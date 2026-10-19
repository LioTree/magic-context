//! Byte oracle for the full-request engine and incremental host hook lane.
//! The frozen digest corpus was emitted by the pre-extraction full engine.
use super::*;
use crate::config::CacheTtlProvenance;
use hooks::answer::HookAnswer;

const SEEDS: [u64; 4] = [0x13a5_9910, 0x72be_041f, 0xcafe_8712, 0xd00d_4405];
const PASSES: usize = 24;
fn next(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}
fn message(mid: &str, role: &str, parts: Value, ordinal: u64, completion: bool) -> Value {
    let created = ordinal as i64 * 301_000;
    let mut value = json!({"info":{"id":mid,"role":role,"time":{"created":created}},"parts":parts});
    if completion {
        value["info"]["time"]["completed"] = json!(created + 1_000);
    }
    value
}
fn corpus(seed: u64) -> Vec<Vec<Value>> {
    corpus_inputs(seed, PASSES, "bash")
}
fn corpus_inputs(seed: u64, passes: usize, mixed_tool: &str) -> Vec<Vec<Value>> {
    let mut random = seed;
    let mut ordinal = 1u64;
    (0..passes).map(|pass| {
        let count = if pass < 4 { 3 } else { (next(&mut random) % 3 + 1) as usize };
        (0..count).map(|slot| {
            ordinal += 1;
            let mid = format!("m{ordinal}");
            let choice = if pass < 4 { slot as u64 } else { next(&mut random) % 4 };
            let completed = next(&mut random) & 1 == 1;
            let parts = match choice {
                0 => json!([{"id":format!("{mid}-text"),"type":"text","text":"rust ownership borrowing"}]),
                1 => {
                    let output = if pass < 4 || next(&mut random) & 1 == 1 { "spent payload ".repeat(30_000) } else { "small output".into() };
                    json!([{"id":format!("{mid}-tool"),"type":"tool","tool":"read","callID":format!("call-{mid}"),"state":{"status":"completed","input":{},"output":output}}])
                },
                2 => json!([{"id":format!("{mid}-a"),"type":"text","text":"§99§ response referencing §3§ inline"},{"id":format!("{mid}-tool"),"type":"tool","tool":mixed_tool,"callID":format!("call-{mid}"),"state":{"status":"completed","input":{},"output":"small output"}},{"id":format!("{mid}-b"),"type":"text","text":"café 🦀 continuation"}]),
                _ => json!([{"id":format!("{mid}-a"),"type":"text","text":"first user block"},{"id":format!("{mid}-b"),"type":"text","text":"second user block"}]),
            };
            message(&mid, if choice == 0 || choice == 3 { "user" } else { "assistant" }, parts, ordinal, completed)
        }).collect()
    }).collect()
}
fn fixture(dir: &Path, memory_budget: f64, temporal: bool) -> (McHandler, String) {
    // Production always serves through the resident engine. MC_RESIDENT_HOOKS=0
    // reruns these parity cases against the test-only non-resident oracle.
    let h = super::host_tests::handler(dir).with_startup_provider_resident_enabled(
        std::env::var("MC_RESIDENT_HOOKS").as_deref() != Ok("0"),
    );
    let mut binding = h.facade_binding(7).unwrap();
    binding.history_budget_tokens = 2_000_000.0;
    binding.config.memory_enabled = true;
    binding.config.memory_budget_tokens = memory_budget;
    binding.config.protected_tokens_user = Some(16_000);
    binding.config.temporal_awareness = temporal;
    binding.config.auto_search.min_prompt_chars = 0;
    binding.config.auto_search.score_threshold = 0.0;
    h.bind_route(7, binding.clone());
    let store = h.store.get().unwrap();
    let project = h.route_project(7, store, &binding).unwrap().key;
    for (id, text) in [
        (1, "rust ownership borrowing durable context"),
        (2, "separate archive subject"),
        (3, "unrelated fixture material"),
    ] {
        store
            .seed_memory(id, &project, "CONSTRAINTS", text, 50)
            .unwrap();
    }
    (h, project)
}
fn request(messages: &[Value], search: bool) -> TransformRequest {
    let entries = messages
        .iter()
        .enumerate()
        .map(|(n, m)| codec::InboundMessage {
            raw_message: None,
            ordinal: n as u64 + 1,
            mid: m["info"]["id"].as_str().unwrap().into(),
            message: m.clone(),
        })
        .collect::<Vec<_>>();
    let decoded = super::super::codec_opencode::decode_messages(&entries).unwrap();
    decode(&json!({"v":2,"kind":"transform","session_id":"s","serializer_profile":"opencode-aisdk","render_config":"parity","messages":decoded.messages,"tool_present":true,"auto_search_enabled":search,"auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0,"geometry":{"usable_soft":4000000,"usable_hard":6000000,"absolute_wall":8000000,"derivation":"parity"}})).unwrap()
}
fn context<'a>(
    project: &'a str,
    memory_budget: f64,
    temporal: bool,
    now: i64,
) -> transform::ProducerContext<'a> {
    transform::ProducerContext {
        project_path: project,
        note_project_path: project,
        project_directory: "/nonexistent-docs",
        history_budget_tokens: 2_000_000.0,
        memory_budget_tokens: memory_budget,
        user_profile_budget_tokens: 0.0,
        memory_enabled: true,
        inject_docs: false,
        temporal_awareness: temporal,
        now_ms: now,
        execute_threshold_percentage: 80.0,
        protected_tokens_floor: 16_000,
        protected_tokens_provenance: "absolute",
        compaction_enabled: true,
        signed_thinking_hold: crate::config::SignedThinkingHold::Off,
        smart_drops: false,
        protected_tools: Default::default(),
        cache_ttl: "never".into(),
        cache_ttl_provenance: CacheTtlProvenance::Default,
        cache_ttl_policy: None,
        model_key: None,
        observed_last_response_at_ms: None,
        guidance_date: None,
        historian_active: false,
        wrapup_active: false,
        caveman_english_word_rules: true,
        injected_reductions: vec![],
    }
}
fn scalars(
    response: &transform::TransformResponse,
    mids: &BTreeSet<String>,
) -> BTreeMap<String, Vec<(usize, String)>> {
    response
        .messages()
        .iter()
        .filter_map(|m| {
            let mid = m.meta.harness_id.as_ref()?;
            if !mids.contains(mid) {
                return None;
            }
            let values = m
                .content
                .iter()
                .enumerate()
                .filter_map(|(i, b)| match &b.kind {
                    mc_store::CkKind::Text { text } => Some((i, text.clone())),
                    mc_store::CkKind::ToolResult { output, .. } => match &output.kind {
                        mc_store::CkOutputKind::Text { text }
                        | mc_store::CkOutputKind::ErrorText { text } => Some((i, text.clone())),
                        _ => None,
                    },
                    _ => None,
                })
                .collect();
            Some((mid.clone(), values))
        })
        .collect()
}
fn digest(values: &BTreeMap<String, Vec<(usize, String)>>) -> String {
    sha256_hex(&serde_json::to_vec(values).unwrap())
}
fn baseline() -> Value {
    message(
        "m1",
        "user",
        json!([{"id":"base-text","type":"text","text":"baseline"}]),
        1,
        false,
    )
}
fn full_corpus(seed: u64) -> Vec<String> {
    let dir = tempfile::tempdir().unwrap();
    let budget = if seed & 1 == 1 { 8000.0 } else { 0.0 };
    let temporal = seed & 2 != 0;
    let (h, project) = fixture(dir.path(), budget, temporal);
    let store = h.store.get().unwrap();
    let mut raw = vec![baseline()];
    for _ in 0..2 {
        transform::transform(
            store,
            &request(&raw, false),
            &context(&project, budget, temporal, 1),
        )
        .unwrap();
    }
    let mut out = Vec::new();
    for (pass, appended) in corpus(seed).into_iter().enumerate() {
        raw.extend(appended);
        let search = pass % 3 != 0;
        let req = request(&raw, search);
        let response = transform::transform(
            store,
            &req,
            &context(&project, budget, temporal, pass as i64 + 2),
        )
        .unwrap();
        let mids = raw
            .iter()
            .map(|m| m["info"]["id"].as_str().unwrap().to_owned())
            .collect();
        out.push(digest(&scalars(&response, &mids)));
    }
    out
}

#[test]
#[ignore = "explicit pre-extraction corpus generator"]
fn emit_pre_extraction_reference() {
    let path = std::env::var("MC_PROVIDER_PARITY_CAPTURE")
        .expect("set a worktree-local fixture destination");
    let values = SEEDS
        .iter()
        .map(|seed| (seed.to_string(), full_corpus(*seed)))
        .collect::<BTreeMap<_, _>>();
    std::fs::write(path, serde_json::to_vec_pretty(&values).unwrap()).unwrap();
    println!(
        "REFERENCE_CORPUS={}",
        serde_json::to_string(&values).unwrap()
    );
    println!(
        "captured {} seeds, {} passes",
        SEEDS.len(),
        SEEDS.len() * PASSES
    );
}

async fn host_message(h: &McHandler, raw: &Value, ordinal: u64, served: u64) -> Value {
    let mut result = raw.clone();
    let parts = raw["parts"].as_array().unwrap();
    let texts = parts
        .iter()
        .filter(|p| p["type"] == "text")
        .collect::<Vec<_>>();
    let mut subjects = Vec::new();
    if !texts.is_empty() {
        subjects.push((
            if raw["info"]["role"] == "user" {
                "pre_user"
            } else {
                "post_assistant"
            },
            None,
            texts
                .iter()
                .map(|p| p["text"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>(),
        ));
    }
    for p in parts.iter().filter(|p| p["type"] == "tool") {
        subjects.push((
            "post_tool",
            Some(p),
            vec![p["state"]["output"].as_str().unwrap().to_owned()],
        ));
    }
    for (kind, tool, blocks) in subjects {
        let mut call = json!({"session":"s","harness":"opencode","params":{"serializer_profile":"opencode-aisdk","observation":"answer","auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0},"lineage_id":"L","subject_mid":raw["info"]["id"],"subject_ordinal":ordinal,"message":raw,"hook":kind,"step_id":"parity","blocks":blocks,"served_through_ordinal":served});
        if let Some(p) = tool {
            call["subject_part"] = p["id"].clone();
            call["tool"] = p["tool"].clone();
            call["tool_call_id"] = p["callID"].clone();
            call["is_error"] = json!(false);
        }
        let mut outcome = super::host_tests::dispatch(h, 7, "transform.hook", call.clone()).await;
        // A cold resident rebuild that overruns the hook budget publishes its
        // state and refuses retryably before recording the hook; hosts retry it.
        // Loaded test machines can hit that budget, so retry exactly that refusal.
        if matches!(&outcome, HandlerOutcome::Error { code, message }
            if code == "transient" && message.starts_with("resident_not_ready: rebuild completed"))
        {
            outcome = super::host_tests::dispatch(h, 7, "transform.hook", call.clone()).await;
        }
        let answer: HookAnswer = decode(&super::host_tests::response(outcome)).unwrap();
        let rendered = match answer {
            HookAnswer::Pass => blocks.clone(),
            HookAnswer::Ops { ops } => hooks::answer::apply_ops(&blocks, &ops).unwrap(),
            _ => panic!("text answer"),
        };
        if let Some(p) = tool {
            let part = result["parts"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|r| r["id"] == p["id"])
                .unwrap();
            part["state"]["output"] = json!(rendered[0]);
        } else {
            for (i, p) in result["parts"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .filter(|p| p["type"] == "text")
                .enumerate()
            {
                p["text"] = json!(rendered[i]);
            }
        }
    }
    result
}

async fn drive_overlay_corpus(queued: bool, calibrated: bool) {
    drive_overlay_corpus_with(
        queued,
        calibrated,
        &CorpusRun {
            seeds: &SEEDS,
            passes: PASSES,
            mixed_tool: "bash",
            frozen_reference: true,
            real_reduce: false,
        },
    )
    .await;
}

struct CorpusRun {
    seeds: &'static [u64],
    passes: usize,
    mixed_tool: &'static str,
    frozen_reference: bool,
    real_reduce: bool,
}

#[derive(Default)]
struct CorpusCounts {
    passes: usize,
    comparisons: usize,
}

async fn drive_overlay_corpus_with(
    queued: bool,
    calibrated: bool,
    run: &CorpusRun,
) -> CorpusCounts {
    let frozen: BTreeMap<String, Vec<String>> = serde_json::from_str(include_str!(
        "../../testdata/provider-overlay-reference.json"
    ))
    .unwrap();
    let mut counts = CorpusCounts::default();
    for &seed in run.seeds {
        let host_dir = tempfile::tempdir().unwrap();
        let full_dir = tempfile::tempdir().unwrap();
        let budget = if seed & 1 == 1 { 8000.0 } else { 0.0 };
        let temporal = seed & 2 != 0;
        let (host, host_project) = fixture(host_dir.path(), budget, temporal);
        let (full, full_project) = fixture(full_dir.path(), budget, temporal);
        let plan = json!({"serializer_profile":"opencode-aisdk","observation":"answer","auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0});
        super::host_tests::response(
            super::host_tests::dispatch(&host, 7, "transform.declare", json!({"params":plan}))
                .await,
        );
        let request_for = |messages: &[Value], search: bool| {
            let mut req = request(messages, search);
            if calibrated {
                req.model_key = Some("anthropic/claude-fable-5-1".into());
            }
            req
        };
        let mut raw = vec![baseline()];
        let mut served_native = raw.clone();
        // Save pending numbers when each message's hook output is produced: we
        // compare it again after newer hooks may have confirmed its delivery.
        let mut pending_by_mid = BTreeMap::new();
        for _ in 0..2 {
            transform::transform(
                full.store.get().unwrap(),
                &request_for(&raw, false),
                &context(&full_project, budget, temporal, 1),
            )
            .unwrap();
            transform::transform(
                host.store.get().unwrap(),
                &request_for(&raw, false),
                &context(&host_project, budget, temporal, 1),
            )
            .unwrap();
        }
        served_native[0]["parts"][0]["text"] = json!("§1§ baseline");
        for (pass, appended) in corpus_inputs(seed, run.passes, run.mixed_tool)
            .into_iter()
            .enumerate()
        {
            let prior = raw.len() as u64;
            let search = pass % 3 != 0;
            if queued && (pass == 6 || pass == 13) {
                let (number, block) = if pass == 6 { (3, "m3#1") } else { (4, "m4#0") };
                full.store
                    .get()
                    .unwrap()
                    .append_pending_agent_drops("s", &[block.into()], pass as i64 + 2)
                    .unwrap();
                let mut meta = full.store.get().unwrap().load_meta("s").unwrap();
                meta.meta.channel1_reduce_suppressed = true;
                full.store
                    .get()
                    .unwrap()
                    .commit_meta("s", meta.row_version, &meta.meta)
                    .unwrap();
                let key = super::host_tests::key(&host);
                if run.real_reduce {
                    let reduced = super::host_tests::response(
                        host.provider_host_reduce(key, &[number as u64])
                            .await
                            .unwrap(),
                    );
                    assert_eq!(reduced["isError"], false, "real provider reduce control");
                } else {
                    host.store
                        .get()
                        .unwrap()
                        .queue_provider_drops(&key.store_key(), &[number])
                        .unwrap();
                }
            }
            let mut binding = host.facade_binding(7).unwrap();
            binding.config.auto_search.enabled = search;
            host.bind_route(7, binding);
            let entries = appended
                .iter()
                .enumerate()
                .map(|(n, m)| json!({"mid":m["info"]["id"],"ordinal":prior+n as u64+1,"message":m}))
                .collect::<Vec<_>>();
            let tail = entries.last().unwrap();
            super::host_tests::response(host.dispatch_value(7,json!({"method":"state_sync","session_id":"s","provider_pass":{"pass_id":format!("{seed}-{pass}"),"lineage_id":"L","appended":entries,"physical_tail":{"mid":tail["mid"],"ordinal":tail["ordinal"]}}})).await);
            for (n, m) in appended.iter().enumerate() {
                served_native.push(host_message(&host, m, prior + n as u64 + 1, prior).await);
                pending_by_mid.insert(
                    m["info"]["id"].as_str().unwrap().to_owned(),
                    super::host_tests::pending_hint_numbers(&host),
                );
            }
            raw.extend(appended);
            let current_request = request_for(&raw, search);
            let expected = transform::transform(
                full.store.get().unwrap(),
                &current_request,
                &context(&full_project, budget, temporal, pass as i64 + 2),
            )
            .unwrap();
            let mids = raw
                .iter()
                .map(|m| m["info"]["id"].as_str().unwrap().to_owned())
                .collect::<BTreeSet<_>>();
            let expected = scalars(&expected, &mids);
            let served_entries = served_native
                .iter()
                .enumerate()
                .map(|(n, m)| codec::InboundMessage {
                    raw_message: None,
                    mid: m["info"]["id"].as_str().unwrap().into(),
                    ordinal: n as u64 + 1,
                    message: m.clone(),
                })
                .collect::<Vec<_>>();
            let decoded = super::super::codec_opencode::decode_messages(&served_entries).unwrap();
            for message in decoded.messages {
                let actual = message
                    .ck
                    .content
                    .iter()
                    .enumerate()
                    .filter_map(|(i, b)| match &b.kind {
                        mc_store::CkKind::Text { text } => Some((i, text.clone())),
                        mc_store::CkKind::ToolResult { output, .. } => match &output.kind {
                            mc_store::CkOutputKind::Text { text } => Some((i, text.clone())),
                            _ => None,
                        },
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                let no_pending = BTreeSet::new();
                let pending_numbers = pending_by_mid.get(&message.mid).unwrap_or(&no_pending);
                let without_hints = |values: &[(usize, String)]| {
                    values
                        .iter()
                        .map(|(index, text)| {
                            (
                                *index,
                                super::host_tests::without_delivery_dependent_hint(
                                    text,
                                    pending_numbers,
                                ),
                            )
                        })
                        .collect::<Vec<_>>()
                };
                assert!(without_hints(&actual)==without_hints(&expected[&message.mid]),"seed={seed:x} pass={pass} mid={} actual prefixes={:?} expected prefixes={:?} actual suffixes={:?} expected suffixes={:?}",message.mid,actual.iter().map(|(_,s)|s.chars().take(100).collect::<String>()).collect::<Vec<_>>(),expected[&message.mid].iter().map(|(_,s)|s.chars().take(100).collect::<String>()).collect::<Vec<_>>(),actual.iter().map(|(_,s)|s.chars().rev().take(180).collect::<String>()).collect::<Vec<_>>(),expected[&message.mid].iter().map(|(_,s)|s.chars().rev().take(180).collect::<String>()).collect::<Vec<_>>());
                counts.comparisons += 1;
            }
            if run.frozen_reference && !queued && !calibrated {
                assert_eq!(
                    digest(&expected),
                    frozen[&seed.to_string()][pass],
                    "full engine changed after pure extraction: seed={seed:x} pass={pass}"
                );
            }
            counts.passes += 1;
        }
    }
    println!("overlay parity: queued={queued}, calibrated={calibrated}, {} seeds {:?}, {} passes, {} per-message byte comparisons",run.seeds.len(),run.seeds,counts.passes,counts.comparisons);
    counts
}

#[tokio::test]
async fn randomized_host_overlay_matches_full_engine_except_delivery_dependent_hints_and_keeps_frozen_corpus(
) {
    drive_overlay_corpus(false, false).await;
}

#[tokio::test]
async fn queued_tool_and_sibling_text_releases_match_full_engine_grace_except_delivery_dependent_hints(
) {
    drive_overlay_corpus(true, false).await;
}

// A late HARD replacement must render the temporal marker withheld by hooks on
// non-HARD passes. Extending the covered range alone cannot supply those bytes.
#[test]
fn late_hard_view_covers_new_users_and_renders_full_engine_temporal_marker() {
    use transform::compaction::{Answer, Preset, State, Status};
    let late_dir = tempfile::tempdir().unwrap();
    let full_dir = tempfile::tempdir().unwrap();
    let (late, late_project) = fixture(late_dir.path(), 0.0, true);
    let (full, full_project) = fixture(full_dir.path(), 0.0, true);
    let first = baseline();
    let second = message(
        "m2",
        "user",
        json!([{"id":"u-text","type":"text","text":"second"}]),
        2,
        false,
    );
    let mut state = State::new("late-hard".into(), Preset::Head);
    let mut status = Status {
        lineage_id: "L".into(),
        newest_ordinal: Some(1),
        previous_usage: None,
        request_tokens: 1000,
        context_window: 6_000_000,
        prefix_rebuilding: false,
        pipeline_switch: false,
        last_applied_version: None,
        last_not_applied: None,
    };
    let mut setup_template = request(std::slice::from_ref(&first), false);
    setup_template.kind = "compaction.host".into();
    transform::compaction::setup(
        late.store.get().unwrap(),
        &setup_template,
        &context(&late_project, 0.0, true, 1),
        &status,
        &mut state,
    )
    .unwrap();
    for _ in 0..2 {
        transform::transform(
            full.store.get().unwrap(),
            &request(std::slice::from_ref(&first), false),
            &context(&full_project, 0.0, true, 1),
        )
        .unwrap();
    }
    let mut full_request = request(&[first.clone(), second.clone()], false);
    full_request.render_config = "forced-hard".into();
    let expected = transform::transform(
        full.store.get().unwrap(),
        &full_request,
        &context(&full_project, 0.0, true, 2),
    )
    .unwrap();
    let expected = scalars(&expected, &BTreeSet::from(["m2".to_owned()]));
    assert!(
        expected["m2"][0].1.contains("<!-- +5m -->"),
        "full HARD positive control"
    );
    status.newest_ordinal = Some(2);
    status.prefix_rebuilding = true;
    let mut late_template = request(&[first, second], false);
    late_template.kind = "compaction.host".into();
    let output = transform::compaction::step(
        late.store.get().unwrap(),
        &late_template,
        &context(&late_project, 0.0, true, 2),
        &status,
        &mut state,
    )
    .unwrap();
    let Answer::Replacement(view) = output.answer else {
        panic!("late HARD must produce a view")
    };
    assert!(view.range.to > 2, "view covers the newest tail");
    let value = view
        .replacement
        .iter()
        .find(|m| m.meta.harness_id.as_deref() == Some("m2"))
        .unwrap();
    let mc_store::CkKind::Text { text } = &value.content[0].kind else {
        panic!("user text")
    };
    assert!(
        text.contains("<!-- +5m -->"),
        "M4 late-HARD temporal overlay is missing from its covering view"
    );
}

#[tokio::test]
async fn admitted_pass_followed_by_hook_timeout_has_no_phantom_tag_or_cadence() {
    let dir = tempfile::tempdir().unwrap();
    let (h, _) = fixture(dir.path(), 0.0, false);
    super::host_tests::response(super::host_tests::dispatch(&h,7,"transform.declare",json!({"params":{"serializer_profile":"opencode-aisdk","observation":"answer","auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0}})).await);
    let abandoned = message(
        "a",
        "assistant",
        json!([{"id":"a-part","type":"tool","tool":"read","callID":"a-call","state":{"status":"completed","input":{},"output":"spent payload ".repeat(30000)}}]),
        1,
        false,
    );
    super::host_tests::sync_pass(&h, &[(1, abandoned)]).await;
    // The host deadline prevented a hook answer; only admission reached the module.
    let next = message(
        "b",
        "assistant",
        json!([{"id":"b-part","type":"tool","tool":"read","callID":"b-call","state":{"status":"completed","input":{},"output":"next"}}]),
        2,
        false,
    );
    super::host_tests::sync_pass(&h, &[(2, next.clone())]).await;
    let served = host_message(&h, &next, 2, 1).await;
    assert!(!served["parts"][0]["state"]["output"]
        .as_str()
        .unwrap()
        .contains("system-reminder"));
    let third = message(
        "u",
        "user",
        json!([{"id":"u-text","type":"text","text":"next"}]),
        3,
        false,
    );
    super::host_tests::sync_pass(&h, &[(3, third.clone())]).await;
    host_message(&h, &third, 3, 2).await;
    let tags = h.store.get().unwrap().load_tags_for_session("s").unwrap();
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0].tag_number, 2);
    assert_eq!(tags[0].block_id, "b#1");
    assert!(!h
        .store
        .get()
        .unwrap()
        .provider_answer_tag_known(&super::host_tests::key(&h).store_key(), 1)
        .unwrap());
}

#[tokio::test]
async fn pass_ingest_is_once_and_changed_hook_ingest_refuses_by_message_name() {
    let dir = tempfile::tempdir().unwrap();
    let (h, _) = fixture(dir.path(), 0.0, false);
    super::host_tests::admit(&h, 7).await;
    let raw = message(
        "u",
        "user",
        json!([{"id":"text","type":"text","text":"one"}]),
        1,
        false,
    );
    super::host_tests::sync_pass(&h, &[(1, raw.clone())]).await;
    let mut changed = raw.clone();
    changed["parts"][0]["text"] = json!("different");
    let call = super::host_tests::hook("u", 1, "pre_user", &["different"], changed);
    assert!(
        matches!(super::host_tests::dispatch(&h,7,"transform.hook",call).await,HandlerOutcome::ErrorWithDetail {ref detail,..} if detail["field"]=="message")
    );
    let call = super::host_tests::hook("u", 1, "pre_user", &["one"], raw);
    super::host_tests::response(super::host_tests::dispatch(&h, 7, "transform.hook", call).await);
    assert_eq!(
        h.store
            .get()
            .unwrap()
            .load_provider_messages(&super::host_tests::key(&h).store_key(), "L")
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn frozen_non_neutral_calibration_matches_full_engine_policy_corpus() {
    let calibration = crate::decision_calibration::DecisionCalibration::for_model(Some(
        "anthropic/claude-fable-5-1",
    ));
    assert!(calibration.seeded && calibration.tools_ratio != 1.0 && calibration.prose_ratio != 1.0);
    drive_overlay_corpus(false, true).await;
}

#[test]
fn frozen_reductions_coverage_and_calibration_reuse_the_engine_measurement() {
    let values=(1..=4).map(|n|message(&format!("t{n}"),"assistant",json!([{"id":format!("p{n}"),"type":"tool","callID":format!("c{n}"),"tool":"read","state":{"status":"completed","input":{},"output":"spent payload ".repeat(30000)}}]),n,false)).chain(std::iter::once(message("u","user",json!([{"id":"text","type":"text","text":"authored text"}]),5,false))).collect::<Vec<_>>();
    let req = request(&values, false);
    let projection = ck_wire::project_messages(&req.messages).unwrap();
    let tags = projection
        .blocks
        .iter()
        .filter_map(|b| {
            transform::taggable_source(b).map(|(kind, source)| McTagRow {
                tag_number: b.ordinal as i64,
                block_id: b.id.clone(),
                kind: kind.as_store_kind().into(),
                token_count: mc_tokenizer::estimate_tokens(&source) as i64,
                created_at_ms: 1,
                source_bytes: Arc::from([]),
            })
        })
        .collect::<Vec<_>>();
    let frozen = crate::decision_calibration::DecisionCalibration::freeze_for_model(Some(
        "anthropic/claude-fable-5-1",
    ));
    let calibration =
        crate::decision_calibration::DecisionCalibration::from_frozen(&frozen).unwrap();
    let window = crate::protection_window::ProtectionWindow::from_persisted_rows_calibrated(
        &tags,
        16000,
        calibration.tools_ratio,
    );
    let mut core = mc_core::CoreState::default();
    core.frozen_units.push(mc_core::FrozenUnit {
        key: "red:t3#1".into(),
        kind: "red".into(),
        frozen_payload: "drop".into(),
        durability_class: mc_core::DurabilityClass::Lineage,
        reset_rule: String::new(),
    });
    let measured = crate::tail_hygiene::measure_tail_hygiene_with_pending_drops(
        &projection,
        &core,
        Some(2),
        &tags,
        &window.tag_numbers,
        &Default::default(),
        &Default::default(),
    );
    let expected = crate::tail_hygiene::refresh_tail_hygiene_baseline_calibrated(
        measured.clone(),
        true,
        None,
        1,
        crate::tail_hygiene::HygieneCalibration {
            units_version: 2,
            tools_ratio: calibration.tools_ratio,
            prose_ratio: calibration.prose_ratio,
        },
    )
    .baseline;
    let parts =
        transform::capture_provider_parts(&req, &projection, &core, &measured.parts, &tags, true);
    let meta = mc_store::ModuleMeta {
        coverage_ordinal: Some(2),
        decision_calibration: Some(frozen),
        protected_tokens_effective: Some(16000),
        tail_hygiene_baseline: Some(expected.clone()),
        ..Default::default()
    };
    let actual = transform::channel1_inputs_from_parts(
        &parts,
        &transform::provider_engine_settings(&meta),
        16000,
        &Default::default(),
        true,
        false,
        None,
    );
    assert_eq!(
        crate::tail_hygiene::effective_tail_hygiene(&actual.baseline),
        crate::tail_hygiene::effective_tail_hygiene(&expected)
    );
    assert_eq!(
        actual.tool_outputs,
        transform::reclaimable_tool_output_count(Some(&expected))
    );
    assert_eq!(
        actual.baseline.effective_token_buckets,
        expected.effective_token_buckets
    );
}

async fn alf_shaped_policy_fixture() -> (tempfile::TempDir, McHandler) {
    let dir = tempfile::tempdir().unwrap();
    let (h, _) = fixture(dir.path(), 0.0, false);
    super::host_tests::response(super::host_tests::dispatch(&h,7,"transform.declare",json!({"params":{"serializer_profile":"opencode-aisdk","observation":"answer","auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0}})).await);
    let sample = message(
        "sample",
        "assistant",
        json!([{"id":"a","type":"text","text":"cached assistant text"},{"id":"r","type":"tool","tool":"read","callID":"r","state":{"status":"completed","input":{},"output":"cached output ".repeat(20)}},{"id":"b","type":"tool","tool":"bash","callID":"b","state":{"status":"completed","input":{},"output":"cached output ".repeat(20)}},{"id":"c","type":"tool","tool":"read","callID":"c","state":{"status":"completed","input":{},"output":"cached output ".repeat(20)}},{"id":"z","type":"text","text":"cached final text"}]),
        1,
        true,
    );
    let req = request(std::slice::from_ref(&sample), false);
    let projection = ck_wire::project_messages(&req.messages).unwrap();
    let template = super::admission_policy_parts(&req, &projection);
    assert_eq!(template.len(), 9);
    let mut messages = Vec::new();
    let mut parts = Vec::new();
    for n in 1..=5560u64 {
        let mid = format!("cached-{n}");
        let mut native = sample.clone();
        native["info"]["id"] = json!(mid);
        messages.push(ProviderMessage {
            mid: mid.clone(),
            ordinal: n,
            message_bytes: serde_json::to_vec(&native).unwrap(),
        });
        for p in &template {
            let mut p = p.clone();
            p.mid = mid.clone();
            p.ordinal = n;
            p.block_id = p.block_id.replace("sample#", &format!("{mid}#"));
            p.measurement.key = p.measurement.key.replace("sample#", &format!("{mid}#"));
            p.arc_id = p.arc_id.map(|a| a.replace("sample#", &format!("{mid}#")));
            p.served = true;
            parts.push(p);
        }
    }
    let lineage = ProviderLineage {
        lineage_id: "L".into(),
        first_ordinal: 1,
        descends_from: None,
        through_ordinal: None,
    };
    h.store
        .get()
        .unwrap()
        .admit_provider_pass(
            &super::host_tests::key(&h).store_key(),
            &lineage,
            &messages,
            &parts,
            &json!({"pass_id":"bootstrap","lineage_id":"L","appended_ids":[]}),
        )
        .unwrap();
    (dir, h)
}

#[tokio::test]
#[ignore = "manual correctness-stage walk measurement; performance/enablement gate remains closed"]
async fn measure_alf_sized_full_metadata_walk_per_hook_and_three_hook_pass() {
    let (_dir, h) = alf_shaped_policy_fixture().await;
    let mut samples = Vec::new();
    let mut passes = Vec::new();
    for pass in 0..2u64 {
        let raw = (0..3)
            .map(|slot| {
                let ordinal = 5561 + pass * 3 + slot;
                message(
                    &format!("measure-{ordinal}"),
                    "user",
                    json!([{"id":"text","type":"text","text":"new user"}]),
                    ordinal,
                    false,
                )
            })
            .collect::<Vec<_>>();
        super::host_tests::sync_pass(
            &h,
            &raw.iter()
                .enumerate()
                .map(|(i, m)| (5561 + pass * 3 + i as u64, m.clone()))
                .collect::<Vec<_>>(),
        )
        .await;
        let start = Instant::now();
        for (i, m) in raw.iter().enumerate() {
            let hook = Instant::now();
            host_message(&h, m, 5561 + pass * 3 + i as u64, 5560 + pass * 3).await;
            samples.push(hook.elapsed().as_secs_f64() * 1000.0);
        }
        passes.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    println!("ALF policy walk: parts=50040 hooks=6 per_hook_ms={samples:?} three_hook_pass_ms={passes:?}");
    assert_eq!(samples.len(), 6);
}

#[tokio::test]
async fn bounded_policy_summary_does_not_return_the_entire_known_metadata_lineage() {
    let (_dir, h) = alf_shaped_policy_fixture().await;
    let store = h.store.get().unwrap();
    let key = super::host_tests::key(&h);
    let lineage = store
        .load_provider_lineage(&key.store_key(), "L")
        .unwrap()
        .unwrap();
    store
        .commit_provider_hook(
            &key.store_key(),
            ProviderHookRequest {
                lineage: &lineage,
                message: None,
                served_through_ordinal: None,
                unserved_subjects: &[],
                repeat_subject: None,
            },
            |ctx| {
                assert!(
                    ctx.parts.len() <= 2048,
                    "bounded-summary gate: returned {} retained metadata parts",
                    ctx.parts.len()
                );
                Ok((
                    ProviderHookWrite {
                        answer: None,
                        counters: ctx.counters.clone(),
                        policy_summary: None,
                    },
                    (),
                ))
            },
        )
        .unwrap();
}

/// A provider lineage of `count` admitted messages: four one-text messages
/// for every assistant carrying text and two completed tool parts.
async fn sized_policy_fixture(count: u64) -> (tempfile::TempDir, McHandler) {
    let dir = tempfile::tempdir().unwrap();
    let (h, _) = fixture(dir.path(), 0.0, false);
    super::host_tests::response(super::host_tests::dispatch(&h,7,"transform.declare",json!({"params":{"serializer_profile":"opencode-aisdk","observation":"answer","auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0}})).await);
    let tool = message(
        "tool",
        "assistant",
        json!([{"id":"a","type":"text","text":"assistant text"},{"id":"r","type":"tool","tool":"read","callID":"r","state":{"status":"completed","input":{},"output":"cached output ".repeat(40)}},{"id":"b","type":"tool","tool":"bash","callID":"b","state":{"status":"completed","input":{},"output":"cached output ".repeat(40)}}]),
        1,
        true,
    );
    let text = message(
        "text",
        "user",
        json!([{"id":"t","type":"text","text":"user text"}]),
        1,
        true,
    );
    let template = |sample: &Value| {
        let req = request(std::slice::from_ref(sample), false);
        let projection = ck_wire::project_messages(&req.messages).unwrap();
        super::admission_policy_parts(&req, &projection)
    };
    let templates = [
        (text.clone(), template(&text)),
        (tool.clone(), template(&tool)),
    ];
    let lineage = ProviderLineage {
        lineage_id: "L".into(),
        first_ordinal: 1,
        descends_from: None,
        through_ordinal: None,
    };
    let store = h.store.get().unwrap();
    let key = super::host_tests::key(&h).store_key();
    for chunk in (1..=count).collect::<Vec<_>>().chunks(2_000) {
        let mut messages = Vec::new();
        let mut parts = Vec::new();
        for &n in chunk {
            let (sample, template) = &templates[usize::from(n % 5 == 0)];
            let sample_mid = sample["info"]["id"].as_str().unwrap();
            let mid = format!("sized-{n}");
            let mut native = sample.clone();
            native["info"]["id"] = json!(mid);
            messages.push(ProviderMessage {
                mid: mid.clone(),
                ordinal: n,
                message_bytes: serde_json::to_vec(&native).unwrap(),
            });
            for p in template {
                let mut p = p.clone();
                let from = format!("{sample_mid}#");
                let to = format!("{mid}#");
                p.mid = mid.clone();
                p.ordinal = n;
                p.block_id = p.block_id.replace(&from, &to);
                p.measurement.key = p.measurement.key.replace(&from, &to);
                p.arc_id = p.arc_id.map(|a| a.replace(&from, &to));
                p.served = true;
                parts.push(p);
            }
        }
        store
            .admit_provider_pass(
                &key,
                &lineage,
                &messages,
                &parts,
                &json!({"pass_id":format!("seed-{}",chunk[0]),"lineage_id":"L","appended_ids":[]}),
            )
            .unwrap();
    }
    (dir, h)
}

/// An ordinary hook replays the policy changes since the stored summary instead
/// of rereading the lineage, so its store work must not grow with the session.
/// SQLite virtual-machine steps count every row the hook reads or writes; the
/// first hook after seeding rebuilds the summary and shows the counter sees a
/// whole-lineage read.
#[tokio::test]
async fn ordinary_hook_store_reads_do_not_grow_with_the_session() {
    let mut rebuild = Vec::new();
    let mut ordinary = Vec::new();
    for size in [1_000u64, 17_000] {
        let (_dir, h) = sized_policy_fixture(size).await;
        let store = h.store.get().unwrap();
        let _measured = super::super::policy_summary::without_full_check();
        let mut steps = Vec::new();
        for pass in 0..4u64 {
            let ordinal = size + 1 + pass * 2;
            let user = message(
                &format!("next-user-{ordinal}"),
                "user",
                json!([{"id":"text","type":"text","text":"new user"}]),
                ordinal,
                false,
            );
            let reply = message(
                &format!("next-reply-{}", ordinal + 1),
                "assistant",
                json!([{"id":"a","type":"text","text":"reply"},{"id":"r","type":"tool","tool":"read","callID":"r","state":{"status":"completed","input":{},"output":"fresh output ".repeat(40)}}]),
                ordinal + 1,
                true,
            );
            for (raw, at) in [(user, ordinal), (reply, ordinal + 1)] {
                store.start_sqlite_step_count();
                host_message(&h, &raw, at, at - 1).await;
                steps.push(store.take_sqlite_step_count());
            }
        }
        rebuild.push(steps[0]);
        ordinary.push(*steps[1..].iter().max().unwrap());
    }
    println!("policy hook SQLite steps: rebuild={rebuild:?} worst ordinary={ordinary:?}");
    // The rebuild reads every part, so it scales with the session ...
    assert!(rebuild[1] > rebuild[0] * 8, "rebuild steps {rebuild:?}");
    // ... while an ordinary hook's work is the same at 1k and 17k messages.
    assert!(
        ordinary[1] <= ordinary[0] + ordinary[0] / 4,
        "ordinary hook steps grew with the session: {ordinary:?}"
    );
    assert!(
        ordinary[1] * 20 < rebuild[1],
        "ordinary {ordinary:?} rebuild {rebuild:?}"
    );
}

#[tokio::test]
async fn no_exact_plan_is_defer_even_if_a_preflight_candidate_claims_hard() {
    let hdir = tempfile::tempdir().unwrap();
    let fdir = tempfile::tempdir().unwrap();
    let (h, hproject) = fixture(hdir.path(), 0.0, true);
    let (full, fproject) = fixture(fdir.path(), 0.0, true);
    let plan = json!({"serializer_profile":"opencode-aisdk","observation":"answer","auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0});
    super::host_tests::response(
        super::host_tests::dispatch(&h, 7, "transform.declare", json!({"params":plan})).await,
    );
    for _ in 0..2 {
        transform::transform(
            h.store.get().unwrap(),
            &request(&[baseline()], false),
            &context(&hproject, 0.0, true, 1),
        )
        .unwrap();
        transform::transform(
            full.store.get().unwrap(),
            &request(&[baseline()], false),
            &context(&fproject, 0.0, true, 1),
        )
        .unwrap();
    }
    let raw = message(
        "m2",
        "user",
        json!([{"id":"text","type":"text","text":"second"}]),
        2,
        false,
    );
    super::host_tests::response(h.dispatch_value(7,json!({"method":"state_sync","session_id":"s","provider_pass":{"pass_id":"no-plan","lineage_id":"L","appended":[{"mid":"m2","ordinal":2,"message":raw}],"physical_tail":{"mid":"m2","ordinal":2},"prefix_mutation_permitted":true,"preflight_candidate":"hard","skip_facts":{"hard":true}}})).await);
    let actual = host_message(&h, &raw, 2, 1).await;
    let expected = transform::transform(
        full.store.get().unwrap(),
        &request(&[baseline(), raw], false),
        &context(&fproject, 0.0, true, 2),
    )
    .unwrap();
    let expected = scalars(&expected, &BTreeSet::from(["m2".into()]));
    assert!(!expected["m2"][0].1.contains("<!--"));
    assert_eq!(
        actual["parts"][0]["text"].as_str().unwrap(),
        expected["m2"][0].1
    );
}

async fn exact_hard_model_case(
    old: Option<&str>,
    new: Option<&str>,
    tools: &[&str],
    repeats: usize,
    temporal: bool,
) -> (usize, usize) {
    let hd = tempfile::tempdir().unwrap();
    let fd = tempfile::tempdir().unwrap();
    let (host, hp) = fixture(hd.path(), 0.0, temporal);
    let (full, fp) = fixture(fd.path(), 0.0, temporal);
    let plan = json!({"serializer_profile":"opencode-aisdk","observation":"answer","auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0});
    super::host_tests::response(
        super::host_tests::dispatch(&host, 7, "transform.declare", json!({"params":plan})).await,
    );
    let mut old_req = request(&[baseline()], false);
    old_req.model_key = old.map(str::to_owned);
    for _ in 0..2 {
        transform::transform(
            full.store.get().unwrap(),
            &old_req,
            &context(&fp, 0.0, temporal, 1),
        )
        .unwrap();
        transform::transform(
            host.store.get().unwrap(),
            &old_req,
            &context(&hp, 0.0, temporal, 1),
        )
        .unwrap();
    }
    let mut binding = host.facade_binding(7).unwrap();
    binding.model_key = new.map(str::to_owned);
    binding.config.auto_search.enabled = false;
    host.bind_route(7, binding);
    let appended=tools.iter().enumerate().map(|(i,tool)| {let ordinal=i as u64+2;let mid=format!("hard-{ordinal}");message(&mid,"assistant",json!([{"id":"part","type":"tool","tool":tool,"callID":format!("call-{mid}"),"state":{"status":"completed","input":{},"output":"spent payload ".repeat(repeats)}}]),ordinal,false)}).collect::<Vec<_>>();
    super::host_tests::sync_pass(
        &host,
        &appended
            .iter()
            .enumerate()
            .map(|(i, m)| (i as u64 + 2, m.clone()))
            .collect::<Vec<_>>(),
    )
    .await;
    let raw = std::iter::once(baseline())
        .chain(appended.iter().cloned())
        .collect::<Vec<_>>();
    let mut req = request(&raw, false);
    req.model_key = new.map(str::to_owned);
    req.render_config = "exact-HARD-switch".into();
    let expected = transform::transform(
        full.store.get().unwrap(),
        &req,
        &context(&fp, 0.0, temporal, 2),
    )
    .unwrap();
    assert_eq!(expected.decision, "HARD");
    assert!(expected.prefix_bust_permitted);
    let mids = appended
        .iter()
        .map(|m| m["info"]["id"].as_str().unwrap().to_owned())
        .collect();
    let expected = scalars(&expected, &mids);
    let mut reminders = 0;
    for (i, m) in appended.iter().enumerate() {
        let actual = host_message(&host, m, i as u64 + 2, 1).await;
        let pending_numbers = super::host_tests::pending_hint_numbers(&host);
        let text = actual["parts"][0]["state"]["output"].as_str().unwrap();
        let want = &expected[m["info"]["id"].as_str().unwrap()][0].1;
        assert!(super::host_tests::without_delivery_dependent_hint(text, &pending_numbers)==super::host_tests::without_delivery_dependent_hint(want, &pending_numbers),"exact HARD {old:?}->{new:?}, tools={tools:?}, repeats={repeats}, index={i}; actual suffix {:?}, expected suffix {:?}",text.find("<system-reminder>").map(|n|&text[n..]),want.find("<system-reminder>").map(|n|&want[n..]));
        reminders += usize::from(want.contains("<system-reminder>"));
    }
    (appended.len(), reminders)
}

#[tokio::test]
async fn exact_hard_model_adoption_shows_and_omits_reminders_like_full_engine() {
    let (_, shown) = exact_hard_model_case(
        None,
        Some("anthropic/claude-fable-5-1"),
        &["read"],
        20000,
        false,
    )
    .await;
    assert_eq!(shown, 1, "new model calibration crosses the floor");
    let (_, omitted) = exact_hard_model_case(
        Some("anthropic/claude-fable-5-1"),
        None,
        &["read"],
        20000,
        false,
    )
    .await;
    assert_eq!(omitted, 0, "neutral model calibration is below the floor");
}

mod r2_review_720_pass_differential_with_new_seeds_and_real_reduce {
    use super::*;

    const REVIEW_PASSES: usize = 60;
    const CONFIGURATIONS: [(bool, bool); 3] = [(false, false), (true, false), (false, true)];

    // Generate the test functions and coverage manifest together, so removing a
    // seed test also removes its contribution to the independently pinned totals.
    macro_rules! seed_tests {
        ($($name:ident => ($seed:expr, $comparisons:expr)),+ $(,)?) => {
            const CASES: &[(u64, usize)] = &[$(($seed, $comparisons)),+];

            $(
                #[tokio::test]
                async fn $name() {
                    run_seed(&[$seed], $comparisons).await;
                }
            )+
        };
    }

    seed_tests! {
        seed_81ac0023 => (0x81ac0023, 11364),
        seed_519e72a0 => (0x519e72a0, 11187),
        seed_9c340162 => (0x9c340162, 12162),
        seed_a107d891 => (0xa107d891, 12267),
    }

    #[test]
    fn coverage_totals() {
        assert_eq!(CASES.len() * REVIEW_PASSES * CONFIGURATIONS.len(), 720);
        assert_eq!(CASES.iter().map(|(_, count)| count).sum::<usize>(), 46980);
        assert_eq!(
            CASES.iter().map(|(seed, _)| *seed).collect::<Vec<_>>(),
            [0x81ac0023, 0x519e72a0, 0x9c340162, 0xa107d891],
        );
        assert_eq!(REVIEW_PASSES, 60);
        assert_eq!(
            CONFIGURATIONS,
            [(false, false), (true, false), (false, true)]
        );
        println!("r2 review coverage: 4 seed tests, 720 passes, 46980 per-message comparisons");
    }

    async fn run_seed(seeds: &'static [u64], expected_comparisons: usize) {
        let run = CorpusRun {
            seeds,
            passes: REVIEW_PASSES,
            mixed_tool: "ctx_reduce",
            frozen_reference: false,
            real_reduce: true,
        };
        let replays = super::super::super::policy_summary::replay_checks();
        let mut counts = CorpusCounts::default();
        for (queued, calibrated) in CONFIGURATIONS {
            let observed = drive_overlay_corpus_with(queued, calibrated, &run).await;
            counts.passes += observed.passes;
            counts.comparisons += observed.comparisons;
        }
        assert_eq!(counts.passes, 180);
        assert_eq!(counts.comparisons, expected_comparisons);
        // Hooks replay the stored policy summary; each replay was checked against
        // the full computation on this test's thread, not another seed's thread.
        let replays = super::super::super::policy_summary::replay_checks() - replays;
        assert!(replays > 0, "the corpus never replayed a policy summary");
        println!("r2 review append differential: {} passes, {} per-message comparisons, {replays} checked summary replays, seeds={seeds:x?}",counts.passes,counts.comparisons);
    }
}

#[tokio::test]
async fn r2_published_hard_failures_and_new_seeded_switch_controls_match_full_engine() {
    let failures: &[(usize, char, char, &[&str], usize)] = &[
        (3, 'F', 'G', &["read", "bash", "ctx_reduce"], 30000),
        (6, 'F', 'G', &["bash", "read"], 10000),
        (7, 'N', 'F', &["read", "read"], 30000),
        (9, 'F', 'N', &["bash", "ctx_reduce", "bash"], 30000),
        (13, 'N', 'F', &["read", "read"], 20000),
        (15, 'F', 'F', &["bash", "ctx_reduce", "bash", "bash"], 20000),
        (17, 'F', 'G', &["bash", "read"], 20000),
        (18, 'F', 'N', &["read", "bash", "read"], 20000),
        (19, 'G', 'N', &["read", "bash", "ctx_reduce"], 30000),
        (20, 'F', 'G', &["bash", "ctx_reduce", "bash", "read"], 20000),
        (22, 'N', 'G', &["ctx_reduce", "read", "bash"], 30000),
        (23, 'G', 'F', &["read"], 20000),
        (24, 'F', 'N', &["read", "bash", "bash"], 30000),
        (26, 'F', 'N', &["ctx_reduce", "ctx_reduce", "read"], 20000),
        (27, 'F', 'N', &["read", "read"], 10000),
        (28, 'F', 'G', &["bash"], 20000),
        (29, 'N', 'G', &["ctx_reduce", "bash", "read", "read"], 30000),
        (31, 'N', 'F', &["read", "ctx_reduce", "ctx_reduce"], 20000),
        (33, 'N', 'N', &["ctx_reduce", "read", "bash"], 30000),
        (35, 'F', 'G', &["read"], 30000),
        (
            36,
            'G',
            'N',
            &["bash", "ctx_reduce", "ctx_reduce", "bash"],
            20000,
        ),
        (37, 'G', 'N', &["read", "read", "bash"], 30000),
        (38, 'F', 'N', &["bash"], 20000),
        (42, 'N', 'N', &["bash", "read", "bash"], 10000),
        (43, 'G', 'N', &["read", "bash", "ctx_reduce"], 10000),
        (44, 'F', 'G', &["read", "bash", "read", "bash"], 30000),
        (45, 'N', 'F', &["ctx_reduce", "read", "bash"], 20000),
        (46, 'G', 'G', &["bash", "bash", "read"], 20000),
        (47, 'G', 'F', &["read", "ctx_reduce", "read"], 10000),
    ];
    let model = |code| match code {
        'F' => Some("anthropic/claude-fable-5-1"),
        'G' => Some("openai/gpt-4.1"),
        _ => None,
    };
    let mut comparisons = 0;
    for &(case, old, new, tools, repeats) in failures {
        comparisons += exact_hard_model_case(model(old), model(new), tools, repeats, case % 2 == 0)
            .await
            .0;
    }
    assert_eq!(
        comparisons, 79,
        "all29 published failing input recipes reached"
    );
    // The review did not persist its passing inputs. These are explicitly new,
    // reproducible controls, not a reconstruction of an undocumented collector.
    let mut random = 0x3e9bc027u64;
    for case in 0..19 {
        let models = ['N', 'F', 'G'];
        let old = models[(next(&mut random) % 3) as usize];
        let new = models[(next(&mut random) % 3) as usize];
        let count = (next(&mut random) % 4 + 1) as usize;
        let names = ["read", "bash", "ctx_reduce"];
        let tools = (0..count)
            .map(|_| names[(next(&mut random) % 3) as usize])
            .collect::<Vec<_>>();
        let repeats = [10000, 20000, 30000][(next(&mut random) % 3) as usize];
        comparisons +=
            exact_hard_model_case(model(old), model(new), &tools, repeats, case % 2 == 0)
                .await
                .0;
    }
    println!("r2 HARD companion: 29 published failures plus19 NEW controls, seed=0x3e9bc027,48 passes,{comparisons} exact new-message comparisons");
}

#[cfg(test)]
mod hookcost_review_witnesses {
    use super::*;

    fn enabled() -> bool {
        std::env::var("MC_HOOKCOST_REVIEW").as_deref() == Ok("1")
    }

    fn covered_fixture() -> (
        TransformRequest,
        Vec<mc_store::provider_records::ProviderPolicyPart>,
        Value,
    ) {
        let values = vec![
            message("covered", "user", json!([{"id":"u","type":"text","text":"already summarized"}]), 1, false),
            message("tail", "assistant", json!((0..4).map(|n| json!({"id":format!("tool-{n}"),"type":"tool","tool":"read","callID":format!("call-tail-{n}"),"state":{"status":"completed","input":{},"output":"spent payload ".repeat(30000)}})).collect::<Vec<_>>()), 2, true),
        ];
        let req = request(&values, false);
        let projection = ck_wire::project_messages(&req.messages).unwrap();
        let tags = projection
            .blocks
            .iter()
            .filter_map(|b| transform::taggable_source(b).map(|(kind, source)| (b, kind, source)))
            .enumerate()
            .map(|(n, (b, kind, source))| McTagRow {
                tag_number: n as i64 + 1,
                block_id: b.id.clone(),
                kind: kind.as_store_kind().into(),
                token_count: mc_tokenizer::estimate_tokens(&source) as i64,
                created_at_ms: 1,
                source_bytes: Arc::from([]),
            })
            .collect::<Vec<_>>();
        let window = crate::protection_window::ProtectionWindow::from_persisted_rows_calibrated(
            &tags, 0, 1.0,
        );
        let core = mc_core::CoreState::default();
        let measured = crate::tail_hygiene::measure_tail_hygiene_with_pending_drops(
            &projection,
            &core,
            Some(1),
            &tags,
            &window.tag_numbers,
            &Default::default(),
            &Default::default(),
        );
        let engine_baseline = crate::tail_hygiene::refresh_tail_hygiene_baseline_calibrated(
            measured.clone(),
            true,
            None,
            1,
            crate::tail_hygiene::HygieneCalibration {
                units_version: 2,
                tools_ratio: 1.0,
                prose_ratio: 1.0,
            },
        )
        .baseline;
        let parts = transform::capture_provider_parts(
            &req,
            &projection,
            &core,
            &measured.parts,
            &tags,
            true,
        );
        let settings = transform::provider_engine_settings(&mc_store::ModuleMeta {
            coverage_ordinal: Some(1),
            protected_tokens_effective: Some(0),
            tail_hygiene_baseline: Some(engine_baseline),
            ..Default::default()
        });
        (req, parts, settings)
    }

    #[test]
    fn hookcost_review_covered_tag_forces_hook_refreeze() {
        if !enabled() {
            return;
        }
        let (_, parts, settings) = covered_fixture();
        let before = &parts
            .iter()
            .find(|p| p.block_id == "covered#0")
            .unwrap()
            .measurement;
        let hook = transform::channel1_inputs_from_parts(
            &parts,
            &settings,
            0,
            &Default::default(),
            false,
            false,
            None,
        );
        let after = &hook.baseline.baseline_parts[0];
        assert_eq!(before.tokens, 0);
        assert_eq!(before.tag_number, None);
        assert_eq!(after.tokens, 0);
        assert_eq!(after.tag_number, Some(1));
        assert_eq!(
            crate::tail_hygiene::compared_field(before, after),
            Some("tagNumber")
        );
        assert_eq!(
            hook.baseline.baseline_generation,
            settings["baseline"]["baseline_generation"]
                .as_u64()
                .unwrap()
                + 1
        );
        println!(
            "covered#0: engine tag=None, hook tag=Some(1), tokens=0; baseline generation {} -> {}",
            settings["baseline"]["baseline_generation"], hook.baseline.baseline_generation
        );
    }

    #[test]
    fn hookcost_review_eager_refreeze_before_append_changes_hook_bytes() {
        if !enabled() {
            return;
        }
        let (_, parts, settings) = covered_fixture();
        let prewarm = transform::channel1_inputs_from_parts(
            &parts,
            &settings,
            0,
            &Default::default(),
            false,
            false,
            None,
        );
        let mut warm_parts = parts.clone();
        // Publish the measurements frozen before the next message exists.
        // The old newest message is consequently outside this frozen prefix.
        for measurement in &prewarm.baseline.baseline_parts {
            let id = measurement.key.split('\0').next().unwrap();
            warm_parts
                .iter_mut()
                .find(|p| p.block_id == id)
                .unwrap()
                .measurement = measurement.clone();
        }
        let mut warm_settings = settings.clone();
        let mut baseline = prewarm.baseline.clone();
        baseline.baseline_parts.clear();
        warm_settings["baseline"] = serde_json::to_value(baseline).unwrap();
        warm_settings["baseline_len"] = json!(prewarm.baseline.baseline_parts.len());
        let next_req = request(
            &[message(
                "next",
                "assistant",
                json!([{"id":"next-tool","type":"tool","tool":"read","callID":"call-next","state":{"status":"completed","input":{},"output":"new output"}}]),
                3,
                true,
            )],
            false,
        );
        let mut next_req = next_req;
        next_req.messages[0].ordinal = 3;
        let projection = ck_wire::project_messages(&next_req.messages).unwrap();
        let mut next = admission_policy_parts(&next_req, &projection);
        for p in &mut next {
            if p.tag_kind.is_some() {
                p.tag_number = Some(6);
            }
        }
        let mut cold_parts = parts;
        cold_parts.extend(next.clone());
        warm_parts.extend(next);
        let cold = transform::channel1_inputs_from_parts(
            &cold_parts,
            &settings,
            0,
            &Default::default(),
            true,
            false,
            None,
        );
        let warm = transform::channel1_inputs_from_parts(
            &warm_parts,
            &warm_settings,
            0,
            &Default::default(),
            true,
            false,
            None,
        );
        assert_eq!(
            crate::tail_hygiene::effective_tail_hygiene(&cold.baseline),
            crate::tail_hygiene::effective_tail_hygiene(&warm.baseline)
        );
        assert_eq!(cold.baseline.baseline_parts.len(), 9);
        assert_eq!(warm.baseline.baseline_parts.len(), 1);
        assert_eq!(cold.tool_outputs, 1);
        assert_eq!(warm.tool_outputs, 0);
        let cold_ops = host_channel1(&cold, &json!({})).0;
        let warm_ops = host_channel1(&warm, &json!({})).0;
        assert!(!cold_ops.is_empty());
        assert!(!warm_ops.is_empty());
        assert_ne!(
            serde_json::to_vec(&cold_ops).unwrap(),
            serde_json::to_vec(&warm_ops).unwrap()
        );
        println!("before next message: prewarm baseline_len=1; after next message: cold baseline_len=9, warm baseline_len=1; reclaimable tool outputs cold=1 warm=0; equal effective totals but different channel-1 append bytes");
    }

    #[test]
    fn prepared_refreeze_finalizes_the_exact_r1_admitted_cut() {
        prepared_cut_case("match");
    }

    fn prepared_cut_case(change: &str) {
        let (_, parts, settings) = covered_fixture();
        let root = std::env::temp_dir().join("magic-context/prepared-r1");
        std::fs::create_dir_all(&root).unwrap();
        let dir = tempfile::tempdir_in(root).unwrap();
        let mut store =
            mc_store::McStore::open_for_test(&crate::test_support::descriptor(dir.path())).unwrap();
        let key = mc_store::ProviderSessionKey {
            project_root: "/fixture".into(),
            session: "session".into(),
            harness: "opencode".into(),
            generation: None,
        };
        store.save_provider_conversation(&key, &mc_store::provider_records::ProviderConversation {
            lineage_id: "L".into(), engine_namespace: "engine".into(), cursor_frontier: 3,
            hook_counters_json: json!({"engine_policy":settings,"tag_high_water":5,"reserved_tag_high_water":5}).to_string(),
            ..Default::default()
        }).unwrap();
        let sql = rusqlite::Connection::open(dir.path().join("store.db")).unwrap();
        sql.execute(
            "INSERT INTO mc_provider_lineages_v1 VALUES (?1,'L',1,NULL,NULL,'session')",
            [key.conversation_key()],
        )
        .unwrap();
        for part in &parts {
            sql.execute(
                "INSERT INTO mc_provider_policy_parts_v1 VALUES (?1,'L',?2,?3,?4,'session')",
                rusqlite::params![
                    key.conversation_key(),
                    part.ordinal,
                    part.block_id,
                    serde_json::to_string(part).unwrap()
                ],
            )
            .unwrap();
        }
        let before = store
            .load_provider_conversation(&key)
            .unwrap()
            .unwrap()
            .hook_counters_json;
        assert!(store
            .prepare_provider_policy(&key, |index, counters| {
                super::super::super::policy_summary::prepare_policy(
                    index,
                    &counters["engine_policy"],
                    0,
                    &Default::default(),
                    None,
                )
            })
            .unwrap());
        assert_eq!(
            store
                .load_provider_conversation(&key)
                .unwrap()
                .unwrap()
                .hook_counters_json,
            before,
            "preparation must not publish the earlier baseline"
        );
        match change {
            "sibling" => {
                let sibling = mc_store::ProviderSessionKey {
                    harness: "opencode2".into(),
                    ..key.clone()
                };
                store
                    .save_provider_conversation(
                        &sibling,
                        &mc_store::provider_records::ProviderConversation {
                            engine_namespace: "engine".into(),
                            ..Default::default()
                        },
                    )
                    .unwrap();
            }
            "shared_tag" => {
                sql.execute(
                    "INSERT INTO mc_provider_consumed_tags_v1 VALUES ('engine',2,'session')",
                    [],
                )
                .unwrap();
            }
            "covered_tag" => {
                sql.execute("UPDATE mc_provider_policy_parts_v1 SET policy_json=json_set(policy_json,'$.tag_number',77) WHERE block_id='covered#0'", []).unwrap();
            }
            "settings" => {
                sql.execute("UPDATE mc_provider_conversations_v2 SET hook_counters_json=json_set(hook_counters_json,'$.engine_policy.prose_ratio',2.0)", []).unwrap();
            }
            "key" => {
                sql.execute(
                    "UPDATE mc_provider_policy_preparations_v1 SET settings_key='unsupported'",
                    [],
                )
                .unwrap();
            }
            "baseline" => {
                sql.execute(
                    "UPDATE mc_provider_policy_preparations_v1 SET original_baseline_json='null'",
                    [],
                )
                .unwrap();
            }
            "cut" => {
                sql.execute(
                    "UPDATE mc_provider_policy_preparations_v1 SET newest_ordinal=99",
                    [],
                )
                .unwrap();
            }
            "cap" => {
                sql.execute(
                    "UPDATE mc_provider_policy_preparations_v1 SET uncompressed_bytes=?1",
                    [mc_store::MAX_PROVIDER_PREPARATION_BYTES as u64 + 1],
                )
                .unwrap();
            }
            "checksum" => {
                sql.execute(
                    "UPDATE mc_provider_policy_preparations_v1 SET prepared_blob=x'00'",
                    [],
                )
                .unwrap();
            }
            "evicted" => {
                sql.execute("DELETE FROM mc_provider_policy_preparations_v1", [])
                    .unwrap();
            }
            "restart" => {
                drop(store);
                store =
                    mc_store::McStore::open_for_test(&crate::test_support::descriptor(dir.path()))
                        .unwrap();
            }
            "ancestry" => {
                sql.execute(
                    "INSERT INTO mc_provider_lineages_v1 VALUES (?1,'child',3,'L',1,'session')",
                    [key.conversation_key()],
                )
                .unwrap();
                sql.execute(
                    "UPDATE mc_provider_conversations_v2 SET lineage_id='child'",
                    [],
                )
                .unwrap();
            }
            "match" | "off" | "cache_bust" | "same_cut" => {}
            _ => panic!("unknown preparation case {change}"),
        }
        let mut next_req = request(
            &[message(
                "next",
                "assistant",
                json!([{"id":"next-tool","type":"tool","tool":"read","callID":"call-next","state":{"status":"completed","input":{},"output":"new output"}}]),
                3,
                true,
            )],
            false,
        );
        next_req.messages[0].ordinal = 3;
        let projection = ck_wire::project_messages(&next_req.messages).unwrap();
        let mut next = admission_policy_parts(&next_req, &projection);
        for part in &mut next {
            if part.tag_kind.is_some() {
                part.tag_number = Some(6);
            }
        }
        let mut cold_parts = parts.clone();
        cold_parts.extend(next.clone());
        let cold_r1 = transform::channel1_inputs_from_parts(
            &cold_parts,
            &settings,
            0,
            &Default::default(),
            true,
            false,
            None,
        );
        let lineage = mc_store::provider_records::ProviderLineage {
            lineage_id: if change == "ancestry" { "child" } else { "L" }.into(),
            first_ordinal: if change == "ancestry" { 3 } else { 1 },
            descends_from: (change == "ancestry").then(|| "L".into()),
            through_ordinal: (change == "ancestry").then_some(1),
        };
        let incoming = mc_store::provider_records::ProviderMessage {
            ordinal: if change == "same_cut" { 2 } else { 3 },
            mid: "next".into(),
            message_bytes: b"{}".to_vec(),
        };
        if change == "same_cut" {
            for part in &mut next {
                part.ordinal = 2;
            }
        }
        let (warm, cold) = store.commit_provider_hook_with_preparation(&key, mc_store::provider_records::ProviderHookRequest { lineage:&lineage,message:Some(&incoming),served_through_ordinal:Some(2),unserved_subjects:&[],repeat_subject:None }, &next,change != "off",|ctx| {
            let cold = transform::channel1_inputs_from_parts(&ctx.policy_index.all_parts()?, &ctx.counters["engine_policy"], 0, &Default::default(), true, change == "cache_bust", None);
            let (inputs,summary) = super::super::super::policy_summary::channel1_inputs(&ctx.policy_index,&ctx.counters["engine_policy"],0,&Default::default(),true,change == "cache_bust",None)?;
            assert_eq!(ctx.policy_index.preparation_was_consumed(), matches!(change, "match" | "restart"), "{change}: mismatch must use the cold path; a valid R1 preparation must actually be consumed");
            let mut counters = ctx.counters.clone();
            counters["policy_baseline_updates"] = json!(inputs.baseline.baseline_parts.iter().map(|measurement| json!({"block_id":measurement.key.split('\0').next().unwrap(),"measurement":measurement})).collect::<Vec<_>>());
            let mut baseline=inputs.baseline.clone();baseline.baseline_parts.clear();
            counters["engine_policy"]["baseline"]=serde_json::to_value(baseline).unwrap();
            counters["engine_policy"]["baseline_len"]=json!(inputs.baseline.baseline_parts.len());
            Ok((mc_store::provider_records::ProviderHookWrite { answer:None,counters,policy_summary:summary },(inputs,cold)))
        }).unwrap();
        if matches!(change, "match" | "restart") {
            assert_eq!(warm.baseline.baseline_parts.len(), 9);
            assert_eq!(warm.tool_outputs, 1);
            assert_eq!(
                serde_json::to_vec(&warm.baseline).unwrap(),
                serde_json::to_vec(&cold_r1.baseline).unwrap()
            );
        }
        assert_eq!(
            serde_json::to_vec(&warm.baseline).unwrap(),
            serde_json::to_vec(&cold.baseline).unwrap()
        );
        assert_eq!(
            serde_json::to_vec(&host_channel1(&warm, &json!({})).0).unwrap(),
            serde_json::to_vec(&host_channel1(&cold, &json!({})).0).unwrap()
        );
        assert_eq!(warm.users, cold.users);
        assert_eq!(warm.tool_outputs, cold.tool_outputs);
        assert_eq!(
            serde_json::to_vec(&warm.hint).unwrap(),
            serde_json::to_vec(&cold.hint).unwrap()
        );
    }

    #[test]
    fn prepared_policy_sibling_revision_mismatch_uses_cold_bytes() {
        prepared_cut_case("sibling");
    }
    #[test]
    fn prepared_policy_shared_consumed_tag_uses_cold_bytes() {
        prepared_cut_case("shared_tag");
    }
    #[test]
    fn prepared_policy_covered_tag_change_uses_cold_bytes() {
        prepared_cut_case("covered_tag");
    }
    #[test]
    fn prepared_policy_settings_revision_mismatch_uses_cold_bytes() {
        prepared_cut_case("settings");
    }
    #[test]
    fn prepared_policy_invalid_key_uses_cold_bytes() {
        prepared_cut_case("key");
    }
    #[test]
    fn prepared_policy_original_baseline_mismatch_uses_cold_bytes() {
        prepared_cut_case("baseline");
    }
    #[test]
    fn prepared_policy_cut_mismatch_uses_cold_bytes() {
        prepared_cut_case("cut");
    }
    #[test]
    fn prepared_policy_byte_cap_uses_cold_bytes() {
        prepared_cut_case("cap");
    }
    #[test]
    fn prepared_policy_corrupt_checksum_uses_cold_bytes() {
        prepared_cut_case("checksum");
    }
    #[test]
    fn prepared_policy_evicted_uses_cold_bytes() {
        prepared_cut_case("evicted");
    }
    #[test]
    fn prepared_policy_restart_retains_revision_checked_bytes() {
        prepared_cut_case("restart");
    }
    #[test]
    fn prepared_policy_disabled_uses_cold_bytes() {
        prepared_cut_case("off");
    }
    #[test]
    fn prepared_policy_cache_bust_uses_cold_bytes() {
        prepared_cut_case("cache_bust");
    }
    #[test]
    fn prepared_policy_ancestry_change_uses_cold_bytes() {
        prepared_cut_case("ancestry");
    }
    #[test]
    fn prepared_policy_unadvanced_cut_uses_cold_bytes() {
        prepared_cut_case("same_cut");
    }
}
