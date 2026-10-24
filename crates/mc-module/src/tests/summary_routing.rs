//! Summaries placed by routing, driven through the real firing preparation and
//! executor with the routing conformance kit's fake provider and the test runner.

use std::sync::Mutex as StdMutex;

use cortexkit_role_routing::{
    errors::Refusal,
    report::{Outcome, ReportAnswer, ReportRequest},
    wire,
};
use cortexkit_role_routing_conformance::{
    fixture, ConsumerConfig, Reply, RouteStamp, RoutingRoute, RoutingSubject,
};
use serde::de::DeserializeOwned;

use super::*;
use crate::historian_routed::{answered_model, SummaryRouting, SummaryScope};
use crate::model_work::tests::kit_fake::{Defects, FakeRoute, FakeSubject};
use crate::model_work::{RoutingCatalog, SelectParams};
use crate::runner_choices::RoutedChoice;

const PROVIDER: &str = "routing-provider";
const SCOPE_REF: &str = "person-session";

#[derive(Default)]
struct RoutingTrace {
    selects: Vec<Value>,
    answers: Vec<RoutedChoice>,
    reports: Vec<ReportRequest>,
    runner_modules: Vec<String>,
    scope_refs: Vec<String>,
}

struct FakeRouting {
    subject: FakeSubject,
    route: FakeRoute,
    providers: Vec<String>,
    accepts_hold_ok: bool,
    config_home: PathBuf,
    producer: Arc<ProducerState>,
    trace: StdMutex<RoutingTrace>,
}

fn decode<T: DeserializeOwned>(reply: Reply) -> Result<T, Refusal> {
    match reply {
        Reply::Response(text) => Ok(wire::read_reply(text.as_bytes()).unwrap()),
        Reply::Error(error) => {
            Err(serde_json::from_value(serde_json::to_value(error).unwrap()).unwrap())
        }
    }
}

#[async_trait]
impl SummaryRouting for FakeRouting {
    async fn catalog(&self) -> Result<RoutingCatalog, String> {
        Ok(RoutingCatalog {
            generation: 1,
            providers: self.providers.clone(),
        })
    }

    async fn select(
        &self,
        provider: &str,
        scope: &SummaryScope,
        params: &SelectParams,
    ) -> Result<RoutedChoice, Refusal> {
        assert_eq!(provider, PROVIDER);
        let params = serde_json::to_value(params).unwrap();
        {
            let mut trace = self.trace.lock().unwrap();
            trace.selects.push(params.clone());
            trace.scope_refs.push(scope.stamp.scope_ref.clone());
        }
        let answer: RoutedChoice =
            decode(self.route.request("route.select", &params).await.unwrap())?;
        self.trace.lock().unwrap().answers.push(answer.clone());
        Ok(answer)
    }

    async fn report(
        &self,
        provider: &str,
        scope: &SummaryScope,
        report: &ReportRequest,
    ) -> Result<ReportAnswer, Refusal> {
        assert_eq!(provider, PROVIDER);
        {
            let mut trace = self.trace.lock().unwrap();
            trace.reports.push(report.clone());
            trace.scope_refs.push(scope.stamp.scope_ref.clone());
        }
        decode(
            self.route
                .request("route.report", &serde_json::to_value(report).unwrap())
                .await
                .unwrap(),
        )
    }

    async fn connect_runner(
        &self,
        scope: &SummaryScope,
        module_id: &str,
    ) -> Result<Box<dyn HistorianProducerDriver + Send>, HistorianProducerError> {
        {
            let mut trace = self.trace.lock().unwrap();
            trace.runner_modules.push(module_id.to_string());
            trace.scope_refs.push(scope.stamp.scope_ref.clone());
        }
        Ok(Box::new(TestProducer {
            state: Arc::clone(&self.producer),
        }))
    }

    fn select_accepts_hold_ok(&self) -> bool {
        self.accepts_hold_ok
    }

    fn persona_tiers(
        &self,
        project_root: &Path,
    ) -> Result<Vec<cortexkit_persona::Tier>, cortexkit_persona::PersonaError> {
        crate::persona_host::tier_ladder_with_config_home(
            &self.config_home,
            None,
            Some(project_root),
        )
    }
}

