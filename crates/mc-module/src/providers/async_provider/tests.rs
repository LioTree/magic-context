use super::*;
use cortexkit_bus_inmemory::{InMemoryBus, InMemoryConfig};

#[derive(Default)]
struct Runner {
    /// The session runner module the conversation was admitted under.
    module: String,
    entries: Mutex<Vec<ReadMessage>>,
    lineage: Mutex<String>,
    read_delay_ms: std::sync::atomic::AtomicU64,
    routed_reads: std::sync::atomic::AtomicU64,
}

#[async_trait]
impl session_resolver::ProviderRunner for Runner {
    async fn call_for(
        &self,
        route: &crate::route_targets::SessionRunnerRoute,
        project: &Path,
        method: &str,
        params: Value,
        budget: Duration,
    ) -> Result<Value, SessionResolveError> {
        assert_eq!(route.module_id(), self.module);
        assert_eq!(route.parent_session(), "s");
        if method == "session.read" {
            self.routed_reads
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        self.call(project, route.parent_session(), method, params, budget)
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
        let delay = self
            .read_delay_ms
            .load(std::sync::atomic::Ordering::Relaxed);
        if delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        let lineage = self.lineage.lock().unwrap().clone();
        if params["lineage_id"]
            .as_str()
            .is_some_and(|held| held != lineage)
        {
            return Err(SessionResolveError::InvalidResponse(
                "lineage_changed".into(),
            ));
        }
        let from = params["from_ordinal"]
            .as_u64()
            .expect("range read, never tail");
        let entries = self.entries.lock().unwrap();
        let messages = entries
            .iter()
            .filter(|e| e.ordinal >= from)
            .take(7)
            .cloned()
            .collect::<Vec<_>>();
        let mut page = json!({"lineage_id":lineage,"messages":messages});
        if let Some(last) = messages
            .last()
            .filter(|last| entries.last().is_some_and(|end| end.ordinal > last.ordinal))
        {
            page["next_from_ordinal"] = json!(last.ordinal + 1);
        }
        Ok(page)
    }
}

struct Rig {
    h: Arc<McHandler>,
    runner: Arc<Runner>,
    bus: Arc<InMemoryBus>,
    task: tokio::task::JoinHandle<()>,
    reference: String,
    module: String,
}
impl Drop for Rig {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn response(result: HandlerOutcome) -> Value {
    let HandlerOutcome::Response(bytes) = result else {
        panic!("{result:?}")
    };
    serde_json::from_slice(&bytes).unwrap()
}

impl Rig {
    async fn new(dir: &Path) -> Self {
        Self::open(
            dir,
            "thalamus-harness",
            "opencode",
            json!({"serializer_profile":"opencode-aisdk"}),
        )
        .await
    }
    /// A rig whose route is admitted under runner module `module` and whose
    /// conversation is set up for `harness` with plan `params`.
    async fn open(dir: &Path, module: &str, harness: &str, params: Value) -> Self {
        let descriptor = StorageDescriptor {
            module_id: DEFAULT_MODULE_ID.into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.join("store.db").to_string_lossy().into(),
            },
        };
        let store = Arc::new(McStore::open_for_test(&descriptor).unwrap());
        let runner = Arc::new(Runner {
            module: module.into(),
            lineage: Mutex::new("L".into()),
            ..Default::default()
        });
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
                    module_id: module.into(),
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
        let reference = session_ref(harness, &dir.to_string_lossy(), "s");
        let rig = Self {
            h,
            runner,
            bus,
            task,
            reference,
            module: module.into(),
        };
        let answer=rig.op("compaction.setup",json!({"session":"s","harness":harness,"request_id":"setup","model":"fixture","context_window":100_000,"composition":{"render_tags":true},"params":params,"lineage_id":"L","now":1})).await;
        assert_eq!(answer["answer"], "ready", "{answer}");
        assert_eq!(answer["ceiling"]["at_share"], 0.95);
        rig
    }
    async fn op(&self, method: &str, params: Value) -> Value {
        response(
            self.h
                .dispatch_value(7, json!({"method":method,"params":params}))
                .await,
        )
    }
    fn state(&self) -> State {
        load(self.h.store.get().unwrap(), &self.reference)
            .unwrap()
            .unwrap()
    }
    async fn queue(&self, numbers: &[u64]) {
        let drop = numbers
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let answer = response(
            self.h
                .dispatch_value(7, json!({"name":"ctx_reduce","arguments":{"drop":drop}}))
                .await,
        );
        assert_ne!(answer["isError"], true, "{answer}");
        assert!(
            !self
                .h
                .store
                .get()
                .unwrap()
                .load_pending_agent_drops(&self.state().namespace())
                .unwrap()
                .is_empty(),
            "the public ctx_reduce route must enqueue engine work"
        );
    }
    fn fill(&self, count: u64) {
        *self.runner.entries.lock().unwrap()=(0..count).map(|n| {
            let part=if n%5>0 && n%5<4 {
                json!({"id":format!("p{n}"),"type":"tool","tool":"read","callID":format!("call{n}"),"state":{"status":"completed","input":{"path":format!("file{n}")},"output":"exact spent output ".repeat(500)}})
            } else {json!({"id":format!("p{n}"),"type":"text","text":format!("message {n} ")+&"durable words ".repeat(16)})};
            ReadMessage::new(n,format!("m{n}"),json!({"info":{"id":format!("m{n}"),"role":if n%5==0{"user"}else{"assistant"},"time":{"created":1}},"parts":[part]})).with_tags(vec![tags::PartTag::tagged("0",format!("§{}§",100+n*3))])
        }).collect();
    }
    async fn notice_with_descent(
        &self,
        seq: u64,
        size: u64,
        applied: Option<u64>,
        descent: Option<String>,
    ) {
        self.notice_with(seq, size, applied, descent, Vec::new())
            .await;
    }
    /// Publish advance notice `seq` with the runner's `events` and wait for
    /// the provider to finish ingesting it.
    async fn notice_with(
        &self,
        seq: u64,
        size: u64,
        applied: Option<u64>,
        descent: Option<String>,
        events: Vec<notice::Event>,
    ) {
        let last = self.runner.entries.lock().unwrap().last().cloned().unwrap();
        let mut notice = notice::AdvanceNotice::new(
            &self.reference,
            seq,
            self.runner.lineage.lock().unwrap().clone(),
            last.ordinal,
            contract::digest::content_digest(&last.message),
            size,
            "fixture",
        )
        .with_window(100_000);
        if let Some(version) = applied {
            notice = notice.with_applied_view_version(version);
        }
        if !events.is_empty() {
            notice = notice.with_events(events);
        }
        let mut headers = notice.to_headers();
        headers.insert(
            "lineage_id".into(),
            self.runner.lineage.lock().unwrap().clone(),
        );
        if let Some(descent) = descent {
            headers.insert("descends_from".into(), descent);
        }
        let notice = notice::AdvanceNotice::from_headers(&headers).unwrap();
        let receipt = self
            .bus
            .publish(
                &notice::event_subject("fixture", &self.module, notice::ADVANCED_EVENT),
                &bus_id(&self.reference, "advanced", seq),
                notice.digest().parse().unwrap(),
                headers,
            )
            .await
            .unwrap();
        assert!(!receipt.duplicate());
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if self.state().completed_seq >= seq
                    && !self.state().entries.is_empty()
                    && self
                        .h
                        .provider_store
                        .async_runtime
                        .completed_notice
                        .load(std::sync::atomic::Ordering::Relaxed)
                        >= seq
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("notice ingested");
    }
    async fn notice(&self, seq: u64, size: u64, applied: Option<u64>) {
        self.notice_with_descent(seq, size, applied, None).await;
    }
    fn newest(&self) -> Option<u64> {
        self.state().published_engine.keys().next_back().copied()
    }
    fn history(&self, end: u64, content: &str) {
        let namespace = self.state().namespace();
        let store = self.h.store.get().unwrap();
        store
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
        store.arm_soft_refresh(&namespace).unwrap();
    }
    async fn get(&self, version: u64) -> view::CompactionView {
        let answer = self
            .op(
                "view.get",
                json!({"session_ref":self.reference,"view_version":version}),
            )
            .await;
        assert_eq!(answer["answer"], "view");
        decode(&answer["view"]).unwrap()
    }
    async fn ride(&self, cause: &str) -> Option<view::CompactionView> {
        let answer = self
            .op(
                "compaction.ride",
                json!({"session_ref":self.reference,"cause":cause,"deadline_ms":10_000}),
            )
            .await;
        if answer["answer"] == "view" {
            Some(decode(&answer["view"]).unwrap())
        } else {
            None
        }
    }
    fn render(&self, view: &view::CompactionView) -> Vec<u8> {
        assert_eq!(independent_digest(view), view.digest);
        let entries = self.runner.entries.lock().unwrap();
        let mut output = Vec::new();
        for range in &view.ranges {
            match range {
                view::ViewRange::Replace { bytes, .. } => {
                    output.extend(serde_json::from_str::<Vec<Value>>(bytes).unwrap())
                }
                view::ViewRange::Keep { from, to, edits } => {
                    for entry in entries
                        .iter()
                        .filter(|e| e.ordinal >= *from && e.ordinal < *to)
                    {
                        let mut message = entry.message.clone();
                        let mut rendered = Vec::new();
                        for (part, row) in parts(&entry.message).unwrap().iter().zip(&entry.tags) {
                            let edit = edits
                                .iter()
                                .find(|e| e.ordinal == entry.ordinal && e.part == row.part);
                            match edit {
                                Some(edit) if edit.drop => {}
                                Some(edit) => rendered.push(
                                    serde_json::from_str(edit.bytes.as_ref().unwrap()).unwrap(),
                                ),
                                None => {
                                    let mut part = part.clone();
                                    if let Some(tag) = &row.tag {
                                        let pointer = if part["type"] == "tool" {
                                            "/state/output"
                                        } else {
                                            "/text"
                                        };
                                        let text = part.pointer_mut(pointer).unwrap();
                                        *text = json!(format!("{tag} {}", text.as_str().unwrap()));
                                    }
                                    rendered.push(part);
                                }
                            }
                        }
                        message["parts"] = json!(rendered);
                        output.push(message);
                    }
                }
                _ => panic!("unknown range kind"),
            }
        }
        for entry in entries
            .iter()
            .filter(|e| e.ordinal > view.covers_through.ordinal)
        {
            output.push(entry.message.clone());
        }
        serde_json::to_vec(&output).unwrap()
    }
}

fn independent_digest(view: &view::CompactionView) -> String {
    let mut fields = vec![
        "ck.compaction.view.v1".into(),
        view.session_ref.clone(),
        view.view_version.to_string(),
        view.lineage_id.clone(),
        view.covers_through.ordinal.to_string(),
        view.covers_through.mid.clone(),
        view.ranges.len().to_string(),
    ];
    for range in &view.ranges {
        match range {
            view::ViewRange::Replace { from, to, bytes } => fields.extend([
                "replace".into(),
                from.to_string(),
                to.to_string(),
                bytes.clone(),
            ]),
            view::ViewRange::Keep { from, to, edits } => {
                fields.extend([
                    "keep".into(),
                    from.to_string(),
                    to.to_string(),
                    edits.len().to_string(),
                ]);
                for edit in edits {
                    fields.extend([
                        edit.ordinal.to_string(),
                        edit.mid.clone(),
                        edit.part.clone(),
                    ]);
                    if edit.drop {
                        fields.push("drop".into());
                    } else {
                        fields.extend(["bytes".into(), edit.bytes.clone().unwrap()]);
                    }
                }
            }
            _ => panic!("unknown range kind"),
        }
    }
    if let Some(cut) = &view.cut {
        fields.extend([
            "cut".into(),
            cut.cut_id.clone(),
            cut.through_ordinal.to_string(),
        ]);
    }
    let mut hash = sha2::Sha256::new();
    for field in fields {
        hash.update((field.len() as u64).to_be_bytes());
        hash.update(field.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

#[tokio::test]
async fn defer_never_publishes_and_runner_tags_are_not_allocated() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1000, None).await;
    assert_eq!(rig.newest(), None, "defer must not publish");
    let state = rig.state();
    assert_eq!(
        tag_rows(&state, codec::Codec::OpencodeAiSdk).unwrap().len(),
        40,
        "all runner parts must be indexed"
    );
    let rows = rig
        .h
        .store
        .get()
        .unwrap()
        .load_tags_for_session(&state.namespace())
        .unwrap();
    assert_eq!(
        rows.iter()
            .map(|row| row.tag_number)
            .collect::<BTreeSet<_>>(),
        (0..40).map(|n| 100 + n * 3).collect()
    );
    rig.history(20, "first completed historian summary");
    rig.notice(2, 1_000, None).await;
    let baseline = rig.newest().expect("new history publishes");
    rig.queue(&[163, 166, 169]).await;
    rig.notice(3, 90_000, Some(baseline)).await;
    let version = rig.newest().expect("execute threshold publishes");
    assert!(
        version > baseline,
        "queued reductions publish at execute threshold"
    );
    let view = rig.get(version).await;
    let bytes = rig.render(&view);
    rig.notice(4, 1000, Some(version)).await;
    assert_eq!(rig.newest(), Some(version));
    assert_eq!(
        rig.render(&view),
        bytes,
        "defer replays byte-identical rendered request"
    );
}

#[tokio::test]
async fn long_session_history_ride_ceiling_resync_and_restart() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    rig.history(20, "initial historian summary");
    rig.notice(2, 1_000, None).await;
    let baseline = rig.newest().expect("initial history publication");
    rig.queue(&[163, 166, 169]).await;
    rig.notice(3, 90_000, Some(baseline)).await;
    let first = rig.newest().unwrap();
    let _ = rig.render(&rig.get(first).await);
    let namespace = rig.state().namespace();
    let store = rig.h.store.get().unwrap();
    store
        .replace_compartments(
            &namespace,
            &[mc_store::StoredCompartment {
                sequence: 1,
                start_message: 0,
                end_message: 20,
                end_message_id: "m20#0".into(),
                title: "history".into(),
                content: "finished summary".into(),
                p1: Some("finished summary".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
    store.arm_soft_refresh(&namespace).unwrap();
    rig.notice(4, 1000, Some(first)).await;
    let history = rig.newest().unwrap();
    assert!(history > first);
    let view = rig.get(history).await;
    let _ = rig.render(&view);
    rig.history(20, "queued summary rides cache expiry");
    let ride = rig.ride("ttl_expired").await.expect("cache rebuild ride");
    assert!(ride.view_version > history);
    let _ = rig.render(&ride);
    rig.history(20, "queued summary rides ceiling");
    let ceiling = rig.ride("ceiling").await.expect("ceiling view");
    let _ = rig.render(&ceiling);
    let policy = CeilingPolicy::new(0.95, 10).with_on_overflow();
    assert_eq!(
        policy.decide(
            100_001,
            100_000,
            false,
            contract::ceiling::WaitEnd::TimedOut
        ),
        contract::ceiling::CeilingDecision::Refuse {
            cause: "over_window"
        }
    );
    *rig.runner.lineage.lock().unwrap() = "reverted".into();
    rig.fill(10);
    rig.notice(5, 1000, None).await;
    let restored = rig.newest().unwrap();
    assert!(restored > ceiling.view_version);
    assert_eq!(rig.get(restored).await.lineage_id, "reverted");
    let again = rig.get(restored).await;
    assert_eq!(
        serde_json::to_vec(&again).unwrap(),
        serde_json::to_vec(&rig.get(restored).await).unwrap(),
        "runner restart pulls identical immutable version"
    );
    let reserved = store
        .reserve_async_compaction_version(&rig.reference, restored)
        .unwrap();
    let next = store
        .reserve_async_compaction_version(&rig.reference, 0)
        .unwrap();
    assert!(next > reserved, "restart skips reserved versions");
}

#[tokio::test]
async fn old_notice_and_view_ids_collide_but_event_named_ids_do_not() {
    let bus = InMemoryBus::new(InMemoryConfig::default());
    let digest = ContentDigest::of_bytes(b"claim");
    assert!(!bus
        .publish(
            "ck.fixture.event.runner.compaction.advanced.v1",
            "abc:1",
            digest,
            BTreeMap::new()
        )
        .await
        .unwrap()
        .duplicate());
    assert!(bus
        .publish(
            "ck.fixture.event.magic-context.compaction.view_ready.v1",
            "abc:1",
            digest,
            BTreeMap::new()
        )
        .await
        .unwrap()
        .duplicate());
    for kind in ["advanced", "view_ready"] {
        assert!(!bus
            .publish(
                "ck.fixture.event.runner.compaction.advanced.v1",
                &bus_id("abc", kind, 1),
                digest,
                BTreeMap::new()
            )
            .await
            .unwrap()
            .duplicate());
    }
}

#[test]
fn part_edit_bytes_participate_in_digest() {
    let view = view::CompactionView::new(
        "00000000000000000000000000000000",
        1,
        "L",
        compact::lineage::MessageRef {
            ordinal: 0,
            mid: "m0".into(),
        },
        vec![view::ViewRange::keep_with_edits(
            0,
            1,
            vec![view::PartEdit::replace(
                0,
                "m0",
                "p0",
                "{\"text\":\"[dropped §100§]\"}",
            )],
        )],
    );
    let view = checked_async_view(view).unwrap();
    assert_eq!(view.digest, independent_digest(&view));
    let mut changed = view.clone();
    if let view::ViewRange::Keep { edits, .. } = &mut changed.ranges[0] {
        edits[0].bytes = Some("{\"text\":\"wrong\"}".into());
    }
    assert_ne!(view.digest, independent_digest(&changed));
    assert!(changed.check().is_err());
}

#[tokio::test]
async fn threshold_without_reclaimable_work_never_publishes() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    for entry in rig.runner.entries.lock().unwrap().iter_mut() {
        entry.message["parts"] = json!([{"id":format!("p{}",entry.ordinal),"type":"text","text":format!("plain message {}",entry.ordinal)}]);
    }
    rig.notice(1, 90_000, None).await;
    assert!(
        rig.newest().is_none(),
        "pressure alone grants no prefix mutation"
    );
}

#[tokio::test]
async fn versions_survive_provider_restart() {
    let dir = tempfile::tempdir().unwrap();
    let mut rig = Rig::new(dir.path()).await;
    let reference = rig.reference.clone();
    let first = rig
        .h
        .store
        .get()
        .unwrap()
        .reserve_async_compaction_version(&reference, 0)
        .unwrap();
    rig.task.abort();
    let _ = (&mut rig.task).await;
    drop(rig);
    let resumed = Rig::new(dir.path()).await;
    let next = resumed
        .h
        .store
        .get()
        .unwrap()
        .reserve_async_compaction_version(&reference, 0)
        .unwrap();
    assert!(
        next > first,
        "a restart must not reuse an allocated version"
    );
}

#[tokio::test]
async fn fork_descent_requires_recorded_digest() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    let state = rig.state();
    let digest = contract::digest::content_digest(&state.entries[&9].message);
    assert_eq!(verified_descent(&state, &format!("L:9:{digest}")), Some(9));
    assert_eq!(
        verified_descent(&state, &format!("L:9:{}", "0".repeat(64))),
        None,
        "unverified descent must be a full resync"
    );
    assert_eq!(verified_descent(&state, &format!("other:9:{digest}")), None);
}

#[tokio::test]
async fn published_part_edits_have_full_digest() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    rig.history(20, "history before explicit reduction");
    rig.notice(2, 1_000, None).await;
    let baseline = rig.newest().unwrap();
    rig.queue(&[163]).await;
    rig.notice(3, 90_000, Some(baseline)).await;
    let view = rig.get(rig.newest().unwrap()).await;
    assert_eq!(view.digest, independent_digest(&view));
    let edits = view
        .ranges
        .iter()
        .filter_map(|range| match range {
            view::ViewRange::Keep { edits, .. } => Some(edits),
            _ => None,
        })
        .flatten()
        .collect::<Vec<_>>();
    assert!(
        edits.iter().any(|edit| edit
            .bytes
            .as_ref()
            .is_some_and(|bytes| bytes.contains("[dropped §163§]"))),
        "queued reductions must be part edits carrying the exact drop placeholder"
    );
    let _ = rig.render(&view);
}

#[tokio::test]
async fn runner_ordinals_may_start_at_one() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(10);
    rig.runner
        .entries
        .lock()
        .unwrap()
        .retain(|entry| entry.ordinal > 0);
    rig.notice(1, 1_000, None).await;
    assert_eq!(rig.state().entries.first_key_value().unwrap().0, &1);
}

#[tokio::test]
async fn fork_descent_preserves_only_verified_prefix_state() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    let before = rig.state();
    let digest = contract::digest::content_digest(&before.entries[&9].message);
    rig.runner.entries.lock().unwrap().truncate(10);
    *rig.runner.lineage.lock().unwrap() = "fork:verified".into();
    rig.notice_with_descent(2, 1_000, None, Some(format!("L:9:{digest}")))
        .await;
    let retained = rig.state();
    assert_eq!(retained.generation, before.generation);
    assert_eq!(retained.tag_index.len(), 10);
    assert_eq!(retained.lineage.as_deref(), Some("fork:verified"));
    *rig.runner.lineage.lock().unwrap() = "fork:unverified".into();
    rig.notice_with_descent(
        3,
        1_000,
        None,
        Some(format!("fork:verified:9:{}", "0".repeat(64))),
    )
    .await;
    let reread = rig.state();
    assert!(reread.generation > retained.generation);
    assert_eq!(reread.tag_index.len(), 10);
    assert_eq!(reread.lineage.as_deref(), Some("fork:unverified"));
}

