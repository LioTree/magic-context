//! Pi provider ingress shares the journal codec with full native transforms.
use super::*;

pub(super) fn decode_messages(
    messages: &[compact::status::StatusMessage],
) -> Result<crate::codec::DecodedHarnessMessages, HandlerOutcome> {
    for message in messages {
        if message.message.get("id").and_then(Value::as_str) != Some(message.mid.as_str())
            || !matches!(
                message
                    .message
                    .pointer("/message/role")
                    .and_then(Value::as_str),
                Some("user" | "assistant" | "toolResult")
            )
        {
            return Err(error(
                "history_unreadable",
                "Pi provider requires stable message entries",
            ));
        }
    }
    let native: Vec<_> = messages.iter().map(|m| m.message.clone()).collect();
    // Provider IDs are journal IDs. Timestamp/response aliases used by full
    // native transforms must not replace the relay's already-frozen identity.
    let mut pins = crate::codec::DecodeSidecar::new("pi");
    for message in messages {
        pins.mid_pins
            .insert(message.mid.clone(), message.mid.clone());
    }
    let mut decoded = crate::codec::decode_pi_with_sidecar(&native, Some(&pins));
    if decoded.messages.len() != messages.len() {
        return Err(error(
            "history_unreadable",
            "Pi entry did not decode to one message",
        ));
    }
    for (decoded, source) in decoded.messages.iter_mut().zip(messages) {
        decoded.mid = source.mid.clone();
        decoded.ordinal = source.ordinal;
        decoded.ck.meta.harness_id = Some(source.mid.clone());
        decoded.ck.meta.ordinal = Some(source.ordinal);
    }
    Ok(decoded)
}

pub(super) fn encode_view(
    view: &transform::compaction::View,
    request: &TransformRequest,
) -> Result<compact::answer::CompactionMessage, HandlerOutcome> {
    let native = request
        .native_messages
        .as_deref()
        .ok_or_else(|| error("history_unreadable", "Pi view requires native ingress"))?;
    let source = native
        .iter()
        .zip(&request.messages)
        .map(|(message, ingress)| compact::status::StatusMessage {
            raw_message: None,
            mid: ingress.mid.clone(),
            ordinal: ingress.ordinal,
            message: message.clone(),
        })
        .collect::<Vec<_>>();
    let sidecar = decode_messages(&source)?.sidecar;
    Ok(compact::answer::CompactionMessage::new(
        &view.compaction_id,
        view.version,
        compact::answer::Range::new(view.range.from, view.range.to),
        crate::codec::encode_pi(&view.replacement, &sidecar),
    ))
}

/// Pi stores tool results separately from their assistant's calls. Read the
/// actual preceding assistant and intervening results (at most 64 prior rows)
/// so tool-pair validation never invents a missing call.
pub(super) fn decode_hook_messages(
    store: &McStore,
    key: &Key,
    lineage: &str,
    entry: compact::status::StatusMessage,
) -> Result<crate::codec::DecodedHarnessMessages, HandlerOutcome> {
    let mut entries = Vec::new();
    if entry
        .message
        .pointer("/message/role")
        .and_then(Value::as_str)
        == Some("toolResult")
    {
        let prior = store
            .load_provider_messages_page(
                &key.store_key(),
                lineage,
                entry.ordinal.saturating_sub(64),
                entry.ordinal.saturating_sub(1),
                64,
            )
            .map_err(transient)?;
        for source in prior {
            let message: Value =
                serde_json::from_slice(&source.message_bytes).map_err(transient)?;
            if message.pointer("/message/role").and_then(Value::as_str) == Some("assistant") {
                entries.clear();
            }
            entries.push(compact::status::StatusMessage {
                raw_message: None,
                mid: source.mid,
                ordinal: source.ordinal,
                message,
            });
        }
    }
    entries.push(entry);
    decode_messages(&entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_identity_beats_repeated_timestamp_and_response_aliases() {
        let entries: Vec<_> = ["entry-a", "entry-b"].into_iter().enumerate().map(|(i, id)| compact::status::StatusMessage {
            raw_message: None, mid: id.into(), ordinal: 41 + i as u64,
            message: json!({"id":id,"type":"message","parentId":null,"message":{"role":"assistant","timestamp":1,"responseId":"same-response","content":[{"type":"text","text":id,"textSignature":"sig"}]}}),
        }).collect();
        let decoded = decode_messages(&entries).unwrap();
        for (actual, expected) in decoded.messages.iter().zip(&entries) {
            assert_eq!(actual.mid, expected.mid);
            assert_eq!(actual.ordinal, expected.ordinal);
            assert_eq!(
                decoded.sidecar.messages[&expected.mid].raw,
                expected.message
            );
        }
        let ck: Vec<_> = decoded.messages.into_iter().map(|m| m.ck).collect();
        assert_eq!(
            crate::codec::encode_pi(&ck, &decoded.sidecar),
            entries.into_iter().map(|e| e.message).collect::<Vec<_>>()
        );
    }

    #[test]
    fn mismatched_or_missing_journal_identity_refuses() {
        for native in [
            json!({"id":"wrong","message":{"role":"user","content":"text"}}),
            json!({"role":"user","content":"text"}),
        ] {
            assert!(decode_messages(&[compact::status::StatusMessage {
                raw_message: None,
                mid: "expected".into(),
                ordinal: 1,
                message: native
            }])
            .is_err());
        }
    }
}
