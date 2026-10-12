use mc_store::memory_projection::{text_line, AgentFragment, AppliedProjection, VisibleText};
use mc_tokenizer::estimate_tokens;

fn assert_automated_memory_change(operation: &str) {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
        .unwrap();
    let id = s
        .insert_memory(memory_input(
            "git:proj",
            "CONSTRAINTS",
            "cache_ttl is 5 minutes in config.ts.",
            0,
        ))
        .unwrap();
    let second = if operation == "curate_merge" {
        Some(
            s.insert_memory(memory_input(
                "git:proj",
                "CONSTRAINTS",
                "config.ts declares a 5 minute cache_ttl.",
                0,
            ))
            .unwrap(),
        )
    } else {
        None
    };
    if operation == "expiry_archive" {
        s.with_context_conn_for_test(|conn| {
            conn.execute("UPDATE memories SET expires_at=1 WHERE id=?1", [id])
        })
        .unwrap();
    }
    let mut request = req(
        "ses",
        "cfg0",
        vec![item("a", 1, "raw"), item("tail", 2, "tail")],
    );
    request.auto_search_enabled = false;
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let before = transform(&s, &request, &ctx).unwrap();
    let served_before = serde_json::to_vec(before.messages()).unwrap();
    assert!(m0_bytes(&before).contains("cache_ttl is 5 minutes"));
    let corrected = "cache_ttl is 10 minutes in config.ts.";
    let original_hash = s.get_memory_full(id).unwrap().unwrap().normalized_hash;
    s.with_facade_command(
        "/tmp",
        "git:proj",
        "memories",
        "ses",
        "memory.curate",
        operation,
        Some(operation),
        |agent_tx| {
            let tx = agent_tx.automated();
            match operation {
                "curate_update" => {
                    tx.update_memory_content("git:proj", id, corrected, None, 2)
                        .map_err(|e| e.to_string())?;
                }
                "curate_merge" => {
                    tx.merge_memories_canonical(
                        "git:proj",
                        &[id, second.unwrap()],
                        corrected,
                        Some("ses"),
                        2,
                    )
                    .map_err(|e| e.to_string())?;
                }
                "curate_archive" => {
                    tx.archive_memories("git:proj", &[id], Some("obsolete"), 2)
                        .map_err(|e| e.to_string())?;
                }
                "verify_archive" | "verify_update" => {
                    let result = tx.set_memory_verification(
                        "git:proj",
                        &[mc_store::VerificationUpdate {
                            memory_id: id,
                            content_hash_at_prompt: original_hash.clone(),
                            verification_status: if operation == "verify_update" {
                                "update"
                            } else {
                                "archive"
                            }
                            .into(),
                            updated_content: Some(corrected.into()),
                            archive_reason: Some("obsolete".into()),
                        }],
                        2,
                    )?;
                    assert_eq!(result.accepted, vec![id]);
                }
                "expiry_archive" => {
                    assert_eq!(tx.expire_memories("git:proj", &[id], 2)?.accepted, vec![id]);
                }
                _ => unreachable!(),
            }
            Ok(Vec::new())
        },
    )
    .unwrap();
    let row = s.get_memory_full(id).unwrap().unwrap();
    if operation.ends_with("archive") || second.is_some() {
        assert_eq!(row.status, "archived");
    } else {
        assert_eq!(row.content, corrected);
    }
    s.with_context_conn_for_test(|conn| {
        let (previous, snapshot): (String, String) = conn.query_row(
            "SELECT previous_text,before_json FROM memory_history WHERE memory_id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(previous, "cache_ttl is 5 minutes in config.ts.");
        assert_eq!(
            serde_json::from_str::<Value>(&snapshot).unwrap()["status"],
            "active"
        );
        if let Some(second) = second {
            assert_eq!(
                conn.query_row(
                    "SELECT previous_text FROM memory_history WHERE memory_id=?1",
                    [second],
                    |row| row.get::<_, String>(0)
                )?,
                "config.ts declares a 5 minute cache_ttl."
            );
        }
        for table in [
            "memory_mutation_log",
            "memory_agent_fragments",
            "memory_tool_proposals",
        ] {
            assert_eq!(
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                    .get::<_, i64>(0))?,
                0,
                "{table}"
            );
        }
        Ok(())
    })
    .unwrap();
    let deferred = transform(&s, &request, &ctx).unwrap();
    assert_eq!(
        serde_json::to_vec(deferred.messages()).unwrap(),
        served_before
    );
    s.arm_soft_refresh("ses").unwrap();
    let soft = transform(&s, &request, &ctx).unwrap();
    assert_eq!(soft.action, "SOFT");
    assert_eq!(serde_json::to_vec(soft.messages()).unwrap(), served_before);
    request.render_config = "cfg-natural-rebuild".into();
    let hard = transform(&s, &request, &ctx).unwrap();
    assert_eq!(hard.action, "HARD");
    assert!(!m0_bytes(&hard).contains("cache_ttl is 5 minutes"));
    if !operation.ends_with("archive") {
        assert!(m0_bytes(&hard).contains(corrected));
    }
}

