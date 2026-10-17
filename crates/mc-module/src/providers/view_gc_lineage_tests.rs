//! A view version named in a step answer stays readable, and kept by pruning,
//! until that same lineage steps again, even when a fork of it steps (and
//! prunes) in between. The conversation's single step receipt only names the
//! last stepping lineage's view, and the conversation's current lineage is
//! whichever lineage stepped last.
use super::claude_code_tests::{call, handler, setup, step, thalamus};
use super::*;

fn response(outcome: HandlerOutcome) -> Value {
    let HandlerOutcome::Response(bytes) = outcome else {
        panic!("{outcome:?}")
    };
    serde_json::from_slice(&bytes).unwrap()
}

fn key(h: &McHandler) -> Key {
    Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap()
}

/// Lineage `L`'s two messages: `m` (ordinal 0) and `tail` (ordinal 1).
fn l_status(request_id: &str) -> Value {
    let mut status = step(r#"{ "content":"unsigned live text", "role":"user" }"#);
    status["request_id"] = json!(request_id);
    status["messages"].as_array_mut().unwrap().push(json!({"mid":"tail","ordinal":1,"message":{"role":"user","content":"live tail"},"raw_message":r#"{"role":"user","content":"live tail"}"#}));
    status["newest"] = json!({"mid":"tail","ordinal":1});
    status
}

/// Bootstrap lineage `L`, seed one compartment and fold, so the answer names a
/// stored Claude Code view on `L`.
async fn fold_on_l(h: &McHandler) -> Value {
    let mut bootstrap = l_status("step");
    bootstrap["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
    let first = response(call(h, "compaction.step", bootstrap.clone()).await);
    h.store
        .get()
        .unwrap()
        .replace_compartments(
            &key(h).engine_key(),
            &[mc_store::StoredCompartment {
                sequence: 1,
                start_message: 0,
                end_message: 0,
                end_message_id: "m#0".into(),
                title: "history".into(),
                content: "idle fold".into(),
                p1: Some("idle fold".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
    let mut status = bootstrap;
    status["request_id"] = json!("cold");
    status["prefix_rebuilding"] = json!({"reason":"expired_cache"});
    if first["answer"] == "compaction_message" {
        status["last_applied"] = json!({"compaction_id":first["compaction"]["compaction_id"],"version":first["compaction"]["version"]});
    }
    let answer = response(call(h, "compaction.step", status).await);
    assert_eq!(answer["answer"], "compaction_message", "{answer}");
    answer
}

/// The full-view read and the hook-cut head read of a step answer's view.
fn reads(answer: &Value) -> [Value; 2] {
    let frozen: compact::view::FrozenView =
        serde_json::from_value(answer["compaction"]["raw_view"].clone()).unwrap();
    let cut = frozen.cut_replacement_ref.as_ref().expect("hook cut head");
    [
        json!({"request_id":"full","view_id":frozen.view.view_id,"version":frozen.view.version,"sha256":frozen.view.sha256,"byte_cursor":0}),
        json!({"request_id":"cut","view_id":cut.view_id,"version":cut.version,"sha256":cut.sha256,"byte_cursor":0}),
    ]
}

async fn read_pages(h: &McHandler, reads: &[Value; 2]) -> Vec<Value> {
    let mut pages = Vec::new();
    for read in reads {
        pages.push(response(call(h, "compaction.view.read", read.clone()).await));
    }
    pages
}

/// One step on lineage `F`, a fork of `L` after ordinal `through`.
fn fork_at(request_id: &str, through: u64) -> Value {
    let raw = r#"{"role":"user","content":"fork turn"}"#;
    json!({"session":"cc","harness":"claude-code","request_id":request_id,"lineage_id":"F","step_id":"f","step_kind":"user_turn",
        "descends_from":{"lineage_id":"L","through_ordinal":through},
        "model":"fixture","context_window":100000,"estimate":{"request_tokens":1},"newest":{"mid":"f2","ordinal":through+1},"after_ordinal":through,
        "messages":[{"mid":"f2","ordinal":through+1,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw}],"now":3})
}

fn held_versions(h: &McHandler) -> Vec<u64> {
    h.store
        .get()
        .unwrap()
        .load_provider_view_recipe_versions(&key(h).store_key())
        .unwrap()
}

fn assert_pages(pages: &[Value], expected: &[Value]) {
    for (page, expected) in pages.iter().zip(expected) {
        assert_eq!(page["answer"], "page", "{page}");
        assert_eq!(page["bytes"], expected["bytes"]);
    }
}

/// A fork stepping after its parent leaves the parent's just-answered view
/// readable, full view and hook-cut head alike, even though the fork is now
/// the conversation's current lineage.
#[tokio::test]
async fn cc_fork_step_keeps_the_parent_answered_view_readable() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    setup(&h).await;
    let answer = fold_on_l(&h).await;
    let reads = reads(&answer);
    let before = read_pages(&h, &reads).await;
    assert_pages(&before, &before);
    let fork = response(call(&h, "compaction.step", fork_at("fork", 1)).await);
    assert_eq!(fork["answer"], "noop", "{fork}");
    assert_pages(&read_pages(&h, &reads).await, &before);
}

/// A fork that folds and prunes after its parent keeps the parent's
/// just-answered view stored and readable, and so does a cold restart.
#[tokio::test]
async fn cc_fork_fold_and_prune_keep_the_parent_answered_view_across_restart() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    setup(&h).await;
    let answer = fold_on_l(&h).await;
    let version = answer["compaction"]["version"].as_u64().unwrap();
    let l_reads = reads(&answer);
    let before = read_pages(&h, &l_reads).await;
    // A fork before the end of L's view drops L's produced view from the
    // Setup state, so only L's own answered-view entry still names it.
    let mut fork = fork_at("fork", 0);
    fork["prefix_rebuilding"] = json!({"reason":"expired_cache"});
    let fork = response(call(&h, "compaction.step", fork).await);
    assert_eq!(fork["answer"], "compaction_message", "{fork}");
    let fork_version = fork["compaction"]["version"].as_u64().unwrap();
    assert_ne!(fork_version, version);
    let f_reads = reads(&fork);
    let f_before = read_pages(&h, &f_reads).await;
    assert_pages(&f_before, &f_before);
    assert!(held_versions(&h).contains(&version), "{:?}", held_versions(&h));
    assert_pages(&read_pages(&h, &l_reads).await, &before);
    drop(h);
    let h = handler(dir.path(), thalamus());
    setup(&h).await;
    assert!(held_versions(&h).contains(&version), "{:?}", held_versions(&h));
    assert_pages(&read_pages(&h, &l_reads).await, &before);
    assert_pages(&read_pages(&h, &f_reads).await, &f_before);
}

/// Once L steps again, L's earlier answer no longer counts as L's answered
/// view: a fork's step then leaves it unreadable even while it is still stored
/// for other reasons, and L's entry names only its newest answer.
#[tokio::test]
async fn cc_superseded_answer_is_refused_after_the_lineage_steps_again() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    setup(&h).await;
    let answer = fold_on_l(&h).await;
    let version = answer["compaction"]["version"].as_u64().unwrap();
    let l_reads = reads(&answer);
    let again = response(call(&h, "compaction.step", l_status("again")).await);
    let store = h.store.get().unwrap();
    let answered = store
        .provider_lineage_answered_views(&key(&h).store_key())
        .unwrap();
    assert_eq!(
        answered.get("L").copied(),
        again["compaction"]["version"].as_u64()
    );
    assert_ne!(answered.get("L"), Some(&version));
    let fork = response(call(&h, "compaction.step", fork_at("fork", 1)).await);
    assert_eq!(fork["answer"], "noop", "{fork}");
    // Still stored (the Setup state's produced view), so the refusal below
    // comes from the read's branch check, not from pruning.
    assert!(held_versions(&h).contains(&version), "{:?}", held_versions(&h));
    for page in read_pages(&h, &l_reads).await {
        assert_eq!(page["code"], "unknown_version", "{page}");
    }
}

/// A lineage that is no longer held releases its answered view: the read
/// refuses it once the fork is the current lineage. No runtime path retires a
/// single lineage today, and the views table's foreign key would force the
/// view out first, so the test removes only the lineage row (with foreign keys
/// unenforced) to show that the answered entry alone does not keep a view
/// readable.
#[tokio::test]
async fn cc_retired_lineage_answered_view_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let h = handler(dir.path(), thalamus());
    setup(&h).await;
    let answer = fold_on_l(&h).await;
    let version = answer["compaction"]["version"].as_u64().unwrap();
    let l_reads = reads(&answer);
    let before = read_pages(&h, &l_reads).await;
    response(call(&h, "compaction.step", fork_at("fork", 1)).await);
    assert_pages(&read_pages(&h, &l_reads).await, &before);
    let store = h.store.get().unwrap();
    let conv = key(&h).store_key().conversation_key();
    // Leave the view and its messages in place: this connection does not
    // enforce foreign keys.
    let sql = rusqlite::Connection::open(dir.path().join("cc.db")).unwrap();
    sql.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
    sql.execute(
        "DELETE FROM mc_provider_lineages_v1 WHERE conv_key=?1 AND lineage_id='L'",
        [&conv],
    )
    .unwrap();
    assert!(held_versions(&h).contains(&version));
    assert!(store
        .provider_lineage_answered_views(&key(&h).store_key())
        .unwrap()
        .is_empty());
    for page in read_pages(&h, &l_reads).await {
        assert_eq!(page["code"], "unknown_version", "{page}");
    }
}
