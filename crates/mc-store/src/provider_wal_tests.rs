use super::*;
use crate::{ProviderSessionKey, ProviderViewRecipe, ProviderViewSegment};
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use std::io::{BufRead, Write};

fn open(path: &Path) -> McStore {
    McStore::open_for_test(&StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: crate::NS.into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: path.to_string_lossy().into(),
        },
    })
    .unwrap()
}
fn seed(store: &McStore) {
    store.execute_tag_sql_for_test("CREATE TABLE wal_probe(id INTEGER PRIMARY KEY, payload BLOB); INSERT INTO wal_probe VALUES(0,x'00')").unwrap();
}
fn write(store: &McStore, index: u64) {
    store
        .execute_tag_sql_for_test(&format!(
            "INSERT INTO wal_probe VALUES({index},zeroblob(2097152))"
        ))
        .unwrap();
    store
        .save_provider_view_recipe(&key(), &recipe(index))
        .unwrap();
}
fn key() -> ProviderSessionKey {
    ProviderSessionKey {
        project_root: "/wal-fixture".into(),
        session: "s".into(),
        harness: "opencode".into(),
        generation: None,
    }
}
fn recipe(version: u64) -> ProviderViewRecipe {
    ProviderViewRecipe {
        version,
        lineage_id: "L".into(),
        range_from: 0,
        range_to: 1,
        base_version: None,
        policy_cut_id: None,
        metadata: serde_json::json!({"version":version}),
        segments: vec![ProviderViewSegment::Synthetic {
            slot: "head".into(),
        }],
        synthetic: std::collections::BTreeMap::from([(
            "head".into(),
            serde_json::json!({"text":format!("committed fold {version}")}),
        )]),
        treatments: vec![],
        serializer_profile: "opencode-aisdk".into(),
        render_key: "fixture".into(),
        tokenizer_key: "fixture".into(),
        state: "produced".into(),
    }
}
fn verify(store: &McStore, count: u64) {
    for index in 1..=count {
        let view = store.resolve_provider_view(&key(), index).unwrap().unwrap();
        assert_eq!(
            view.recipe.synthetic["head"],
            serde_json::json!({"text":format!("committed fold {index}")})
        );
    }
    store
        .inner
        .with_conn(|conn| {
            let count: u64 = conn.query_row(
                "SELECT count(*) FROM wal_probe WHERE length(payload)=2097152",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(count, 48);
            Ok(())
        })
        .unwrap();
}

#[test]
fn startup_primes_restarted_wal_without_changing_schema_or_sync_policy() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    {
        let store = open(&path);
        seed(&store);
        store
            .execute_tag_sql_for_test("PRAGMA user_version=42")
            .unwrap();
    }
    let store = open(&path);
    assert_eq!(wal_bytes(&path), 0, "closed seed starts with an empty WAL");
    // Establish the lease's fence epoch, then empty the WAL. Otherwise the fence
    // advance itself could hide a missing page-one write in the startup prime.
    store.inner.with_conn_fenced(|_| Ok(())).unwrap();
    store
        .inner
        .with_conn(|conn| {
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                row.get::<_, i64>(0)
            })
        })
        .unwrap();
    assert_eq!(wal_bytes(&path), 0);
    let state = || {
        store
            .inner
            .with_conn(|conn| {
                let schema = conn
                    .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")?
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let version: u32 =
                    conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
                let sync: u32 = conn.pragma_query_value(None, "synchronous", |row| row.get(0))?;
                let schema_version: u32 =
                    conn.pragma_query_value(None, "schema_version", |row| row.get(0))?;
                let rows: u64 = conn.query_row(
                    "SELECT count(*) FROM wal_probe WHERE id=0 AND payload=x'00'",
                    [],
                    |row| row.get(0),
                )?;
                Ok((schema, version, sync, schema_version, rows))
            })
            .unwrap()
    };
    let before = state();
    assert_eq!((before.1, before.2, before.4), (42, 1, 1));
    store.prime_wal_for_serving().unwrap();
    assert!(
        wal_bytes(&path) > 32,
        "startup must commit a WAL frame before serving"
    );
    assert_eq!(
        state(),
        before,
        "priming changes no logical state or durability policy"
    );
    assert!(
        store.provider_wal.lock().unwrap().is_none(),
        "priming does not change checkpoint scheduling"
    );
}

