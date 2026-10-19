//! Async cursors and view versions are independent of the compatibility record.
//! A legacy record save must never reset a notice-driven reader's progress.
use crate::{McStore, McStoreError, McTagRow};
use rusqlite::{params, OptionalExtension};

impl McStore {
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
