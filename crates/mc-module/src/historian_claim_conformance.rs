//! Frozen claim exchanges execute the production handler against disposable stores.
use super::*;
use std::cell::Cell;

thread_local! {
    static CLOCK: Cell<Option<i64>> = const { Cell::new(None) };
}

pub(super) fn fixture_now_ms() -> Option<i64> {
    CLOCK.with(Cell::get)
}

const START: i64 = 1_700_000_000_000;
const PROJECT: &str = "/historian-claim-v1/project";
const VECTOR_PATH: &str = "../../packages/plugin/src/hooks/magic-context/host-runner/conformance/vectors/historian-claim-v1.json";
const METHODS: [&str; 4] = [
    "historian.pending",
    "historian.claim",
    "historian.heartbeat",
    "historian.complete",
];

fn principal() -> subc_protocol::Principal {
    subc_protocol::Principal::Reserved {
        module_id: "thalamus-harness".into(),
    }
}

fn scope() -> subc_protocol::scope::ScopeStamp {
    subc_protocol::scope::ScopeStamp {
        owner: subc_protocol::Principal::Reserved {
            module_id: "prefrontal-core".into(),
        },
        scope_ref: "historian-session".into(),
        scope_epoch: 1,
        kind: subc_protocol::scope::ScopeKind::Head,
        parent: None,
        parent_state: None,
        attributes: Default::default(),
        owner_authorized: true,
    }
}

struct Fixture {
    handler: McHandler,
    store: Arc<McStore>,
    _dir: tempfile::TempDir,
}

impl Fixture {
    fn new(paused: bool) -> Self {
        let root = std::env::temp_dir().join("magic-context/historian-claim-v1");
        // Store creation goes through the shared permission helper, as the
        // repository's direct-creator guard requires. The shared parent stays
        // non-private like a plain create_dir_all; each fixture's store lives in
        // its own owner-only tempdir below it.
        mc_store::private_permissions::ensure_directory(&root, false).unwrap();
        let dir = tempfile::tempdir_in(root).unwrap();
        let descriptor = StorageDescriptor {
            module_id: DEFAULT_MODULE_ID.into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        };
        let store = Arc::new(McStore::open_for_test(&descriptor).unwrap());
        let handler = McHandler::new();
        handler.store.set(store.clone()).ok().unwrap();
        handler.bind_route(
            7,
            SessionBinding {
                connection_incarnation: 0,
                native_generation: None,
                principal: Some(principal()),
                scope: Some(scope()),
                project_root: PROJECT.into(),
                harness: "opencode".into(),
                session: "session-a".into(),
                model_key: None,
                history_budget_tokens: 4000.0,
                config: McModuleConfig {
                    compaction_enabled: !paused,
                    ..Default::default()
                },
            },
        );
        let fixture = Self {
            handler,
            store,
            _dir: dir,
        };
        if !paused {
            fixture.queue("run-a", "session-a", PROJECT);
            fixture.queue("run-sibling", "session-b", PROJECT);
            fixture.queue(
                "run-foreign",
                "session-foreign",
                "/historian-claim-v1/foreign",
            );
        }
        fixture
    }

    fn queue(&self, run: &str, session: &str, project: &str) {
        let mut loaded = self.store.load_meta(session).unwrap();
        loaded.meta.historian.state = mc_store::HistorianPhase::Firing;
        loaded.meta.historian.firing_seq = 1;
        loaded.meta.historian.chunk_fingerprint = format!("fingerprint-{run}");
        self.store
            .commit_meta(session, loaded.row_version, &loaded.meta)
            .unwrap();
        self.store
            .publish_pending_historian_run(&mc_store::NewHistorianPendingRun {
                run_id: run.into(),
                session_id: session.into(),
                project_path: project.into(),
                firing_seq: 1,
                chunk_fingerprint: format!("fingerprint-{run}"),
                system_prompt: "Summarize exactly. café\r\n".into(),
                user_prompt: format!("Transcript for {session}."),
                model_chain: vec!["fixture/model-a".into(), "fixture/model-b".into()],
                await_budget_ms: 1_200_000,
                historian_timeout_ms: Some(120_000),
                now_ms: START,
            })
            .unwrap();
    }

    fn rebind(&self, mutate: impl FnOnce(&mut SessionBinding)) {
        let mut binding = self.handler.facade_binding(7).unwrap();
        mutate(&mut binding);
        self.handler.bind_route(7, binding);
    }