#[test]
fn module_curate_update_applies_with_history_and_waits_for_hard() {
    assert_automated_memory_change("curate_update");
}
#[test]
fn module_curate_merge_applies_with_history_and_waits_for_hard() {
    assert_automated_memory_change("curate_merge");
}
#[test]
fn module_curate_archive_applies_with_history_and_waits_for_hard() {
    assert_automated_memory_change("curate_archive");
}
#[test]
fn module_verify_archive_applies_with_history_and_waits_for_hard() {
    assert_automated_memory_change("verify_archive");
}
#[test]
fn module_verify_update_applies_with_history_and_waits_for_hard() {
    assert_automated_memory_change("verify_update");
}
#[test]
fn module_expiry_archive_applies_with_history_and_waits_for_hard() {
    assert_automated_memory_change("expiry_archive");
}

fn edit(s: &McStore, session: &str, id: i64, text: &str, key: &str) -> Result<(), McStoreError> {
    s.with_facade_command(
        "/tmp",
        "git:proj",
        "memories",
        session,
        "ctx_memory",
        "update",
        Some(key),
        |tx| {
            let row = tx
                .update_memory_content("git:proj", id, text, None, 0)
                .map_err(|e| e.to_string())?;
            tx.record_agent_fragment(
                session,
                "git:proj",
                key,
                &[id],
                Some(id),
                &[text_line("updated", id, &row.category, &row.content)],
                &[VisibleText {
                    id,
                    text: row.content,
                }],
                0,
            )?;
            Ok(Vec::new())
        },
    )?;
    Ok(())
}

#[test]
fn review_fragment_failure_rolls_back_canonical_edit_and_history() {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let id = s
        .insert_memory(memory_input("git:proj", "CONSTRAINTS", "original claim", 0))
        .unwrap();
    s.with_context_conn_for_test(|conn| conn.execute_batch("CREATE TRIGGER review_fragment_failure BEFORE INSERT ON memory_agent_fragments BEGIN SELECT RAISE(ABORT, 'review fragment failure'); END;")).unwrap();
    assert!(edit(&s, "ses", id, "must roll back", "failed-fragment").is_err());
    drop(s);
    let s = store(dir.path());
    s.with_context_conn_for_test(|conn| {
        let content: String =
            conn.query_row("SELECT content FROM memories WHERE id=?1", [id], |row| {
                row.get(0)
            })?;
        assert_eq!(content, "original claim");
        for table in [
            "memory_history",
            "memory_mutation_log",
            "memory_agent_fragments",
        ] {
            let count: i64 =
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?;
            assert_eq!(count, 0, "{table} must roll back with the row");
        }
        Ok(())
    })
    .unwrap();
}

