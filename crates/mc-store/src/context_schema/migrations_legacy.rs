//! Historical context.db upgrades for starting versions 87 through 100.
//!
//! Earlier versions still need identity repairs, embedding rebuilds, authority-trigger
//! repairs, and host-evidence harness relabeling. Refuse them rather than skip those steps.
//! The caller supplies an open connection and a clock; this module never discovers host stores.

use std::{fmt, time::Duration};

use rusqlite::{params, types::ValueRef, Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};

use crate::context_schema::{
    bootstrap::BOOTSTRAP_VERSION,
    fingerprints::{fingerprint, schema_snapshot},
};
use crate::parity_schema_manifest::{ContentHash, ContextSchemaReport};

pub const OLDEST_SUPPORTED_VERSION: u32 = 87;
const FORK_FLOOR: i64 = 10_000;
const STEPS: &str = include_str!("../../testdata/context_schema_legacy/steps.json");
const LKG_CHUNKS: &str = include_str!("../../testdata/context_schema_legacy/lkg_chunks.sql");
const LKG_SLOTS: &str = include_str!("../../testdata/context_schema_legacy/lkg_slots.sql");

#[derive(Debug)]
pub enum UpgradeError {
    UnsupportedVersion(i64),
    Sqlite(rusqlite::Error),
    InvalidAsset(String),
}

impl fmt::Display for UpgradeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedVersion(version) => write!(f, "context.db version {version} is outside supported range {OLDEST_SUPPORTED_VERSION}..={BOOTSTRAP_VERSION}"),
            Self::Sqlite(error) => write!(f, "context.db migration failed: {error}"),
            Self::InvalidAsset(error) => write!(f, "context.db migration asset invalid: {error}"),
        }
    }
}
impl std::error::Error for UpgradeError {}
impl From<rusqlite::Error> for UpgradeError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

#[derive(Deserialize)]
struct Step {
    version: u32,
    description: String,
    sql: Vec<String>,
}

fn exists(db: &Connection, name: &str) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |row| row.get(0),
    )
}

fn column_exists(db: &Connection, table: &str, name: &str) -> rusqlite::Result<bool> {
    let mut statement = db.prepare(&format!(
        "PRAGMA table_info('{}')",
        table.replace('\'', "''")
    ))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for column in columns {
        if column? == name {
            return Ok(true);
        }
    }
    Ok(false)
}

fn current_version(db: &Connection) -> rusqlite::Result<i64> {
    if !exists(db, "schema_migrations")? {
        return Ok(0);
    }
    db.query_row(
        "SELECT COALESCE(MAX(version),0) FROM schema_migrations WHERE version < ?1",
        [FORK_FLOOR],
        |row| row.get(0),
    )
}

fn admit(version: i64) -> Result<(), UpgradeError> {
    if version < i64::from(OLDEST_SUPPORTED_VERSION) || version > i64::from(BOOTSTRAP_VERSION) {
        return Err(UpgradeError::UnsupportedVersion(version));
    }
    Ok(())
}

/// Apply each pending body and ledger row atomically, re-reading under the writer lock.
/// An error rolls back the failing step, leaving previously committed steps intact.
/// Newer upstream versions are rejected before any schema or data writes; fork rows are preserved.
pub fn upgrade(db: &mut Connection, now_ms: i64) -> Result<ContextSchemaReport, UpgradeError> {
    admit(current_version(db)?)?;
    let steps: Vec<Step> = serde_json::from_str(STEPS)
        .map_err(|error| UpgradeError::InvalidAsset(error.to_string()))?;
    if steps.len() != (BOOTSTRAP_VERSION - OLDEST_SUPPORTED_VERSION) as usize
        || steps
            .iter()
            .enumerate()
            .any(|(index, step)| step.version != OLDEST_SUPPORTED_VERSION + index as u32 + 1)
    {
        return Err(UpgradeError::InvalidAsset(
            "migration fence or sequence changed".into(),
        ));
    }
    db.busy_timeout(Duration::from_secs(5))?;
    db.pragma_update(None, "foreign_keys", true)?;
    while current_version(db)? < i64::from(BOOTSTRAP_VERSION) {
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version = current_version(&tx)?;
        admit(version)?;
        if let Some(step) = steps.iter().find(|step| i64::from(step.version) > version) {
            apply(&tx, step, now_ms)?;
            tx.execute(
                "INSERT INTO schema_migrations(version,description,applied_at) VALUES (?1,?2,?3)",
                params![step.version, step.description, now_ms],
            )?;
        }
        tx.commit()?;
    }
    let snapshot = schema_snapshot(db)?;
    Ok(ContextSchemaReport {
        schema_version: BOOTSTRAP_VERSION,
        schema_fingerprint: ContentHash(fingerprint(&snapshot)),
    })
}