#[tokio::test]
async fn ordinary_execute_with_only_drops_defers_but_m1_refresh_publishes() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    rig.history(10, "stable baseline history");
    rig.notice(2, 1_000, None).await;
    let baseline = rig.newest().unwrap();
    rig.queue(&[163, 166, 169]).await;
    rig.notice(3, 75_000, Some(baseline)).await;
    assert_eq!(
        rig.newest(),
        Some(baseline),
        "ordinary Execute does not originate a bust for drops alone"
    );
    let namespace = rig.state().namespace();
    let store = rig.h.store.get().unwrap();
    assert_eq!(store.load_pending_agent_drops(&namespace).unwrap().len(), 3);
    let mut rows = store.load_compartments(&namespace).unwrap();
    rows.push(mc_store::StoredCompartment {
        sequence: 2,
        start_message: 11,
        end_message: 15,
        end_message_id: "m15#0".into(),
        title: "delta".into(),
        content: "queued in-session history delta".into(),
        p1: Some("queued in-session history delta".into()),
        importance: 50,
        ..Default::default()
    });
    store.replace_compartments(&namespace, &rows).unwrap();
    rig.notice(4, 1_000, Some(baseline)).await;
    assert_eq!(
        rig.newest(),
        Some(baseline),
        "M1 delta remains queued below Execute"
    );
    rig.notice(5, 75_000, Some(baseline)).await;
    let version = rig.newest().unwrap();
    assert!(
        version > baseline,
        "ordinary Execute publishes an M1 refresh, carrying queued drops"
    );
    assert!(store
        .load_pending_agent_drops(&namespace)
        .unwrap()
        .is_empty());
    let _ = rig.render(&rig.get(version).await);
}

