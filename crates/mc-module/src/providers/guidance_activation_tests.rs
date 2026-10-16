use super::tests::{handler, key, pins, value};
use super::*;
use crate::providers::claude_code_tests as cc;
use hooks::answer::{HookAnswer, Operation};

async fn guidance(h: &McHandler, preset: &str) -> Value {
    value(
        h.dispatch_value(
            7,
            json!({"method":"guidance.get","session_id":"cc","tool_present":true,"preset":preset}),
        )
        .await,
    )
}

async fn status(h: &McHandler) -> Value {
    value(
        h.dispatch_value(
            7,
            json!({"method":"session.status","session_id":"cc","v":1}),
        )
        .await,
    )["admission_tags"]
        .clone()
}

fn assert_guidance(answer: &Value, auto_tag: bool) {
    let text = answer["bytes"].as_str().unwrap();
    assert_eq!(
        text.contains("Magic Context adds a tag such as §12§"),
        auto_tag
    );
    assert_eq!(text.contains("Start the text of each reply"), !auto_tag);
    assert_eq!(text.contains("Tags are added for you"), auto_tag);
    assert!(text.contains("To refer to an item in your prose, write \"tag 12\"."));
}

async fn activation(canonical_reduce: bool, guidance_enabled: bool) {
    for preset in ["full", "light"] {
        let dir = tempfile::tempdir().unwrap();
        let mut p = pins("guidance-activation");
        p.canonical_reduce = canonical_reduce;
        p.guidance = guidance_enabled;
        let auto_tag = canonical_reduce && guidance_enabled;
        let h = handler(dir.path(), &p);
        let before = guidance(&h, preset).await;
        assert_guidance(&before, auto_tag);
        let mut scoped = h.facade_binding(7).unwrap();
        scoped.native_generation = Some(mc_store::provider_records::ProviderGeneration {
            profile: p.profile_generation.clone(),
            provider: p.provider_generation.clone(),
        });
        let k = Key::new(&scoped, "cc", "claude-code").unwrap();
        let store = h.store.get().unwrap();
        assert!(store
            .load_provider_conversation(&k.store_key())
            .unwrap()
            .is_none());
        value(
            cc::call(
                &h,
                "transform.declare",
                json!({
                    "session":"cc","harness":"claude-code","preset":"head",
                    "params":{"serializer_profile":"claude-code-anthropic","observation":"answer"}
                }),
            )
            .await,
        );
        let created = store
            .load_provider_conversation(&k.store_key())
            .unwrap()
            .unwrap();
        let counters: Value = serde_json::from_str(&created.hook_counters_json).unwrap();
        assert_eq!(
            counters,
            if auto_tag {
                json!({"auto_tag":true})
            } else {
                json!({})
            }
        );
        let plan: Value = serde_json::from_str(created.native_plan_json.as_ref().unwrap()).unwrap();
        assert_eq!(
            plan,
            json!({
                "params":{"serializer_profile":"claude-code-anthropic","observation":"answer"},
                "preset":"head"
            })
        );
        // Repeating transform.declare and compaction.setup must retain both
        // auto_tag and the sentinel counter rather than initialize them again.
        store
            .update_provider_hook_counters(&k.store_key(), |c| c["sentinel"] = json!(7))
            .unwrap();
        let saved = store
            .load_provider_conversation(&k.store_key())
            .unwrap()
            .unwrap()
            .hook_counters_json;
        cc::setup(&h).await;
        assert_eq!(
            status(&h).await,
            json!({"enabled":auto_tag,"reason":if auto_tag {"enabled"} else {"candidate_inactive"}})
        );
        assert_eq!(
            store
                .load_provider_conversation(&k.store_key())
                .unwrap()
                .unwrap()
                .hook_counters_json,
            saved
        );
        let after = guidance(&h, preset).await;
        assert_eq!(before, after);
        let raw = r#"{"role":"user","content":"hello"}"#;
        let answer: HookAnswer = serde_json::from_value(value(cc::call(&h, "transform.hook", json!({
            "session":"cc","harness":"claude-code","lineage_id":"L","step_id":"hook",
            "params":{"serializer_profile":"claude-code-anthropic","observation":"answer"},
            "subject_mid":"user","subject_ordinal":0,"message":{"role":"user","content":"hello"},
            "raw_message":raw,"hook":"pre_user","blocks":["hello"]
        })).await)).unwrap();
        if auto_tag {
            let HookAnswer::Ops { ops } = answer else {
                panic!("{answer:?}")
            };
            assert!(
                matches!(&ops[..], [Operation::Prepend { block: 0, text, .. }] if text == "§1§ ")
            );
        } else {
            assert_eq!(answer, HookAnswer::Pass);
        }
        let saved = store
            .load_provider_conversation(&k.store_key())
            .unwrap()
            .unwrap()
            .hook_counters_json;
        drop(h);
        let restarted = handler(dir.path(), &p);
        assert_eq!(guidance(&restarted, preset).await, after);
        cc::setup(&restarted).await;
        let row = restarted
            .store
            .get()
            .unwrap()
            .load_provider_conversation(&k.store_key())
            .unwrap()
            .unwrap();
        assert_eq!(row.hook_counters_json, saved);
        assert_eq!(
            status(&restarted).await,
            json!({"enabled":auto_tag,"reason":if auto_tag {"enabled"} else {"candidate_inactive"}})
        );
    }
}