struct RoutedFactory {
    routing: Arc<FakeRouting>,
}

#[async_trait]
impl HistorianProducerFactory for RoutedFactory {
    async fn connect(
        &self,
        _project_root: &Path,
    ) -> Result<Box<dyn HistorianProducerDriver + Send>, HistorianProducerError> {
        panic!("a routed summary connects only to the runner routing answered");
    }

    fn summary_routing(&self) -> Option<Arc<dyn crate::historian_routed::SummaryRouting>> {
        Some(self.routing.clone())
    }
}

struct Rig {
    handler: McHandler,
    store: Arc<McStore>,
    dir: tempfile::TempDir,
    project: PathBuf,
    producer: Arc<ProducerState>,
    routing: Arc<FakeRouting>,
}

fn stamp() -> subc_protocol::scope::ScopeStamp {
    subc_protocol::scope::ScopeStamp::new(
        subc_protocol::Principal::Reserved {
            module_id: "prefrontal-core".into(),
        },
        SCOPE_REF,
        1,
        subc_protocol::scope::ScopeKind::Head,
    )
    .with_owner_authorized(true)
}

fn routed_config() -> McModuleConfig {
    let mut config = default_test_config();
    config.rust_background_enabled = true;
    config
}

fn routed_binding(project: &Path) -> SessionBinding {
    let mut binding = binding(project.to_str().unwrap(), "ses");
    binding.config = routed_config();
    binding.scope = Some(stamp());
    binding
}

async fn rig_with(providers: &[&str], accepts_hold_ok: bool) -> Rig {
    let producer = Arc::new(ProducerState::default());
    let dir = tempfile::tempdir().unwrap();
    let data_home = dir.path().join("data");
    std::fs::create_dir_all(&data_home).unwrap();
    let store =
        Arc::new(McStore::open_for_test(&dev_descriptor_at(data_home.to_str().unwrap())).unwrap());
    let subject = FakeSubject::new(Defects::default());
    subject
        .configure_catalog(&fixture::catalog())
        .await
        .unwrap();
    subject
        .configure_consumers(&[ConsumerConfig {
            id: crate::persona_host::SUMMARY_CONSUMER.into(),
            priced_only: false,
        }])
        .await
        .unwrap();
    let route = subject
        .route(&RouteStamp::project("magic-context", "project-one"))
        .await
        .unwrap();
    let routing = Arc::new(FakeRouting {
        subject,
        route,
        providers: providers.iter().map(|p| p.to_string()).collect(),
        accepts_hold_ok,
        config_home: dir.path().join("config"),
        producer: Arc::clone(&producer),
        trace: StdMutex::default(),
    });
    let handler = McHandler::with_producer_factory_config_resolver(
        Arc::new(RoutedFactory {
            routing: Arc::clone(&routing),
        }),
        routed_config(),
        Arc::new(MissingSessionResolver),
    );
    handler.store.set(Arc::clone(&store)).ok().unwrap();
    let project = dir.path().join("project");
    std::fs::create_dir_all(&project).unwrap();
    handler.bind_route(7, routed_binding(&project));
    seed_block_identities(&store);
    Rig {
        handler,
        store,
        dir,
        project,
        producer,
        routing,
    }
}

/// Store the block identities a transform would have recorded for the
/// conversation, which the publication fence checks a summary against.
fn seed_block_identities(store: &McStore) {
    let parsed: TransformRequest = serde_json::from_value(request(messages())).unwrap();
    let projection = crate::ck_wire::project_messages(&parsed.messages).unwrap();
    let loaded = store.load("ses").unwrap();
    let mut meta = loaded.meta;
    meta.block_identity_by_mid
        .extend(projection.identity_by_mid);
    store
        .commit("ses", loaded.row_version, &loaded.core, &meta)
        .unwrap();
}

async fn rig() -> Rig {
    rig_with(&[PROVIDER], false).await
}

fn messages() -> Vec<CkIngressMessage> {
    wrapup_messages(240, 800)
}

