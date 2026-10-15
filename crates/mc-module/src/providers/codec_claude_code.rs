//! Native Anthropic messages with a validated, byte-preserving provenance sidecar.
use super::*;
use ck_wire::{
    CkKind, CkOutputKind, CkToolOutput, CkWireBlock, CkWireMessage, HarnessMeta, ProviderExtras,
};
use std::ops::Range;

pub(super) const EXTRAS: &str = "mc-claude-code";

// Revisions of the native codec and raw JSON envelope formats, frozen internally
// with each admitted native route/session plan. Public capability advertisement
// remains disabled until the module and host activate support together.
pub(super) const CODEC_FORMAT_EPOCH: u64 = 1;
pub(super) const RAW_PROVENANCE_FORMAT_EPOCH: u64 = 1;

fn invalid_raw(reason: &str) -> HandlerOutcome {
    HandlerOutcome::ErrorWithDetail {
        code: "invalid_params".into(),
        message: reason.into(),
        detail: json!({"field":"raw_message"}),
    }
}

struct UniqueJson(Value);

impl<'de> serde::Deserialize<'de> for UniqueJson {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = UniqueJson;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("JSON with unique object keys")
            }
            fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(UniqueJson(json!(value)))
            }
            fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(UniqueJson(json!(value)))
            }
            fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(UniqueJson(json!(value)))
            }
            fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self::Value, E> {
                serde_json::Number::from_f64(value)
                    .map(|n| UniqueJson(Value::Number(n)))
                    .ok_or_else(|| E::custom("invalid JSON number"))
            }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::String(value.into())))
            }
            fn visit_string<E: serde::de::Error>(self, value: String) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::String(value)))
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(UniqueJson(Value::Null))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = seq.next_element::<UniqueJson>()? {
                    values.push(value.0);
                }
                Ok(UniqueJson(Value::Array(values)))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Self::Value, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    // Decoded names make "text" and "\u0074ext" the same key.
                    // Reject duplicates even in tool inputs and unknown payloads:
                    // choosing one value would let later edits of the raw bytes
                    // disagree with the value read from parsed JSON.
                    if values.contains_key(&key) {
                        return Err(serde::de::Error::custom(
                            "duplicate object key in raw_message",
                        ));
                    }
                    values.insert(key, map.next_value::<UniqueJson>()?.0);
                }
                Ok(UniqueJson(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}

fn parse_unique_json(raw: &str) -> Result<Value, HandlerOutcome> {
    serde_json::from_str::<UniqueJson>(raw)
        .map(|parsed| parsed.0)
        .map_err(|_| invalid_raw("raw_message must be valid JSON with no duplicate object keys"))
}

/// Only Anthropic transport locations are inspected; tool inputs and opaque data
/// may legitimately contain a user-authored member named `cache_control`.
fn has_marker(message: &Value) -> bool {
    message["content"].as_array().is_some_and(|blocks| {
        blocks.iter().any(|block| {
            (transport_block(block, false) && block.get("cache_control").is_some())
                || (block["type"] == "tool_result"
                    && block["content"].as_array().is_some_and(|children| {
                        children.iter().any(|child| {
                            transport_block(child, true) && child.get("cache_control").is_some()
                        })
                    }))
        })
    })
}
fn transport_block(block: &Value, nested: bool) -> bool {
    matches!(block["type"].as_str(), Some("text" | "image" | "document"))
        || (!nested
            && matches!(
                block["type"].as_str(),
                Some("thinking" | "redacted_thinking" | "tool_use" | "tool_result")
            ))
}

/// Only a scalar and a singleton, unadorned text block can differ in form.
/// All message fields outside content must still match, including the role.
fn text_form_flip(left: &Value, right: &Value) -> bool {
    let Some((left, right)) = left.as_object().zip(right.as_object()) else {
        return false;
    };
    let text_block = |value: &Value| {
        let blocks = value.as_array()?;
        let [block] = blocks.as_slice() else {
            return None;
        };
        let block = block.as_object()?;
        (block.len() == 2 && block.get("type")?.as_str()? == "text")
            .then(|| block.get("text")?.as_str().map(str::to_owned))?
    };
    let (Some(a), Some(b)) = (left.get("content"), right.get("content")) else {
        return false;
    };
    let equal_text = match (a.as_str(), b.as_str()) {
        (Some(text), None) => text_block(b).as_deref() == Some(text),
        (None, Some(text)) => text_block(a).as_deref() == Some(text),
        _ => false,
    };
    equal_text
        && left.len() == right.len()
        && left
            .iter()
            .all(|(key, value)| key == "content" || right.get(key) == Some(value))
}

/// Substitute the first stored envelope before checking immutable message rows.
/// This runs under the provider lock. Rendering must retain the original bytes:
/// Anthropic thinking signatures depend on the exact preceding message prefix.
pub(super) fn preserve_stored_forms(
    store: &McStore,
    key: &Key,
    lineage: &mc_store::provider_records::ProviderLineage,
    messages: &mut [mc_store::provider_records::ProviderMessage],
) -> Result<(), HandlerOutcome> {
    for message in messages {
        let lookup = match (&lineage.descends_from, lineage.through_ordinal) {
            (Some(parent), Some(cut)) if message.ordinal <= cut => parent.as_str(),
            _ => lineage.lineage_id.as_str(),
        };
        let Some(stored) = store
            .load_provider_message(&key.store_key(), lookup, message.ordinal, &message.mid)
            .map_err(transient)?
        else {
            continue;
        };
        let incoming: Value = serde_json::from_slice(&message.message_bytes).map_err(transient)?;
        let original: Value = serde_json::from_slice(&stored.message_bytes).map_err(transient)?;
        if text_form_flip(&incoming["message"], &original["message"]) {
            let current = incoming["raw_message"]
                .as_str()
                .ok_or_else(|| invalid_raw("missing raw_message"))?;
            let first = original["raw_message"]
                .as_str()
                .ok_or_else(|| invalid_raw("missing raw_message"))?;
            // Only content's form may change. Whitespace, escaping and member
            // order outside that value remain part of the immutable raw identity.
            if field(current, "content", "null")? == field(first, "content", "null")? {
                message.message_bytes.clone_from(&stored.message_bytes);
            }
        }
    }
    Ok(())
}

pub(super) fn envelope(message: &Value, raw: Option<&Value>) -> Result<Value, HandlerOutcome> {
    let raw = raw
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_raw("Claude Code requires raw_message"))?;
    let parsed = parse_unique_json(raw)?;
    if (&parsed != message && !text_form_flip(&parsed, message))
        || has_marker(&parsed)
        || has_marker(message)
    {
        return Err(invalid_raw(
            "raw_message must equal message and exclude transport cache_control",
        ));
    }
    if !matches!(
        parsed["role"].as_str(),
        Some("user" | "assistant" | "system")
    ) || !(parsed["content"].is_string() || parsed["content"].is_array())
    {
        return Err(invalid_raw("invalid Anthropic message role/content"));
    }
    Ok(json!({"message":parsed,"raw_message":raw}))
}

