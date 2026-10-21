//! How the async conversation record's storage scales with session length.
//!
//! The regression test drives the real provider through a fake runner and
//! counts what one ordinary notice writes to the async compaction tables. That
//! write set must depend on what the notice added, never on how many messages
//! the conversation already holds. The ignored benchmark prints the timing and
//! size table reported in the storage-scaling investigation.
use super::*;

#[path = "reminder_tests.rs"]
mod reminder_tests;

/// Tag rows hydrated by reminder hints, independent of other provider phases.
pub(super) mod reminder_work {
    use std::cell::Cell;
    thread_local! {
        static TAGS: Cell<usize> = const { Cell::new(0) };
    }
    pub fn loaded(count: usize) {
        TAGS.set(TAGS.get() + count);
    }
    pub fn tags() -> usize {
        TAGS.get()
    }
}
use cortexkit_bus_inmemory::{InMemoryBus, InMemoryConfig};

pub(super) mod view_work {
    use super::*;

    #[derive(Clone, Copy, Debug, Default)]
    pub struct Work {
        pub decoded_entries: usize,
        pub engine_input: usize,
        pub renderer_input: usize,
    }
    static WORK: Mutex<BTreeMap<String, Work>> = Mutex::new(BTreeMap::new());

    pub fn engine(reference: &str, count: usize) {
        let mut work = WORK.lock().unwrap();
        let work = work.entry(reference.into()).or_default();
        work.engine_input += count;
    }
    pub fn renderer(reference: &str, count: usize) {
        let mut work = WORK.lock().unwrap();
        let work = work.entry(reference.into()).or_default();
        work.renderer_input += count;
    }
    pub fn decoded(reference: &str, count: usize) {
        WORK.lock()
            .unwrap()
            .entry(reference.into())
            .or_default()
            .decoded_entries += count;
    }
    pub fn take(reference: &str) -> Work {
        WORK.lock().unwrap().remove(reference).unwrap_or_default()
    }
}

pub(super) mod hygiene_interleaving {
    use super::*;
    use std::collections::VecDeque;

    pub type Hook = Box<dyn FnOnce() + Send>;
    static HOOKS: Mutex<BTreeMap<String, VecDeque<Hook>>> = Mutex::new(BTreeMap::new());

    pub struct Guard(String);
    impl Drop for Guard {
        fn drop(&mut self) {
            HOOKS.lock().unwrap().remove(&self.0);
        }
    }
    impl Guard {
        pub(super) fn remaining(&self) -> usize {
            HOOKS.lock().unwrap().get(&self.0).unwrap().len()
        }
    }
    pub(super) fn install(reference: &str, hooks: Vec<Hook>) -> Guard {
        assert!(HOOKS
            .lock()
            .unwrap()
            .insert(reference.into(), hooks.into())
            .is_none());
        Guard(reference.into())
    }
    pub fn run(reference: &str) {
        let hook = HOOKS
            .lock()
            .unwrap()
            .get_mut(reference)
            .and_then(VecDeque::pop_front);
        if let Some(hook) = hook {
            hook();
        }
    }
}

#[tokio::test]
async fn covered_view_work_tracks_tail_not_session() {
    for size in [80, 800] {
        let dir = tempfile::tempdir().unwrap();
        let mut rig = Rig::new(dir.path()).await;
        rig.append(size);
        rig.history(size - 13, "completed covered prefix");
        rig.notice(1_000, None).await;
        assert!(
            rig.store()
                .load(&rig.state().namespace())
                .unwrap()
                .meta
                .tail_hygiene_baseline
                .unwrap()
                .baseline_parts
                .len()
                <= 56,
            "covered excluded measurements must not remain an unbounded engine input"
        );
        let version = rig.newest_view();
        rig.notice(1_000, version).await;
        assert!(rig.state().logical_prefix.is_some());
        view_work::take(&rig.reference);
        rig.history(size - 12, "new completed prefix for the ride");
        let answer = rig
            .op(
                "compaction.ride",
                json!({"session_ref":rig.reference,"cause":"ceiling","deadline_ms":300_000}),
            )
            .await;
        assert_eq!(answer["answer"], "view", "{answer}");
        let work = view_work::take(&rig.reference);
        assert!(
            work.engine_input > 0 && work.renderer_input > 0 && work.decoded_entries > 0,
            "{work:?}"
        );
        eprintln!("covered ride total={size} tail=12 work={work:?}");
        assert!(
            work.engine_input <= 14 && work.renderer_input <= 14 && work.decoded_entries <= 28,
            "size={size}, tail=12: {work:?}"
        );
        rig.history(size - 10, "later fold");
        rig.notice(1_000, answer["view"]["view_version"].as_u64())
            .await;
        let work = view_work::take(&rig.reference);
        assert!(
            work.engine_input > 0 && work.engine_input <= 14,
            "size={size}: {work:?}"
        );
    }
}

#[tokio::test]
async fn first_certified_notice_renders_only_the_view_sources() {
    // The first notice over an already summarized transcript has no
    // certificate yet, so its engine pass reads every held message. Once that
    // pass certifies the covered prefix, rendering must still be bounded by the
    // view's own sources, not by the transcript.
    for size in [80, 800] {
        let dir = tempfile::tempdir().unwrap();
        let mut rig = Rig::new(dir.path()).await;
        rig.append(size);
        rig.history(size - 13, "completed covered prefix");
        view_work::take(&rig.reference);
        rig.notice(1_000, None).await;
        let work = view_work::take(&rig.reference);
        assert!(
            rig.state().logical_prefix.is_some(),
            "size={size}: the first pass did not certify its prefix"
        );
        assert!(
            rig.newest_view().is_some(),
            "size={size}: no view published"
        );
        assert_eq!(
            work.engine_input, size as usize,
            "size={size}: the first pass reads the whole transcript"
        );
        assert!(
            work.renderer_input > 0 && work.renderer_input <= 14,
            "size={size}: {work:?}"
        );
    }
}