fn prepare_task(handler: &McHandler, store: Arc<McStore>, project: &Path) -> HistorianFiringTask {
    let parsed: TransformRequest = serde_json::from_value(request(messages())).unwrap();
    let projection = crate::ck_wire::project_messages(&parsed.messages).unwrap();
    let mut timings = HistorianTriggerTimings::default();
    match handler.prepare_historian_fire(
        store,
        &parsed,
        &routed_binding(project),
        project.to_str().unwrap(),
        &projection,
        HistorianPrepareContext {
            rust_background_enabled: Some(true),
            now: now_ms(),
            snapshot_generation: None,
            publication_fence: None,
            tag_snapshot: None,
            async_coverage: None,
            reclaim_ride_available: false,
            runner_lane: true,
            timings: &mut timings,
        },
    ) {
        PreparedHistorianAction::FireReady(prepared) => prepared.task,
        PreparedHistorianAction::Complete(diagnostics) => {
            panic!("expected firing: {diagnostics:?}")
        }
        PreparedHistorianAction::Busy { .. } => panic!("unexpected busy"),
    }
}

impl Rig {
    fn task(&self) -> HistorianFiringTask {
        prepare_task(&self.handler, Arc::clone(&self.store), &self.project)
    }

    async fn fire(
        &self,
        task: HistorianFiringTask,
    ) -> Result<historian::HistorianDriveOutcome, historian::HistorianDriveError> {
        McHandler::execute_historian_firing_task(self.handler.producer_factory.clone(), task).await
    }

    fn failure(&self) -> (Option<String>, Option<i64>) {
        let state = self.store.load_meta("ses").unwrap().meta.historian;
        (state.last_failure, state.failure_backoff_at_ms)
    }

    fn fail_next_start(&self, code: &str) {
        self.producer
            .start_errors
            .lock()
            .unwrap()
            .push_back(Err(HistorianProducerError::Subc(
                crate::historian_producer::ProducerErrorBody::untagged(
                    code,
                    "fixture runner failure",
                ),
            )));
    }

    /// Clear the failure backoff an earlier firing left, so the next transform fires.
    fn clear_backoff(&self) {
        let loaded = self.store.load_meta("ses").unwrap();
        let mut meta = loaded.meta.clone();
        meta.historian.failure_backoff_at_ms = None;
        self.store
            .commit_meta("ses", loaded.row_version, &meta)
            .unwrap();
    }

    fn write_user_persona(&self, body: &str) {
        let path = self
            .dir
            .path()
            .join("config/cortexkit/magic-context/roles/mc_summary/PERSONA.md");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            format!("---\n---\n{{% block instructions %}}{body}{{% endblock %}}"),
        )
        .unwrap();
    }
}

fn today_system_bytes() -> String {
    crate::historian_prompt::with_content_language_directive(
        crate::historian_prompt::HISTORIAN_SYSTEM_PROMPT,
        None,
        Default::default(),
    )
    .into_owned()
}

#[tokio::test]
async fn routed_summary_selects_sends_exactly_the_answer_and_reports_on_the_session_scope() {
    let rig = rig().await;
    let task = rig.task();
    assert_eq!(task.scope.as_ref().unwrap().scope_ref, SCOPE_REF);
    let outcome = rig.fire(task).await.unwrap();
    let historian::HistorianDriveOutcome::Completed(success) = outcome else {
        panic!("expected a published summary, got {outcome:?}");
    };
    let trace = rig.routing.trace.lock().unwrap();
    assert_eq!(trace.selects.len(), 1);
    let answer = &trace.answers[0];
    let select = &trace.selects[0];
    assert_eq!(select["consumer"], "mc.summary");
    assert_eq!(select["requirements"]["iq"], 50);
    assert_eq!(select["requirements"]["tools"], "none");
    assert_eq!(select["requirements"]["max_output_tokens"], 32_000);
    assert!(select["requirements"]["context_window"].as_u64().unwrap() > 32_000);
    assert!(select.get("exclude").is_none());
    assert!(select["affinity"]
        .as_str()
        .unwrap()
        .starts_with("mc.summary:"));
    for forbidden in [
        "project",
        "project_id",
        "session",
        "workdir",
        "scope",
        "runners",
    ] {
        assert!(
            select.get(forbidden).is_none(),
            "select carried {forbidden}"
        );
    }
    // Exactly the answered runner and model, under the session's own scope.
    assert_eq!(
        trace.runner_modules,
        std::slice::from_ref(&answer.runner.module)
    );
    assert_eq!(
        *rig.producer.models.lock().unwrap(),
        [answered_model(answer)]
    );
    assert_eq!(success.model, answered_model(answer));
    assert!(trace.scope_refs.iter().all(|scope| scope == SCOPE_REF));
    assert_eq!(trace.reports.len(), 1);
    assert_eq!(trace.reports[0].decision_id, answer.decision_id);
    assert_eq!(trace.reports[0].outcome, Outcome::Completed);
    // The persona renders today's system bytes and freezes them on the session.
    let systems = rig.producer.systems.lock().unwrap();
    assert_eq!(systems.as_slice(), [today_system_bytes()]);
    let frozen = rig
        .store
        .load_meta("ses")
        .unwrap()
        .meta
        .summary_persona
        .unwrap();
    assert_eq!(frozen.bytes, systems[0]);
    assert_eq!(frozen.consumer, "mc.summary");
}

