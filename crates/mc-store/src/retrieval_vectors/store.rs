//! Read and write the host's SQLite float32 vector rows without changing their schema.
//! Source text writers must delete old vectors in the same transaction as a text change,
//! because memory and commit vector rows do not persist the hash of their input text.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_SELECTION: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Memory,
    Commit,
    Chunk,
}

impl Kind {
    pub const ALL: [Self; 3] = [Self::Memory, Self::Commit, Self::Chunk];
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Source {
    Memory {
        id: i64,
    },
    Commit {
        sha: String,
    },
    Chunk {
        compartment_id: i64,
        window_index: i64,
    },
}

impl Source {
    pub fn kind(&self) -> Kind {
        match self {
            Self::Memory { .. } => Kind::Memory,
            Self::Commit { .. } => Kind::Commit,
            Self::Chunk { .. } => Kind::Chunk,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkSpan {
    pub session_id: String,
    pub harness: String,
    pub start_ordinal: i64,
    pub end_ordinal: i64,
}

/// Text and hash must come from the same source snapshot. Chunk text is the canonical
/// raw window produced by the archive reader, not a summary or a provider-prefixed input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Passage {
    pub source: Source,
    pub project: String,
    pub text: String,
    pub content_hash: String,
    pub span: Option<ChunkSpan>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VectorRow {
    pub source: Source,
    pub model_id: String,
    pub values: Vec<f32>,
}

pub fn content_sha256(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// Bun's Float32Array blobs are native-endian on the supported little-endian hosts.
/// Explicit little-endian encoding also avoids alignment-dependent decoding.
pub fn encode(values: &[f32]) -> Vec<u8> {
    values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

pub fn decode(bytes: &[u8], dimensions: usize) -> Option<Vec<f32>> {
    if dimensions == 0 || bytes.len() != dimensions.checked_mul(4)? {
        return None;
    }
    let values: Vec<_> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect();
    values
        .iter()
        .all(|value| value.is_finite())
        .then_some(values)
}

/// Match JavaScript number arithmetic: f32 inputs, f64 products and accumulators.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() {
        return 0.0;
    }
    let (mut dot, mut norm_a, mut norm_b) = (0.0, 0.0, 0.0);
    for (&a, &b) in a.iter().zip(b) {
        let (a, b) = (f64::from(a), f64::from(b));
        dot += a * b;
        norm_a += a * a;
        norm_b += b * b;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        0.0
    } else {
        dot / (norm_a.sqrt() * norm_b.sqrt())
    }
}

/// The shared memory/commit vector schema has no input-hash column. Their text
/// writers must invalidate old vectors on text changes; this operation checks the
/// source's current hash against the embedded text to reject delayed provider replies.
pub fn save_if_current(
    db: &Transaction<'_>,
    chunks: &dyn ChunkCatalog,
    passage: &Passage,
    model_id: &str,
    values: &[f32],
    now_ms: i64,
) -> rusqlite::Result<bool> {
    if model_id.is_empty() || values.is_empty() || values.iter().any(|v| !v.is_finite()) {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let expected_hash = if passage.source.kind() == Kind::Memory {
        crate::compute_normalized_memory_hash(&passage.text)
    } else {
        content_sha256(&passage.text)
    };
    if expected_hash != passage.content_hash {
        return Ok(false);
    }
    let blob = encode(values);
    let changed = match &passage.source {
        Source::Memory { id } => db.execute(
            "INSERT INTO memory_embeddings(memory_id,embedding,model_id)
             SELECT id,?1,?2 FROM memories WHERE id=?3 AND project_path=?4 AND normalized_hash=?5
             ON CONFLICT(memory_id,model_id) DO UPDATE SET embedding=excluded.embedding",
            params![blob, model_id, id, passage.project, passage.content_hash],
        )?,
        Source::Commit { sha } => {
            let message: Option<String> = db
                .query_row(
                    "SELECT message FROM git_commits WHERE sha=?1 AND project_path=?2",
                    params![sha, passage.project],
                    |row| row.get(0),
                )
                .optional()?;
            if message.as_deref().map(content_sha256).as_deref() != Some(&passage.content_hash) {
                return Ok(false);
            }
            db.execute(
                "INSERT INTO git_commit_embeddings(sha,embedding,model_id,created_at) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(sha,model_id) DO UPDATE SET embedding=excluded.embedding,created_at=excluded.created_at",
                params![sha, blob, model_id, now_ms],
            )?
        }
        Source::Chunk {
            compartment_id,
            window_index,
        } => {
            if !chunks.current(db, passage)? {
                return Ok(false);
            }
            let span = passage.span.as_ref().ok_or(rusqlite::Error::InvalidQuery)?;
            if *window_index < 0
                || span.end_ordinal < span.start_ordinal
                || content_sha256(&passage.text) != passage.content_hash
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
            db.execute(
                "INSERT INTO compartment_chunk_embeddings(compartment_id,session_id,project_path,harness,
                   window_index,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,created_at)
                 SELECT c.id,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11 FROM compartments c
                 JOIN session_projects sp ON sp.session_id=c.session_id AND sp.harness=c.harness
                 WHERE c.id=?12 AND sp.project_path=?2 AND c.session_id=?1 AND c.harness=?3
                 ON CONFLICT(compartment_id,model_id,window_index) DO UPDATE SET
                   session_id=excluded.session_id,project_path=excluded.project_path,harness=excluded.harness,
                   start_ordinal=excluded.start_ordinal,end_ordinal=excluded.end_ordinal,
                   chunk_hash=excluded.chunk_hash,dims=excluded.dims,vector=excluded.vector,created_at=excluded.created_at",
                params![span.session_id, passage.project, span.harness, window_index, span.start_ordinal,
                    span.end_ordinal, passage.content_hash, model_id, values.len() as i64, blob, now_ms, compartment_id],
            )?
        }
    };
    Ok(changed > 0)
}

/// Supply raw transcript windows whose text has already been formatted and split
/// by the archive reader. `current` must compare a window's hash, ordinal range and
/// project/session/harness against current archive data. It must use the supplied
/// connection so a source edit cannot slip between validation and publication.
pub trait ChunkCatalog {
    /// Return at most `limit` missing/stale raw transcript windows. When text changes
    /// how it is split into windows, the text writer must delete all vector rows for
    /// that compartment (the transcript span), including obsolete window indexes.
    fn pending(
        &self,
        db: &Connection,
        project: &str,
        model_id: &str,
        limit: usize,
    ) -> rusqlite::Result<Vec<Passage>>;
    fn current(&self, db: &Connection, passage: &Passage) -> rusqlite::Result<bool>;
}

pub fn pending(
    db: &Connection,
    chunks: &dyn ChunkCatalog,
    project: &str,
    kind: Kind,
    model_id: &str,
    limit: usize,
) -> rusqlite::Result<Vec<Passage>> {
    if limit > MAX_SELECTION {
        return Err(rusqlite::Error::InvalidQuery);
    }
    if limit == 0 {
        return Ok(Vec::new());
    }
    match kind {
        Kind::Memory => db
            .prepare(
                "SELECT id,content,normalized_hash FROM memories m WHERE project_path=?1
             AND status IN ('active','permanent') AND NOT EXISTS
             (SELECT 1 FROM memory_embeddings e WHERE e.memory_id=m.id AND e.model_id=?2)
             ORDER BY id ASC LIMIT ?3",
            )?
            .query_map(params![project, model_id, limit as i64], |row| {
                Ok(Passage {
                    source: Source::Memory { id: row.get(0)? },
                    project: project.into(),
                    text: row.get(1)?,
                    content_hash: row.get(2)?,
                    span: None,
                })
            })?
            .collect(),
        Kind::Commit => db
            .prepare(
                "SELECT sha,message FROM git_commits c WHERE project_path=?1 AND NOT EXISTS
             (SELECT 1 FROM git_commit_embeddings e WHERE e.sha=c.sha AND e.model_id=?2)
             ORDER BY committed_at DESC,sha ASC LIMIT ?3",
            )?
            .query_map(params![project, model_id, limit as i64], |row| {
                let text: String = row.get(1)?;
                Ok(Passage {
                    source: Source::Commit { sha: row.get(0)? },
                    project: project.into(),
                    content_hash: content_sha256(&text),
                    text,
                    span: None,
                })
            })?
            .collect(),
        Kind::Chunk => {
            let rows = chunks.pending(db, project, model_id, limit)?;
            if rows.len() > limit
                || rows
                    .iter()
                    .any(|row| row.project != project || row.source.kind() != Kind::Chunk)
            {
                return Err(rusqlite::Error::InvalidQuery);
            }
            Ok(rows)
        }
    }
}

/// Load only vectors for the requested project and stored model identity. Reject
/// corrupt or mismatched widths. The retrieval caller must still apply memory
/// status/access policy; this loader does not decide whether an archived row is visible.
pub fn load(
    db: &Connection,
    chunks: &dyn ChunkCatalog,
    project: &str,
    kind: Kind,
    model_id: &str,
    dimensions: usize,
) -> rusqlite::Result<Vec<VectorRow>> {
    let mut out = Vec::new();
    match kind {
        Kind::Memory | Kind::Commit => {
            let sql = if kind == Kind::Memory {
                "SELECT e.memory_id,e.embedding FROM memory_embeddings e JOIN memories m ON m.id=e.memory_id
                 WHERE m.project_path=?1 AND e.model_id=?2 ORDER BY e.memory_id ASC"
            } else {
                "SELECT e.sha,e.embedding FROM git_commit_embeddings e JOIN git_commits c ON c.sha=e.sha
                 WHERE c.project_path=?1 AND e.model_id=?2 ORDER BY e.sha ASC"
            };
            let mut statement = db.prepare(sql)?;
            let rows = statement.query_map(params![project, model_id], |row| {
                let source = if kind == Kind::Memory {
                    Source::Memory { id: row.get(0)? }
                } else {
                    Source::Commit { sha: row.get(0)? }
                };
                Ok((source, row.get::<_, Vec<u8>>(1)?))
            })?;
            for row in rows {
                let (source, bytes) = row?;
                if let Some(values) = decode(&bytes, dimensions) {
                    out.push(VectorRow {
                        source,
                        model_id: model_id.into(),
                        values,
                    });
                }
            }
        }
        Kind::Chunk => {
            let mut statement = db.prepare(
                "SELECT e.compartment_id,e.window_index,e.session_id,e.harness,e.start_ordinal,
                        e.end_ordinal,e.chunk_hash,e.dims,e.vector
                 FROM compartment_chunk_embeddings e JOIN compartments c ON c.id=e.compartment_id
                 JOIN session_projects sp ON sp.session_id=c.session_id AND sp.harness=c.harness
                 WHERE e.project_path=?1 AND sp.project_path=?1 AND e.session_id=c.session_id
                   AND e.harness=c.harness AND e.model_id=?2 ORDER BY e.compartment_id ASC,e.window_index ASC",
            )?;
            let rows = statement.query_map(params![project, model_id], |row| {
                Ok((
                    Passage {
                        source: Source::Chunk {
                            compartment_id: row.get(0)?,
                            window_index: row.get(1)?,
                        },
                        project: project.into(),
                        text: String::new(),
                        content_hash: row.get(6)?,
                        span: Some(ChunkSpan {
                            session_id: row.get(2)?,
                            harness: row.get(3)?,
                            start_ordinal: row.get(4)?,
                            end_ordinal: row.get(5)?,
                        }),
                    },
                    row.get::<_, i64>(7)?,
                    row.get::<_, Vec<u8>>(8)?,
                ))
            })?;
            for row in rows {
                let (passage, dims, bytes) = row?;
                if dims == dimensions as i64 && chunks.current(db, &passage)? {
                    if let Some(values) = decode(&bytes, dimensions) {
                        out.push(VectorRow {
                            source: passage.source,
                            model_id: model_id.into(),
                            values,
                        });
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Call in the same transaction that changes or deletes source text. Delete vectors
/// for every model, including experimental alternatives. A status-only change to
/// `archived` does not change text and need not delete vectors, matching the host writer.
pub fn invalidate(db: &Connection, source: &Source) -> rusqlite::Result<usize> {
    match source {
        Source::Memory { id } => {
            db.execute("DELETE FROM memory_embeddings WHERE memory_id=?1", [id])
        }
        Source::Commit { sha } => {
            db.execute("DELETE FROM git_commit_embeddings WHERE sha=?1", [sha])
        }
        Source::Chunk { compartment_id, .. } => db.execute(
            "DELETE FROM compartment_chunk_embeddings WHERE compartment_id=?1",
            [compartment_id],
        ),
    }
}

pub fn clear_model(
    db: &Connection,
    project: &str,
    kind: Kind,
    model_id: &str,
) -> rusqlite::Result<usize> {
    match kind {
        Kind::Memory => db.execute(
            "DELETE FROM memory_embeddings WHERE model_id=?1 AND memory_id IN
             (SELECT id FROM memories WHERE project_path=?2)",
            params![model_id, project],
        ),
        Kind::Commit => db.execute(
            "DELETE FROM git_commit_embeddings WHERE model_id=?1 AND sha IN
             (SELECT sha FROM git_commits WHERE project_path=?2)",
            params![model_id, project],
        ),
        Kind::Chunk => db.execute(
            "DELETE FROM compartment_chunk_embeddings WHERE model_id=?1 AND project_path=?2",
            params![model_id, project],
        ),
    }
}

/// Replace all windows for one transcript compartment/model together, deleting
/// obsolete windows when the new text splits differently. Supply the complete set
/// here, not just one partial embedding-provider response.
pub fn replace_chunks_if_current(
    db: &Transaction<'_>,
    chunks: &dyn ChunkCatalog,
    passages: &[Passage],
    model_id: &str,
    vectors: &[Vec<f32>],
    now_ms: i64,
) -> rusqlite::Result<usize> {
    if model_id.is_empty() || passages.is_empty() || passages.len() != vectors.len() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let Source::Chunk { compartment_id, .. } = passages[0].source else {
        return Err(rusqlite::Error::InvalidQuery);
    };
    let mut windows = std::collections::BTreeSet::new();
    for (passage, vector) in passages.iter().zip(vectors) {
        let Source::Chunk {
            compartment_id: id,
            window_index,
        } = passage.source
        else {
            return Err(rusqlite::Error::InvalidQuery);
        };
        if id != compartment_id
            || passage.project != passages[0].project
            || window_index < 0
            || !windows.insert(window_index)
            || vector.is_empty()
            || vector.len() != vectors[0].len()
            || vector.iter().any(|x| !x.is_finite())
            || passage
                .span
                .as_ref()
                .is_none_or(|span| span.end_ordinal < span.start_ordinal)
            || content_sha256(&passage.text) != passage.content_hash
        {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if !chunks.current(db, passage)? {
            return Ok(0);
        }
    }
    db.execute(
        "DELETE FROM compartment_chunk_embeddings WHERE compartment_id=?1 AND model_id=?2",
        params![compartment_id, model_id],
    )?;
    let mut accepted = 0;
    for (passage, vector) in passages.iter().zip(vectors) {
        if !save_if_current(db, chunks, passage, model_id, vector, now_ms)? {
            return Err(rusqlite::Error::InvalidQuery);
        }
        accepted += 1;
    }
    Ok(accepted)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryCoverage {
    pub embedded: i64,
    pub total: i64,
}

/// Count only memories with `status='active'`, and the subset with this model's
/// vector. The host's `/ctx-embed` status excludes permanent and archived rows too.
pub fn memory_coverage(
    db: &Connection,
    project: &str,
    model_id: &str,
) -> rusqlite::Result<MemoryCoverage> {
    db.query_row(
        "SELECT count(*),coalesce(sum(CASE WHEN EXISTS
           (SELECT 1 FROM memory_embeddings e WHERE e.memory_id=m.id AND e.model_id=?1)
           THEN 1 ELSE 0 END),0) FROM memories m WHERE m.project_path=?2 AND m.status='active'",
        params![model_id, project],
        |row| {
            Ok(MemoryCoverage {
                total: row.get(0)?,
                embedded: row.get(1)?,
            })
        },
    )
}
