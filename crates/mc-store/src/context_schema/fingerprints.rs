//! Schema-only fingerprints include virtual/shadow tables, constraints, and migration identities.

use rusqlite::{types::ValueRef, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TableSnapshot {
    pub name: String,
    pub columns: Vec<Vec<Value>>,
    pub indexes: Vec<Vec<Value>>,
    pub foreign_keys: Vec<Vec<Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SchemaSnapshot {
    pub user_version: i64,
    pub migrations: Vec<Vec<Value>>,
    pub master: Vec<Vec<Value>>,
    pub tables: Vec<TableSnapshot>,
}

/// Collapse formatting whitespace without changing quoted identifiers or string literals.
fn normalize_sql(sql: &str) -> String {
    let mut result = String::new();
    let mut chars = sql.chars().peekable();
    let mut quote = None;
    let mut space = false;
    while let Some(ch) = chars.next() {
        if let Some(end) = quote {
            result.push(ch);
            if ch == end {
                if end != ']' && chars.peek() == Some(&end) {
                    result.push(chars.next().expect("peeked character"));
                } else {
                    quote = None;
                }
            }
        } else if ch.is_whitespace() {
            space = true;
        } else {
            if space && !result.is_empty() {
                result.push(' ');
            }
            space = false;
            result.push(ch);
            quote = match ch {
                '\'' | '"' | '`' => Some(ch),
                '[' => Some(']'),
                _ => None,
            };
        }
    }
    result
}

fn rows(connection: &Connection, sql: &str) -> rusqlite::Result<Vec<Vec<Value>>> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map([], |row| {
        (0..row.as_ref().column_count())
            .map(|column| {
                Ok(match row.get_ref(column)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(value) => Value::from(value),
                    ValueRef::Real(value) => Value::from(value),
                    ValueRef::Text(value) => Value::from(String::from_utf8_lossy(value).as_ref()),
                    ValueRef::Blob(_) => return Err(rusqlite::Error::InvalidQuery),
                })
            })
            .collect()
    })?;
    rows.collect()
}

pub fn schema_snapshot(connection: &Connection) -> rusqlite::Result<SchemaSnapshot> {
    let mut master = rows(
        connection,
        "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
    )?;
    let mut tables = Vec::new();
    for object in &mut master {
        if let Some(sql) = object[3].as_str() {
            object[3] = Value::from(normalize_sql(sql));
        }
        if object[0] != "table" {
            continue;
        }
        let name = object[1].as_str().ok_or(rusqlite::Error::InvalidQuery)?;
        let quoted = format!("'{}'", name.replace('\'', "''"));
        // Index-list sequence numbers are creation order, not schema semantics.
        let mut indexes = rows(connection, &format!("PRAGMA index_list({quoted})"))?
            .into_iter()
            .map(|row| row.into_iter().skip(1).collect::<Vec<_>>())
            .collect::<Vec<_>>();
        indexes.sort_by(|a, b| a[0].as_str().cmp(&b[0].as_str()));
        tables.push(TableSnapshot {
            name: name.to_owned(),
            columns: rows(connection, &format!("PRAGMA table_info({quoted})"))?,
            indexes,
            foreign_keys: rows(connection, &format!("PRAGMA foreign_key_list({quoted})"))?,
        });
    }
    Ok(SchemaSnapshot {
        user_version: connection.query_row("PRAGMA user_version", [], |row| row.get(0))?,
        // Exclude applied_at because migration application times differ on every run.
        migrations: rows(
            connection,
            "SELECT version, description FROM schema_migrations ORDER BY version",
        )?,
        master,
        tables,
    })
}

/// Serialize through a JSON value so object keys have canonical ordering.
pub fn fingerprint(snapshot: &SchemaSnapshot) -> String {
    let mut canonical =
        serde_json::to_value(snapshot).expect("schema snapshot is JSON serializable");
    canonical.sort_all_objects();
    let encoded = serde_json::to_vec(&canonical).expect("schema JSON is serializable");
    format!("{:x}", Sha256::digest(encoded))
}
