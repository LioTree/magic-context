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

#[test]
#[ignore = "invoked by scripts/rehearse-upgrade.ts with a throwaway store root"]
fn measure_store_process() {
    let root = std::path::PathBuf::from(std::env::var("REHEARSAL_ROOT").unwrap())
        .canonicalize()
        .unwrap();
    assert!(root.starts_with(
        std::env::temp_dir()
            .join("magic-context")
            .canonicalize()
            .unwrap()
    ));
    let descriptor = cortexkit_store_types::StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: "mc_cache".into(),
        isolation: cortexkit_store_types::Isolation::Module,
        backend: cortexkit_store_types::StorageBackend::Sqlite {
            path: root.join("store.db").to_string_lossy().into_owned(),
        },
    };
    let inner = open_sqlite(&descriptor).unwrap();
    inner
        .with_conn(|db| {
            register_legacy_trigger_functions(db)?;
            Ok(())
        })
        .unwrap();
    let size = || -> Vec<u64> {
        ["store.db", "store.db-wal"]
            .iter()
            .map(|name| {
                std::fs::metadata(root.join(name))
                    .map(|m| m.len())
                    .unwrap_or(0)
            })
            .collect()
    };
    for migration in MIGRATIONS.iter().filter(|m| m.version > 63) {
        let before = size();
        // Linux clear_refs=5 resets this process's peak RSS without changing its mappings.
        std::fs::write("/proc/self/clear_refs", "5").unwrap();
        let started = std::time::Instant::now();
        inner.migrate(NS, std::slice::from_ref(migration)).unwrap();
        let seconds = started.elapsed().as_secs_f64();
        let status = std::fs::read_to_string("/proc/self/status").unwrap();
        let peak: u64 = status
            .lines()
            .find(|l| l.starts_with("VmHWM:"))
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        println!(
            "REHEARSAL_METRIC {}",
            serde_json::json!({"database":"store", "version":migration.version, "seconds":seconds, "peakKiB":peak, "beforeMainWal":before, "afterMainWal":size(), "scope":"committed migration via real store migrator; per-step process RSS"})
        );
    }
}
