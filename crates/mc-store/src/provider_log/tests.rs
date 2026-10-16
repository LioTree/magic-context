use super::*;
use crate::{open_sqlite, register_legacy_trigger_functions, MIGRATIONS, NS};
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};

fn descriptor(dir: &std::path::Path) -> StorageDescriptor {
    StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: NS.into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.join("store.db").to_string_lossy().into_owned(),
        },
    }
}
fn key() -> ProviderSessionKey {
    ProviderSessionKey {
        generation: None,
        project_root: "/project".into(),
        session: "session".into(),
        harness: "opencode".into(),
    }
}
fn store(dir: &std::path::Path) -> McStore {
    let store = McStore::open_for_test(&descriptor(dir)).unwrap();
    store
        .save_provider_conversation(
            &key(),
            &ProviderConversation {
                engine_namespace: "engine".into(),
                params_json: "{}".into(),
                hook_counters_json: "{}".into(),
                historian_model_chain_json: "[]".into(),
                ..Default::default()
            },
        )
        .unwrap();
    store
}
fn lineage(id: &str, first: u64) -> ProviderLineage {
    ProviderLineage {
        lineage_id: id.into(),
        first_ordinal: first,
        descends_from: None,
        through_ordinal: None,
    }
}
fn message(ordinal: u64) -> ProviderMessage {
    ProviderMessage {
        ordinal,
        mid: format!("m{ordinal}"),
        message_bytes: format!("{{ \"text\" : \"résumé \\u0061\", \"n\": {ordinal} }}")
            .into_bytes(),
    }
}
fn subject(mid: &str, part: &str) -> ProviderSubject {
    ProviderSubject {
        subject_mid: mid.into(),
        hook: "post_tool".into(),
        subject_part: part.into(),
    }
}
fn hook(
    store: &McStore,
    l: &ProviderLineage,
    m: &ProviderMessage,
    part: &str,
    served: Option<u64>,
    repeat: bool,
) -> i64 {
    let s = subject(&m.mid, part);
    store
        .commit_provider_hook(
            &key(),
            ProviderHookRequest {
                lineage: l,
                message: Some(m),
                served_through_ordinal: served,
                unserved_subjects: &[],
                repeat_subject: repeat.then_some(&s),
            },
            |ctx| {
                let number = ctx.tag_high_water + 1;
                Ok((
                    ProviderHookWrite {
                        answer: Some(ProviderHookAnswer {
                            subject: s.clone(),
                            ordinal: m.ordinal,
                            ops_json: "[]".into(),
                            tags: vec![ProviderAnswerTag {
                                number,
                                block_id: format!("{}#{part}", m.mid),
                                kind: "tool_result".into(),
                                source: "payload".into(),
                                token_count: 2,
                                created_at_ms: 10,
                            }],
                        }),
                        counters: ctx.counters.clone(),
                        policy_summary: None,
                    },
                    number,
                ))
            },
        )
        .unwrap()
}

#[test]
fn tag_high_water_survives_conversation_and_counter_resets() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let l = lineage("L", 0);
    assert_eq!(hook(&store, &l, &message(0), "a", None, false), 1);
    let mut reset = store.load_provider_conversation(&key()).unwrap().unwrap();
    reset.hook_counters_json = "{}".into();
    store.save_provider_conversation(&key(), &reset).unwrap();
    assert_eq!(hook(&store, &l, &message(1), "a", None, false), 2);
    store
        .update_provider_hook_counters(&key(), |c| *c = json!({}))
        .unwrap();
    assert_eq!(hook(&store, &l, &message(2), "a", None, false), 3);
    store
        .commit_provider_hook(
            &key(),
            ProviderHookRequest {
                lineage: &l,
                message: None,
                served_through_ordinal: None,
                unserved_subjects: &[],
                repeat_subject: None,
            },
            |_| {
                Ok((
                    ProviderHookWrite {
                        answer: None,
                        counters: json!({}),
                        policy_summary: None,
                    },
                    (),
                ))
            },
        )
        .unwrap();
    assert_eq!(hook(&store, &l, &message(3), "a", None, false), 4);
}

