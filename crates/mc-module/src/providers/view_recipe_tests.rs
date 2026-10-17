//! Claude Code and Broca views persisted as exact recipes: what the store keeps
//! and what the lanes serve from it.
use super::*;
use crate::providers::claude_code_tests as cc;

async fn page_through(h: &McHandler, read: &Value) -> String {
    let mut read = read.clone();
    let mut joined = String::new();
    loop {
        let outcome = cc::call(h, "compaction.view.read", read.clone()).await;
        let HandlerOutcome::Response(bytes) = outcome else {
            panic!("view read failed: {outcome:?}")
        };
        let page: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(page["answer"], "page", "{page}");
        joined.push_str(page["bytes"].as_str().unwrap());
        match page.get("next_byte_cursor").and_then(Value::as_u64) {
            Some(cursor) => read["byte_cursor"] = json!(cursor),
            None => return joined,
        }
    }
}

fn response(outcome: HandlerOutcome) -> Value {
    let HandlerOutcome::Response(bytes) = outcome else {
        panic!("{outcome:?}")
    };
    serde_json::from_slice(&bytes).unwrap()
}

fn cc_message(mid: &str, ordinal: u64, raw: &str) -> Value {
    json!({"mid":mid,"ordinal":ordinal,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw})
}

/// The native ordinals a stored recipe streams, and every raw text it holds.
fn stored_parts(store: &McStore, key: &Key, version: u64) -> (BTreeSet<u64>, Vec<String>) {
    let resolved = store
        .resolve_provider_view_catalog(&key.store_key(), version)
        .unwrap()
        .unwrap();
    let mut native = BTreeSet::new();
    for segment in &resolved.recipe.segments {
        if let ProviderViewSegment::NativeRange { from, to, .. } = segment {
            native.extend(*from..*to);
        }
    }
    let mut held = Vec::new();
    for slot in resolved.recipe.synthetic.values() {
        if let Some(raw) = slot.get("raw").and_then(Value::as_str) {
            held.push(raw.to_string());
        }
    }
    for treatment in &resolved.recipe.treatments {
        if let Some(splice) = treatment.patch.as_ref().and_then(|patch| patch.get("raw")) {
            held.push(splice["insert"].as_str().unwrap().to_string());
        }
    }
    (native, held)
}

