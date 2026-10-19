//! Provider codecs selected by the plan item's serializer profile.
use super::*;
use serde::Deserialize;

/// A transcript message held by the compaction engine, independent of its transport.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct InboundMessage {
    pub ordinal: u64,
    pub mid: String,
    pub message: Value,
}

/// The engine's rendered replacement and the transcript range it covers.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct OutboundMessage {
    pub compaction_id: String,
    pub version: u64,
    pub range: MessageRange,
    pub replacement: Vec<Value>,
}

impl OutboundMessage {
    pub fn new(
        compaction_id: impl Into<String>,
        version: u64,
        range: MessageRange,
        replacement: Vec<Value>,
    ) -> Self {
        Self {
            compaction_id: compaction_id.into(),
            version,
            range,
            replacement,
        }
    }
}

/// Half-open transcript ordinals covered by a rendered replacement.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct MessageRange {
    pub from: u64,
    pub to: u64,
}

impl MessageRange {
    pub fn new(from: u64, to: u64) -> Self {
        Self { from, to }
    }
}

/// Missing profile preserves the original Broca plan's strict native codec.
/// Only profiles with a provider transcript codec are admitted here; accepting
/// another engine profile would silently decode the runner's wrong schema.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    OwnedBroca,
    OpencodeAiSdk,
    Pi,
}

impl Codec {
    /// Takes the plan item's opaque `params`, not the operation envelope.
    pub fn from_params(params: &Value) -> Result<Self, HandlerOutcome> {
        match params.get("serializer_profile") {
            None => Ok(Self::OwnedBroca),
            Some(Value::String(profile)) if profile == "owned-broca" => Ok(Self::OwnedBroca),
            Some(Value::String(profile)) if profile == "opencode-aisdk" => Ok(Self::OpencodeAiSdk),
            Some(Value::String(profile)) if profile == "pi" => Ok(Self::Pi),
            _ => Err(HandlerOutcome::ErrorWithDetail {
                code: "invalid_params".into(),
                message: "unknown provider serializer profile".into(),
                detail: json!({"field":"params.serializer_profile"}),
            }),
        }
    }

    pub fn serializer_profile(self) -> SerializerProfile {
        match self {
            Self::OwnedBroca => SerializerProfile::OwnedBroca,
            Self::OpencodeAiSdk => SerializerProfile::OpencodeAiSdk,
            Self::Pi => SerializerProfile::Pi,
        }
    }

    pub fn decode_message(
        self,
        message: &codec::InboundMessage,
    ) -> Result<ck_wire::CkIngressMessage, HandlerOutcome> {
        match self {
            Self::OwnedBroca => decode_message(message),
            Self::Pi => Ok(
                super::codec_pi::decode_messages(std::slice::from_ref(message))?
                    .messages
                    .into_iter()
                    .next()
                    .expect("one Pi message"),
            ),
            Self::OpencodeAiSdk => {
                let decoded =
                    super::codec_opencode::decode_messages(std::slice::from_ref(message))?;
                decoded.messages.into_iter().next().ok_or_else(|| {
                    error(
                        "history_unreadable",
                        "OpenCode entry did not decode to one message",
                    )
                })
            }
        }
    }

    /// Install CK ingress and the untouched native sidecar together. The engine
    /// must use the same profile as native rendering so healing has one owner.
    pub fn prepare_request(
        self,
        request: &mut TransformRequest,
        messages: &[codec::InboundMessage],
    ) -> Result<(), HandlerOutcome> {
        let (ingress, native) = match self {
            Self::Pi => (
                super::codec_pi::decode_messages(messages)?.messages,
                Some(messages.iter().map(|m| m.message.clone()).collect()),
            ),
            Self::OwnedBroca => (
                messages
                    .iter()
                    .map(decode_message)
                    .collect::<Result<Vec<_>, _>>()?,
                None,
            ),
            Self::OpencodeAiSdk => {
                let decoded = super::codec_opencode::decode_messages(messages)?;
                (
                    decoded.messages,
                    Some(
                        messages
                            .iter()
                            .map(|message| message.message.clone())
                            .collect(),
                    ),
                )
            }
        };
        request.messages = ingress;
        request.native_messages = native;
        request.serve_native = self == Self::OpencodeAiSdk;
        request.serializer_profile = self.serializer_profile().wire_id().into();
        Ok(())
    }