#[tokio::test]
async fn failed_decision_is_reported_and_reselected_with_its_route_excluded() {
    let rig = rig().await;
    rig.fail_next_start("upstream_overloaded");
    let outcome = rig.fire(rig.task()).await.unwrap();
    assert!(matches!(
        outcome,
        historian::HistorianDriveOutcome::Completed(_)
    ));
    let trace = rig.routing.trace.lock().unwrap();
    assert_eq!(trace.selects.len(), 2);
    let first = &trace.answers[0];
    let second = &trace.answers[1];
    assert!(trace.selects[0].get("exclude").is_none());
    assert_eq!(
        trace.selects[1]["exclude"],
        json!([first.route.route_key()])
    );
    assert_ne!(first.route.route_key(), second.route.route_key());
    assert_eq!(
        *rig.producer.models.lock().unwrap(),
        [answered_model(first), answered_model(second)]
    );
    assert_eq!(trace.reports.len(), 2);
    assert_eq!(trace.reports[0].decision_id, first.decision_id);
    assert!(trace.reports[0].outcome.is_failure());
    assert_eq!(
        trace.reports[0].runner_code.as_deref(),
        Some("upstream_overloaded")
    );
    assert_eq!(trace.reports[1].decision_id, second.decision_id);
    assert_eq!(trace.reports[1].outcome, Outcome::Completed);
}

#[tokio::test]
async fn timed_routing_refusal_parks_the_summary_until_reset_without_a_send() {
    let rig = rig().await;
    let reset = now_ms() as u64 + 3_600_000;
    for model in fixture::catalog().models {
        rig.routing
            .subject
            .cool_down(&model.route_key(), reset)
            .await
            .unwrap();
    }
    let error = rig.fire(rig.task()).await.unwrap_err();
    assert!(error.to_string().contains("mc_route_waiting"), "{error}");
    assert_eq!(rig.producer.starts.load(Ordering::SeqCst), 0);
    let trace = rig.routing.trace.lock().unwrap();
    assert_eq!(trace.selects.len(), 1);
    assert!(trace.runner_modules.is_empty());
    assert!(trace.reports.is_empty());
    let (failure, backoff) = rig.failure();
    assert!(failure.unwrap().starts_with("mc_route_waiting"));
    assert_eq!(backoff, Some(reset as i64));
}

#[tokio::test]
async fn no_routing_provider_refuses_by_name_and_sends_nothing() {
    let rig = rig_with(&[], false).await;
    let error = rig.fire(rig.task()).await.unwrap_err();
    assert!(
        error.to_string().contains("mc_routing_unavailable"),
        "{error}"
    );
    assert_eq!(rig.producer.starts.load(Ordering::SeqCst), 0);
    let trace = rig.routing.trace.lock().unwrap();
    assert!(trace.selects.is_empty());
    assert!(trace.runner_modules.is_empty());
    assert!(trace.reports.is_empty());
    let (failure, backoff) = rig.failure();
    assert!(failure.unwrap().starts_with("mc_routing_unavailable"));
    assert!(backoff.is_some());
}

