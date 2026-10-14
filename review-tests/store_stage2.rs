// rust-stage2.ts copies mc-store's existing provider_v2_tests module and includes this file in that
// temporary copy, giving these tests access to its private fixtures without changing product files.
fn review_descriptor(dir: &std::path::Path) -> StorageDescriptor {
    StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: NS.into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.join("store.db").to_string_lossy().into(),
        },
    }
}
fn review_rows(conn: &rusqlite::Connection, table: &str) -> Vec<Vec<rusqlite::types::Value>> {
    let mut q = conn
        .prepare(&format!("SELECT * FROM {table} ORDER BY 1,2"))
        .unwrap();
    let columns = q.column_count();
    q.query_map([], |r| {
        (0..columns)
            .map(|i| r.get(i))
            .collect::<rusqlite::Result<Vec<_>>>()
    })
    .unwrap()
    .map(Result::unwrap)
    .collect()
}
fn review_populated_v70(dir: &std::path::Path) -> Vec<ProviderSessionKey> {
    let chain: Vec<_> = MIGRATIONS
        .iter()
        .filter(|m| m.version <= 70)
        .cloned()
        .collect();
    let store = McStore::open_with_migrations(&review_descriptor(dir), false, &chain).unwrap();
    let keys: Vec<_> = ["opencode", "opencode2", "claude_code", "generic"]
        .into_iter()
        .map(|harness| ProviderSessionKey {
            project_root: "/migration-review".into(),
            session: format!("review-{harness}"),
            harness: harness.into(),
            generation: None,
        })
        .collect();
    for key in &keys {
        seed(&store, key);
        store
            .commit(
                &format!("engine-{}", key.session),
                None,
                &cortexkit_cache_core::CoreState::default(),
                &ModuleMeta {
                    initialized: true,
                    ..Default::default()
                },
            )
            .unwrap();
        store.inner.with_conn_fenced(|conn| {
            let conv = key.conversation_key();
            conn.execute("INSERT INTO mc_provider_sessions_v1 VALUES(?1,?2,?3,'{}')", params![key.project_root,key.session,key.harness])?;
            conn.execute("INSERT INTO mc_provider_policy_parts_v1 VALUES(?1,'L',0,'m#0',?2,?3)", params![conv,serde_json::to_string(&part()).unwrap(),key.session])?;
            conn.execute("INSERT INTO mc_provider_hook_answers_v1 VALUES(?1,0,'L','m','post_tool','',0,'[]','[]','live',NULL,'{}',?2)",params![conv,key.session])?;
            conn.execute("INSERT INTO mc_provider_views_v1 VALUES(?1,1,'L',0,1,'[]','applied','{}',?2)",params![conv,key.session])?;
            conn.execute("INSERT INTO mc_provider_legacy_tags_v1 VALUES(?1,1,'live','{}',?2)",params![conv,key.session])?;
            conn.execute("INSERT INTO mc_provider_pending_drops_v1 VALUES(?1,1,?2)",params![conv,key.session])?;
            conn.execute("INSERT INTO mc_provider_policy_summaries_v1 VALUES(?1,'{}',?2)",params![conv,key.session])?;
            conn.execute("INSERT INTO mc_provider_policy_changes_v1 VALUES(?1,'L','m#0',NULL,0,?2)",params![conv,key.session])?;
            conn.execute("INSERT INTO mc_provider_consumed_tags_v1 VALUES(?1,1,?2)",params![format!("engine-{}",key.session),key.session])?;
            Ok(())
        }).unwrap();
    }
    keys
}
#[test]
fn review_migrations_step_populated_reset_scope_idempotency_and_old_binary_fence() {
    let dir = tempfile::tempdir().unwrap();
    let keys = review_populated_v70(dir.path());
    let conn = rusqlite::Connection::open(dir.path().join("store.db")).unwrap();
    let cache = review_rows(&conn, "mc_cache_state");
    let consumed = review_rows(&conn, "mc_provider_consumed_tags_v1");
    drop(conn);
    let chain71: Vec<_> = MIGRATIONS
        .iter()
        .filter(|m| m.version <= 71)
        .cloned()
        .collect();
    let store71 =
        McStore::open_with_migrations(&review_descriptor(dir.path()), false, &chain71).unwrap();
    assert_eq!(store71.module_store_schema_version().unwrap(), 71);
    for key in &keys {
        assert!(store71.load_provider_conversation(key).unwrap().is_some());
    }
    store71.inner.with_conn_fenced(|conn| {
        for key in &keys {
            conn.execute("INSERT INTO mc_provider_policy_preparations_v1 VALUES(?1,?2,0,'key','{}',0,x'00',0,?3)",params![key.conversation_key(),format!("engine-{}",key.session),key.session])?;
        }
        Ok(())
    }).unwrap();
    drop(store71);
    let store = McStore::open_for_test(&review_descriptor(dir.path())).unwrap();
    assert_eq!(store.module_store_schema_version().unwrap(), 72);
    let tables = [
        "mc_provider_conversations_v2",
        "mc_provider_sessions_v1",
        "mc_provider_lineages_v1",
        "mc_provider_messages_v1",
        "mc_provider_policy_parts_v1",
        "mc_provider_hook_answers_v1",
        "mc_provider_views_v1",
        "mc_provider_legacy_tags_v1",
        "mc_provider_pending_drops_v1",
        "mc_provider_policy_summaries_v1",
        "mc_provider_policy_changes_v1",
        "mc_provider_policy_preparations_v1",
    ];
    store
        .inner
        .with_conn(|conn| {
            for table in tables {
                for (i, key) in keys.iter().enumerate() {
                    let count: u64 = conn.query_row(
                        &format!("SELECT count(*) FROM {table} WHERE session=?1"),
                        [&key.session],
                        |r| r.get(0),
                    )?;
                    assert_eq!(count, if i < 2 { 0 } else { 1 }, "{table}: {}", key.harness);
                }
            }
            assert_eq!(review_rows(conn, "mc_cache_state"), cache);
            assert_eq!(review_rows(conn, "mc_provider_consumed_tags_v1"), consumed);
            Ok(())
        })
        .unwrap();
    let before = std::fs::read(dir.path().join("store.db")).unwrap();
    drop(store);
    let reopened = McStore::open_for_test(&review_descriptor(dir.path())).unwrap();
    assert_eq!(reopened.module_store_schema_version().unwrap(), 72);
    drop(reopened);
    let chain70: Vec<_> = MIGRATIONS
        .iter()
        .filter(|m| m.version <= 70)
        .cloned()
        .collect();
    assert!(matches!(
        McStore::open_with_migrations(&review_descriptor(dir.path()), false, &chain70),
        Err(McStoreError::StoreAheadOfBinary {
            db_version: 72,
            binary_max: 70
        })
    ));
    // Check the closed database, avoiding a comparison against an uncheckpointed WAL.
    let closed = std::fs::read(dir.path().join("store.db")).unwrap();
    assert!(!before.is_empty());
    assert!(matches!(
        McStore::open_with_migrations(&review_descriptor(dir.path()), false, &chain70),
        Err(McStoreError::StoreAheadOfBinary { .. })
    ));
    assert_eq!(std::fs::read(dir.path().join("store.db")).unwrap(), closed);
}