/// Build and validate {message, raw_message} from the decoded commons fields.
/// Keeping this existing JSON shape lets MC's message blobs and immutable views
/// retain the original bytes without changing the store schema.
pub(super) fn from_wire(
    message: &Value,
    raw_message: Option<&str>,
) -> Result<Value, HandlerOutcome> {
    envelope(message, raw_message.map(|raw| json!(raw)).as_ref())
}

pub(super) fn decode_message(
    entry: &compact::status::StatusMessage,
) -> Result<ck_wire::CkIngressMessage, HandlerOutcome> {
    let validated = envelope(&entry.message["message"], entry.message.get("raw_message"))?;
    let native = &validated["message"];
    let blocks = if let Some(text) = native["content"].as_str() {
        vec![json!({"type":"text","text":text})]
    } else {
        native["content"].as_array().expect("validated").clone()
    };
    let content = blocks
        .iter()
        .map(|block| {
            let kind = match block["type"].as_str() {
                Some("text") if block["text"].is_string() => CkKind::Text {
                    text: block["text"].as_str().unwrap().into(),
                },
                Some("thinking") if block["thinking"].is_string() => CkKind::Reasoning {
                    text: block["thinking"].as_str().unwrap().into(),
                    signature: block["signature"].as_str().map(str::to_owned),
                },
                Some("redacted_thinking") if block["data"].is_string() => {
                    CkKind::RedactedReasoning {
                        data: block["data"].as_str().unwrap().into(),
                    }
                }
                Some("tool_use") if block["id"].is_string() && block["name"].is_string() => {
                    CkKind::ToolCall {
                        id: block["id"].as_str().unwrap().into(),
                        name: block["name"].as_str().unwrap().into(),
                        input: block["input"].clone(),
                        provider_executed: false,
                    }
                }
                Some("tool_result") if block["tool_use_id"].is_string() => {
                    let error = block["is_error"].as_bool().unwrap_or(false);
                    let output = match block["content"].as_str() {
                        Some(text) if error => CkOutputKind::ErrorText { text: text.into() },
                        Some(text) => CkOutputKind::Text { text: text.into() },
                        None if error => CkOutputKind::ErrorJson {
                            value: block["content"].clone(),
                        },
                        None => CkOutputKind::Json {
                            value: block["content"].clone(),
                        },
                    };
                    CkKind::ToolResult {
                        id: block["tool_use_id"].as_str().unwrap().into(),
                        tool_name: String::new(),
                        output: CkToolOutput::bare(output),
                        provider_executed: false,
                    }
                }
                _ => CkKind::Opaque(ck_wire::OpaqueBlock {
                    source: json!("anthropic"),
                    kind: block["type"].as_str().unwrap_or("unknown").into(),
                    raw: block.clone(),
                    arc: None,
                }),
            };
            let mut extras = ProviderExtras::new();
            extras.insert(
                EXTRAS.into(),
                BTreeMap::from([("kind".into(), serde_json::to_value(&kind).expect("CK kind"))]),
            );
            CkWireBlock::with_provider_extras(kind, extras)
        })
        .collect();
    let mut extras = ProviderExtras::new();
    extras.insert(
        EXTRAS.into(),
        BTreeMap::from([
            ("raw_message".into(), validated["raw_message"].clone()),
            ("mid".into(), json!(entry.mid)),
            ("ordinal".into(), json!(entry.ordinal)),
        ]),
    );
    Ok(ck_wire::CkIngressMessage {
        mid: entry.mid.clone(),
        ordinal: entry.ordinal,
        ck: CkWireMessage::from_parts(
            native["role"].as_str().unwrap(),
            content,
            None,
            extras,
            HarnessMeta::default(),
        ),
    })
}

// Span walking is performed only after serde has validated the JSON. It never
// interprets strings, so escaped quotes and noncanonical JSON stay untouched.
fn ws(bytes: &[u8], mut i: usize) -> usize {
    while bytes.get(i).is_some_and(u8::is_ascii_whitespace) {
        i += 1;
    }
    i
}
fn end(raw: &str, start: usize) -> usize {
    let bytes = raw.as_bytes();
    if bytes[start] == b'"' {
        let mut i = start + 1;
        while bytes[i] != b'"' {
            i += if bytes[i] == b'\\' { 2 } else { 1 };
        }
        return i + 1;
    }
    if matches!(bytes[start], b'{' | b'[') {
        let close = if bytes[start] == b'{' { b'}' } else { b']' };
        let mut i = start + 1;
        while bytes[i] != close {
            i = ws(bytes, i);
            if bytes[i] == close {
                break;
            }
            if matches!(bytes[i], b',' | b':') {
                i += 1;
            } else {
                i = end(raw, i);
            }
        }
        return i + 1;
    }
    let mut i = start;
    while bytes
        .get(i)
        .is_some_and(|b| !b.is_ascii_whitespace() && !matches!(b, b',' | b']' | b'}'))
    {
        i += 1;
    }
    i
}
fn members(raw: &str) -> Vec<(String, Range<usize>, Range<usize>)> {
    let mut i = ws(raw.as_bytes(), 0) + 1;
    let mut out = Vec::new();
    loop {
        i = ws(raw.as_bytes(), i);
        if raw.as_bytes()[i] == b'}' {
            break;
        }
        let start = i;
        let key_end = end(raw, i);
        let key = serde_json::from_str(&raw[i..key_end]).expect("validated key");
        i = ws(raw.as_bytes(), key_end) + 1;
        i = ws(raw.as_bytes(), i);
        let value_end = end(raw, i);
        out.push((key, i..value_end, start..value_end));
        i = ws(raw.as_bytes(), value_end);
        if raw.as_bytes()[i] == b',' {
            i += 1;
        } else {
            break;
        }
    }
    out
}
fn array(raw: &str) -> Vec<Range<usize>> {
    let mut i = ws(raw.as_bytes(), 0) + 1;
    let mut out = Vec::new();
    loop {
        i = ws(raw.as_bytes(), i);
        if raw.as_bytes()[i] == b']' {
            break;
        }
        let stop = end(raw, i);
        out.push(i..stop);
        i = ws(raw.as_bytes(), stop);
        if raw.as_bytes()[i] == b',' {
            i += 1;
        } else {
            break;
        }
    }
    out
}
fn replace(raw: &str, range: Range<usize>, value: &str) -> String {
    format!("{}{}{}", &raw[..range.start], value, &raw[range.end..])
}
fn field(raw: &str, key: &str, value: &str) -> Result<String, HandlerOutcome> {
    let range = members(raw)
        .into_iter()
        .find(|m| m.0 == key)
        .ok_or_else(|| invalid_raw("missing native field"))?
        .1;
    Ok(replace(raw, range, value))
}