#[tokio::test]
async fn g11_auto_tag_guidance_creation_hook_and_restart() {
    activation(true, true).await;
}

#[tokio::test]
async fn fresh_native_plan_tags_first_eligible_hook() {
    let dir = tempfile::tempdir().unwrap();
    let mut p = pins("first-hook");
    p.canonical_reduce = true;
    p.guidance = true;
    let h = handler(dir.path(), &p);
    cc::setup(&h).await;
    let raw = r#"{"role":"user","content":"first"}"#;
    let answer: HookAnswer = serde_json::from_value(value(cc::call(&h, "transform.hook", json!({
        "session":"cc","harness":"claude-code","lineage_id":"L","step_id":"first",
        "params":{"serializer_profile":"claude-code-anthropic","observation":"answer"},
        "subject_mid":"user","subject_ordinal":0,"message":{"role":"user","content":"first"},
        "raw_message":raw,"hook":"pre_user","blocks":["first"]
    })).await)).unwrap();
    assert!(
        matches!(answer, HookAnswer::Ops { ref ops }
        if matches!(&ops[..], [Operation::Prepend { block: 0, text, .. }] if text == "§1§ ")),
        "a newly selected MC-owned plan must tag its first hook: {answer:?}"
    );
}

#[tokio::test]
async fn g11_legacy_guidance_creation_pass_and_restart() {
    activation(false, false).await;
}

#[tokio::test]
async fn preexisting_native_plan_without_flag_is_never_enabled() {
    let dir = tempfile::tempdir().unwrap();
    let mut p = pins("preexisting-plan");
    p.canonical_reduce = true;
    p.guidance = true;
    let h = handler(dir.path(), &p);
    cc::setup(&h).await;
    let k = key(&h);
    // Older conversation rows lack auto_tag. Removing it models such a row
    // while keeping the native pins identical for the repeated declaration.
    h.store
        .get()
        .unwrap()
        .update_provider_hook_counters(&k.store_key(), |c| {
            c.as_object_mut().unwrap().remove("auto_tag");
        })
        .unwrap();
    drop(h);
    let restarted = handler(dir.path(), &p);
    cc::setup(&restarted).await;
    assert_eq!(
        status(&restarted).await,
        json!({"enabled":false,"reason":"plan_predates_auto_tag"})
    );
    assert_guidance(&guidance(&restarted, "full").await, false);
    let raw = r#"{"role":"user","content":"old plan"}"#;
    let answer: HookAnswer = serde_json::from_value(value(cc::call(&restarted, "transform.hook", json!({
        "session":"cc","harness":"claude-code","lineage_id":"L","step_id":"old",
        "params":{"serializer_profile":"claude-code-anthropic","observation":"answer"},
        "subject_mid":"user","subject_ordinal":0,"message":{"role":"user","content":"old plan"},
        "raw_message":raw,"hook":"pre_user","blocks":["old plan"]
    })).await)).unwrap();
    assert_eq!(answer, HookAnswer::Pass);
}

