//! Code-owned dream inputs. Watermarks describe the claim snapshot, not the
//! state after a task has written its results.

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::path::Path;
use std::pin::Pin;

use mc_store::dream_scheduler::schedules::{ScheduleState, TaskName};
use mc_store::memory_levels::RunAuthority;
use mc_store::McStore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::memory_context::{ContextAnswer, MemoryContextReader};
use crate::memory_profile::{self, MemoryContext};

pub(crate) trait ProjectProfiles: Send + Sync {
    fn read<'a>(
        &'a self,
        folder: &'a str,
    ) -> Pin<Box<dyn Future<Output = MemoryContext> + Send + 'a>>;
}

impl ProjectProfiles for MemoryContextReader {
    fn read<'a>(
        &'a self,
        folder: &'a str,
    ) -> Pin<Box<dyn Future<Output = MemoryContext> + Send + 'a>> {
        Box::pin(memory_profile::project_profile(self, folder, &[]))
    }
}

pub(crate) fn unavailable_context() -> MemoryContext {
    // An unanswered context read uses the bundled software profile without
    // assigning a project id, so its creates cannot fabricate placement owners.
    memory_profile::resolve(
        &ContextAnswer::NotAnswering,
        &ContextAnswer::NotAnswering,
        &[],
    )
}

pub(crate) fn authority(pin: &MemoryContext) -> RunAuthority {
    RunAuthority::from_session_pin(&serde_json::to_value(pin).expect("context JSON"), "dream")
        .expect("resolved context includes category ids")
}

