//! Re-reads of reasoning a runner pruned at rest (llm-runner §9.14.1,
//! `archive_prunes_reasoning`).
//!
//! A runner that declares archive pruning may, once a session is archived and
//! idle, empty the reasoning in its stored messages. ck-mc opted in through
//! its Setup answer (`accepts: ["pruned_reasoning"]`), so a re-read of a
//! message it already holds may differ from the held copy. The contract's
//! re-read rule says exactly how: only in the parts the page lists in
//! `pruned_reasoning`, each listed with the SHA-256 the part had when it was
//! written. Identities, ordering, tags and write-time digests never move.
//! Anything else is still a changed transcript and is refused as before.
use super::*;
use cortexkit_role_llm_runner::archive_prunes_reasoning::{kinds, PrunedReasoning};

/// The page's `pruned_reasoning` rows, grouped by message id. A page without
/// the member lists nothing; so does one whose member does not decode, so a
/// malformed list can never make a changed message acceptable.
pub(super) fn listed(page: &Value) -> BTreeMap<String, Vec<PrunedReasoning>> {
    let rows = page
        .get("pruned_reasoning")
        .and_then(|rows| serde_json::from_value::<Vec<PrunedReasoning>>(rows.clone()).ok())
        .unwrap_or_default();
    let mut by_mid: BTreeMap<String, Vec<PrunedReasoning>> = BTreeMap::new();
    for row in rows {
        by_mid.entry(row.mid.clone()).or_default().push(row);
    }
    by_mid
}

/// Where a message's top-level parts live, in the order `parts` looks for
/// them: the whole `content` string of an Anthropic message that has no
/// block array, then `parts`, `content` or `message.content` arrays.
fn parts_pointer(message: &Value) -> Option<(&'static str, bool)> {
    if message.get("parts").is_none() && message.get("content").is_some_and(Value::is_string) {
        return Some(("/content", true));
    }
    ["/parts", "/content", "/message/content"]
        .into_iter()
        .find(|pointer| message.pointer(pointer).is_some_and(Value::is_array))
        .map(|pointer| (pointer, false))
}

/// Whether `fresh`, a re-read of the held message `held`, differs from it
/// only as the contract's re-read rule allows: every member but the message
/// body is unchanged, every part the page does not list in `listed` is
/// byte-identical, a listed part keeps its index, key and type, its kind is
/// one the contract defines, and its listed SHA-256 equals the part's
/// write-time digest. A part of an unknown kind is not trusted, so a message
/// with one is refused like any other change.
pub(super) fn accepts(held: &ReadMessage, fresh: &ReadMessage, listed: &[PrunedReasoning]) -> bool {
    if listed.is_empty()
        || held.ordinal != fresh.ordinal
        || held.mid != fresh.mid
        || held.digest != fresh.digest
        || held.part_digests != fresh.part_digests
        || held.tags != fresh.tags
        || held.role != fresh.role
        || held.written_at != fresh.written_at
        || held.delivered_as != fresh.delivered_as
    {
        return false;
    }
    let (Some((pointer, whole)), Some((held_pointer, held_whole))) =
        (parts_pointer(&fresh.message), parts_pointer(&held.message))
    else {
        return false;
    };
    if (pointer, whole) != (held_pointer, held_whole) {
        return false;
    }
    let mut candidate = fresh.message.clone();
    for row in listed {
        if row.mid != fresh.mid || !kinds::ALL.contains(&row.kind.as_str()) {
            return false;
        }
        let Some(index) = fresh.tags.iter().position(|tag| tag.part == row.part) else {
            return false;
        };
        match served_part_digest(held, &row.part) {
            Ok(digest) if digest == row.sha256 => {}
            _ => return false,
        }
        let (Some(served), Some(original)) = (
            part_at(&fresh.message, pointer, whole, index),
            part_at(&held.message, pointer, whole, index),
        ) else {
            return false;
        };
        if served.get("type") != original.get("type") {
            return false;
        }
        // Put the held part back where the pruned one is served: if the
        // result is the held message, nothing else changed.
        let original = original.clone();
        match candidate.pointer_mut(pointer) {
            Some(slot) if whole => *slot = original,
            Some(Value::Array(parts)) if index < parts.len() => parts[index] = original,
            _ => return false,
        }
    }
    candidate == held.message
}

fn part_at<'a>(message: &'a Value, pointer: &str, whole: bool, index: usize) -> Option<&'a Value> {
    let parts = message.pointer(pointer)?;
    if whole {
        return (index == 0).then_some(parts);
    }
    parts.as_array()?.get(index)
}

impl AsyncRecord {
    /// Hold `fresh` in place of the held copy of the same message, after
    /// `accepts` allowed it. The stored row is rewritten on the next save.
    /// Everything this record derived from the held bytes is dropped so it is
    /// derived again from the new ones, and the next engine pass runs once as
    /// a rebuild: the runner's next request carries the pruned parts, so its
    /// prompt cache is written again from the changed message onward anyway.
    pub(super) fn accept_pruned_reread(
        &mut self,
        fresh: &ReadMessage,
        pruned_parts: usize,
    ) -> Result<(), HandlerOutcome> {
        let held = HeldEntry::from_read(fresh)?;
        #[cfg(test)]
        let held = held.counted_as(self.reference());
        self.entries.insert(fresh.ordinal, Arc::new(held));
        self.journal.replaced.insert(fresh.ordinal);
        self.logical_prefix = None;
        self.prefix_input_proof = None;
        self.cut_signature = None;
        self.reminder_hint_state = None;
        self.aggregates = self.base_aggregates();
        self.entry_bytes = (None, 0);
        self.pruned_rebuild_pending = true;
        tracing::info!(
            session_ref = %self.reference(),
            ordinal = fresh.ordinal,
            mid = %fresh.mid,
            pruned_parts,
            "async re-read accepted reasoning the runner pruned at rest; the next engine pass rebuilds"
        );
        Ok(())
    }
}
