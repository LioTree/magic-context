//! Offline move tests. The source stores come from
//! `testdata/mode3_move_fixture.json`, which the standalone plugin's own writers
//! produce (`packages/plugin/src/features/magic-context/mode3-move-fixture.test.ts`
//! regenerates it and fails when it is stale).
use super::*;
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use std::collections::BTreeSet;

pub(crate) const FIXTURE: &str = include_str!("../testdata/mode3_move_fixture.json");

pub(crate) fn fixture() -> Value {
    serde_json::from_str(FIXTURE).unwrap()
}

pub(crate) fn fixture_session() -> String {
    fixture()["session"].as_str().unwrap().to_owned()
}

/// No other process holds anything: the test's own connections are excluded the
/// same way `Lsof` excludes this process.
pub(crate) struct NoHolders;
impl HolderCheck for NoHolders {
    fn holders(&self, _: &[PathBuf]) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
}

struct Held(&'static str);
impl HolderCheck for Held {
    fn holders(&self, _: &[PathBuf]) -> Result<Vec<String>, String> {
        Ok(vec![self.0.to_owned()])
    }
}

fn sql_value(value: &Value) -> rusqlite::types::Value {
    match value {
        Value::Null => rusqlite::types::Value::Null,
        Value::Bool(flag) => rusqlite::types::Value::Integer(i64::from(*flag)),
        Value::Number(n) if n.is_i64() => rusqlite::types::Value::Integer(n.as_i64().unwrap()),
        Value::Number(n) => rusqlite::types::Value::Real(n.as_f64().unwrap()),
        Value::String(text) => rusqlite::types::Value::Text(text.clone()),
        other => rusqlite::types::Value::Text(other.to_string()),
    }
}

pub(crate) fn insert_rows(conn: &Connection, table: &str, rows: &[Value]) {
    for row in rows {
        let row = row.as_object().unwrap();
        let columns = row.keys().cloned().collect::<Vec<_>>();
        let marks = (1..=columns.len())
            .map(|n| format!("?{n}"))
            .collect::<Vec<_>>()
            .join(",");
        let values = row.values().map(sql_value).collect::<Vec<_>>();
        conn.execute(
            &format!(
                "INSERT INTO {table} ({}) VALUES ({marks})",
                columns.join(",")
            ),
            rusqlite::params_from_iter(values),
        )
        .unwrap_or_else(|error| panic!("{table}: {error}"));
    }
}

pub(crate) fn store_descriptor(dir: &Path) -> StorageDescriptor {
    StorageDescriptor {
        module_id: crate::DEFAULT_MODULE_ID.into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.join("store.db").to_string_lossy().into(),
        },
    }
}

/// Write the fixture's three stores under `dir`: `store.db` and `context.db` from
/// ck-mc's own opener (its context schema is the plugin's current one), then the
/// standalone rows, and an OpenCode 1 `opencode.db`.
pub(crate) fn write_stores(dir: &Path) -> StorePaths {
    let fixture = fixture();
    drop(mc_store::McStore::open_for_test(&store_descriptor(dir)).unwrap());
    let context = Connection::open(dir.join("context.db")).unwrap();
    for (table, rows) in fixture["context"].as_object().unwrap() {
        insert_rows(&context, table, rows.as_array().unwrap());
    }
    let opencode = Connection::open(dir.join("opencode.db")).unwrap();
    // The fixture copies OpenCode's message and part tables; their foreign keys
    // name a session table it does not copy, so a minimal one stands in.
    opencode
        .execute_batch("CREATE TABLE session (id text PRIMARY KEY)")
        .unwrap();
    opencode
        .execute(
            "INSERT INTO session(id) VALUES (?1)",
            [fixture["session"].as_str().unwrap()],
        )
        .unwrap();
    opencode
        .execute_batch(fixture["opencode"]["schema"].as_str().unwrap())
        .unwrap();
    for table in ["message", "part"] {
        insert_rows(
            &opencode,
            table,
            fixture["opencode"][table].as_array().unwrap(),
        );
    }
    StorePaths {
        opencode_db: dir.join("opencode.db"),
        context_db: dir.join("context.db"),
        store_db: dir.join("store.db"),
    }
}

fn marker_data(paths: &StorePaths) -> Value {
    let part = fixture()["expected"]["marker_part"]
        .as_str()
        .unwrap()
        .to_owned();
    let conn = Connection::open(&paths.opencode_db).unwrap();
    let data: String = conn
        .query_row("SELECT data FROM part WHERE id=?1", [part], |row| {
            row.get(0)
        })
        .unwrap();
    serde_json::from_str(&data).unwrap()
}

fn record(paths: &StorePaths) -> Option<String> {
    let conn = Connection::open(&paths.context_db).unwrap();
    read_move_record_raw(&conn, &fixture_session()).unwrap()
}