#[test]
fn tag_allocation_at_or_below_reserved_session_high_water_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    store
        .update_provider_hook_counters(&key(), |c| c["reserved_tag_high_water"] = json!(40))
        .unwrap();
    let l = lineage("L", 0);
    for number in [39, 40] {
        let m = message(0);
        let result = store.commit_provider_hook(
            &key(),
            ProviderHookRequest {
                lineage: &l,
                message: Some(&m),
                served_through_ordinal: None,
                unserved_subjects: &[],
                repeat_subject: None,
            },
            |_| {
                Ok((
                    ProviderHookWrite {
                        answer: Some(ProviderHookAnswer {
                            subject: subject(&m.mid, "a"),
                            ordinal: 0,
                            ops_json: "[]".into(),
                            tags: vec![ProviderAnswerTag {
                                number,
                                block_id: "m0#a".into(),
                                kind: "tool_result".into(),
                                source: "payload".into(),
                                token_count: 2,
                                created_at_ms: 10,
                            }],
                        }),
                        counters: json!({}),
                        policy_summary: None,
                    },
                    (),
                ))
            },
        );
        assert!(
            matches!(result, Err(ProviderError::Transient(ref text)) if text == "tag allocation must advance its high water"),
            "{result:?}"
        );
        assert!(store.load_provider_hook_answers(&key()).unwrap().is_empty());
        assert!(store
            .load_provider_messages(&key(), "L")
            .unwrap()
            .is_empty());
    }
    assert_eq!(hook(&store, &l, &message(0), "a", None, false), 41);
}

