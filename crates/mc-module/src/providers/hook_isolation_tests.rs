use super::*;

#[tokio::test(flavor = "current_thread")]
async fn transport_hook_completes_while_other_session_fold_is_blocked() {
    use std::sync::atomic::AtomicBool;

    let directory = tempfile::tempdir().unwrap();
    let (handler, mut fold_binding, store, _) = handler(directory.path(), Arc::new(NoReads::default()));
    let handler = Arc::new(handler.with_startup_provider_resident_enabled(true));
    let session = "isolation-fold";
    fold_binding.session = session.into();
    let mut start = setup();
    start["session"] = json!(session);
    answer(handler.provider_setup(fold_binding.clone(), &start).await);
    let mut initial = step("initial", (1..=30).map(message).collect(), 30);
    initial["session"] = json!(session);
    let initial = answer(handler.provider_step(fold_binding.clone(), &initial).await);
    store.replace_compartments(session, &compartments()).unwrap();
    store.arm_soft_refresh(session).unwrap();
    let mut request = step("prime", vec![], 30);
    request["session"] = json!(session);
    request["last_applied"] = json!({"compaction_id":initial["compaction"]["compaction_id"],"version":initial["compaction"]["version"]});
    let view = answer(handler.provider_step(fold_binding.clone(), &request).await);
    let fold_session = fold_binding.session.clone();
    fold_binding.principal = Some(subc_protocol::Principal::Reserved {
        module_id: "thalamus-harness".into(),
    });
    fold_binding.scope = Some(crate::providers::host_lane_tests::scope());
    let mut hook_binding = fold_binding.clone();
    hook_binding.session = "hook-sibling".into();
    let hook_key = Key::new(&hook_binding, &hook_binding.session, "opencode").unwrap();
    let mut start = setup();
    start["session"] = json!(hook_binding.session);
    answer(handler.provider_setup(hook_binding.clone(), &start).await);
    let hook = json!({"method":"transform.hook","params":{
        "session":hook_binding.session,"harness":"opencode","params":setup()["params"],
        "lineage_id":"L","subject_mid":"m1","subject_ordinal":1,
        "message":message(1)["message"],"hook":"pre_user","blocks":["raw 1"],"step_id":"step"}});
    let transport = Arc::new(crate::provider_transport_tests::Transport::start(true).await);
    transport.register("fold", handler.clone(), fold_binding);
    transport.register("hook", handler.clone(), hook_binding);
    let warm = transport.call("hook", hook.clone()).await;
    assert!(warm.get("error").is_none(), "{warm}");
    let resident_before = handler.provider_resident.session_stats(store.tag_cache_namespace(), &hook_key);
    let mut rows = store.load_compartments(session).unwrap();
    rows[0].p1 = Some("blocked fold visible delta".into());
    store.replace_compartments(session, &rows).unwrap();
    store.arm_soft_refresh(session).unwrap();
    let mut request = step("blocked-fold", vec![], 30);
    request["session"] = json!(session);
    request["last_applied"] = json!({"compaction_id":view["compaction"]["compaction_id"],"version":view["compaction"]["version"]});
    let (entered, reached) = tokio::sync::oneshot::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let entered = Mutex::new(Some(entered));
    let wait = Mutex::new(wait);
    let released = Arc::new(AtomicBool::new(false));
    let observed = released.clone();
    crate::transform::install_transform_attempt_hook(session, move || {
        entered.lock().unwrap().take().unwrap().send(()).unwrap();
        // A finite OS-thread wait also releases an inline-dispatch mutant, whose
        // blocked runtime could not run an async timeout or clean up the worker.
        let _ = wait.lock().unwrap().recv_timeout(Duration::from_secs(3));
        observed.store(true, Ordering::SeqCst);
    });
    let folding = transport.clone();
    let fold = tokio::spawn(async move {
        folding.call("fold", json!({"method":"compaction.step","params":request})).await
    });
    tokio::time::timeout(Duration::from_secs(10), reached).await.unwrap().unwrap();
    let mut own_hook = hook.clone();
    own_hook["params"]["session"] = json!(fold_session);
    own_hook["params"]["subject_mid"] = json!("m30");
    own_hook["params"]["subject_ordinal"] = json!(30);
    own_hook["params"]["message"] = message(30)["message"].clone();
    own_hook["params"]["blocks"] = json!(["raw 30"]);
    own_hook["params"]["served_through_ordinal"] = json!(30);
    let mut own_hook = Box::pin(transport.call("fold", own_hook));
    let own_early = tokio::time::timeout(Duration::from_millis(20), &mut own_hook).await.ok();
    let own_session_waits = own_early.is_none();
    let spare_slots = crate::transport_admission::hold_free_long_slots();
    let result = tokio::time::timeout(Duration::from_secs(1), transport.call("hook", hook)).await;
    let completed_while_blocked = result.as_ref().is_ok_and(|r| r.get("error").is_none())
        && !released.load(Ordering::SeqCst);
    drop(spare_slots);
    let _ = release.send(());
    let folded = fold.await.unwrap();
    let own_hook = match own_early { Some(result) => result, None => own_hook.await };
    assert!(folded.get("error").is_none(), "{folded}");
    assert!(completed_while_blocked, "hook A must finish before blocked fold B is released");
    assert!(own_session_waits, "a hook must not overtake its own in-flight fold");
    assert!(own_hook.get("error").is_none(), "{own_hook}");
    let result = result.unwrap();
    assert!(result.get("error").is_none(), "{result}");
    assert_eq!(handler.provider_resident.session_stats(store.tag_cache_namespace(), &hook_key), resident_before);
}
