//! Session-scoped UI commands and their bounded, acknowledged event stream.
//! The command record and its store-local effect commit in the same transaction.

use crate::{cache_codec, McStore, McStoreError};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const EVENT_RETENTION: i64 = 256;
pub const EVENT_PAGE_LIMIT: usize = 64;

fn initialize(tx: &Connection) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS mc_ops_commands (
          session_id TEXT NOT NULL, command_id TEXT NOT NULL, job_id TEXT NOT NULL,
          parameters TEXT NOT NULL, job TEXT NOT NULL,
          PRIMARY KEY(session_id, command_id), UNIQUE(session_id, job_id));
         CREATE TABLE IF NOT EXISTS mc_ops_stream (
          session_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, acked INTEGER NOT NULL, active_command TEXT);
         CREATE TABLE IF NOT EXISTS mc_ops_events (
          session_id TEXT NOT NULL, sequence INTEGER NOT NULL, event TEXT NOT NULL,
          PRIMARY KEY(session_id, sequence));
         CREATE TRIGGER IF NOT EXISTS mc_ops_retire AFTER DELETE ON mc_cache_state BEGIN
          DELETE FROM mc_ops_commands WHERE session_id=OLD.session_id;
          DELETE FROM mc_ops_events WHERE session_id=OLD.session_id;
          DELETE FROM mc_ops_stream WHERE session_id=OLD.session_id;
         END;",
    )
}

fn exists(conn: &Connection) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='mc_ops_commands')",
        [],
        |r| r.get(0),
    )
}

fn decode(text: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&text).map_err(crate::serde_to_sql_error)
}

fn job_id(session: &str, command: &str) -> String {
    let mut hash = Sha256::new();
    hash.update((session.len() as u64).to_be_bytes());
    hash.update(session.as_bytes());
    hash.update(command.as_bytes());
    format!("ops-{:x}", hash.finalize())
}

