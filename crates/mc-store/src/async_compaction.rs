//! Async cursors and view versions are independent of the compatibility record.
//! A legacy record save must never reset a notice-driven reader's progress.
use crate::{McStore, McStoreError, McTagRow};
use rusqlite::{params, OptionalExtension};

/// Write accounting for one async conversation, compiled only for sibling-crate
/// tests. It lets a test prove that a notice's write set does not grow with the
/// held transcript, and lets a benchmark report write-transaction time.
#[cfg(feature = "test-support")]
pub mod write_meter {
    use std::collections::BTreeMap;
    use std::sync::Mutex;
    use std::time::Instant;

    /// Totals since the meter was armed for a conversation. `bytes` counts the
    /// text/blob cells written; `rows` counts rows inserted, updated or deleted;
    /// `nanos` is the wall time of the fenced write calls, including waiting
    /// for the writer connection and the write lock; `held_nanos` is the time
    /// the write lock was held, from the first statement through COMMIT.
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct AsyncWriteStats {
        pub transactions: u64,
        pub rows: u64,
        pub bytes: u64,
        pub nanos: u64,
        pub held_nanos: u64,
    }

    static METERS: Mutex<BTreeMap<String, AsyncWriteStats>> = Mutex::new(BTreeMap::new());

    /// Start (or restart) counting writes for `session_ref`.
    pub fn arm(session_ref: &str) {
        METERS
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(session_ref.into(), AsyncWriteStats::default());
    }

    /// The totals for an armed conversation; `None` when it is not armed.
    pub fn read(session_ref: &str) -> Option<AsyncWriteStats> {
        METERS
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(session_ref)
            .copied()
    }

    pub(crate) fn record(
        session_ref: &str,
        started: Instant,
        held: Instant,
        rows: u64,
        bytes: u64,
    ) {
        let mut meters = METERS.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(stats) = meters.get_mut(session_ref) {
            stats.transactions += 1;
            stats.rows += rows;
            stats.bytes += bytes;
            stats.nanos += started.elapsed().as_nanos() as u64;
            stats.held_nanos += held.elapsed().as_nanos() as u64;
        }
    }
}

