#[path = "../src/retrieval_vectors/drain.rs"]
mod drain;
#[path = "../src/retrieval_vectors/store.rs"]
mod store;

use drain::{ClaimOutcome, FinishOutcome, Registration};
use mc_store::{
    compute_normalized_memory_hash,
    context_schema::BOOTSTRAP,
    parity_schema_manifest::{
        CapabilityResult, ContextSchemaRequest, ContextSchemaStore, Generation,
    },
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{fs, path::Path, process::Command, sync::OnceLock};
use store::{ChunkCatalog, ChunkSpan, Kind, Passage, Source};
use tempfile::TempDir;

struct Golden {
    value: Value,
    database: Vec<u8>,
}
fn golden() -> &'static Golden {
    static GOLDEN: OnceLock<Golden> = OnceLock::new();
    GOLDEN.get_or_init(|| {
        let root = TempDir::new().unwrap();
        let database = root.path().join("typescript.db");
        let output = root.path().join("typescript.json");
        generator(&[database.as_path(), output.as_path()]);
        Golden {
            value: serde_json::from_slice(&fs::read(output).unwrap()).unwrap(),
            database: fs::read(database).unwrap(),
        }
    })
}
fn generator(args: &[&Path]) {
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/retrieval_vectors/generate.ts");
    let result = Command::new("bun")
        .arg(script)
        .args(args)
        .output()
        .expect("Bun is required to run the real TypeScript vector stores");
    assert!(
        result.status.success(),
        "TypeScript generator failed:\n{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    println!("{}", String::from_utf8_lossy(&result.stdout).trim());
}
fn fresh(path: &Path) -> Connection {
    let request = ContextSchemaRequest {
        database_path: path.to_str().unwrap().into(),
        expected_schema_version: mc_store::context_schema::BOOTSTRAP_VERSION,
        writer_generation: Generation(1),
    };
    assert!(matches!(
        BOOTSTRAP.bootstrap(&request),
        CapabilityResult::Available { .. }
    ));
    Connection::open(path).unwrap()
}
fn seed(db: &Connection) {
    let g = &golden().value;
    for (index, text) in g["texts"].as_array().unwrap().iter().enumerate() {
        let text = text.as_str().unwrap();
        db.execute(
            "INSERT INTO memories(id,project_path,category,content,normalized_hash,
            first_seen_at,created_at,updated_at,last_seen_at) VALUES(?1,?2,'fact',?3,?4,1,1,1,1)",
            params![
                index as i64 + 1,
                project(),
                text,
                compute_normalized_memory_hash(text)
            ],
        )
        .unwrap();
    }
    db.execute(
        "INSERT INTO git_commits(sha,project_path,short_sha,message,committed_at,indexed_at)
        VALUES('sha-a',?1,'sha-a','Commit message',10,1)",
        [project()],
    )
    .unwrap();
    db.execute("INSERT INTO compartments(id,session_id,sequence,start_message,end_message,title,content,created_at)
        VALUES(1,'session-a',1,0,1,'Vector fixture',?1,1)", [g["windows"][0]["text"].as_str().unwrap()]).unwrap();
    db.execute(
        "INSERT INTO session_projects(session_id,harness,project_path,updated_at)
        VALUES('session-a','opencode',?1,1)",
        [project()],
    )
    .unwrap();
}
fn project() -> &'static str {
    "/fixture/project"
}
fn registration() -> Registration {
    Registration {
        project: project().into(),
        model_id: "embedding-provider:fixture-a".into(),
        chunk_model_id: "embedding-provider:fixture-a:raw-window-fixture".into(),
        fingerprint: "fixture-fingerprint".into(),
        table_epoch: 1,
        dimensions: 4,
        generation: 1,
    }
}
fn register(db: &Connection, r: &Registration) {
    db.execute("INSERT INTO embedding_registrations(project_path,model_id,chunk_model_id,fingerprint,
        table_epoch,dims,generation,provenance_json) VALUES(?1,?2,?3,?4,?5,?6,?7,'{\"unrelated\":42}')",
        params![r.project, r.model_id, r.chunk_model_id, r.fingerprint, r.table_epoch, r.dimensions as i64, r.generation]).unwrap();
}
fn vector(index: usize) -> Vec<f32> {
    golden().value["vectors"][index]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap() as f32)
        .collect()
}