    pub fn encode_view(
        self,
        view: &transform::compaction::View,
        request: &TransformRequest,
        context: &super::codec_opencode::NativeRenderContext<'_>,
    ) -> Result<codec::OutboundMessage, HandlerOutcome> {
        match self {
            Self::OwnedBroca => encode_view(view),
            Self::Pi => super::codec_pi::encode_view(view, request),
            Self::OpencodeAiSdk => super::codec_opencode::encode_view(view, request, context),
        }
    }

    /// Decode a runner's transcript entries, oldest first, into the engine's
    /// CK messages. Each entry is decoded on its own, so the result for an
    /// entry never depends on how the transcript was paged. `mid` must be the
    /// runner's own message id (OpenCode `info.id`, a Pi journal entry `id`):
    /// an entry without one is refused, never assigned an id.
    pub fn decode_entries(
        self,
        entries: &[InboundMessage],
    ) -> Result<Vec<ck_wire::CkIngressMessage>, HandlerOutcome> {
        entries
            .iter()
            .map(|entry| self.decode_message(entry))
            .collect()
    }

    /// Render a view back into the runner's declared schema. `entries` are the
    /// runner's held native messages for the view's lineage, so every message
    /// the view leaves unchanged goes back as the runner's own bytes; `session`
    /// is the runner's session name, which OpenCode stamps on messages ck-mc
    /// authors (the history head). Messages ck-mc authors carry no native id;
    /// the runner assigns one when it applies the view. Rendering takes no
    /// engine reasoning-clear or tag decisions: those are already in the view's
    /// messages, and provider and model restrictions are the runner's to apply.
    /// The result is a pure function of the view, the session and the entries.
    /// Broca's schema needs neither: its messages carry their native copy.
    pub fn render_view(
        self,
        view: &transform::compaction::View,
        session: &str,
        entries: &[InboundMessage],
    ) -> Result<OutboundMessage, HandlerOutcome> {
        if self == Self::OwnedBroca {
            return encode_view(view);
        }
        let mut request: TransformRequest = decode(&json!({"v":2,"kind":"compaction.step",
            "serializer_profile":self.serializer_profile().wire_id(),"session_id":session,
            "render_config":"","messages":[],"tool_present":false,"auto_search_enabled":false}))?;
        self.prepare_request(&mut request, entries)?;
        let tags = BTreeMap::new();
        self.encode_view(
            view,
            &request,
            &super::codec_opencode::NativeRenderContext {
                reasoning_clear_units: &[],
                tag_numbers: &tags,
                mutation_exempt_mid: None,
                lineage_anchor_mid: None,
                transition_consumed: false,
                native_reasoning_keep_mids: &[],
            },
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeOrigin {
    provider_module_id: String,
    model_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeMessage {
    role: String,
    content: Vec<NativeBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cache_prefix_blocks: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    origin: Option<NativeOrigin>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum NativeBlock {
    Text {
        text: String,
    },
    Reasoning {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    RedactedReasoning {
        data: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_format: Option<String>,
    },
    ToolCall {
        tool_call_id: String,
        tool_name: String,
        input: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thought_signature: Option<String>,
    },
    ToolResult {
        tool_call_id: String,
        output: NativeOutput,
        is_error: bool,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum NativeOutput {
    Text { text: String },
    Json { value: Value },
    Denied { reason: String },
    Error { message: String },
}

fn native(message: &Value) -> Result<NativeMessage, HandlerOutcome> {
    let parsed: NativeMessage =
        serde_json::from_value(message.clone()).map_err(|e| error("history_unreadable", e))?;
    if !["system", "user", "assistant", "tool"].contains(&parsed.role.as_str()) {
        return Err(error("history_unreadable", "unknown runner message role"));
    }
    Ok(parsed)
}

/// Broca serves its native messages, not the retired whole-array CK envelope.
/// Preserve the native shell for unchanged content; authored content cannot
/// inherit cache markers, origin attribution or encrypted reasoning.
pub fn decode_message(
    message: &codec::InboundMessage,
) -> Result<ck_wire::CkIngressMessage, HandlerOutcome> {
    use ck_wire::{
        CkKind, CkOutputKind, CkToolOutput, CkWireBlock, CkWireMessage, HarnessMeta, ProviderExtras,
    };
    let parsed = native(&message.message)?;
    let mut content = Vec::new();
    for block in parsed.content {
        let raw = serde_json::to_value(&block).map_err(transient)?;
        let kind = match block {
            NativeBlock::Text { text } => CkKind::Text { text },
            NativeBlock::Reasoning { text, signature } => CkKind::Reasoning { text, signature },
            NativeBlock::RedactedReasoning { data, .. } => CkKind::RedactedReasoning { data },
            NativeBlock::ToolCall {
                tool_call_id,
                tool_name,
                input,
                ..
            } => CkKind::ToolCall {
                id: tool_call_id,
                name: tool_name,
                input,
                provider_executed: false,
            },
            NativeBlock::ToolResult {
                tool_call_id,
                output,
                is_error,
            } => {
                let kind = match output {
                    NativeOutput::Text { text } => {
                        if is_error {
                            CkOutputKind::ErrorText { text }
                        } else {
                            CkOutputKind::Text { text }
                        }
                    }
                    NativeOutput::Json { value } => {
                        if is_error {
                            CkOutputKind::ErrorJson { value }
                        } else {
                            CkOutputKind::Json { value }
                        }
                    }
                    NativeOutput::Denied { reason } => CkOutputKind::ExecutionDenied {
                        reason: Some(reason),
                    },
                    NativeOutput::Error { message } => CkOutputKind::ErrorText { text: message },
                };
                CkKind::ToolResult {
                    id: tool_call_id,
                    tool_name: String::new(),
                    output: CkToolOutput::bare(kind),
                    provider_executed: false,
                }
            }
        };
        let mut extras = ProviderExtras::new();
        extras.insert(
            "mc-provider".into(),
            BTreeMap::from([("native_block".into(), raw)]),
        );
        content.push(CkWireBlock::with_provider_extras(kind, extras));
    }
    let mut extras = ProviderExtras::new();
    extras.insert(
        "mc-provider".into(),
        BTreeMap::from([("native_message".into(), message.message.clone())]),
    );
    let ck = CkWireMessage::from_parts(parsed.role, content, None, extras, HarnessMeta::default());
    Ok(ck_wire::CkIngressMessage {
        mid: message.mid.clone(),
        ordinal: message.ordinal,
        ck,
    })
}

pub fn encode_message(message: &ck_wire::CkWireMessage) -> Result<Value, HandlerOutcome> {
    use ck_wire::{CkKind, CkOutputKind};
    let mut content = Vec::new();
    for block in &message.content {
        let raw = block
            .provider_extras
            .get("mc-provider")
            .and_then(|v| v.get("native_block"));
        let native = match &block.kind {
            CkKind::Text { text } => json!({"type":"text","text":text}),
            CkKind::Reasoning { text, signature } => {
                let mut value = json!({"type":"reasoning","text":text});
                if let Some(signature) = signature {
                    value["signature"] = json!(signature);
                }
                value
            }
            CkKind::RedactedReasoning { data } => {
                let mut value = json!({"type":"redacted_reasoning","data":data});
                if let Some(format) = raw.and_then(|v| v.get("provider_format")) {
                    value["provider_format"] = format.clone();
                }
                value
            }
            CkKind::ToolCall {
                id, name, input, ..
            } => {
                let mut value =
                    json!({"type":"tool_call","tool_call_id":id,"tool_name":name,"input":input});
                if raw.is_some_and(|v| {
                    v.get("input") == Some(input)
                        && v.get("tool_call_id") == Some(&json!(id))
                        && v.get("tool_name") == Some(&json!(name))
                }) {
                    if let Some(signature) = raw.and_then(|v| v.get("thought_signature")) {
                        value["thought_signature"] = signature.clone();
                    }
                }
                value
            }
            CkKind::ToolResult { id, output, .. } => {
                let is_error = matches!(
                    output.kind,
                    CkOutputKind::ErrorText { .. }
                        | CkOutputKind::ErrorJson { .. }
                        | CkOutputKind::ErrorContent { .. }
                        | CkOutputKind::ExecutionDenied { .. }
                );
                let output = match &output.kind {
                    CkOutputKind::Text { text } => json!({"kind":"text","text":text}),
                    CkOutputKind::ErrorText { text } => {
                        if raw
                            .and_then(|v| v.pointer("/output/kind"))
                            .and_then(Value::as_str)
                            == Some("text")
                        {
                            json!({"kind":"text","text":text})
                        } else {
                            json!({"kind":"error","message":text})
                        }
                    }
                    CkOutputKind::Json { value } | CkOutputKind::ErrorJson { value } => {
                        json!({"kind":"json","value":value})
                    }
                    CkOutputKind::ExecutionDenied { reason } => {
                        json!({"kind":"denied","reason":reason.as_deref().unwrap_or("denied")})
                    }
                    _ => {
                        return Err(error(
                            "history_unreadable",
                            "Broca does not accept a CK content-array output",
                        ))
                    }
                };
                // Error/denied outputs and their error flag are independent on
                // Broca's wire. An unchanged block retains even a false flag.
                let candidate = json!({"type":"tool_result","tool_call_id":id,"output":output,"is_error":is_error});
                if raw.is_some_and(|v| {
                    v.get("output") == candidate.get("output")
                        && v.get("tool_call_id") == candidate.get("tool_call_id")
                }) {
                    raw.expect("matched native block").clone()
                } else {
                    candidate
                }
            }
            _ => {
                return Err(error(
                    "history_unreadable",
                    "CK block has no Broca-native representation",
                ))
            }
        };
        content.push(native);
    }
    if let Some(original) = message
        .provider_extras
        .get("mc-provider")
        .and_then(|v| v.get("native_message"))
    {
        if original.get("role") == Some(&json!(message.role))
            && original.get("content") == Some(&json!(content))
        {
            return Ok(original.clone());
        }
    }
    Ok(json!({"role":message.role,"content":content}))
}

pub fn encode_view(
    view: &transform::compaction::View,
) -> Result<codec::OutboundMessage, HandlerOutcome> {
    let replacement = view
        .replacement
        .iter()
        .map(encode_message)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(codec::OutboundMessage::new(
        &view.compaction_id,
        view.version,
        MessageRange::new(view.range.from, view.range.to),
        replacement,
    ))
}

#[cfg(test)]
mod dispatch_tests {
    use super::*;

    #[test]
    fn serializer_profile_dispatch_preserves_the_strict_broca_default() {
        for params in [json!({}), json!({"serializer_profile":"owned-broca"})] {
            let codec = Codec::from_params(&params).unwrap();
            assert_eq!(codec, Codec::OwnedBroca);
            assert_eq!(codec.serializer_profile(), SerializerProfile::OwnedBroca);
            let entries: Vec<codec::InboundMessage> = serde_json::from_str(include_str!(
                "../tests/fixtures/tool-catalog/broca-session-read-messages.json"
            ))
            .unwrap();
            for entry in entries {
                let ingress = codec.decode_message(&entry).unwrap();
                assert_eq!(
                    bytes(&encode_message(&ingress.ck).unwrap()).unwrap(),
                    bytes(&entry.message).unwrap()
                );
            }
            let invalid_entry = codec::InboundMessage {
                mid: "m".into(),
                ordinal: 1,
                message: json!({"role":"user","content":[{"type":"future","text":"a"}]}),
            };
            assert!(codec.decode_message(&invalid_entry).is_err());
        }
        let codec = Codec::from_params(&json!({"serializer_profile":"opencode-aisdk"})).unwrap();
        assert_eq!(codec, Codec::OpencodeAiSdk);
        assert_eq!(codec.serializer_profile(), SerializerProfile::OpencodeAiSdk);
        let codec = Codec::from_params(&json!({"serializer_profile":"pi"})).unwrap();
        assert_eq!(codec, Codec::Pi);
        assert_eq!(codec.serializer_profile(), SerializerProfile::Pi);
    }

    #[test]
    fn unknown_serializer_profile_refuses_invalid_params_with_field() {
        for profile in [
            json!("unknown"),
            json!("owned-llmrunner"),
            json!(null),
            json!(3),
            json!({}),
        ] {
            match Codec::from_params(&json!({"serializer_profile":profile})) {
                Err(HandlerOutcome::ErrorWithDetail { code, detail, .. }) => {
                    assert_eq!(code, "invalid_params");
                    assert_eq!(detail, json!({"field":"params.serializer_profile"}));
                }
                _ => panic!("unknown profile did not refuse by field: {profile}"),
            }
        }
    }
}