/// Prefix a native content part without re-encoding its JSON string. Part indices
/// are native content indices (zero for scalar content), not hook block indices.
/// Array tool results use their first text child; eligibility is the caller's job.
#[allow(dead_code)] // Hook answers and served-baseline rendering share this splicer.
pub(super) fn splice_admission_tag(
    raw: &str,
    part_index: usize,
    number: u64,
) -> Result<String, HandlerOutcome> {
    let message = parse_unique_json(raw)?;
    if !message.is_object() {
        return Err(invalid_raw(
            "admission tag requires a native message object",
        ));
    }
    let content_span = members(raw)
        .into_iter()
        .find(|m| m.0 == "content")
        .ok_or_else(|| invalid_raw("admission tag requires native content"))?
        .1;
    let content_raw = &raw[content_span.clone()];
    let offset = if message["content"].is_string() && part_index == 0 {
        content_span.start
    } else {
        let blocks = message["content"]
            .as_array()
            .ok_or_else(|| invalid_raw("admission tag part is outside native content"))?;
        let block = blocks
            .get(part_index)
            .ok_or_else(|| invalid_raw("admission tag part is outside native content"))?;
        let span = array(content_raw)[part_index].clone();
        let block_raw = &content_raw[span.clone()];
        let (key, child) = match block["type"].as_str() {
            Some("text") if block["text"].is_string() => ("text", None),
            Some("tool_result") if block["content"].is_string() => ("content", None),
            Some("tool_result") => {
                let children = block["content"]
                    .as_array()
                    .ok_or_else(|| invalid_raw("admission tag requires tool result text"))?;
                if !children.iter().all(|child| {
                    child["type"] == "image"
                        || (child["type"] == "text" && child["text"].is_string())
                }) {
                    return Err(invalid_raw(
                        "admission tag requires text/image tool content",
                    ));
                }
                let first_text = children
                    .iter()
                    .position(|child| child["type"] == "text")
                    .ok_or_else(|| invalid_raw("admission tag requires tool result text"))?;
                ("content", Some(first_text))
            }
            _ => return Err(invalid_raw("admission tag requires a native text part")),
        };
        let value_span = members(block_raw)
            .into_iter()
            .find(|m| m.0 == key)
            .expect("validated text field")
            .1;
        let value_offset = content_span.start + span.start + value_span.start;
        if let Some(child) = child {
            let result_raw = &block_raw[value_span];
            let child_span = array(result_raw)[child].clone();
            let text_span = members(&result_raw[child_span.clone()])
                .into_iter()
                .find(|m| m.0 == "text")
                .expect("validated text child")
                .1;
            value_offset + child_span.start + text_span.start
        } else {
            value_offset
        }
    };
    let insert_at = offset + 1; // The opening quote belongs to the original JSON.
    Ok(replace(raw, insert_at..insert_at, &format!("§{number}§ ")))
}

/// Changed text is spliced into its original shell. Verified thinking bytes and
/// opaque blocks cannot be authored; a covered whole-turn strip may remove all
/// thinking while replaying every remaining block from the original raw JSON.
pub(super) fn render(message: &CkWireMessage) -> Result<String, HandlerOutcome> {
    let raw = message
        .provider_extras
        .get(EXTRAS)
        .and_then(|e| e.get("raw_message"))
        .and_then(Value::as_str);
    let Some(raw) = raw else {
        let blocks = message
            .content
            .iter()
            .map(|b| match &b.kind {
                CkKind::Text { text } => Ok(json!({"type":"text","text":text})),
                _ => Err(error(
                    "invalid_signed_tool_boundary",
                    "Claude Code cannot author non-text blocks",
                )),
            })
            .collect::<Result<Vec<_>, _>>()?;
        return serde_json::to_string(&json!({"role":message.role,"content":blocks}))
            .map_err(transient);
    };
    let stripped;
    let raw = if strips_signed_turn(message) {
        stripped = stripped_turn_shell(raw)?;
        stripped.as_str()
    } else {
        raw
    };
    let original = parse_unique_json(raw)?;
    if original["role"].as_str() != Some(&message.role) {
        return Err(error("signed_prefix_edit", "native role changed"));
    }
    let content_range = members(raw)
        .into_iter()
        .find(|m| m.0 == "content")
        .expect("validated content")
        .1;
    let content_raw = &raw[content_range.clone()];
    let scalar = original["content"].is_string();
    let spans = if scalar {
        std::iter::once(0..content_raw.len()).collect()
    } else {
        array(content_raw)
    };
    if spans.len() != message.content.len() {
        return Err(error(
            "signed_prefix_edit",
            "native block removal requires a complete covered message",
        ));
    }
    let mut output = content_raw.to_owned();
    for (block, span) in message.content.iter().zip(spans).rev() {
        let unchanged = block
            .provider_extras
            .get(EXTRAS)
            .and_then(|e| e.get("kind"))
            == Some(&serde_json::to_value(&block.kind).map_err(transient)?);
        if unchanged {
            continue;
        }
        let block_raw = &content_raw[span.clone()];
        let updated = match &block.kind {
            CkKind::Text { text } if scalar => serde_json::to_string(text).map_err(transient)?,
            CkKind::Text { text } => field(
                block_raw,
                "text",
                &serde_json::to_string(text).map_err(transient)?,
            )?,
            CkKind::ToolResult { output, .. } => match &output.kind {
                CkOutputKind::Text { text } | CkOutputKind::ErrorText { text } => field(
                    block_raw,
                    "content",
                    &serde_json::to_string(text).map_err(transient)?,
                )?,
                _ => {
                    return Err(error(
                        "invalid_signed_tool_boundary",
                        "unsupported native tool edit",
                    ))
                }
            },
            _ => {
                return Err(error(
                    "signed_prefix_edit",
                    "signed or opaque block changed",
                ))
            }
        };
        output = replace(&output, span, &updated);
    }
    Ok(replace(raw, content_range, &output))
}