#[test]
fn ordinary_stores_keep_autocheckpoint_until_provider_opt_in() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    let store = open(&path);
    assert!(store.provider_wal.lock().unwrap().is_none());
    let value = || {
        store
            .inner
            .with_conn(|conn| {
                conn.pragma_query_value(None, "wal_autocheckpoint", |row| row.get::<_, u64>(0))
            })
            .unwrap()
    };
    assert_eq!(value(), 1000);
    store.prepare_provider_wal();
    assert_eq!(value(), store.inner.with_conn(hard_frame_limit).unwrap());
    store.prepare_provider_wal();
    assert!(store
        .provider_wal
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .worker
        .is_some());
}

#[test]
fn stalled_maintenance_bounds_wal_to_hard_limit_plus_one_fold() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    let store = open(&path);
    seed(&store);
    store.prepare_provider_wal();
    store.stall_provider_wal_for_test(true);
    // Disable SQLite's automatic checkpoints to exercise only the synchronous
    // 64 MiB check before resident requests. The outside-call writer test covers
    // the independent SQLite checkpoint that runs after write commits.
    store
        .execute_tag_sql_for_test("PRAGMA wal_autocheckpoint=0")
        .unwrap();
    let mut largest_delta = 0;
    let mut largest = 0;
    for index in 1..=48 {
        store.prepare_provider_wal();
        let before = wal_bytes(&path);
        write(&store, index);
        store.finish_provider_wal();
        let after = wal_bytes(&path);
        largest_delta = largest_delta.max(after.saturating_sub(before));
        largest = largest.max(after);
    }
    assert!(
        largest >= HARD_BYTES,
        "the synchronous hard-limit path must execute"
    );
    assert!(
        largest_delta <= 3 * 1024 * 1024,
        "each fixture fold adds at most 3 MiB"
    );
    assert!(
        largest <= HARD_BYTES + 3 * 1024 * 1024,
        "WAL {largest} exceeds limit plus one fold"
    );
    verify(&store, 48);
    store.stall_provider_wal_for_test(false);
    store.flush_provider_wal_for_test();
    assert!(
        wal_bytes(&path) < HARD_BYTES,
        "maintenance reclaims high-water allocation"
    );
}

#[test]
fn pinned_reader_never_refuses_writes_and_reclaims_after_release() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    let store = open(&path);
    seed(&store);
    store.prepare_provider_wal();
    let reader = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    reader.execute_batch("BEGIN").unwrap();
    let _: u64 = reader
        .query_row("SELECT count(*) FROM wal_probe", [], |row| row.get(0))
        .unwrap();
    for index in 1..=48 {
        store.prepare_provider_wal();
        write(&store, index);
        store.finish_provider_wal();
    }
    assert!(
        wal_bytes(&path) > HARD_BYTES,
        "the reader must pin enough frames to cross the cap"
    );
    verify(&store, 48);
    reader.execute_batch("COMMIT").unwrap();
    drop(reader);
    store.flush_provider_wal_for_test();
    assert!(
        wal_bytes(&path) < HARD_BYTES,
        "the maintenance thread must reclaim after the reader releases"
    );
}

#[test]
#[ignore = "subprocess for killing a checkpoint in progress"]
fn checkpoint_crash_child() {
    let path = PathBuf::from(std::env::var_os("MC_WAL_CRASH_FIXTURE").unwrap());
    let store = open(&path);
    seed(&store);
    store.prepare_provider_wal();
    store.stall_provider_wal_for_test(true);
    for index in 1..=48 {
        write(&store, index);
    }
    store.stall_provider_wal_for_test(false);
    println!(
        "CHECKPOINT_READY {}",
        std::fs::metadata(&path).unwrap().len()
    );
    std::io::stdout().flush().unwrap();
    store.flush_provider_wal_for_test();
    println!("CHECKPOINT_COMPLETED");
    std::io::stdout().flush().unwrap();
}

#[test]
fn killing_active_maintenance_checkpoint_preserves_all_committed_fold_recipes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "provider_wal::tests::checkpoint_crash_child",
            "--ignored",
            "--nocapture",
        ])
        .env("MC_WAL_CRASH_FIXTURE", &path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let (send, recv) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines() {
            let _ = send.send(line.unwrap());
        }
    });
    let initial = loop {
        let line = recv
            .recv_timeout(std::time::Duration::from_secs(20))
            .expect("child seeds committed folds");
        if let Some(size) = line.strip_prefix("CHECKPOINT_READY ") {
            break size.parse::<u64>().unwrap();
        }
    };
    let started = std::time::Instant::now();
    let mut reached = false;
    while started.elapsed() < std::time::Duration::from_secs(10) {
        let bytes = std::fs::metadata(&path).unwrap().len();
        if bytes > initial && bytes < 80 * 1024 * 1024 {
            child.kill().unwrap();
            reached = true;
            break;
        }
        if child.try_wait().unwrap().is_some() {
            break;
        }
        std::thread::yield_now();
    }
    if !reached {
        let _ = child.kill();
    }
    let _ = child.wait();
    reader.join().unwrap();
    assert!(
        reached,
        "must observe partially copied database pages, not merely a pre-checkpoint marker"
    );
    let store = open(&path);
    verify(&store, 48);
    store
        .inner
        .with_conn(|conn| {
            let integrity: String =
                conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
            assert_eq!(integrity, "ok");
            Ok(())
        })
        .unwrap();
}