#[test]
fn v65_blob_round_trips_messages_answers_views_pending_drops_and_empty_lineages() {
    let dir = tempfile::tempdir().unwrap();
    let descriptor = descriptor(dir.path());
    let inner = open_sqlite(&descriptor).unwrap();
    inner.with_conn(register_legacy_trigger_functions).unwrap();
    let previous: Vec<_> = MIGRATIONS
        .iter()
        .filter(|migration| migration.version < 66)
        .cloned()
        .collect();
    inner.migrate(NS, &previous).unwrap();
    let view = |v: u64| json!({"compaction_id":"c","version":v,"range":{"lineage_id":"L","from":4000,"to":4001},"replacement":[{"content":"frozen"}]});
    let record = json!({
        "catalog":{"compacting":true,"tools":["ctx_reduce"]},
        "setup":{"request":{"lineage_id":"L","params":{"serializer_profile":"owned-broca"}},"state":{"compaction_id":"c","preset":"head","version_high_water":9,"rebuild_epoch":2,"last_produced":view(9),"last_applied":view(8)},"stability":[{"index":0,"rank":2}],"call_when":{"usage":0.7}},
        "hook":{"high_water":12,"answers":[{"subject":"digest","lineage":"L","answer":{"ops":[{"op":"prepend","text":"§12§ "}]},"rendered":["§12§ payload"],"tags":[12],"cadence":true,"observed":false,"tool_call_id":"repeat"},{"subject":"seen","lineage":null,"answer":"pass","rendered":[],"tags":[],"cadence":false,"observed":true,"tool_call_id":null}],"live":{"10":{"lineage":"L","ordinal":4000,"block_id":"m4000#0","kind":"text","source":"payload"}},"burned":[11],"observed_tools":6,"last_reminder_at":5,"observed_users":2,"last_nudge_at":null},
        "messages":{"L":{"4000":{"ordinal":4000,"mid":"m4000","message":{"role":"user","content":[{"type":"text","text":"résumé"}]}}},"empty":{}},
        "pending_drops":[10,12],"last_answer":{"request_id":"r","answer":"noop"},"wait_request":"wait","wait_view":view(7),"future_field":{"keep":true}
    });
    inner
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO mc_provider_sessions_v1 VALUES (?1,?2,?3,?4)",
                params![
                    key().project_root,
                    key().session,
                    key().harness,
                    record.to_string()
                ],
            )?;
            Ok(())
        })
        .unwrap();
    drop(inner);
    let store = McStore::open_for_test(&descriptor).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&store.load_provider_record(&key()).unwrap().unwrap())
            .unwrap(),
        record
    );
    let c = store.load_provider_conversation(&key()).unwrap().unwrap();
    assert!(c.engine_namespace.starts_with("mc-provider:"));
    assert_eq!(c.version_high_water, 9);
    store
        .inner
        .with_conn(|conn| {
            let policies: Vec<String> = conn
                .prepare("SELECT policy_json FROM mc_provider_hook_answers_v1 WHERE conv_key=?1")?
                .query_map([key().conversation_key()], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            assert_eq!(policies, vec!["{}".to_string(); 2]);
            Ok(())
        })
        .unwrap();
    assert_eq!(store.provider_frontier(&key(), "L").unwrap(), 4001);
    store
        .save_provider_record(&key(), &record.to_string(), &c.engine_namespace, &[])
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&store.load_provider_record(&key()).unwrap().unwrap())
            .unwrap(),
        record
    );
    drop(store);
    let reopened = McStore::open_for_test(&descriptor).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&reopened.load_provider_record(&key()).unwrap().unwrap())
            .unwrap(),
        record
    );
    reopened
        .inner
        .with_conn(|conn| {
            assert_eq!(
                conn.query_row("SELECT record FROM mc_provider_sessions_v1", [], |r| r
                    .get::<_, String>(
                    0
                ))?,
                record.to_string()
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn message_bytes_are_verbatim_and_conflicts_refuse_without_partial_writes() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let l = lineage("L", 4000);
    let m = message(4000);
    store
        .commit_provider_status(&key(), &l, std::slice::from_ref(&m), None, &[])
        .unwrap();
    store
        .commit_provider_status(&key(), &l, std::slice::from_ref(&m), None, &[])
        .unwrap();
    assert_eq!(
        store.load_provider_messages(&key(), "L").unwrap(),
        vec![m.clone()]
    );
    let mut different = m.clone();
    different.message_bytes =
        serde_json::to_vec(&serde_json::from_slice::<Value>(&m.message_bytes).unwrap()).unwrap();
    assert!(
        matches!(store.commit_provider_status(&key(),&l,&[different],None,&[]),Err(ProviderError::Transient(reason)) if reason=="an ingested ordinal changed")
    );
    let mut different = m.clone();
    different.mid = "other".into();
    assert!(matches!(
        store.commit_provider_status(&key(), &l, &[message(4001), different], None, &[]),
        Err(ProviderError::InvalidParams {
            field: "subject_ordinal"
        })
    ));
    let mut different = m.clone();
    different.ordinal = 4001;
    assert!(matches!(
        store.commit_provider_status(&key(), &l, &[different], None, &[]),
        Err(ProviderError::InvalidParams {
            field: "subject_mid"
        })
    ));
    assert_eq!(store.load_provider_messages(&key(), "L").unwrap(), vec![m]);
}

#[test]
fn absolute_frontier_is_complete_at_4010_and_reports_a_real_hole() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let l = lineage("L", 4000);
    let entries = (4000..=4010)
        .filter(|n| *n != 4005)
        .map(message)
        .collect::<Vec<_>>();
    store
        .commit_provider_status(&key(), &l, &entries, None, &[])
        .unwrap();
    assert_eq!(store.provider_frontier(&key(), "L").unwrap(), 4005);
    store
        .commit_provider_status(&key(), &l, &[message(4005)], None, &[])
        .unwrap();
    assert_eq!(store.provider_frontier(&key(), "L").unwrap(), 4011);
}

#[test]
fn pending_answers_promote_only_after_confirmation_and_retries_burn_only_one_part() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let l = lineage("L", 0);
    let m = message(0);
    let first = hook(&store, &l, &m, "p1", None, false);
    let second = hook(&store, &l, &m, "p2", None, false);
    assert!(store.load_tags_for_session("engine").unwrap().is_empty());
    store
        .queue_provider_drops(&key(), &[first, second])
        .unwrap();
    let third = hook(&store, &l, &m, "p1", None, true);
    assert_eq!(
        store.load_provider_pending_drops(&key()).unwrap(),
        vec![second]
    );
    assert!(store.queue_provider_drops(&key(), &[first]).is_err());
    store
        .commit_provider_status(&key(), &l, &[], Some(0), &[])
        .unwrap();
    let numbers = store
        .load_tags_for_session("engine")
        .unwrap()
        .iter()
        .map(|t| t.tag_number)
        .collect::<Vec<_>>();
    assert_eq!(numbers, vec![second, third]);
    assert_eq!(
        store
            .load_provider_hook_answers(&key())
            .unwrap()
            .iter()
            .map(|a| a.state.as_str())
            .collect::<Vec<_>>(),
        vec!["burned", "live", "live"]
    );
}