#[tokio::test]
async fn activation_requires_both_compiled_flags() {
    activation(true, false).await;
    activation(false, true).await;
}

#[tokio::test]
async fn g11_stored_native_pins_differ_refuses_without_changing_flag() {
    for original in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut p = pins("unchanged-generation");
        p.canonical_reduce = original;
        p.guidance = original;
        let h = handler(dir.path(), &p);
        cc::setup(&h).await;
        let k = key(&h);
        let held = h
            .store
            .get()
            .unwrap()
            .load_provider_conversation(&k.store_key())
            .unwrap()
            .unwrap();
        drop(h);
        p.canonical_reduce = !original;
        p.guidance = !original;
        let restarted = handler(dir.path(), &p);
        // Stored auto_tag controls guidance even if the restarted build has
        // different canonical_reduce and guidance flags.
        assert_guidance(&guidance(&restarted, "full").await, original);
        assert_eq!(
            status(&restarted).await,
            json!({"enabled":original,"reason":if original {"enabled"} else {"plan_predates_auto_tag"}})
        );
        let outcome = cc::call(
            &restarted,
            "transform.declare",
            json!({
                "session":"cc","harness":"claude-code","preset":"head",
                "params":{"serializer_profile":"claude-code-anthropic","observation":"answer"}
            }),
        )
        .await;
        assert!(
            matches!(outcome, HandlerOutcome::ErrorWithDetail { ref message, .. } if message == "stored native pins differ"),
            "{outcome:?}"
        );
        let row = restarted
            .store
            .get()
            .unwrap()
            .load_provider_conversation(&k.store_key())
            .unwrap()
            .unwrap();
        assert_eq!(row.hook_counters_json, held.hook_counters_json);
        assert_eq!(row.native_pins_json, held.native_pins_json);
        assert_eq!(row.native_plan_json, held.native_plan_json);
    }
}

#[tokio::test]
async fn auto_tag_guidance_requires_attested_cc_binding() {
    let dir = tempfile::tempdir().unwrap();
    let mut p = pins("attestation");
    p.canonical_reduce = true;
    p.guidance = true;
    let h = handler(dir.path(), &p);
    h.bind_route(7, cc::binding(dir.path(), None));
    assert_guidance(&guidance(&h, "full").await, false);
    assert_eq!(
        status(&h).await,
        json!({"enabled":false,"reason":"not_attested"})
    );
}

#[tokio::test]
async fn auto_tag_plan_requires_mc_reduction_ownership() {
    let dir = tempfile::tempdir().unwrap();
    let mut p = pins("non-owner");
    p.canonical_reduce = true;
    p.guidance = true;
    let h = handler(dir.path(), &p);
    value(
        cc::call(
            &h,
            "transform.declare",
            json!({
                "session":"cc","harness":"claude-code","preset":"head",
                "params":{"serializer_profile":"claude-code-anthropic","observation":"answer"},
                "composition":{"compaction":{"provider":"another-provider"}}
            }),
        )
        .await,
    );
    assert_eq!(
        status(&h).await,
        json!({"enabled":false,"reason":"not_reduction_owner"})
    );
    assert_guidance(&guidance(&h, "full").await, false);
    let row = h
        .store
        .get()
        .unwrap()
        .load_provider_conversation(&key(&h).store_key())
        .unwrap()
        .unwrap();
    let counters: Value = serde_json::from_str(&row.hook_counters_json).unwrap();
    assert!(counters.get("auto_tag").is_none());
}

#[tokio::test]
async fn other_lanes_report_admission_tagging_disabled() {
    let dir = tempfile::tempdir().unwrap();
    let h = cc::handler(dir.path(), cc::thalamus());
    for harness in ["opencode", "broca"] {
        let mut binding = cc::binding(dir.path(), cc::thalamus());
        binding.harness = harness.into();
        h.bind_route(7, binding);
        assert_eq!(
            status(&h).await,
            json!({"enabled":false,"reason":"lane_not_claude_code"})
        );
    }
}

#[tokio::test]
async fn compiled_candidate_controls_new_plan_tagging() {
    activation(
        capability_candidate::CANDIDATE.canonical_reduce,
        capability_candidate::CANDIDATE.guidance,
    )
    .await;
}