    fn state(&self) -> Value {
        let rows = ["session-a", "session-b", "session-foreign"].map(|session| {
            let state = self.store.load_meta(session).unwrap().meta.historian;
            let parked = self.store.load_parked_historian_run(session).unwrap();
            let report = parked
                .and_then(|run| run.report)
                .map(|report| match report {
                    mc_store::HistorianRunReport::Output {
                        text,
                        length_capped,
                    } => json!({"output":{"text":text,"length_capped":length_capped}}),
                    mc_store::HistorianRunReport::Failed { code, message } => {
                        json!({"error":{"code":code,"message":message}})
                    }
                });
            json!({"session_id":session,"phase":state.state,"run_id":state.producer_run_id,
                "attempt":state.producer_attempt,"token":state.coordinator_token,
                "claim_deadline_ms":state.claim_deadline_ms,"report":report})
        });
        json!({"sessions":rows,"waiting_count":self.handler.host_runs.waiting_count()})
    }

    async fn exchange(&self, id: &str, now: i64, request: Value) -> Value {
        CLOCK.with(|slot| slot.set(Some(now)));
        let request_bytes = serde_json::to_string(&request).unwrap();
        let outcome = self
            .handler
            .dispatch_value(7, serde_json::from_str(&request_bytes).unwrap())
            .await;
        let (kind, bytes) = match outcome {
            HandlerOutcome::Response(bytes) => ("response", bytes),
            HandlerOutcome::Error { code, message } => (
                "error",
                serde_json::to_vec(&json!({"code":code,"message":message})).unwrap(),
            ),
            other => panic!("unexpected historian outcome: {other:?}"),
        };
        let binding = self.handler.facade_binding(7).unwrap();
        json!({"id":id,"now_ms":now,"route":{"project":binding.project_root,"session":binding.session,"harness":binding.harness,"principal":binding.principal,"scope":binding.scope},"request_bytes":request_bytes,"response_kind":kind,
            "response_bytes":String::from_utf8(bytes).unwrap(),"store":self.state()})
    }
}

fn request(method: &str, run: &str, token: &str) -> Value {
    json!({"method":method,"v":1,"run_id":run,"claimant_instance_id":"claimant-a","token":token})
}

fn token(exchange: &Value) -> String {
    serde_json::from_str::<Value>(exchange["response_bytes"].as_str().unwrap()).unwrap()["token"]
        .as_str()
        .unwrap()
        .into()
}

async fn lifecycle(stale: &str) -> Value {
    let f = Fixture::new(false);
    f.rebind(|b| {
        b.harness = if stale == "historian.heartbeat" {
            "pi"
        } else {
            "opencode2"
        }
        .into()
    });
    let mut steps = vec![
        f.exchange(
            "pending",
            START,
            json!({"method":"historian.pending","v":1}),
        )
        .await,
    ];
    let claimed = f
        .exchange("claim", START, request("historian.claim", "run-a", ""))
        .await;
    let old_token = token(&claimed);
    steps.push(claimed);
    let mut competitor = request("historian.claim", "run-a", "");
    competitor["claimant_instance_id"] = json!("claimant-b");
    steps.push(f.exchange("race-loser", START, competitor.clone()).await);
    steps.push(
        f.exchange(
            "heartbeat-renewal",
            START + 30_000,
            request("historian.heartbeat", "run-a", &old_token),
        )
        .await,
    );
    let reclaimed = f
        .exchange("expired-claim-reclaimed", START + 630_001, competitor)
        .await;
    let new_token = token(&reclaimed);
    assert_ne!(old_token, new_token);
    steps.push(reclaimed);
    let mut stale_request = request(stale, "run-a", &old_token);
    if stale == "historian.complete" {
        // An invalid body proves stale authorization is refused before body parsing.
        stale_request["output"] = json!({"text":false});
    }
    steps.push(
        f.exchange("stale-token-refused", START + 630_002, stale_request)
            .await,
    );
    let mut complete = request("historian.complete", "run-a", &new_token);
    complete["output"] = json!({"text":"<compartments/>","length_capped":false});
    steps.push(
        f.exchange("valid-complete", START + 630_003, complete.clone())
            .await,
    );
    steps.push(
        f.exchange("duplicate-complete", START + 630_004, complete)
            .await,
    );
    json!(steps)
}