#[tokio::test]
async fn ride_deadline_returns_nothing_without_waiting_for_slow_runner() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(10);
    rig.notice(1, 1_000, None).await;
    rig.runner
        .read_delay_ms
        .store(500, std::sync::atomic::Ordering::Relaxed);
    let started = Instant::now();
    let answer = rig
        .op(
            "compaction.ride",
            json!({"session_ref":rig.reference,"cause":"ceiling","deadline_ms":10}),
        )
        .await;
    assert_eq!(answer["answer"], "nothing");
    assert!(started.elapsed() < Duration::from_millis(250));
}

#[tokio::test]
async fn reads_use_the_admitted_runner_not_the_process_default() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(10);
    rig.notice(1, 1_000, None).await;
    assert!(
        rig.runner
            .routed_reads
            .load(std::sync::atomic::Ordering::Relaxed)
            >= 2
    );
    let state = rig.state();
    assert_eq!(state.runner_route.unwrap()["module_id"], "thalamus-harness");
    let project = state.dream_target.as_ref().unwrap()["project"]
        .as_str()
        .unwrap();
    assert!(
        rig.h.dream_runs.target_for_test(project).is_none(),
        "background-disabled conversations must not start a dream schedule"
    );
    assert_eq!(state.dream_target.unwrap()["route"]["parent_session"], "s");
}

