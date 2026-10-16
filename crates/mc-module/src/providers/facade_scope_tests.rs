use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

const SESSION: &str = "provider_session";

#[derive(Default)]
struct RefusingResolver(AtomicUsize);

#[async_trait::async_trait]
impl crate::session_resolver::SessionResolver for RefusingResolver {
    async fn resolve_session(
        &self,
        project_root: &Path,
        harness: &str,
        instance_token: &str,
    ) -> Result<
        Option<crate::session_resolver::ResolvedSession>,
        crate::session_resolver::SessionResolveError,
    > {
        assert!(project_root.is_absolute());
        assert_eq!(harness, "claude-code");
        assert_eq!(instance_token, SESSION);
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(None)
    }
}

fn step_lane(
    root: &Path,
    principal: Option<subc_protocol::Principal>,
) -> (McHandler, Arc<RefusingResolver>) {
    let mut h = handler(root, principal.clone());
    let mut pins = h.native_pins();
    pins.canonical_reduce = true;
    pins.guidance = true;
    *h.native_bundle_override.lock().unwrap() = Some(pins);
    let mut route = binding(root, principal);
    route.session = SESSION.into();
    h.bind_route(7, route);
    let resolver = Arc::new(RefusingResolver::default());
    h.session_resolver = resolver.clone();
    (h, resolver)
}

async fn admit(h: &McHandler) -> Value {
    response(
        call(
            h,
            "transform.declare",
            json!({
                "session":SESSION,"harness":"claude-code","params":plan(),"preset":"head"
            }),
        )
        .await,
    );
    let ready = response(
        call(
            h,
            "compaction.setup",
            json!({
                "session":SESSION,"harness":"claude-code","request_id":"setup","params":plan(),
                "preset":"head","model":"fixture","context_window":100000,"composition":{},
                "lineage_id":"L","now":1
            }),
        )
        .await,
    );
    let route = h.facade_binding(7).unwrap();
    assert_eq!(route.harness, "claude-code");
    assert_eq!(route.session, SESSION);
    assert_eq!(route.principal, thalamus());
    assert!(route.native_generation.is_some());
    assert!(h.host_provider_conversation(&route).is_some());
    ready
}

async fn facade(h: &McHandler, name: &str, args: Value) -> HandlerOutcome {
    h.dispatch_value(7, json!({"name":name,"arguments":args}))
        .await
}

async fn lane_status(h: &McHandler) -> Value {
    response(
        h.dispatch_value(
            7,
            json!({
                "method":"session.status","v":1,"session_id":SESSION
            }),
        )
        .await,
    )
}

