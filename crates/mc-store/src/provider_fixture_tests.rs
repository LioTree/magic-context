//! Test-only populated store fixture for the executable compatibility gate.
use crate::McStoreError;

/// Build a populated pre-provider store using the shipped migration chain.
pub fn create_test_v63_store(
    descriptor: &cortexkit_store_types::StorageDescriptor,
) -> Result<(), McStoreError> {
    let inner = crate::open_sqlite(descriptor)?;
    inner.with_conn(crate::register_legacy_trigger_functions)?;
    let end = crate::MIGRATIONS
        .iter()
        .position(|m| m.version == 64)
        .expect("v64 migration");
    inner.migrate(crate::NS, &crate::MIGRATIONS[..end])?;
    inner.with_conn(|conn| {
        conn.execute_batch("UPDATE mc_privilege_state SET single_store=1, single_store_set_at_ms=424242, single_store_set_by='provider-release-fixture' WHERE id=1;
            INSERT INTO mc_cache_state(session_id,row_version,core_state,meta) VALUES ('legacy-fixture',7,'{}','{}');
            INSERT INTO mc_tags(session_id,tag_number,block_id,kind,token_count,created_at_ms,source_bytes) VALUES ('legacy-fixture',11,'m0#0','tool_result',4,10,X'7061796c6f6164');
            INSERT INTO pending_agent_drops(session_id,target_id,queued_at) VALUES ('legacy-fixture','m0#0',10);")?;
        assert_eq!(crate::single_store_schema::recorded_store_version(conn)?, 63);
        Ok(())
    })?;
    Ok(())
}
