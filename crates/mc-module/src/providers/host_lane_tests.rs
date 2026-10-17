use super::*;
use subc_protocol::{scope::ScopeStamp, Principal};

pub(super) fn scope() -> ScopeStamp {
    ScopeStamp {
        owner: Principal::Reserved {
            module_id: "prefrontal-core".into(),
        },
        scope_ref: "host-session".into(),
        scope_epoch: 1,
        kind: subc_protocol::scope::ScopeKind::Head,
        parent: None,
        parent_state: None,
        attributes: Default::default(),
        owner_authorized: true,
    }
}

fn harness_principal() -> Principal {
    Principal::Reserved {
        module_id: "thalamus-harness".into(),
    }
}

async fn bind(
    h: &McHandler,
    root: &Path,
    harness: &str,
    principal: Option<Principal>,
    scope: Option<ScopeStamp>,
) {
    let mut req = RouteBindRequest::new(
        RouteHandle::detached(7, 1),
        crate::route_targets::catalog_provider_target_for_test(),
        subc_protocol::BindIdentity::new(root, harness, "s"),
    );
    req.principal = principal;
    req.scope = scope;
    h.on_bind(&req).await;
}

const METHODS: [&str; 4] = [
    "transform.declare",
    "transform.hook",
    "compaction.setup",
    "compaction.step",
];

async fn refusal(h: &McHandler, method: &str) -> String {
    // Request fields cannot supply the daemon-stamped principal or scope, even if they claim both.
    let outcome = h.dispatch_value(7, json!({"method":method,"params":{
        "session":"s", "harness":"opencode", "principal":"reserved:thalamus-harness",
        "scope":scope(), "params":{"serializer_profile":"opencode-aisdk","observation":"answer"}
    }})).await;
    match outcome {
        HandlerOutcome::Error { code, .. } | HandlerOutcome::ErrorWithDetail { code, .. } => code,
        other => panic!("expected refusal: {other:?}"),
    }
}

#[tokio::test]
async fn host_lane_requires_attested_harness_even_with_authorized_scope() {
    let dir = tempfile::tempdir().unwrap();
    let h = McHandler::new();
    for harness in ["opencode", "opencode2", "pi"] {
        for principal in [
            None,
            Some(Principal::Direct),
            Some(Principal::Reserved {
                module_id: "broca".into(),
            }),
            Some(Principal::Reserved {
                module_id: "thalamus".into(),
            }),
        ] {
            bind(&h, dir.path(), harness, principal, Some(scope())).await;
            for method in METHODS {
                assert_eq!(
                    refusal(&h, method).await,
                    "host_lane_requires_harness_module",
                    "{harness} {method}"
                );
            }
        }
    }
}

#[tokio::test]
async fn host_lane_requires_authorized_prefrontal_scope_even_with_harness_principal() {
    let dir = tempfile::tempdir().unwrap();
    let h = McHandler::new();
    let mut wrong_owner = scope();
    wrong_owner.owner = harness_principal();
    let mut direct_owner = scope();
    direct_owner.owner = Principal::Direct;
    let mut unauthorized = scope();
    unauthorized.owner_authorized = false;
    for harness in ["opencode", "opencode2", "pi"] {
        for scope in [
            None,
            Some(wrong_owner.clone()),
            Some(direct_owner.clone()),
            Some(unauthorized.clone()),
        ] {
            bind(&h, dir.path(), harness, Some(harness_principal()), scope).await;
            for method in METHODS {
                assert_eq!(
                    refusal(&h, method).await,
                    "host_lane_scope_missing",
                    "{harness} {method}"
                );
            }
        }
    }
}

#[tokio::test]
async fn host_lane_admits_both_daemon_attestations_and_retains_the_bind_stamp() {
    let dir = tempfile::tempdir().unwrap();
    for harness in ["opencode", "opencode2", "pi"] {
        let h = super::claude_code_tests::handler(dir.path(), None);
        bind(
            &h,
            dir.path(),
            harness,
            Some(harness_principal()),
            Some(scope()),
        )
        .await;
        let binding = h.facade_binding(7).unwrap();
        assert_eq!(binding.scope, Some(scope()));
        assert_eq!(binding.principal, Some(harness_principal()));
        assert!(admit_host_lane(&binding).is_ok());
        for method in ["transform.declare", "compaction.setup"] {
            let outcome = h.dispatch_value(7, json!({"method":method,"params":{
                "session":"s","harness":harness,"request_id":"setup","preset":"head",
                "params":{"serializer_profile":if harness == "pi" { "pi" } else { "opencode-aisdk" },"observation":"answer"},
                "composition":{},"model":"fixture","context_window":100000,"lineage_id":"L","now":1
            }})).await;
            assert!(
                matches!(outcome, HandlerOutcome::Response(_)),
                "{harness} {method}: {outcome:?}"
            );
        }
    }
}

#[tokio::test]
async fn host_lane_check_leaves_broca_and_claude_code_admission_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let mut binding = super::claude_code_tests::binding(dir.path(), None);
    for harness in [session_resolver::RUNNER_BIND_HARNESS, "claude-code"] {
        binding.harness = harness.into();
        for principal in [
            None,
            Some(Principal::Direct),
            Some(Principal::Reserved {
                module_id: "broca".into(),
            }),
            super::claude_code_tests::thalamus(),
        ] {
            binding.principal = principal;
            assert!(admit_host_lane(&binding).is_ok());
        }
    }
    let h = super::claude_code_tests::handler(dir.path(), super::claude_code_tests::thalamus());
    assert_eq!(super::claude_code_tests::setup(&h).await["answer"], "ready");
    bind(
        &h,
        dir.path(),
        session_resolver::RUNNER_BIND_HARNESS,
        Some(Principal::Reserved {
            module_id: "broca".into(),
        }),
        None,
    )
    .await;
    let outcome = h
        .dispatch_value(
            7,
            json!({"method":"compaction.setup","params":{
                "session":"s","harness":"broca","request_id":"setup","preset":"head","params":{},
                "composition":{},"model":"fixture","context_window":100000,"lineage_id":"L","now":1
            }}),
        )
        .await;
    assert!(
        matches!(outcome, HandlerOutcome::Response(_)),
        "{outcome:?}"
    );
}

#[tokio::test]
async fn pi_provider_tool_facade_requires_attestation_even_when_the_plan_exists() {
    let dir = tempfile::tempdir().unwrap();
    let h = super::claude_code_tests::handler(dir.path(), None);
    bind(
        &h,
        dir.path(),
        "pi",
        Some(harness_principal()),
        Some(scope()),
    )
    .await;
    let declaration = h.dispatch_value(7, json!({"method":"transform.declare","params":{"session":"s","harness":"pi","preset":"head","params":{"serializer_profile":"pi","observation":"answer"}}})).await;
    assert!(matches!(declaration, HandlerOutcome::Response(_)));
    let response = h
        .dispatch_value(7, json!({"name":"ctx_reduce","arguments":{"drop":"1"}}))
        .await;
    assert!(
        matches!(response, HandlerOutcome::Response(_)),
        "{response:?}"
    );
    bind(&h, dir.path(), "pi", Some(Principal::Direct), Some(scope())).await;
    let response = h
        .dispatch_value(7, json!({"name":"ctx_reduce","arguments":{"drop":"1"}}))
        .await;
    assert!(
        !matches!(response, HandlerOutcome::Response(_)),
        "unattested Pi caller reused the host plan: {response:?}"
    );
}
