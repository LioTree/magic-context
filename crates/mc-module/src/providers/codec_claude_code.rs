//! Native Anthropic messages with a validated, byte-preserving provenance sidecar.
use super::*;
use ck_wire::{
    CkKind, CkOutputKind, CkToolOutput, CkWireBlock, CkWireMessage, HarnessMeta, ProviderExtras,
};
use std::ops::Range;

const EXTRAS: &str = "mc-claude-code";

fn invalid_raw(reason: &str) -> HandlerOutcome {
    HandlerOutcome::ErrorWithDetail {
        code: "invalid_params".into(),
        message: reason.into(),
        detail: json!({"field":"raw_message"}),
    }
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

pub(super) fn envelope(message: &Value, raw: Option<&Value>) -> Result<Value, HandlerOutcome> {
    let raw = raw
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_raw("Claude Code requires raw_message"))?;
    let parsed: Value =
        serde_json::from_str(raw).map_err(|_| invalid_raw("raw_message is not JSON"))?;
    if &parsed != message || has_marker(&parsed) {
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
    Ok(json!({"message":message,"raw_message":raw}))
}

/// Read the raw JSON string beside the parsed message on Claude Code requests.
/// Keep this lookup separate so a typed commons field can later replace it;
/// validation and stored provenance must remain the same.
pub(super) fn from_wire(fields: &Value) -> Result<Value, HandlerOutcome> {
    envelope(&fields["message"], fields.get("raw_message"))
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

/// Changed text is spliced into its original shell. Signed, redacted and opaque
/// blocks can only be replayed unchanged; the engine cannot author their bytes.
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
    let original: Value = serde_json::from_str(raw).map_err(transient)?;
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
        vec![0..content_raw.len()]
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

fn signed_prefix(raw: &str) -> Option<&str> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let last = value["content"]
        .as_array()?
        .iter()
        .rposition(|b| matches!(b["type"].as_str(), Some("thinking" | "redacted_thinking")))?;
    let content = members(raw).into_iter().find(|m| m.0 == "content")?.1;
    let spans = array(&raw[content.clone()]);
    Some(&raw[..content.start + spans[last].end])
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
    // The prefix of every surviving signed block must remain identical, even
    // across a later real user turn. Compare native bytes, not normalized text.
    for (index, entry) in request.messages.iter().enumerate() {
        if signed_prefix(&original[index]).is_none() {
            continue;
        }
        if let Some(position) = view.replacement.iter().position(|m| {
            m.provider_extras
                .get(EXTRAS)
                .and_then(|e| e.get("mid"))
                .and_then(Value::as_str)
                == Some(entry.mid.as_str())
        }) {
            if raw[..position] != original[..index]
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
                        .map(|s| serde_json::from_str::<Value>(s).map_err(transient))
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
    Ok(output.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::super::codec::Codec;
    use super::*;

    fn entry(raw: &str, ordinal: u64) -> compact::status::StatusMessage {
        compact::status::StatusMessage {
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