async fn session_scope() -> Value {
    let f = Fixture::new(false);
    let mut steps = Vec::new();
    for harness in ["opencode", "opencode2", "pi"] {
        f.rebind(|b| b.harness = harness.into());
        steps.push(f.exchange(&format!("{harness}-pending-bound-session"), START,
            json!({"method":"historian.pending","v":1,"session_id":"session-b","project_path":"/historian-claim-v1/foreign"})).await);
        for (run, label) in [
            ("run-sibling", "cross-session"),
            ("run-foreign", "cross-project"),
        ] {
            for method in &METHODS[1..] {
                let mut req = request(method, run, "not-owned");
                req["session_id"] = json!("session-b");
                req["project_path"] = json!("/historian-claim-v1/foreign");
                steps.push(
                    f.exchange(&format!("{harness}-{label}-{method}"), START, req)
                        .await,
                );
            }
        }
    }
    // Keep the session unchanged so this reaches the store's project predicate,
    // rather than being refused earlier by the harness session boundary.
    f.rebind(|b| b.project_root = "/historian-claim-v1/foreign".into());
    for method in METHODS {
        let mut req = request(method, "run-a", "not-owned");
        req["project_path"] = json!(PROJECT);
        steps.push(
            f.exchange(&format!("bound-project-{method}"), START, req)
                .await,
        );
    }
    json!(steps)
}

async fn admission() -> Value {
    let f = Fixture::new(false);
    let mut steps = Vec::new();
    for harness in ["opencode", "opencode2", "pi"] {
        for (label, caller, stamp) in [
            (
                "direct-caller",
                subc_protocol::Principal::Direct,
                Some(scope()),
            ),
            (
                "wrong-reserved-principal",
                subc_protocol::Principal::Reserved {
                    module_id: "thalamus".into(),
                },
                Some(scope()),
            ),
            ("missing-scope", principal(), None),
            (
                "wrong-scope-owner",
                principal(),
                Some({
                    let mut s = scope();
                    s.owner = principal();
                    s
                }),
            ),
            (
                "unauthorized-scope",
                principal(),
                Some({
                    let mut s = scope();
                    s.owner_authorized = false;
                    s
                }),
            ),
        ] {
            f.rebind(|b| {
                b.harness = harness.into();
                b.principal = Some(caller);
                b.scope = stamp;
            });
            for method in METHODS {
                let mut req = request(method, "run-a", "forged-token");
                req["principal"] = json!("reserved:thalamus-harness");
                req["scope"] = json!(scope());
                steps.push(
                    f.exchange(&format!("{harness}-{label}-{method}"), START, req)
                        .await,
                );
            }
        }
    }
    json!(steps)
}

async fn invalid_body() -> Value {
    let f = Fixture::new(false);
    let claim = f
        .exchange("claim", START, request("historian.claim", "run-a", ""))
        .await;
    let live_token = token(&claim);
    let mut steps = vec![claim];
    for (id, output, error) in [
        ("non-string-text", json!({"text":false}), Value::Null),
        (
            "both-output-and-error",
            json!({"text":"<compartments/>"}),
            json!({"code":"failed","message":"no"}),
        ),
        ("missing-output-and-error", Value::Null, Value::Null),
    ] {
        let mut req = request("historian.complete", "run-a", &live_token);
        req["output"] = output;
        req["error"] = error;
        steps.push(f.exchange(id, START + 1, req).await);
    }
    json!(steps)
}

async fn paused() -> Value {
    let f = Fixture::new(true);
    json!([
        f.exchange("disabled-provider-declare", START, json!({"method":"transform.declare","params":{
            "session":"session-a","harness":"opencode","request_id":"paused-declare","preset":"head",
            "params":{"serializer_profile":"opencode-aisdk","observation":"answer"},"composition":{},
            "model":"fixture","context_window":100000,"now":START,"lineage_id":"paused-lineage"
        }})).await,
        f.exchange("disabled-provider-setup", START, json!({"method":"compaction.setup","params":{
            "session":"session-a","harness":"opencode","request_id":"paused-setup","preset":"head",
            "params":{"serializer_profile":"opencode-aisdk","observation":"answer"},"composition":{},
            "model":"fixture","context_window":100000,"now":START,"lineage_id":"paused-lineage"
        }})).await,
        f.exchange("disabled-no-queued-work", START, json!({"method":"historian.pending","v":1})).await,
        f.exchange("disabled-no-claim", START, request("historian.claim", "run-a", "")).await,
    ])
}

async fn race_orderings() -> Value {
    let mut steps = Vec::new();
    // Both serializations of a concurrent CAS race must have exactly one winner.
    for order in [["claimant-a", "claimant-b"], ["claimant-b", "claimant-a"]] {
        let f = Fixture::new(false);
        for claimant in order {
            let mut req = request("historian.claim", "run-a", "");
            req["claimant_instance_id"] = json!(claimant);
            steps.push(
                f.exchange(&format!("{}-first-{claimant}", order[0]), START, req)
                    .await,
            );
        }
    }
    json!(steps)
}