pub(crate) fn memory_kind(task: TaskName) -> bool {
    matches!(
        task,
        TaskName::Curate
            | TaskName::Classify
            | TaskName::CompressCues
            | TaskName::Map
            | TaskName::Verify
            | TaskName::VerifyBroad
    )
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Inputs {
    memory: String,
    /// At claim this is the unmapped backlog; completion replaces it with only
    /// the batches actually started, so an unstarted batch stays due.
    attempted: BTreeSet<i64>,
    files: BTreeMap<String, String>,
    candidates: BTreeSet<i64>,
    history: Option<i64>,
    git: String,
}

impl Inputs {
    pub(crate) fn watermark(&self) -> Value {
        serde_json::to_value(self).expect("inputs JSON")
    }

    pub(crate) fn map_attempts(watermark: &mut Value, ids: &BTreeSet<i64>) {
        watermark["attempted"] = serde_json::to_value(ids).expect("attempted ids JSON");
    }

    pub(crate) fn due(&self, task: TaskName, state: &ScheduleState) -> bool {
        let Some(prior) = state
            .inputs_watermark
            .as_ref()
            .and_then(|value| serde_json::from_value::<Self>(value.clone()).ok())
        else {
            return true;
        };
        match task {
            TaskName::Curate | TaskName::Classify | TaskName::CompressCues => {
                self.memory != prior.memory
            }
            TaskName::Map => {
                self.memory != prior.memory || !self.attempted.is_subset(&prior.attempted)
            }
            TaskName::Verify | TaskName::VerifyBroad => {
                self.memory != prior.memory
                    || self
                        .files
                        .iter()
                        .any(|(path, hash)| prior.files.get(path) != Some(hash))
            }
            TaskName::ReviewUserMemories => !self.candidates.is_subset(&prior.candidates),
            TaskName::Retrospective => self.history.is_some_and(|at| {
                at > state
                    .retrospective_watermark_ms
                    .or(prior.history)
                    .unwrap_or(0)
            }),
            TaskName::RefreshPrimers => {
                !self.candidates.is_subset(&prior.candidates) || self.files != prior.files
            }
            TaskName::MaintainDocs => self.git != prior.git,
            TaskName::PromotePrimers | TaskName::EvaluateSmartNotes => true,
        }
    }
}

pub(crate) fn capture(
    store: &McStore,
    project: &str,
    root: &Path,
    task: TaskName,
) -> Result<Inputs, String> {
    let mut inputs = Inputs::default();
    if memory_kind(task) {
        let (rows, unmapped, paths) = store.with_context_read(|db| {
            let rows = db.prepare("SELECT id,category,content,importance,scope,shareable,status,metadata_json FROM memories WHERE project_path=?1 ORDER BY id")?
                .query_map([project], |row| {
                    let status: String = row.get(6)?;
                    let metadata: Option<String> = row.get(7)?;
                    let expired = metadata.and_then(|text| serde_json::from_str::<Value>(&text).ok())
                        .is_some_and(|value| value["archive_reason"] == "expired");
                    let status = if status == "archived" && expired { "active" } else { &status };
                    Ok(serde_json::json!([row.get::<_,i64>(0)?,row.get::<_,String>(1)?,hash(row.get::<_,String>(2)?.as_bytes()),row.get::<_,Option<i64>>(3)?,row.get::<_,Option<String>>(4)?,row.get::<_,Option<i64>>(5)?,status]))
                })?.collect::<rusqlite::Result<Vec<_>>>()?;
            let unmapped = db.prepare("SELECT id FROM memories m WHERE project_path=?1 AND status='active' AND NOT EXISTS(SELECT 1 FROM memory_verifications v WHERE v.memory_id=m.id) ORDER BY id")?
                .query_map([project], |row| row.get(0))?.collect::<rusqlite::Result<BTreeSet<i64>>>()?;
            // Partition by memory, as the verifier does. Removing an expired
            // memory's paths is not a file change; only surviving paths compare.
            // Verification's own timestamps are deliberately not inputs.
            let paths = db.prepare("SELECT m.id,v.file_path FROM memory_verifications v JOIN memories m ON m.id=v.memory_id WHERE m.project_path=?1 AND m.status IN ('active','permanent') AND v.file_path!='' ORDER BY m.id,v.file_path")?
                .query_map([project], |row| Ok((row.get(0)?,row.get(1)?)))?.collect::<rusqlite::Result<Vec<(i64,String)>>>()?;
            Ok((rows,unmapped,paths))
        }).map_err(|error| error.to_string())?;
        inputs.memory = hash(&serde_json::to_vec(&rows).expect("memory rows JSON"));
        inputs.attempted = unmapped;
        if matches!(task, TaskName::Verify | TaskName::VerifyBroad) {
            inputs.files = file_inputs(root, paths);
        }
    }
    if task == TaskName::ReviewUserMemories {
        inputs.candidates = store
            .with_context_read(|db| {
                db.prepare("SELECT id FROM user_memory_candidates ORDER BY id")?
                    .query_map([], |row| row.get(0))?
                    .collect()
            })
            .map_err(|error| error.to_string())?;
    }
    Ok(inputs)
}

fn file_inputs(root: &Path, paths: Vec<(i64, String)>) -> BTreeMap<String, String> {
    paths
        .into_iter()
        .map(|(id, relative)| {
            // Mapping paths are project-relative. Never follow a symlink outside the
            // project when collecting a due input, even for a legacy mapping row.
            let bytes = root.canonicalize().ok().and_then(|root| {
                let path = root.join(&relative).canonicalize().ok()?;
                path.starts_with(&root)
                    .then(|| std::fs::read(path).ok())
                    .flatten()
            });
            let digest = bytes.map_or_else(|| "missing".into(), |bytes| hash(&bytes));
            (format!("{id}:{relative}"), digest)
        })
        .collect()
}

pub(crate) fn expire_on_curate(
    store: &McStore,
    context: &super::context::TaskContext,
) -> Result<(), String> {
    use super::adapters::EmbeddingQueue;
    use crate::memory_actions::{EmbeddingEffect, EmbeddingEffectKind, MemoryEmbeddingQueue};
    use mc_store::dream_verify::VerifyIdentity;
    let rows = store
        .load_dream_verify(&VerifyIdentity {
            project: &context.scope.project.0,
            invocation: &context.task_lease.invocation.0,
            session: &context.scope.session.0,
            harness: &context.config.harness,
        })
        .map_err(|error| error.to_string())?;
    let rows: Vec<_> = rows
        .into_iter()
        .filter(|row| {
            row.memory.status == "active"
                && row
                    .memory
                    .expires_at
                    .is_some_and(|at| at <= context.now_ms())
        })
        .collect();
    for batch in rows.chunks(100) {
        store
            .commit_dream_expiry(
                &context.scope.project.0,
                batch,
                context.now_ms(),
                |tx| {
                    context
                        .check_control()
                        .map_err(|_| rusqlite::Error::InvalidQuery)?;
                    mc_store::dream_domain::require_tx(tx, &context.domain_lease, context.now_ms())
                },
                |tx, memory| {
                    EmbeddingQueue.enqueue_tx(
                        tx,
                        &EmbeddingEffect {
                            project_path: memory.project_path.clone(),
                            session_id: context.scope.session.0.clone(),
                            memory_id: memory.id,
                            kind: EmbeddingEffectKind::Invalidate,
                            content: None,
                            content_hash: memory.normalized_hash.clone(),
                            queued_at: context.now_ms(),
                        },
                    )
                },
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "due_inputs_tests.rs"]
mod tests;
