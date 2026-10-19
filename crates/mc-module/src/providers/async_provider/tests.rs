use super::*;
use cortexkit_bus_inmemory::{InMemoryBus, InMemoryConfig};

#[derive(Default)]
struct Runner {
    entries: Mutex<Vec<ReadMessage>>,
    lineage: Mutex<String>,
}

#[async_trait]
impl session_resolver::ProviderRunner for Runner {
    async fn call(
        &self,
        _: &Path,
        _: &str,
        method: &str,
        params: Value,
        _: Duration,
    ) -> Result<Value, SessionResolveError> {
        assert_eq!(method, "session.read");
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
                connection_incarnation: 1,
                native_generation: None,
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
            bus,
            task,
            reference,
        };
        let answer=rig.op("compaction.setup",json!({"session":"s","harness":"opencode","request_id":"setup","model":"fixture","context_window":100_000,"composition":{"render_tags":true},"params":{"serializer_profile":"opencode-aisdk"},"lineage_id":"L","now":1})).await;
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
    fn fill(&self, count: u64) {
        *self.runner.entries.lock().unwrap()=(0..count).map(|n| {
            let part=if n%5>0 && n%5<4 {
                json!({"id":format!("p{n}"),"type":"tool","tool":"read","callID":format!("call{n}"),"state":{"status":"completed","input":{"path":format!("file{n}")},"output":"exact spent output ".repeat(500)}})
            } else {json!({"id":format!("p{n}"),"type":"text","text":format!("message {n} ")+&"durable words ".repeat(16)})};
            ReadMessage::new(n,format!("m{n}"),json!({"info":{"id":format!("m{n}"),"role":if n%5==0{"user"}else{"assistant"},"time":{"created":1}},"parts":[part]})).with_tags(vec![tags::PartTag::tagged(format!("p{n}"),format!("§{}§",100+n*3))])
        }).collect();
    }
    async fn notice(&self, seq: u64, size: u64, applied: Option<u64>) {
        let last = self.runner.entries.lock().unwrap().last().cloned().unwrap();
        let mut notice = notice::AdvanceNotice::new(
            &self.reference,
            seq,
            last.ordinal,
            contract::content_digest(&last.message),
            size,
            "fixture",
        )
        .with_window(100_000);
        if let Some(version) = applied {
            notice = notice.with_applied_view_version(version);
        }
        let receipt = self
            .bus
            .publish(
                &notice::event_subject("fixture", "thalamus-harness", notice::ADVANCED_EVENT),
                &bus_id(&self.reference, "advanced", seq),
                notice.digest().parse().unwrap(),
                notice.to_headers(),
            )
            .await
            .unwrap();
        assert!(!receipt.duplicate());
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if self.state().completed_seq >= seq && !self.state().entries.is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("notice ingested");
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
    let binding = rig.h.facade_binding(7).unwrap();
    assert!(rig.h.async_reduce(&binding, &[163, 166, 169]).await.is_ok());
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
    let binding = rig.h.facade_binding(7).unwrap();
    assert!(rig.h.async_reduce(&binding, &[163, 166, 169]).await.is_ok());
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
        compact::status::MessageRef {
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
    let digest = contract::content_digest(&state.entries[&9].message);
    assert_eq!(verified_descent(&state, &format!("L:9:{digest}")), Some(9));
    assert_eq!(
        verified_descent(&state, &format!("L:9:{}", "0".repeat(64))),
        None,
        "unverified descent must be a full resync"
    );
    assert_eq!(verified_descent(&state, &format!("other:9:{digest}")), None);
}