#[tokio::test]
async fn frozen_persona_bytes_are_reused_after_a_persona_file_edit() {
    let rig = rig().await;
    rig.write_user_persona("FIRST WORDING");
    // The first firing fails on both answerable routes, after rendering and
    // sending the persona; the session keeps its frozen bytes.
    rig.fail_next_start("upstream_overloaded");
    rig.fail_next_start("upstream_overloaded");
    assert!(rig.fire(rig.task()).await.is_err());
    let frozen = rig
        .store
        .load_meta("ses")
        .unwrap()
        .meta
        .summary_persona
        .unwrap();
    assert_eq!(frozen.bytes, "FIRST WORDING");
    rig.write_user_persona("SECOND WORDING");
    rig.clear_backoff();
    let outcome = rig.fire(rig.task()).await.unwrap();
    assert!(matches!(
        outcome,
        historian::HistorianDriveOutcome::Completed(_)
    ));
    let systems = rig.producer.systems.lock().unwrap();
    assert_eq!(systems.len(), 3);
    assert!(
        systems.iter().all(|system| system == "FIRST WORDING"),
        "{systems:?}"
    );
    assert_eq!(
        rig.store
            .load_meta("ses")
            .unwrap()
            .meta
            .summary_persona
            .unwrap(),
        frozen
    );
}

#[test]
fn frozen_identity_covers_generation_and_demand_not_only_bytes() {
    let base = crate::historian_routed::frozen_identity("digest", None, "mc.summary", 50, None);
    assert_ne!(
        base,
        crate::historian_routed::frozen_identity("digest", Some(0.2), "mc.summary", 50, None)
    );
    assert_ne!(
        base,
        crate::historian_routed::frozen_identity("digest", None, "mc.summary", 70, None)
    );
    assert_ne!(
        base,
        crate::historian_routed::frozen_identity("other", None, "mc.summary", 50, None)
    );
}

#[tokio::test]
async fn pressure_summary_sends_hold_ok_false_when_routing_accepts_it() {
    let rig = rig_with(&[PROVIDER], true).await;
    let mut task = rig.task();
    task.pressure = true;
    rig.fire(task).await.unwrap();
    let trace = rig.routing.trace.lock().unwrap();
    assert_eq!(trace.selects[0]["hold_ok"], json!(false));
}

#[tokio::test]
async fn hold_ok_is_not_sent_when_routing_does_not_accept_it_or_without_pressure() {
    for (accepts, pressure) in [(false, true), (true, false)] {
        let rig = rig_with(&[PROVIDER], accepts).await;
        let mut task = rig.task();
        task.pressure = pressure;
        rig.fire(task).await.unwrap();
        let trace = rig.routing.trace.lock().unwrap();
        assert!(
            trace.selects[0].get("hold_ok").is_none(),
            "accepts={accepts} pressure={pressure}: {}",
            trace.selects[0]
        );
    }
}

/// Run one summary on the chain-walking path with the given model, the way
/// sessions summarized before routing.
async fn chain_path_rig(
    model: &str,
) -> (
    McHandler,
    Arc<McStore>,
    tempfile::TempDir,
    PathBuf,
    Arc<ProducerState>,
) {
    let producer = Arc::new(ProducerState::default());
    let (handler, store, dir, project) = handler_with_store(Arc::clone(&producer), routed_config());
    handler.bind_route(7, routed_binding(&project));
    seed_block_identities(&store);
    let mut raw = request(messages());
    raw["historian_model_chain"] = json!([model]);
    let parsed: TransformRequest = serde_json::from_value(raw).unwrap();
    let projection = crate::ck_wire::project_messages(&parsed.messages).unwrap();
    let mut timings = HistorianTriggerTimings::default();
    let task = match handler.prepare_historian_fire(
        Arc::clone(&store),
        &parsed,
        &routed_binding(&project),
        project.to_str().unwrap(),
        &projection,
        HistorianPrepareContext {
            rust_background_enabled: Some(true),
            now: now_ms(),
            snapshot_generation: None,
            publication_fence: None,
            tag_snapshot: None,
            async_coverage: None,
            reclaim_ride_available: false,
            runner_lane: true,
            timings: &mut timings,
        },
    ) {
        PreparedHistorianAction::FireReady(prepared) => prepared.task,
        other => panic!(
            "expected firing: {:?}",
            matches!(other, PreparedHistorianAction::Busy { .. })
        ),
    };
    McHandler::execute_historian_firing_task(handler.producer_factory.clone(), task)
        .await
        .unwrap();
    (handler, store, dir, project, producer)
}

