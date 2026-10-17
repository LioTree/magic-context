use super::*;
use crate::historian_runner::HistorianRunnerKind;
use std::collections::BTreeSet;

const VECTOR: &str = include_str!(
    "../../../../../packages/plugin/src/hooks/magic-context/host-runner/conformance/vectors/dream-ownership-v1.json"
);

fn vector() -> Value {
    serde_json::from_str(VECTOR).unwrap()
}

/// Every task that has a Rust host, wired as if production executors existed.
pub(crate) fn every_hosted_task() -> Wiring {
    Wiring {
        tasks: CANONICAL_TASKS
            .into_iter()
            .filter(|task| task_roles(*task).is_some())
            .collect(),
        broca: false,
    }
}

/// A claimant that registers every dream agent with its full tool set and
/// declares every guard, including the filesystem fence no OpenCode host has.
pub(crate) fn claimant_carrying_every_role(now_ms: i64) -> ClaimantDeclaration {
    let roles = [
        DreamRole::Classifier,
        DreamRole::MemoryMapper,
        DreamRole::Curate,
        DreamRole::Docs,
        DreamRole::Reviewer,
        DreamRole::PrimerInvestigator,
        DreamRole::Retrospective,
    ];
    let mut tools = BTreeSet::new();
    let mut agents = Map::new();
    for role in roles {
        tools.extend(role.tools().iter().copied());
        agents.insert(role.agent().into(), json!(role.tools()));
    }
    ClaimantDeclaration::parse(
        &json!({
            "capabilities": {
                "tools": tools.into_iter().collect::<Vec<_>>(),
                "child_guard": true, "steps": true, "tokens": true, "stop": true,
                "retire": true, "task_tools": true, "filesystem_fence": true,
                "default_model": true,
            },
            "agents": agents,
        }),
        now_ms,
    )
    .unwrap()
}

fn host_config() -> McModuleConfig {
    McModuleConfig {
        rust_background_enabled: true,
        ..Default::default()
    }
}

fn names(tasks: &[TaskName]) -> Vec<&'static str> {
    tasks.iter().map(|t| t.as_str()).collect()
}

#[test]
fn shared_vector_publishes_only_what_each_opencode_claimant_can_carry() {
    let vector = vector();
    let wiring = every_hosted_task();
    let config = host_config();
    for harness in ["opencode", "opencode2"] {
        let claimant = ClaimantDeclaration::parse(&vector["claimants"][harness], 1).unwrap();
        for settings in ["with_models", "without_models"] {
            let ownership = publish(&OwnershipInput {
                config: &config,
                settings: Some(&vector["settings"][settings]),
                harness,
                wiring: &wiring,
                claimant: Some(&claimant),
            });
            let expected: Vec<&str> = vector["expected"][harness][settings]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap())
                .collect();
            assert_eq!(
                names(&ownership.published),
                expected,
                "{harness} {settings}"
            );
            if settings == "with_models" {
                for (task, reason) in &ownership.withheld {
                    assert_eq!(
                        vector["withheld_with_models"][harness][task.as_str()],
                        json!(reason),
                        "{harness} {}",
                        task.as_str()
                    );
                }
            }
        }
    }
}

#[test]
fn verify_and_map_stay_with_typescript_without_a_filesystem_fence() {
    let vector = vector();
    let wiring = every_hosted_task();
    let config = host_config();
    for harness in ["opencode", "opencode2"] {
        let claimant = ClaimantDeclaration::parse(&vector["claimants"][harness], 1).unwrap();
        // Even a host that registered the mapper agent with its read tools is
        // refused while it declares no filesystem fence.
        let mut with_mapper = claimant.clone();
        with_mapper.agents.insert(
            DreamRole::MemoryMapper.agent().into(),
            DreamRole::MemoryMapper
                .tools()
                .iter()
                .map(|t| t.to_string())
                .collect(),
        );
        with_mapper.capabilities["tools"] = json!(DreamRole::MemoryMapper.tools());
        let ownership = publish(&OwnershipInput {
            config: &config,
            settings: Some(&vector["settings"]["with_models"]),
            harness,
            wiring: &wiring,
            claimant: Some(&with_mapper),
        });
        for task in [TaskName::Map, TaskName::Verify, TaskName::VerifyBroad] {
            assert!(!ownership.owns(task), "{harness} {}", task.as_str());
            assert!(ownership
                .withheld
                .contains(&(task, "claimant_capability:filesystem_fence".into())));
        }
    }
}