async fn retained_auto_tag_conversation(auto_tag: Option<bool>, descend: bool) {
    let enabled = auto_tag == Some(true);
    let dir = tempfile::tempdir().unwrap();
    let mut p = pins("retained-auto-tag");
    p.canonical_reduce = true;
    p.guidance = true;
    let h = handler(dir.path(), &p);
    cc::setup(&h).await;
    let k = key(&h);
    h.store
        .get()
        .unwrap()
        .update_provider_hook_counters(&k.store_key(), |c| {
            if let Some(value) = auto_tag {
                c["auto_tag"] = json!(value);
            } else {
                c.as_object_mut().unwrap().remove("auto_tag");
            }
        })
        .unwrap();
    let raw = r#"{"role":"user","content":"prefix"}"#;
    let hook = |lineage: &str, mid: &str, ordinal: u64| {
        json!({
            "session":"cc","harness":"claude-code","lineage_id":lineage,"step_id":"hook",
            "params":{"serializer_profile":"claude-code-anthropic","observation":"answer"},
            "subject_mid":mid,"subject_ordinal":ordinal,"message":{"role":"user","content":"prefix"},
            "raw_message":raw,"hook":"pre_user","blocks":["prefix"]
        })
    };
    let first = value(cc::call(&h, "transform.hook", hook("L", "prefix", 0)).await);
    cc::assert_admission_answer(&first, enabled, &[(0, 1)]);
    cc::assert_stored_and_served_raw(
        &h,
        "prefix",
        raw,
        if enabled {
            r#"{"role":"user","content":"§1§ prefix"}"#
        } else {
            raw
        },
    );
    if descend {
        let mut ingest = cc::step(raw);
        ingest["messages"] = json!([
            {"mid":"prefix","ordinal":0,"message":serde_json::from_str::<Value>(raw).unwrap(),"raw_message":raw},
            {"mid":"suffix","ordinal":1,"message":{"role":"user","content":"suffix"},"raw_message":r#"{"role":"user","content":"suffix"}"#}
        ]);
        ingest["newest"] = json!({"mid":"suffix","ordinal":1});
        ingest["served_through_ordinal"] = json!(0);
        let produced = value(cc::call(&h, "compaction.step", ingest.clone()).await);
        assert_eq!(produced["compaction"]["range"], json!({"from":0,"to":2}));
        ingest["last_applied"] = json!({"compaction_id":produced["compaction"]["compaction_id"],"version":produced["compaction"]["version"]});
        ingest["request_id"] = json!("ack");
        value(cc::call(&h, "compaction.step", ingest).await);
    }
    h.bind_route(7, cc::binding(dir.path(), cc::thalamus()));
    cc::setup(&h).await;
    if descend {
        value(cc::call(&h, "compaction.setup", json!({
            "session":"cc","harness":"claude-code","request_id":"fork",
            "params":{"serializer_profile":"claude-code-anthropic","observation":"answer"},
            "preset":"head","model":"fixture","context_window":100000,"composition":{},
            "lineage_id":"child","descends_from":{"lineage_id":"L","through_ordinal":0},"now":3
        })).await);
    }
    assert_eq!(
        status(&h).await,
        json!({"enabled":enabled,"reason":if enabled {"enabled"} else {"plan_predates_auto_tag"}})
    );
    let lineage = if descend { "child" } else { "L" };
    let answer = value(cc::call(&h, "transform.hook", hook(lineage, "new", 1)).await);
    cc::assert_admission_answer(&answer, enabled, &[(0, 2)]);
    cc::assert_stored_and_served_raw_in_lineage(
        &h,
        lineage,
        "new",
        raw,
        if enabled {
            r#"{"role":"user","content":"§2§ prefix"}"#
        } else {
            raw
        },
    );
}

#[tokio::test]
async fn auto_tag_survives_new_client_redeclare() {
    for auto_tag in [Some(true), Some(false), None] {
        retained_auto_tag_conversation(auto_tag, false).await;
    }
}

#[tokio::test]
async fn auto_tag_descendant_inherits_enabled_and_disabled() {
    for auto_tag in [Some(true), Some(false), None] {
        retained_auto_tag_conversation(auto_tag, true).await;
    }
}
