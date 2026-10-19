//! Todo state for runner-lane conversations, read from the transcript.
//!
//! A host bridge reports the native `todowrite` result to ck-mc with the
//! management op `todo_state.set`. A runner sends no such op: its transcript
//! already holds the `todowrite` call and the tool's result, so ck-mc reads
//! them there. A call counts only once its result shows the tool ran: a call
//! with no result yet is held until the result arrives, and an error or denied
//! result never changes the state. The state written is byte-identical to what
//! `todo_state.set` writes for the same todos and owning message, so the
//! synthetic todo pair built from it is identical as well.
use super::*;
use mc_store::{CkKind, CkOutputKind};

/// The native tool whose calls carry todo state. Exact match, as the host
/// bridges require: a lookalike such as `mcp_Todowrite` is not the native tool.
const TODO_TOOL_NAME: &str = "todowrite";

/// A `todowrite` call still waiting for its result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct PendingTodo {
    pub owner_message_id: String,
    pub state_json: String,
}

/// The scan cursor kept in the runner record, so each step reads only the
/// messages it has not seen.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct TodoScan {
    pub lineage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub through: Option<u64>,
    /// Calls by tool-call id whose result has not been seen yet.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub pending: BTreeMap<String, PendingTodo>,
}

/// The todo state to record, in the exact form `todo_state.set` stores it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DerivedTodo {
    pub state_json: String,
    pub owner_message_id: String,
    pub state_hash: String,
}

impl DerivedTodo {
    fn new(pending: PendingTodo) -> Self {
        Self {
            state_hash: sha256_hex(pending.state_json.as_bytes()),
            state_json: pending.state_json,
            owner_message_id: pending.owner_message_id,
        }
    }
}

/// True for a result that shows the tool ran and returned normally.
fn result_succeeded(output: &CkOutputKind) -> bool {
    matches!(
        output,
        CkOutputKind::Text { .. } | CkOutputKind::Json { .. } | CkOutputKind::Content { .. }
    )
}

impl TodoScan {
    /// Read `messages` (one lineage, ascending ordinals) past the cursor and
    /// return the newest todo state whose call has a successful result.
    /// Messages at or before the cursor are skipped, so a repeated step is a no-op.
    pub fn advance<'a>(
        &mut self,
        lineage: &str,
        messages: impl IntoIterator<Item = &'a ck_wire::CkIngressMessage>,
    ) -> Option<DerivedTodo> {
        if self.lineage != lineage {
            // A new lineage has its own ordinals; restart there. Durable todo
            // state already recorded for the session is unaffected.
            *self = Self {
                lineage: lineage.to_string(),
                ..Self::default()
            };
        }
        let mut latest = None;
        for message in messages {
            if self
                .through
                .is_some_and(|through| message.ordinal <= through)
            {
                continue;
            }
            self.through = Some(message.ordinal);
            for block in &message.ck.content {
                match &block.kind {
                    CkKind::ToolCall {
                        id, name, input, ..
                    } if name == TODO_TOOL_NAME => {
                        if let Some(state_json) = crate::injection::todo_state_from_input(input) {
                            self.pending.insert(
                                id.clone(),
                                PendingTodo {
                                    owner_message_id: message.mid.clone(),
                                    state_json,
                                },
                            );
                        }
                    }
                    CkKind::ToolResult { id, output, .. } => {
                        if let Some(call) = self.pending.remove(id) {
                            if result_succeeded(&output.kind) {
                                latest = Some(call);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        latest.map(DerivedTodo::new)
    }
}

/// Decode `entries` (one lineage, ascending ordinals) with the runner lane's
/// codec and advance `scan` over them.
pub(crate) fn scan_status_messages<'a>(
    scan: &mut TodoScan,
    lineage: &str,
    entries: impl IntoIterator<Item = &'a codec::InboundMessage>,
) -> Result<Option<DerivedTodo>, HandlerOutcome> {
    let decoded = entries
        .into_iter()
        .map(|entry| codec::Codec::OwnedBroca.decode_message(entry))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(scan.advance(lineage, &decoded))
}

/// Decode the record's messages after the scan cursor and record a newer
/// todo state in the conversation's engine namespace.
pub(super) fn record_from_transcript(
    store: &McStore,
    key: &Key,
    record: &mut Record,
    lineage: &str,
) -> Result<Option<DerivedTodo>, HandlerOutcome> {
    // Advance a copy and commit it only after the state is written, so a
    // failed write is retried on the next step instead of being skipped.
    let mut scan = record.todo_scan.clone().unwrap_or_default();
    let after = if scan.lineage == lineage {
        scan.through
    } else {
        None
    };
    let entries = record
        .messages
        .get(lineage)
        .into_iter()
        .flat_map(|entries| entries.range(after.map_or(0, |a| a.saturating_add(1))..))
        .map(|(_, entry)| entry);
    let derived = scan_status_messages(&mut scan, lineage, entries)?;
    let Some(derived) = derived else {
        record.todo_scan = Some(scan);
        return Ok(None);
    };
    // The same namespace the record saves its engine state to.
    let namespace = store
        .load_provider_conversation(&key.store_key())
        .map_err(transient)?
        .map_or_else(
            || key.engine_key(),
            |conversation| conversation.engine_namespace,
        );
    store
        .set_todo_state(
            &namespace,
            &derived.state_json,
            &derived.owner_message_id,
            &derived.state_hash,
        )
        .map_err(transient)?;
    record.todo_scan = Some(scan);
    Ok(Some(derived))
}

#[cfg(test)]
#[path = "runner_todo_tests.rs"]
mod tests;
