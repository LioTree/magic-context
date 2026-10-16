//! Process-only crash helper using the same store migrator and SQL chain as McStore::open.
use super::*;

#[test]
#[ignore = "invoked by scripts/rehearse-upgrade.ts with a throwaway store root"]
fn store_process() {
    let root = std::path::PathBuf::from(std::env::var("REHEARSAL_ROOT").expect("REHEARSAL_ROOT"))
        .canonicalize()
        .unwrap();
    assert!(root.starts_with(
        std::env::temp_dir()
            .join("magic-context")
            .canonicalize()
            .unwrap()
    ));
    let target: usize = std::env::var("REHEARSAL_CRASH_VERSION")
        .unwrap()
        .parse()
        .unwrap();
    assert!(target > 63 && target <= LATEST_MIGRATION_VERSION as usize);
    let descriptor = cortexkit_store_types::StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: "mc_cache".into(),
        isolation: cortexkit_store_types::Isolation::Module,
        backend: cortexkit_store_types::StorageBackend::Sqlite {
            path: root.join("store.db").to_string_lossy().into_owned(),
        },
    };
    let inner = open_sqlite(&descriptor).unwrap();
    let marker = root.join("crash-ready");
    inner.with_conn(move |db| {
        register_legacy_trigger_functions(db)?;
        let mut updates = 0;
        // Ledger writes are inside the migration transaction; the parent kills this process
        // only after the hook reports that the chosen step has reached its uncommitted ledger.
        db.update_hook(Some(move |action: rusqlite::hooks::Action, _: &str, table: &str, _: i64| {
            if table == "cortexkit_schema_version" && matches!(action, rusqlite::hooks::Action::SQLITE_INSERT | rusqlite::hooks::Action::SQLITE_UPDATE) {
                updates += 1;
                if updates == target - 63 {
                    std::fs::write(&marker, format!("store.db migration {target} ledger written, transaction uncommitted")).unwrap();
                    loop { std::thread::park_timeout(std::time::Duration::from_secs(60)); }
                }
            }
        }));
        Ok(())
    }).unwrap();
    inner.migrate(NS, MIGRATIONS).unwrap();
    panic!("requested crash ledger was not reached");
}