impl McStore {
    /// Read only small cache fields and a capped compartment-count projection.
    /// Counts over the scan bound are unknown rather than truncated truth.
    pub fn ops_snapshot(&self, session: &str) -> Result<Value, McStoreError> {
        let count = self.context_read(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM (SELECT 1 FROM compartments WHERE session_id=?1 LIMIT 4097)",
                [session],
                |r| r.get::<_, i64>(0),
            )
        })?;
        let (version, meta, boundary) =
            self.inner
                .with_conn(|conn| match cache_codec::read_small_row(conn, session)? {
                    Some(row) => {
                        let meta = cache_codec::decode_small_meta(&row.meta)
                            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                        let core = cache_codec::decode_small_core(&row.core_state)
                            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                        Ok((Some(row.row_version), meta, !core.boundary_id.is_empty()))
                    }
                    None => Ok((None, crate::ModuleMeta::default(), false)),
                })?;
        Ok(
            json!({"row_version":version,"meta":meta,"boundary_present":boundary,"compartment_count":if count <= 4096 { Some(count) } else { None }}),
        )
    }

    pub fn ops_flush(
        &self,
        session: &str,
        command: &str,
        compaction: bool,
        now: i64,
    ) -> Result<Value, McStoreError> {
        self.ops_flush_parameters(
            session,
            command,
            compaction,
            now,
            "{\"method\":\"mc.flush\"}",
        )
    }

    fn ops_flush_parameters(
        &self,
        session: &str,
        command: &str,
        compaction: bool,
        now: i64,
        parameters: &str,
    ) -> Result<Value, McStoreError> {
        Ok(self.inner.with_conn_fenced(|tx| {
            crate::move_store::check_writer(tx,session)?;
            let has_ledger = exists(tx)?;
            let existing = if has_ledger { tx.query_row("SELECT parameters,job FROM mc_ops_commands WHERE session_id=?1 AND command_id=?2", params![session,command], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()? } else { None };
            if let Some((prior,job)) = existing {
                return if prior == parameters { decode(job) } else { Ok(json!({"error":"command_parameter_mismatch"})) };
            }
            let (sequence,acked,active) = if has_ledger { tx.query_row("SELECT sequence,acked,active_command FROM mc_ops_stream WHERE session_id=?1", [session], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,Option<String>>(2)?))).optional()?.unwrap_or((0,0,None)) } else { (0,0,None) };
            if sequence - acked >= EVENT_RETENTION { return Ok(json!({"error":"event_backlog_full"})); }
            let targets = {
                let mut stmt = tx.prepare("SELECT target_id FROM pending_agent_drops WHERE session_id=?1 ORDER BY target_id LIMIT 513")?;
                let rows = stmt.query_map([session], |r| r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            if targets.len() > 512 || targets.iter().any(|v| v.len() > 256) || serde_json::to_vec(&targets).map_err(crate::serde_to_sql_error)?.len() > 256 * 1024 { return Ok(json!({"error":"flush_queue_too_large"})); }
            initialize(tx)?;
            let row = cache_codec::read_small_row(tx,session)?;
            let mut meta = row.as_ref().map(|row| cache_codec::decode_small_meta(&row.meta)).transpose().map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?.unwrap_or_default();
            if compaction { meta.soft_refresh_pending = true; }
            if let Some(row) = row {
                let encoded = cache_codec::encode_small_meta(&meta).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                let encoded = cache_codec::preserve_native_marker(encoded,&row.meta)?;
                if encoded != row.meta {
                    tx.execute("UPDATE mc_cache_state SET meta=?2,row_version=row_version+1,last_activity_at=?3 WHERE session_id=?1",params![session,encoded,now])?;
                    crate::advance_row_state_digest_tx(tx,session,row.row_version as i64,row.row_version as i64 + 1)?;
                }
            } else {
                crate::write_cache_state_tx(tx,session,1,&crate::CoreState::default(),&meta,None,now)?;
            }
            if compaction {
                if let Some(active) = active {
                    tx.execute("UPDATE mc_ops_commands SET job=json_set(job,'$.state','superseded') WHERE session_id=?1 AND command_id=?2 AND json_extract(job,'$.state')='armed'",params![session,active])?;
                    tx.execute("UPDATE mc_ops_events SET event=json_set(event,'$.currentness.current',json('false')) WHERE session_id=?1 AND json_extract(event,'$.command_id')=?2",params![session,active])?;
                }
            }
            let mut result = json!({"queued_drops":{"state":"pending","count":targets.len(),"target_tag_ids":targets},"soft_refresh_pending":meta.soft_refresh_pending,"bridge_refresh_obligations":if compaction { vec!["materialization","history","system"] } else {vec![]},"history_rebuilt":false});
            if !compaction { result["reason"] = json!("compaction_off"); }
            let id = job_id(session,command);
            let job = json!({"v":1,"command_id":command,"job_id":id,"state":if compaction {"armed"} else {"no_op"},"result":result,"created_at_ms":now});
            let inserted = tx.execute("INSERT OR IGNORE INTO mc_ops_commands(session_id,command_id,job_id,parameters,job) VALUES(?1,?2,?3,?4,?5)",params![session,command,id,parameters,job.to_string()])?;
            if inserted != 1 { return Err(rusqlite::Error::InvalidQuery); }
            let event = json!({"v":1,"event_id":format!("{id}:{}",sequence+1),"sequence":sequence+1,"session_id":session,"command_id":command,"job_id":id,"kind":if compaction {"job.armed"} else {"job.terminal"},"invalidates":["mc.read_sidebar","mc.read_status"],"currentness":{"policy":"current_until_withdrawn","current":true},"job":job});
            if event.to_string().len() > 512 * 1024 { return Err(rusqlite::Error::InvalidQuery); }
            tx.execute("INSERT INTO mc_ops_events(session_id,sequence,event) VALUES(?1,?2,?3)",params![session,sequence+1,event.to_string()])?;
            tx.execute("INSERT INTO mc_ops_stream(session_id,sequence,acked,active_command) VALUES(?1,?2,0,?3) ON CONFLICT(session_id) DO UPDATE SET sequence=excluded.sequence,active_command=COALESCE(excluded.active_command,active_command)",params![session,sequence+1,if compaction {Some(command)} else {None}])?;
            Ok(job)
        })?)
    }

    pub fn ops_jobs(&self, session: &str) -> Result<Vec<Value>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            if !exists(conn)? { return Ok(Vec::new()); }
            let text = conn.query_row("SELECT c.job FROM mc_ops_stream s JOIN mc_ops_commands c ON c.session_id=s.session_id AND c.command_id=s.active_command WHERE s.session_id=?1",[session],|r| r.get::<_,String>(0)).optional()?;
            text.map(decode).transpose().map(|v| v.into_iter().collect())
        })?)
    }

    pub fn ops_job(
        &self,
        session: &str,
        command: Option<&str>,
        job: Option<&str>,
    ) -> Result<Option<Value>, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            if !exists(conn)? { return Ok(None); }
            let text = match (command,job) {
                (Some(command),job) => conn.query_row("SELECT job FROM mc_ops_commands WHERE session_id=?1 AND command_id=?2 AND (?3 IS NULL OR job_id=?3)", params![session,command,job], |r| r.get::<_,String>(0)).optional()?,
                (None,Some(job)) => conn.query_row("SELECT job FROM mc_ops_commands WHERE session_id=?1 AND job_id=?2", params![session,job], |r| r.get::<_,String>(0)).optional()?,
                (None,None) => None,
            };
            text.map(decode).transpose()
        })?)
    }

    /// Acknowledgement means the module durably spooled the events, not that a
    /// host displayed them. Unacknowledged terminal notices are never evicted.
    pub fn ops_events(&self, session: &str, ack: i64, limit: usize) -> Result<Value, McStoreError> {
        Ok(self.inner.with_conn_fenced(|tx| {
            if !exists(tx)? {
                return Ok(if ack == 0 { event_page(0,0,Vec::new(),false) } else { json!({"error":"invalid_ack"}) });
            }
            let (sequence, prior_ack) = tx.query_row("SELECT sequence,acked FROM mc_ops_stream WHERE session_id=?1", [session], |r| Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?))).optional()?.unwrap_or((0,0));
            if ack > sequence { return Ok(json!({"error":"invalid_ack"})); }
            if ack < prior_ack { return Ok(json!({"error":"resync_required","acked_position":prior_ack,"through_sequence":sequence})); }
            let mut stmt = tx.prepare("SELECT event FROM mc_ops_events WHERE session_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3")?;
            let events = stmt.query_map(params![session,ack,limit as i64], |r| decode(r.get(0)?))?.collect::<rusqlite::Result<Vec<_>>>()?;
            drop(stmt);
            // A count bound alone can exceed the bridge's 1 MiB reply ceiling
            // when many jobs carry large pending-drop snapshots. Leave room for
            // the page envelope and resume after the last event actually sent.
            let mut bytes = 0;
            let events = events.into_iter().take_while(|event| {
                bytes += event.to_string().len();
                bytes <= 512 * 1024
            }).collect::<Vec<_>>();
            tx.execute("UPDATE mc_ops_stream SET acked=?2 WHERE session_id=?1", params![session,ack])?;
            tx.execute("DELETE FROM mc_ops_events WHERE session_id=?1 AND sequence<=?2", params![session,ack])?;
            let next = events.last().and_then(|v| v["sequence"].as_i64()).unwrap_or(ack);
            Ok(event_page(sequence,next,events,next < sequence))
        })?)
    }

    pub fn ops_currentness(&self, session: &str, id: &str) -> Result<bool, McStoreError> {
        Ok(self.inner.with_conn(|conn| {
            if !exists(conn)? { return Ok(false); }
            conn.query_row("SELECT EXISTS(SELECT 1 FROM mc_ops_events WHERE session_id=?1 AND json_extract(event,'$.currentness.current')=1 AND json_extract(event,'$.event_id')=?2)", params![session,id], |r| r.get(0))
        })?)
    }
}

