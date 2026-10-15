//! Manual wall-clock gate; the baseline runner executes the same workload at both revisions.
use super::*;
use crate::providers::claude_code_tests as cc;
use std::time::Instant;

fn response(outcome: HandlerOutcome) -> Value {
    let HandlerOutcome::Response(bytes) = outcome else {
        panic!("{outcome:?}")
    };
    serde_json::from_slice(&bytes).unwrap()
}

fn set_tagging(h: &McHandler, key: &Key, enabled: bool) {
    let store = h.store.get().unwrap();
    let mut row = store
        .load_provider_conversation(&key.store_key())
        .unwrap()
        .unwrap();
    let mut counters: Value = serde_json::from_str(&row.hook_counters_json).unwrap();
    counters["auto_tag"] = json!(enabled);
    row.hook_counters_json = counters.to_string();
    store
        .save_provider_conversation(&key.store_key(), &row)
        .unwrap();
}

fn hook(raw: &str, ordinal: u64, kind: &str, blocks: Vec<String>, tool_id: &str) -> Value {
    let mut params = json!({"session":"cc","harness":"claude-code","lineage_id":"L",
        "step_id":format!("step-{ordinal}"),"subject_mid":format!("m{ordinal}"),
        "subject_ordinal":ordinal,"hook":kind,"blocks":blocks,
        "message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw,
        "params":{"serializer_profile":"claude-code-anthropic","observation":"answer"}});
    if ordinal > 0 {
        params["served_through_ordinal"] = json!(ordinal - 1);
    }
    if kind == "post_tool" {
        params["subject_part"] = json!(tool_id);
        params["tool_call_id"] = json!(tool_id);
        params["tool"] = json!("Read");
        params["is_error"] = json!(false);
    }
    params
}

fn distribution(mut samples: Vec<f64>) -> Value {
    assert!(!samples.is_empty());
    samples.sort_by(f64::total_cmp);
    let percentile = |percent: usize| samples[(samples.len() * percent).div_ceil(100) - 1];
    json!({"samples":samples.len(),"p50_ms":percentile(50),"p95_ms":percentile(95),
        "p99_ms":percentile(99),"samples_ms":samples})
}

async fn measure(tagging: bool, first: u64, count: u64) -> Value {
    let dir = tempfile::tempdir().unwrap();
    let root = std::env::var_os("MC_CC_LATENCY_STORE")
        .map(PathBuf::from)
        .unwrap_or_else(|| dir.path().into());
    std::fs::create_dir_all(&root).unwrap();
    let h = cc::handler(&root, cc::thalamus());
    cc::setup(&h).await;
    let binding = h.facade_binding(7).unwrap();
    let key = Key::new(&binding, "cc", "claude-code").unwrap();
    set_tagging(&h, &key, tagging);
    let mut samples = [Vec::new(), Vec::new(), Vec::new()];
    for i in first..first + count {
        let id = format!("call-{i}");
        let user = format!("user {i}");
        let assistant = format!("assistant {i}");
        let output = format!("result {i}");
        let messages = [
            json!({"role":"user","content":user}),
            json!({"role":"assistant","content":[{"type":"text","text":assistant},
                {"type":"tool_use","id":id,"name":"Read","input":{"path":"fixture.txt"}}]}),
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":output}]}),
        ];
        for (index, (kind, text)) in [
            ("pre_user", user),
            ("post_assistant", assistant),
            ("post_tool", output),
        ]
        .into_iter()
        .enumerate()
        {
            let params = hook(
                &messages[index].to_string(),
                i * 3 + index as u64,
                kind,
                vec![text],
                &id,
            );
            let call = serde_json::from_value(params.clone()).unwrap();
            let started = Instant::now();
            let bytes = h
                .provider_claude_code_hook(binding.clone(), key.clone(), &call, &params)
                .await
                .unwrap();
            samples[index].push(started.elapsed().as_secs_f64() * 1000.0);
            let answer: hooks::answer::HookAnswer = serde_json::from_slice(&bytes).unwrap();
            if tagging {
                assert!(matches!(answer, hooks::answer::HookAnswer::Ops { ops } if ops.len() == 1));
            } else {
                assert_eq!(answer, hooks::answer::HookAnswer::Pass);
            }
        }
    }
    let mut report = json!({"tagging":tagging});
    for (kind, values) in ["pre_user", "post_assistant", "post_tool"]
        .into_iter()
        .zip(&samples)
    {
        report[kind] = distribution(values.clone());
    }
    report["all"] = distribution(samples.into_iter().flatten().collect());
    for kind in ["pre_user", "post_assistant", "post_tool", "all"] {
        println!(
            "G9 tagging={tagging} {kind}: n={} p50={} p95={} p99={} ms",
            report[kind]["samples"],
            report[kind]["p50_ms"],
            report[kind]["p95_ms"],
            report[kind]["p99_ms"]
        );
    }
    report
}