#[test]
fn production_wiring_publishes_nothing_even_for_a_fully_capable_claimant() {
    let claimant = claimant_carrying_every_role(1);
    let settings = vector()["settings"]["with_models"].clone();
    for harness in ["opencode", "opencode2"] {
        let ownership = publish(&OwnershipInput {
            config: &host_config(),
            settings: Some(&settings),
            harness,
            wiring: &Wiring::production(),
            claimant: Some(&claimant),
        });
        assert!(ownership.activated);
        assert_eq!(ownership.published, Vec::<TaskName>::new(), "{harness}");
    }
}

#[test]
fn switch_off_publishes_nothing() {
    let claimant = claimant_carrying_every_role(1);
    let settings = vector()["settings"]["with_models"].clone();
    let ownership = publish(&OwnershipInput {
        config: &McModuleConfig::default(),
        settings: Some(&settings),
        harness: "opencode",
        wiring: &every_hosted_task(),
        claimant: Some(&claimant),
    });
    assert!(!ownership.activated);
    assert!(ownership.published.is_empty());
    assert!(ownership.withheld.iter().all(|(_, r)| r == "inactive"));
}

#[test]
fn host_runner_without_a_declared_claimant_publishes_nothing() {
    let settings = vector()["settings"]["with_models"].clone();
    let ownership = publish(&OwnershipInput {
        config: &host_config(),
        settings: Some(&settings),
        harness: "opencode",
        wiring: &every_hosted_task(),
        claimant: None,
    });
    assert!(ownership.published.is_empty());
    assert!(ownership
        .withheld
        .contains(&(TaskName::Curate, "no_claimant".into())));
}

#[test]
fn unresolvable_trusted_config_publishes_nothing() {
    let claimant = claimant_carrying_every_role(1);
    let ownership = publish(&OwnershipInput {
        config: &host_config(),
        settings: None,
        harness: "opencode",
        wiring: &every_hosted_task(),
        claimant: Some(&claimant),
    });
    assert!(ownership.published.is_empty());
}

#[test]
fn broca_is_chosen_only_when_the_user_configured_it() {
    let settings = json!({"dreamer": {"claude-code": {"model": "anthropic/claude-sonnet-4-5"}}});
    let no_models = json!({"dreamer": {}});
    let mut wiring = every_hosted_task();
    // A harness whose default is Broca: the default alone never publishes.
    let defaulted = publish(&OwnershipInput {
        config: &host_config(),
        settings: Some(&settings),
        harness: "claude-code",
        wiring: &Wiring {
            broca: true,
            ..wiring.clone()
        },
        claimant: None,
    });
    assert!(defaulted.published.is_empty());
    assert!(defaulted
        .withheld
        .contains(&(TaskName::Curate, "broca_not_configured".into())));

    let configured = McModuleConfig {
        dreamer_runner: Some(HistorianRunnerKind::Broca),
        ..host_config()
    };
    let unwired = publish(&OwnershipInput {
        config: &configured,
        settings: Some(&settings),
        harness: "claude-code",
        wiring: &wiring,
        claimant: None,
    });
    assert!(unwired.published.is_empty());
    assert!(unwired
        .withheld
        .contains(&(TaskName::Curate, "broca_unwired".into())));

    wiring.broca = true;
    let wired = publish(&OwnershipInput {
        config: &configured,
        settings: Some(&settings),
        harness: "claude-code",
        wiring: &wiring,
        claimant: None,
    });
    assert_eq!(wired.published, wiring.tasks);
    let modelless = publish(&OwnershipInput {
        config: &configured,
        settings: Some(&no_models),
        harness: "claude-code",
        wiring: &wiring,
        claimant: None,
    });
    assert!(modelless.published.is_empty());
    assert!(modelless
        .withheld
        .contains(&(TaskName::Curate, "broca_model_required".into())));
}