#[test]
fn review_shown_full_and_marker_lines_survive_budget_collapse() {
    let mut projection = AppliedProjection::default();
    let fragment = |id: i64, text: &str| AgentFragment {
        id,
        operation_key: format!("op-{id}"),
        memory_ids: vec![id],
        current_id: Some(id),
        lines: vec![text_line("updated", id, "CONSTRAINTS", text)],
        visible_texts: vec![VisibleText {
            id,
            text: text.into(),
        }],
    };
    let (first, next) = crate::agent_fragments::compose(
        projection,
        &[fragment(1, "fully shown")],
        8000.0,
        60000.0,
        0,
        0,
        estimate_tokens,
    );
    projection = next;
    assert!(first.contains("fully shown"));
    let (second, next) = crate::agent_fragments::compose(
        projection,
        &[fragment(2, &"oversized correction ".repeat(5000))],
        8000.0,
        60000.0,
        0,
        0,
        estimate_tokens,
    );
    projection = next;
    assert!(second.contains("<stale-memory ids=\"2\""));
    let retained = projection.committed.clone();
    let pending = (3..103)
        .map(|id| fragment(id, "new correction"))
        .collect::<Vec<_>>();
    let (third, next) = crate::agent_fragments::compose(
        projection,
        &pending,
        0.0,
        0.0,
        50000,
        8000,
        estimate_tokens,
    );
    assert_eq!(&next.committed[..retained.len()], retained.as_slice());
    assert!(third.contains("fully shown"));
    assert!(third.contains("<stale-memory ids=\"2\""));
    assert_eq!(third.matches("<more-memory-edits ").count(), 1);
    assert_eq!(next.committed.last().unwrap().overflow_count, Some(100));
}