#[tokio::test]
async fn cc_step_lane_reduce_queues_and_next_rewrite_drops_block() {
    let dir = tempfile::tempdir().unwrap();
    let (h, resolver) = step_lane(dir.path(), thalamus());
    {
        let mut routes = h.bindings.lock().unwrap();
        let config = &mut routes.get_mut(&7).unwrap().config;
        config.protected_tokens_user = Some(1);
        config.protected_tools.clear();
        config.protected_tools.insert("ctx_reduce".into(), 0);
    }
    let ready = admit(&h).await;
    assert_eq!(ready["answer"], "ready");
    // Give the first tool result enough content to reclaim, and keep three later results so
    // it is outside the automatic protection for the most recent tool outputs.
    let obsolete = "obsolete output for step-lane reduction ".repeat(1000);
    let raw = [
        r#"{"role":"user","content":"Read the old note."}"#,
        r#"{"role":"assistant","content":[{"type":"text","text":"Reading."},{"type":"tool_use","id":"read-1","name":"Read","input":{"file_path":"old.txt"}}]}"#,
        r#"{"role":"user","content":[{"type":"tool_result","tool_use_id":"read-1","content":"obsolete output for step-lane reduction"}]}"#,
        r#"{"role":"assistant","content":"The old note is read."}"#,
        r#"{"role":"user","content":"Continue with another source."}"#,
        r#"{"role":"assistant","content":[{"type":"tool_use","id":"read-2","name":"Read","input":{"file_path":"second.txt"}}]}"#,
        r#"{"role":"user","content":[{"type":"tool_result","tool_use_id":"read-2","content":"additional output two"}]}"#,
        r#"{"role":"assistant","content":"A third detail."}"#,
        r#"{"role":"user","content":"One more source."}"#,
        r#"{"role":"assistant","content":[{"type":"tool_use","id":"read-3","name":"Read","input":{"file_path":"third.txt"}}]}"#,
        r#"{"role":"user","content":[{"type":"tool_result","tool_use_id":"read-3","content":"additional output three"}]}"#,
        r#"{"role":"assistant","content":"A fourth detail."}"#,
        r#"{"role":"user","content":"The final source."}"#,
        r#"{"role":"assistant","content":[{"type":"tool_use","id":"read-4","name":"Read","input":{"file_path":"fourth.txt"}}]}"#,
        r#"{"role":"user","content":[{"type":"tool_result","tool_use_id":"read-4","content":"additional output four"}]}"#,
        r#"{"role":"assistant","content":"The final detail."}"#,
        r#"{"role":"user","content":"Summarize the remaining details."}"#,
    ].map(|raw| raw.replace("obsolete output for step-lane reduction", &obsolete));
    for (i, (kind, text)) in [
        ("pre_user", "Read the old note."),
        ("post_assistant", "Reading."),
        ("post_tool", obsolete.as_str()),
    ]
    .into_iter()
    .enumerate()
    {
        let mut hook = json!({
            "session":SESSION,"harness":"claude-code","lineage_id":"L","step_id":"hook",
            "params":plan(),"subject_mid":format!("m{i}"),"subject_ordinal":i,
            "message":serde_json::from_str::<Value>(&raw[i]).unwrap(),"raw_message":raw[i],
            "hook":kind,"blocks":[text]
        });
        if kind == "post_tool" {
            hook["subject_part"] = json!("read-1");
            hook["tool_call_id"] = json!("read-1");
            hook["tool"] = json!("Read");
            hook["is_error"] = json!(false);
        }
        let answer = response(call(&h, "transform.hook", hook).await);
        assert_admission_answer(&answer, true, &[(0, i as u64 + 1)]);
    }
    let mut status = step(&raw[0]);
    status["session"] = json!(SESSION);
    status["messages"] = json!(raw.iter().enumerate().map(|(i, raw)| {
        json!({"mid":format!("m{i}"),"ordinal":i,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw})
    }).collect::<Vec<_>>());
    status["newest"] = json!({"mid":"m16","ordinal":16});
    status["served_through_ordinal"] = json!(16);
    let first = response(call(&h, "compaction.step", status.clone()).await);
    assert_eq!(first["answer"], "compaction_message");
    status["last_applied"] = json!({"compaction_id":first["compaction"]["compaction_id"],"version":first["compaction"]["version"]});
    let key = Key::new(&h.facade_binding(7).unwrap(), SESSION, "claude-code").unwrap();
    let store = h.store.get().unwrap();
    let reduced = response(facade(&h, "ctx_reduce", json!({"drop":"3"})).await);
    assert_eq!(reduced["isError"], false, "{reduced}");
    assert_eq!(
        store.load_provider_pending_drops(&key.store_key()).unwrap(),
        vec![3]
    );
    assert!(store.load_pending_agent_drops(SESSION).unwrap().is_empty());
    let queued_status = lane_status(&h).await;
    assert_eq!(
        queued_status["step_lane"]["queued_drops"]["tag_ids"],
        json!([3])
    );
    assert_eq!(queued_status["step_lane"]["queued_drops"]["total_count"], 1);

    status["request_id"] = json!("rewrite-after-reduce");
    status["estimate"]["request_tokens"] = json!(95000);
    status["prefix_rebuilding"] = json!({"reason":"expired_cache"});
    let rewritten = response(call(&h, "compaction.step", status).await);
    assert_eq!(rewritten["answer"], "compaction_message", "{rewritten}");
    let frozen: compact::view::FrozenView =
        serde_json::from_value(rewritten["compaction"]["raw_view"].clone()).unwrap();
    let bytes = native_read(&h, &frozen.view).await;
    assert!(bytes.contains("[dropped §3§]"), "{bytes}");
    assert!(
        !bytes.contains("obsolete output for step-lane reduction"),
        "{bytes}"
    );
    assert_eq!(resolver.0.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn cc_step_lane_other_facades_work_or_refuse_by_name() {
    let dir = tempfile::tempdir().unwrap();
    let (h, resolver) = step_lane(dir.path(), thalamus());
    admit(&h).await;
    assert_eq!(
        code(facade(&h, "ctx_expand", json!({"tag":1})).await),
        "ctx_expand_unavailable"
    );
    for args in [
        json!({"query":"lanefacadeproof"}),
        json!({"query":"lanefacadeproof","sources":["message"]}),
    ] {
        assert_eq!(
            code(facade(&h, "ctx_search", args).await),
            "ctx_search_unavailable"
        );
    }
    let disabled = response(facade(&h, "ctx_memory", json!({"action":"read"})).await);
    assert_eq!(disabled["isError"], true);
    assert!(
        disabled.to_string().contains("memory is disabled"),
        "{disabled}"
    );
    h.bindings
        .lock()
        .unwrap()
        .get_mut(&7)
        .unwrap()
        .config
        .memory_enabled = true;
    let saved = response(facade(&h, "ctx_memory", json!({
        "action":"write","category":MEMORY_CATEGORIES[0],"content":"Step lane project memory.",
        "command_id":"save-step-memory"
    })).await);
    assert_eq!(saved["isError"], false, "{saved}");
    assert!(saved.to_string().contains("Saved memory"), "{saved}");
    let note = response(
        facade(
            &h,
            "ctx_note",
            json!({
                "action":"write","content":"Remember lanefacadeproof for project notes.",
                "command_id":"save-step-note"
            }),
        )
        .await,
    );
    assert_eq!(note["isError"], false, "{note}");
    let read = response(facade(&h, "ctx_note", json!({"action":"read"})).await);
    assert_eq!(read["isError"], false, "{read}");
    assert!(
        read.to_string().contains("Remember lanefacadeproof"),
        "{read}"
    );
    let search = response(
        facade(
            &h,
            "ctx_search",
            json!({
                "query":"lanefacadeproof","sources":["memory","note"]
            }),
        )
        .await,
    );
    assert_eq!(search["isError"], false, "{search}");
    assert!(
        search.to_string().contains("Remember lanefacadeproof"),
        "{search}"
    );
    let status = lane_status(&h).await;
    assert!(status["step_lane"].is_object(), "{status}");
    assert_eq!(resolver.0.load(Ordering::SeqCst), 0);
    assert_eq!(
        code(
            facade(
                &h,
                "ctx_note",
                json!({
                    "action":"read","memory_project":"not-the-bound-project"
                })
            )
            .await
        ),
        "facade_project_vocabulary_mismatch"
    );
}

#[tokio::test]
async fn cc_unattested_facade_still_uses_resolver() {
    let dir = tempfile::tempdir().unwrap();
    let (h, resolver) = step_lane(dir.path(), thalamus());
    admit(&h).await;
    // Keep the admitted route's generation and session, but remove its daemon attestation.
    h.bindings.lock().unwrap().get_mut(&7).unwrap().principal = None;
    assert!(h
        .host_provider_conversation(&h.facade_binding(7).unwrap())
        .is_none());
    assert_eq!(
        code(facade(&h, "ctx_reduce", json!({"drop":"1"})).await),
        "session_unresolved"
    );
    assert_eq!(resolver.0.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cc_step_lane_without_admitted_plan_still_refuses() {
    let dir = tempfile::tempdir().unwrap();
    let (h, resolver) = step_lane(dir.path(), thalamus());
    assert!(h
        .host_provider_conversation(&h.facade_binding(7).unwrap())
        .is_none());
    assert_eq!(
        code(facade(&h, "ctx_reduce", json!({"drop":"1"})).await),
        "session_unresolved"
    );
    assert_eq!(resolver.0.load(Ordering::SeqCst), 1);
}