/// The retained tail is streamed from the stored native rows, not copied: its
/// exact raw text (spacing, key order, escapes, non-ASCII), the frozen full
/// and cut payloads, their SHA-256 and lengths, and their paged reads all match
/// what the lane served, before and after a restart.
#[tokio::test]
async fn v2_claude_recipe_preserves_full_cut_and_tail_raw_bytes() {
    // The engine replays signed and redacted thinking only unchanged with its
    // whole prefix, and refuses any fold that would cut it. Check the stored
    // form directly: the source decodes to its exact raw text, and a view that
    // keeps it unchanged streams it from the native row with no copied bytes.
    let signed = r#"{"role":"assistant",  "content":[{"signature":"sig\/1","thinking":"caf\u00e9 \"quoted\"","type":"thinking"},{"type":"redacted_thinking","data":"b3BhcXVl=="},{"type":"text","text":"雪 answer\n"}]}"#;
    let envelope = crate::providers::codec_claude_code::from_wire(
        &serde_json::from_str(signed).unwrap(),
        Some(signed),
    )
    .unwrap();
    let source = source_item(RecipeLane::ClaudeCodeAnthropic, "s", 1, envelope).unwrap();
    assert_eq!(source.raw.as_deref(), Some(signed));
    let range = transform::compaction::Range {
        lineage_id: "L".into(),
        from: 0,
        to: 2,
    };
    let kept = build_exact(ExactView {
        lane: RecipeLane::ClaudeCodeAnthropic,
        version: 1,
        range: &range,
        metadata: json!({}),
        items: vec![source.clone()],
        natives: vec![Some(Native {
            lineage: "L".into(),
            mid: "s".into(),
            ordinal: 1,
            source: source.clone(),
        })],
        policy_cut_id: None,
        state: "produced",
    });
    assert!(kept.synthetic.is_empty() && kept.treatments.is_empty());
    assert!(matches!(
        kept.segments.as_slice(),
        [ProviderViewSegment::NativeRange { from: 1, to: 2, .. }]
    ));

    let dir = tempfile::tempdir().unwrap();
    let h = cc::handler(dir.path(), cc::thalamus());
    cc::setup(&h).await;
    let messages = [
        (
            "m",
            r#"{ "content" : "covered \u00e9 history", "role":"user" }"#,
        ),
        (
            "call",
            r#"{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"read","input":{"z":1,"path":"a\tb","a":[true,null]}}]}"#,
        ),
        (
            "result",
            r#"{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":[{"type":"text","text":"tool \ud83e\udd80 output"}]}]}"#,
        ),
        (
            "img",
            r#"{"content":[{"type":"text","text":"look"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}],"role":"user"}"#,
        ),
        ("tail", "{\"role\":\"user\",\n  \"content\":\"live tail\"}"),
    ];
    let mut status = cc::step(messages[0].1);
    status["messages"] = json!(messages
        .iter()
        .enumerate()
        .map(|(ordinal, (mid, raw))| cc_message(mid, ordinal as u64, raw))
        .collect::<Vec<_>>());
    status["newest"] = json!({"mid":"tail","ordinal":4});
    status["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
    let first = response(cc::call(&h, "compaction.step", status.clone()).await);
    assert_eq!(first["answer"], "compaction_message", "{first}");
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    let store = h.store.get().unwrap().clone();
    let first_version = first["compaction"]["version"].as_u64().unwrap();
    let (native, held) = stored_parts(&store, &key, first_version);
    assert_eq!(native, (0..5).collect());
    // Only the synthetic head's genuinely new messages are stored as raw text.
    for (_, raw) in &messages {
        assert!(
            held.iter().all(|text| !text.contains(raw)),
            "native raw text was copied: {raw}"
        );
    }

    // Fold the first user message and the tool exchange that ends at the
    // covered boundary into a summary head.
    store
        .replace_compartments(
            &key.engine_key(),
            &[mc_store::StoredCompartment {
                sequence: 1,
                start_message: 0,
                end_message: 2,
                end_message_id: "result#0".into(),
                title: "history".into(),
                content: "folded history".into(),
                p1: Some("folded history".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
    status["request_id"] = json!("cold");
    status["prefix_rebuilding"] = json!({"reason":"expired_cache"});
    status["last_applied"] =
        json!({"compaction_id":first["compaction"]["compaction_id"],"version":first_version});
    let HandlerOutcome::Response(bytes) = cc::call(&h, "compaction.step", status).await else {
        panic!("fold failed")
    };
    let served = String::from_utf8(bytes).unwrap();
    let answer: Value = serde_json::from_str(&served).unwrap();
    assert_eq!(answer["answer"], "compaction_message", "{answer}");
    let version = answer["compaction"]["version"].as_u64().unwrap();
    let frozen: compact::view::FrozenView =
        serde_json::from_value(answer["compaction"]["raw_view"].clone()).unwrap();
    let compact::view::RawPayload::Inline { bytes: inline } = &frozen.payload else {
        panic!("inline payload")
    };
    let tail: Vec<&str> = messages[3..].iter().map(|(_, raw)| *raw).collect();
    assert!(
        inline.ends_with(&format!("{}]", tail.join(","))),
        "{inline}"
    );

    // Storage: the tail is a native range with no copied raw bytes.
    let (native, held) = stored_parts(&store, &key, version);
    assert_eq!(native, (3..5).collect());
    for raw in &tail {
        assert!(
            held.iter().all(|text| !text.contains(raw)),
            "tail raw text was copied into the recipe: {raw}"
        );
    }

    // The resolver reproduces the served view: raw text, full and cut payloads.
    let host = load(&store, &key, version).unwrap().unwrap();
    let raws = host.raw_replacement.clone().unwrap();
    assert_eq!(&raws[raws.len() - tail.len()..], tail.as_slice());
    let stored_frozen = host.wire.raw_view.as_deref().unwrap();
    assert_eq!(stored_frozen, &frozen);
    assert_eq!(
        serde_json::to_value(&host.wire).unwrap(),
        answer["compaction"]
    );
    let cut = host.cut_replacement.as_ref().unwrap();
    assert_eq!(
        cut.bytes,
        format!("[{}]", raws[..raws.len() - tail.len()].join(","))
    );
    assert_eq!(Some(&cut.reference), frozen.cut_replacement_ref.as_ref());
    crate::providers::native_view::validate(&key, &host).unwrap();

    // Paged reads of both identities concatenate to the frozen bytes.
    let full_read = json!({"request_id":"full","view_id":frozen.view.view_id,"version":version,"sha256":frozen.view.sha256,"byte_cursor":0});
    let cut_ref = frozen.cut_replacement_ref.clone().unwrap();
    let cut_read = json!({"request_id":"cut","view_id":cut_ref.view_id,"version":version,"sha256":cut_ref.sha256,"byte_cursor":0});
    let full = page_through(&h, &full_read).await;
    assert_eq!(&full, inline);
    assert_eq!(full.len() as u64, frozen.view.byte_length);
    assert_eq!(crate::sha256_hex(full.as_bytes()), frozen.view.sha256);
    let head = page_through(&h, &cut_read).await;
    assert_eq!(head, cut.bytes);
    assert_eq!(head.len() as u64, cut_ref.byte_length);
    assert_eq!(crate::sha256_hex(head.as_bytes()), cut_ref.sha256);

    // A cold process serves the same bytes from the same rows.
    drop(store);
    drop(h);
    let h = cc::handler(dir.path(), cc::thalamus());
    cc::setup(&h).await;
    assert_eq!(page_through(&h, &full_read).await, full);
    assert_eq!(page_through(&h, &cut_read).await, head);
}

#[test]
fn exact_patch_keeps_unchanged_bytes_and_falls_back_to_a_whole_slot() {
    let source = Item {
        engine: json!({"role":"user","text":"source"}),
        wire: Some(json!({"role":"user"})),
        raw: Some(r#"{ "role":"user", "content":"caf\u00e9 雪" }"#.into()),
    };
    let mut target = source.clone();
    target.raw = Some(r#"{ "role":"user", "content":"§1§ caf\u00e9 雪" }"#.into());
    target.engine["text"] = json!("§1§ source");
    let patch = exact_patch(&source, &target).unwrap().unwrap();
    assert_eq!(patch["raw"]["insert"], "§1§ ");
    assert_eq!(apply_exact(source.clone(), &patch).unwrap(), target);
    // A runner item has no wire form; pairing it with a host source cannot
    // be expressed as a patch, so the message is stored whole.
    let runner = Item {
        wire: None,
        raw: None,
        ..target.clone()
    };
    assert!(exact_patch(&source, &runner).is_err());
    let range = transform::compaction::Range {
        lineage_id: "L".into(),
        from: 0,
        to: 1,
    };
    let recipe = build_exact(ExactView {
        lane: RecipeLane::OwnedBrocaRunner,
        version: 3,
        range: &range,
        metadata: json!({}),
        items: vec![runner.clone()],
        natives: vec![Some(Native {
            lineage: "L".into(),
            mid: "m".into(),
            ordinal: 0,
            source,
        })],
        policy_cut_id: None,
        state: "produced",
    });
    assert_eq!(
        recipe.segments,
        vec![ProviderViewSegment::Synthetic {
            slot: "synthetic-0".into()
        }]
    );
    assert_eq!(
        Item::from_slot(&recipe.synthetic["synthetic-0"]).unwrap(),
        runner
    );
}

fn runner_handler(dir: &Path, resident: bool) -> McHandler {
    let descriptor = StorageDescriptor {
        module_id: DEFAULT_MODULE_ID.into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.join("store.db").to_string_lossy().into(),
        },
    };
    let handler = McHandler::new().with_startup_provider_resident_enabled(resident);
    handler
        .store
        .set(Arc::new(McStore::open_for_test(&descriptor).unwrap()))
        .ok()
        .unwrap();
    handler.bind_route(
        8,
        SessionBinding {
            connection_incarnation: 0,
            native_generation: None,
            principal: None,
            project_root: dir.to_path_buf(),
            harness: session_resolver::RUNNER_BIND_HARNESS.into(),
            session: "s".into(),
            model_key: None,
            config: McModuleConfig {
                inject_docs: false,
                protected_tokens_user: Some(0),
                protected_tools: BTreeMap::new(),
                ..Default::default()
            },
            history_budget_tokens: 4_000.0,
        },
    );
    handler
}

async fn runner_call(h: &McHandler, method: &str, params: Value) -> Value {
    let HandlerOutcome::Response(bytes) = h
        .dispatch_value(8, json!({"method":method,"params":params}))
        .await
    else {
        panic!("{method} failed")
    };
    serde_json::from_slice(&bytes).unwrap()
}

/// Runner records name their views by version. Reading the record back, from
/// the resident session or a cold process, resolves each reference to the view
/// the runner was served, and the native messages that view kept unchanged are
/// read from their stored rows rather than copied into the recipe.
#[tokio::test]
async fn runner_record_view_references_resolve_to_the_served_views() {
    for resident in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let h = runner_handler(dir.path(), resident);
        runner_call(&h, "compaction.setup", json!({"session":"s","harness":"broca","request_id":"setup","preset":"head","params":{},"composition":{},"model":"fixture","context_window":100_000,"now":1,"lineage_id":"L"})).await;
        let messages: Vec<Value> = (1..=6)
            .map(|ordinal| json!({"ordinal":ordinal,"mid":format!("m{ordinal}"),"message":{"role":if ordinal % 2 == 1 {"user"} else {"assistant"},"content":[{"type":"text","text":format!("native {ordinal}: café 🦀")}]}}))
            .collect();
        let mut step = json!({"session":"s","harness":"broca","request_id":"step","lineage_id":"L","step_id":"st","step_kind":"user_turn","model":"fixture",
            "context_window":100_000,"estimate":{"request_tokens":1_000},"messages":messages,"now":2,"newest":{"ordinal":6,"mid":"m6"},
            "prefix_rebuilding":{"reason":"pipeline_switch"}});
        let answer = runner_call(&h, "compaction.step", step.clone()).await;
        assert_eq!(answer["answer"], "compaction_message", "{answer}");
        let version = answer["compaction"]["version"].as_u64().unwrap();
        step["request_id"] = json!("ack");
        step["messages"] = json!([]);
        step.as_object_mut().unwrap().remove("prefix_rebuilding");
        step["last_applied"] =
            json!({"compaction_id":answer["compaction"]["compaction_id"],"version":version});
        runner_call(&h, "compaction.step", step).await;
        let key = Key::new(&h.facade_binding(8).unwrap(), "s", "broca").unwrap();
        let store = h.store.get().unwrap().clone();
        let raw: Value = serde_json::from_str(
            &store
                .load_provider_record(&key.store_key())
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert!(
            raw.pointer("/setup/state/last_applied/replacement")
                .is_none(),
            "the store keeps a reference, not a whole view: {raw}"
        );
        let resolved = store
            .resolve_provider_view_catalog(&key.store_key(), version)
            .unwrap()
            .unwrap();
        assert!(resolved
            .recipe
            .segments
            .iter()
            .any(|segment| matches!(segment, ProviderViewSegment::NativeRange { .. })));
        assert!(!resolved
            .recipe
            .synthetic
            .values()
            .any(|slot| slot.to_string().contains("native 6")));
        drop(store);
        drop(h);
        let cold = runner_handler(dir.path(), resident);
        let record = cold.provider_store.load(&key).unwrap();
        let state = &record.setup.as_ref().unwrap().state;
        let held = [&state.last_produced, &state.last_applied, &record.wait_view]
            .into_iter()
            .flatten()
            .find(|view| view.version == version)
            .expect("the served view is still named by the record");
        assert_eq!(
            serde_json::to_value(crate::providers::codec::encode_view(held).unwrap()).unwrap(),
            answer["compaction"],
            "resident={resident}"
        );
    }
}
