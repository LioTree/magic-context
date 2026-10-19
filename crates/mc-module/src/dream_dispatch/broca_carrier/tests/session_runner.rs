//! A dream child for a runner-lane conversation: the same llm-runner carrier as
//! Broca, through a port that reaches the conversation's own runner. The fake
//! runner is the Broca fake behind a port that reports the parent session, as the
//! production port does for a session runner route.

use super::*;

/// The fake runner, reached as the runner that owns the dream's parent session.
#[derive(Clone)]
struct SessionRunnerPort {
    runner: FakeBroca,
    parent: String,
}

impl BrocaPort for SessionRunnerPort {
    async fn call(&mut self, session: &str, op: &str, params: Value) -> Result<Value, PortError> {
        self.runner.call(session, op, params).await
    }

    async fn next_unit(&mut self, session: &str) -> Result<Option<Value>, PortError> {
        self.runner.next_unit(session).await
    }

    async fn release(&mut self, session: &str) {
        self.runner.release(session).await;
    }

    fn session_runner_parent(&self) -> Option<&str> {
        Some(&self.parent)
    }
}

fn session_carrier(f: &Fixture, parent: &str) -> BrocaCarrier<SessionRunnerPort> {
    BrocaCarrier::new(
        SessionRunnerPort {
            runner: f.broca.clone(),
            parent: parent.into(),
        },
        f.handler.broca_dream_tools(),
        f.context.clone(),
        f.effects.clone(),
        f.effects.clone(),
        f.scheduler.clone(),
        policy(),
    )
}

/// A request whose runner the user left unset, so the harness default applies
/// (`host` for the OpenCode harness).
fn harness_default(f: &Fixture, tools: &'static [&'static str]) -> ChildRequest {
    let mut request = f.request(tools, 3);
    request.runner = ResolvedRunner {
        kind: HistorianRunnerKind::Host,
        source: RunnerSource::HarnessDefault,
    };
    request
}

/// On a runner lane the child needs no configured Broca runner: it runs on the
/// session's own runner, which receives the parent, the read-only allowlist as a
/// plan (no inline tools), the step limit and the runner's retention, and no input
/// cap the runner did not advertise.
#[tokio::test]
async fn a_session_runner_child_names_its_parent_and_keeps_the_carrier_limits() {
    let f = Fixture::new(BASE);
    f.script(vec![answer("done")]);
    let request = harness_default(&f, &["ctx_search"]);
    let completion = bounded(async {
        let mut carrier = session_carrier(&f, "parent");
        let child = carrier.open(&request).await.expect("open");
        let completion = carrier.complete(&child, &request).await;
        carrier.close(&child, completion.is_ok()).await.unwrap();
        completion
    })
    .await;
    assert_eq!(completion.unwrap().text, "done");
    let sent = f.sent();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["parent"], "parent");
    assert_eq!(sent[0]["tools"], json!([]));
    assert_eq!(sent[0]["stop_when"], json!({"max_steps": 3}));
    assert_eq!(sent[0]["retention"], ORDINARY_RETENTION_SECONDS);
    assert_eq!(
        sent[0]["plan"]["items"],
        json!([{"provider": "magic-context", "item": "tools",
            "params": {"tools": ["ctx_search"]}}])
    );
    assert!(sent[0].get("budget").is_none(), "{}", sent[0]);
}

/// The port's parent must be the task's own parent session: a child is never
/// sent under another conversation.
#[tokio::test]
async fn a_session_runner_child_for_another_parent_is_refused_before_any_op() {
    let f = Fixture::new(BASE);
    let refused = bounded(session_carrier(&f, "someone-else").open(&harness_default(&f, &[])))
        .await
        .unwrap_err();
    assert_eq!(refused.message, "invalid_descriptor");
    assert!(f.broca.state().log.is_empty());
}

/// The same request through the configured-runner port is still refused: only
/// the session's own runner removes the configured-Broca requirement.
#[tokio::test]
async fn the_configured_port_still_requires_a_configured_broca() {
    let f = Fixture::new(BASE);
    let refused = bounded(f.carrier(policy()).open(&harness_default(&f, &[])))
        .await
        .unwrap_err();
    assert_eq!(refused.message, "unavailable: broca_not_configured");
    assert!(f.broca.state().log.is_empty());
}