#[tokio::test]
async fn covered_ride_keeps_prefix_during_historian_meta_write() {
    // One conflict exercises the fresh-snapshot retry; two exhaust the retry
    // budget and must still use the valid certificate for rendering.
    for writes in [1, 2] {
        let dir = tempfile::tempdir().unwrap();
        let mut rig = Rig::new(dir.path()).await;
        rig.append(800);
        rig.history(787, "completed covered prefix");
        rig.notice(1_000, None).await;
        let version = rig.newest_view();
        rig.notice(1_000, version).await;
        rig.settle().await;
        view_work::take(&rig.reference);
        rig.history(788, "new completed prefix for the ride");
        let hooks = (0..writes)
            .map(|write| {
                let h = rig.h.clone();
                let namespace = rig.state().namespace();
                Box::new(move || {
                    // Historian no-fire metadata writes do not take the provider
                    // lock. Force one after the ride reads its hygiene snapshot
                    // and before the hygiene CAS.
                    std::thread::spawn(move || {
                        let store = h.store.get().unwrap();
                        let loaded = store.load_meta(&namespace).unwrap();
                        let diagnostics = crate::HistorianDiagnostics {
                            fired: false,
                            reason: None,
                            no_fire: Some("BelowProactiveFloor".into()),
                            no_fire_detail: Some(format!("interleaved no-fire decision {write}")),
                            canonical_cause: Some("below_proactive_floor".into()),
                            state: "idle".into(),
                            progress: None,
                            last_failure: None,
                        };
                        let context = crate::HistorianDecisionContext {
                            at_ms: write + 1,
                            request_observed_at_ms: write + 1,
                            pressure_pct: 1,
                            drain_latch: false,
                            chunk_range: None,
                            eligible_tokens: Some(0),
                            bar_tokens: Some(15_000),
                        };
                        h.record_no_fire(store, &namespace, &loaded, &diagnostics, &context);
                        assert_eq!(
                            store.load_meta(&namespace).unwrap().row_version,
                            loaded.row_version.map(|v| v + 1),
                            "the historian write must commit before the hygiene CAS"
                        );
                    })
                    .join()
                    .unwrap();
                }) as hygiene_interleaving::Hook
            })
            .collect();
        let interleaving = hygiene_interleaving::install(&rig.reference, hooks);
        let answer = rig
            .op(
                "compaction.ride",
                json!({"session_ref":rig.reference,"cause":"ceiling","deadline_ms":300_000}),
            )
            .await;
        assert_eq!(answer["answer"], "view", "{answer}");
        assert_eq!(interleaving.remaining(), 0, "every conflict must execute");
        let work = view_work::take(&rig.reference);
        assert!(
            work.engine_input > 0
                && work.engine_input <= 14
                && work.renderer_input > 0
                && work.renderer_input <= 14
                && work.decoded_entries > 0
                && work.decoded_entries <= 28,
            "writes={writes}: {work:?}"
        );
        let state = rig.state();
        assert!(state.logical_prefix.is_some());
        let loaded = rig.store().load(&state.namespace()).unwrap();
        assert_eq!(
            loaded.meta.historian.last_no_fire.as_deref(),
            Some(format!("interleaved no-fire decision {}", writes - 1).as_str()),
            "rebasing hygiene must preserve the historian's newer metadata"
        );
        if writes == 1 {
            assert!(
                loaded
                    .meta
                    .tail_hygiene_baseline
                    .unwrap()
                    .baseline_parts
                    .len()
                    <= 56
            );
        }
        eprintln!("forced historian writes={writes} covered ride work={work:?}");
    }
}

#[tokio::test]
async fn covered_ride_rejects_prefix_when_hygiene_conflict_changes_certificate() {
    let dir = tempfile::tempdir().unwrap();
    let mut rig = Rig::new(dir.path()).await;
    rig.append(80);
    rig.history(67, "completed covered prefix");
    rig.notice(1_000, None).await;
    let version = rig.newest_view();
    rig.notice(1_000, version).await;
    rig.settle().await;
    view_work::take(&rig.reference);
    rig.history(68, "new completed prefix for the ride");
    let store = rig.h.store.get().unwrap().clone();
    let namespace = rig.state().namespace();
    let interleaving = hygiene_interleaving::install(
        &rig.reference,
        vec![Box::new(move || {
            let mut loaded = store.load_meta(&namespace).unwrap();
            loaded.meta.revert_epoch += 1;
            store
                .commit_meta(&namespace, loaded.row_version, &loaded.meta)
                .unwrap();
        })],
    );
    let answer = rig
        .op(
            "compaction.ride",
            json!({"session_ref":rig.reference,"cause":"ceiling","deadline_ms":300_000}),
        )
        .await;
    assert_eq!(answer["answer"], "view", "{answer}");
    assert_eq!(interleaving.remaining(), 0);
    let work = view_work::take(&rig.reference);
    assert_eq!(work.engine_input, 13);
    assert_eq!(
        work.renderer_input, 80,
        "an invalid certificate must fall back"
    );
    assert!(rig.state().logical_prefix.is_none());
}

#[tokio::test]
async fn prefix_certificate_does_not_guess_after_catalog_rewind() {
    let dir = tempfile::tempdir().unwrap();
    let mut rig = Rig::new(dir.path()).await;
    rig.append(80);
    rig.history(67, "adopted coverage");
    rig.notice(1_000, None).await;
    let state = rig.state();
    let mut request: TransformRequest = decode(&json!({"v":2,"kind":"compaction.step", "session_id":state.namespace(),"messages":[],"render_config":"","model_key":"fixture","tool_present":false})).unwrap();
    codec::Codec::OpencodeAiSdk
        .prepare_request(
            &mut request,
            &inbound_messages(state.entries.values()).unwrap(),
        )
        .unwrap();
    let projection = ck_wire::project_messages(&request.messages).unwrap();
    let loaded = rig.store().load(&state.namespace()).unwrap();
    let mut compartments = rig.store().load_compartments(&state.namespace()).unwrap();
    assert!(transform::compaction::LogicalPrefix::certify(
        rig.store(),
        &request,
        &projection,
        &loaded,
        &compartments,
        "L",
        state.generation
    )
    .is_some());
    compartments[0].end_message = 62;
    compartments[0].end_message_id = "m62#0".into();
    assert!(transform::compaction::LogicalPrefix::certify(
        rig.store(),
        &request,
        &projection,
        &loaded,
        &compartments,
        "L",
        state.generation
    )
    .is_none());
}

/// Wall and thread-CPU time spent in `AsyncRecord::save` (and, separately,
/// in a full `load`), per conversation. Saves run on whichever worker thread
/// holds the conversation, so the meter is keyed by session reference rather
/// than kept thread-local.
pub(super) mod save_meter {
    use std::collections::BTreeMap;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    #[derive(Clone, Copy, Debug, Default)]
    pub struct SaveStats {
        pub saves: u64,
        pub wall_nanos: u64,
        pub cpu_nanos: u64,
    }

    static METERS: Mutex<BTreeMap<String, SaveStats>> = Mutex::new(BTreeMap::new());

    pub struct Timer {
        reference: String,
        kind: &'static str,
        wall: Instant,
        // Thread CPU at start, kept as a plain duration so a timer held
        // across an await stays `Send`.
        cpu: Duration,
    }

    pub fn start(reference: &str) -> Timer {
        start_kind(reference, "save")
    }

    pub fn start_kind(reference: &str, kind: &'static str) -> Timer {
        Timer {
            kind,
            reference: reference.into(),
            wall: Instant::now(),
            cpu: cpu_time::ThreadTime::now().as_duration(),
        }
    }

    impl Drop for Timer {
        fn drop(&mut self) {
            let mut meters = METERS.lock().unwrap_or_else(|p| p.into_inner());
            let stats = meters
                .entry(format!("{}:{}", self.kind, self.reference))
                .or_default();
            stats.saves += 1;
            stats.wall_nanos += self.wall.elapsed().as_nanos() as u64;
            stats.cpu_nanos += cpu_time::ThreadTime::now()
                .as_duration()
                .saturating_sub(self.cpu)
                .as_nanos() as u64;
        }
    }

    pub fn read(reference: &str) -> SaveStats {
        read_kind(reference, "save")
    }

    pub fn read_kind(reference: &str, kind: &str) -> SaveStats {
        METERS
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&format!("{kind}:{reference}"))
            .copied()
            .unwrap_or_default()
    }
}

/// A runner that pages by the provider's requested byte budget, like a real
/// runner, so a long transcript is read in a few hundred pages, not thousands.
#[derive(Default)]
struct PagedRunner {
    entries: Mutex<Vec<(ReadMessage, usize)>>,
}

