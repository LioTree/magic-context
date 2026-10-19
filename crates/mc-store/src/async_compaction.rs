//! Async cursors and view versions are independent of the compatibility record.
//! A legacy record save must never reset a notice-driven reader's progress.
use crate::{McStore, McStoreError, McTagRow};
use rusqlite::{params, OptionalExtension};

impl McStore {
    pub fn clear_async_compaction_drops(&self, namespace: &str) -> Result<usize, McStoreError> {
        self.inner
            .with_conn_fenced(|conn| {
                conn.execute(
                    "DELETE FROM pending_agent_drops WHERE session_id=?1",
                    [namespace],
                )
            })
            .map_err(Into::into)
    }
    /// Copy source-validated history artifacts without invoking an embedding model.
    /// The caller retains its resync intent until this idempotent copy completes.
    pub fn copy_async_history_artifacts(
        &self,
        source: &str,
        target: &str,
        sequences: &[(i64, i64)],
    ) -> Result<usize, McStoreError> {
        self.resume_pending_context_write(source)?;
        self.resume_pending_context_write(target)?;
        let (copied,mapped)=self.context_write(&["compartments","compartment_chunk_embeddings"],|conn| {
            let mut copied=0;
            let mut mapped=Vec::new();
            for (old_sequence,new_sequence) in sequences {
                let ids:Option<(i64,i64,i64)>=conn.query_row("SELECT old.id,new.id,new.start_message-old.start_message FROM compartments old JOIN compartments new
                    ON new.session_id=?2 AND new.sequence=?4 WHERE old.session_id=?1 AND old.sequence=?3
                    AND old.content=new.content AND old.p1 IS new.p1 AND old.p2 IS new.p2 AND old.p3 IS new.p3 AND old.p4 IS new.p4",
                    params![source,target,old_sequence,new_sequence],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional()?;
                let Some((old_id,new_id,shift))=ids else {continue;};
                mapped.push((*old_sequence,*new_sequence,shift));
                conn.execute("UPDATE compartments SET p1_embedding=(SELECT p1_embedding FROM compartments WHERE id=?1),p1_embedding_model_id=(SELECT p1_embedding_model_id FROM compartments WHERE id=?1) WHERE id=?2",params![old_id,new_id])?;
                copied+=conn.execute("INSERT INTO compartment_chunk_embeddings(compartment_id,session_id,project_path,harness,window_index,start_ordinal,end_ordinal,chunk_hash,model_id,dims,vector,created_at)
                    SELECT ?2,?3,project_path,harness,window_index,start_ordinal+?4,end_ordinal+?4,chunk_hash,model_id,dims,vector,created_at FROM compartment_chunk_embeddings WHERE compartment_id=?1
                    ON CONFLICT(compartment_id,model_id,window_index) DO UPDATE SET session_id=excluded.session_id,project_path=excluded.project_path,harness=excluded.harness,start_ordinal=excluded.start_ordinal,end_ordinal=excluded.end_ordinal,chunk_hash=excluded.chunk_hash,dims=excluded.dims,vector=excluded.vector,created_at=excluded.created_at",
                    params![old_id,new_id,target,shift])?;
            }
            Ok((copied,mapped))
        })?;
        self.inner.with_conn_fenced(|conn| {
            for (old_sequence,new_sequence,shift) in mapped {
                conn.execute("INSERT INTO mc_chunk_transcripts(session_id,compartment_seq,start_ordinal,end_ordinal,transcript_deflate,created_at_ms) SELECT ?2,?4,start_ordinal+?5,end_ordinal+?5,transcript_deflate,created_at_ms FROM mc_chunk_transcripts WHERE session_id=?1 AND compartment_seq=?3
                    ON CONFLICT(session_id,compartment_seq) DO UPDATE SET start_ordinal=excluded.start_ordinal,end_ordinal=excluded.end_ordinal,transcript_deflate=excluded.transcript_deflate,created_at_ms=excluded.created_at_ms",params![source,target,old_sequence,new_sequence,shift])?;
            }
            Ok(())
        })?;
        Ok(copied)
    }
    pub fn retire_unannounced_async_views(&self, session_ref: &str) -> Result<(), McStoreError> {
        self.inner.with_conn_fenced(|conn|conn.execute("UPDATE mc_async_compaction_views SET announced=-1 WHERE session_ref=?1 AND announced=0",[session_ref]).map(|_|())).map_err(Into::into)
    }
    pub fn async_compaction_for_session(
        &self,
        project: &str,
        session: &str,
    ) -> Result<Vec<String>, McStoreError> {
        self.inner.with_conn(|conn| {
            let mut query=conn.prepare("SELECT state_json FROM mc_async_compaction WHERE session=?2 AND json_extract(conversation_key,'$[0]')=?1")?;
            let rows=query.query_map(params![project,session],|row|row.get(0))?;
            rows.collect()
        }).map_err(Into::into)
    }
    pub fn load_async_compaction(&self, session_ref: &str) -> Result<Option<String>, McStoreError> {
        self.inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT state_json FROM mc_async_compaction WHERE session_ref=?1",
                    [session_ref],
                    |row| row.get(0),
                )
                .optional()
            })
            .map_err(Into::into)
    }

    pub fn async_compaction_for_key(&self, key: &str) -> Result<bool, McStoreError> {
        self.inner
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM mc_async_compaction WHERE conversation_key=?1)",
                    [key],
                    |row| row.get(0),
                )
            })
            .map_err(Into::into)
    }

    pub fn save_async_compaction(
        &self,
        session_ref: &str,
        key: &str,
        session: &str,
        state: &str,
        namespace: &str,
        tags: &[McTagRow],
    ) -> Result<(), McStoreError> {
        self.inner.with_conn_fenced(|conn| {
            conn.execute("INSERT INTO mc_async_compaction(session_ref,conversation_key,session,state_json) VALUES(?1,?2,?3,?4)
                ON CONFLICT(session_ref) DO UPDATE SET state_json=excluded.state_json",
                params![session_ref,key,session,state])?;
            crate::provider_log::insert_tags_tx(conn, namespace, tags)
        }).map_err(Into::into)
    }

    /// Reserve before building a view. A crash skips the reservation, never reuses it.
    pub fn reserve_async_compaction_version(
        &self,
        session_ref: &str,
        applied: u64,
    ) -> Result<u64, McStoreError> {
        self.inner
            .with_conn_fenced(|conn| {
                conn.query_row(
                    "UPDATE mc_async_compaction SET version_high_water=max(version_high_water,?2)+1
                WHERE session_ref=?1 RETURNING version_high_water",
                    params![session_ref, applied],
                    |row| row.get(0),
                )
            })
            .map_err(Into::into)
    }

    pub fn save_async_compaction_view(
        &self,
        session_ref: &str,
        version: u64,
        view: &str,
    ) -> Result<(), McStoreError> {
        self.inner
            .with_conn_fenced(|conn| {
                conn.execute(
            "INSERT INTO mc_async_compaction_views(session_ref,session,version,view_json) SELECT ?1,session,?2,?3 FROM mc_async_compaction WHERE session_ref=?1",
            params![session_ref,version,view],
        ).map(|_| ())
            })
            .map_err(Into::into)
    }

    pub fn load_async_compaction_view(
        &self,
        session_ref: &str,
        version: u64,
    ) -> Result<Option<String>, McStoreError> {
        self.inner
            .with_conn(|conn| {
                conn.query_row(
            "SELECT view_json FROM mc_async_compaction_views WHERE session_ref=?1 AND version=?2",
            params![session_ref,version], |row| row.get(0),
        ).optional()
            })
            .map_err(Into::into)
    }

    pub fn pending_async_compaction_views(
        &self,
    ) -> Result<Vec<(String, u64, String)>, McStoreError> {
        self.inner.with_conn(|conn| {
            let mut query = conn.prepare("SELECT session_ref,version,view_json FROM mc_async_compaction_views WHERE announced=0 ORDER BY session_ref,version")?;
            let rows = query.query_map([], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
            rows.collect()
        }).map_err(Into::into)
    }

    pub fn mark_async_compaction_announced(
        &self,
        session_ref: &str,
        version: u64,
    ) -> Result<(), McStoreError> {
        self.inner
            .with_conn_fenced(|conn| {
                conn.execute(
            "UPDATE mc_async_compaction_views SET announced=1 WHERE session_ref=?1 AND version=?2",
            params![session_ref,version],
        ).map(|_| ())
            })
            .map_err(Into::into)
    }
}
