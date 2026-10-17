use super::*;

const VECTOR_PATH: &str = "../../packages/plugin/src/hooks/magic-context/host-runner/conformance/vectors/dream-claim-v1.json";

struct Recorder {
    replacements: Vec<(String, String)>,
    cases: Vec<Value>,
}
impl Recorder {
    fn new(f: &Fixture) -> Self {
        Self {
            replacements: vec![(
                f.root
                    .path()
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .into(),
                "<root>".into(),
            )],
            cases: Vec::new(),
        }
    }
    fn bind(&mut self, claim: &Value, attempt: usize) {
        let id = claim["entry_id"].as_str().unwrap();
        self.replacements
            .push((format!("host-{id}"), format!("<host-child-{attempt}>")));
        for (value, name) in [
            (claim["descriptor"]["child_id"].as_str().unwrap(), "child"),
            (claim["token"].as_str().unwrap(), "token"),
            (id, "entry"),
        ] {
            self.replacements
                .push((value.into(), format!("<{name}-{attempt}>")));
        }
    }
    fn normalize(&self, value: &Value) -> Value {
        match value {
            Value::String(s) => {
                let mut result = s.clone();
                for (from, to) in &self.replacements {
                    result = result.replace(from, to);
                }
                Value::String(result)
            }
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), self.normalize(v)))
                    .collect(),
            ),
            Value::Array(items) => Value::Array(items.iter().map(|v| self.normalize(v)).collect()),
            v => v.clone(),
        }
    }
    fn record(&mut self, name: &str, request: Value, response: Value) {
        self.cases.push(json!({"name": name, "request": self.normalize(&request), "response": self.normalize(&response)}));
    }
    async fn send(
        &mut self,
        f: &Fixture,
        claim: &Value,
        name: &str,
        method: &str,
        mut body: Value,
    ) -> Value {
        body["method"] = json!(method);
        body["v"] = json!(1);
        body["entry_id"] = claim["entry_id"].clone();
        body["token"] = claim["token"].clone();
        body["claimant_epoch"] = json!("epoch-1");
        body["child_id"] = claim["descriptor"]["child_id"].clone();
        let response = f.call(7, body.clone()).await;
        self.record(name, body, response.clone());
        response
    }
}