#[test]
fn claim_refusal_follows_the_claim_route_rules() {
    let full = json!({"tools": ["ctx_memory", "read"], "child_guard": true, "steps": true,
        "tokens": true, "stop": true, "retire": true, "task_tools": true,
        "filesystem_fence": true, "default_model": true});
    assert_eq!(claim_refusal(&full, &["ctx_memory", "read"], true), None);
    let mut no_fence = full.clone();
    no_fence["filesystem_fence"] = json!(false);
    assert_eq!(claim_refusal(&no_fence, &["ctx_memory"], false), None);
    assert_eq!(
        claim_refusal(&no_fence, &["read"], false).as_deref(),
        Some("filesystem_fence")
    );
    let mut no_default = full.clone();
    no_default["default_model"] = json!(false);
    assert_eq!(claim_refusal(&no_default, &[], false), None);
    assert_eq!(
        claim_refusal(&no_default, &[], true).as_deref(),
        Some("default_model")
    );
    let mut no_retire = full.clone();
    no_retire["retire"] = json!(false);
    assert_eq!(
        claim_refusal(&no_retire, &[], false).as_deref(),
        Some("retire")
    );
    assert_eq!(
        claim_refusal(&full, &["grep"], false).as_deref(),
        Some("tool:grep")
    );
}

#[test]
fn declarations_expire_and_are_scoped_to_their_session() {
    let registry = ClaimantRegistry::default();
    registry.declare("p", "s", claimant_carrying_every_role(1_000));
    assert!(registry.current("p", "s", 1_000).is_some());
    assert!(registry.current("p", "other", 1_000).is_none());
    assert!(registry.current("other", "s", 1_000).is_none());
    assert!(registry
        .current("p", "s", 1_000 + DECLARATION_TTL_MS - 1)
        .is_some());
    assert!(registry
        .current("p", "s", 1_000 + DECLARATION_TTL_MS)
        .is_none());
    registry.withdraw("p", "s");
    assert!(registry.current("p", "s", 1_000).is_none());
}

#[test]
fn malformed_declarations_are_refused_whole() {
    let good = vector()["claimants"]["opencode"].clone();
    assert!(ClaimantDeclaration::parse(&good, 1).is_ok());
    for (pointer, value) in [
        ("/capabilities", json!(null)),
        ("/capabilities/tools", json!("ctx_memory")),
        ("/capabilities/steps", json!("true")),
        ("/agents", json!([])),
        ("/agents/dreamer", json!("ctx_memory")),
        ("/agents/dreamer", json!([""])),
        (
            "/capabilities/tools",
            json!(vec!["t"; MAX_DECLARED_NAMES + 1]),
        ),
        ("/agents/dreamer", json!(["x".repeat(MAX_NAME_BYTES + 1)])),
    ] {
        let mut bad = good.clone();
        *bad.pointer_mut(pointer).unwrap() = value;
        assert!(ClaimantDeclaration::parse(&bad, 1).is_err(), "{pointer}");
    }
}

/// The roles in `task_roles` are the roles each host actually opens children
/// for. Read from the hosts' (and their task modules') non-test source.
#[test]
fn task_roles_match_the_roles_each_host_opens() {
    let production = |source: &'static str| source.split("#[cfg(test)]").next().unwrap();
    let hosts: [(&str, &str, &[TaskName]); 5] = [
        (
            "dream_tasks/classify.rs",
            production(include_str!("../../dream_tasks/classify.rs")),
            &[TaskName::Classify, TaskName::Map],
        ),
        (
            "dream_dispatch/verify_host.rs",
            production(include_str!("../verify_host.rs")),
            &[TaskName::Verify, TaskName::VerifyBroad],
        ),
        (
            "dream_tasks/curate.rs",
            production(include_str!("../../dream_tasks/curate.rs")),
            &[TaskName::Curate],
        ),
        (
            "dream_dispatch/retrospective_host.rs",
            production(include_str!("../retrospective_host.rs")),
            &[TaskName::Retrospective, TaskName::ReviewUserMemories],
        ),
        (
            "dream_dispatch/primer_host.rs",
            production(include_str!("../primer_host.rs")),
            &[TaskName::PromotePrimers, TaskName::RefreshPrimers],
        ),
    ];
    let all = [
        DreamRole::Classifier,
        DreamRole::MemoryMapper,
        DreamRole::Curate,
        DreamRole::Docs,
        DreamRole::Reviewer,
        DreamRole::PrimerInvestigator,
        DreamRole::Retrospective,
    ];
    for (file, source, tasks) in hosts {
        let opened: BTreeSet<String> = all
            .iter()
            .filter(|role| source.contains(&format!("DreamRole::{role:?}")))
            .map(|role| format!("{role:?}"))
            .collect();
        let declared: BTreeSet<String> = tasks
            .iter()
            .flat_map(|task| task_roles(*task).unwrap().iter())
            .map(|role| format!("{role:?}"))
            .collect();
        assert_eq!(opened, declared, "{file}");
    }
}