#[test]
#[ignore = "requires Bun and installed workspace packages; run explicitly for the independent cache review"]
fn review_randomized_served_sequences_match_ts_composer() {
    let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut oracle_inputs = Vec::new();
    let mut actual_soft = Vec::new();
    let mut counts = [0usize; 7];
    for seed_start in [0x8b45a029u32, 0xa643d711, 0x137efccb, 0xc09d32a1] {
        let dir = tempfile::tempdir().unwrap();
        let mut s = store(dir.path());
        s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
            .unwrap();
        let id = s
            .insert_memory(memory_input("git:proj", "CONSTRAINTS", "baseline", 0))
            .unwrap();
        let mut request = req(
            "ses",
            "cfg0",
            vec![item("a", 1, "raw"), item("tail", 2, "tail")],
        );
        request.auto_search_enabled = false;
        let mut ctx = pctx("git:proj", "/nonexistent-docs", 0);
        let mut shown = transform(&s, &request, &ctx).unwrap();
        let mut random = seed_start;
        let mut next = || {
            random ^= random << 13;
            random ^= random >> 17;
            random ^= random << 5;
            random
        };
        for step in 0..160 {
            let old_m0 = m0_bytes(&shown).to_string();
            let previous = serde_json::to_vec(shown.messages()).unwrap();
            let owner = if next() % 2 == 0 { "ses" } else { "foreign" };
            let mut canonical = format!("{owner} seed {seed_start} step {step}: literal & <claim> \"quoted\" 🦀\nsecond line");
            edit(&s, owner, id, &canonical, &format!("{seed_start}-{step}")).unwrap();
            if next() % 3 == 0 {
                canonical = format!("automated seed {seed_start} step {step}");
                s.with_context_conn_for_test(|conn| {
                    conn.execute(
                        "UPDATE memories SET content=?1,revision=revision+1 WHERE id=?2",
                        rusqlite::params![canonical, id],
                    )
                })
                .unwrap();
            }
            let action = next() % 7;
            counts[action as usize] += 1;
            if action == 3 {
                drop(s);
                s = store(dir.path());
            }
            if action == 4 {
                let stale = s.load("ses").unwrap();
                s.arm_soft_refresh("ses").unwrap();
                let current = s.load("ses").unwrap();
                assert!(current.row_version > stale.row_version);
                assert!(s
                    .commit("ses", stale.row_version, &stale.core, &stale.meta)
                    .is_err());
            }
            if action == 5 {
                ctx.memory_budget_tokens = 8000.0;
                request.render_config = format!("hard-{seed_start}-{step}");
            }
            if action == 6 {
                ctx.memory_budget_tokens = 8000.0;
                request.model_key = Some(format!("model-{step}"));
                request.render_config = format!("model-config-{seed_start}-{step}");
            }
            if matches!(action, 1 | 2 | 4) {
                let loaded = s.load("ses").unwrap();
                let projection = loaded.meta.memory_projection.unwrap();
                let after = projection
                    .committed
                    .iter()
                    .map(|entry| entry.id)
                    .fold(projection.fragment_watermark, i64::max);
                let pending = s.load_agent_fragments("ses", after).unwrap();
                ctx.memory_budget_tokens =
                    [8000.0, 1200.0, 500.0, 100.0, 0.0][(next() % 5) as usize];
                oracle_inputs.push(json!({
                    "before": { "generation": projection.generation, "hardMemoryBlock": "{\"updateLines\":[],\"newMemories\":\"\"}", "fragmentWatermark": projection.fragment_watermark, "committed": projection.committed, "legacy": false },
                    "pending": pending, "memoryBudgetTokens": ctx.memory_budget_tokens,
                    "historyBudgetTokens": ctx.history_budget_tokens, "independentTokens": 0,
                    "m0Tokens": estimate_tokens(&old_m0)
                }));
                s.arm_soft_refresh("ses").unwrap();
            }
            let served = transform(&s, &request, &ctx).unwrap();
            match action {
                0 | 3 => {
                    assert_eq!(served.action, "SOFT+");
                    assert_eq!(
                        serde_json::to_vec(served.messages()).unwrap(),
                        previous,
                        "defer seed {seed_start} step {step}"
                    );
                }
                1 | 2 | 4 => {
                    assert_eq!(served.action, "SOFT");
                    assert_eq!(m0_bytes(&served), old_m0);
                    let projection = s.load("ses").unwrap().meta.memory_projection.unwrap();
                    actual_soft.push((
                        crate::agent_fragments::block(m1_bytes(&served), "memory-updates"),
                        projection.committed,
                    ));
                }
                5 | 6 => {
                    assert_eq!(served.action, "HARD");
                    let escaped = canonical
                        .replace('&', "&amp;")
                        .replace('<', "&lt;")
                        .replace('>', "&gt;")
                        .replace('\n', "\n  ");
                    assert!(
                        m0_bytes(&served).contains(&escaped),
                        "HARD must fold the latest canonical text: {}",
                        m0_bytes(&served)
                    );
                    assert!(!m1_bytes(&served).contains("<memory-updates>"));
                    assert!(s
                        .load("ses")
                        .unwrap()
                        .meta
                        .memory_projection
                        .unwrap()
                        .committed
                        .is_empty());
                }
                _ => unreachable!(),
            }
            shown = served;
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("input.json");
    let output = dir.path().join("output.json");
    std::fs::write(&input, serde_json::to_vec(&oracle_inputs).unwrap()).unwrap();
    let command = std::process::Command::new("bun")
        .current_dir(&workspace)
        .args([
            "crates/mc-module/tests/fixtures/agent-fragments-golden.ts",
            "--input",
        ])
        .arg(&input)
        .arg("--output")
        .arg(&output)
        .output()
        .unwrap();
    assert!(
        command.status.success(),
        "{}",
        String::from_utf8_lossy(&command.stderr)
    );
    let expected: Vec<serde_json::Value> =
        serde_json::from_slice(&std::fs::read(output).unwrap()).unwrap();
    assert_eq!(expected.len(), actual_soft.len());
    for (index, (block, committed)) in actual_soft.iter().enumerate() {
        assert_eq!(
            block,
            expected[index]["block"].as_str().unwrap(),
            "supplied SOFT case {index}"
        );
        assert_eq!(
            serde_json::to_value(committed).unwrap(),
            expected[index]["committed"],
            "supplied SOFT case {index}"
        );
    }
    assert!(counts.iter().all(|count| *count > 0));
    println!("640 served steps; defer/SOFT/flush/restart/CAS-loss/HARD/model-switch={counts:?}; {} exact TS/Pi SOFT comparisons", actual_soft.len());
}

#[test]
#[ignore = "requires Bun and installed workspace packages; run explicitly for the independent cache review"]
fn review_new_seed_fragment_sequences_match_ts_composer() {
    let workspace = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let dir = tempfile::tempdir().unwrap();
    let output = dir.path().join("golden.json");
    let mut checked = 0;
    for seed in [0x8b45a029u32, 0xa643d711, 0x137efccb, 0xc09d32a1] {
        let command = std::process::Command::new("bun")
            .current_dir(&workspace)
            .args([
                "crates/mc-module/tests/fixtures/agent-fragments-golden.ts",
                "--seed",
                &seed.to_string(),
                "--steps",
                "320",
                "--output",
            ])
            .arg(&output)
            .output()
            .unwrap();
        assert!(
            command.status.success(),
            "{}",
            String::from_utf8_lossy(&command.stderr)
        );
        let cases: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(&output).unwrap()).unwrap();
        assert_eq!(cases.len(), 324);
        for (index, case) in cases.iter().enumerate() {
            let projection = AppliedProjection {
                committed: serde_json::from_value(case["before"]["committed"].clone()).unwrap(),
                fragment_watermark: case["before"]["fragmentWatermark"].as_i64().unwrap(),
                ..Default::default()
            };
            if case["pass"] != "soft" {
                assert_eq!(
                    serde_json::to_value(projection.committed).unwrap(),
                    case["committed"]
                );
                continue;
            }
            let pending: Vec<AgentFragment> =
                serde_json::from_value(case["pending"].clone()).unwrap();
            let (block, actual) = crate::agent_fragments::compose(
                projection,
                &pending,
                case["memoryBudgetTokens"].as_f64().unwrap(),
                case["historyBudgetTokens"].as_f64().unwrap(),
                case["independentTokens"].as_u64().unwrap() as usize,
                case["m0Tokens"].as_u64().unwrap() as usize,
                estimate_tokens,
            );
            assert_eq!(
                block,
                case["block"].as_str().unwrap(),
                "seed {seed} pass {index}"
            );
            assert_eq!(
                serde_json::to_value(actual.committed).unwrap(),
                case["committed"],
                "seed {seed} pass {index}"
            );
        }
        checked += cases.len();
    }
    println!("{checked} newly seeded TS/Pi/Rust cases checked");
}

fn hard_with_stale_host_mural() -> TransformResponse {
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
        .unwrap();
    let id = s
        .insert_memory(memory_input("git:proj", "CONSTRAINTS", "NO", 0))
        .unwrap();
    let mut request = req(
        "ses",
        "cfg0",
        vec![item("a", 1, "raw"), item("tail", 2, "tail")],
    );
    request.serializer_profile = "opencode-aisdk".into();
    request.auto_search_enabled = false;
    request.mural = Some(crate::m0_compose::M0MuralInput {
        enabled: true,
        supports_vision: true,
        data_url: Some(format!("data:image/png;base64,{NO_GLYPH_PNG}")),
        content_hash: Some("host-snapshot-NO".into()),
    });
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    let first = transform(&s, &request, &ctx).unwrap();
    s.with_context_conn_for_test(|conn| {
        conn.execute(
            "UPDATE memories SET content='YES',revision=revision+1 WHERE id=?1",
            [id],
        )
    })
    .unwrap();
    let deferred = transform(&s, &request, &ctx).unwrap();
    assert_eq!(
        serde_json::to_vec(deferred.messages()).unwrap(),
        serde_json::to_vec(first.messages()).unwrap()
    );
    s.arm_soft_refresh("ses").unwrap();
    let soft = transform(&s, &request, &ctx).unwrap();
    assert_eq!(soft.action, "SOFT");
    assert_eq!(m0_bytes(&soft), m0_bytes(&first));
    assert!(serde_json::to_string(soft.messages())
        .unwrap()
        .contains(NO_GLYPH_PNG));
    request.render_config = "independent-hard".into();
    let hard = transform(&s, &request, &ctx).unwrap();
    assert_eq!(hard.action, "HARD");
    assert!(m0_bytes(&hard).contains("#1: YES"));
    hard
}

// This PNG visibly spells NO, representing a host image rendered before the row changed.
const NO_GLYPH_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAACmElEQVR4nO2cwQ3AQAyDuv/S7RC2gpDLAvjI/54n4IWgNideJa2DXYamvEpaB7sMTXmVtA52GZryKmkd7DI05VXSOthlaMqrpHWwy9CUV0nrYJehKa+S1sEuQ1NeJa2DXYamvEpaB7sMTXmVtA52GZryKmkd7DI05VXSOthlaMqrpHWwy9CUV0nrYJehKa+S1sEuQ1NeJa2DXYamvEpaB7sMTXmVtA52GZryzrF2YMqLsRaa8mKshaa8GGuhKS/GWmjKi7EWmvJirIWmvBhroSkvxlpoyouxFpryYqyFprwYa6EpL8ZaaMqLsRaa8mKshaa8GGuhKS/GWmjKi7EWmvJirIWmvBhroSlvhHE0tdnYSjma2mxspRxNbTa2Uo6mNhtbKUdTm42tlKOpzcZWytHUZmMr5Whqs7GVcjS12dhKOZrabGylHE1tNrZSjqY2G1spR1Obja2Uo6nNxlbK0dRmYyvlaGqzsZVyNLXZ2Eo5mtpsbKUcTW02tlKOpjYbW/0foQm8Eclo6sFr3ohkNPXgNW9EMpp68Jo3IhlNPXjNG5GMph685o1IRlMPXvNGJKOpB695I5LR1IPXvBHJaOrBa96IZDT14DVvRDKaevCaNyIZTT14zRuRjKYevOaNSEZTD17zRiSjqQeveSOS0dSD17wRyWjqwWveiGQ09eA1b0QymnrwmjciGU09mPIqaR3sMjTlVdI62GVoyqukdbDL0JRXSetgl6Epr5LWwS5DU14lrYNdhqa8SloHuwxNeZW0DnYZmvIqaR3sMjTlVdI62GVoyqukdbDL0JRXSetgl6Epr5LWwS5DU14lrYNdhqa8SloHuwxNeZW0DnYZmvIqaR3sMjTlVdI62GVoyqukdbDL0JSX4gOR57lX6Kr2/QAAAABJRU5ErkJggg==";

#[test]
fn review_stale_host_mural_is_frozen_on_soft_but_accepted_at_hard() {
    let hard = hard_with_stale_host_mural();
    assert!(serde_json::to_string(hard.messages())
        .unwrap()
        .contains(NO_GLYPH_PNG));
}

#[test]
// The host mural has no source revision manifest. S7 must add and validate that
// wire field before HARD can reject an image rendered from stale memory revisions.
#[ignore = "S7 host-manifest gap: HARD mural/text source revision coherence is not enforced yet"]
fn review_hard_requires_mural_revision_coherence() {
    let hard = hard_with_stale_host_mural();
    assert!(!serde_json::to_string(hard.messages()).unwrap().contains(NO_GLYPH_PNG),
        "HARD serves canonical YES beside a host image visibly spelling NO; no revision manifest rejects it");
}

#[test]
fn review_crash_between_row_and_fragment_is_atomic() {
    if let Some(root) = std::env::var_os("MC_REVIEW_CRASH_ROOT") {
        let s = store(std::path::Path::new(&root));
        let _ = s.with_facade_command(
            "/tmp",
            "git:proj",
            "memories",
            "ses",
            "ctx_memory",
            "update",
            Some("crashed-edit"),
            |tx| {
                tx.update_memory_content("git:proj", 1, "uncommitted claim", None, 0)
                    .unwrap();
                // Exit without destructors after the row write and before recording its fragment.
                std::process::exit(73);
            },
        );
        unreachable!();
    }
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    let id = s
        .insert_memory(memory_input("git:proj", "CONSTRAINTS", "original claim", 0))
        .unwrap();
    assert_eq!(id, 1);
    drop(s);
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "transform::tests::memory_cache_review::review_crash_between_row_and_fragment_is_atomic", "--nocapture"])
        .env("MC_REVIEW_CRASH_ROOT", dir.path()).output().unwrap();
    assert_eq!(
        child.status.code(),
        Some(73),
        "{}",
        String::from_utf8_lossy(&child.stderr)
    );
    let s = store(dir.path());
    s.with_context_conn_for_test(|conn| {
        let content: String =
            conn.query_row("SELECT content FROM memories WHERE id=1", [], |row| {
                row.get(0)
            })?;
        assert_eq!(content, "original claim");
        for table in [
            "memory_history",
            "memory_mutation_log",
            "memory_agent_fragments",
        ] {
            let count: i64 =
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?;
            assert_eq!(count, 0, "{table} survived an uncommitted crash");
        }
        Ok(())
    })
    .unwrap();
}

