//! A native hook replaces only the covered original prefix, not the full working
//! range. Keep its new head separate from original tail parts the hook leaves behind.
use super::*;
use compact::view::{NativeEndpoint, RetainedPart, ViewRef};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct CutReplacement {
    pub(super) reference: ViewRef,
    pub(super) bytes: String,
}

fn unrepresentable() -> HandlerOutcome {
    error(
        "native_hook_cut_unrepresentable",
        "native hook cannot install the head while retaining this original tail unchanged",
    )
}

fn native_identity(message: &ck_wire::CkWireMessage) -> Option<(&str, u64)> {
    let provenance = message.provider_extras.get(codec_claude_code::EXTRAS)?;
    Some((
        provenance.get("mid")?.as_str()?,
        provenance.get("ordinal")?.as_u64()?,
    ))
}

pub(super) fn attach(
    key: &Key,
    host: &mut compaction::HostView,
    request: &TransformRequest,
) -> Result<(), HandlerOutcome> {
    let coverage = host.coverage.as_ref().ok_or_else(unrepresentable)?;
    let endpoint = coverage.endpoint.as_ref().ok_or_else(unrepresentable)?;
    let boundary = request
        .messages
        .iter()
        .find(|entry| entry.mid == endpoint.message_id && entry.ordinal == coverage.ordinal)
        .ok_or_else(unrepresentable)?;
    if boundary
        .ck
        .content
        .len()
        .checked_sub(1)
        .map(|part| part as u64)
        != Some(endpoint.part_index)
    {
        return Err(unrepresentable());
    }
    let raw = host.raw_replacement.as_ref().ok_or_else(unrepresentable)?;
    if raw.len() != host.engine.replacement.len() {
        return Err(unrepresentable());
    }
    let head_count = host
        .engine
        .replacement
        .iter()
        .take_while(|message| native_identity(message).is_none())
        .count();
    if host.engine.replacement[..head_count]
        .iter()
        .any(|message| !message.meta.synthetic)
    {
        return Err(unrepresentable());
    }
    // An unfolded head covers the first user message by carrying it verbatim.
    // That copy belongs to the installed cut prefix, not the retained tail.
    let mut cut_count = head_count;
    if let Some(message) = host.engine.replacement.get(cut_count) {
        if native_identity(message) == Some((endpoint.message_id.as_str(), coverage.ordinal)) {
            if message.role != "user" || raw[cut_count] != codec_claude_code::render(&boundary.ck)?
            {
                return Err(unrepresentable());
            }
            cut_count += 1;
        }
    }
    let originals = request
        .messages
        .iter()
        .filter(|entry| entry.ordinal > coverage.ordinal && entry.ordinal < host.engine.range.to)
        .collect::<Vec<_>>();
    let tail = &host.engine.replacement[cut_count..];
    if tail.len() != originals.len() {
        return Err(unrepresentable());
    }
    let mut retained = Vec::new();
    for ((message, source), bytes) in tail.iter().zip(originals).zip(&raw[cut_count..]) {
        if native_identity(message) != Some((source.mid.as_str(), source.ordinal))
            || message.content.len() != source.ck.content.len()
            || bytes != &codec_claude_code::render(&source.ck)?
        {
            return Err(unrepresentable());
        }
        for part in 0..source.ck.content.len() {
            retained.push(RetainedPart {
                endpoint: NativeEndpoint {
                    message_id: source.mid.clone(),
                    part_index: part as u64,
                },
                engine_handle: format!("{}#{part}", source.mid),
            });
        }
    }
    let bytes = format!("[{}]", raw[..cut_count].join(","));
    host.cut_replacement = Some(CutReplacement {
        reference: super::native_view::identity(key, &host.engine, "cut", &bytes),
        bytes,
    });
    refresh(key, host, Some(retained))?;
    validate(key, host)
}

pub(super) fn refresh(
    key: &Key,
    host: &mut compaction::HostView,
    retained: Option<Vec<RetainedPart>>,
) -> Result<(), HandlerOutcome> {
    if let Some(cut) = &mut host.cut_replacement {
        let frozen = host.wire.raw_view.as_mut().ok_or_else(unrepresentable)?;
        cut.reference = super::native_view::identity(key, &host.engine, "cut", &cut.bytes);
        frozen.cut_replacement_ref = Some(cut.reference.clone());
        frozen.retained_tail = Some(retained.ok_or_else(unrepresentable)?);
    } else if retained.is_some() {
        return Err(unrepresentable());
    }
    Ok(())
}