fn apply(db: &Connection, step: &Step, now_ms: i64) -> Result<(), UpgradeError> {
    if step.version == 94 {
        split_lkg(db, now_ms)?;
    }
    let move_temporal = step.version == 95 && !exists(db, "temporal_decisions")?;
    let existing_map = if step.version == 95 {
        db.query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='git_commit_fts_rowid_map'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    } else {
        None
    };
    if let Some(sql) = &existing_map {
        if sql != "CREATE TABLE git_commit_fts_rowid_map (\n    fts_rowid INTEGER PRIMARY KEY,\n    sha BLOB\n)" {
            return Err(UpgradeError::InvalidAsset("git_commit_fts_rowid_map schema differs; refusing to replace rowid data".into()));
        }
        let mismatch: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM git_commits_fts f LEFT JOIN git_commit_fts_rowid_map m ON m.fts_rowid=f.rowid WHERE m.fts_rowid IS NULL OR m.sha IS NOT f.sha OR typeof(m.sha) IS NOT typeof(f.sha) UNION ALL SELECT 1 FROM git_commit_fts_rowid_map m WHERE NOT EXISTS(SELECT 1 FROM git_commits_fts f WHERE f.rowid=m.fts_rowid))", [], |row| row.get(0))?;
        if mismatch {
            return Err(UpgradeError::InvalidAsset(
                "git FTS rowid inventory differs; refusing migration replay".into(),
            ));
        }
    }
    for sql in &step.sql {
        let sql = sql.replace(":now_ms", &now_ms.to_string());
        let words: Vec<_> = sql.split_whitespace().collect();
        // Skip an ALTER's named column if an initializer or prerelease build already
        // added it; replay must not fail with a duplicate-column error.
        if words.first() == Some(&"ALTER")
            && words.get(1) == Some(&"TABLE")
            && words.get(3) == Some(&"ADD")
        {
            let table = words[2];
            let column = if words[4] == "COLUMN" {
                words[5]
            } else {
                words[4]
            };
            if !exists(db, table)? || column_exists(db, table, column)? {
                continue;
            }
        }
        if step.version == 93 && sql.starts_with("CREATE TABLE compartment_history_versions") {
            let installed: Option<String> = db.query_row("SELECT sql FROM sqlite_master WHERE type='table' AND name='compartment_history_versions'", [], |row| row.get(0)).optional()?;
            if let Some(installed) = installed {
                if installed != sql {
                    return Err(UpgradeError::InvalidAsset("compartment_history_versions schema differs from v93; refusing to replace revision data".into()));
                }
                continue;
            }
        }
        if words.first() == Some(&"CREATE")
            && words.get(1) == Some(&"INDEX")
            && words.get(2) != Some(&"IF")
        {
            let installed: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)",
                [words[2]],
                |row| row.get(0),
            )?;
            if installed {
                continue;
            }
        }
        if step.version == 95 {
            if sql.starts_with("CREATE TABLE temporal_decisions") && !move_temporal {
                continue;
            }
            if existing_map.is_some()
                && (sql.starts_with("CREATE TABLE git_commit_fts_rowid_map")
                    || sql
                        .starts_with("INSERT INTO git_commit_fts_rowid_map(fts_rowid, sha) SELECT"))
            {
                continue;
            }
            if sql.starts_with("DROP INDEX ")
                && !db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)",
                    [words[2]],
                    |row| row.get::<_, bool>(0),
                )?
            {
                continue;
            }
        }
        db.execute_batch(&sql)?;
        if move_temporal && sql.starts_with("CREATE TABLE temporal_decisions") {
            split_temporal(db)?;
        }
    }
    Ok(())
}

fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}