#[tokio::test]
async fn ceiling_overflow_ride_with_reported_limit_updates_learned_limit() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(10);
    rig.notice(1, 1_000, None).await;
    let answer=rig.op("compaction.ride",json!({"session_ref":rig.reference,"cause":"ceiling","deadline_ms":10_000,"overflow":{"reported_limit_tokens":80_000}})).await;
    assert!(matches!(
        answer["answer"].as_str(),
        Some("view" | "nothing")
    ));
    let state = rig.state();
    let policy = state.usage_policy.as_ref().unwrap();
    assert_eq!(policy.limit_for("fixture"), Some(80_000));
    let _ = rig.ride("ceiling").await;
    assert_eq!(
        rig.state()
            .usage_policy
            .as_ref()
            .unwrap()
            .limit_for("fixture"),
        Some(80_000),
        "an absent overflow fact must not clear an existing learned limit"
    );
}

#[tokio::test]
async fn plain_ceiling_ride_does_not_invent_a_learned_limit() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(10);
    rig.notice(1, 1_000, None).await;
    let _ = rig.ride("ceiling").await;
    assert!(rig
        .state()
        .usage_policy
        .as_ref()
        .unwrap()
        .learned_limit
        .is_none());
}

#[tokio::test]
async fn synthetic_ids_never_fall_back_to_positional_transcript_matches() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(1);
    rig.notice(1, 1_000, None).await;
    let state = rig.state();
    let entry = &state.entries[&0];
    let original = codec::Codec::OpencodeAiSdk
        .decode_message(&InboundMessage {
            ordinal: 0,
            mid: entry.mid.clone(),
            message: entry.message.clone(),
        })
        .unwrap();
    let engine = transform::compaction::View {
        compaction_id: "proof".into(),
        version: 1,
        range: transform::compaction::Range {
            lineage_id: "L".into(),
            from: 0,
            to: 1,
        },
        replacement: vec![original.ck],
    };
    let wire:OutboundMessage=decode(&json!({"compaction_id":"proof","version":1,"range":{"from":0,"to":1},"replacement":[{"info":{"id":"synthetic-todo","role":"user"},"parts":[{"id":"synthetic-part","type":"text","text":"inserted content"}]},entry.message]})).unwrap();
    let ranges = ranges(&state, codec::Codec::OpencodeAiSdk, &wire, &engine, None).unwrap();
    assert!(matches!(
        &ranges[0],
        view::ViewRange::Replace { from: 0, to: 0, .. }
    ));
    assert!(matches!(&ranges[1],view::ViewRange::Keep{from:0,to:1,edits} if edits.is_empty()));
}