/// Generate normalized transcripts by executing the same McHandler dispatch as
/// production. The fixture substitutes only OS credentials and temporary roots.
#[tokio::test]
async fn dream_claim_v1_frozen_vectors() {
    let f = Fixture::new();
    let mut r = Recorder::new(&f);
    let request = json!({"v": 1, "method": "dream.child.pending"});
    r.record(
        "unbound_route",
        request.clone(),
        f.call(99, request.clone()).await,
    );
    match Box::pin(
        f.handler
            .dispatch_value(7, json!({"v": 2, "method": "dream.child.pending"})),
    )
    .await
    {
        HandlerOutcome::Error { code, .. } => r.record(
            "version_refusal",
            json!({"v": 2, "method": "dream.child.pending"}),
            json!({"error": code}),
        ),
        _ => panic!("version must refuse"),
    }
    let (job, claim, child) = f.running().await;
    r.bind(&claim, 1);
    r.record("selected_attempt_claim", json!({"v": 1, "method": "dream.child.claim", "entry_id": claim["entry_id"], "claimant_epoch": "epoch-1", "capabilities": capabilities()}), claim.clone());
    r.record("claim_race", json!({"v": 1, "method": "dream.child.claim", "entry_id": claim["entry_id"], "claimant_epoch": "epoch-1", "capabilities": capabilities()}), f.claim(&claim["entry_id"]).await);
    let mut stale = claim.clone();
    stale["token"] = json!("stale-token");
    r.send(
        &f,
        &stale,
        "stale_token",
        "dream.child.tool",
        json!({"call_id": "stale", "tool": "ctx_memory", "arguments": {}}),
    )
    .await;
    let mut binding = f.handler.bindings.lock().unwrap().get(&7).unwrap().clone();
    binding.session = "other-session".into();
    f.handler.bind_route(8, binding.clone());
    r.record(
        "session_confined_pending",
        request.clone(),
        f.call(8, request.clone()).await,
    );
    let other_claim = json!({"v": 1, "method": "dream.child.claim", "entry_id": claim["entry_id"], "claimant_epoch": "epoch-1", "capabilities": capabilities()});
    r.record(
        "session_confined_claim",
        other_claim.clone(),
        f.call(8, other_claim).await,
    );
    binding.session = "parent".into();
    binding.principal = Some(subc_protocol::Principal::Reserved {
        module_id: "untrusted".into(),
    });
    f.handler.bind_route(9, binding);
    r.record(
        "unattested_principal",
        request.clone(),
        f.call(9, request).await,
    );
    r.send(&f, &claim, "forged_arguments_are_not_authority", "dream.child.tool", json!({"call_id": "effect", "tool": "ctx_memory", "arguments": {"child_id": "forged", "token": "forged"}})).await;
    assert_eq!(f.effects.calls.lock().unwrap()[0].0, child);
    r.send(&f, &claim, "tool_replay", "dream.child.tool", json!({"call_id": "effect", "tool": "ctx_memory", "arguments": {"child_id": "forged", "token": "forged"}})).await;
    r.send(
        &f,
        &claim,
        "forbidden_tool",
        "dream.child.tool",
        json!({"call_id": "denied", "tool": "bash", "arguments": {}}),
    )
    .await;
    let event = json!({"seq": 1, "event": {"kind": "usage", "message_id": "usage-1", "completed": false, "usage": {"input": 90, "output": 1000, "cache_read": 10, "cache_write": 1}}});
    r.send(
        &f,
        &claim,
        "usage_overflow",
        "dream.child.event",
        event.clone(),
    )
    .await;
    r.send(&f, &claim, "usage_replay", "dream.child.event", event)
        .await;
    r.send(
        &f,
        &claim,
        "over_budget_tool",
        "dream.child.tool",
        json!({"call_id": "overflow", "tool": "ctx_memory", "arguments": {}}),
    )
    .await;
    f.control.lease.store(false, Ordering::SeqCst);
    r.send(
        &f,
        &claim,
        "lease_loss_tool",
        "dream.child.tool",
        json!({"call_id": "lost-lease", "tool": "ctx_memory", "arguments": {}}),
    )
    .await;
    r.send(&f, &claim, "stop_ack", "dream.child.heartbeat", json!({}))
        .await;
    r.send(
        &f,
        &claim,
        "cleanup_unknown",
        "dream.child.cleanup",
        json!({"quiescent": true, "retired": false}),
    )
    .await;
    r.send(
        &f,
        &claim,
        "cleanup_ack",
        "dream.child.cleanup",
        json!({"quiescent": true, "retired": true}),
    )
    .await;
    job.abort();
    let _ = job.await;

    let g = Fixture::new();
    r.replacements.insert(
        0,
        (
            g.root
                .path()
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into(),
            "<root>".into(),
        ),
    );
    let mut carrier = g.carrier();
    let request = g.request();
    let mut open = Box::pin(carrier.open(&request));
    let id = tokio::select! { _ = &mut open => panic!("unexpected open"), id = wait_for(async || g.pending().await["entries"][0]["entry_id"].clone(), |v| v.is_string()) => id };
    let late = g.claim(&id).await;
    r.bind(&late, 2);
    drop(open);
    r.send(
        &g,
        &late,
        "cancel_during_open_late_child",
        "dream.child.opened",
        json!({"host_child_id": "late-child"}),
    )
    .await;
    r.send(
        &g,
        &late,
        "late_child_retired",
        "dream.child.cleanup",
        json!({"quiescent": true, "retired": true}),
    )
    .await;
    let (job, next, _) = g.running().await;
    r.bind(&next, 3);
    r.record("fresh_attempt_after_cleanup", json!({"v": 1, "method": "dream.child.claim", "entry_id": next["entry_id"], "claimant_epoch": "epoch-1", "capabilities": capabilities()}), next.clone());
    assert_ne!(
        next["descriptor"]["child_id"],
        late["descriptor"]["child_id"]
    );
    g.clock.0.store(70_001, Ordering::SeqCst);
    r.send(
        &g,
        &next,
        "deadline_expired",
        "dream.child.tool",
        json!({"call_id": "expired", "tool": "ctx_memory", "arguments": {}}),
    )
    .await;
    job.abort();
    let _ = job.await;

    let h = Fixture::new();
    let mut carrier = h.carrier();
    let request = h.request();
    let mut open = Box::pin(carrier.open(&request));
    let id = tokio::select! { _ = &mut open => panic!("unexpected open"), id = wait_for(async || h.pending().await["entries"][0]["entry_id"].clone(), |v| v.is_string()) => id };
    let mut caps = capabilities();
    caps["tokens"] = json!(false);
    let request = json!({"v": 1, "method": "dream.child.claim", "entry_id": id, "claimant_epoch": "epoch-1", "capabilities": caps});
    r.replacements
        .push((id.as_str().unwrap().into(), "<entry-4>".into()));
    r.record(
        "capability_unavailable",
        request.clone(),
        h.call(7, request).await,
    );
    drop(open);
    let vectors = json!({"schema": "dream-claim-v1", "normalization": "Only OS credentials, queue/child ids and throwaway roots are replaced. Cases use v=1 routes; setup and routing channels are described in dream-claim-v1.md.", "cases": r.cases});
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(VECTOR_PATH);
    if std::env::var_os("UPDATE_DREAM_CLAIM_VECTORS").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            format!("{}\n", serde_json::to_string_pretty(&vectors).unwrap()),
        )
        .unwrap();
    }
    let frozen: Value = serde_json::from_slice(
        &std::fs::read(path).expect("generate dream-claim-v1 vectors first"),
    )
    .unwrap();
    assert_eq!(vectors, frozen, "dream-claim-v1 wire drift");
    assert!(vectors["cases"].as_array().unwrap().len() >= 20);
}