#[async_trait]
impl session_resolver::ProviderRunner for PagedRunner {
    async fn call_for_identity(
        &self,
        route: &crate::route_targets::SessionRunnerRoute,
        identity: &session_resolver::RunnerBindIdentity,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        self.call(
            &identity.project_root,
            route.parent_session(),
            method,
            params,
            budget,
        )
        .await
    }
    async fn call(
        &self,
        _: &Path,
        _: &str,
        method: &str,
        params: Value,
        _: Duration,
    ) -> Result<Value, SessionResolveError> {
        if method == "session.send" {
            return Ok(json!({"state":"pending","submission_id":"reminder"}));
        }
        if method == "role.describe" {
            return Ok(
                json!({"majors":[{"version":"llm-runner/v1","ops":["role.describe","session.baseline","session.send"]}],"implementation_version":"fake","session_capabilities_from":"baseline","capabilities":["delivery_order"]}),
            );
        }
        assert_eq!(method, "session.read");
        let from = params["from_ordinal"].as_u64().unwrap();
        let budget = params["max_bytes"].as_u64().unwrap_or(1_048_576) as usize;
        let entries = self.entries.lock().unwrap();
        let start = entries.partition_point(|(entry, _)| entry.ordinal < from);
        let mut used = 0;
        let mut messages = Vec::new();
        for (entry, size) in &entries[start..] {
            if !messages.is_empty() && used + size > budget {
                break;
            }
            used += size;
            messages.push(entry.clone());
        }
        let mut page = json!({"lineage_id":"L","messages":messages});
        if start + messages.len() < entries.len() {
            page["next_from_ordinal"] = json!(messages.last().unwrap().ordinal + 1);
        }
        Ok(page)
    }
}

/// Realistic part sizes: short user turns, assistant turns with a short text
/// part and a ~1.2 KB tool output, a 32 KB output every 101 messages and a
/// 200 KB output every 997 messages.
fn message(n: u64) -> (ReadMessage, usize) {
    let (role, parts, tags) = if n.is_multiple_of(5) {
        (
            "user",
            json!([{"id":format!("p{n}a"),"type":"text","text":format!("user turn {n}: ")+&"please look at the failing build ".repeat(8)}]),
            vec![tags::PartTag::tagged("0", format!("§{}§", 100 + n * 3))],
        )
    } else {
        let output = if n % 997 == 3 {
            "large spent tool output line\n".repeat(7_000)
        } else if n % 101 == 7 {
            "medium spent tool output line\n".repeat(1_100)
        } else {
            "spent tool output line\n".repeat(52)
        };
        (
            "assistant",
            json!([
                {"id":format!("p{n}a"),"type":"text","text":format!("step {n}: checking the next file")},
                {"id":format!("p{n}b"),"type":"tool","tool":"read","callID":format!("call{n}"),"state":{"status":"completed","input":{"path":format!("src/file{n}.rs")},"output":output}}
            ]),
            vec![
                tags::PartTag::tagged("0", format!("§{}§", 100 + n * 3)),
                tags::PartTag::tagged("1", format!("§{}§", 101 + n * 3)),
            ],
        )
    };
    let entry = ReadMessage::new(
        n,
        format!("m{n}"),
        json!({"info":{"id":format!("m{n}"),"role":role,"time":{"created":1}},"parts":parts}),
    )
    .with_tags(tags);
    let size = serde_json::to_vec(&entry).unwrap().len();
    (entry, size)
}

struct Rig {
    h: Arc<McHandler>,
    runner: Arc<PagedRunner>,
    _bus: Arc<InMemoryBus>,
    task: tokio::task::JoinHandle<()>,
    reference: String,
    db: PathBuf,
    seq: u64,
}
impl Drop for Rig {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Sample {
    wall_ms: f64,
    process_cpu_ms: f64,
    save_wall_ms: f64,
    save_cpu_ms: f64,
    load_cpu_ms: f64,
    write_tx_ms: f64,
    lock_held_ms: f64,
    write_tx: u64,
    rows: u64,
    bytes: u64,
    wal_bytes: u64,
}

impl Rig {
    async fn new(dir: &Path) -> Self {
        let db = dir.join("store.db");
        let descriptor = StorageDescriptor {
            module_id: DEFAULT_MODULE_ID.into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: db.to_string_lossy().into(),
            },
        };
        let store = Arc::new(McStore::open_for_test(&descriptor).unwrap());
        let runner = Arc::new(PagedRunner::default());
        let mut h = McHandler::new();
        h.store.set(store).ok().unwrap();
        h.provider_runner = runner.clone();
        let config = McModuleConfig {
            inject_docs: false,
            protected_tokens_user: Some(0),
            protected_tools: BTreeMap::new(),
            ..Default::default()
        };
        h.fixed_config = Some(config.clone());
        h.bind_route(
            7,
            SessionBinding {
                principal: Some(subc_protocol::Principal::Reserved {
                    module_id: "thalamus-harness".into(),
                }),
                scope: None,
                project_root: dir.into(),
                harness: "runner".into(),
                session: "s".into(),
                model_key: None,
                config,
                history_budget_tokens: 4_000.0,
            },
        );
        let h = Arc::new(h);
        let bus = Arc::new(InMemoryBus::new(
            InMemoryConfig::default().with_durable(DurableOwner::Module(DEFAULT_MODULE_ID)),
        ));
        let task = h
            .clone()
            .start_compaction_bus(bus.clone(), "fixture".into())
            .await
            .unwrap();
        let reference = session_ref("opencode", &dir.to_string_lossy(), "s");
        let rig = Self {
            h,
            runner,
            _bus: bus,
            task,
            reference,
            db,
            seq: 0,
        };
        let answer = rig.op("compaction.setup",json!({"session":"s","harness":"opencode","request_id":"setup","model":"fixture","context_window":100_000,"composition":{"render_tags":true},"params":{"serializer_profile":"opencode-aisdk"},"lineage_id":"L","now":1})).await;
        assert_eq!(answer["answer"], "ready", "{answer}");
        rig
    }

    async fn op(&self, method: &str, params: Value) -> Value {
        match self
            .h
            .dispatch_value(7, json!({"method":method,"params":params}))
            .await
        {
            HandlerOutcome::Response(bytes) => serde_json::from_slice(&bytes).unwrap(),
            other => panic!("{method} failed: {other:?}"),
        }
    }

    fn store(&self) -> &McStore {
        self.h.store.get().unwrap()
    }

    fn append(&self, count: u64) {
        let mut entries = self.runner.entries.lock().unwrap();
        let next = entries.last().map_or(0, |(entry, _)| entry.ordinal + 1);
        entries.extend((next..next + count).map(message));
    }

