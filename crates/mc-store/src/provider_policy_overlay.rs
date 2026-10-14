//! Frozen policy facts share the lifetime of their immutable native message.
//! Retiring a native row retires its facts; missing source facts are an error,
//! never permission to invent measurements for a view or a policy reader.
use crate::provider_log::{ProviderError, ProviderPolicyPart};
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use rusqlite::{params, Connection};
use serde_json::Value;
use std::io::{Read, Write};

const MAX_FACT_BYTES: usize = 16 * 1024 * 1024;

pub(crate) fn encode_facts(
    parts: &[ProviderPolicyPart],
) -> Result<(Vec<u8>, usize), ProviderError> {
    let raw = serde_json::to_vec(parts).map_err(|e| ProviderError::Transient(e.to_string()))?;
    if raw.len() > MAX_FACT_BYTES {
        return Err(ProviderError::Transient(
            "frozen policy facts exceed source cap".into(),
        ));
    }
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(&raw)
        .map_err(|e| ProviderError::Transient(e.to_string()))?;
    Ok((
        encoder
            .finish()
            .map_err(|e| ProviderError::Transient(e.to_string()))?,
        raw.len(),
    ))
}

pub(crate) fn decode_facts(
    blob: &[u8],
    bytes: usize,
    count: usize,
) -> Result<Vec<ProviderPolicyPart>, ProviderError> {
    if bytes > MAX_FACT_BYTES || count > 100_000 {
        return Err(ProviderError::Transient(
            "frozen policy facts exceed source cap".into(),
        ));
    }
    let mut raw = Vec::with_capacity(bytes.min(64 * 1024));
    ZlibDecoder::new(blob)
        .take(bytes.saturating_add(1) as u64)
        .read_to_end(&mut raw)
        .map_err(|e| ProviderError::Transient(e.to_string()))?;
    if raw.len() != bytes {
        return Err(ProviderError::Transient(
            "frozen policy facts length mismatch".into(),
        ));
    }
    let parts: Vec<ProviderPolicyPart> =
        serde_json::from_slice(&raw).map_err(|e| ProviderError::Transient(e.to_string()))?;
    if parts.len() != count {
        return Err(ProviderError::Transient(
            "frozen policy facts count mismatch".into(),
        ));
    }
    Ok(parts)
}

pub(crate) fn current_cut_tx(conn: &Connection, conv: &str) -> rusqlite::Result<Option<u64>> {
    use rusqlite::OptionalExtension;
    conn.query_row("SELECT json_extract(hook_counters_json,'$.engine_policy.baseline_cut_id') FROM mc_provider_conversations_v2 WHERE conv_key=?1", [conv], |r|r.get(0)).optional().map(Option::flatten)
}

pub(crate) struct FrozenPolicyResolver {
    defaults: Value,
    overrides: std::collections::HashMap<(String, String), Value>,
}

impl FrozenPolicyResolver {
    pub(crate) fn new(conn: &Connection, conv: &str) -> Result<Self, ProviderError> {
        use rusqlite::OptionalExtension;
        let mut defaults = Value::Null;
        let mut overrides = std::collections::HashMap::new();
        if let Some(cut) = current_cut_tx(conn, conv)? {
            let raw: Option<String> = conn.query_row("SELECT defaults_json FROM mc_provider_policy_cuts_v1 WHERE conv_key=?1 AND cut_id=?2", params![conv,cut], |r|r.get(0)).optional()?;
            defaults = serde_json::from_str(
                &raw.ok_or_else(|| ProviderError::Transient("policy cut is missing".into()))?,
            )
            .map_err(|e| ProviderError::Transient(e.to_string()))?;
            let mut q=conn.prepare_cached("SELECT source_lineage_id,block_id,override_json FROM mc_provider_policy_overrides_v1 WHERE conv_key=?1 AND cut_id=?2")?;
            for row in q.query_map(params![conv, cut], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })? {
                let (lineage, block, raw) = row?;
                overrides.insert(
                    (lineage, block),
                    serde_json::from_str(&raw)
                        .map_err(|e| ProviderError::Transient(e.to_string()))?,
                );
            }
        }
        Ok(Self {
            defaults,
            overrides,
        })
    }

    /// The only projection of a frozen source into the public policy representation.
    pub(crate) fn resolve(
        &self,
        lineage: &str,
        mut part: ProviderPolicyPart,
    ) -> Result<ProviderPolicyPart, ProviderError> {
        if self.defaults.get("covered_measurements") == Some(&Value::Bool(true))
            && part.kind != "header"
        {
            part.measurement.kind = crate::TailHygienePartKind::Excluded;
            part.measurement.tokens = 0;
            part.measurement.u_tokens = 0;
        }
        if let Some(patch) = self
            .overrides
            .get(&(lineage.to_string(), part.block_id.clone()))
        {
            let mut value =
                serde_json::to_value(&part).map_err(|e| ProviderError::Transient(e.to_string()))?;
            merge_policy_patch(&mut value, patch)?;
            part = serde_json::from_value(value)
                .map_err(|e| ProviderError::Transient(e.to_string()))?;
        }
        Ok(part)
    }
}