fn noprop_automated(s: &McStore, kind: u32, step: usize) {
    let hash = s.get_memory_full(7).unwrap().unwrap().normalized_hash;
    s.with_facade_command(
        "/tmp",
        "git:proj",
        "memories",
        "ses",
        "memory.curate",
        "review",
        Some(&format!("noprop:{step}")),
        |agent_tx| {
            let tx = agent_tx.automated();
            match kind {
                2 => {
                    tx.archive_memories("git:proj", &[4], Some("obsolete"), 2)
                        .map_err(|e| e.to_string())?;
                }
                3 => {
                    tx.merge_memories_canonical(
                        "git:proj",
                        &[5, 6],
                        "Merged automated claim.",
                        Some("ses"),
                        2,
                    )
                    .map_err(|e| e.to_string())?;
                }
                4 => {
                    tx.set_memory_verification(
                        "git:proj",
                        &[mc_store::VerificationUpdate {
                            memory_id: 7,
                            content_hash_at_prompt: hash,
                            verification_status: "archive".into(),
                            updated_content: None,
                            archive_reason: Some("obsolete".into()),
                        }],
                        2,
                    )?;
                }
                _ => {
                    tx.update_memory_content(
                        "git:proj",
                        2,
                        &format!("Automated claim {step}."),
                        None,
                        2,
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            Ok(Vec::new())
        },
    )
    .unwrap();
}

#[test]
fn noprop_randomized_automated_vs_delayed_served_bytes() {
    if std::env::var("MC_NOPROP_REVIEW").as_deref() != Ok("1") {
        return;
    }
    let mut counts = [0usize; 3];
    for seed in [0x941aac21u32, 0x287cf89b, 0xb41c137e, 0x1799fdd3] {
        let dirs = [tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap()];
        let actual = store(dirs[0].path());
        let delayed = store(dirs[1].path());
        for s in [&actual, &delayed] {
            s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
                .unwrap();
            for text in [
                "Agent baseline.",
                "Automated baseline.",
                "Spare baseline.",
                "Archive baseline.",
                "Merge first.",
                "Merge second.",
                "Verify baseline.",
            ] {
                s.insert_memory(memory_input("git:proj", "CONSTRAINTS", text, 0))
                    .unwrap();
            }
        }
        let mut request = req(
            "ses",
            "cfg0",
            vec![item("a", 1, "raw"), item("tail", 2, "tail")],
        );
        request.auto_search_enabled = false;
        let ctx = pctx("git:proj", "/nonexistent-docs", 0);
        let mut previous = transform(&actual, &request, &ctx).unwrap();
        assert_eq!(
            serde_json::to_vec(previous.messages()).unwrap(),
            serde_json::to_vec(transform(&delayed, &request, &ctx).unwrap().messages()).unwrap()
        );
        let mut rng = seed;
        let mut next = || {
            rng ^= rng << 13;
            rng ^= rng >> 17;
            rng ^= rng << 5;
            rng
        };
        let mut pending = Vec::new();
        for step in 0..80 {
            let kind = if step < 3 { step as u32 + 2 } else { 0 };
            let before = actual.load_agent_fragments("ses", 0).unwrap().len();
            noprop_automated(&actual, kind, step);
            assert_eq!(actual.load_agent_fragments("ses", 0).unwrap().len(), before);
            pending.push((kind, step));
            if next() % 2 == 0 {
                let owner = if next() % 2 == 0 { "ses" } else { "foreign" };
                for s in [&actual, &delayed] {
                    edit(
                        s,
                        owner,
                        1,
                        &format!("Agent correction {step} & <quoted>."),
                        &format!("agent:{step}"),
                    )
                    .unwrap();
                }
            }
            let pass = if step == 79 { 2 } else { next() % 3 };
            counts[pass as usize] += 1;
            if pass == 2 {
                for (kind, queued) in pending.drain(..) {
                    noprop_automated(&delayed, kind, queued);
                }
                request.render_config = format!("natural-{seed}-{step}");
            } else if pass == 1 {
                actual.arm_soft_refresh("ses").unwrap();
                delayed.arm_soft_refresh("ses").unwrap();
            }
            let served = transform(&actual, &request, &ctx).unwrap();
            let oracle = transform(&delayed, &request, &ctx).unwrap();
            assert_eq!(
                serde_json::to_vec(served.messages()).unwrap(),
                serde_json::to_vec(oracle.messages()).unwrap(),
                "seed {seed}, step {step}"
            );
            assert_eq!(served.action, ["SOFT+", "SOFT", "HARD"][pass as usize]);
            if pass == 0 {
                assert_eq!(
                    serde_json::to_vec(served.messages()).unwrap(),
                    serde_json::to_vec(previous.messages()).unwrap()
                );
            }
            if pass == 1 {
                assert_eq!(m0_bytes(&served), m0_bytes(&previous));
            }
            previous = served;
        }
        actual
            .with_context_conn_for_test(|conn| {
                assert_eq!(
                    conn.query_row("SELECT COUNT(*) FROM memory_tool_proposals", [], |row| row
                        .get::<_, i64>(
                        0
                    ))?,
                    0
                );
                for id in [4, 5, 6, 7] {
                    assert_eq!(
                        conn.query_row(
                            "SELECT COUNT(*) FROM memory_history WHERE memory_id=?1",
                            [id],
                            |row| row.get::<_, i64>(0)
                        )?,
                        1
                    );
                }
                Ok(())
            })
            .unwrap();
    }
    assert!(counts.iter().all(|count| *count > 0));
    println!("noprop Rust differential: 320 passes; defer/SOFT/HARD={counts:?}");
}

#[test]
fn noprop_agent_m1_fingerprint_matches_baseline() {
    if std::env::var("MC_NOPROP_REVIEW").as_deref() != Ok("1") {
        return;
    }
    use sha2::{Digest, Sha256};
    let dir = tempfile::tempdir().unwrap();
    let s = store(dir.path());
    s.replace_compartments("ses", &[comp(1, 1, 1, "a", "SUMMARY")])
        .unwrap();
    let id = s
        .insert_memory(memory_input(
            "git:proj",
            "CONSTRAINTS",
            "Agent baseline.",
            0,
        ))
        .unwrap();
    let mut request = req(
        "ses",
        "cfg0",
        vec![item("a", 1, "raw"), item("tail", 2, "tail")],
    );
    request.auto_search_enabled = false;
    let ctx = pctx("git:proj", "/nonexistent-docs", 0);
    transform(&s, &request, &ctx).unwrap();
    let mut output = Vec::new();
    for step in 0..24 {
        edit(
            &s,
            "ses",
            id,
            &format!("Agent claim {step} & <quoted>."),
            &format!("agent:{step}"),
        )
        .unwrap();
        s.arm_soft_refresh("ses").unwrap();
        let served = transform(&s, &request, &ctx).unwrap();
        assert_eq!(served.action, "SOFT");
        assert!(m1_bytes(&served).contains("<updated id=\"1\""));
        output.push(m1_bytes(&served).to_string());
    }
    let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&output).unwrap()));
    assert_eq!(
        hash,
        "31d496e40cc01df9e0d9c19052511472d06b968d9ea41a180362659e988ccae9"
    );
    println!("noprop Rust agent m[1] SHA256 {hash}");
}