    fn sql(&self) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open(&self.db).unwrap();
        conn.busy_timeout(Duration::from_secs(30)).unwrap();
        conn
    }

    fn scalar(&self, sql: &str) -> u64 {
        self.sql()
            .query_row(sql, [&self.reference], |row| row.get::<_, Option<i64>>(0))
            .unwrap()
            .unwrap_or(0) as u64
    }

    /// Bytes the conversation record occupies, split into the per-conversation
    /// record and every per-message or per-view row stored beside it.
    fn record_bytes(&self) -> (u64, u64) {
        let record =
            self.scalar("SELECT length(state_json) FROM mc_async_compaction WHERE session_ref=?1");
        let entries = if self.table_exists("mc_async_compaction_entries") {
            self.scalar("SELECT sum(length(entry_json)+length(index_json)) FROM mc_async_compaction_entries WHERE session_ref=?1")
        } else {
            0
        };
        (record, entries)
    }

    fn views(&self) -> (u64, u64) {
        let column = if self.column_exists("mc_async_compaction_views", "engine_json") {
            "length(view_json)+coalesce(length(engine_json),0)"
        } else {
            "length(view_json)"
        };
        (
            self.scalar("SELECT count(*) FROM mc_async_compaction_views WHERE session_ref=?1"),
            self.scalar(&format!(
                "SELECT sum({column}) FROM mc_async_compaction_views WHERE session_ref=?1"
            )),
        )
    }

    fn table_exists(&self, table: &str) -> bool {
        self.sql()
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [table],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
            > 0
    }

    fn column_exists(&self, table: &str, column: &str) -> bool {
        self.sql()
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .any(|name| name.unwrap() == column)
    }

    fn truncate_wal(&self) {
        let _: (i64, i64, i64) = self
            .sql()
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
    }

    fn wal_bytes(&self) -> u64 {
        std::fs::metadata(self.db.with_extension("db-wal")).map_or(0, |meta| meta.len())
    }

    /// Run `work` and report its cost: wall time, process CPU, the time and
    /// CPU spent saving the record, and the fenced async-table writes.
    async fn measure<T>(&self, work: impl std::future::Future<Output = T>) -> (T, Sample) {
        self.truncate_wal();
        self.store().arm_async_write_meter(&self.reference);
        let saves = save_meter::read(&self.reference);
        let loads = save_meter::read_kind(&self.reference, "load");
        let wall = Instant::now();
        let cpu = cpu_time::ProcessTime::now();
        let value = work.await;
        let process_cpu_ms = cpu.elapsed().as_secs_f64() * 1e3;
        let wall_ms = wall.elapsed().as_secs_f64() * 1e3;
        let writes = self.store().async_write_stats(&self.reference).unwrap();
        let after = save_meter::read(&self.reference);
        let loaded = save_meter::read_kind(&self.reference, "load");
        let sample = Sample {
            wall_ms,
            process_cpu_ms,
            save_wall_ms: (after.wall_nanos - saves.wall_nanos) as f64 / 1e6,
            save_cpu_ms: (after.cpu_nanos - saves.cpu_nanos) as f64 / 1e6,
            load_cpu_ms: (loaded.cpu_nanos - loads.cpu_nanos) as f64 / 1e6,
            write_tx_ms: writes.nanos as f64 / 1e6,
            lock_held_ms: writes.held_nanos as f64 / 1e6,
            write_tx: writes.transactions,
            rows: writes.rows,
            bytes: writes.bytes,
            wal_bytes: self.wal_bytes(),
        };
        (value, sample)
    }

    /// Deliver one advance notice straight to the provider, as the bus loop
    /// does, so its cost is measured without the loop's polling interval.
    async fn notice(&mut self, est_tokens: u64, applied: Option<u64>) -> Sample {
        self.seq += 1;
        let seq = self.seq;
        let (last_ordinal, digest) = {
            let entries = self.runner.entries.lock().unwrap();
            let (last, _) = entries.last().unwrap();
            (
                last.ordinal,
                contract::digest::content_digest(&last.message),
            )
        };
        let mut notice = notice::AdvanceNotice::new(
            &self.reference,
            seq,
            "L",
            last_ordinal,
            digest,
            est_tokens,
            "fixture",
        )
        .with_window(100_000);
        if let Some(version) = applied {
            notice = notice.with_applied_view_version(version);
        }
        let mut headers = notice.to_headers();
        headers.insert("lineage_id".into(), "L".into());
        let message = cortexkit_bus_trait::Message {
            subject: notice::event_subject("fixture", "thalamus-harness", notice::ADVANCED_EVENT),
            id: bus_id(&self.reference, "advanced", seq),
            digest: notice.digest().parse().unwrap(),
            headers,
        };
        let (result, sample) = self
            .measure(self.h.advance_compaction("fixture", &message))
            .await;
        result.unwrap();
        assert_eq!(self.state().completed_seq, seq);
        sample
    }

    fn state(&self) -> State {
        load(self.store(), &self.reference).unwrap().unwrap()
    }

    fn newest(&self) -> Option<u64> {
        self.state().published_engine.keys().next_back().copied()
    }

    /// Publish a finished historian summary so the next notice has real
    /// structural work and publishes a view.
    fn history(&self, end: u64, content: &str) {
        let namespace = self.state().namespace();
        self.store()
            .replace_compartments(
                &namespace,
                &[mc_store::StoredCompartment {
                    sequence: 1,
                    start_message: 0,
                    end_message: end as i64,
                    end_message_id: format!("m{end}#0"),
                    title: "history".into(),
                    content: content.into(),
                    p1: Some(content.into()),
                    importance: 50,
                    ..Default::default()
                }],
            )
            .unwrap();
        self.store().arm_soft_refresh(&namespace).unwrap();
    }
}

/// A conversation of `size` messages, bootstrapped through the provider, with
/// one published view that the runner has acknowledged.
async fn conversation(dir: &Path, size: u64) -> (Rig, u64) {
    let mut rig = Rig::new(dir).await;
    rig.append(size);
    rig.notice(1_000, None).await;
    rig.history(size / 2, "first completed historian summary");
    rig.notice(1_000, None).await;
    let version = rig.newest().expect("history publishes a view");
    rig.append(4);
    rig.notice(1_000, Some(version)).await;
    (rig, version)
}