fn run(case: &str) -> Value {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            CLOCK.with(|slot| slot.set(None));
        }
    }
    let _reset = Reset;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    mc_store::with_historian_claim_fixture_entropy(|| {
        runtime.block_on(async {
            match case {
                "session-scope" => session_scope().await,
                "admission" => admission().await,
                "stale-heartbeat" => lifecycle("historian.heartbeat").await,
                "stale-complete" => lifecycle("historian.complete").await,
                "invalid-body" => invalid_body().await,
                "paused" => paused().await,
                "race-orderings" => race_orderings().await,
                other => panic!("unknown conformance case {other}"),
            }
        })
    })
}

const CASES: [&str; 7] = [
    "session-scope",
    "admission",
    "stale-heartbeat",
    "stale-complete",
    "invalid-body",
    "paused",
    "race-orderings",
];

fn vector_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(VECTOR_PATH)
}

fn verify(case: &str) {
    let frozen: Value = serde_json::from_slice(&std::fs::read(vector_path()).unwrap()).unwrap();
    let actual = run(case);
    let expected = &frozen["cases"][case];
    assert_eq!(
        actual.as_array().unwrap().len(),
        expected.as_array().unwrap().len()
    );
    for (actual, expected) in actual
        .as_array()
        .unwrap()
        .iter()
        .zip(expected.as_array().unwrap())
    {
        assert_eq!(actual, expected, "{case}: {}", actual["id"]);
    }
}

#[test]
fn historian_claim_vectors_session_scope() {
    verify("session-scope");
}
#[test]
fn historian_claim_vectors_admission() {
    verify("admission");
}
#[test]
fn historian_claim_vectors_stale_heartbeat() {
    verify("stale-heartbeat");
}
#[test]
fn historian_claim_vectors_stale_complete() {
    verify("stale-complete");
}
#[test]
fn historian_claim_vectors_invalid_body() {
    verify("invalid-body");
}
#[test]
fn historian_claim_vectors_paused() {
    verify("paused");
}
#[test]
fn historian_claim_vectors_race_orderings() {
    verify("race-orderings");
}

#[test]
fn historian_claim_vectors_byte_identical_regeneration() {
    let cases: serde_json::Map<String, Value> =
        CASES.into_iter().map(|id| (id.into(), run(id))).collect();
    let vectors = json!({"schema":"mc-historian-claim/v1", "limits":{"report_text_bytes":MAX_HISTORIAN_REPORT_BYTES,"facade_frame_bytes":MAX_FACADE_FRAME_BYTES}, "generator":{
        "version":1,"source_base":"919bc9862839c3c1820b4e673e3ba210782a1d7c",
        "command":"bash packages/plugin/src/hooks/magic-context/host-runner/conformance/generate-historian-claim.sh --write",
        "clock":"fixed wall clock per step", "entropy":"test-support only: process id and sequence set to zero; all other token inputs unchanged",
        "store_root":"$TMPDIR/magic-context/historian-claim-v1/",
        "error_encoding":"HandlerOutcome::Error code/message as compact JSON; response_kind distinguishes ERROR from RESPONSE"
    },"cases":cases});
    let bytes = format!("{}\n", serde_json::to_string_pretty(&vectors).unwrap());
    if std::env::var_os("MC_WRITE_HISTORIAN_CLAIM_VECTORS").is_some() {
        std::fs::write(vector_path(), &bytes).unwrap();
    } else {
        assert_eq!(
            std::fs::read_to_string(vector_path()).unwrap(),
            bytes,
            "historian-claim-v1.json drift; run generator with --write"
        );
    }
}

#[test]
fn historian_claim_vectors_concurrent_claimants_have_one_winner() {
    let f = Fixture::new(false);
    let barrier = std::sync::Barrier::new(2);
    let outcomes = std::thread::scope(|threads| {
        let tasks: Vec<_> = ["claimant-a", "claimant-b"]
            .into_iter()
            .map(|claimant| {
                let f = &f;
                let barrier = &barrier;
                threads.spawn(move || {
                    CLOCK.with(|slot| slot.set(Some(START)));
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .unwrap();
                    let mut req = request("historian.claim", "run-a", "");
                    req["claimant_instance_id"] = json!(claimant);
                    barrier.wait();
                    let outcome = runtime.block_on(f.handler.dispatch_value(7, req));
                    let HandlerOutcome::Response(bytes) = outcome else {
                        panic!("{outcome:?}");
                    };
                    serde_json::from_slice::<Value>(&bytes).unwrap()
                })
            })
            .collect();
        tasks
            .into_iter()
            .map(|task| task.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| outcome["ok"] == true)
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| outcome["refusal"] == "already_claimed")
            .count(),
        1
    );
    assert_eq!(
        f.store
            .load_meta("session-a")
            .unwrap()
            .meta
            .historian
            .producer_attempt,
        1
    );
}