#[test]
fn review_dashboard_and_export_snapshots_survive_maintenance() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    let store = open(&path);
    seed(&store);
    store.prepare_provider_wal();
    let readers = [0, 1].map(|_| {
        let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        conn.busy_timeout(std::time::Duration::ZERO).unwrap();
        conn.execute_batch("BEGIN").unwrap();
        let count: u64 = conn
            .query_row("SELECT count(*) FROM wal_probe", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        conn
    });
    for index in 1..=40 {
        store.prepare_provider_wal();
        write(&store, index);
        store.finish_provider_wal();
    }
    store.flush_provider_wal_for_test();
    assert!(
        wal_bytes(&path) > HARD_BYTES,
        "both snapshots must pin the growing WAL"
    );
    for reader in &readers {
        let count: u64 = reader
            .query_row("SELECT count(*) FROM wal_probe", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            count, 1,
            "maintenance must not change either reader's snapshot"
        );
        reader.execute_batch("COMMIT").unwrap();
        let count: u64 = reader
            .query_row("SELECT count(*) FROM wal_probe", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 41, "each new snapshot sees all committed writes");
        let integrity: String = reader
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
    }
    drop(readers);
    store.flush_provider_wal_for_test();
    assert!(wal_bytes(&path) < HARD_BYTES);
    for version in 1..=40 {
        assert!(store
            .resolve_provider_view(&key(), version)
            .unwrap()
            .is_some());
    }
}

/// Shared-connection writers need their own checkpoint backstop when no
/// resident call can notify maintenance. The control keeps SQLite's original
/// policy; opting in must not leave historian, memory or tag writes unbounded.
#[test]
fn review_writes_outside_resident_calls_keep_the_wal_bounded() {
    let mut largest = Vec::new();
    for opted_in in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.db");
        let store = open(&path);
        seed(&store);
        if opted_in {
            // Simulate one resident call: the provider handler wraps it in
            // prepare_provider_wal / finish_provider_wal.
            store.prepare_provider_wal();
            store.finish_provider_wal();
        }
        let mut peak = 0;
        for index in 1..=48 {
            // These writes skip prepare/finish, as historian, memory, tag and
            // other-harness writes do.
            write(&store, index);
            peak = peak.max(wal_bytes(&path));
        }
        verify(&store, 48);
        largest.push(peak);
    }
    assert!(
        largest[0] < HARD_BYTES,
        "control: a store that never opted in keeps autocheckpoint ({} bytes)",
        largest[0]
    );
    assert!(
        largest[1] <= HARD_BYTES + 3 * 1024 * 1024,
        "opted-in store: WAL reached {} bytes from writes outside resident calls (limit {} plus one fold)",
        largest[1],
        HARD_BYTES
    );
}

#[test]
fn passive_rewind_discards_high_water_allocation_before_threshold_checks() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    let store = open(&path);
    seed(&store);
    store.prepare_provider_wal();
    store.stall_provider_wal_for_test(true);
    for index in 1..=4 {
        write(&store, index);
    }
    let allocated = wal_bytes(&path);
    assert!(
        allocated >= SOFT_BYTES,
        "fixture must exceed the soft threshold"
    );
    let (busy, frames, copied) = store.inner.with_conn(passive).unwrap();
    assert_eq!(busy, 0);
    assert_eq!(frames, copied);
    assert_eq!(
        wal_bytes(&path),
        allocated,
        "PASSIVE itself retains the old allocation"
    );
    store
        .execute_tag_sql_for_test("INSERT INTO wal_probe VALUES(5,x'01')")
        .unwrap();
    assert!(
        wal_bytes(&path) < SOFT_BYTES,
        "a rewound WAL must not trigger the old size threshold"
    );
    store.stall_provider_wal_for_test(false);
    for index in 6..=9 {
        write(&store, index);
    }
    assert!(wal_bytes(&path) >= SOFT_BYTES);
    store.flush_provider_wal_for_test();
    store
        .execute_tag_sql_for_test("INSERT INTO wal_probe VALUES(10,x'01')")
        .unwrap();
    assert!(
        wal_bytes(&path) < SOFT_BYTES,
        "the writer discards allocation after a maintenance checkpoint too"
    );
}