pub(super) fn validate(key: &Key, host: &compaction::HostView) -> Result<(), HandlerOutcome> {
    let frozen = host.wire.raw_view.as_ref().ok_or_else(unrepresentable)?;
    let Some(cut) = &host.cut_replacement else {
        return if frozen.cut_replacement_ref.is_none() && frozen.retained_tail.is_none() {
            Ok(())
        } else {
            Err(unrepresentable())
        };
    };
    if frozen.cut_replacement_ref.as_ref() != Some(&cut.reference)
        || cut.reference != super::native_view::identity(key, &host.engine, "cut", &cut.bytes)
        || cut.reference.view_id == frozen.view.view_id
    {
        return Err(unrepresentable());
    }
    cut.reference
        .check_bytes(cut.bytes.as_bytes())
        .map_err(|_| unrepresentable())?;
    let head: Vec<Value> = serde_json::from_str(&cut.bytes).map_err(|_| unrepresentable())?;
    let raw = host.raw_replacement.as_ref().ok_or_else(unrepresentable)?;
    let count = head.len();
    if count > raw.len() || cut.bytes != format!("[{}]", raw[..count].join(",")) {
        return Err(unrepresentable());
    }
    if host.engine.replacement.len() != raw.len()
        || host.engine.replacement[..count]
            .iter()
            .enumerate()
            .any(|(index, message)| match native_identity(message) {
                None => !message.meta.synthetic,
                Some((mid, ordinal)) => {
                    index + 1 != count
                        || message.role != "user"
                        || host.coverage.as_ref().is_none_or(|coverage| {
                            coverage.ordinal != ordinal || coverage.end_mid != mid
                        })
                        || frozen.endpoint.message_id != mid
                        || message.content.len().checked_sub(1).map(|part| part as u64)
                            != Some(frozen.endpoint.part_index)
                }
            })
    {
        return Err(unrepresentable());
    }
    let expected = host.engine.replacement[count..]
        .iter()
        .map(|message| {
            let (mid, _) = native_identity(message).ok_or_else(unrepresentable)?;
            Ok((0..message.content.len())
                .map(|part| RetainedPart {
                    endpoint: NativeEndpoint {
                        message_id: mid.into(),
                        part_index: part as u64,
                    },
                    engine_handle: format!("{mid}#{part}"),
                })
                .collect::<Vec<_>>())
        })
        .collect::<Result<Vec<_>, HandlerOutcome>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if frozen.retained_tail.as_ref() != Some(&expected) {
        return Err(unrepresentable());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const TAIL: &str = r#"{ "role":"user", "content":[{"type":"tool_result","tool_use_id":"call","content":[{"type":"text","text":"child one"},{"type":"text","text":"child two"}]},{"type":"text","text":"retained\u0021"}] }"#;

    fn fixture(with_tail: bool) -> (Key, TransformRequest, compaction::HostView) {
        let key = Key {
            project: PathBuf::from("/project"),
            session: "main".into(),
            harness: "claude-code".into(),
            generation: Some(mc_store::provider_records::ProviderGeneration {
                profile: "format".into(),
                provider: "provider".into(),
            }),
        };
        let mut entries = vec![("covered", r#"{"role":"user","content":"history"}"#)];
        if with_tail {
            entries.push(("call",r#"{"role":"assistant","content":[{"type":"tool_use","id":"call","name":"read","input":{}},{"type":"future","opaque":"untouched"}]}"#));
            entries.push(("tail", TAIL));
        }
        let messages = entries
            .iter()
            .enumerate()
            .map(|(ordinal, (mid, raw))| compact::status::StatusMessage {
                mid: (*mid).into(),
                ordinal: ordinal as u64,
                message: codec_claude_code::from_wire(
                    &serde_json::from_str(raw).unwrap(),
                    Some(raw),
                )
                .unwrap(),
                raw_message: None,
            })
            .collect::<Vec<_>>();
        let mut request:TransformRequest=decode(&json!({"v":2,"kind":"compaction.step","serializer_profile":"claude-code-anthropic","session_id":"main","render_config":"","messages":[],"tool_present":false,"auto_search_enabled":false})).unwrap();
        codec::Codec::ClaudeCodeAnthropic
            .prepare_request(&mut request, &messages)
            .unwrap();
        let mut replacement = (0..3)
            .map(|index| ck_wire::CkWireMessage::synthetic_user_text(format!("head-{index}")))
            .collect::<Vec<_>>();
        replacement.extend(
            request
                .messages
                .iter()
                .skip(1)
                .map(|entry| entry.ck.clone()),
        );
        let engine = transform::compaction::View {
            compaction_id: "compaction".into(),
            version: 5,
            range: transform::compaction::Range {
                lineage_id: "L".into(),
                from: 0,
                to: messages.len() as u64,
            },
            replacement,
        };
        let (mut wire, raw) = codec_claude_code::encode_view(&engine, &request, Some(0)).unwrap();
        let endpoint = NativeEndpoint {
            message_id: "covered".into(),
            part_index: 0,
        };
        wire.raw_view = Some(Box::new(
            super::super::native_view::freeze(&key, &engine, Some(&endpoint), &raw).unwrap(),
        ));
        let host = compaction::HostView {
            engine,
            wire,
            coverage: Some(compaction::HostCoverage {
                end_mid: "covered".into(),
                ordinal: 0,
                endpoint: Some(endpoint),
            }),
            raw_replacement: Some(raw),
            head_slots: None,
            cut_replacement: None,
        };
        (key, request, host)
    }

    #[test]
    fn hook_cut_head_excludes_retained_parts_and_nested_children_keep_top_level_handles() {
        let (key, request, mut host) = fixture(true);
        attach(&key, &mut host, &request).unwrap();
        let frozen = host.wire.raw_view.as_ref().unwrap();
        let cut = host.cut_replacement.as_ref().unwrap();
        assert_eq!(
            serde_json::from_str::<Vec<Value>>(&cut.bytes)
                .unwrap()
                .len(),
            3
        );
        assert!(!cut.bytes.contains("retained"));
        assert_ne!(cut.reference, frozen.view);
        assert_eq!(frozen.cut_replacement_ref.as_ref(), Some(&cut.reference));
        assert_eq!(
            frozen.retained_tail.as_ref().unwrap(),
            &vec![
                RetainedPart {
                    endpoint: NativeEndpoint {
                        message_id: "call".into(),
                        part_index: 0
                    },
                    engine_handle: "call#0".into()
                },
                RetainedPart {
                    endpoint: NativeEndpoint {
                        message_id: "call".into(),
                        part_index: 1
                    },
                    engine_handle: "call#1".into()
                },
                RetainedPart {
                    endpoint: NativeEndpoint {
                        message_id: "tail".into(),
                        part_index: 0
                    },
                    engine_handle: "tail#0".into()
                },
                RetainedPart {
                    endpoint: NativeEndpoint {
                        message_id: "tail".into(),
                        part_index: 1
                    },
                    engine_handle: "tail#1".into()
                },
            ]
        );
        let full = host.raw_replacement.as_ref().unwrap();
        assert_eq!(full.last().unwrap(), TAIL);
        assert_eq!(
            format!(
                "[{},{}]",
                cut.bytes
                    .strip_prefix('[')
                    .unwrap()
                    .strip_suffix(']')
                    .unwrap(),
                full[3..].join(",")
            ),
            format!("[{}]", full.join(","))
        );
        super::super::native_view::validate(&key, &host).unwrap();
    }

    #[test]
    fn hook_cut_all_history_has_explicit_empty_tail_and_replay_references_are_version_scoped() {
        let (key, request, mut host) = fixture(false);
        attach(&key, &mut host, &request).unwrap();
        let full = host.wire.raw_view.as_ref().unwrap();
        assert_eq!(full.retained_tail, Some(vec![]));
        assert_ne!(
            full.view.view_id,
            host.cut_replacement.as_ref().unwrap().reference.view_id
        );
        let previous = host.cut_replacement.as_ref().unwrap().clone();
        host.engine.version += 1;
        host.wire.version += 1;
        let retained = host.wire.raw_view.as_ref().unwrap().retained_tail.clone();
        host.wire.raw_view = Some(Box::new(
            super::super::native_view::freeze(
                &key,
                &host.engine,
                host.coverage.as_ref().unwrap().endpoint.as_ref(),
                host.raw_replacement.as_deref().unwrap(),
            )
            .unwrap(),
        ));
        refresh(&key, &mut host, retained).unwrap();
        let current = host.cut_replacement.as_ref().unwrap();
        assert_eq!(previous.bytes, current.bytes);
        assert_eq!(previous.reference.sha256, current.reference.sha256);
        assert_ne!(previous.reference.view_id, current.reference.view_id);
        super::super::native_view::validate(&key, &host).unwrap();
    }

    #[test]
    fn hook_cut_changed_or_removed_native_tail_refuses_without_snapping() {
        let (key, request, mut host) = fixture(true);
        host.raw_replacement
            .as_mut()
            .unwrap()
            .last_mut()
            .unwrap()
            .push(' ');
        assert!(
            matches!(attach(&key,&mut host,&request),Err(HandlerOutcome::Error {code,..}) if code=="native_hook_cut_unrepresentable")
        );
        let (key, request, mut host) = fixture(true);
        host.engine.replacement.pop();
        host.raw_replacement.as_mut().unwrap().pop();
        assert!(attach(&key, &mut host, &request).is_err());
        let (key, request, mut host) = fixture(true);
        host.coverage
            .as_mut()
            .unwrap()
            .endpoint
            .as_mut()
            .unwrap()
            .part_index = 1;
        assert!(attach(&key, &mut host, &request).is_err());
    }
}
