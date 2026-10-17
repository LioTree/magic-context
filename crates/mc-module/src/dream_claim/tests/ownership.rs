//! `dream.ownership` and `dreamer.run_task` against the published list, on a real
//! handler and store. Publication is fed by the fixture's wiring, never by a
//! request field.

use super::*;
use crate::dream_dispatch::ownership::{tests::every_hosted_task, Wiring};

const VECTOR: &str = include_str!(
    "../../../../../packages/plugin/src/hooks/magic-context/host-runner/conformance/vectors/dream-ownership-v1.json"
);

struct Route {
    _root: tempfile::TempDir,
    handler: McHandler,
}

fn route(harness: &str, activated: bool, wiring: Option<Wiring>) -> Route {
    let base = std::env::temp_dir().join("magic-context/i5-stage-d");
    std::fs::create_dir_all(&base).unwrap();
    let root = tempfile::tempdir_in(base).unwrap();
    let directory = root.path().canonicalize().unwrap();
    let store =
        Arc::new(McStore::open(&crate::dev_descriptor_at(root.path().to_str().unwrap())).unwrap());
    let context_path = root.path().join("context.db");
    rusqlite::Connection::open(&context_path)
        .unwrap()
        .execute_batch(
            &include_str!("../../../../mc-store/testdata/context_schema/schema.sql")
                .replace(":applied_at", "1"),
        )
        .unwrap();
    store.install_context_domain(Arc::new(
        mc_store::SqliteContextDomain::open(&context_path).unwrap(),
    ));
    let mut handler = McHandler::new();
    assert!(handler.store.set(store).is_ok());
    handler.fixed_config = Some(McModuleConfig {
        rust_background_enabled: activated,
        ..Default::default()
    });
    let vector: Value = serde_json::from_str(VECTOR).unwrap();
    handler.fixed_dream_settings = Some(vector["settings"]["with_models"].clone());
    handler.dream_wiring = wiring;
    for (channel, session) in [(7, "parent"), (8, "other")] {
        handler.bind_route(
            channel,
            SessionBinding {
                connection_incarnation: 1,
                native_generation: None,
                principal: None,
                scope: None,
                project_root: directory.clone(),
                harness: harness.into(),
                session: session.into(),
                model_key: None,
                config: McModuleConfig::default(),
                history_budget_tokens: 1000.0,
            },
        );
    }
    Route {
        _root: root,
        handler,
    }
}

async fn call(handler: &McHandler, channel: u16, request: Value) -> Value {
    match Box::pin(handler.dispatch_value(channel, request)).await {
        HandlerOutcome::Response(bytes) => serde_json::from_slice(&bytes).unwrap(),
        HandlerOutcome::Error { code, .. } => json!({"error": code}),
        other => panic!("unexpected outcome {other:?}"),
    }
}

fn claimant(harness: &str) -> Value {
    let vector: Value = serde_json::from_str(VECTOR).unwrap();
    vector["claimants"][harness].clone()
}

fn published(body: &Value) -> Vec<String> {
    body["published"]
        .as_array()
        .unwrap_or_else(|| panic!("no published list in {body}"))
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn ownership_route_publishes_for_the_declaring_session_only() {
    for harness in ["opencode", "opencode2"] {
        let r = route(harness, true, Some(every_hosted_task()));
        let vector: Value = serde_json::from_str(VECTOR).unwrap();
        let answer = call(
            &r.handler,
            7,
            json!({"v": 1, "method": "dream.ownership", "claimant": claimant(harness)}),
        )
        .await;
        assert_eq!(answer["activated"], true, "{harness}");
        assert_eq!(
            json!(published(&answer)),
            vector["expected"][harness]["with_models"],
            "{harness}"
        );
        // Another session of the same project has declared nothing.
        let other = call(&r.handler, 8, json!({"v": 1, "method": "dream.ownership"})).await;
        assert_eq!(published(&other), Vec::<String>::new(), "{harness}");
        // Withdrawing the declaration withdraws the publication.
        let withdrawn = call(&r.handler, 7, json!({"v": 1, "method": "dream.ownership"})).await;
        assert_eq!(published(&withdrawn), Vec::<String>::new(), "{harness}");
    }
}

#[tokio::test]
async fn ownership_route_publishes_nothing_in_this_build_or_with_the_switch_off() {
    let production = route("opencode2", true, None);
    let answer = call(
        &production.handler,
        7,
        json!({"v": 1, "method": "dream.ownership", "claimant": claimant("opencode2")}),
    )
    .await;
    assert_eq!(answer["activated"], true);
    assert_eq!(published(&answer), Vec::<String>::new());
    let off = route("opencode2", false, Some(every_hosted_task()));
    let answer = call(
        &off.handler,
        7,
        json!({"v": 1, "method": "dream.ownership", "claimant": claimant("opencode2")}),
    )
    .await;
    assert_eq!(answer["activated"], false);
    assert_eq!(published(&answer), Vec::<String>::new());
}

#[tokio::test]
async fn ownership_route_refuses_malformed_claimants_and_foreign_lanes() {
    let r = route("opencode2", true, Some(every_hosted_task()));
    let answer = call(
        &r.handler,
        7,
        json!({"v": 1, "method": "dream.ownership", "claimant": {"capabilities": true}}),
    )
    .await;
    assert_eq!(answer["error"], "invalid_params");
    let answer = call(&r.handler, 7, json!({"v": 2, "method": "dream.ownership"})).await;
    assert_eq!(answer["error"], "bad_request");
    let foreign = route("claude-code", true, Some(every_hosted_task()));
    let answer = call(
        &foreign.handler,
        7,
        json!({"v": 1, "method": "dream.ownership", "claimant": claimant("opencode2")}),
    )
    .await;
    assert_eq!(answer["error"], "host_lane_requires_plugin");
}

/// With the switch on, a plugin route keeps running every unpublished task
/// exactly as with it off; only a published task is refused as Rust's.
#[tokio::test]
async fn run_task_on_a_plugin_route_refuses_only_published_tasks() {
    for activated in [false, true] {
        let r = route("opencode2", activated, Some(every_hosted_task()));
        // The classify route's own name is not a canonical task, so publication
        // never claims it; TypeScript skips classify-memories before calling it.
        let legacy = call(
            &r.handler,
            7,
            json!({"v": 1, "method": "dreamer.run_task", "session_id": "parent",
                "task": "classify", "command_id": "c1",
                "payload": {"prompt_body": "p", "items": []}}),
        )
        .await;
        assert_eq!(legacy["error"], "model_chain_missing", "{activated}");
        let curate = json!({"v": 1, "method": "dreamer.run_task", "session_id": "parent",
            "task": "curate"});
        assert_eq!(
            call(&r.handler, 7, curate.clone()).await["error"],
            "invalid_params",
            "{activated}"
        );
        call(
            &r.handler,
            7,
            json!({"v": 1, "method": "dream.ownership", "claimant": claimant("opencode2")}),
        )
        .await;
        assert_eq!(
            call(&r.handler, 7, curate).await["error"],
            if activated {
                "rust_scheduler_owns_task"
            } else {
                "invalid_params"
            },
            "{activated}"
        );
    }
}