#[tokio::test]
async fn restored_lineage_reuses_history_embeddings_and_reanchors_only_surviving_drops() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    rig.history(20, "published history survives a runner backup restore");
    rig.notice(2, 1_000, None).await;
    let old_version = rig.newest().unwrap();
    rig.notice(3, 1_000, Some(old_version)).await;
    let old_view = rig.get(old_version).await;
    assert_eq!(
        old_view.ranges[0].to(),
        21,
        "the history replacement must remove its covered raw prefix"
    );
    let old_head = match &old_view.ranges[0] {
        view::ViewRange::Replace { bytes, .. } => bytes.clone(),
        _ => panic!("history head"),
    };
    rig.queue(&[163, 208]).await;
    let held = rig.state();
    let tool = decoded_entry(
        codec::Codec::OpencodeAiSdk,
        &InboundMessage {
            ordinal: 21,
            mid: "m21".into(),
            message: held.entries[&21].message.clone(),
        },
    )
    .unwrap();
    assert_eq!(tool.ck.content.len(), 2);
    assert!(matches!(
        tool.ck.content[0].kind,
        ck_wire::CkKind::ToolCall { .. }
    ));
    assert!(matches!(
        tool.ck.content[1].kind,
        ck_wire::CkKind::ToolResult { .. }
    ));
    assert_eq!(held.tag_index["§163§"].part, "0");
    tokio::time::timeout(Duration::from_secs(2), async {
        while rig
            .h
            .provider_store
            .async_runtime
            .historian_evaluations
            .load(std::sync::atomic::Ordering::Relaxed)
            == 0
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let evaluations = rig
        .h
        .provider_store
        .async_runtime
        .historian_evaluations
        .load(std::sync::atomic::Ordering::Relaxed);
    let before = rig.state();
    let source = before.namespace();
    let store = rig.h.store.get().unwrap();
    store.with_context_conn_for_test(|conn| {
        conn.execute("INSERT INTO compartment_chunk_embeddings(compartment_id,session_id,project_path,harness,window_index,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,created_at) SELECT id,?1,'fixture','opencode',0,0,20,'unchanged-chunk-hash','fixture-model',1,x'0000803f',1 FROM compartments WHERE session_id=?1 AND sequence=1",[&source])?;
        Ok(())
    }).unwrap();
    {
        let mut entries = rig.runner.entries.lock().unwrap();
        entries.truncate(31);
        for entry in entries.iter_mut() {
            entry.tags[0].tag = Some(format!("§{}§", 9_000 + entry.ordinal * 3));
        }
    }
    *rig.runner.lineage.lock().unwrap() = "runner-restored".into();
    rig.notice(4, 1_000, None).await;
    let after = rig.state();
    assert!(after.generation > before.generation);
    assert_eq!(after.last_discarded_drops, 1);
    assert_eq!(after.last_transferred_drops, 1);
    assert_eq!(
        rig.h
            .provider_store
            .async_runtime
            .historian_evaluations
            .load(std::sync::atomic::Ordering::Relaxed),
        evaluations,
        "a restore of known messages must not even schedule another historian evaluation"
    );
    let restored = rig.get(rig.newest().unwrap()).await;
    let new_head = match &restored.ranges[0] {
        view::ViewRange::Replace { bytes, .. } => bytes,
        _ => panic!("restored history head"),
    };
    assert_eq!(
        new_head, &old_head,
        "restored history head must remain byte-identical"
    );
    assert!(after.tag_index.contains_key("§9063§"));
    let dropped = restored.ranges.iter().any(|range| match range {
        view::ViewRange::Keep { edits, .. } => edits
            .iter()
            .any(|edit| edit.mid == "m21" && edit.part == "0" && edit.drop),
        _ => false,
    });
    assert!(
        dropped,
        "the tool-part tag must remove the whole native pair, not a CK block numbered 0 or 1"
    );
    assert!(store.load_pending_agent_drops(&source).unwrap().is_empty());
    let target = after.namespace();
    let embedding: Vec<(String, Vec<u8>)> = store
        .with_context_read(|conn| {
            conn.prepare(
                "SELECT chunk_hash,vector FROM compartment_chunk_embeddings WHERE session_id=?1",
            )?
            .query_map([&target], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect()
        })
        .unwrap();
    assert_eq!(
        embedding,
        vec![("unchanged-chunk-hash".into(), vec![0, 0, 128, 63])],
        "copy vectors without an embedding call"
    );
    assert_eq!(
        store.load_compartments(&target).unwrap()[0].content,
        "published history survives a runner backup restore"
    );
    let _ = rig.render(&restored);
    rig.runner.entries.lock().unwrap().push(ReadMessage::new(31,"new-user-after-restore",json!({"info":{"id":"new-user-after-restore","role":"user","time":{"created":2}},"parts":[{"id":"new-part","type":"text","text":"a genuinely new turn"}]})).with_tags(vec![tags::PartTag::tagged("0","§20000§")]));
    rig.notice(5, 1_000, None).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while rig
            .h
            .provider_store
            .async_runtime
            .historian_evaluations
            .load(std::sync::atomic::Ordering::Relaxed)
            == evaluations
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("a real new user turn must still wake the historian");
}

/// The runner tag llm-runner would serve for part `part` of message `n` in
/// [`anthropic_transcript`].
fn anthropic_tag(n: u64, part: u64) -> u64 {
    1_000 + n * 10 + part
}

/// A Claude Code transcript in the `anthropic-messages` schema, repeating a
/// four-message turn: a string-content prompt, an assistant message with a
/// signed thinking block, its tool result, and a final answer. Text and tool
/// result parts are tagged; thinking and tool_use parts carry no tag.
fn anthropic_transcript(count: u64) -> Vec<ReadMessage> {
    (0..count)
        .map(|n| {
            let tagged = |part: u64| tags::PartTag::tagged(part.to_string(), format!("§{}§", anthropic_tag(n, part)));
            let (message, rows) = match n % 4 {
                0 => (
                    json!({"role":"user","content":format!("message {n} ")+&"durable words ".repeat(16)}),
                    vec![tagged(0)],
                ),
                1 => (
                    json!({"role":"assistant","content":[
                        {"type":"thinking","thinking":format!("plan {n}"),"signature":format!("EqQBsig{n}+/==")},
                        {"type":"text","text":format!("reading file {n} ")+&"careful words ".repeat(8)},
                        {"type":"tool_use","id":format!("toolu_{n}"),"name":"read","input":{"path":format!("file{n}")}},
                    ]}),
                    vec![tags::PartTag::untagged("0"), tagged(1), tags::PartTag::untagged("2")],
                ),
                2 => (
                    json!({"role":"user","content":[
                        {"type":"tool_result","tool_use_id":format!("toolu_{}", n - 1),"content":"exact spent output ".repeat(500)},
                    ]}),
                    vec![tagged(0)],
                ),
                _ => (
                    json!({"role":"assistant","content":[{"type":"text","text":format!("answer {n} ")+&"durable words ".repeat(16)}]}),
                    vec![tagged(0)],
                ),
            };
            ReadMessage::new(n, format!("m{n}"), message).with_tags(rows)
        })
        .collect()
}

impl Rig {
    /// Apply `view` to the runner's `anthropic-messages` transcript the way
    /// the runner does: replacement ranges as sent, kept parts with their
    /// rendered tags, edited parts with their edit bytes.
    fn render_anthropic(&self, view: &view::CompactionView) -> Vec<Value> {
        assert_eq!(independent_digest(view), view.digest);
        let entries = self.runner.entries.lock().unwrap();
        let mut output = Vec::new();
        for range in &view.ranges {
            match range {
                view::ViewRange::Replace { bytes, .. } => {
                    output.extend(serde_json::from_str::<Vec<Value>>(bytes).unwrap())
                }
                view::ViewRange::Keep { from, to, edits } => {
                    for entry in entries
                        .iter()
                        .filter(|e| e.ordinal >= *from && e.ordinal < *to)
                    {
                        let mut rendered = Vec::new();
                        for (part, row) in parts(&entry.message).unwrap().iter().zip(&entry.tags) {
                            match edits
                                .iter()
                                .find(|e| e.ordinal == entry.ordinal && e.part == row.part)
                            {
                                Some(edit) if edit.drop => {}
                                Some(edit) => rendered.push(
                                    serde_json::from_str(edit.bytes.as_ref().unwrap()).unwrap(),
                                ),
                                None => rendered.push(render_part(part, row.tag.as_deref(), true)),
                            }
                        }
                        let mut message = entry.message.clone();
                        message["content"] = match rendered.as_slice() {
                            [Value::String(text)] => json!(text),
                            _ => json!(rendered),
                        };
                        output.push(message);
                    }
                }
                _ => panic!("unknown range kind"),
            }
        }
        output.extend(
            entries
                .iter()
                .filter(|e| e.ordinal > view.covers_through.ordinal)
                .map(|e| e.message.clone()),
        );
        output
    }
}

#[tokio::test]
async fn anthropic_messages_session_publishes_part_edits_beside_signed_thinking() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "thalamus-harness",
        "claude-code",
        json!({"serializer_profile":"anthropic-messages"}),
    )
    .await;
    let transcript = anthropic_transcript(39);
    *rig.runner.entries.lock().unwrap() = transcript.clone();
    rig.notice(1, 1_000, None).await;
    assert_eq!(rig.newest(), None, "defer must not publish");
    let state = rig.state();
    assert_eq!(
        tag_rows(&state, codec::Codec::AnthropicMessages)
            .unwrap()
            .len(),
        39,
        "every tagged text and tool result part must be indexed"
    );
    rig.history(20, "first completed historian summary");
    rig.notice(2, 1_000, None).await;
    let baseline = rig.newest().expect("new history publishes");
    // Message 21 is an assistant message whose first part is a signed
    // thinking block; drop its text part, and the tool result after it.
    rig.queue(&[anthropic_tag(21, 1), anthropic_tag(22, 0)])
        .await;
    rig.notice(3, 90_000, Some(baseline)).await;
    let version = rig.newest().expect("execute threshold publishes");
    assert!(version > baseline);
    let view = rig.get(version).await;
    assert!(
        matches!(view.ranges[0], view::ViewRange::Replace { from: 0, .. }),
        "the view inserts the history head before every kept message"
    );
    let edits: Vec<_> = view
        .ranges
        .iter()
        .flat_map(|range| match range {
            view::ViewRange::Keep { edits, .. } => edits.clone(),
            _ => Vec::new(),
        })
        .collect();
    let near: Vec<_> = edits
        .iter()
        .filter(|edit| edit.ordinal == 21 || edit.ordinal == 22)
        .map(|edit| (edit.ordinal, edit.part.as_str(), edit.drop))
        .collect();
    assert_eq!(
        near,
        [(21, "1", false), (22, "0", false)],
        "the dropped parts get their placeholders; the signed thinking part beside them is kept"
    );
    // The head insertion invalidates every later signature, but removing those
    // blocks is the runner's companion edit (or it defers the view): the view
    // itself never edits a thinking part.
    for edit in &edits {
        let content = &transcript[edit.ordinal as usize].message["content"];
        let part = content.get(edit.part.parse::<usize>().unwrap());
        assert!(
            part.is_none_or(|part| part["type"] != "thinking"),
            "the view edited a signed thinking part: {edit:?}"
        );
    }
    let rendered = rig.render_anthropic(&view);
    let applied = rendered
        .iter()
        .find(|message| message["content"][2]["id"] == "toolu_21")
        .expect("message 21 stays in the rendered request");
    assert_eq!(
        bytes(&applied["content"][0]).unwrap(),
        bytes(&transcript[21].message["content"][0]).unwrap(),
        "the signed thinking block and its signature are the runner's own bytes"
    );
    assert_ne!(applied["content"][1], transcript[21].message["content"][1]);
    for message in rendered.iter().filter(|m| m["role"] == "assistant") {
        if let Some(signed) = message["content"]
            .as_array()
            .and_then(|parts| parts.iter().find(|p| p["type"] == "thinking"))
        {
            let source = transcript
                .iter()
                .find(|entry| entry.message["content"][0] == *signed)
                .expect("every rendered thinking block is a runner block");
            assert_eq!(
                bytes(signed).unwrap(),
                bytes(&source.message["content"][0]).unwrap()
            );
        }
    }
    // A view is immutable: the same version is served again unchanged.
    assert_eq!(rig.get(version).await, view);
    // The runner applies the view with the provider's companion strip and says
    // so. That fact is recorded, and it is not a reason for a new view: the
    // next notice with no new work publishes nothing, so the runner and ck-mc
    // never chase each other's bytes.
    rig.notice_with(
        4,
        90_000,
        Some(version),
        None,
        vec![notice::Event::ViewCompanion {
            view_version: version,
            edit: notice::companion_edits::STRIP_SIGNED_REASONING.into(),
        }],
    )
    .await;
    assert_eq!(
        rig.state().acknowledgements,
        [format!("view_companion:{version}:strip_signed_reasoning")]
    );
    assert_eq!(
        rig.newest(),
        Some(version),
        "a companion apply needs no new view"
    );
    rig.notice(5, 90_000, Some(version)).await;
    assert_eq!(rig.newest(), Some(version));
}

