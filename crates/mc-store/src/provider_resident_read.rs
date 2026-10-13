//! Read-only provider inputs for in-memory policy rebuilding and offline fixtures.
//! Capturing these inputs never publishes a resident checkpoint or a new baseline.
use crate::provider_log::{
    conversation_tx, ProviderConversation, ProviderError, ProviderMessage, ProviderPolicyIndex,
    ProviderPolicyPart,
};
use crate::{McStore, ProviderSessionKey};
use rusqlite::params;
use serde_json::Value;
use std::collections::BTreeMap;

pub struct ProviderResidentAuthority {
    pub conversation_key: String,
    pub store_instance: u64,
    pub conversation: ProviderConversation,
    pub policy_revision: u64,
    pub ancestry: Vec<(String, u64)>,
    pub parts: Vec<ProviderPolicyPart>,
    pub tail: Vec<ProviderMessage>,
    pub coverage: Option<u64>,
    pub tail_blob_rows: usize,
    pub tail_blob_bytes: usize,
}

impl McStore {
    /// Read the authoritative policy rows and their counters at one database cut.
    /// This read does not save a resident checkpoint or advance a policy baseline.
    pub fn read_provider_resident_policy<T>(
        &self,
        key: &ProviderSessionKey,
        read: impl FnOnce(&ProviderPolicyIndex<'_>, &Value) -> Result<T, ProviderError>,
    ) -> Result<T, ProviderError> {
        let mut refusal = None;
        self.inner.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let conversation = conversation_tx(&tx, key)?.ok_or(rusqlite::Error::InvalidQuery)?;
            let result = (|| {
                let (rows, bytes): (u64, u64) = tx.query_row(
                    "SELECT COUNT(*),COALESCE(SUM(length(CAST(policy_json AS BLOB))),0) FROM mc_provider_policy_parts_v1 WHERE conv_key=?1",
                    [key.conversation_key()], |r| Ok((r.get(0)?, r.get(1)?)))?;
                if rows > 100_000 || bytes > 128 * 1024 * 1024 {
                    return Err(ProviderError::Transient("resident_not_ready: policy input exceeds rebuild cap".into()));
                }
                let counters = serde_json::from_str(&conversation.hook_counters_json).map_err(|e| ProviderError::Transient(e.to_string()))?;
                let index = ProviderPolicyIndex::new(&tx, &key.conversation_key(), &conversation.lineage_id)?;
                read(&index, &counters)
            })().map_err(|e| { refusal = Some(e); rusqlite::Error::InvalidQuery })?;
            tx.commit()?;
            Ok(result)
        }).map_err(|e| refusal.unwrap_or_else(|| ProviderError::Storage(e.into())))
    }

    /// Capture current provider authority in one read transaction. The policy
    /// index is a cold-build input; native BLOB reads are restricted to the
    /// unsummarized tail before they are decoded or copied.
    pub fn read_provider_resident_authority(
        &self,
        key: &ProviderSessionKey,
        max_parts: usize,
        max_tail: usize,
        max_bytes: usize,
    ) -> Result<ProviderResidentAuthority, ProviderError> {
        let mut refusal = None;
        let result = self.inner.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            let read = || -> Result<ProviderResidentAuthority, ProviderError> {
                let conversation = conversation_tx(&tx, key)?.ok_or_else(|| ProviderError::Transient("resident input conversation is missing".into()))?;
                let revision = crate::provider_preparation::policy_revision_tx(&tx, &conversation.engine_namespace)?;
                let counters: Value = serde_json::from_str(&conversation.hook_counters_json).map_err(|e| ProviderError::Transient(e.to_string()))?;
                let coverage = counters.pointer("/engine_policy/coverage").and_then(Value::as_u64);
                let conv = key.conversation_key();
                // Count before allocating. Counting shadowed rows is deliberately
                // conservative; an oversize experiment must not truncate policy.
                let (rows, bytes): (u64, u64) = tx.query_row("SELECT COUNT(*),COALESCE(SUM(length(CAST(policy_json AS BLOB))),0) FROM mc_provider_policy_parts_v1 WHERE conv_key=?1", [&conv], |r| Ok((r.get(0)?, r.get(1)?)))?;
                if rows > max_parts as u64 || bytes > max_bytes as u64 {
                    return Err(ProviderError::Transient("resident policy input exceeds cap".into()));
                }
                let index = ProviderPolicyIndex::new(&tx, &conv, &conversation.lineage_id)?;
                if index.ancestry().len() > 64 { return Err(ProviderError::Transient("resident ancestry exceeds cap".into())); }
                let parts = index.all_parts()?;
                let ancestry = index.ancestry().to_vec();
                let mut tail = BTreeMap::new();
                let mut tail_blob_rows = 0;
                let mut tail_blob_bytes = 0usize;
                for (lineage, cut) in &ancestry {
                    if coverage.is_some_and(|n| n >= i64::MAX as u64) { continue; }
                    let mut q = tx.prepare("SELECT ordinal,mid,CASE WHEN length(message_bytes)<=?6 THEN message_bytes ELSE NULL END FROM mc_provider_messages_v1 WHERE conv_key=?1 AND lineage_id=?2 AND ordinal>=?3 AND ordinal<=?4 ORDER BY ordinal LIMIT ?5")?;
                    let first = coverage.map_or(0, |n| n.saturating_add(1));
                    let messages = q.query_map(params![conv, lineage, first.min(i64::MAX as u64), (*cut).min(i64::MAX as u64), max_tail.saturating_add(1).min(i64::MAX as usize) as i64, max_bytes.min(i64::MAX as usize) as i64], |r| Ok(ProviderMessage { ordinal: r.get(0)?, mid: r.get(1)?, message_bytes: r.get::<_, Option<Vec<u8>>>(2)?.ok_or(rusqlite::Error::InvalidQuery)? }))?;
                    for message in messages {
                        let message = message?;
                        tail_blob_rows += 1;
                        tail_blob_bytes = tail_blob_bytes.checked_add(message.message_bytes.len()).ok_or_else(|| ProviderError::Transient("resident tail byte count overflow".into()))?;
                        if tail_blob_bytes.checked_add(bytes as usize).is_none_or(|size| size > max_bytes) { return Err(ProviderError::Transient("resident tail input exceeds byte cap".into())); }
                        if tail.insert(message.ordinal, message).is_some() { return Err(ProviderError::Transient("resident ancestry has overlapping native ordinals".into())); }
                        if tail.len() > max_tail { return Err(ProviderError::Transient("resident native tail exceeds cap".into())); }
                    }
                }
                Ok(ProviderResidentAuthority { conversation_key: conv, store_instance: self.tag_cache_namespace(), conversation, policy_revision: revision, ancestry, parts, tail: tail.into_values().collect(), coverage, tail_blob_rows, tail_blob_bytes })
            };
            let captured = read().map_err(|e| { refusal = Some(e); rusqlite::Error::InvalidQuery })?;
            tx.commit()?;
            Ok(captured)
        });
        result.map_err(|e| refusal.unwrap_or_else(|| ProviderError::Storage(e.into())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider_records::{ProviderLineage, ProviderStatusPage};
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    fn rig(coverage: Option<u64>) -> (tempfile::TempDir, McStore, ProviderSessionKey) {
        let root = std::env::temp_dir().join("magic-context/provider-resident-authority");
        std::fs::create_dir_all(&root).unwrap();
        let dir = tempfile::tempdir_in(root).unwrap();
        let store = McStore::open_for_test(&StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "mc_cache".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into(),
            },
        })
        .unwrap();
        let key = ProviderSessionKey {
            project_root: "/resident-fixture".into(),
            session: "s".into(),
            harness: "opencode".into(),
            generation: None,
        };
        store
            .save_provider_conversation(
                &key,
                &ProviderConversation {
                    lineage_id: "L".into(),
                    engine_namespace: "engine".into(),
                    hook_counters_json: serde_json::json!({"engine_policy":{"coverage":coverage}})
                        .to_string(),
                    ..Default::default()
                },
            )
            .unwrap();
        (dir, store, key)
    }
    fn ingest(store: &McStore, key: &ProviderSessionKey, count: u64) {
        let lineage = ProviderLineage {
            lineage_id: "L".into(),
            first_ordinal: 1,
            descends_from: None,
            through_ordinal: None,
        };
        let messages = (1..=count).map(|ordinal| ProviderMessage { ordinal, mid: format!("m{ordinal}"),
            message_bytes: serde_json::to_vec(&serde_json::json!({"info":{"id":format!("m{ordinal}"),"role":"assistant"},"parts":[{"type":"text","text":"raw tail"}]})).unwrap() }).collect::<Vec<_>>();
        store
            .commit_provider_status_page(
                key,
                ProviderStatusPage {
                    lineage: &lineage,
                    messages: &messages,
                    served: Some(count),
                    unserved: &[],
                    newest: Some(count),
                    more: false,
                },
            )
            .unwrap();
    }
    #[test]
    fn resident_authority_covered_history_is_not_materialized() {
        let (_dir, store, key) = rig(Some(16_500));
        ingest(&store, &key, 17_000);
        let read = store
            .read_provider_resident_authority(&key, 100_000, 500, 128 * 1024 * 1024)
            .unwrap();
        assert_eq!(read.tail_blob_rows, 500);
        assert_eq!(read.tail.first().unwrap().ordinal, 16_501);
        assert_eq!(read.tail.last().unwrap().ordinal, 17_000);
        let full = store.load_provider_messages(&key, "L").unwrap();
        assert_eq!(
            read.tail,
            full[16_500..],
            "independent existing lineage reader tail"
        );
    }
    #[test]
    fn resident_authority_read_transaction_has_no_writes() {
        let (_dir, store, key) = rig(None);
        ingest(&store, &key, 3);
        let changes = || {
            store
                .inner
                .with_conn(|conn| Ok(conn.total_changes()))
                .unwrap()
        };
        let before = changes();
        let revision = store.provider_policy_revision("engine").unwrap();
        let conversation = store.load_provider_conversation(&key).unwrap().unwrap();
        let read = store
            .read_provider_resident_authority(&key, 100, 10, 1024 * 1024)
            .unwrap();
        assert_eq!(
            serde_json::to_value(read.conversation).unwrap(),
            serde_json::to_value(conversation).unwrap()
        );
        assert_eq!(changes(), before);
        assert_eq!(store.provider_policy_revision("engine").unwrap(), revision);
        assert_eq!(read.tail, store.load_provider_messages(&key, "L").unwrap());
    }
    #[test]
    fn resident_authority_native_limits_refuse_instead_of_truncating() {
        let (_dir, store, key) = rig(None);
        ingest(&store, &key, 3);
        assert!(store
            .read_provider_resident_authority(&key, 100, 2, 1024 * 1024)
            .is_err());
        assert!(store
            .read_provider_resident_authority(&key, 100, 10, 16)
            .is_err());
        assert_eq!(store.load_provider_messages(&key, "L").unwrap().len(), 3);
    }
}
