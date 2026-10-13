// run.py injects this into context_writes::tests only when MC_S7_REVIEW=1.
fn s7_fold_store(dir: &std::path::Path) -> McStore {
    McStore::open_for_test(&cortexkit_store_types::StorageDescriptor {
        module_id: "s7-review".into(),
        storage_namespace: crate::single_store_schema::STORE_NAMESPACE.into(),
        isolation: cortexkit_store_types::Isolation::Module,
        backend: cortexkit_store_types::StorageBackend::Sqlite {
            path: dir.join("store.db").to_string_lossy().into_owned(),
        },
    })
    .unwrap()
}

fn s7_rows(conn: &Connection, table: &str) -> Vec<String> {
    let mut statement = conn.prepare(&format!("SELECT * FROM {table}")).unwrap();
    let columns = statement.column_count();
    let mut rows = statement
        .query_map([], |row| {
            Ok((0..columns)
                .map(|col| format!("{:?}", row.get_ref(col).unwrap()))
                .collect::<Vec<_>>()
                .join("|"))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    rows.sort();
    rows
}

fn s7_fixed_history(conn: &Connection) {
    conn.execute("INSERT INTO compartment_history_versions(session_id,generation,version,rewrite_version,seeded) VALUES ('ses','review-fixed-generation',0,0,0)", []).unwrap();
}

#[test]
fn s7_review_snapshot_randomized_pending_folds() {
    let mut rng: u64 = 0xf01d_7337_1012;
    for index in 0..24 {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        let dir = tempfile::tempdir().unwrap();
        let store = s7_fold_store(dir.path());
        let PendingContextWrite::Fold(mut write) = fold() else {
            unreachable!()
        };
        write.facts.clear();
        for fact in 0..rng % 4 {
            write.facts.push(FactCandidate {
                category: "ARCHITECTURE".into(),
                content: format!("Review fact {index}:{fact}"),
                ..Default::default()
            });
        }
        write.promote_facts = rng & 4 != 0;
        #[cfg(mc_s7_head)]
        {
            write.lifecycle_publication_id = Some(format!("review-publication-{index}"));
        }
        let write = PendingContextWrite::Fold(write);
        record(&store, &write);
        store.with_context_conn_for_test(|conn| {
            s7_fixed_history(conn);
            if rng & 8 != 0 {
                conn.execute("INSERT INTO authority_managed(project_path,context_store_uuid,marked_at) VALUES ('git:other','review',1)", [])?;
            }
            Ok(())
        }).unwrap();
        assert!(store.resume_pending_context_write("ses").unwrap());
        // Simulate a committed context transaction whose outbox acknowledgement was lost.
        record(&store, &write);
        assert!(store.resume_pending_context_write("ses").unwrap());
        assert!(!store.resume_pending_context_write("ses").unwrap());
        let value = store
            .with_context_conn_for_test(|conn| {
                Ok(serde_json::json!({
                    "compartments": s7_rows(conn, "compartments"),
                    "memories": s7_rows(conn, "memories"),
                    "events": s7_rows(conn, "compartment_events"),
                    "primers": s7_rows(conn, "primer_candidates"),
                    "observations": s7_rows(conn, "user_memory_candidates"),
                    "publications": s7_rows(conn, "memory_publications"),
                    "pending_facts": s7_rows(conn, "memory_pending_facts"),
                    "ledger": s7_rows(conn, "memory_activity_ledger"),
                }))
            })
            .unwrap();
        println!("S7_SNAPSHOT fold-{index} {value}");
    }
}

#[cfg(mc_s7_head)]
#[test]
fn s7_review_witness_no_candidate_fold_is_byte_identical() {
    let legacy_dir = tempfile::tempdir().unwrap();
    let current_dir = tempfile::tempdir().unwrap();
    let legacy = s7_fold_store(legacy_dir.path());
    let current = s7_fold_store(current_dir.path());
    let PendingContextWrite::Fold(mut write) = fold() else {
        unreachable!()
    };
    write.facts.clear();
    write.events.clear();
    write.primer_candidates.clear();
    write.user_memory_candidates.clear();
    for fixture in [&legacy, &current] {
        fixture
            .with_context_conn_for_test(|conn| {
                s7_fixed_history(conn);
                Ok(())
            })
            .unwrap();
    }
    legacy
        .with_context_conn_for_test(|conn| {
            apply_fold_tx(conn, "ses", &write)?;
            // Normal TypeScript compartment publication writes one publication
            // and one activity row here, even before turn-two support is enabled.
            // Specify those expected rows independently of the Rust publisher.
            conn.execute("INSERT INTO memory_publications(publication_id,project_path,source_session_id,commit_order,committed_at)
                VALUES ('ordinary-no-candidate-publication','git:proj','ses',1,10)", [])?;
            conn.execute("INSERT INTO memory_activity_ledger(project_path,publication_id,compartment_id,committed_at)
                VALUES ('git:proj','ordinary-no-candidate-publication',1,10)", [])?;
            Ok(())
        })
        .unwrap();
    write.lifecycle_publication_id = Some("ordinary-no-candidate-publication".into());
    current
        .with_context_conn_for_test(|conn| {
            apply_fold_tx(conn, "ses", &write)?;
            Ok(())
        })
        .unwrap();
    let old_compartments = legacy
        .with_context_conn_for_test(|conn| Ok(s7_rows(conn, "compartments")))
        .unwrap();
    let new_compartments = current
        .with_context_conn_for_test(|conn| Ok(s7_rows(conn, "compartments")))
        .unwrap();
    assert_eq!(
        new_compartments, old_compartments,
        "compartment row bytes changed"
    );
    let old = legacy
        .with_context_conn_for_test(|conn| Ok(domain_rows(conn)))
        .unwrap();
    let new = current
        .with_context_conn_for_test(|conn| Ok(domain_rows(conn)))
        .unwrap();
    let differences = new
        .into_iter()
        .zip(old)
        .filter(|(after, before)| after != before)
        .collect::<Vec<_>>();
    assert!(
        differences.is_empty(),
        "no-candidate production fold writes new rows despite byte-identity claim: {differences:?}"
    );
}

#[cfg(mc_s7_head)]
#[test]
fn s7_review_control_replay_preserves_publication_order_and_candidates() {
    let dir = tempfile::tempdir().unwrap();
    let store = s7_fold_store(dir.path());
    let PendingContextWrite::Fold(mut write) = fold() else {
        unreachable!()
    };
    write.lifecycle_publication_id = Some("review-idempotent-publication".into());
    write.promote_facts = false;
    write.facts = (0..7)
        .map(|i| FactCandidate {
            category: "ARCHITECTURE".into(),
            content: format!("fact-{i}"),
            ..Default::default()
        })
        .collect();
    store.with_context_conn_for_test(|conn| {
        s7_fixed_history(conn);
        conn.execute("INSERT INTO authority_managed(project_path,context_store_uuid,marked_at) VALUES ('git:other','review',1)", [])?;
        apply_fold_tx(conn, "ses", &write)?;
        let before = ["memory_publications", "memory_pending_facts", "memory_activity_ledger"].map(|table| s7_rows(conn, table));
        assert_eq!(before[1].len(), 7);
        assert!(s7_rows(conn, "memories").is_empty());
        write.published_at_ms = 999;
        apply_fold_tx(conn, "ses", &write)?;
        let after = ["memory_publications", "memory_pending_facts", "memory_activity_ledger"].map(|table| s7_rows(conn, table));
        assert!(after == before, "lost-ack replay changed publication order, timestamp, or candidates: publication {:?} => {:?}", before[0], after[0]);
        assert!(s7_rows(conn, "memories").is_empty());
        Ok(())
    }).unwrap();
}
