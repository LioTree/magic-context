//! Memory text that one session has actually been served. A full baseline rebuild
//! (HARD) may read canonical rows; a delta refresh (SOFT) may not. This tuple and
//! the frozen prefix bytes share one store.db cache-generation compare-and-swap.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{FacadeMutationTxn, McStore, McStoreError, MemoryRenderSnapshot, StoredMemory};

pub const FRAGMENT_HARNESS: &str = "ck-mc";

pub fn text_line(kind: &str, id: i64, category: &str, text: &str) -> String {
    let attr = category
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let text = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let category = if category.is_empty() {
        String::new()
    } else {
        format!(" category=\"{attr}\"")
    };
    format!("  <{kind} id=\"{id}\"{category}>{text}</{kind}>")
}

impl FacadeMutationTxn<'_> {
    /// Read the canonical row after admission in this same write transaction.
    /// A normalized duplicate may retain different bytes than the save request.
    pub fn memory_for_fragment(&self, id: i64) -> Result<crate::StoredMemoryFull, String> {
        crate::load_memory_full_tx(self.tx, id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("memory {id} disappeared during its operation"))
    }
    /// Retain the prior text before an agent changes an existing row. Saving this
    /// history never requests a prefix rebuild or changes another session's cache.
    pub(crate) fn record_agent_history(
        &self,
        memory: &crate::StoredMemoryFull,
        after: &str,
        operation: &str,
        now_ms: i64,
    ) -> Result<(), crate::FacadeMemoryMutationError> {
        let revision: i64 = self
            .tx
            .query_row(
                "SELECT revision FROM memories WHERE id=?1",
                [memory.id],
                |row| row.get(0),
            )
            .map_err(crate::FacadeMemoryMutationError::storage)?;
        let key = crate::memory_lifecycle::applier::fresh_decision_key("agent-history", now_ms);
        self.tx.execute("INSERT INTO memory_history(memory_id,revision,previous_text,after_text,applied_at,reason,evidence_json,source_ids_json,decision_key) VALUES(?1,?2,?3,?4,?5,?6,'[]','[]',?7)",params![memory.id,revision,memory.content,after,now_ms,operation,key]).map_err(crate::FacadeMemoryMutationError::storage)?;
        self.tx
            .execute(
                "UPDATE memories SET revision=revision+1 WHERE id=?1",
                [memory.id],
            )
            .map_err(crate::FacadeMemoryMutationError::storage)?;
        Ok(())
    }
    /// Store the pre-rendered lines for an agent operation with its canonical write.
    /// Retrying the same command key keeps those first lines, even after later edits.
    #[allow(clippy::too_many_arguments)]
    pub fn record_agent_fragment(
        &self,
        session: &str,
        project: &str,
        key: &str,
        ids: &[i64],
        current_id: Option<i64>,
        lines: &[String],
        visible_texts: &[VisibleText],
        now_ms: i64,
    ) -> Result<(), String> {
        if lines.is_empty() {
            return Ok(());
        }
        self.tx.execute("INSERT OR IGNORE INTO memory_agent_fragments(session_id,harness,project_path,operation_key,memory_ids_json,current_id,lines,visible_texts_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![session,FRAGMENT_HARNESS,project,key,serde_json::to_string(ids).map_err(|e| e.to_string())?,current_id,lines.join("\n"),serde_json::to_string(visible_texts).map_err(|e| e.to_string())?,now_ms]).map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShownMemory {
    pub memory: StoredMemory,
    pub revision: i64,
    /// Image-only cues are abbreviations, not a complete text-search result.
    pub representation: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibleText {
    pub id: i64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommittedFragment {
    pub id: i64,
    pub form: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub overflow_ids: Vec<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overflow_count: Option<usize>,
    pub lines: Vec<String>,
    pub visible_texts: Vec<VisibleText>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppliedProjection {
    pub generation: u64,
    pub m0_sha256: String,
    pub hard_memory_block: String,
    pub fragment_watermark: i64,
    pub committed: Vec<CommittedFragment>,
    pub rows: Vec<ShownMemory>,
    pub user_profile: Vec<String>,
    pub legacy: bool,
}

impl AppliedProjection {
    pub fn hard(
        snapshot: &MemoryRenderSnapshot,
        selected: &[StoredMemory],
        profile: &[String],
    ) -> Self {
        Self {
            fragment_watermark: snapshot.fragment_watermark,
            rows: selected
                .iter()
                .map(|memory| ShownMemory {
                    memory: memory.clone(),
                    revision: snapshot.revisions.get(&memory.id).copied().unwrap_or(1),
                    representation: "text".into(),
                })
                .collect(),
            user_profile: profile.to_vec(),
            ..Self::default()
        }
    }

    pub fn bind_m0(&mut self, text: &str) {
        self.m0_sha256 = format!("{:x}", Sha256::digest(text.as_bytes()));
    }

    pub fn matches_m0(&self, text: &str) -> bool {
        self.m0_sha256 == format!("{:x}", Sha256::digest(text.as_bytes()))
    }

    pub fn shows_text(&self, id: i64, text: &str) -> bool {
        self.rows.iter().any(|row| {
            row.memory.id == id && row.representation == "text" && row.memory.content == text
        }) || self
            .committed
            .iter()
            .filter(|fragment| fragment.form == "full")
            .flat_map(|fragment| &fragment.visible_texts)
            .any(|shown| shown.id == id && shown.text == text)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFragment {
    pub id: i64,
    pub operation_key: String,
    pub memory_ids: Vec<i64>,
    pub current_id: Option<i64>,
    pub lines: Vec<String>,
    pub visible_texts: Vec<VisibleText>,
}

impl McStore {
    /// Read immutable session-operation fragments. Do not load canonical memory
    /// rows, the mutation log, or either table's maximum ID here.
    pub fn load_agent_fragments(
        &self,
        session_id: &str,
        after: i64,
    ) -> Result<Vec<AgentFragment>, McStoreError> {
        self.context_read(|conn| {
            let mut statement = conn.prepare("SELECT id,operation_key,memory_ids_json,current_id,lines,visible_texts_json FROM memory_agent_fragments WHERE session_id=?1 AND id>?2 AND harness='ck-mc' ORDER BY id")?;
            let rows = statement.query_map(params![session_id,after], |row| {
                let parse = |json: String| serde_json::from_str(&json).map_err(|error| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error)));
                Ok(AgentFragment {
                    id: row.get(0)?, operation_key: row.get(1)?,
                    memory_ids: parse(row.get(2)?)?, current_id: row.get(3)?,
                    lines: row.get::<_, String>(4)?.split('\n').map(str::to_string).collect(),
                    visible_texts: serde_json::from_str(&row.get::<_, String>(5)?).map_err(|error| rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(error)))?,
                })
            })?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// Hide a search hit only when its current full prose was already shown.
    /// Without a trustworthy list of shown texts, return no exclusions: an edited
    /// claim must remain retrievable even when its old text is in the prompt.
    pub fn fully_visible_memory_ids(&self, session_id: &str) -> Result<Vec<i64>, McStoreError> {
        let loaded = self.load(session_id)?;
        let Some(projection) = loaded.meta.memory_projection else {
            return Ok(Vec::new());
        };
        let Some(m0) = loaded
            .core
            .frozen_units
            .iter()
            .find(|unit| unit.key == "m0")
        else {
            return Ok(Vec::new());
        };
        if projection.legacy || !projection.matches_m0(&m0.frozen_payload) {
            return Ok(Vec::new());
        }
        self.visible_ids_for_projection(&projection)
    }

    /// A hint needs only the manifest in the small cache row. Avoid decoding the
    /// entire frozen prefix a second time while deciding one new tail hint.
    pub fn fully_visible_memory_ids_for_hint(
        &self,
        session_id: &str,
    ) -> Result<Vec<i64>, McStoreError> {
        let loaded = self.load_meta(session_id)?;
        let Some(projection) = loaded.meta.memory_projection else {
            return Ok(Vec::new());
        };
        if projection.legacy || projection.m0_sha256.is_empty() {
            return Ok(Vec::new());
        }
        self.visible_ids_for_projection(&projection)
    }

    fn visible_ids_for_projection(
        &self,
        projection: &AppliedProjection,
    ) -> Result<Vec<i64>, McStoreError> {
        let mut ids = projection
            .rows
            .iter()
            .map(|row| row.memory.id)
            .chain(
                projection
                    .committed
                    .iter()
                    .flat_map(|fragment| fragment.visible_texts.iter().map(|shown| shown.id)),
            )
            .collect::<Vec<_>>();
        ids.sort_unstable();
        ids.dedup();
        self.context_read(|conn| {
            let mut visible = Vec::new();
            for id in &ids {
                let text = conn.query_row("SELECT content FROM memories WHERE id=?1 AND status IN ('active','permanent') AND superseded_by_memory_id IS NULL", [id], |row| row.get::<_, String>(0)).optional()?;
                if text.as_deref().is_some_and(|text| projection.shows_text(*id,text)) { visible.push(*id); }
            }
            Ok(visible)
        })
    }
}
