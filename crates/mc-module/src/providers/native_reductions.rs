//! Map reductions onto native shells before freezing a Claude Code replacement.
use super::*;
use ck_wire::{CkKind, CkWireBlock, CkWireMessage};

fn identity(message: &CkWireMessage) -> Option<(&str, u64)> {
    let extras = message.provider_extras.get(codec_claude_code::EXTRAS)?;
    Some((
        extras.get("mid")?.as_str()?,
        extras.get("ordinal")?.as_u64()?,
    ))
}

fn thinking(block: &CkWireBlock) -> bool {
    codec_claude_code::is_thinking_block(block)
}

fn placeholder(mid: &str, part: usize, tags: &BTreeMap<String, i64>) -> Option<String> {
    tags.get(&format!("{mid}#{part}"))
        .map(|n| format!("[dropped §{n}§]"))
}

fn result_drop(source: &CkWireBlock, text: Option<String>) -> CkWireBlock {
    if let Some(text) = text {
        ck_wire::reduced_block(source, &text)
    } else {
        tracing::debug!("native reduction held: dropped result has no display tag");
        source.clone()
    }
}

fn restore_arc(index: usize, slots: &mut [Option<CkWireMessage>], request: &TransformRequest) {
    slots[index] = Some(request.messages[index].ck.clone());
    for block in &request.messages[index].ck.content {
        if let CkKind::ToolCall { id, .. } | CkKind::ToolResult { id, .. } = &block.kind {
            for (other, entry) in request.messages.iter().enumerate() {
                if entry.ck.content.iter().any(|b| matches!(&b.kind,
                    CkKind::ToolCall { id: candidate, .. } | CkKind::ToolResult { id: candidate, .. } if candidate == id))
                {
                    // Reinstate any deleted call/result message with all original
                    // blocks. Surviving results keep their placeholder content.
                    if slots[other].is_none() {
                        slots[other] = Some(entry.ck.clone());
                    }
                }
            }
        }
    }
}