fn split_lkg(db: &Connection, now_ms: i64) -> rusqlite::Result<()> {
    db.execute_batch(LKG_CHUNKS)?;
    if !exists(db, "lkg_slots")? {
        return db.execute_batch(&LKG_SLOTS.replace("lkg_slots_v94", "lkg_slots"));
    }
    if !column_exists(db, "lkg_slots", "json_prefix")? {
        return Ok(());
    }
    db.execute(
        "DELETE FROM lkg_slots WHERE NOT (captured_at >= ?1)",
        [now_ms - 86_400_000],
    )?;
    db.execute_batch("DROP TABLE IF EXISTS lkg_slots_v94")?;
    db.execute_batch(LKG_SLOTS)?;
    db.execute("DELETE FROM lkg_slot_chunks", [])?;
    let mut statement = db.prepare("SELECT session_id FROM lkg_slots")?;
    let sessions = statement
        .query_map([], |row| {
            Ok(match row.get_ref(0)? {
                ValueRef::Text(value) => Some(String::from_utf8_lossy(value).into_owned()),
                _ => None,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for session in sessions.into_iter().flatten() {
        let prefix: Option<String> = db.query_row(
            "SELECT json_prefix FROM lkg_slots WHERE session_id IS ?1",
            [&session],
            |row| {
                Ok(match row.get_ref(0)? {
                    ValueRef::Text(value) => Some(String::from_utf8_lossy(value).into_owned()),
                    _ => None,
                })
            },
        )?;
        let Some(prefix) = prefix else {
            continue;
        };
        let mut chunks = Vec::new();
        let mut start = 0;
        let mut units = 0;
        // JavaScript counts UTF-16 units, and backs off at a surrogate-pair boundary.
        for (offset, ch) in prefix.char_indices() {
            if units + ch.len_utf16() > 65_536 {
                chunks.push(&prefix[start..offset]);
                start = offset;
                units = 0;
            }
            units += ch.len_utf16();
        }
        if start < prefix.len() {
            chunks.push(&prefix[start..]);
        }
        let hashes: Vec<_> = chunks.iter().map(hash).collect();
        let changed = db.execute("INSERT OR IGNORE INTO lkg_slots_v94(session_id,json_prefix_chars,json_prefix_chunks,json_prefix_hash,input_id_seq,input_content_digests,input_content_signatures,last_input_message_id,model_key,provider_key,captured_at,row_version,capture_sequence) SELECT session_id,?1,?2,?3,input_id_seq,input_content_digests,input_content_signatures,last_input_message_id,model_key,provider_key,captured_at,row_version,capture_sequence FROM lkg_slots WHERE session_id IS ?4", params![prefix.encode_utf16().count() as i64, chunks.len() as i64, hash(hashes.join("\n")), session])?;
        if changed != 1 {
            continue;
        }
        for (index, chunk) in chunks.iter().enumerate() {
            db.execute(
                "INSERT INTO lkg_slot_chunks(session_id,chunk,hash,body) VALUES (?1,?2,?3,?4)",
                params![session, index as i64, hashes[index], chunk],
            )?;
        }
    }
    db.execute_batch("DROP TABLE lkg_slots; ALTER TABLE lkg_slots_v94 RENAME TO lkg_slots")
}

fn split_temporal(db: &Connection) -> rusqlite::Result<()> {
    if !exists(db, "session_meta")?
        || !column_exists(db, "session_meta", "merged_reasoning_stripped_ids")?
    {
        return Ok(());
    }
    let mut statement = db.prepare("SELECT session_id,merged_reasoning_stripped_ids FROM session_meta WHERE merged_reasoning_stripped_ids LIKE '%temporal-message-v1:%'")?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (session, blob) in rows {
        let Ok(entries) = serde_json::from_str::<Vec<Box<RawValue>>>(&blob) else {
            continue;
        };
        let mut kept = Vec::new();
        for entry in entries {
            if let Some((message_id, marker)) = temporal_pair(&entry) {
                db.execute("INSERT OR IGNORE INTO temporal_decisions(session_id,message_id,marker) VALUES (?1,?2,?3)", params![session, message_id, marker])?;
            } else {
                kept.push(stringify_js(&entry));
            }
        }
        db.execute(
            "UPDATE session_meta SET merged_reasoning_stripped_ids=?1 WHERE session_id=?2",
            params![format!("[{}]", kept.join(",")), session],
        )?;
    }
    Ok(())
}

fn temporal_pair(entry: &RawValue) -> Option<(String, String)> {
    if !entry.get().starts_with('"') {
        return None;
    }
    let text = String::from_utf16_lossy(&js_string(entry.get()));
    let payload = text.strip_prefix("temporal-message-v1:")?;
    let pair = serde_json::from_str::<Vec<Box<RawValue>>>(payload).ok()?;
    if pair.len() != 2 || !pair.iter().all(|item| item.get().starts_with('"')) {
        return None;
    }
    let id = js_string(pair[0].get());
    if id.is_empty() {
        return None;
    }
    Some((
        String::from_utf16_lossy(&id),
        String::from_utf16_lossy(&js_string(pair[1].get())),
    ))
}

fn js_string(raw: &str) -> Vec<u16> {
    let mut result = Vec::new();
    let mut chars = raw[1..raw.len() - 1].chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            let escaped = chars.next().expect("validated JSON escape");
            if escaped == 'u' {
                let digits: String = chars.by_ref().take(4).collect();
                result.push(u16::from_str_radix(&digits, 16).expect("validated Unicode escape"));
            } else {
                result.push(match escaped {
                    'b' => 8,
                    'f' => 12,
                    'n' => 10,
                    'r' => 13,
                    't' => 9,
                    other => other as u16,
                });
            }
        } else {
            let mut buffer = [0; 2];
            result.extend_from_slice(ch.encode_utf16(&mut buffer));
        }
    }
    result
}

fn encode_js_string(units: &[u16]) -> String {
    let mut result = String::from("\"");
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(ch) => {
                let encoded = serde_json::to_string(&ch.to_string()).unwrap();
                result.push_str(&encoded[1..encoded.len() - 1]);
            }
            Err(error) => result.push_str(&format!("\\u{:04x}", error.unpaired_surrogate())),
        }
    }
    result.push('"');
    result
}