#[tokio::test]
#[ignore = "manual Linux latency gate: run crates/mc-module/scripts/admission-gates.py"]
async fn cc_admission_hook_latency() {
    assert_eq!(HOOK_BUDGET_MS, 1500);
    let mode = std::env::var("MC_CC_LATENCY_MODE").expect("run the paired latency script");
    assert!(["baseline", "off", "on"].contains(&mode.as_str()));
    let first = std::env::var("MC_CC_LATENCY_FIRST")
        .unwrap_or_else(|_| "0".into())
        .parse()
        .unwrap();
    let count = std::env::var("MC_CC_LATENCY_COUNT")
        .unwrap_or_else(|_| "200".into())
        .parse()
        .unwrap();
    let report = measure(mode == "on", first, count).await;
    if let Ok(path) = std::env::var("MC_CC_LATENCY_REPORT") {
        std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
}

async fn replay_capture(h: &McHandler, capture: Value) {
    let hooks = capture["hooks"]
        .as_array()
        .expect("capture.hooks must be an array");
    assert!(!hooks.is_empty(), "a capture must contain hooks");
    for (index, entry) in hooks.iter().enumerate() {
        let actual = response(cc::call(h, "transform.hook", entry["params"].clone()).await);
        assert!(
            entry["expected"].is_object(),
            "hook {index} has no expected answer"
        );
        assert_eq!(actual, entry["expected"], "captured hook {index}");
    }
}

#[test]
fn latency_percentiles_use_nearest_rank() {
    let report = distribution((1..=100).rev().map(f64::from).collect());
    assert_eq!(report["samples"], 100);
    assert_eq!(report["p50_ms"], 50.0);
    assert_eq!(report["p95_ms"], 95.0);
    assert_eq!(report["p99_ms"], 99.0);
}

async fn capture_fixture() -> (tempfile::TempDir, McHandler, Value) {
    let dir = tempfile::tempdir().unwrap();
    let h = cc::handler(dir.path(), cc::thalamus());
    cc::setup(&h).await;
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    set_tagging(&h, &key, true);
    let params = hook(
        r#"{"role":"user","content":"hello"}"#,
        0,
        "pre_user",
        vec!["hello".into()],
        "",
    );
    let entry = json!({"params":params,"expected":{"answer":"ops","ops":[{"op":"prepend","block":0,"text":"§1§ "}]}});
    (dir, h, json!({"hooks":[entry.clone(),entry]}))
}

#[tokio::test]
async fn cc_capture_replay_checks_expected_ops_and_retry() {
    let (_dir, h, capture) = capture_fixture().await;
    replay_capture(&h, capture).await;
}

#[tokio::test]
#[should_panic(expected = "captured hook 0")]
async fn cc_capture_replay_refuses_wrong_expected_ops() {
    let (_dir, h, mut capture) = capture_fixture().await;
    capture["hooks"][0]["expected"] = json!({"answer":"pass"});
    replay_capture(&h, capture).await;
}

#[tokio::test]
async fn cc_real_capture_hook_sequence() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let path = std::env::var_os("MC_CC_HOOK_CAPTURE")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("local-ignore/cc-admission-hooks.json"));
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "G8 NOT RUN: missing Claude Code hook capture: {}",
                path.display()
            );
            return;
        }
        Err(error) => panic!("{}: {error}", path.display()),
    };
    let capture: Value = serde_json::from_slice(&bytes).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let h = cc::handler(dir.path(), cc::thalamus());
    cc::setup(&h).await;
    let key = Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap();
    set_tagging(&h, &key, true);
    replay_capture(&h, capture).await;
}