/// Apply edits alongside a fold/flush or an execute/force opportunity that can
/// replace queued tool results. The returned ordinal is the last summarized or
/// changed original message for validating signed-thinking edits, not the full replacement
/// range. Keep it separate from both the wire removal endpoint and the engine's
/// summary boundary so unsummarized messages never become summarized history.
pub(super) fn apply(
    view: &mut transform::compaction::View,
    request: &TransformRequest,
    folded: Option<u64>,
    rebuild: bool,
    protected: &[String],
    tags: &BTreeMap<String, i64>,
    pending: &BTreeSet<String>,
) -> Option<u64> {
    // Do not repair unknown or duplicated gateway message IDs and ordinals.
    // The encoder must reject those; only valid reduction decisions are mapped.
    let input_ids = request
        .messages
        .iter()
        .map(|m| (m.mid.as_str(), m.ordinal))
        .collect::<BTreeSet<_>>();
    let mut seen = BTreeSet::new();
    if view.replacement.iter().any(|m| {
        m.provider_extras.contains_key(codec_claude_code::EXTRAS)
            && identity(m).is_none_or(|id| !input_ids.contains(&id) || !seen.insert(id))
    }) {
        return folded;
    }
    let head = view
        .replacement
        .iter()
        .filter(|m| identity(m).is_none())
        .cloned()
        .collect::<Vec<_>>();
    let candidates = view
        .replacement
        .iter()
        .filter_map(|m| identity(m).map(|id| (id, m)))
        .collect::<BTreeMap<_, _>>();
    let prefix_edit = !head.is_empty()
        || request.messages.iter().any(|entry| {
            candidates
                .get(&(entry.mid.as_str(), entry.ordinal))
                .copied()
                != Some(&entry.ck)
        });
    let mut slots = Vec::with_capacity(request.messages.len());
    let mut removed = BTreeSet::new();
    for (index, entry) in request.messages.iter().enumerate() {
        if folded.is_some_and(|c| entry.ordinal <= c)
            && !candidates.contains_key(&(entry.mid.as_str(), entry.ordinal))
        {
            slots.push(None);
            continue;
        }
        let source = &entry.ck;
        let candidate = candidates
            .get(&(entry.mid.as_str(), entry.ordinal))
            .copied();
        if !rebuild || protected.contains(&entry.mid) {
            if candidate != Some(source) {
                tracing::debug!(
                    mid = entry.mid,
                    rebuild,
                    "native reduction held: first publication or protected turn"
                );
            }
            slots.push(Some(source.clone()));
            continue;
        }
        let mut mapped = source.clone();
        let mut remaining = candidate
            .map(|m| m.content.iter().collect::<Vec<_>>())
            .unwrap_or_default();
        for (part, block) in source.content.iter().enumerate() {
            let provenance = block.provider_extras.get(codec_claude_code::EXTRAS);
            if source
                .content
                .iter()
                .filter(|b| b.provider_extras.get(codec_claude_code::EXTRAS) == provenance)
                .count()
                > 1
            {
                tracing::debug!(
                    mid = entry.mid,
                    part,
                    "native reduction held: indistinguishable block provenance"
                );
                continue;
            }
            if matches!(block.kind, CkKind::ToolResult { .. })
                && pending.contains(&format!("{}#{part}", entry.mid))
            {
                mapped.content[part] = result_drop(block, placeholder(&entry.mid, part, tags));
                continue;
            }
            let edited = remaining
                .iter()
                .position(|b| b.provider_extras.get(codec_claude_code::EXTRAS) == provenance)
                .map(|position| remaining.remove(position));
            mapped.content[part] = match (&block.kind, edited) {
                (CkKind::Text { .. }, Some(edit)) if matches!(edit.kind, CkKind::Text { .. }) => {
                    edit.clone()
                }
                (CkKind::ToolResult { id, .. }, Some(edit))
                    if matches!(&edit.kind, CkKind::ToolResult { id: edited_id, output, .. }
                    if id == edited_id && matches!(output.kind, ck_wire::CkOutputKind::Text { .. } | ck_wire::CkOutputKind::ErrorText { .. })) =>
                {
                    let dropped = matches!(&edit.kind, CkKind::ToolResult { output, .. }
                        if matches!(&output.kind, ck_wire::CkOutputKind::Text { text } | ck_wire::CkOutputKind::ErrorText { text } if text == "[dropped]"));
                    if dropped {
                        result_drop(block, placeholder(&entry.mid, part, tags))
                    } else {
                        edit.clone()
                    }
                }
                (CkKind::ToolResult { .. }, None) => {
                    result_drop(block, placeholder(&entry.mid, part, tags))
                }
                (_, Some(edit)) if edit.kind == block.kind => block.clone(),
                _ => {
                    tracing::debug!(
                        mid = entry.mid,
                        part,
                        "native reduction held: block cannot be edited in its original shell"
                    );
                    block.clone()
                }
            };
        }
        // A permitted prefix rewrite removes every thinking block in the turn.
        // Non-thinking siblings survive; complete single-result arcs may retire.
        if source.content.iter().any(thinking) && prefix_edit {
            mapped.content.retain(|block| !thinking(block));
            mapped
                .provider_extras
                .get_mut(codec_claude_code::EXTRAS)
                .expect("native message")
                .insert("strip_signed_turn".into(), json!(true));
            if mapped.content.is_empty() {
                removed.insert(index);
            }
        }
        if mapped.content.len() == 1
            && matches!(mapped.content[0].kind, CkKind::ToolCall { .. })
            && candidate.is_none_or(|m| {
                !m.content
                    .iter()
                    .any(|b| matches!(b.kind, CkKind::ToolCall { .. }))
            })
        {
            removed.insert(index);
        }
        slots.push(Some(mapped));
    }

    for index in removed {
        let source = &request.messages[index].ck;
        let calls = source
            .content
            .iter()
            .filter_map(|b| match &b.kind {
                CkKind::ToolCall { id, .. } => Some(id),
                _ => None,
            })
            .collect::<Vec<_>>();
        if calls.is_empty() {
            if slots[index].as_ref().is_some_and(|m| m.content.is_empty()) {
                slots[index] = None;
            }
            continue;
        }
        let result_index = index + 1;
        let Some(result) = request.messages.get(result_index) else {
            continue;
        };
        let result_ids = result
            .ck
            .content
            .iter()
            .filter_map(|b| match &b.kind {
                CkKind::ToolResult { id, .. } => Some(id),
                _ => None,
            })
            .collect::<Vec<_>>();
        let signed_turn = source.content.iter().any(thinking);
        if (signed_turn || source.content.len() == 1)
            && result.ck.content.len() == result_ids.len()
            && calls == result_ids
            && !protected.contains(&result.mid)
        {
            let before = slots[..index]
                .iter()
                .rev()
                .flatten()
                .next()
                .or_else(|| head.last());
            let after = slots[result_index + 1..].iter().flatten().next();
            let unsafe_roles = before.zip(after).is_some_and(|(a, b)| {
                (a.role == "assistant" && b.role == "assistant")
                    || (a.role == "system" && b.role != "assistant")
            });
            if !unsafe_roles {
                slots[index] = None;
                slots[result_index] = None;
            } else {
                tracing::debug!(
                    mid = request.messages[index].mid,
                    "native arc removal held: would merge assistants or strand a system message"
                );
            }
        }
    }

    // Tool-result eligibility was computed before the signed thinking strip.
    // Now that no signature remains, queued result drops can share this rewrite
    // without deleting other user blocks in the same result message.
    for index in 0..slots.len().saturating_sub(1) {
        if slots[index]
            .as_ref()
            .is_some_and(codec_claude_code::strips_signed_turn)
        {
            let entry = &request.messages[index + 1];
            if let Some(result) = &mut slots[index + 1] {
                for (part, source) in entry.ck.content.iter().enumerate() {
                    if matches!(source.kind, CkKind::ToolResult { .. })
                        && pending.contains(&format!("{}#{part}", entry.mid))
                    {
                        result.content[part] =
                            result_drop(source, placeholder(&entry.mid, part, tags));
                    }
                }
            }
        }
    }

    // Deletion can bring two assistants together or leave a system message
    // followed by a user. Reinstate the deleted original message and its tool
    // partner rather than inventing a separator that changes the transcript.
    loop {
        let kept = slots
            .iter()
            .enumerate()
            .filter_map(|(i, m)| m.as_ref().map(|m| (i, m)))
            .collect::<Vec<_>>();
        let invalid = kept.windows(2).find_map(|pair| {
            let ((left, a), (right, b)) = (pair[0], pair[1]);
            ((a.role == "assistant" && b.role == "assistant")
                || (a.role == "system" && b.role != "assistant"))
                .then(|| {
                    (left + 1..right).find(|i| {
                        slots[*i].is_none()
                            && folded.is_none_or(|c| request.messages[*i].ordinal > c)
                    })
                })
                .flatten()
        });
        let Some(index) = invalid else { break };
        tracing::debug!(
            mid = request.messages[index].mid,
            "native turn removal held: unsafe role boundary"
        );
        restore_arc(index, &mut slots, request);
    }

    // A surviving thinking signature binds all preceding message bytes.
    // Keep that original prefix, skipping reductions that would edit it. The
    // encoder still rejects a required summary-head edit before kept thinking.
    if let Some(last_signed) = slots
        .iter()
        .rposition(|m| m.as_ref().is_some_and(|m| m.content.iter().any(thinking)))
    {
        for (index, slot) in slots.iter_mut().enumerate().take(last_signed + 1) {
            if folded.is_none_or(|c| request.messages[index].ordinal > c) {
                if slot.as_ref() != Some(&request.messages[index].ck) {
                    tracing::debug!(
                        mid = request.messages[index].mid,
                        "native reduction held: prefix of kept signed thinking"
                    );
                }
                *slot = Some(request.messages[index].ck.clone());
            }
        }
    }
    let mut coverage = folded;
    for (entry, mapped) in request.messages.iter().zip(&slots) {
        if folded.is_none_or(|c| entry.ordinal > c) && mapped.as_ref() != Some(&entry.ck) {
            coverage = Some(coverage.map_or(entry.ordinal, |c| c.max(entry.ordinal)));
        }
    }
    if let Some(index) =
        coverage.and_then(|through| request.messages.iter().position(|m| m.ordinal == through))
    {
        let calls = request.messages[index]
            .ck
            .content
            .iter()
            .filter_map(|b| match &b.kind {
                CkKind::ToolCall { id, .. } => Some(id),
                _ => None,
            })
            .collect::<BTreeSet<_>>();
        if let Some(entry) = request.messages.get(index + 1) {
            if entry
                .ck
                .content
                .iter()
                .any(|b| matches!(&b.kind, CkKind::ToolResult { id, .. } if calls.contains(id)))
            {
                coverage = Some(entry.ordinal);
            }
        }
    }
    view.replacement = head
        .into_iter()
        .chain(slots.into_iter().flatten())
        .collect();
    coverage
}