#[test]
fn conflicting_status_refuses_before_promote_and_burn() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let l = lineage("L", 0);
    let m = message(0);
    hook(&store, &l, &m, "p1", None, false);
    let mut conflict = m.clone();
    conflict.mid = "other".into();
    assert!(store
        .commit_provider_status(&key(), &l, &[conflict], Some(0), &[subject(&m.mid, "p1")])
        .is_err());
    assert_eq!(
        store.load_provider_hook_answers(&key()).unwrap()[0].state,
        "pending"
    );
    assert!(store.load_tags_for_session("engine").unwrap().is_empty());
}

#[test]
fn final_status_gap_rolls_back_admission_and_acknowledgement_in_the_conflict_fence() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let l = lineage("L", 1);
    hook(&store, &l, &message(1), "p1", None, false);
    let before = serde_json::to_value(store.load_provider_conversation(&key()).unwrap()).unwrap();
    assert_eq!(
        store
            .commit_provider_status_page(
                &key(),
                ProviderStatusPage {
                    lineage: &l,
                    messages: &[message(3)],
                    served: Some(3),
                    unserved: &[subject("m1", "p1")],
                    newest: Some(3),
                    more: false
                }
            )
            .unwrap(),
        Some(2)
    );
    assert_eq!(
        store.load_provider_messages(&key(), "L").unwrap(),
        vec![message(1)]
    );
    assert_eq!(
        store.load_provider_hook_answers(&key()).unwrap()[0].state,
        "pending"
    );
    assert!(store.load_tags_for_session("engine").unwrap().is_empty());
    assert_eq!(
        serde_json::to_value(store.load_provider_conversation(&key()).unwrap()).unwrap(),
        before
    );
    let mut conflict = message(1);
    conflict.mid = "other".into();
    assert!(matches!(
        store.commit_provider_status_page(
            &key(),
            ProviderStatusPage {
                lineage: &l,
                messages: &[message(3), conflict],
                served: Some(3),
                unserved: &[],
                newest: Some(3),
                more: false
            }
        ),
        Err(ProviderError::InvalidParams {
            field: "subject_ordinal"
        })
    ));
    assert_eq!(
        store.load_provider_messages(&key(), "L").unwrap(),
        vec![message(1)]
    );
}

#[test]
fn acknowledgements_are_bounded_monotone_and_missing_never_promotes() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let l = lineage("L", 4000);
    hook(&store, &l, &message(4000), "p", None, false);
    assert!(matches!(
        store.commit_provider_status(&key(), &l, &[], Some(4001), &[]),
        Err(ProviderError::InvalidParams {
            field: "served_through_ordinal"
        })
    ));
    assert_eq!(
        store.load_provider_hook_answers(&key()).unwrap()[0].state,
        "pending"
    );
    store
        .commit_provider_status(&key(), &l, &[], Some(4000), &[])
        .unwrap();
    hook(&store, &l, &message(4001), "p", None, false);
    assert_eq!(
        store
            .load_provider_conversation(&key())
            .unwrap()
            .unwrap()
            .served_through_ordinal,
        Some(4000)
    );
    assert_eq!(
        store.load_provider_hook_answers(&key()).unwrap()[1].state,
        "pending"
    );
    assert!(matches!(
        store.commit_provider_status(&key(), &l, &[], Some(3999), &[subject("m4001", "p")]),
        Err(ProviderError::InvalidParams {
            field: "served_through_ordinal"
        })
    ));
    assert_eq!(
        store.load_provider_hook_answers(&key()).unwrap()[1].state,
        "pending"
    );
    assert_eq!(store.load_tags_for_session("engine").unwrap().len(), 1);
}