/// Wrap a fenced-write callback so it also reports when it started, that is,
/// once the IMMEDIATE transaction holds the write lock.
fn held<T>(
    write: impl FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<(T, u64, u64)>,
) -> impl FnOnce(&rusqlite::Transaction<'_>) -> rusqlite::Result<(T, u64, u64, std::time::Instant)>
{
    move |conn| {
        let started = std::time::Instant::now();
        write(conn).map(|(value, rows, bytes)| (value, rows, bytes, started))
    }
}

/// Records one fenced write for the test meter; compiles to nothing otherwise.
macro_rules! metered {
    ($session_ref:expr, $write:expr) => {{
        #[cfg(feature = "test-support")]
        let started = std::time::Instant::now();
        let result = $write;
        #[cfg(feature = "test-support")]
        if let Ok((_, rows, bytes, held)) = &result {
            write_meter::record($session_ref, started, *held, *rows, *bytes);
        }
        result.map(|(value, ..)| value)
    }};
}

impl McStore {
    /// Start counting this conversation's async-table writes (test builds only).
    #[cfg(feature = "test-support")]
    pub fn arm_async_write_meter(&self, session_ref: &str) {
        write_meter::arm(session_ref);
    }
    /// Writes counted since [`Self::arm_async_write_meter`] (test builds only).
    #[cfg(feature = "test-support")]
    pub fn async_write_stats(&self, session_ref: &str) -> Option<write_meter::AsyncWriteStats> {
        write_meter::read(session_ref)
    }
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
        metered!(session_ref, self.inner.with_conn_fenced(held(|conn|conn.execute("UPDATE mc_async_compaction_views SET announced=-1 WHERE session_ref=?1 AND announced=0",[session_ref]).map(|rows|((),rows as u64,0)))).map_err(McStoreError::from))
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

    /// Begin one atomic save of an async conversation: the small record plus
    /// only the row changes the caller adds. Nothing is written until
    /// [`AsyncCompactionSave::commit`].
    pub fn async_compaction_save<'a>(
        &'a self,
        session_ref: &'a str,
        key: &'a str,
        session: &'a str,
        state: &'a str,
    ) -> AsyncCompactionSave<'a> {
        AsyncCompactionSave {
            store: self,
            session_ref,
            key,
            session,
            state,
            namespace: "",
            tags: &[],
            truncate_entries: None,
            entries: Vec::new(),
            baselines: Vec::new(),
            clear_engine_views: false,
            retain_views_from: None,
        }
    }

    /// Everything needed to rebuild a held conversation, read in one snapshot
    /// from a reader connection so a long transcript never holds the writer.
    pub fn load_async_compaction_rows(
        &self,
        session_ref: &str,
    ) -> Result<Option<AsyncCompactionRows>, McStoreError> {
        self.inner
            .with_read(|conn| {
                let Some(state) = conn
                    .query_row(
                        "SELECT state_json FROM mc_async_compaction WHERE session_ref=?1",
                        [session_ref],
                        |row| row.get(0),
                    )
                    .optional()?
                else {
                    return Ok(None);
                };
                let entries = conn
                    .prepare("SELECT ordinal,entry_json,index_json FROM mc_async_compaction_entries WHERE session_ref=?1 ORDER BY ordinal")?
                    .query_map([session_ref], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                    .collect::<rusqlite::Result<_>>()?;
                let engine_views = conn
                    .prepare("SELECT version,engine_json FROM mc_async_compaction_views WHERE session_ref=?1 AND engine_json IS NOT NULL ORDER BY version")?
                    .query_map([session_ref], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<rusqlite::Result<_>>()?;
                let baselines = conn
                    .prepare("SELECT slot,view_json FROM mc_async_compaction_baselines WHERE session_ref=?1")?
                    .query_map([session_ref], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<rusqlite::Result<_>>()?;
                Ok(Some(AsyncCompactionRows {
                    state,
                    entries,
                    engine_views,
                    baselines,
                }))
            })
            .map_err(Into::into)
    }

    /// Reserve before building a view. A crash skips the reservation, never reuses it.
    pub fn reserve_async_compaction_version(
        &self,
        session_ref: &str,
        applied: u64,
    ) -> Result<u64, McStoreError> {
        metered!(
            session_ref,
            self.inner
                .with_conn_fenced(held(|conn| {
                    conn.query_row(
                        "UPDATE mc_async_compaction SET version_high_water=max(version_high_water,?2)+1
                WHERE session_ref=?1 RETURNING version_high_water",
                        params![session_ref, applied],
                        |row| row.get(0),
                    )
                    .map(|version| (version, 1, 0))
                }))
                .map_err(McStoreError::from)
        )
    }

    pub fn save_async_compaction_view(
        &self,
        session_ref: &str,
        version: u64,
        view: &str,
        engine: &str,
    ) -> Result<(), McStoreError> {
        metered!(
            session_ref,
            self.inner
                .with_conn_fenced(held(|conn| {
                    conn.execute(
            "INSERT INTO mc_async_compaction_views(session_ref,session,version,view_json,engine_json) SELECT ?1,session,?2,?3,?4 FROM mc_async_compaction WHERE session_ref=?1",
            params![session_ref,version,view,engine],
        ).map(|rows| ((), rows as u64, (view.len() + engine.len()) as u64))
                }))
                .map_err(McStoreError::from)
        )
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
        metered!(
            session_ref,
            self.inner
                .with_conn_fenced(held(|conn| {
                    conn.execute(
            "UPDATE mc_async_compaction_views SET announced=1 WHERE session_ref=?1 AND version=?2",
            params![session_ref,version],
        ).map(|rows| ((), rows as u64, 0))
                }))
                .map_err(McStoreError::from)
        )
    }
}

/// The stored rows of one async conversation, as read by
/// [`McStore::load_async_compaction_rows`].
pub struct AsyncCompactionRows {
    pub state: String,
    /// `(ordinal, entry_json, index_json)` in ordinal order.
    pub entries: Vec<(u64, String, String)>,
    /// `(version, engine_json)` for published views still usable as an
    /// engine baseline, in version order.
    pub engine_views: Vec<(u64, String)>,
    /// `(slot, view_json)` for baselines stored outside the published views.
    pub baselines: Vec<(String, String)>,
}

/// One pending atomic save; see [`McStore::async_compaction_save`].
pub struct AsyncCompactionSave<'a> {
    store: &'a McStore,
    session_ref: &'a str,
    key: &'a str,
    session: &'a str,
    state: &'a str,
    namespace: &'a str,
    tags: &'a [McTagRow],
    truncate_entries: Option<Option<u64>>,
    entries: Vec<(u64, String, String)>,
    baselines: Vec<(&'static str, Option<String>)>,
    clear_engine_views: bool,
    retain_views_from: Option<u64>,
}

impl<'a> AsyncCompactionSave<'a> {
    /// Runner tag rows to import into the engine namespace's tag table.
    pub fn tags(&mut self, namespace: &'a str, tags: &'a [McTagRow]) -> &mut Self {
        self.namespace = namespace;
        self.tags = tags;
        self
    }

    /// Delete held entries after `through` (all entries for `None`) before
    /// appending. Several calls keep the earliest cut.
    pub fn truncate_entries(&mut self, through: Option<u64>) -> &mut Self {
        self.truncate_entries = Some(match (self.truncate_entries, through) {
            (Some(None), _) | (_, None) => None,
            (Some(Some(held)), Some(through)) => Some(held.min(through)),
            (None, Some(through)) => Some(through),
        });
        self
    }

    /// Append one new held entry. An ordinal that is already stored is an
    /// error, never an overwrite: held entries are immutable.
    pub fn append_entry(
        &mut self,
        ordinal: u64,
        entry_json: String,
        index_json: String,
    ) -> &mut Self {
        self.entries.push((ordinal, entry_json, index_json));
        self
    }

    /// Store (`Some`) or remove (`None`) the baseline kept in `slot`.
    pub fn baseline(&mut self, slot: &'static str, view_json: Option<String>) -> &mut Self {
        self.baselines.push((slot, view_json));
        self
    }

    /// Forget every published view's engine form; their immutable runner
    /// views stay retrievable.
    pub fn clear_engine_views(&mut self) -> &mut Self {
        self.clear_engine_views = true;
        self
    }

    /// Record that versions below `floor` are no longer needed and delete
    /// them, except the newest version, in this same transaction.
    pub fn retain_views_from(&mut self, floor: u64) -> &mut Self {
        self.retain_views_from = Some(floor);
        self
    }

    pub fn commit(&self) -> Result<(), McStoreError> {
        let Self {
            store,
            session_ref,
            key,
            session,
            state,
            namespace,
            tags,
            truncate_entries,
            ref entries,
            ref baselines,
            clear_engine_views,
            retain_views_from,
        } = *self;
        metered!(session_ref, store.inner.with_conn_fenced(held(|conn| {
            let mut rows = conn.execute("INSERT INTO mc_async_compaction(session_ref,conversation_key,session,state_json) VALUES(?1,?2,?3,?4)
                ON CONFLICT(session_ref) DO UPDATE SET state_json=excluded.state_json",
                params![session_ref,key,session,state])? as u64;
            let mut bytes = state.len();
            if let Some(through) = truncate_entries {
                rows += conn.execute(
                    "DELETE FROM mc_async_compaction_entries WHERE session_ref=?1 AND ordinal>?2",
                    params![session_ref, through.map_or(-1, |n| n as i64)],
                )? as u64;
            }
            if !entries.is_empty() {
                let mut insert = conn.prepare_cached("INSERT INTO mc_async_compaction_entries(session_ref,session,ordinal,entry_json,index_json) VALUES(?1,?2,?3,?4,?5)")?;
                for (ordinal, entry, index) in entries {
                    rows += insert.execute(params![session_ref, session, ordinal, entry, index])? as u64;
                    bytes += entry.len() + index.len();
                }
            }
            for (slot, view) in baselines {
                rows += match view {
                    Some(view) => {
                        bytes += view.len();
                        conn.execute("INSERT INTO mc_async_compaction_baselines(session_ref,session,slot,view_json) VALUES(?1,?2,?3,?4)
                            ON CONFLICT(session_ref,slot) DO UPDATE SET view_json=excluded.view_json",
                            params![session_ref, session, slot, view])?
                    }
                    None => conn.execute(
                        "DELETE FROM mc_async_compaction_baselines WHERE session_ref=?1 AND slot=?2",
                        params![session_ref, slot],
                    )?,
                } as u64;
            }
            if clear_engine_views {
                rows += conn.execute(
                    "UPDATE mc_async_compaction_views SET engine_json=NULL WHERE session_ref=?1 AND engine_json IS NOT NULL",
                    [session_ref],
                )? as u64;
            }
            if let Some(floor) = retain_views_from {
                rows += conn.execute(
                    "DELETE FROM mc_async_compaction_views WHERE session_ref=?1 AND version<?2
                        AND version<(SELECT max(version) FROM mc_async_compaction_views WHERE session_ref=?1)",
                    params![session_ref, floor],
                )? as u64;
            }
            crate::provider_log::insert_tags_tx(conn, namespace, tags)?;
            rows += tags.len() as u64;
            bytes += tags.iter().map(|t| t.source_bytes.len() + t.block_id.len()).sum::<usize>();
            Ok(((), rows, bytes as u64))
        })).map_err(McStoreError::from))
    }
}