/// Every row the move may touch, so two runs can be compared.
fn snapshot(paths: &StorePaths) -> (Vec<(String, String)>, Option<String>) {
    let conn = Connection::open(&paths.opencode_db).unwrap();
    let mut statement = conn
        .prepare("SELECT id, data FROM part UNION ALL SELECT id, data FROM message ORDER BY 1")
        .unwrap();
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    (rows, record(paths))
}

fn moved(paths: &StorePaths) -> Plan {
    match run(paths, &fixture_session(), false, &NoHolders, None).unwrap() {
        Outcome::Moved(plan) => plan,
        other => panic!("{other:?}"),
    }
}

fn refusal(paths: &StorePaths) -> Refusal {
    match run(paths, &fixture_session(), false, &NoHolders, None) {
        Err(MoveError::Refused(refusal)) => refusal,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn pairs(value: &Value) -> BTreeSet<(String, String)> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| {
            (
                pair["mid"].as_str().unwrap().to_owned(),
                pair["part"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn carried(record: &MoveRecord, kind: DropKind) -> BTreeSet<(String, String)> {
    record
        .drops
        .iter()
        .filter(|drop| drop.kind == kind)
        .map(|drop| (drop.mid.clone(), drop.part.clone()))
        .collect()
}

#[test]
fn move_carries_summaries_cut_checkpoint_and_drops_after_the_cut() {
    let dir = tempfile::tempdir().unwrap();
    let paths = write_stores(dir.path());
    let fixture = fixture();
    let expected = &fixture["expected"];
    let before = snapshot(&paths);
    let plan = moved(&paths);
    let record = plan.record.clone();
    // The highest number standalone ever allocated: twenty counted parts.
    assert_eq!(record.tag_checkpoint, 20);
    assert_eq!(
        record.tag_checkpoint,
        expected["tag_checkpoint"].as_u64().unwrap()
    );
    assert_eq!(record.cut, expected["cut"].as_str().unwrap());
    assert_eq!(
        record.marker_part,
        expected["marker_part"].as_str().unwrap()
    );
    let source = fixture["context"]["compartments"].as_array().unwrap();
    assert_eq!(record.compartments.len(), source.len());
    for (imported, source) in record.compartments.iter().zip(source) {
        assert_eq!(imported.sequence, source["sequence"].as_i64().unwrap());
        assert_eq!(
            imported.start_message_id,
            source["start_message_id"].as_str().unwrap()
        );
        assert_eq!(
            imported.end_message_id,
            source["end_message_id"].as_str().unwrap()
        );
        assert_eq!(imported.content, source["content"].as_str().unwrap());
        assert_eq!(imported.p1.as_deref(), source["p1"].as_str());
        assert_eq!(imported.p2.as_deref(), source["p2"].as_str());
        assert_eq!(
            imported.importance as i64,
            source["importance"].as_i64().unwrap()
        );
        assert_eq!(
            (imported.start_part.as_ref(), imported.end_part.as_ref()),
            (None, None)
        );
    }
    assert_eq!(
        record.compartments.last().unwrap().end_message_id,
        expected["coverage_end"].as_str().unwrap()
    );
    // The drops land on the parts the generator chose, by OpenCode part id.
    assert_eq!(
        carried(&record, DropKind::Applied),
        pairs(&expected["applied"])
    );
    assert_eq!(
        carried(&record, DropKind::Queued),
        pairs(&expected["queued"])
    );
    assert_eq!(
        plan.behind_cut,
        expected["behind_cut"].as_array().unwrap().len()
    );
    assert!(plan.missing.is_empty(), "{:?}", plan.missing);
    // The checkpoint key, in r2's shape, is the only change to opencode.db.
    let marker = marker_data(&paths);
    assert_eq!(
        marker,
        json!({"type":"compaction","auto":true,"cortexkit":{"tag_checkpoint":20,"session":fixture_session()}})
    );
    let after = snapshot(&paths);
    let changed = before
        .0
        .iter()
        .zip(&after.0)
        .filter(|(a, b)| a != b)
        .map(|(a, _)| a.0.clone())
        .collect::<Vec<_>>();
    assert_eq!(changed, vec![record.marker_part.clone()]);
    // The moved record is the stored plan.
    let stored: MoveRecord = serde_json::from_str(&record_of(&paths)).unwrap();
    assert_eq!(stored, record);
}

fn record_of(paths: &StorePaths) -> String {
    record(paths).expect("moved record")
}

#[test]
fn move_dry_run_prints_the_plan_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let paths = write_stores(dir.path());
    // Each database and its WAL, byte for byte. The `-shm` file is SQLite's
    // shared-memory index, which any reader may rebuild; it holds no data.
    let bytes = |paths: &StorePaths| {
        database_files(paths)
            .into_iter()
            .filter(|path| !path.to_string_lossy().ends_with("-shm"))
            .map(|path| {
                let digest = std::fs::read(&path)
                    .ok()
                    .map(|bytes| crate::sha256_hex(&bytes));
                (path.display().to_string(), digest)
            })
            .collect::<Vec<_>>()
    };
    let before = bytes(&paths);
    let Outcome::Planned(plan) = run(&paths, &fixture_session(), true, &NoHolders, None).unwrap()
    else {
        panic!("dry run moved the session");
    };
    assert_eq!(bytes(&paths), before);
    let value = plan.to_value();
    assert_eq!(value["tag_checkpoint"], 20);
    assert_eq!(value["drops"]["applied"], 2);
    assert_eq!(value["drops"]["queued"], 3);
    assert_eq!(value["marker_key"], "to_write");
    assert!(record(&paths).is_none());
}

#[test]
fn move_rerun_after_a_crash_at_each_write_step_ends_identical() {
    let finished = tempfile::tempdir().unwrap();
    let finished = write_stores(finished.path());
    moved(&finished);
    let reference = snapshot(&finished);

    // A crash after the marker key: the session is not moved yet, because the
    // moved record, the commit point, is written last.
    let crashed = tempfile::tempdir().unwrap();
    let crashed = write_stores(crashed.path());
    let stopped = run(
        &crashed,
        &fixture_session(),
        false,
        &NoHolders,
        Some(StopAfter::MarkerKey),
    );
    assert!(
        matches!(stopped, Err(MoveError::Interrupted(_))),
        "{stopped:?}"
    );
    assert!(
        record(&crashed).is_none(),
        "the moved record must be the last write"
    );
    assert_eq!(marker_data(&crashed)["cortexkit"]["tag_checkpoint"], 20);
    let Outcome::Moved(plan) = run(&crashed, &fixture_session(), false, &NoHolders, None).unwrap()
    else {
        panic!("rerun did not move");
    };
    assert!(plan.marker_already_keyed);
    assert_eq!(snapshot(&crashed), reference);

    // A crash after the moved record is a finished move: rerunning refuses by
    // name and changes nothing.
    assert_eq!(refusal(&crashed).code, "already_moved");
    assert_eq!(snapshot(&crashed), reference);
}

#[test]
fn move_refuses_each_case_by_name_without_writing() {
    let cases: Vec<(&str, Box<dyn Fn(&StorePaths)>)> = vec![
        (
            "marker_pending_not_in_effect",
            Box::new(|paths| {
                Connection::open(&paths.context_db)
                    .unwrap()
                    .execute(
                        "UPDATE session_meta SET pending_compaction_marker_state='{\"ordinal\":9,\"endMessageId\":\"msg_m010\"}'",
                        [],
                    )
                    .unwrap();
            }),
        ),
        (
            "not_standalone_opencode1",
            Box::new(|paths| {
                Connection::open(&paths.context_db)
                    .unwrap()
                    .execute("UPDATE session_meta SET harness='pi'", [])
                    .unwrap();
            }),
        ),
        (
            "target_ambiguous",
            Box::new(|paths| {
                Connection::open(&paths.opencode_db).unwrap().execute(
                    "INSERT INTO part SELECT 'prt_m010_z', message_id, session_id, time_created, time_updated, data FROM part WHERE id='prt_m010_a'",
                    [],
                ).unwrap();
            }),
        ),
        (
            "fork_unsupported",
            Box::new(|paths| {
                Connection::open(&paths.opencode_db).unwrap().execute(
                    "UPDATE part SET data=json_set(data,'$.cortexkit',json('{\"tag_checkpoint\":20,\"session\":\"ses_parent\"}')) WHERE json_extract(data,'$.type')='compaction'",
                    [],
                ).unwrap();
            }),
        ),
        (
            "checkpoint_conflict",
            Box::new(|paths| {
                let session = fixture_session();
                Connection::open(&paths.opencode_db).unwrap().execute(
                    "UPDATE part SET data=json_set(data,'$.cortexkit',json(?1)) WHERE json_extract(data,'$.type')='compaction'",
                    [json!({"tag_checkpoint":7,"session":session}).to_string()],
                ).unwrap();
            }),
        ),
        (
            "marker_missing",
            Box::new(|paths| {
                Connection::open(&paths.opencode_db)
                    .unwrap()
                    .execute(
                        "DELETE FROM message WHERE json_extract(data,'$.summary')=1",
                        [],
                    )
                    .unwrap();
            }),
        ),
        (
            "address_malformed",
            Box::new(|paths| {
                Connection::open(&paths.context_db)
                    .unwrap()
                    .execute(
                        "UPDATE tags SET message_id='msg_m008#3' WHERE tag_number=13",
                        [],
                    )
                    .unwrap();
            }),
        ),
        (
            "destination_not_empty",
            Box::new(|paths| {
                Connection::open(&paths.store_db).unwrap().execute(
                    "INSERT INTO mc_async_compaction(session_ref,conversation_key,session,state_json) VALUES ('r','k',?1,'{}')",
                    [fixture_session()],
                ).unwrap();
            }),
        ),
        (
            "queue_invalid",
            Box::new(|paths| {
                Connection::open(&paths.context_db)
                    .unwrap()
                    .execute(
                        "UPDATE pending_ops SET operation='caveman' WHERE tag_id=16",
                        [],
                    )
                    .unwrap();
            }),
        ),
    ];
    for (code, break_source) in cases {
        let dir = tempfile::tempdir().unwrap();
        let paths = write_stores(dir.path());
        break_source(&paths);
        let before = snapshot(&paths);
        let refused = refusal(&paths);
        assert_eq!(refused.code, code, "{refused}");
        assert_eq!(snapshot(&paths), before, "{code} wrote a store");
    }
    // Another session, and a held store.
    let dir = tempfile::tempdir().unwrap();
    let paths = write_stores(dir.path());
    let other = run(&paths, "ses_other", false, &NoHolders, None);
    assert!(
        matches!(&other, Err(MoveError::Refused(r)) if r.code == "not_standalone_opencode1"),
        "{other:?}"
    );
    let held = run(
        &paths,
        &fixture_session(),
        false,
        &Held("opencode/4242"),
        None,
    );
    assert!(
        matches!(&held, Err(MoveError::Refused(r)) if r.code == "stores_in_use" && r.detail.contains("opencode/4242")),
        "{held:?}"
    );
    moved(&paths);
    assert_eq!(refusal(&paths).code, "already_moved");
}

/// The real holder check sees another process that holds `context.db` open.
#[test]
fn move_refuses_while_another_process_holds_a_store() {
    let dir = tempfile::tempdir().unwrap();
    let paths = write_stores(dir.path());
    let mut child = std::process::Command::new("sh")
        .arg("-c")
        .arg("exec 3<\"$1\"; echo ready; exec sleep 30")
        .arg("sh")
        .arg(&paths.context_db)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut ready = String::new();
    std::io::BufRead::read_line(
        &mut std::io::BufReader::new(child.stdout.as_mut().unwrap()),
        &mut ready,
    )
    .unwrap();
    let held = run(&paths, &fixture_session(), false, &Lsof, None);
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(
        matches!(&held, Err(MoveError::Refused(r)) if r.code == "stores_in_use"),
        "{held:?}"
    );
    assert!(record(&paths).is_none());
    // With the holder gone the same check passes.
    check_holders(&paths, &Lsof).unwrap();
}

fn part(id: &str, kind: &str) -> PartRow {
    PartRow {
        id: id.into(),
        kind: kind.into(),
        call_id: None,
        blank_text: false,
    }
}

#[test]
fn positional_resolution_follows_standalone_exact_then_ordinal_fallback() {
    // Exact addresses bind by part index, not by text ordinal.
    let parts = [
        part("r", "reasoning"),
        part("a", "text"),
        part("t", "tool"),
        part("b", "text"),
    ];
    let bound = resolve_positional_tags(
        &parts,
        &[(PositionalKind::Text, 1, 11), (PositionalKind::Text, 3, 13)],
    );
    assert_eq!(bound.get(&11).map(String::as_str), Some("a"));
    assert_eq!(bound.get(&13).map(String::as_str), Some("b"));
    // A part inserted before the text (the compaction part on the boundary
    // message) shifts the index; the ordinal fallback rebinds the tag.
    let parts = [part("c", "compaction"), part("a", "text")];
    let bound = resolve_positional_tags(&parts, &[(PositionalKind::Text, 0, 7)]);
    assert_eq!(bound.get(&7).map(String::as_str), Some("a"));
    // The fallback never takes an address an earlier part already claimed.
    let parts = [part("x", "text"), part("y", "text")];
    let bound = resolve_positional_tags(
        &parts,
        &[(PositionalKind::Text, 0, 1), (PositionalKind::Text, 5, 2)],
    );
    assert_eq!(bound.get(&1).map(String::as_str), Some("x"));
    assert_eq!(bound.get(&2).map(String::as_str), Some("y"));
    // Files resolve with their own ordinal.
    let parts = [part("t", "text"), part("f", "file")];
    let bound = resolve_positional_tags(&parts, &[(PositionalKind::File, 1, 9)]);
    assert_eq!(bound.get(&9).map(String::as_str), Some("f"));
    assert_eq!(
        parse_positional("msg_a:p12"),
        Some(("msg_a", PositionalKind::Text, 12))
    );
    assert_eq!(
        parse_positional("msg_a:file3"),
        Some(("msg_a", PositionalKind::File, 3))
    );
    assert_eq!(parse_positional("msg_a#3"), None);
}