#[test]
fn acknowledgement_decreases_only_in_the_transaction_creating_a_descent() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let root = lineage("L", 4000);
    store
        .commit_provider_status(
            &key(),
            &root,
            &[message(4000), message(4001), message(4002)],
            Some(4002),
            &[],
        )
        .unwrap();
    let child = ProviderLineage {
        lineage_id: "child".into(),
        first_ordinal: 4001,
        descends_from: Some("L".into()),
        through_ordinal: Some(4000),
    };
    store
        .commit_provider_status(&key(), &child, &[], Some(4000), &[])
        .unwrap();
    assert_eq!(
        store
            .load_provider_conversation(&key())
            .unwrap()
            .unwrap()
            .served_through_ordinal,
        Some(4000)
    );
    store
        .commit_provider_status(&key(), &child, &[message(4001)], Some(4001), &[])
        .unwrap();
    assert!(matches!(
        store.commit_provider_status(&key(), &child, &[], Some(4000), &[]),
        Err(ProviderError::InvalidParams {
            field: "served_through_ordinal"
        })
    ));
}

#[test]
fn view_state_changes_only_state_and_refuses_missing_or_illegal_transitions() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let original = ProviderView {
        version: 7,
        lineage_id: "L".into(),
        range_from: 4000,
        range_to: 4001,
        replacement_json: "[ { \"text\" : \"résumé \\u0061\" } ]".into(),
        state: "produced".into(),
    };
    store.save_provider_view(&key(), &original).unwrap();
    for state in ["applied", "applied", "not_applied", "not_applied"] {
        store.set_provider_view_state(&key(), 7, state).unwrap();
        let mut expected = original.clone();
        expected.state = state.into();
        assert_eq!(store.load_provider_views(&key()).unwrap(), vec![expected]);
    }
    assert!(store
        .set_provider_view_state(&key(), 7, "produced")
        .unwrap_err()
        .to_string()
        .contains("state"));
    assert!(store
        .set_provider_view_state(&key(), 7, "applied")
        .unwrap_err()
        .to_string()
        .contains("state"));
    assert!(store
        .set_provider_view_state(&key(), 8, "applied")
        .unwrap_err()
        .to_string()
        .contains("version"));
    assert_eq!(
        store.load_provider_views(&key()).unwrap()[0].replacement_json,
        original.replacement_json
    );
}

#[test]
fn descent_shares_prefix_without_copying_and_burns_module_ahead_allocations() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let l = lineage("L", 4000);
    let a = hook(&store, &l, &message(4000), "p1", None, false);
    let b = hook(&store, &l, &message(4001), "p2", None, false);
    store.queue_provider_drops(&key(), &[a, b]).unwrap();
    let child = ProviderLineage {
        lineage_id: "child".into(),
        first_ordinal: 4001,
        descends_from: Some("L".into()),
        through_ordinal: Some(4000),
    };
    let mut m = message(4001);
    m.mid = "replacement".into();
    hook(&store, &child, &m, "p3", Some(4000), false);
    assert_eq!(
        store.load_provider_messages(&key(), "child").unwrap(),
        vec![message(4000), m]
    );
    assert_eq!(store.provider_frontier(&key(), "child").unwrap(), 4002);
    assert_eq!(
        store
            .load_tags_for_session("engine")
            .unwrap()
            .iter()
            .map(|t| t.tag_number)
            .collect::<Vec<_>>(),
        vec![a]
    );
    assert_eq!(store.load_provider_pending_drops(&key()).unwrap(), vec![a]);
    assert_eq!(
        store.load_provider_hook_answers(&key()).unwrap()[1].state,
        "burned"
    );
    store
        .inner
        .with_conn(|conn| {
            assert_eq!(
                conn.query_row("SELECT count(*) FROM mc_provider_messages_v1", [], |r| r
                    .get::<_, i64>(0))?,
                3
            );
            Ok(())
        })
        .unwrap();
    let bad = ProviderLineage {
        lineage_id: "bad".into(),
        first_ordinal: 4011,
        descends_from: Some("child".into()),
        through_ordinal: Some(4010),
    };
    assert!(store
        .commit_provider_status(&key(), &bad, &[], Some(4010), &[])
        .is_err());
}