pub(super) fn strips_signed_turn(message: &CkWireMessage) -> bool {
    message
        .provider_extras
        .get(EXTRAS)
        .and_then(|e| e.get("strip_signed_turn"))
        == Some(&Value::Bool(true))
}

pub(super) fn is_thinking_block(block: &CkWireBlock) -> bool {
    matches!(
        block.kind,
        CkKind::Reasoning { .. } | CkKind::RedactedReasoning { .. }
    ) || matches!(&block.kind, CkKind::Opaque(opaque) if matches!(opaque.kind.as_str(), "thinking" | "redacted_thinking"))
}

fn stripped_turn_shell(raw: &str) -> Result<String, HandlerOutcome> {
    let original = parse_unique_json(raw)?;
    let content = members(raw)
        .into_iter()
        .find(|m| m.0 == "content")
        .expect("validated content")
        .1;
    let spans = array(&raw[content.clone()]);
    let blocks = original["content"]
        .as_array()
        .ok_or_else(|| error("signed_prefix_edit", "thinking strip requires an array"))?;
    // A permitted whole-turn strip removes all thinking, not a signed subset.
    // Every surviving block is copied from its original raw JSON span.
    let kept = spans
        .iter()
        .zip(blocks)
        .filter(|(_, block)| {
            !matches!(
                block["type"].as_str(),
                Some("thinking" | "redacted_thinking")
            )
        })
        .map(|(span, _)| &raw[content.start + span.start..content.start + span.end])
        .collect::<Vec<_>>();
    Ok(replace(raw, content, &format!("[{}]", kept.join(","))))
}

fn signed_prefix(raw: &str) -> Option<&str> {
    let value = parse_unique_json(raw).ok()?;
    let last = value["content"]
        .as_array()?
        .iter()
        .rposition(|b| matches!(b["type"].as_str(), Some("thinking" | "redacted_thinking")))?;
    let content = members(raw).into_iter().find(|m| m.0 == "content")?.1;
    let spans = array(&raw[content.clone()]);
    Some(&raw[..content.start + spans[last].end])
}

fn same_identity_prefix(
    input: &[(String, u64)],
    output: &[Option<(String, u64)>],
    index: usize,
    position: usize,
) -> bool {
    position == index
        && output[..position]
            .iter()
            .zip(&input[..index])
            .all(|(output, input)| output.as_ref() == Some(input))
}

pub(super) fn whole_message_endpoint(
    entry: &compact::status::StatusMessage,
    boundary: &str,
) -> Result<compact::view::NativeEndpoint, HandlerOutcome> {
    let native = envelope(&entry.message["message"], entry.message.get("raw_message"))?;
    let content = &native["message"]["content"];
    let part = if content.is_string() {
        Some(0)
    } else {
        content
            .as_array()
            .and_then(|blocks| blocks.len().checked_sub(1))
    };
    let part = part
        .and_then(|part| u64::try_from(part).ok())
        .ok_or_else(|| {
            error(
                "native_endpoint_unrepresentable",
                "native message has no representable final part",
            )
        })?;
    // Whole-message-only cuts must end at the actual final original block.
    // An earlier engine boundary cannot be snapped forward over retained data.
    if boundary != format!("{}#{part}", entry.mid) {
        return Err(error(
            "native_endpoint_unrepresentable",
            "coverage does not end at a whole native message boundary",
        ));
    }
    Ok(compact::view::NativeEndpoint {
        message_id: entry.mid.clone(),
        part_index: part,
    })
}

pub(super) fn encode_view(
    view: &transform::compaction::View,
    request: &TransformRequest,
    covered: Option<u64>,
) -> Result<(compact::answer::CompactionMessage, Vec<String>), HandlerOutcome> {
    let raw = view
        .replacement
        .iter()
        .map(render)
        .collect::<Result<Vec<_>, _>>()?;
    let original = request
        .messages
        .iter()
        .map(|m| render(&m.ck))
        .collect::<Result<Vec<_>, _>>()?;
    let identity = |message: &CkWireMessage| {
        message.provider_extras.get(EXTRAS).and_then(|extras| {
            Some((
                extras.get("mid")?.as_str()?.to_owned(),
                extras.get("ordinal")?.as_u64()?,
            ))
        })
    };
    let input_ids = request
        .messages
        .iter()
        .map(|entry| (entry.mid.clone(), entry.ordinal))
        .collect::<Vec<_>>();
    let output_ids = view.replacement.iter().map(identity).collect::<Vec<_>>();
    let mut seen = BTreeSet::new();
    for (position, output) in view.replacement.iter().enumerate() {
        if output.provider_extras.contains_key(EXTRAS) {
            let id = output_ids[position].as_ref().ok_or_else(|| {
                error(
                    "signed_prefix_edit",
                    "native replacement lost its gateway identity",
                )
            })?;
            let source = input_ids
                .iter()
                .position(|input| input == id)
                .ok_or_else(|| {
                    error(
                        "signed_prefix_edit",
                        "native replacement has an unknown gateway identity",
                    )
                })?;
            if !seen.insert(id.clone())
                || output.provider_extras[EXTRAS]
                    .get("raw_message")
                    .and_then(Value::as_str)
                    != Some(original[source].as_str())
            {
                return Err(error(
                    "signed_prefix_edit",
                    "native replacement changed or duplicated its gateway identity",
                ));
            }
        }
    }
    // The prefix of every surviving signed block must remain identical, even
    // across a later real user turn. Compare native bytes, not normalized text.
    for (index, entry) in request.messages.iter().enumerate() {
        if signed_prefix(&original[index]).is_none() {
            continue;
        }
        if let Some(position) = output_ids
            .iter()
            .position(|id| id.as_ref() == Some(&input_ids[index]))
        {
            if strips_signed_turn(&view.replacement[position]) {
                if covered.is_none_or(|c| entry.ordinal > c)
                    || view.replacement[position]
                        .content
                        .iter()
                        .any(is_thinking_block)
                {
                    return Err(error(
                        "signed_prefix_edit",
                        "thinking strip requires complete coverage and no kept thinking",
                    ));
                }
                continue;
            }
            if !same_identity_prefix(&input_ids, &output_ids, index, position)
                || raw[..position] != original[..index]
                || signed_prefix(&raw[position]) != signed_prefix(&original[index])
            {
                return Err(error(
                    "signed_prefix_edit",
                    "replacement edits the prefix of kept signed thinking",
                ));
            }
        } else if covered.is_none_or(|c| entry.ordinal > c) {
            return Err(error(
                "signed_prefix_edit",
                "replacement changes or removes uncovered signed thinking",
            ));
        }
    }
    // A whole-message cut may not split a tool exchange. Kept signed thinking
    // cannot be deleted merely to make an otherwise unsafe replacement fit.
    if let Some(covered) = covered {
        let mut calls = BTreeSet::new();
        let mut results = BTreeSet::new();
        for entry in request.messages.iter().filter(|m| m.ordinal <= covered) {
            for block in &entry.ck.content {
                match &block.kind {
                    CkKind::ToolCall { id, .. } => {
                        calls.insert(id);
                    }
                    CkKind::ToolResult { id, .. } => {
                        results.insert(id);
                    }
                    _ => {}
                }
            }
        }
        if calls != results {
            return Err(error(
                "invalid_signed_tool_boundary",
                "coverage splits an Anthropic tool exchange",
            ));
        }
    }
    let replacement = raw
        .iter()
        .map(|r| serde_json::from_str(r).map_err(transient))
        .collect::<Result<Vec<_>, _>>()?;
    Ok((
        compact::answer::CompactionMessage::new(
            &view.compaction_id,
            view.version,
            compact::answer::Range::new(view.range.from, view.range.to),
            replacement,
        ),
        raw,
    ))
}