fn without_timestamps(
    mut rows: Vec<mc_store::StoredCompartment>,
) -> Vec<mc_store::StoredCompartment> {
    for row in &mut rows {
        row.created_at = 0;
    }
    rows
}

/// The parent's served messages after a summary, with the rig's own temporary
/// paths replaced so two rigs compare byte for byte.
async fn served_after_summary(handler: &McHandler, project: &Path, dir: &Path) -> String {
    // Low usage: this transform serves the published summary and fires nothing.
    let served =
        call_transform_request(handler, request_with_usage(messages(), 5_000, 50_000)).await;
    serde_json::to_string(&served["ck_messages"])
        .unwrap()
        .replace(project.to_str().unwrap(), "<project>")
        .replace(dir.to_str().unwrap(), "<dir>")
}

#[tokio::test]
async fn routed_output_is_byte_identical_to_the_chain_path_for_the_same_model() {
    let routed = rig().await;
    routed.fire(routed.task()).await.unwrap();
    let answer = routed.routing.trace.lock().unwrap().answers[0].clone();
    let model = answered_model(&answer);
    let (_handler, chain_store, chain_dir, chain_project, chain_producer) =
        chain_path_rig(&model).await;
    let normalize = |texts: &[String], project: &Path, dir: &Path| -> Vec<String> {
        texts
            .iter()
            .map(|text| {
                text.replace(project.to_str().unwrap(), "<project>")
                    .replace(dir.to_str().unwrap(), "<dir>")
            })
            .collect()
    };
    assert_eq!(
        *chain_producer.models.lock().unwrap(),
        std::slice::from_ref(&model)
    );
    assert_eq!(*routed.producer.models.lock().unwrap(), [model]);
    assert_eq!(
        *chain_producer.systems.lock().unwrap(),
        *routed.producer.systems.lock().unwrap()
    );
    assert_eq!(
        normalize(
            &chain_producer.prompts.lock().unwrap(),
            &chain_project,
            chain_dir.path()
        ),
        normalize(
            &routed.producer.prompts.lock().unwrap(),
            &routed.project,
            routed.dir.path()
        )
    );
    let routed_rows = without_timestamps(routed.store.load_compartments("ses").unwrap());
    assert!(!routed_rows.is_empty());
    assert_eq!(
        without_timestamps(chain_store.load_compartments("ses").unwrap()),
        routed_rows
    );
}

/// Where a summary ran is never an input to the parent's served prompt: a
/// summary placed on a different route after a forced route failure leaves the
/// parent's served messages byte-identical to one placed on the first answer.
#[tokio::test]
async fn placement_never_changes_the_parents_served_prefix() {
    let direct = rig().await;
    direct.fire(direct.task()).await.unwrap();
    let rerouted = rig().await;
    rerouted.fail_next_start("upstream_overloaded");
    rerouted.fire(rerouted.task()).await.unwrap();
    {
        let direct_trace = direct.routing.trace.lock().unwrap();
        let rerouted_trace = rerouted.routing.trace.lock().unwrap();
        assert_eq!(direct_trace.answers.len(), 1);
        assert_eq!(rerouted_trace.answers.len(), 2);
        assert_ne!(
            direct_trace.answers[0].route, rerouted_trace.answers[1].route,
            "the two summaries must run on different routes"
        );
    }
    let direct_served =
        served_after_summary(&direct.handler, &direct.project, direct.dir.path()).await;
    let rerouted_served =
        served_after_summary(&rerouted.handler, &rerouted.project, rerouted.dir.path()).await;
    // The summary itself reaches the parent; only its placement must not.
    assert!(direct_served.contains("autonomous"), "{direct_served}");
    assert_eq!(direct_served, rerouted_served);
}