#[test]
fn review_actual_migration_runner_rolls_back_partial_ddl_and_reset_on_error() {
    for version in [71, 72] {
        let dir = tempfile::tempdir().unwrap();
        review_populated_v70(dir.path());
        if version == 72 {
            let chain: Vec<_> = MIGRATIONS
                .iter()
                .filter(|m| m.version <= 71)
                .cloned()
                .collect();
            drop(
                McStore::open_with_migrations(&review_descriptor(dir.path()), false, &chain)
                    .unwrap(),
            );
        }
        let sql = MIGRATIONS
            .iter()
            .find(|m| m.version == version)
            .unwrap()
            .statements;
        let split = if version == 71 {
            sql.find("-- A prepared snapshot").unwrap()
        } else {
            sql.find("CREATE TABLE mc_provider_policy_cuts_v1").unwrap()
        };
        let prefix = &sql[..split];
        let broken: &'static str = Box::leak(
            format!("{prefix}\nSELECT review_injected_missing_function();").into_boxed_str(),
        );
        let mut chain: Vec<_> = MIGRATIONS
            .iter()
            .filter(|m| m.version < version)
            .cloned()
            .collect();
        chain.push(Migration {
            version,
            statements: broken,
        });
        assert!(
            McStore::open_with_migrations(&review_descriptor(dir.path()), false, &chain).is_err()
        );
        let prior: Vec<_> = MIGRATIONS
            .iter()
            .filter(|m| m.version < version)
            .cloned()
            .collect();
        let store =
            McStore::open_with_migrations(&review_descriptor(dir.path()), false, &prior).unwrap();
        assert_eq!(store.module_store_schema_version().unwrap(), version - 1);
        store.inner.with_conn(|conn| {
            assert_eq!(conn.query_row("SELECT count(*) FROM mc_provider_conversations_v2",[],|r|r.get::<_,u64>(0))?,4);
            if version==71 {assert_eq!(conn.query_row("SELECT count(*) FROM sqlite_master WHERE name='mc_provider_policy_revisions_v1'",[],|r|r.get::<_,u64>(0))?,0);}
            else {assert_eq!(conn.query_row("SELECT count(*) FROM pragma_table_info('mc_provider_messages_v1') WHERE name='frozen_policy_format'",[],|r|r.get::<_,u64>(0))?,0);}
            Ok(())
        }).unwrap();
        drop(store);
        assert_eq!(
            McStore::open_for_test(&review_descriptor(dir.path()))
                .unwrap()
                .module_store_schema_version()
                .unwrap(),
            72
        );
    }
}