/// Serialize the role answer while substituting committed raw replacement JSON.
/// This is used only by the CC lane; other profiles keep the ordinary serializer.
pub(super) fn answer_bytes(answer: &Value, raw: &[String]) -> Result<Vec<u8>, HandlerOutcome> {
    fn write(value: &Value, raw: &[String], out: &mut String) -> Result<(), HandlerOutcome> {
        if let Some(object) = value.as_object() {
            out.push('{');
            for (i, (key, value)) in object.iter().enumerate() {
                if i != 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).map_err(transient)?);
                out.push(':');
                if key == "replacement" {
                    let parsed = raw
                        .iter()
                        .map(|s| parse_unique_json(s))
                        .collect::<Result<Vec<_>, _>>()?;
                    if value != &json!(parsed) {
                        return Err(transient("raw view differs from committed replacement"));
                    }
                    out.push('[');
                    out.push_str(&raw.join(","));
                    out.push(']');
                } else {
                    write(value, raw, out)?;
                }
            }
            out.push('}');
        } else {
            out.push_str(&serde_json::to_string(value).map_err(transient)?);
        }
        Ok(())
    }
    let mut output = String::new();
    write(answer, raw, &mut output)?;
    if output.len() >= HOST_ENVELOPE_BYTES {
        return Err(HandlerOutcome::ErrorWithDetail {
            code: "invalid_params".into(),
            message: "native replacement exceeds the inline reply ceiling".into(),
            detail: json!({"field":"raw_view"}),
        });
    }
    Ok(output.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::super::codec::Codec;
    use super::*;

    const ADMISSION_VECTORS: &[u8] = include_bytes!("cc_admission_vectors/admission-tags.json");
    const ADMISSION_SOURCE: &str = include_str!("cc_admission_vectors/SOURCE");

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct AdmissionSource {
        repository: String,
        path: String,
        commit: Option<String>,
        sha256: Option<String>,
    }

    fn checked_admission_vectors<'a>(
        source: &str,
        bytes: &'a [u8],
    ) -> Result<Option<&'a [u8]>, String> {
        let source: AdmissionSource = serde_json::from_str(source).map_err(|e| e.to_string())?;
        if source.repository != "thalamus"
            || source.path != "crates/thalamus-module/src/cc_step_codec/vectors/admission-tags.json"
        {
            return Err("SOURCE must name the THALAMUS admission vector file".into());
        }
        match (source.commit, source.sha256) {
            (None, None) => {
                if serde_json::from_slice::<Value>(bytes).map_err(|e| e.to_string())? != json!([]) {
                    return Err("unpinned admission vectors must be empty; do not author provisional vectors".into());
                }
                Ok(None)
            }
            (Some(commit), Some(digest)) => {
                let hex = |value: &str, len| {
                    value.len() == len
                        && value
                            .bytes()
                            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                };
                if !hex(&commit, 40) || !hex(&digest, 64) {
                    return Err("SOURCE requires a full commit and lowercase sha256".into());
                }
                let actual = sha256_hex(bytes);
                if actual != digest {
                    return Err(format!(
                        "admission-tags.json sha256 mismatch: SOURCE {digest}, actual {actual}"
                    ));
                }
                Ok(Some(bytes))
            }
            _ => Err("SOURCE commit and sha256 must be pinned together".into()),
        }
    }

    fn pinned_admission_vectors(gate: &str) -> Option<&'static [u8]> {
        let vectors = checked_admission_vectors(ADMISSION_SOURCE, ADMISSION_VECTORS)
            .unwrap_or_else(|reason| panic!("{gate}: {reason}"));
        if vectors.is_none() {
            eprintln!("SKIP {gate}: THALAMUS has not named a pinned commit for admission-tags.json; G1 cannot close");
        }
        vectors
    }

    #[test]
    fn admission_vectors_digest_matches_source() {
        let _ = pinned_admission_vectors("admission_vectors_digest_matches_source");
    }

    #[test]
    fn admission_vectors_replay_byte_for_byte() {
        let Some(bytes) = pinned_admission_vectors("admission_vectors_replay_byte_for_byte") else {
            return;
        };
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Vector {
            name: String,
            raw_message: String,
            part_index: usize,
            number: u64,
            expected: String,
            /// The message as Claude Code sent it, before the gateway strips
            /// transport markers. Only the gateway's own test reads it.
            #[serde(default)]
            #[allow(dead_code)]
            raw_input: Option<String>,
        }
        let vectors: Vec<Vector> = serde_json::from_slice(bytes).expect("THALAMUS splice vectors");
        assert!(
            !vectors.is_empty(),
            "pinned admission vectors must not be empty"
        );
        for vector in vectors {
            let actual =
                splice_admission_tag(&vector.raw_message, vector.part_index, vector.number)
                    .unwrap_or_else(|error| panic!("{}: {error:?}", vector.name));
            assert_eq!(
                actual.as_bytes(),
                vector.expected.as_bytes(),
                "{}",
                vector.name
            );
        }
    }

    #[test]
    fn admission_vector_digest_rejects_mismatch() {
        let source = json!({
            "repository": "thalamus",
            "path": "crates/thalamus-module/src/cc_step_codec/vectors/admission-tags.json",
            "commit": "1111111111111111111111111111111111111111",
            "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        })
        .to_string();
        assert_eq!(
            checked_admission_vectors(&source, b"").unwrap(),
            Some(&b""[..])
        );
        assert!(checked_admission_vectors(&source, b"changed")
            .unwrap_err()
            .contains("sha256 mismatch"));
    }

    #[test]
    fn admission_vectors_require_a_complete_pin_or_an_empty_placeholder() {
        let mut source: Value = serde_json::from_str(ADMISSION_SOURCE).unwrap();
        source["commit"] = Value::Null;
        source["sha256"] = Value::Null;
        assert_eq!(
            checked_admission_vectors(&source.to_string(), b"[]").unwrap(),
            None
        );
        assert!(checked_admission_vectors(&source.to_string(), b"[null]").is_err());
        source["commit"] = json!("1111111111111111111111111111111111111111");
        assert!(checked_admission_vectors(&source.to_string(), b"[]").is_err());
    }

    #[test]
    fn admission_splice_preserves_scalar_escape_spelling() {
        let raw = r#" { "role" : "user", "\u0063ontent" : " §9§ \u00e9\n\"\\\/𐐀" } "#;
        let expected = r#" { "role" : "user", "\u0063ontent" : "§12§  §9§ \u00e9\n\"\\\/𐐀" } "#;
        assert_eq!(
            splice_admission_tag(raw, 0, 12).unwrap().as_bytes(),
            expected.as_bytes()
        );
    }

    #[test]
    fn admission_splice_uses_native_part_indices_and_keeps_empty_text() {
        let raw = r#"{"role":"user","content":[{"type":"image","source":{}},{"type":"text","text":""},{"type":"text","text":"\u0061"}]}"#;
        let first = splice_admission_tag(raw, 1, 2).unwrap();
        assert_eq!(
            first,
            r#"{"role":"user","content":[{"type":"image","source":{}},{"type":"text","text":"§2§ "},{"type":"text","text":"\u0061"}]}"#
        );
        assert_eq!(
            splice_admission_tag(&first, 2, 3).unwrap(),
            r#"{"role":"user","content":[{"type":"image","source":{}},{"type":"text","text":"§2§ "},{"type":"text","text":"§3§ \u0061"}]}"#
        );
    }

    #[test]
    fn admission_splice_targets_tool_result_string_or_first_text_child() {
        let raw = r#"{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"\t done"}]}"#;
        assert_eq!(
            splice_admission_tag(raw, 0, 4).unwrap(),
            r#"{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"§4§ \t done"}]}"#
        );
        let raw = r#"{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","is_error":true,"content":[{"type":"image","source":{}},{"type":"text","te\u0078t":"\u0041"},{"type":"text","text":"second"}]}]}"#;
        assert_eq!(
            splice_admission_tag(raw, 0, 5).unwrap(),
            r#"{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","is_error":true,"content":[{"type":"image","source":{}},{"type":"text","te\u0078t":"§5§ \u0041"},{"type":"text","text":"second"}]}]}"#
        );
    }

    #[test]
    fn admission_splice_refuses_invalid_json_and_non_text_targets() {
        for raw in [
            "not json",
            "[]",
            r#"{"role":"user"}"#,
            r#"{"content":"one","\u0063ontent":"two"}"#,
            r#"{"content":[]}"#,
            r#"{"content":[{"type":"thinking","thinking":"signed"}]}"#,
            r#"{"content":[{"type":"tool_result","content":[{"type":"image"}]}]}"#,
            r#"{"content":[{"type":"tool_result","content":[{"type":"text","text":"ok"},{"type":"other"}]}]}"#,
        ] {
            assert!(splice_admission_tag(raw, 0, 1).is_err(), "{raw}");
        }
        assert!(splice_admission_tag(r#"{"content":"scalar"}"#, 1, 1).is_err());
        assert!(
            splice_admission_tag(r#"{"content":[{"type":"text","text":"ok"}]}"#, 1, 1).is_err()
        );
    }

    fn entry(raw: &str, ordinal: u64) -> compact::status::StatusMessage {
        compact::status::StatusMessage {
            raw_message: None,
            mid: format!("cc-{ordinal}"),
            ordinal,
            message: envelope(&serde_json::from_str(raw).unwrap(), Some(&json!(raw))).unwrap(),
        }
    }
    fn request(messages: &[compact::status::StatusMessage]) -> TransformRequest {
        let mut request: TransformRequest = decode(&json!({"v":2,"kind":"compaction.step","session_id":"cc","messages":[],"render_config":"","tool_present":false,"auto_search_enabled":false})).unwrap();
        Codec::ClaudeCodeAnthropic
            .prepare_request(&mut request, messages)
            .unwrap();
        request
    }

    #[test]
    fn commons_0_2_native_sidecars_reach_the_mc_codec_without_reserializing() {
        // Source: cortexkit/commons@77f10f0f, test-vectors/{compaction-provider-v1,
        // step-transform-provider-v1}/claude-code-native-ingress.json. Expected
        // bytes come from the role owner, not MC's renderer, and cover typed
        // status/hook fields with signed and redacted blocks.
        let status: Value = serde_json::from_str(include_str!(
            "../../testdata/codec/claude-code-status-77f10f0f.json"
        ))
        .unwrap();
        let hooks: Value = serde_json::from_str(include_str!(
            "../../testdata/codec/claude-code-hooks-77f10f0f.json"
        ))
        .unwrap();
        for case in status["messages"].as_array().unwrap() {
            let mut entry: compact::status::StatusMessage =
                serde_json::from_value(case["message"].clone()).unwrap();
            let raw = entry.raw_message.clone().unwrap();
            assert_eq!(serde_json::to_value(&entry).unwrap(), case["message"]);
            entry.message = from_wire(&entry.message, entry.raw_message.as_deref()).unwrap();
            let request = request(&[entry]);
            let (wire, rendered) = encode_view(&view(&request), &request, None).unwrap();
            assert_eq!(rendered, vec![raw.clone()]);
            assert!(String::from_utf8(
                answer_bytes(&json!({"compaction":wire}), &rendered).unwrap()
            )
            .unwrap()
            .contains(&raw));
        }
        for case in hooks["hooks"].as_array().unwrap() {
            let call: hooks::hook::HookCall =
                serde_json::from_value(case["request"].clone()).unwrap();
            assert_eq!(serde_json::to_value(&call).unwrap(), case["request"]);
            let admitted =
                from_wire(call.message.as_ref().unwrap(), call.raw_message.as_deref()).unwrap();
            let entry = compact::status::StatusMessage {
                mid: "hook".into(),
                ordinal: 0,
                message: admitted,
                raw_message: None,
            };
            assert_eq!(
                render(&decode_message(&entry).unwrap().ck).unwrap(),
                call.raw_message.unwrap()
            );
        }
        assert_eq!(status["messages"].as_array().unwrap().len(), 3);
        assert_eq!(hooks["hooks"].as_array().unwrap().len(), 3);
    }
    fn view(request: &TransformRequest) -> transform::compaction::View {
        transform::compaction::View {
            compaction_id: "cc-view".into(),
            version: 1,
            range: transform::compaction::Range {
                lineage_id: "line".into(),
                from: 0,
                to: request.messages.len() as u64,
            },
            replacement: request.messages.iter().map(|m| m.ck.clone()).collect(),
        }
    }
    #[test]
    fn synthetic_noncanonical_signed_redacted_scalar_and_opaque_roundtrip() {
        let input = [
            entry(
                r#"{ "content" : "a\u0062", "role":"system", "extra":7 }"#,
                0,
            ),
            entry(
                r#"{"content":[{ "signature":"sig\\x", "thinking":"x\u0061", "type":"thinking","extra":true },{"data":"opaque==","type":"redacted_thinking"},{"type":"text","text":"answer"},{"type":"future","opaque":{"x":1}}], "role":"assistant"}"#,
                1,
            ),
        ];
        let request = request(&input);
        let (_, raw) = encode_view(&view(&request), &request, None).unwrap();
        for (i, entry) in input.iter().enumerate() {
            assert_eq!(raw[i], entry.message["raw_message"].as_str().unwrap());
        }
        let (wire, raw) = encode_view(&view(&request), &request, None).unwrap();
        let bytes = answer_bytes(
            &json!({"answer":"compaction_message","request_id":"r","message":wire}),
            &raw,
        )
        .unwrap();
        let encoded = String::from_utf8(bytes).unwrap();
        assert!(encoded.contains(&raw.join(",")));
    }
    #[test]
    fn raw_provenance_and_transport_markers_are_required() {
        let message = json!({"role":"user","content":"hello"});
        assert!(envelope(&message, None).is_err());
        assert!(envelope(&message, Some(&json!("{}"))).is_err());
        for block in [
            json!({"type":"text","text":"x","cache_control":{}}),
            json!({"type":"tool_result","tool_use_id":"t","content":[{"type":"text","text":"x","cache_control":{}}]}),
        ] {
            let message = json!({"role":"user","content":[block]});
            assert!(envelope(&message, Some(&json!(message.to_string()))).is_err());
        }
        let raw = r#"{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"tool","input":{"cache_control":{"user":"data"}}}]}"#;
        let message = entry(raw, 0);
        assert_eq!(render(&decode_message(&message).unwrap().ck).unwrap(), raw);
        let unknown = r#"{"role":"user","content":[{"type":"future","cache_control":{"user":"data"}},{"type":"tool_result","tool_use_id":"t","content":[{"type":"future","cache_control":{}},{"type":"thinking","cache_control":{}}]}]}"#;
        assert_eq!(
            render(&decode_message(&entry(unknown, 0)).unwrap().ck).unwrap(),
            unknown
        );
    }

    #[test]
    fn oversized_inline_reply_is_named_refusal_not_unbounded_bytes() {
        let raw = serde_json::to_string(
            &json!({"role":"user","content":"x".repeat(HOST_ENVELOPE_BYTES)}),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&raw).unwrap();
        assert!(
            matches!(answer_bytes(&json!({"replacement":[parsed]}),&[raw]),Err(HandlerOutcome::ErrorWithDetail { code,detail,.. }) if code=="invalid_params" && detail["field"]=="raw_view")
        );
    }

    #[test]
    fn duplicate_object_keys_are_refused_at_every_depth_including_escaped_names() {
        for raw in [
            r#"{"role":"user","content":"a","content":"b"}"#,
            r#"{"role":"user","content":[{"type":"text","text":"a","text":"b"}]}"#,
            r#"{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"tool","input":{"nested":{"x":1,"x":1}}}]}"#,
            r#"{"role":"user","content":[{"type":"future","payload":[{"a":null,"\u0061":true}]}]}"#,
            r#"{"role":"user","content":"a","extra":{"x":[],"x":{}}}"#,
        ] {
            let parsed: Value = serde_json::from_str(raw).unwrap();
            assert!(
                matches!(envelope(&parsed,Some(&json!(raw))),Err(HandlerOutcome::ErrorWithDetail { code,detail,.. }) if code=="invalid_params" && detail["field"]=="raw_message")
            );
        }
        let raw = r#"{"role":"user","content":[{"type":"future","payload":[{"x":1},{"x":2,"y":[null,true,0,0.5]}]}]}"#;
        assert_eq!(
            render(&decode_message(&entry(raw, 0)).unwrap().ck).unwrap(),
            raw
        );
    }
    #[test]
    fn every_kept_signed_prefix_is_fenced_including_historical_turns() {
        let request = request(&[
            entry(r#"{"role":"user","content":"before"}"#, 0),
            entry(
                r#"{"role":"assistant","content":[{"type":"thinking","thinking":"private","signature":"sig"},{"type":"text","text":"after"}]}"#,
                1,
            ),
            entry(r#"{"role":"user","content":"later real user"}"#, 2),
        ]);
        let mut output = view(&request);
        output.replacement[0].content[0].kind = CkKind::Text {
            text: "edited".into(),
        };
        assert!(
            matches!(encode_view(&output,&request,None),Err(HandlerOutcome::Error { code, .. }) if code=="signed_prefix_edit")
        );
        output = view(&request);
        output.replacement[1].content[1].kind = CkKind::Text {
            text: "edited after signed".into(),
        };
        let (_, raw) = encode_view(&output, &request, None).unwrap();
        assert!(raw[1].contains(r#"{"type":"thinking","thinking":"private","signature":"sig"}"#));
        output.replacement.remove(1);
        assert!(encode_view(&output, &request, None).is_err());
    }
    #[test]
    fn complete_signed_tool_run_can_be_covered_but_split_or_tail_removal_refuses() {
        let request = request(&[
            entry(
                r#"{"role":"assistant","content":[{"type":"thinking","thinking":"private","signature":"s"},{"type":"tool_use","id":"t","name":"tool","input":{}}]}"#,
                0,
            ),
            entry(
                r#"{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"result"}]}"#,
                1,
            ),
            entry(r#"{"role":"user","content":"tail"}"#, 2),
        ]);
        let mut output = view(&request);
        output.replacement = vec![
            CkWireMessage::synthetic_user_text("summary"),
            request.messages[2].ck.clone(),
        ];
        assert!(encode_view(&output, &request, Some(1)).is_ok());
        assert!(
            matches!(encode_view(&output,&request,Some(0)),Err(HandlerOutcome::Error { code, .. }) if code=="invalid_signed_tool_boundary")
        );
        assert!(encode_view(&output, &request, None).is_err());
    }

    #[test]
    fn identical_signed_messages_remain_distinct_by_gateway_mid() {
        let raw = r#"{"role":"assistant","content":[{"type":"thinking","thinking":"x","signature":"s"}]}"#;
        let request = request(&[entry(raw, 0), entry(raw, 1)]);
        assert!(encode_view(&view(&request), &request, None).is_ok());
    }

    #[test]
    fn opaque_native_thinking_shapes_still_fence_their_signed_prefix() {
        let request = request(&[
            entry(r#"{"role":"user","content":"before"}"#, 0),
            entry(
                r#"{"role":"assistant","content":[{"type":"thinking","signature":"s","thinking":{"future":"shape"}}]}"#,
                1,
            ),
        ]);
        assert!(matches!(
            request.messages[1].ck.content[0].kind,
            CkKind::Opaque(_)
        ));
        let mut output = view(&request);
        assert!(encode_view(&output, &request, None).is_ok());
        output.replacement[0].content[0].kind = CkKind::Text {
            text: "edited".into(),
        };
        assert!(
            matches!(encode_view(&output,&request,None),Err(HandlerOutcome::Error { code,.. }) if code=="signed_prefix_edit")
        );
    }

    // Captures include moving cache markers. Remove just their members with a
    // byte splice; all non-marker bytes, especially signed blocks, remain raw.
    fn strip_block(raw: &str, nested: bool) -> String {
        let value: Value = serde_json::from_str(raw).unwrap();
        let mut output = raw.to_owned();
        if !nested && value["type"] == "tool_result" && value["content"].is_array() {
            output = field(
                &output,
                "content",
                &strip_array(
                    &raw[members(raw)
                        .into_iter()
                        .find(|m| m.0 == "content")
                        .unwrap()
                        .1],
                    true,
                ),
            )
            .unwrap();
        }
        let fields = members(&output);
        if let Some(index) = fields
            .iter()
            .position(|m| m.0 == "cache_control" && transport_block(&value, nested))
        {
            let mut range = fields[index].2.clone();
            if let Some(next) = fields.get(index + 1) {
                range.end = next.2.start;
            } else if index > 0 {
                range.start = fields[index - 1].2.end;
            }
            output = replace(&output, range, "");
        }
        output
    }
    fn strip_array(raw: &str, nested: bool) -> String {
        let mut output = raw.to_owned();
        for span in array(raw).into_iter().rev() {
            output = replace(&output, span.clone(), &strip_block(&raw[span], nested));
        }
        output
    }
    #[test]
    fn real_claude_code_capture_roundtrips_actual_raw_replacement_bytes() {
        let Ok(path) = std::env::var("MC_CC_CAPTURE") else {
            eprintln!("SKIP real Claude Code capture: set MC_CC_CAPTURE to private 14047-req-body");
            return;
        };
        let body = std::fs::read_to_string(path).unwrap();
        assert_eq!(body.len(), 157790);
        assert_eq!(
            sha256_hex(body.as_bytes()),
            "ca6d004324b7d758d5fe7e17d6e637d468c873d7a4a4dbc7116e26e4c7cc314c"
        );
        let messages = members(&body)
            .into_iter()
            .find(|m| m.0 == "messages")
            .unwrap()
            .1;
        let entries = array(&body[messages.clone()])
            .into_iter()
            .enumerate()
            .map(|(i, span)| {
                let raw = &body[messages.start + span.start..messages.start + span.end];
                let value: Value = serde_json::from_str(raw).unwrap();
                let raw = if value["content"].is_array() {
                    let content = members(raw)
                        .into_iter()
                        .find(|m| m.0 == "content")
                        .unwrap()
                        .1;
                    field(raw, "content", &strip_array(&raw[content], false)).unwrap()
                } else {
                    raw.into()
                };
                entry(&raw, i as u64)
            })
            .collect::<Vec<_>>();
        assert_eq!(entries.len(), 6);
        let request = request(&entries);
        let output = view(&request);
        let (wire, raw) = encode_view(&output, &request, None).unwrap();
        let answer =
            answer_bytes(&json!({"answer":"compaction_message","message":wire}), &raw).unwrap();
        let answer = String::from_utf8(answer).unwrap();
        assert!(answer.contains(&raw.join(",")));
        for (entry, actual) in entries.iter().zip(raw) {
            assert_eq!(entry.message["raw_message"].as_str().unwrap(), actual);
        }
        assert_eq!(
            request
                .messages
                .iter()
                .flat_map(|m| &m.ck.content)
                .filter(|b| matches!(b.kind, CkKind::Reasoning { .. }))
                .count(),
            1
        );
    }
}