pub(super) fn pending_applied(
    view: &transform::compaction::View,
    request: &TransformRequest,
    tags: &BTreeMap<String, i64>,
    pending: &BTreeSet<String>,
    previously_applied: Option<&transform::compaction::View>,
) -> bool {
    request.messages.iter().any(|entry| {
        entry.ck.content.iter().enumerate().any(|(part, source)| {
            let CkKind::ToolResult { id, .. } = &source.kind else {
                return false;
            };
            if !pending.contains(&format!("{}#{part}", entry.mid)) {
                return false;
            }
            let Some(text) = placeholder(&entry.mid, part, tags) else {
                return false;
            };
            let applied_in = |view: &transform::compaction::View| {
                if entry.ordinal < view.range.from || entry.ordinal >= view.range.to {
                    return false;
                }
                view.replacement
                .iter()
                .find(|message| identity(message) == Some((&entry.mid, entry.ordinal)))
                .is_none_or(|message| {
                    message.content.iter().any(|block| {
                        block.kind != source.kind
                            && matches!(&block.kind, CkKind::ToolResult { id: kept_id, output, .. }
                                if kept_id == id && matches!(&output.kind,
                                    ck_wire::CkOutputKind::Text { text: kept }
                                    | ck_wire::CkOutputKind::ErrorText { text: kept } if kept == &text))
                    })
                })
            };
            applied_in(view) && previously_applied.is_none_or(|previous| !applied_in(previous))
        })
    })
}