fn merge_policy_patch(value: &mut Value, patch: &Value) -> Result<(), ProviderError> {
    const FIELDS: &[&str] = &[
        "measurement",
        "tag_kind",
        "tag_number",
        "tag_tokens",
        "tool_name",
        "arc_id",
        "subject_part",
        "active",
        "served",
        "reduced",
        "queued",
        "real_user",
        "created_at_ms",
        "completed_at_ms",
    ];
    const MEASUREMENTS: &[&str] = &[
        "key",
        "content_hash",
        "kind",
        "tokens",
        "u_tokens",
        "tag_number",
        "tag_status",
        "protected",
        "queued_for_drop",
    ];
    let patch = patch
        .as_object()
        .ok_or_else(|| ProviderError::Transient("invalid policy override".into()))?;
    for (key, next) in patch {
        if !FIELDS.contains(&key.as_str()) {
            return Err(ProviderError::Transient(
                "policy override changes source identity".into(),
            ));
        }
        if key == "measurement" {
            for (field, next) in next
                .as_object()
                .ok_or_else(|| ProviderError::Transient("invalid measurement override".into()))?
            {
                if !MEASUREMENTS.contains(&field.as_str()) {
                    return Err(ProviderError::Transient(
                        "unknown measurement override".into(),
                    ));
                }
                value[key][field] = next.clone();
            }
        } else {
            value[key] = next.clone();
        }
    }
    Ok(())
}

/// Freeze only newly covered messages. Existing frozen vectors are never
/// rewritten by a later cut; uniform measurement changes live in cut defaults.
pub(crate) fn freeze_cut_tx(
    conn: &Connection,
    conv: &str,
    lineage: &str,
    coverage: Option<u64>,
    settings: &Value,
    parts: &[ProviderPolicyPart],
) -> Result<u64, ProviderError> {
    let cut: u64 = conn.query_row(
        "SELECT coalesce(max(cut_id),-1)+1 FROM mc_provider_policy_cuts_v1 WHERE conv_key=?1",
        [conv],
        |r| r.get(0),
    )?;
    let mut grouped = std::collections::BTreeMap::<u64, Vec<ProviderPolicyPart>>::new();
    for part in parts
        .iter()
        .filter(|part| coverage.is_some_and(|n| part.ordinal <= n))
    {
        grouped.entry(part.ordinal).or_default().push(part.clone());
    }
    let mut frozen_parts = 0u64;
    let mut frozen_users = 0u64;
    for (ordinal, parts) in grouped {
        use rusqlite::OptionalExtension;
        let format: Option<u32>=conn.query_row("SELECT frozen_policy_format FROM mc_provider_messages_v1 WHERE conv_key=?1 AND lineage_id=?2 AND ordinal=?3",params![conv,lineage,ordinal],|r|r.get(0)).optional()?;
        match format {
            Some(0) => {
                let (blob, bytes) = encode_facts(&parts)?;
                conn.execute("UPDATE mc_provider_messages_v1 SET frozen_policy_format=1,frozen_policy_raw_bytes=?4,frozen_policy_parts=?5,frozen_policy_bytes=?6 WHERE conv_key=?1 AND lineage_id=?2 AND ordinal=?3 AND frozen_policy_format=0",params![conv,lineage,ordinal,bytes,parts.len(),blob])?;
                frozen_parts += parts.len() as u64;
                frozen_users += parts
                    .iter()
                    .filter(|p| p.kind == "header" && p.real_user)
                    .count() as u64;
            }
            Some(1) => {}
            _ => {
                return Err(ProviderError::Transient(
                    "frozen policy source message is missing".into(),
                ))
            }
        }
    }
    let old = current_cut_tx(conn, conv)?;
    let (old_count, old_totals): (u64, Value) = if let Some(old) = old {
        let (count,raw):(u64,String)=conn.query_row("SELECT frozen_part_count,prefix_totals_json FROM mc_provider_policy_cuts_v1 WHERE conv_key=?1 AND cut_id=?2",params![conv,old],|r|Ok((r.get(0)?,r.get(1)?)))?;
        (
            count,
            serde_json::from_str(&raw).map_err(|e| ProviderError::Transient(e.to_string()))?,
        )
    } else {
        (0, serde_json::json!({}))
    };
    conn.execute("INSERT INTO mc_provider_policy_cuts_v1 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,json_extract(?1,'$[1]'))",params![conv,cut,lineage,coverage,old_count+frozen_parts,settings.get("baseline").unwrap_or(&Value::Null).to_string(),serde_json::json!({"format":1,"covered_measurements":true}).to_string(),serde_json::json!({"users":old_totals.get("users").and_then(Value::as_u64).unwrap_or(0)+frozen_users}).to_string(),settings.to_string()])?;
    // Sparse exceptions are relative to the current cut, not an ever-growing
    // stack of historical before-images.
    conn.execute(
        "UPDATE mc_provider_policy_overrides_v1 SET cut_id=?2 WHERE conv_key=?1",
        params![conv, cut],
    )?;
    if let Some(coverage) = coverage {
        conn.execute("DELETE FROM mc_provider_policy_parts_v1 WHERE conv_key=?1 AND lineage_id=?2 AND ordinal<=?3",params![conv,lineage,coverage])?;
    }
    Ok(cut)
}
