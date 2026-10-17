//! `dream.ownership` and `dreamer.run_task` against the published list, on a real
//! handler and store. Claimants are declared on an attested harness route (the
//! THALAMUS harness module principal with an authorized prefrontal scope);
//! publication is fed by the fixture's wiring, never by a request field.

use super::*;
use crate::dream_dispatch::ownership::tests::{every_hosted_task, vector_claimant};
use crate::dream_dispatch::ownership::Wiring;
use crate::dream_runner::DreamRole;

const VECTOR: &str = include_str!(
    "../../../../../packages/plugin/src/hooks/magic-context/host-runner/conformance/vectors/dream-ownership-v1.json"
);

/// Channel 7: a plugin route. Channel 9: an attested harness route of the same
/// project, bound with the harness name the vector lists for its claimant.
const PLUGIN: u16 = 7;
const HARNESS: u16 = 9;

struct Route {
    _root: tempfile::TempDir,
    handler: McHandler,
}

fn vector() -> Value {
    serde_json::from_str(VECTOR).unwrap()
}

fn attested(mut binding: SessionBinding, harness: &str) -> SessionBinding {
    binding.harness = harness.into();
    binding.session = "harness-session".into();
    binding.principal = Some(subc_protocol::Principal::Reserved {
        module_id: "thalamus-harness".into(),
    });
    binding.scope = Some(subc_protocol::scope::ScopeStamp {
        owner: subc_protocol::Principal::Reserved {
            module_id: "prefrontal-core".into(),
        },
        scope_ref: "harness-session".into(),
        scope_epoch: 1,
        kind: subc_protocol::scope::ScopeKind::Head,
        parent: None,
        parent_state: None,
        attributes: Default::default(),
        owner_authorized: true,
    });
    binding
}