fn event_page(sequence: i64, next: i64, events: Vec<Value>, more: bool) -> Value {
    json!({"v":1,"events":events,"through_sequence":sequence,"next_position":next,"has_more":more,"retention_bound":EVENT_RETENTION,"page_limit":EVENT_PAGE_LIMIT,"emits_push":false,"currentness":{"policy":"current_until_withdrawn","current":true}})
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};

    fn fixture() -> (McStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "mc".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        })
        .unwrap();
        (store, dir)
    }

    #[test]
    fn ops_ledger_replays_once_survives_restart_and_rejects_parameter_mismatch() {
        let (store, dir) = fixture();
        let first = store.ops_flush("a", "one", true, 1).unwrap();
        let version = store.load_meta("a").unwrap().row_version;
        assert_eq!(store.ops_flush("a", "one", true, 2).unwrap(), first);
        assert_eq!(store.load_meta("a").unwrap().row_version, version);
        assert_eq!(
            store
                .ops_flush_parameters("a", "one", true, 3, "different")
                .unwrap()["error"],
            "command_parameter_mismatch"
        );
        assert_eq!(
            store.ops_job("a", Some("one"), None).unwrap(),
            Some(first.clone())
        );
        assert!(store.ops_job("b", Some("one"), None).unwrap().is_none());
        drop(store);
        let store = McStore::open_for_test(&StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "mc".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        })
        .unwrap();
        assert_eq!(store.ops_flush("a", "one", true, 4).unwrap(), first);
        assert_eq!(
            store.ops_events("a", 0, 64).unwrap()["events"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn ops_ledger_rolls_back_refresh_if_job_insert_fails() {
        let (store, _dir) = fixture();
        store.inner.with_conn_fenced(|tx| {
            initialize(tx)?;
            tx.execute_batch("CREATE TRIGGER fail_ops_job BEFORE INSERT ON mc_ops_commands BEGIN SELECT RAISE(ABORT,'job failure'); END;")
        }).unwrap();
        assert!(store.ops_flush("a", "one", true, 1).is_err());
        assert!(!store.load_meta("a").unwrap().meta.soft_refresh_pending);
        assert!(store.ops_job("a", Some("one"), None).unwrap().is_none());
    }

    #[test]
    fn ops_event_retention_refuses_admission_instead_of_losing_unacked_outcomes() {
        let (store, _dir) = fixture();
        for id in 0..EVENT_RETENTION {
            store.ops_flush("a", &id.to_string(), true, id).unwrap();
        }
        assert_eq!(
            store.ops_flush("a", "overflow", true, 300).unwrap()["error"],
            "event_backlog_full"
        );
        assert!(store
            .ops_job("a", Some("overflow"), None)
            .unwrap()
            .is_none());
        let page = store.ops_events("a", 0, 64).unwrap();
        assert_eq!(page["events"].as_array().unwrap().len(), 64);
        assert_eq!(page["has_more"], true);
        store.ops_events("a", 64, 64).unwrap();
        assert!(store
            .ops_flush("a", "overflow", true, 301)
            .unwrap()
            .get("error")
            .is_none());
        assert_eq!(
            store.ops_events("a", 0, 64).unwrap()["error"],
            "resync_required"
        );
    }

    #[test]
    fn ops_jobs_retire_with_session_without_touching_other_sessions() {
        let (store, _dir) = fixture();
        store.ops_flush("a", "one", true, 1).unwrap();
        let other = store.ops_flush("b", "one", true, 1).unwrap();
        store.delete_session("a", "project-a").unwrap();
        assert!(store.ops_job("a", Some("one"), None).unwrap().is_none());
        assert_eq!(store.ops_job("b", Some("one"), None).unwrap(), Some(other));
    }

    #[test]
    fn ops_event_pages_are_byte_bounded_without_skipping_events() {
        let (store, _dir) = fixture();
        let targets = (0..512)
            .map(|id| format!("{id:04}{}", "x".repeat(252)))
            .collect::<Vec<_>>();
        store.append_pending_agent_drops("a", &targets, 1).unwrap();
        for id in 0..8 {
            store.ops_flush("a", &id.to_string(), true, id).unwrap();
        }
        let mut ack = 0;
        let mut seen = Vec::new();
        while ack < 8 {
            let page = store.ops_events("a", ack, 64).unwrap();
            assert!(page.to_string().len() < 1024 * 1024);
            for event in page["events"].as_array().unwrap() {
                seen.push(event["sequence"].as_i64().unwrap());
            }
            let next = page["next_position"].as_i64().unwrap();
            assert!(next > ack);
            ack = next;
        }
        assert_eq!(seen, (1..=8).collect::<Vec<_>>());
    }

    mod review {
        use super::*;
        include!("command_ledger_review_tests.rs");
    }
}