/// A fake archive reader for tests: each compartment's content is one raw transcript
/// window formatted by TypeScript's `chunkCanonicalText` (ordinal/role-prefixed lines).
/// Production readers supply these windows from raw archive data through ChunkCatalog.
struct Archive;
impl ChunkCatalog for Archive {
    fn pending(
        &self,
        db: &Connection,
        project: &str,
        model_id: &str,
        limit: usize,
    ) -> rusqlite::Result<Vec<Passage>> {
        let mut statement = db.prepare("SELECT c.id,c.session_id,c.harness,c.start_message,c.end_message,c.content
            FROM compartments c JOIN session_projects sp ON sp.session_id=c.session_id AND sp.harness=c.harness
            WHERE sp.project_path=?1 ORDER BY c.created_at DESC,c.id DESC LIMIT ?2")?;
        let candidates = statement
            .query_map(params![project, limit as i64], |row| {
                let text: String = row.get(5)?;
                Ok(Passage {
                    source: Source::Chunk {
                        compartment_id: row.get(0)?,
                        window_index: 0,
                    },
                    project: project.into(),
                    content_hash: store::content_sha256(&text),
                    text,
                    span: Some(ChunkSpan {
                        session_id: row.get(1)?,
                        harness: row.get(2)?,
                        start_ordinal: row.get(3)?,
                        end_ordinal: row.get(4)?,
                    }),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = Vec::new();
        for passage in candidates {
            let Source::Chunk { compartment_id, .. } = passage.source else {
                unreachable!()
            };
            let covered: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM compartment_chunk_embeddings
                WHERE compartment_id=?1 AND window_index=0 AND model_id=?2 AND chunk_hash=?3)",
                params![compartment_id, model_id, passage.content_hash],
                |row| row.get(0),
            )?;
            if !covered {
                out.push(passage);
            }
        }
        Ok(out)
    }
    fn current(&self, db: &Connection, passage: &Passage) -> rusqlite::Result<bool> {
        let Source::Chunk {
            compartment_id,
            window_index,
        } = passage.source
        else {
            return Ok(false);
        };
        let Some(span) = &passage.span else {
            return Ok(false);
        };
        let mut statement = db.prepare("SELECT c.content FROM compartments c JOIN session_projects sp
            ON sp.session_id=c.session_id AND sp.harness=c.harness WHERE c.id=?1 AND sp.project_path=?2
            AND c.session_id=?3 AND c.harness=?4 AND c.start_message=?5 AND c.end_message=?6")?;
        let mut rows = statement.query(params![
            compartment_id,
            passage.project,
            span.session_id,
            span.harness,
            span.start_ordinal,
            span.end_ordinal
        ])?;
        Ok(window_index == 0
            && rows.next()?.is_some_and(|row| {
                row.get::<_, String>(0)
                    .is_ok_and(|text| store::content_sha256(&text) == passage.content_hash)
            }))
    }
}

fn passages(db: &Connection, kind: Kind) -> Vec<Passage> {
    let r = registration();
    store::pending(db, &Archive, project(), kind, r.model(kind), 64).unwrap()
}
fn write_vectors(db: &mut Connection) {
    let r = registration();
    for kind in Kind::ALL {
        let inputs = passages(db, kind);
        let tx = db.transaction().unwrap();
        for (index, input) in inputs.iter().enumerate() {
            let values = vector(if kind == Kind::Commit {
                1
            } else if kind == Kind::Chunk {
                0
            } else {
                index
            });
            assert!(
                store::save_if_current(&tx, &Archive, input, r.model(kind), &values, 123).unwrap()
            );
        }
        if kind == Kind::Memory {
            assert!(store::save_if_current(
                &tx,
                &Archive,
                &inputs[0],
                "other-model",
                &[0., 1., 0., 0.],
                123
            )
            .unwrap());
        }
        tx.commit().unwrap();
    }
}
fn assert_rankings(db: &Connection) {
    let r = registration();
    let query: Vec<f32> = golden().value["query"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap() as f32)
        .collect();
    for (kind, key) in [
        (Kind::Memory, "memory"),
        (Kind::Commit, "commit"),
        (Kind::Chunk, "chunk"),
    ] {
        let rows = store::load(db, &Archive, project(), kind, r.model(kind), 4).unwrap();
        let mut scores: Vec<_> = rows
            .iter()
            .map(|row| {
                let id = match &row.source {
                    Source::Memory { id } => json!(id),
                    Source::Commit { sha } => json!(sha),
                    Source::Chunk { window_index, .. } => json!(window_index),
                };
                (id, store::cosine_similarity(&query, &row.values))
            })
            .collect();
        scores.sort_by(|a, b| {
            b.1.total_cmp(&a.1)
                .then_with(|| a.0.to_string().cmp(&b.0.to_string()))
        });
        let expected = golden().value["rankings"][key].as_array().unwrap();
        assert_eq!(scores.len(), expected.len(), "{key} count");
        for ((id, score), expected) in scores.iter().zip(expected) {
            assert_eq!(*id, expected["id"], "{key} ranking");
            assert!(
                (score - expected["score"].as_f64().unwrap()).abs() < 1e-15,
                "{key} score {score} vs {expected}"
            );
        }
    }
}

#[test]
fn real_typescript_rows_and_cosine_are_interchangeable_both_directions() {
    let root = TempDir::new().unwrap();
    let imported = root.path().join("import.db");
    fs::write(&imported, &golden().database).unwrap();
    let db = Connection::open(&imported).unwrap();
    // Give the fake reader the same ordinal/role-prefixed window text as the TypeScript planner.
    db.execute(
        "UPDATE compartments SET content=?1 WHERE id=1",
        [golden().value["windows"][0]["text"].as_str().unwrap()],
    )
    .unwrap();
    assert_rankings(&db);
    let path = root.path().join("rust.db");
    let mut db = fresh(&path);
    seed(&db);
    write_vectors(&mut db);
    assert_rankings(&db);
    assert_eq!(
        serde_json::to_value(
            store::memory_coverage(&db, project(), &registration().model_id).unwrap()
        )
        .unwrap(),
        golden().value["coverage"]
    );
    drop(db);
    let output = root.path().join("rust-via-typescript.json");
    generator(&[Path::new("--inspect"), &path, &output]);
    let actual: Value = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
    assert_eq!(actual["rows"], golden().value["rows"]);
    assert_eq!(actual["decoded"], golden().value["decoded"]);
    assert_eq!(actual["rankings"], golden().value["rankings"]);
    assert_eq!(actual["coverage"], golden().value["coverage"]);
    for edge in golden().value["cosineEdges"].as_array().unwrap() {
        assert_eq!(edge.as_f64().unwrap(), 0.0);
    }
    assert_eq!(store::cosine_similarity(&[], &[]), 0.0);
    assert_eq!(store::cosine_similarity(&[1.], &[1., 2.]), 0.0);
    assert_eq!(store::cosine_similarity(&[1.], &[0.]), 0.0);
}

#[test]
fn model_identity_fence_excludes_other_models_and_projects() {
    let root = TempDir::new().unwrap();
    let mut db = fresh(&root.path().join("context.db"));
    seed(&db);
    write_vectors(&mut db);
    let r = registration();
    for kind in Kind::ALL {
        assert!(
            store::load(&db, &Archive, project(), kind, "absent-model", 4)
                .unwrap()
                .is_empty()
        );
        assert!(
            store::load(&db, &Archive, "/other-project", kind, r.model(kind), 4)
                .unwrap()
                .is_empty()
        );
        assert!(
            store::load(&db, &Archive, project(), kind, r.model(kind), 3)
                .unwrap()
                .is_empty()
        );
    }
    let alternate = store::load(&db, &Archive, project(), Kind::Memory, "other-model", 4).unwrap();
    assert_eq!(alternate.len(), 1);
    assert_eq!(alternate[0].values, vec![0., 1., 0., 0.]);
    assert!(store::decode(&[1, 2, 3], 1).is_none());
    assert!(store::decode(&store::encode(&[f32::NAN]), 1).is_none());
}

fn take_claim(db: &mut Connection, r: &Registration, now: i64, limit: usize) -> drain::Claim {
    match drain::claim(db, &Archive, r, limit, now, 100).unwrap() {
        ClaimOutcome::Claimed(claim) => *claim,
        other => panic!("expected claim, got {other:?}"),
    }
}
fn answers(claim: &drain::Claim) -> Vec<Vec<f32>> {
    vec![vector(0); claim.passages().len()]
}
fn master(db: &Connection) -> Vec<(String, String)> {
    db.prepare("SELECT name,coalesce(sql,'') FROM sqlite_master ORDER BY name")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

#[test]
fn stale_generation_cannot_publish() {
    let root = TempDir::new().unwrap();
    let mut db = fresh(&root.path().join("context.db"));
    seed(&db);
    let r = registration();
    register(&db, &r);
    let claim = take_claim(&mut db, &r, 1, 1);
    assert_eq!(claim.registration(), &r);
    // Keep provenance_json unchanged: only generation differs, so rejection cannot
    // come from comparing the lease's saved JSON against a changed JSON value.
    db.execute(
        "UPDATE embedding_registrations SET generation=2 WHERE project_path=?1",
        [project()],
    )
    .unwrap();
    assert_eq!(
        drain::finish(&mut db, &Archive, &claim, &answers(&claim), 2).unwrap(),
        FinishOutcome::Superseded
    );
    assert_eq!(
        db.query_row::<i64, _, _>("SELECT count(*) FROM memory_embeddings", [], |row| row
            .get(0))
            .unwrap(),
        0
    );
    assert!(!drain::fail(&mut db, &claim, 3).unwrap());
}

#[test]
fn model_change_and_same_generation_cas_reject_delayed_batches() {
    let root = TempDir::new().unwrap();
    let mut db = fresh(&root.path().join("context.db"));
    seed(&db);
    let r = registration();
    register(&db, &r);
    let claim = take_claim(&mut db, &r, 1, 1);
    db.execute(
        "UPDATE embedding_registrations SET model_id='new-model' WHERE project_path=?1",
        [project()],
    )
    .unwrap();
    assert_eq!(
        drain::finish(&mut db, &Archive, &claim, &answers(&claim), 2).unwrap(),
        FinishOutcome::Superseded
    );
    db.execute(
        "UPDATE embedding_registrations SET model_id=?1 WHERE project_path=?2",
        params![r.model_id, project()],
    )
    .unwrap();
    db.execute(
        "UPDATE embedding_registrations SET provenance_json='{}' WHERE project_path=?1",
        [project()],
    )
    .unwrap();
    let newer = take_claim(&mut db, &r, 3, 1);
    assert_eq!(
        drain::finish(&mut db, &Archive, &claim, &answers(&claim), 4).unwrap(),
        FinishOutcome::Superseded
    );
    assert_eq!(
        drain::finish(&mut db, &Archive, &newer, &answers(&newer), 5).unwrap(),
        FinishOutcome::Published {
            accepted: 1,
            discarded: 0
        }
    );
    assert_eq!(
        drain::finish(&mut db, &Archive, &newer, &answers(&newer), 6).unwrap(),
        FinishOutcome::Superseded
    );
    assert_eq!(drain::progress(&db, &r).unwrap().unwrap().accepted, 1);
}

#[test]
fn text_mutation_invalidates_all_models_and_hash_guard_discards_inflight_vectors() {
    let root = TempDir::new().unwrap();
    let mut db = fresh(&root.path().join("context.db"));
    seed(&db);
    let memory = passages(&db, Kind::Memory).remove(0);
    let commit = passages(&db, Kind::Commit).remove(0);
    let chunk = passages(&db, Kind::Chunk).remove(0);
    write_vectors(&mut db);
    let r = registration();
    let tx = db.transaction().unwrap();
    tx.execute(
        "UPDATE memories SET content='Changed',normalized_hash=?1,revision=revision+1 WHERE id=1",
        [compute_normalized_memory_hash("Changed")],
    )
    .unwrap();
    assert_eq!(store::invalidate(&tx, &memory.source).unwrap(), 2);
    tx.execute(
        "UPDATE git_commits SET message='Changed commit' WHERE sha='sha-a'",
        [],
    )
    .unwrap();
    store::invalidate(&tx, &commit.source).unwrap();
    tx.execute(
        "UPDATE compartments SET content='[0] U: Changed raw text' WHERE id=1",
        [],
    )
    .unwrap();
    tx.commit().unwrap();
    assert!(
        store::load(&db, &Archive, project(), Kind::Memory, &r.model_id, 4)
            .unwrap()
            .iter()
            .all(|row| row.source != memory.source)
    );
    assert!(
        store::load(&db, &Archive, project(), Kind::Commit, &r.model_id, 4)
            .unwrap()
            .is_empty()
    );
    // Comparing the current raw text's hash prevents loading its old vector even
    // before the writer explicitly deletes that vector row.
    assert!(
        store::load(&db, &Archive, project(), Kind::Chunk, &r.chunk_model_id, 4)
            .unwrap()
            .is_empty()
    );
    let tx = db.transaction().unwrap();
    for old in [&memory, &commit, &chunk] {
        assert!(!store::save_if_current(
            &tx,
            &Archive,
            old,
            r.model(old.source.kind()),
            &vector(0),
            123
        )
        .unwrap());
    }
    store::invalidate(&tx, &chunk.source).unwrap();
    tx.commit().unwrap();
    let changed = passages(&db, Kind::Memory).remove(0);
    assert_eq!(changed.text, "Changed");
    let tx = db.transaction().unwrap();
    assert!(store::save_if_current(&tx, &Archive, &changed, &r.model_id, &vector(1), 123).unwrap());
    tx.commit().unwrap();
    assert_eq!(
        store::load(&db, &Archive, project(), Kind::Memory, &r.model_id, 4).unwrap()[0].values,
        vector(1)
    );
    // A status-only archival leaves vector bytes unchanged; deleting the source
    // removes them, matching storage-memory.ts archiveMemory/deleteMemory.
    db.execute("UPDATE memories SET status='archived' WHERE id=1", [])
        .unwrap();
    assert_eq!(
        store::load(&db, &Archive, project(), Kind::Memory, &r.model_id, 4)
            .unwrap()
            .len(),
        4
    );
    let tx = db.transaction().unwrap();
    store::invalidate(&tx, &changed.source).unwrap();
    tx.execute("DELETE FROM memories WHERE id=1", []).unwrap();
    tx.commit().unwrap();
    assert_eq!(
        store::load(&db, &Archive, project(), Kind::Memory, &r.model_id, 4)
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn bounded_round_robin_jobs_resume_after_restart_and_report_progress_without_schema_changes() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("context.db");
    let mut db = fresh(&path);
    seed(&db);
    let r = registration();
    register(&db, &r);
    let schema = master(&db);
    assert!(drain::claim(&mut db, &Archive, &r, drain::MAX_BATCH + 1, 1, 100).is_err());
    assert!(drain::claim(&mut db, &Archive, &r, 1, 1, drain::MAX_LEASE_MS + 1).is_err());
    let abandoned = take_claim(&mut db, &r, 1, 1);
    assert_eq!(abandoned.kind(), Kind::Memory);
    assert_eq!(
        drain::claim(&mut db, &Archive, &r, 1, 2, 100).unwrap(),
        ClaimOutcome::Busy
    );
    drop(db);
    let mut db = Connection::open(&path).unwrap();
    let commit = take_claim(&mut db, &r, 102, 1);
    assert_eq!(commit.kind(), Kind::Commit);
    assert_eq!(
        drain::finish(&mut db, &Archive, &abandoned, &answers(&abandoned), 103).unwrap(),
        FinishOutcome::Superseded
    );
    assert!(matches!(
        drain::finish(&mut db, &Archive, &commit, &answers(&commit), 104).unwrap(),
        FinishOutcome::Published { accepted: 1, .. }
    ));
    let chunk = take_claim(&mut db, &r, 105, 1);
    assert_eq!(chunk.kind(), Kind::Chunk);
    assert!(matches!(
        drain::finish(&mut db, &Archive, &chunk, &answers(&chunk), 106).unwrap(),
        FinishOutcome::Published { accepted: 1, .. }
    ));
    for now in 107..111 {
        let memory = take_claim(&mut db, &r, now, 1);
        assert_eq!(memory.kind(), Kind::Memory);
        assert_eq!(memory.passages().len(), 1);
        drain::finish(&mut db, &Archive, &memory, &answers(&memory), now).unwrap();
    }
    assert_eq!(
        drain::claim(&mut db, &Archive, &r, 1, 111, 100).unwrap(),
        ClaimOutcome::Drained
    );
    let state = drain::progress(&db, &r).unwrap().unwrap();
    assert_eq!(
        (
            state.batches,
            state.accepted,
            state.discarded,
            state.failures
        ),
        (6, 6, 0, 0)
    );
    let provenance: String = db
        .query_row(
            "SELECT provenance_json FROM embedding_registrations WHERE project_path=?1",
            [project()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&provenance).unwrap()["unrelated"],
        42
    );
    assert!(provenance.len() < 512);
    assert_eq!(schema, master(&db));
    assert_eq!(
        store::clear_model(&db, project(), Kind::Memory, &r.model_id).unwrap(),
        4
    );
    assert_eq!(passages(&db, Kind::Memory).len(), 4);
}

struct Provider {
    calls: usize,
    fail: bool,
    invalid: bool,
}
impl drain::EmbeddingProvider for Provider {
    fn embed(&mut self, _: &Registration, passages: &[Passage]) -> Result<Vec<Vec<f32>>, String> {
        self.calls += 1;
        if self.fail {
            Err("offline injected provider".into())
        } else if self.invalid {
            Ok(vec![vec![f32::NAN]; passages.len()])
        } else {
            Ok(vec![vector(0); passages.len()])
        }
    }
}
#[test]
fn provider_failures_and_invalid_results_stay_pending_and_do_not_starve_other_sources() {
    let root = TempDir::new().unwrap();
    let mut db = fresh(&root.path().join("context.db"));
    seed(&db);
    let r = registration();
    register(&db, &r);
    let mut provider = Provider {
        calls: 0,
        fail: true,
        invalid: false,
    };
    let error = drain::drain_once(&mut db, &Archive, &mut provider, &r, 1, 1, || 2).unwrap_err();
    assert!(
        matches!(error, drain::DrainError::Provider(message) if message == "offline injected provider")
    );
    let commit = take_claim(&mut db, &r, 3, 1);
    assert_eq!(commit.kind(), Kind::Commit);
    assert!(drain::fail(&mut db, &commit, 4).unwrap());
    provider.fail = false;
    provider.invalid = true;
    assert!(matches!(
        drain::drain_once(&mut db, &Archive, &mut provider, &r, 1, 5, || 6),
        Err(drain::DrainError::InvalidVectors)
    ));
    provider.invalid = false;
    assert_eq!(
        drain::drain_once(&mut db, &Archive, &mut provider, &r, 1, 7, || 8).unwrap(),
        Some(FinishOutcome::Published {
            accepted: 1,
            discarded: 0
        })
    );
    let state = drain::progress(&db, &r).unwrap().unwrap();
    assert_eq!(state.failures, 3);
    assert_eq!(state.accepted, 1);
    assert_eq!(provider.calls, 3);
    assert_eq!(passages(&db, Kind::Memory).len(), 3);
}

#[test]
fn content_change_during_backfill_is_discarded_and_can_be_retried() {
    let root = TempDir::new().unwrap();
    let mut db = fresh(&root.path().join("context.db"));
    seed(&db);
    let r = registration();
    register(&db, &r);
    let claim = take_claim(&mut db, &r, 1, 1);
    let tx = db.transaction().unwrap();
    tx.execute(
        "UPDATE memories SET content='new',normalized_hash=?1 WHERE id=1",
        [compute_normalized_memory_hash("new")],
    )
    .unwrap();
    store::invalidate(&tx, &claim.passages()[0].source).unwrap();
    tx.commit().unwrap();
    assert_eq!(
        drain::finish(&mut db, &Archive, &claim, &answers(&claim), 2).unwrap(),
        FinishOutcome::Published {
            accepted: 0,
            discarded: 1
        }
    );
    assert_eq!(drain::progress(&db, &r).unwrap().unwrap().discarded, 1);
    assert_eq!(passages(&db, Kind::Memory)[0].text, "new");
}

#[test]
fn chunk_replacement_removes_obsolete_windows_only_for_the_target_model() {
    let root = TempDir::new().unwrap();
    let mut db = fresh(&root.path().join("context.db"));
    seed(&db);
    let r = registration();
    let input = passages(&db, Kind::Chunk).remove(0);
    let tx = db.transaction().unwrap();
    assert!(
        store::save_if_current(&tx, &Archive, &input, &r.chunk_model_id, &vector(1), 123).unwrap()
    );
    tx.execute("INSERT INTO compartment_chunk_embeddings(compartment_id,session_id,project_path,harness,
        window_index,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,created_at)
        SELECT compartment_id,session_id,project_path,harness,1,start_ordinal,end_ordinal,chunk_hash,
        model_id,dims,vector,created_at FROM compartment_chunk_embeddings", []).unwrap();
    assert!(
        store::save_if_current(&tx, &Archive, &input, "shadow-model", &vector(1), 123).unwrap()
    );
    assert_eq!(
        store::replace_chunks_if_current(
            &tx,
            &Archive,
            &[input],
            &r.chunk_model_id,
            &[vector(0)],
            123
        )
        .unwrap(),
        1
    );
    tx.commit().unwrap();
    assert_eq!(
        db.query_row::<i64, _, _>(
            "SELECT count(*) FROM compartment_chunk_embeddings",
            [],
            |row| row.get(0)
        )
        .unwrap(),
        2
    );
    let rows = store::load(&db, &Archive, project(), Kind::Chunk, &r.chunk_model_id, 4).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].values, vector(0));
    assert_eq!(rows[0].model_id, r.chunk_model_id);
}