fn route(plugin_harness: &str, claimant: &str, activated: bool, wiring: Option<Wiring>) -> Route {
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
    handler.fixed_dream_settings = Some(vector()["settings"]["with_models"].clone());
    handler.dream_wiring = wiring;
    let plugin = SessionBinding {
        connection_incarnation: 1,
        native_generation: None,
        principal: None,
        scope: None,
        project_root: directory,
        harness: plugin_harness.into(),
        session: "parent".into(),
        model_key: None,
        config: McModuleConfig::default(),
        history_budget_tokens: 1000.0,
    };
    let harness = vector()["claimants"][claimant]["harness"]
        .as_str()
        .unwrap()
        .to_owned();
    handler.bind_route(HARNESS, attested(plugin.clone(), &harness));
    handler.bind_route(PLUGIN, plugin);
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

async fn declare(handler: &McHandler, claimant: &str) -> Value {
    call(
        handler,
        HARNESS,
        json!({"v": 1, "method": "dream.ownership", "claimant": vector()["claimants"][claimant]}),
    )
    .await
}

async fn read(handler: &McHandler) -> Value {
    call(
        handler,
        PLUGIN,
        json!({"v": 1, "method": "dream.ownership"}),
    )
    .await
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
async fn attested_claimant_publishes_for_its_project_and_plugin_routes_read_it() {
    for claimant in ["fenceless", "fenceless_default_model"] {
        let r = route("opencode", claimant, true, Some(every_hosted_task()));
        let expected = vector()["expected"][claimant]["with_models"].clone();
        let answer = declare(&r.handler, claimant).await;
        assert_eq!(answer["activated"], true, "{claimant}");
        assert_eq!(json!(published(&answer)), expected, "{claimant}");
        // The plugin route of the same project reads the same list without
        // declaring anything itself.
        let plugin = read(&r.handler).await;
        assert_eq!(plugin["claimant_declared"], true, "{claimant}");
        assert_eq!(json!(published(&plugin)), expected, "{claimant}");
        // Reading does not withdraw; the harness withdrawing does.
        assert_eq!(json!(published(&read(&r.handler).await)), expected);
        let withdrawn = call(
            &r.handler,
            HARNESS,
            json!({"v": 1, "method": "dream.ownership", "claimant": null}),
        )
        .await;
        assert_eq!(published(&withdrawn), Vec::<String>::new(), "{claimant}");
        assert_eq!(published(&read(&r.handler).await), Vec::<String>::new());
    }
}

#[tokio::test]
async fn a_plugin_route_cannot_declare_a_claimant_and_keeps_every_task() {
    let r = route("opencode2", "fenceless", true, Some(every_hosted_task()));
    for claimant in [vector()["claimants"]["fenceless"].clone(), Value::Null] {
        let answer = call(
            &r.handler,
            PLUGIN,
            json!({"v": 1, "method": "dream.ownership", "claimant": claimant}),
        )
        .await;
        assert_eq!(answer["error"], "claimant_requires_attested_harness");
    }
    let answer = read(&r.handler).await;
    assert_eq!(answer["claimant_declared"], false);
    assert_eq!(published(&answer), Vec::<String>::new());
}

#[tokio::test]
async fn nothing_is_published_in_this_build_or_with_the_switch_off() {
    let production = route("opencode2", "fenceless", true, None);
    assert_eq!(
        published(&declare(&production.handler, "fenceless").await),
        Vec::<String>::new()
    );
    assert_eq!(
        published(&read(&production.handler).await),
        Vec::<String>::new()
    );
    let off = route("opencode2", "fenceless", false, Some(every_hosted_task()));
    let answer = declare(&off.handler, "fenceless").await;
    assert_eq!(answer["activated"], false);
    assert_eq!(published(&answer), Vec::<String>::new());
    assert_eq!(published(&read(&off.handler).await), Vec::<String>::new());
}

#[tokio::test]
async fn ownership_route_refuses_malformed_claimants_and_foreign_lanes() {
    let r = route("opencode2", "fenceless", true, Some(every_hosted_task()));
    let answer = call(
        &r.handler,
        HARNESS,
        json!({"v": 1, "method": "dream.ownership", "claimant": {"capabilities": true}}),
    )
    .await;
    assert_eq!(answer["error"], "invalid_params");
    let answer = call(
        &r.handler,
        PLUGIN,
        json!({"v": 2, "method": "dream.ownership"}),
    )
    .await;
    assert_eq!(answer["error"], "bad_request");
    let foreign = route("claude-code", "fenceless", true, Some(every_hosted_task()));
    assert_eq!(
        read(&foreign.handler).await["error"],
        "host_lane_requires_plugin"
    );
}

/// With the switch on, a plugin route keeps running every unpublished task
/// exactly as with it off; only a published task is refused with
/// `rust_scheduler_owns_task`.
#[tokio::test]
async fn run_task_on_a_plugin_route_refuses_only_published_tasks() {
    for activated in [false, true] {
        let r = route(
            "opencode2",
            "fenceless",
            activated,
            Some(every_hosted_task()),
        );
        // The classify route's own name is not a canonical task, so publication
        // never claims it; TypeScript skips classify-memories before calling it.
        let legacy = call(
            &r.handler,
            PLUGIN,
            json!({"v": 1, "method": "dreamer.run_task", "session_id": "parent",
                "task": "classify", "command_id": "c1",
                "payload": {"prompt_body": "p", "items": []}}),
        )
        .await;
        assert_eq!(legacy["error"], "model_chain_missing", "{activated}");
        let curate = json!({"v": 1, "method": "dreamer.run_task", "session_id": "parent",
            "task": "curate"});
        assert_eq!(
            call(&r.handler, PLUGIN, curate.clone()).await["error"],
            "invalid_params",
            "{activated}"
        );
        declare(&r.handler, "fenceless").await;
        assert_eq!(
            call(&r.handler, PLUGIN, curate).await["error"],
            if activated {
                "rust_scheduler_owns_task"
            } else {
                "invalid_params"
            },
            "{activated}"
        );
    }
}

/// A scripted dream-claim-v1 peer claims real queued children with the
/// declared capabilities. Whatever the claim route refuses, publication also
/// refuses, so Rust never publishes a task whose children its claimant cannot
/// take. (Publication is stricter: it also requires the agent registration.)
#[tokio::test]
async fn claim_route_never_admits_less_than_publication_promises() {
    let declaration = vector_claimant("fenceless");
    for role in [
        DreamRole::Curate,
        DreamRole::Classifier,
        DreamRole::Reviewer,
        DreamRole::MemoryMapper,
        DreamRole::PrimerInvestigator,
        DreamRole::Retrospective,
    ] {
        let f = super::Fixture::new();
        let mut carrier = f.carrier();
        let mut request = f.request();
        request.agent = role.agent();
        request.allowed_tools = role.tools();
        let published = declaration.refusal(role, false).is_none();
        let open = carrier.open(&request);
        let peer = async {
            let id = super::wait_for(
                async || f.pending().await["entries"][0]["entry_id"].clone(),
                |v| v.is_string(),
            )
            .await;
            let claim = f
                .call(
                    7,
                    json!({"method": "dream.child.claim", "entry_id": id,
                        "claimant_epoch": "epoch-1", "capabilities": declaration.capabilities}),
                )
                .await;
            let admitted = claim["ok"] == true;
            if admitted {
                // Hand the untouched entry back; no child was created.
                let back = f
                    .send(
                        &claim,
                        "dream.child.unavailable",
                        json!({"quiescent": true, "retired": true}),
                    )
                    .await;
                assert_eq!(back["ok"], true, "{back}");
            } else {
                assert_eq!(claim, json!({"ok": false, "refusal": "unavailable"}));
            }
            admitted
        };
        let (opened, admitted) = super::bounded(async { tokio::join!(open, peer) }).await;
        assert!(opened.is_err(), "{role:?}");
        assert!(admitted || !published, "{role:?} published but refused");
        if published {
            assert!(admitted, "{role:?}");
        }
        assert!(f.effects.calls.lock().unwrap().is_empty());
    }
}