#[test]
fn review_compact_tail_rejects_unknown_format_by_name() {
    let (_dir, store, _key) = rig();
    let (meta, policy) = native_cache_inputs();
    cache_policy_commit(&store, "engine-s", &meta, &policy).unwrap();
    store.inner.with_conn_fenced(|conn| {
        conn.execute("UPDATE mc_cache_state SET meta=replace(meta,'mc_native_tail_v1','review_future_tail_v2') WHERE session_id='engine-s'",[])?;
        Ok(())
    }).unwrap();
    let error = store.load("engine-s").unwrap_err().to_string();
    assert!(
        error.contains("unsupported native tail format: review_future_tail_v2"),
        "{error}"
    );
}

#[test]
fn review_compact_baseline_with_many_parts_and_distinct_blocks_is_exact() {
    for count in [1usize, 63, 64, 65, 500] {
        let (_dir, store, key) = rig();
        let (mut meta, mut policy) = native_cache_inputs();
        policy.parts.clear();
        for i in 0..count {
            let mut p = part();
            p.block_id = format!("m#{i}");
            p.block_index = i as i64;
            p.measurement.key = format!("m#{i}\\0text");
            p.measurement.content_hash = format!("hash-{i}");
            p.measurement.kind = TailHygienePartKind::Excluded;
            p.measurement.tokens = 0;
            p.measurement.tag_number = None;
            p.measurement.tag_status = None;
            policy.parts.push(p);
        }
        meta.tail_hygiene_baseline.as_mut().unwrap().baseline_parts =
            policy.parts.iter().map(|p| p.measurement.clone()).collect();
        cache_policy_commit(&store, "engine-s", &meta, &policy).unwrap();
        assert_eq!(
            store.load("engine-s").unwrap().meta.tail_hygiene_baseline,
            meta.tail_hygiene_baseline,
            "{count}"
        );
        let physical = store
            .inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT count(*) FROM mc_provider_policy_parts_v1 WHERE conv_key=?1",
                    [key.conversation_key()],
                    |r| r.get::<_, u64>(0),
                )
            })
            .unwrap();
        assert_eq!(physical, 0, "must execute frozen-prefix storage");
    }
}