/// What two ordinary notices write in a conversation of `size` messages: the
/// first acknowledges a newly published view, the second repeats that
/// acknowledgement. Each appends four messages. Also returns the size of the
/// per-conversation record afterwards.
async fn ordinary_notices(size: u64) -> (Sample, Sample, u64) {
    let dir = tempfile::tempdir().unwrap();
    let mut rig = Rig::new(dir.path()).await;
    rig.append(size);
    rig.notice(1_000, None).await;
    rig.history(size / 2, "first completed historian summary");
    rig.notice(1_000, None).await;
    let version = rig.newest().expect("history publishes a view");
    rig.append(4);
    let acknowledging = rig.notice(1_000, Some(version)).await;
    rig.append(4);
    let repeating = rig.notice(1_000, Some(version)).await;
    assert_eq!(
        rig.newest(),
        Some(version),
        "an ordinary notice publishes nothing"
    );
    (acknowledging, repeating, rig.record_bytes().0)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ordinary_notice_write_set_does_not_grow_with_the_session() {
    let (small_ack, small, small_record) = ordinary_notices(60).await;
    let (large_ack, large, large_record) = ordinary_notices(600).await;
    for (label, small, large) in [
        ("acknowledging a new view", small_ack, large_ack),
        ("repeating an acknowledgement", small, large),
    ] {
        assert!(
            large.bytes <= small.bytes * 2 && large.rows <= small.rows * 2,
            "a notice {label} and adding four messages wrote {} bytes in {} rows at 600 messages but {} bytes in {} rows at 60",
            large.bytes,
            large.rows,
            small.bytes,
            small.rows
        );
    }
    assert!(
        large_record <= small_record * 2,
        "the per-conversation record must stay fixed-size: {large_record} bytes at 600 messages, {small_record} at 60"
    );
}

/// Measure the transcript work of one notice that publishes nothing, in a
/// conversation of `size` messages: entries parsed from JSON, messages
/// decoded by the codec, engine passes and engine views parsed. Also returns
/// why the engine last ran on this thread.
async fn quiet_notice_work(size: u64) -> (resident::counters::Work, String) {
    let dir = tempfile::tempdir().unwrap();
    let (mut rig, version) = conversation(dir.path(), size).await;
    rig.append(4);
    rig.notice(1_000, Some(version)).await;
    let before = resident::counters::read();
    rig.append(4);
    rig.notice(1_000, Some(version)).await;
    let after = resident::counters::read();
    assert_eq!(
        rig.newest(),
        Some(version),
        "a quiet notice publishes nothing"
    );
    (
        resident::counters::Work {
            parsed: after.parsed - before.parsed,
            decoded: after.decoded - before.decoded,
            engine_passes: after.engine_passes - before.engine_passes,
            engine_views: after.engine_views - before.engine_views,
        },
        resident::counters::last_engine_reason(),
    )
}

/// A notice that adds four messages and publishes nothing reads only those
/// messages: no engine pass, no engine view, and the same number of parsed
/// and decoded entries at 600 messages as at 60. The counters are per thread,
/// so this runs on a single-threaded runtime.
#[tokio::test]
async fn a_quiet_notice_reads_only_what_it_added() {
    let (small, small_reason) = quiet_notice_work(60).await;
    let (large, large_reason) = quiet_notice_work(600).await;
    assert_eq!(
        (small.engine_passes, large.engine_passes),
        (0, 0),
        "a quiet notice ran the engine: {small_reason} / {large_reason}"
    );
    assert_eq!((small.engine_views, large.engine_views), (0, 0));
    assert!(
        large.parsed <= small.parsed && large.decoded <= small.decoded,
        "a quiet notice's transcript work grew with the session: {large:?} at 600 messages, {small:?} at 60"
    );
    assert!(
        large.decoded <= 12 && large.parsed <= 40,
        "a quiet notice adding four messages read {large:?}"
    );
}

async fn view_answer(rig: &Rig, version: u64) -> String {
    let answer = rig
        .op(
            "view.get",
            json!({"session_ref":rig.reference,"view_version":version}),
        )
        .await;
    match answer["answer"].as_str() {
        Some("view") => {
            assert_eq!(answer["view"]["view_version"], version);
            "view".into()
        }
        _ => answer["code"].as_str().unwrap().into(),
    }
}

/// Retention keeps the runner's applied version, every version it has not
/// acknowledged yet and the newest; an acknowledgement evicts the rest, and
/// `view.get` of an evicted version answers `unknown_version`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acknowledgement_evicts_only_superseded_views() {
    let dir = tempfile::tempdir().unwrap();
    let (mut rig, first) = conversation(dir.path(), 40).await;
    rig.history(22, "a second historian summary");
    rig.append(4);
    rig.notice(1_000, Some(first)).await;
    let second = rig.newest().unwrap();
    assert!(second > first);
    rig.history(24, "a third historian summary");
    rig.append(4);
    rig.notice(1_000, Some(first)).await;
    let third = rig.newest().unwrap();
    assert!(third > second);
    for version in [first, second, third] {
        assert_eq!(
            view_answer(&rig, version).await,
            "view",
            "applied {first}: version {version} is applied or not yet acknowledged"
        );
    }
    rig.append(4);
    rig.notice(1_000, Some(second)).await;
    assert_eq!(view_answer(&rig, first).await, "unknown_version");
    assert_eq!(view_answer(&rig, second).await, "view");
    assert_eq!(view_answer(&rig, third).await, "view");
    rig.append(4);
    rig.notice(1_000, Some(third)).await;
    assert_eq!(view_answer(&rig, second).await, "unknown_version");
    assert_eq!(view_answer(&rig, third).await, "view");
    assert_eq!(rig.views().0, 1, "only the applied, newest view remains");
    assert_eq!(rig.newest(), Some(third));
}

fn row(label: &str, size: u64, sample: &Sample) -> String {
    let line = format!(
        "| {label} | {size} | {:.1} | {:.1} | {:.1} | {:.2} | {:.2} | {:.2} | {:.2} | {} | {} | {} | {} |",
        sample.wall_ms,
        sample.process_cpu_ms,
        sample.load_cpu_ms,
        sample.save_wall_ms,
        sample.save_cpu_ms,
        sample.write_tx_ms,
        sample.lock_held_ms,
        sample.write_tx,
        sample.rows,
        sample.bytes,
        sample.wal_bytes
    );
    // Print as soon as measured, so a run stopped at a larger size keeps
    // the rows it already produced.
    eprintln!("{line}");
    line
}

const PHASES: [&str; 17] = [
    "load",
    "rem:base",
    "rem:last",
    "rem:send",
    "phase:checkout",
    "phase:read",
    "phase:index",
    "phase:policy",
    "phase:skip",
    "phase:skip_meta",
    "phase:publish",
    "phase:reminders",
    "phase:cache_state_load",
    "phase:cadence",
    "phase:historian",
    "phase:checkin",
    "save",
];

fn phase_stats(reference: &str) -> Vec<save_meter::SaveStats> {
    PHASES
        .iter()
        .map(|kind| save_meter::read_kind(reference, kind))
        .collect()
}