#[test]
fn failed_counter_write_rolls_back_ingest_promotion_answer_and_tags() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let l = lineage("L", 0);
    hook(&store, &l, &message(0), "p1", None, false);
    store.inner.with_conn(|conn|conn.execute_batch("CREATE TEMP TRIGGER fail_counter BEFORE UPDATE OF hook_counters_json ON mc_provider_conversations_v2 BEGIN SELECT RAISE(ABORT,'counter failure'); END;")).unwrap();
    assert!(store
        .commit_provider_status(&key(), &l, &[message(1)], Some(0), &[])
        .is_err());
    assert_eq!(
        store.load_provider_messages(&key(), "L").unwrap(),
        vec![message(0)]
    );
    assert_eq!(
        store.load_provider_hook_answers(&key()).unwrap()[0].state,
        "pending"
    );
    assert!(store.load_tags_for_session("engine").unwrap().is_empty());
}

#[test]
fn hook_path_writes_one_transaction_without_blob_rewrite() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let l = lineage("L", 0);
    store.inner.with_conn(|conn| {
        // Counter triggers observe the actual tables, including rollback blobs;
        // they cannot pass merely because a preferred API was not called.
        conn.execute("INSERT INTO mc_provider_sessions_v1 VALUES ('/project','session','opencode','{}')",[])?;
        conn.execute_batch("CREATE TEMP TABLE hook_writes(kind TEXT);
            CREATE TEMP TRIGGER count_message AFTER INSERT ON mc_provider_messages_v1 BEGIN INSERT INTO hook_writes VALUES ('message'); END;
            CREATE TEMP TRIGGER count_message_rewrite AFTER UPDATE ON mc_provider_messages_v1 BEGIN INSERT INTO hook_writes VALUES ('rewrite'); END;
            CREATE TEMP TRIGGER count_answer AFTER INSERT ON mc_provider_hook_answers_v1 BEGIN INSERT INTO hook_writes VALUES ('answer'); END;
            CREATE TEMP TRIGGER count_counter AFTER UPDATE ON mc_provider_conversations_v2 BEGIN INSERT INTO hook_writes VALUES ('counter'); END;
            CREATE TEMP TRIGGER count_blob_insert AFTER INSERT ON mc_provider_sessions_v1 BEGIN INSERT INTO hook_writes VALUES ('blob'); END;
            CREATE TEMP TRIGGER count_blob_update AFTER UPDATE ON mc_provider_sessions_v1 BEGIN INSERT INTO hook_writes VALUES ('blob'); END;
            CREATE TEMP TRIGGER count_record_update AFTER UPDATE OF record_json ON mc_provider_conversations_v2 BEGIN INSERT INTO hook_writes VALUES ('blob'); END;")?;
        Ok(())
    }).unwrap();
    hook(&store, &l, &message(0), "p1", None, false);
    store.inner.with_conn(|conn| {
        let writes=conn.prepare("SELECT kind FROM hook_writes ORDER BY kind")?.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(writes,vec!["answer","counter","message"],"unexpected hook durable writes");
        conn.execute_batch("DELETE FROM hook_writes; CREATE TEMP TRIGGER fail_final_write BEFORE UPDATE OF hook_counters_json ON mc_provider_conversations_v2 BEGIN SELECT RAISE(ABORT,'final write failure'); END;")?;
        Ok(())
    }).unwrap();
    // Failure at the final write proves all counted writes share its transaction.
    assert!(store
        .commit_provider_status(&key(), &l, &[message(1)], Some(0), &[])
        .is_err());
    assert_eq!(
        store.load_provider_messages(&key(), "L").unwrap(),
        vec![message(0)]
    );
    assert_eq!(
        store.load_provider_hook_answers(&key()).unwrap()[0].state,
        "pending"
    );
    assert!(store.load_tags_for_session("engine").unwrap().is_empty());
    store
        .inner
        .with_conn(|conn| {
            assert_eq!(
                conn.query_row("SELECT count(*) FROM hook_writes", [], |r| r
                    .get::<_, i64>(0))?,
                0
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn views_are_frozen_at_a_version_and_only_application_state_changes() {
    let dir = tempfile::tempdir().unwrap();
    let store = store(dir.path());
    let mut view = ProviderView {
        version: 1,
        lineage_id: "L".into(),
        range_from: 4000,
        range_to: 4001,
        replacement_json: r#"[ {"frozen":true} ]"#.into(),
        state: "produced".into(),
    };
    store.save_provider_view(&key(), &view).unwrap();
    view.state = "applied".into();
    store.save_provider_view(&key(), &view).unwrap();
    assert_eq!(
        store.load_provider_views(&key()).unwrap(),
        vec![view.clone()]
    );
    view.replacement_json = "[]".into();
    assert!(store.save_provider_view(&key(), &view).is_err());
    assert_eq!(
        store.load_provider_views(&key()).unwrap()[0].replacement_json,
        r#"[ {"frozen":true} ]"#
    );
}

fn late_descent_fixture(
    dir: &std::path::Path,
) -> (
    McStore,
    ProviderSessionKey,
    ProviderLineage,
    ProviderLineage,
) {
    let store = McStore::open_for_test(&descriptor(dir)).unwrap();
    let key = ProviderSessionKey {
        harness: "claude-code".into(),
        generation: Some(crate::provider_records::ProviderGeneration {
            profile: "profile".into(),
            provider: "provider".into(),
        }),
        ..key()
    };
    store
        .save_provider_conversation(
            &key,
            &ProviderConversation {
                native_pins_json: Some(
                    json!({"profile_generation":"profile","provider_generation":"provider"})
                        .to_string(),
                ),
                native_plan_json: Some("{}".into()),
                engine_namespace: "engine".into(),
                lineage_id: "parent".into(),
                ..Default::default()
            },
        )
        .unwrap();
    let parent = lineage("parent", 0);
    store
        .commit_provider_status(&key, &parent, &[message(0)], None, &[])
        .unwrap();
    let child = lineage("child", 0);
    store.start_provider_root_lineage(&key, &child).unwrap();
    store
        .save_provider_conversation(
            &key,
            &ProviderConversation {
                native_pins_json: Some(
                    json!({"profile_generation":"profile","provider_generation":"provider"})
                        .to_string(),
                ),
                native_plan_json: Some("{}".into()),
                engine_namespace: "engine".into(),
                lineage_id: "child".into(),
                setup_json: Some("{}".into()),
                ..Default::default()
            },
        )
        .unwrap();
    store
        .save_provider_view(
            &key,
            &ProviderView {
                version: 4,
                lineage_id: "child".into(),
                range_from: 0,
                range_to: 0,
                replacement_json: "[]".into(),
                state: "applied".into(),
            },
        )
        .unwrap();
    let descendant = ProviderLineage {
        first_ordinal: 1,
        descends_from: Some("parent".into()),
        through_ordinal: Some(0),
        ..child.clone()
    };
    (store, key, child, descendant)
}

fn late_hook(
    store: &McStore,
    key: &ProviderSessionKey,
    child: &ProviderLineage,
    message: &ProviderMessage,
    ops: &str,
    tagged: bool,
) {
    store
        .commit_provider_hook(
            key,
            ProviderHookRequest {
                lineage: child,
                message: Some(message),
                served_through_ordinal: None,
                unserved_subjects: &[],
                repeat_subject: None,
            },
            |ctx| {
                Ok((
                    ProviderHookWrite {
                        answer: Some(ProviderHookAnswer {
                            subject: subject(&message.mid, ""),
                            ordinal: message.ordinal,
                            ops_json: ops.into(),
                            tags: if tagged {
                                vec![ProviderAnswerTag {
                                    number: 1,
                                    block_id: format!("{}#0", message.mid),
                                    kind: "tool_result".into(),
                                    source: "payload".into(),
                                    token_count: 2,
                                    created_at_ms: 10,
                                }]
                            } else {
                                vec![]
                            },
                        }),
                        counters: ctx.counters.clone(),
                        policy_summary: None,
                    },
                    (),
                ))
            },
        )
        .unwrap();
}

fn assert_late_refusal(
    store: &McStore,
    key: &ProviderSessionKey,
    child: &ProviderLineage,
    descendant: &ProviderLineage,
    field: &str,
) {
    let before = store
        .load_provider_messages(key, &child.lineage_id)
        .unwrap();
    let conversation =
        serde_json::to_value(store.load_provider_conversation(key).unwrap()).unwrap();
    let result = store.commit_provider_status(key, descendant, &[message(1)], None, &[]);
    assert!(
        matches!(result, Err(ProviderError::InvalidParams { field: actual }) if actual == field),
        "{result:?}"
    );
    assert_eq!(
        store
            .load_provider_lineage(key, &child.lineage_id)
            .unwrap()
            .as_ref(),
        Some(child)
    );
    assert_eq!(
        store
            .load_provider_messages(key, &child.lineage_id)
            .unwrap(),
        before
    );
    assert_eq!(
        serde_json::to_value(store.load_provider_conversation(key).unwrap()).unwrap(),
        conversation
    );
}

#[test]
fn late_descent_accepts_pass_hooks_and_matching_prefix_and_new_tail() {
    let dir = tempfile::tempdir().unwrap();
    let (store, key, child, descendant) = late_descent_fixture(dir.path());
    late_hook(&store, &key, &child, &message(0), "[]", false);
    late_hook(&store, &key, &child, &message(1), "[]", false);
    store
        .commit_provider_status(&key, &descendant, &[message(2)], None, &[])
        .unwrap();
    assert_eq!(
        store.load_provider_messages(&key, "child").unwrap(),
        vec![message(0), message(1), message(2)]
    );
    assert_eq!(
        store.load_provider_lineage(&key, "child").unwrap().as_ref(),
        Some(&descendant)
    );
    store
        .commit_provider_status(&key, &descendant, &[], None, &[])
        .unwrap();
}

#[test]
fn late_descent_refuses_nonpass_hook_answer() {
    for (ops, tagged) in [
        ("[{\"op\":\"append\",\"block\":0,\"text\":\"edit\"}]", false),
        ("[]", true),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let (store, key, child, descendant) = late_descent_fixture(dir.path());
        late_hook(&store, &key, &child, &message(1), ops, tagged);
        assert_late_refusal(&store, &key, &child, &descendant, "hook_answer");
    }
}

#[test]
fn late_descent_refuses_mismatched_retained_message() {
    for ordinal in [0, 1] {
        let dir = tempfile::tempdir().unwrap();
        let (store, key, child, mut descendant) = late_descent_fixture(dir.path());
        // Ordinal 0 is inside the retained prefix; ordinal 1 is its inclusive cut.
        store
            .commit_provider_status(&key, &lineage("parent", 0), &[message(1)], None, &[])
            .unwrap();
        descendant.through_ordinal = Some(1);
        descendant.first_ordinal = 2;
        let mut changed = message(ordinal);
        changed.message_bytes = b"{\"text\":\"different\"}".to_vec();
        late_hook(&store, &key, &child, &changed, "[]", false);
        assert_late_refusal(&store, &key, &child, &descendant, "messages");
    }
}

#[test]
fn late_descent_refuses_nonidentity_frozen_view() {
    let dir = tempfile::tempdir().unwrap();
    let (store, key, child, descendant) = late_descent_fixture(dir.path());
    store
        .save_provider_view(
            &key,
            &ProviderView {
                version: 5,
                lineage_id: "child".into(),
                range_from: 0,
                range_to: 1,
                replacement_json: "[]".into(),
                state: "not_applied".into(),
            },
        )
        .unwrap();
    assert_late_refusal(&store, &key, &child, &descendant, "lineage_id");
}

#[test]
fn late_descent_admission_is_atomic_and_link_is_immutable() {
    let dir = tempfile::tempdir().unwrap();
    let (store, key, child, descendant) = late_descent_fixture(dir.path());
    late_hook(&store, &key, &child, &message(0), "[]", false);
    let mut changed = message(0);
    changed.message_bytes = b"{\"text\":\"conflicting page\"}".to_vec();
    assert!(store
        .commit_provider_status(&key, &descendant, &[changed], None, &[])
        .is_err());
    assert_eq!(
        store.load_provider_lineage(&key, "child").unwrap().as_ref(),
        Some(&child)
    );
    assert_eq!(
        store.load_provider_messages(&key, "child").unwrap(),
        vec![message(0)]
    );
    store
        .commit_provider_status(&key, &descendant, &[message(1)], None, &[])
        .unwrap();
    let contradiction = ProviderLineage {
        first_ordinal: 2,
        through_ordinal: Some(1),
        ..descendant.clone()
    };
    assert!(matches!(
        store.commit_provider_status(&key, &contradiction, &[], None, &[]),
        Err(ProviderError::InvalidParams {
            field: "lineage_id"
        })
    ));
    assert_eq!(
        store.load_provider_lineage(&key, "child").unwrap().as_ref(),
        Some(&descendant)
    );
}
