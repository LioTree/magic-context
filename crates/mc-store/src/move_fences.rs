//! Writer protection for the durable private-store move fences.
//!
//! The schema is retained for migration compatibility. This binary has no move
//! activation or export/import API, but must respect any fence already on disk.
use crate::move_inventory::{self, Class, RowSelector, Store};
use crate::{McStore, McStoreError};
use rusqlite::{Connection, OptionalExtension};

fn quoted(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

/// Temporary triggers cover ordinary writes, bulk deletes and trigger effects
/// without depending on which McStore method a writer uses.
pub(crate) fn install_writer_guards(conn: &Connection) -> rusqlite::Result<()> {
    for table in move_inventory::tables(Store::Module) {
        let RowSelector::Predicate(_) = table.rows else {
            continue;
        };
        if table.class == Class::NotSession {
            continue;
        }
        let owner = table.session_column().expect("classified session owner");
        for action in ["INSERT", "UPDATE", "DELETE"] {
            let sides: &[&str] = match action {
                "INSERT" => &["NEW"],
                "UPDATE" => &["OLD", "NEW"],
                _ => &["OLD"],
            };
            let allowed = draining_exception(table.table, action, table.columns);
            let conditions = sides.iter().map(|side| format!(
                "EXISTS(SELECT 1 FROM mc_move_fences f WHERE f.session_id = {side}.{} AND CASE WHEN f.phase = 'draining' AND ({allowed}) THEN 0 ELSE 1 END)", quoted(owner)
            )).collect::<Vec<_>>().join(" OR ");
            conn.execute_batch(&format!(
                "CREATE TEMP TRIGGER IF NOT EXISTS {} BEFORE {action} ON main.{} WHEN {conditions} BEGIN SELECT RAISE(ABORT, 'session_moving'); END;",
                quoted(&format!("mc_move_guard_{}_{}", table.table, action.to_lowercase())), quoted(table.table)
            ))?;
        }
    }
    Ok(())
}

fn draining_exception(table: &str, action: &str, columns: &[&str]) -> String {
    match (table, action) {
        ("mc_single_store_pending_publish" | "mc_historian_pending_run", "DELETE") => "1".into(),
        ("mc_historian_pending_run", "UPDATE") => "NEW.session_id IS OLD.session_id AND NEW.run_id IS OLD.run_id AND NEW.phase = 'cancelled'".into(),
        ("mc_cache_state", "UPDATE") => {
            let unchanged = columns.iter().filter(|c| !["meta", "row_version"].contains(c)).map(|c| format!("NEW.{} IS OLD.{}", quoted(c), quoted(c))).collect::<Vec<_>>().join(" AND ");
            // Missing JSON fields must not turn SQL NULL into permission to write.
            format!("{unchanged} AND json_valid(NEW.meta) AND json_valid(OLD.meta) AND json_remove(NEW.meta, '$.historian') = json_remove(OLD.meta, '$.historian') AND json_extract(NEW.meta, '$.historian.state') IN ('Idle','idle','Cancelled','cancelled','Completed','completed')")
        }
        ("mc_cache_state_digest", _) => "EXISTS(SELECT 1 FROM mc_cache_state s WHERE s.session_id = NEW.session_id AND json_extract(s.meta, '$.historian.state') IN ('Idle','idle','Cancelled','cancelled','Completed','completed'))".replace("NEW", if action == "DELETE" { "OLD" } else { "NEW" }),
        _ => "0".into(),
    }
}

impl McStore {
    pub(crate) fn check_session_not_moving(&self, session: &str) -> Result<(), McStoreError> {
        let fenced = self.inner.with_conn(|conn| {
            conn.query_row(
                "SELECT phase FROM mc_move_fences WHERE session_id = ?1",
                [session],
                |row| row.get::<_, String>(0),
            )
            .optional()
        })?;
        if fenced.is_some() {
            Err(McStoreError::SessionMoving)
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};

    #[test]
    fn durable_fences_cover_provider_catalog_and_record_writes_after_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let descriptor = StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: crate::NS.into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: dir.path().join("store.db").to_string_lossy().into_owned(),
            },
        };
        let store = McStore::open_for_test(&descriptor).unwrap();
        store
            .inner
            .with_conn(|conn| {
                conn.execute_batch("INSERT INTO mc_move_fences VALUES ('fenced','cut','frozen')")
            })
            .unwrap();
        drop(store);
        let store = McStore::open_for_test(&descriptor).unwrap();
        let key = crate::ProviderSessionKey {
            project_root: "/project".into(),
            session: "fenced".into(),
            harness: "broca".into(),
        };
        assert!(matches!(
            store.save_provider_record(&key, "{}", "engine", &[]),
            Err(McStoreError::SessionMoving)
        ));
        assert!(matches!(
            store.save_provider_catalog("/project", "fenced", "{}"),
            Err(McStoreError::SessionMoving)
        ));
        assert!(matches!(
            store.delete_session("fenced", "/project"),
            Err(McStoreError::SessionMoving)
        ));
        assert!(store.load_provider_record(&key).unwrap().is_none());
        assert!(store
            .load_provider_catalog("/project", "fenced")
            .unwrap()
            .is_none());
        store
            .save_provider_catalog("/project", "unfenced", "{}")
            .unwrap();
    }
}