/// THALAMUS's Claude Code gateway (module `thalamus`) is a session runner: a
/// Setup attested by it is accepted, and the conversation's transcript reads,
/// sends and background children all route to that module. The fake runner
/// asserts the routed module on every call it receives.
#[tokio::test]
async fn a_thalamus_attested_setup_routes_reads_sends_and_children_to_thalamus() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "thalamus",
        "claude-code",
        json!({"serializer_profile":"anthropic-messages"}),
    )
    .await;
    *rig.runner.entries.lock().unwrap() = anthropic_transcript(12);
    rig.notice(1, 1_000, None).await;
    assert!(
        rig.runner
            .routed_reads
            .load(std::sync::atomic::Ordering::Relaxed)
            >= 1,
        "transcript reads go through the session runner route"
    );
    let state = rig.state();
    assert_eq!(state.runner_module, "thalamus");
    let route = state.runner().unwrap();
    assert_eq!(route.module_id(), "thalamus");
    assert_eq!(
        state.runner_route.as_ref().unwrap()["module_id"],
        "thalamus"
    );
    assert_eq!(
        state.dream_target.as_ref().unwrap()["route"]["module_id"],
        "thalamus"
    );
    // A send (a reminder) takes the same routed interface as the reads.
    let sent = rig
        .h
        .provider_runner
        .call_for(
            &route,
            dir.path(),
            "session.send",
            json!({}),
            Duration::from_secs(1),
        )
        .await
        .unwrap();
    assert_eq!(sent["state"], "pending");
    // Historian and dreamer children of a Claude Code conversation run on the
    // conversation's own runner.
    let principal = subc_protocol::Principal::Reserved {
        module_id: "thalamus".into(),
    };
    let config = McModuleConfig::default();
    for resolved in [
        config.historian_runner_for("claude-code"),
        config.dreamer_runner_for("claude-code"),
    ] {
        let child = crate::route_targets::SessionRunnerRoute::for_background_call(
            Some(&principal),
            "s",
            resolved,
        )
        .expect("a thalamus conversation's children use its session runner");
        assert_eq!(child.module_id(), "thalamus");
        assert_eq!(child.parent_session(), "s");
    }
}