fn ordered_object(text: &str) -> Vec<(Vec<u16>, Box<RawValue>)> {
    let mut entries: Vec<(Vec<u16>, Box<RawValue>)> = Vec::new();
    let mut remaining = text[1..text.len() - 1].trim();
    while !remaining.is_empty() {
        let mut reader = serde_json::Deserializer::from_str(remaining).into_iter::<Box<RawValue>>();
        let key = js_string(
            reader
                .next()
                .expect("object key")
                .expect("validated JSON key")
                .get(),
        );
        remaining = remaining[reader.byte_offset()..]
            .trim_start()
            .strip_prefix(':')
            .expect("object colon")
            .trim_start();
        let mut reader = serde_json::Deserializer::from_str(remaining).into_iter::<Box<RawValue>>();
        let value = reader
            .next()
            .expect("object value")
            .expect("validated JSON value");
        remaining = remaining[reader.byte_offset()..].trim_start();
        if let Some(rest) = remaining.strip_prefix(',') {
            remaining = rest.trim_start();
        }
        if let Some(entry) = entries.iter_mut().find(|entry| entry.0 == key) {
            entry.1 = value;
        } else {
            entries.push((key, value));
        }
    }
    entries
}

// JSON.stringify retains object insertion order (except integer keys), rounds
// numbers to IEEE-754, and renders integral floats without a decimal suffix.
// Using a sorted serde_json map would rewrite unrelated retained replay entries.
fn stringify_js(raw: &RawValue) -> String {
    let text = raw.get();
    match text.as_bytes()[0] {
        b'{' => {
            let mut entries = ordered_object(text);
            let array_index = |key: &[u16]| {
                let key = String::from_utf16_lossy(key);
                key.parse::<u32>()
                    .ok()
                    .filter(|value| *value != u32::MAX && value.to_string() == key)
            };
            entries.sort_by(|a, b| match (array_index(&a.0), array_index(&b.0)) {
                (Some(a), Some(b)) => a.cmp(&b),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            });
            format!(
                "{{{}}}",
                entries
                    .iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        encode_js_string(key),
                        stringify_js(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        b'[' => format!(
            "[{}]",
            serde_json::from_str::<Vec<Box<RawValue>>>(text)
                .expect("valid JSON array")
                .iter()
                .map(|value| stringify_js(value))
                .collect::<Vec<_>>()
                .join(",")
        ),
        b'"' => encode_js_string(&js_string(text)),
        b't' | b'f' | b'n' => text.into(),
        _ => {
            let value = text.parse::<f64>().expect("valid JSON number");
            if !value.is_finite() {
                return "null".into();
            }
            if value == 0.0 {
                return "0".into();
            }
            let encoded = serde_json::to_string(&value.abs()).unwrap();
            let (mantissa, exponent) = encoded
                .split_once('e')
                .map_or((encoded.as_str(), 0), |(mantissa, exponent)| {
                    (mantissa, exponent.parse::<i32>().unwrap())
                });
            let decimal = mantissa.find('.').unwrap_or(mantissa.len()) as i32 + exponent;
            let mut digits = mantissa.replace('.', "");
            while digits.ends_with('0') {
                digits.pop();
            }
            let sign = if value < 0.0 { "-" } else { "" };
            let body = if decimal > 0 && decimal <= 21 {
                if decimal as usize >= digits.len() {
                    format!("{}{}", digits, "0".repeat(decimal as usize - digits.len()))
                } else {
                    format!(
                        "{}.{}",
                        &digits[..decimal as usize],
                        &digits[decimal as usize..]
                    )
                }
            } else if decimal <= 0 && decimal > -6 {
                format!("0.{}{}", "0".repeat((-decimal) as usize), digits)
            } else {
                let fraction = if digits.len() > 1 {
                    format!(".{}", &digits[1..])
                } else {
                    String::new()
                };
                format!(
                    "{}{}e{}{exponent}",
                    &digits[..1],
                    fraction,
                    if decimal > 0 { "+" } else { "" },
                    exponent = decimal - 1
                )
            };
            format!("{sign}{body}")
        }
    }
}