#[test]
#[ignore = "subprocess helper for a mid-migration process kill"]
fn review_migration_crash_child() {
    let Ok(path) = std::env::var("REVIEW_MIGRATION_CRASH_PATH") else {
        return;
    };
    let version: u32 = std::env::var("REVIEW_MIGRATION_CRASH_VERSION")
        .unwrap()
        .parse()
        .unwrap();
    let conn = rusqlite::Connection::open(path).unwrap();
    let sql = MIGRATIONS
        .iter()
        .find(|m| m.version == version)
        .unwrap()
        .statements;
    let split = if version == 71 {
        sql.find("-- A prepared snapshot").unwrap()
    } else {
        sql.find("CREATE TABLE mc_provider_policy_cuts_v1").unwrap()
    };
    conn.execute_batch("BEGIN IMMEDIATE").unwrap();
    conn.execute_batch(&sql[..split]).unwrap();
    if version == 72 {
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM mc_provider_conversations_v2",
                [],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
            2
        );
    } else {
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM mc_provider_policy_revisions_v1",
                [],
                |r| r.get::<_, u64>(0)
            )
            .unwrap(),
            4
        );
    }
    use std::io::Write;
    println!("REVIEW_MID_MIGRATION_DDL_APPLIED");
    std::io::stdout().flush().unwrap();
    loop {
        std::thread::park();
    }
}

#[test]
fn review_migration_midway_process_kill_restores_rows_and_schema() {
    use std::io::BufRead;
    for version in [71, 72] {
        let dir = tempfile::tempdir().unwrap();
        review_populated_v70(dir.path());
        if version == 72 {
            let chain: Vec<_> = MIGRATIONS
                .iter()
                .filter(|m| m.version <= 71)
                .cloned()
                .collect();
            drop(
                McStore::open_with_migrations(&review_descriptor(dir.path()), false, &chain)
                    .unwrap(),
            );
        }
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "provider_v2_tests::review_migration_crash_child",
                "--nocapture",
                "--ignored",
            ])
            .env("REVIEW_MIGRATION_CRASH_PATH", dir.path().join("store.db"))
            .env("REVIEW_MIGRATION_CRASH_VERSION", version.to_string())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        loop {
            line.clear();
            assert!(
                output.read_line(&mut line).unwrap() > 0,
                "child must reach the applied-DDL marker"
            );
            if line.contains("REVIEW_MID_MIGRATION_DDL_APPLIED") {
                break;
            }
        }
        child.kill().unwrap();
        assert!(!child.wait().unwrap().success());
        let prior: Vec<_> = MIGRATIONS
            .iter()
            .filter(|m| m.version < version)
            .cloned()
            .collect();
        let restored =
            McStore::open_with_migrations(&review_descriptor(dir.path()), false, &prior).unwrap();
        assert_eq!(restored.module_store_schema_version().unwrap(), version - 1);
        restored.inner.with_conn(|conn| {
            assert_eq!(conn.query_row("SELECT count(*) FROM mc_provider_conversations_v2",[],|r|r.get::<_,u64>(0))?,4);
            let query=if version==71 {"SELECT count(*) FROM sqlite_master WHERE name='mc_provider_policy_revisions_v1'"} else {"SELECT count(*) FROM pragma_table_info('mc_provider_messages_v1') WHERE name='frozen_policy_format'"};
            assert_eq!(conn.query_row(query,[],|r|r.get::<_,u64>(0))?,0);Ok(())
        }).unwrap();
        drop(restored);
        drop(McStore::open_for_test(&review_descriptor(dir.path())).unwrap());
    }
}