/// Thread-CPU milliseconds and call counts per notice phase since `before`.
fn phases(reference: &str, before: &[save_meter::SaveStats]) -> String {
    PHASES
        .iter()
        .zip(phase_stats(reference).iter().zip(before))
        .map(|(kind, (now, then))| {
            format!(
                "{kind}={:.1}cpu-ms/{:.1}wall-ms/{}",
                (now.cpu_nanos - then.cpu_nanos) as f64 / 1e6,
                (now.wall_nanos - then.wall_nanos) as f64 / 1e6,
                now.saves - then.saves
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn median(mut samples: Vec<Sample>) -> Sample {
    samples.sort_by(|a, b| a.save_wall_ms.total_cmp(&b.save_wall_ms));
    samples[samples.len() / 2]
}

/// Prints the scaling table. Sizes come from `MC_ASYNC_SCALING_SIZES`
/// (comma-separated message counts), default 1k, 10k, 50k and 150k.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "storage scaling benchmark; run explicitly with --ignored --nocapture"]
async fn storage_scaling_benchmark() {
    let sizes = std::env::var("MC_ASYNC_SCALING_SIZES")
        .unwrap_or_else(|_| "1000,10000,50000,150000".into())
        .split(',')
        .map(|size| size.trim().parse::<u64>().unwrap())
        .collect::<Vec<_>>();
    let mut table = vec![
        "| operation | messages | wall ms | process CPU ms | full-load CPU ms | save wall ms | save CPU ms | write-tx call ms | write-lock held ms | write txs | rows written | bytes written | WAL bytes |".to_string(),
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|".to_string(),
    ];
    let mut sizes_table = vec![
        "| messages | transcript bytes | state_json bytes | entry rows bytes | views rows | views bytes | views rows +1 publish | views bytes +1 publish |".to_string(),
        "|---:|---:|---:|---:|---:|---:|---:|---:|".to_string(),
    ];
    for size in sizes {
        let dir = tempfile::tempdir().unwrap();
        let started = Instant::now();
        let (mut rig, version) = conversation(dir.path(), size).await;
        eprintln!(
            "bootstrapped {size} messages in {:.1}s",
            started.elapsed().as_secs_f64()
        );
        let transcript = rig
            .runner
            .entries
            .lock()
            .unwrap()
            .iter()
            .map(|(_, size)| *size as u64)
            .sum::<u64>();
        let mut notices = Vec::new();
        let before = phase_stats(&rig.reference);
        for _ in 0..5 {
            rig.append(4);
            notices.push(rig.notice(1_000, Some(version)).await);
        }
        table.push(row("notice (+4 msgs)", size, &median(notices)));
        eprintln!(
            "phases over 5 notices at {size}: {}",
            phases(&rig.reference, &before)
        );
        let (record, entries) = rig.record_bytes();
        let (view_rows, view_bytes) = rig.views();
        let (answer, get) = rig
            .measure(rig.op(
                "view.get",
                json!({"session_ref":rig.reference,"view_version":version}),
            ))
            .await;
        assert_eq!(answer["answer"], "view", "{answer}");
        table.push(row("view.get", size, &get));
        rig.history(size / 2 + 2, "a newer historian summary");
        let reference = rig.reference.clone();
        let (answer, ride) = rig
            .measure(rig.op(
                "compaction.ride",
                json!({"session_ref":reference,"cause":"ceiling","deadline_ms":300_000}),
            ))
            .await;
        table.push(row(
            &format!("ride (answer {})", answer["answer"]),
            size,
            &ride,
        ));
        if let Some(ridden) = answer["view"]["view_version"].as_u64() {
            rig.append(4);
            let acknowledged = rig.notice(1_000, Some(ridden)).await;
            table.push(row("notice acking ride", size, &acknowledged));
        }
        let (after_rows, after_bytes) = rig.views();
        let (after_record, _) = rig.record_bytes();
        let line = format!(
            "| {size} | {transcript} | {record} (after ride+ack: {after_record}) | {entries} | {view_rows} | {view_bytes} | {} | {} |",
            after_rows as i64 - view_rows as i64,
            after_bytes as i64 - view_bytes as i64,
        );
        eprintln!("{line}");
        sizes_table.push(line);
        drop(rig);
    }
    println!("{}", table.join("\n"));
    println!();
    println!("{}", sizes_table.join("\n"));
}

/// Peak and current resident set size of this process, in bytes (Linux).
fn rss() -> (u64, u64) {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let field = |name: &str| {
        status
            .lines()
            .find(|line| line.starts_with(name))
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|kb| kb.parse::<u64>().ok())
            .map_or(0, |kb| kb * 1024)
    };
    (field("VmHWM:"), field("VmRSS:"))
}

fn percentiles(label: &str, size: u64, samples: &mut [(f64, f64, f64)]) {
    if samples.is_empty() {
        return;
    }
    let pick = |samples: &[(f64, f64, f64)], at: f64, key: fn(&(f64, f64, f64)) -> f64| {
        let mut values = samples.iter().map(key).collect::<Vec<_>>();
        values.sort_by(f64::total_cmp);
        let index = ((values.len() as f64 * at).ceil() as usize).clamp(1, values.len()) - 1;
        values[index]
    };
    let row = |name: &str, key: fn(&(f64, f64, f64)) -> f64| {
        format!(
            "{name} p50 {:.1} / p90 {:.1} / p99 {:.1}",
            pick(samples, 0.50, key),
            pick(samples, 0.90, key),
            pick(samples, 0.99, key)
        )
    };
    eprintln!(
        "| {label} | {size} | {} | {} | {} | {} |",
        samples.len(),
        row("wall ms", |s| s.0),
        row("thread CPU ms", |s| s.1),
        row("process CPU ms", |s| s.2)
    );
}

impl Rig {
    /// Deliver a notice adding `count` messages; returns wall, this thread's
    /// CPU and process CPU in milliseconds, and the process CPU the
    /// historian evaluation it started took afterwards.
    async fn timed_notice(&mut self, count: u64, applied: Option<u64>) -> ((f64, f64, f64), f64) {
        let (sample, historian, outcome) = self.try_timed_notice(count, applied, 1_000).await;
        outcome.unwrap();
        let head = load_head(self.store(), &self.reference).unwrap().unwrap();
        assert_eq!(head.completed_seq, self.seq);
        (sample, historian)
    }

    async fn try_timed_notice(
        &mut self,
        count: u64,
        applied: Option<u64>,
        est_tokens: u64,
    ) -> ((f64, f64, f64), f64, Result<(), HandlerOutcome>) {
        self.append(count);
        self.seq += 1;
        let seq = self.seq;
        let (last_ordinal, digest) = {
            let entries = self.runner.entries.lock().unwrap();
            let (last, _) = entries.last().unwrap();
            (
                last.ordinal,
                contract::digest::content_digest(&last.message),
            )
        };
        let mut notice = notice::AdvanceNotice::new(
            &self.reference,
            seq,
            "L",
            last_ordinal,
            digest,
            est_tokens,
            "fixture",
        )
        .with_window(100_000);
        if let Some(version) = applied {
            notice = notice.with_applied_view_version(version);
        }
        let mut headers = notice.to_headers();
        headers.insert("lineage_id".into(), "L".into());
        let message = cortexkit_bus_trait::Message {
            subject: notice::event_subject("fixture", "thalamus-harness", notice::ADVANCED_EVENT),
            id: bus_id(&self.reference, "advanced", seq),
            digest: notice.digest().parse().unwrap(),
            headers,
        };
        let wall = Instant::now();
        let thread = cpu_time::ThreadTime::now();
        let process = cpu_time::ProcessTime::now();
        let outcome = self.h.advance_compaction("fixture", &message).await;
        let sample = (
            wall.elapsed().as_secs_f64() * 1e3,
            thread.elapsed().as_secs_f64() * 1e3,
            process.elapsed().as_secs_f64() * 1e3,
        );
        let background = cpu_time::ProcessTime::now();
        self.settle().await;
        let historian = background.elapsed().as_secs_f64() * 1e3;
        (sample, historian, outcome)
    }

    async fn settle(&self) {
        while self
            .h
            .provider_store
            .async_runtime
            .historian_inflight
            .load(std::sync::atomic::Ordering::SeqCst)
            > 0
        {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    }

    fn newest_view(&self) -> Option<u64> {
        self.sql()
            .query_row(
                "SELECT max(version) FROM mc_async_compaction_views WHERE session_ref=?1",
                [&self.reference],
                |row| row.get::<_, Option<i64>>(0),
            )
            .unwrap()
            .map(|version| version as u64)
    }
}

/// Notice and view latency percentiles, cold start and memory at each size
/// in `MC_ASYNC_SCALING_SIZES`. `MC_ASYNC_NOTICES` quiet notices (default
/// 200) and `MC_ASYNC_VIEWS` view builds of each kind (default 20) per size.
/// Set `MC_ASYNC_ORACLE=1` to measure the full-recompute path instead.
/// Runs on one thread so a notice's own CPU is this thread's CPU; rides and
/// historian evaluations run on blocking threads and count in process CPU.
#[tokio::test]
#[ignore = "latency benchmark; run explicitly with --ignored --nocapture"]
async fn resident_latency_benchmark() {
    let env = |name: &str, default: &str| std::env::var(name).unwrap_or_else(|_| default.into());
    let sizes = env("MC_ASYNC_SCALING_SIZES", "1000,10000,50000,150000")
        .split(',')
        .map(|size| size.trim().parse::<u64>().unwrap())
        .collect::<Vec<_>>();
    let quiet = env("MC_ASYNC_NOTICES", "200").parse::<usize>().unwrap();
    let views = env("MC_ASYNC_VIEWS", "20").parse::<usize>().unwrap();
    let oracle = env("MC_ASYNC_ORACLE", "0") == "1";
    eprintln!("| operation | messages | samples | wall | this thread's CPU | process CPU |");
    eprintln!("|---|---:|---:|---|---|---|");
    for size in sizes {
        let dir = tempfile::tempdir().unwrap();
        let started = Instant::now();
        let mut rig = Rig::new(dir.path()).await;
        rig.h
            .provider_store
            .async_runtime
            .resident
            .lock()
            .unwrap()
            .oracle = oracle;
        rig.append(size);
        rig.timed_notice(0, None).await;
        rig.history(size / 2, "first completed historian summary");
        rig.timed_notice(0, None).await;
        let mut version = rig.newest_view().expect("history publishes a view");
        rig.timed_notice(4, Some(version)).await;
        eprintln!(
            "bootstrapped {size} messages in {:.1}s",
            started.elapsed().as_secs_f64()
        );
        let transcript = rig
            .runner
            .entries
            .lock()
            .unwrap()
            .iter()
            .map(|(_, bytes)| *bytes as u64)
            .sum::<u64>();
        let mut notices = Vec::new();
        let mut historian = Vec::new();
        let phases_before = phase_stats(&rig.reference);
        let reasons_before = resident::counters::engine_reasons();
        for _ in 0..quiet {
            let (sample, background) = rig.timed_notice(4, Some(version)).await;
            notices.push(sample);
            historian.push((background, background, background));
        }
        assert_eq!(
            rig.newest_view(),
            Some(version),
            "quiet notices publish nothing"
        );
        percentiles("quiet notice (+4 msgs)", size, &mut notices);
        eprintln!(
            "phases over {quiet} quiet notices at {size}: {}",
            phases(&rig.reference, &phases_before)
        );
        eprintln!(
            "engine ran on quiet notices at {size}: before {reasons_before:?} after {:?}",
            resident::counters::engine_reasons()
        );
        percentiles(
            "historian evaluation after it (process CPU)",
            size,
            &mut historian,
        );
        let (peak, current) = rss();
        eprintln!(
            "memory after quiet notices at {size}: process RSS {:.2} GB (peak so far {:.2} GB)",
            current as f64 / 1e9,
            peak as f64 / 1e9
        );
        let mut rides = Vec::new();
        let mut publishes = Vec::new();
        let mut acknowledging = Vec::new();
        for index in 0..views {
            rig.history(size / 2 + 2 + index as u64 * 2, "a newer historian summary");
            let reference = rig.reference.clone();
            let wall = Instant::now();
            let thread = cpu_time::ThreadTime::now();
            let process = cpu_time::ProcessTime::now();
            let answer = rig
                .op(
                    "compaction.ride",
                    json!({"session_ref":reference,"cause":"ceiling","deadline_ms":300_000}),
                )
                .await;
            rides.push((
                wall.elapsed().as_secs_f64() * 1e3,
                thread.elapsed().as_secs_f64() * 1e3,
                process.elapsed().as_secs_f64() * 1e3,
            ));
            assert_eq!(answer["answer"], "view", "{answer}");
            version = answer["view"]["view_version"].as_u64().unwrap();
            acknowledging.push(rig.timed_notice(4, Some(version)).await.0);
            rig.history(size / 2 + 3 + index as u64 * 2, "a newer historian summary");
            publishes.push(rig.timed_notice(4, Some(version)).await.0);
            version = rig.newest_view().unwrap();
            rig.timed_notice(4, Some(version)).await;
        }
        percentiles("ride building a view", size, &mut rides);
        percentiles("notice publishing a view", size, &mut publishes);
        percentiles("notice acknowledging a ride view", size, &mut acknowledging);
        eprintln!(
            "engine reasons after the view builds at {size}: {:?}",
            resident::counters::engine_reasons()
        );
        let held = rig
            .h
            .provider_store
            .async_runtime
            .resident
            .lock()
            .unwrap()
            .held_bytes(&rig.reference)
            .unwrap_or(0);
        let mut cold = Vec::new();
        for _ in 0..3 {
            rig.h
                .provider_store
                .async_runtime
                .resident
                .lock()
                .unwrap()
                .forget(&rig.reference);
            cold.push(rig.timed_notice(4, Some(version)).await.0);
        }
        percentiles("cold start (first notice after restart)", size, &mut cold);
        let (peak, current) = rss();
        eprintln!(
            "memory at {size}: transcript {transcript} B, resident record {held} B ({:.2}x), process RSS {:.2} GB (peak {:.2} GB)",
            held as f64 / transcript.max(1) as f64,
            current as f64 / 1e9,
            peak as f64 / 1e9
        );
        drop(rig);
    }
}

/// Select a suffix by message count and by Claude BPE tokens in the serialized
/// native messages. Counting schema fields as well as content is conservative:
/// the model's content-only tail is no larger than the selected token budget.
fn covered_suffix(
    entries: &[(ReadMessage, usize)],
    max_messages: usize,
    max_tokens: usize,
) -> (usize, usize) {
    let mut count = 0;
    let mut tokens = 0;
    for (entry, _) in entries.iter().rev().take(max_messages) {
        let measured =
            mc_tokenizer::estimate_tokens(&serde_json::to_string(&entry.message).unwrap());
        if max_tokens != 0 && tokens + measured > max_tokens {
            break;
        }
        count += 1;
        tokens += measured;
    }
    (count, tokens)
}

#[test]
fn covered_benchmark_suffix_respects_both_budgets() {
    let entries = (0..100).map(message).collect::<Vec<_>>();
    let (by_count, _) = covered_suffix(&entries, 3, 0);
    assert_eq!(by_count, 3);
    let (by_tokens, tokens) = covered_suffix(&entries, 100, 4_000);
    assert!(by_tokens > 0 && by_tokens < 100);
    assert!(tokens <= 4_000);
    let next = &entries[entries.len() - by_tokens - 1].0.message;
    assert!(tokens + mc_tokenizer::estimate_tokens(&serde_json::to_string(next).unwrap()) > 4_000);
}

/// A covered-prefix variant of the resident benchmark. Set the token cap to
/// zero and the message cap to 20,000 to model a summarizer outage. Refusals are
/// reported as outcomes, not successful view samples, so oversized views cannot
/// silently disappear from the latency table. `MC_ASYNC_EST_TOKENS` sets the
/// runner's next-request estimate (default 1,000 of the 100,000-token window).
/// Use 95,000 to exercise emergency pressure rather than the quiet-notice band.
#[tokio::test]
#[ignore = "covered-prefix latency benchmark; run explicitly with --ignored --nocapture"]
async fn covered_tail_latency_benchmark() {
    let env = |name: &str, default: &str| std::env::var(name).unwrap_or_else(|_| default.into());
    let sizes = env("MC_ASYNC_SCALING_SIZES", "50000,150000");
    let quiet = env("MC_ASYNC_NOTICES", "10").parse::<usize>().unwrap();
    let views = env("MC_ASYNC_VIEWS", "5").parse::<usize>().unwrap();
    let max_messages = env("MC_ASYNC_TAIL_MESSAGES", "3000")
        .parse::<usize>()
        .unwrap();
    let max_tokens = env("MC_ASYNC_TAIL_TOKENS", "40000")
        .parse::<usize>()
        .unwrap();
    let est_tokens = env("MC_ASYNC_EST_TOKENS", "1000").parse::<u64>().unwrap();
    for size in sizes
        .split(',')
        .map(|size| size.trim().parse::<u64>().unwrap())
    {
        let dir = tempfile::tempdir().unwrap();
        let mut rig = Rig::new(dir.path()).await;
        rig.append(size);
        let (tail, tokens) = covered_suffix(
            &rig.runner.entries.lock().unwrap(),
            max_messages,
            max_tokens,
        );
        assert!(tail > 0 && (tail as u64) < size);
        let covered = size - tail as u64 - 1;
        rig.history(covered, "completed history covering the old prefix");
        let bootstrap = rig.try_timed_notice(0, None, est_tokens).await;
        eprintln!("shape total={size} uncovered={tail} serialized_tail_tokens={tokens} compartment_end={covered} bootstrap={:?} elapsed_ms={:.1}", bootstrap.2, bootstrap.0.0);
        if bootstrap.2.is_err() {
            eprintln!("Bootstrap failed; retrying before ordinary-notice sampling.");
        }
        let mut version = rig.newest_view();
        if bootstrap.2.is_err() {
            let retry = rig.try_timed_notice(0, version, est_tokens).await;
            eprintln!(
                "bootstrap retry outcome={:?} elapsed_ms={:.1}",
                retry.2, retry.0 .0
            );
            retry.2.unwrap();
            version = rig.newest_view();
        }
        let ack = rig.try_timed_notice(0, version, est_tokens).await;
        ack.2.unwrap();
        eprintln!("initial acknowledged version={version:?}");
        let phases_before = phase_stats(&rig.reference);
        let reminder_phases_before = crate::runner_reminders::phase_meter::snapshot();
        let mut notices = Vec::new();
        let mut historian = Vec::new();
        let mut notice_errors = 0;
        let mut evaluations = 0;
        for _ in 0..quiet {
            let before = rig
                .h
                .provider_store
                .async_runtime
                .historian_evaluations
                .load(std::sync::atomic::Ordering::Relaxed);
            let sample_phases = phase_stats(&rig.reference);
            let (sample, background, outcome) = rig.try_timed_notice(4, version, est_tokens).await;
            if sample.0 >= 20.0 {
                eprintln!(
                    "quiet notice above 20ms: wall={:.3}ms own-cpu={:.3}ms phases: {}",
                    sample.0,
                    sample.1,
                    phases(&rig.reference, &sample_phases)
                );
            }
            notices.push(sample);
            if let Err(error) = outcome {
                notice_errors += 1;
                eprintln!("quiet notice failed: {error:?}");
            }
            let after = rig
                .h
                .provider_store
                .async_runtime
                .historian_evaluations
                .load(std::sync::atomic::Ordering::Relaxed);
            if after > before {
                evaluations += after - before;
                historian.push((background, background, background));
            }
        }
        percentiles("quiet notice (+4 msgs)", size, &mut notices);
        if !historian.is_empty() {
            percentiles(
                "historian evaluation (process CPU after notice)",
                size,
                &mut historian,
            );
        }
        eprintln!("quiet errors={notice_errors}/{quiet}, scheduled evaluations={evaluations}");
        for (phase, (calls, nanos)) in crate::runner_reminders::phase_meter::snapshot() {
            let (before_calls, before_nanos) = reminder_phases_before
                .get(phase)
                .copied()
                .unwrap_or_default();
            eprintln!(
                "reminder phase {phase}: {:.3}ms/{}",
                (nanos - before_nanos) as f64 / 1e6,
                calls - before_calls
            );
        }
        eprintln!(
            "quiet phase totals: {}",
            phases(&rig.reference, &phases_before)
        );
        eprintln!("engine reasons: {:?}", resident::counters::engine_reasons());
        let namespace = rig.state().namespace();
        let actual = rig.store().max_compartment_end_ordinal(&namespace).unwrap();
        assert_eq!(actual, covered as i64);
        let (peak, current) = rss();
        eprintln!("after quiet notices RSS_bytes={current} peak_RSS_bytes={peak} compartment_end={actual} uncovered_messages={}", tail + quiet * 4);
        let mut rides = Vec::new();
        let mut publishes = Vec::new();
        let mut ride_errors = 0;
        let mut publish_errors = 0;
        for index in 0..views {
            rig.history(covered + 1 + index as u64 * 2, "a newer completed summary");
            let wall = Instant::now();
            let thread = cpu_time::ThreadTime::now();
            let process = cpu_time::ProcessTime::now();
            let answer = rig
                .op(
                    "compaction.ride",
                    json!({"session_ref":rig.reference,"cause":"ceiling","deadline_ms":300_000}),
                )
                .await;
            rides.push((
                wall.elapsed().as_secs_f64() * 1e3,
                thread.elapsed().as_secs_f64() * 1e3,
                process.elapsed().as_secs_f64() * 1e3,
            ));
            if answer["answer"] == "view" {
                version = answer["view"]["view_version"].as_u64();
                eprintln!(
                    "view total={size} bytes={} ranges={}",
                    serde_json::to_vec(&answer["view"]).unwrap().len(),
                    answer["view"]["ranges"].as_array().unwrap().len()
                );
            } else {
                ride_errors += 1;
                eprintln!("ride failed: {answer}");
            }
            let ack = rig.try_timed_notice(0, version, est_tokens).await;
            eprintln!("acknowledging notice outcome={:?}", ack.2);
            rig.history(covered + 2 + index as u64 * 2, "another completed summary");
            let (sample, _, outcome) = rig.try_timed_notice(0, version, est_tokens).await;
            publishes.push(sample);
            if let Err(error) = outcome {
                publish_errors += 1;
                eprintln!("publishing notice failed: {error:?}");
            }
            version = rig.newest_view();
        }
        percentiles("ride attempt", size, &mut rides);
        percentiles("publishing notice attempt", size, &mut publishes);
        eprintln!(
            "ride errors={ride_errors}/{views}, publishing notice errors={publish_errors}/{views}"
        );
        let namespace = rig.state().namespace();
        let meta = rig.store().load_meta(&namespace).unwrap().meta;
        let compartment_end = rig.store().max_compartment_end_ordinal(&namespace).unwrap();
        let (peak, current) = rss();
        eprintln!("memory total={size} RSS_bytes={current} peak_RSS_bytes={peak} persisted_compartment_end={compartment_end} applied_coverage={:?}", meta.coverage_ordinal);
    }
}
