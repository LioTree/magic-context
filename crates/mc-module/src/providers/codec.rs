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
    /// llm-runner's `anthropic-messages` profile: entries are Anthropic
    /// Messages request messages, rendered under the Claude Code serializer.
    AnthropicMessages,
}

impl Codec {
    /// Every profile `from_params` admits, in the fixed order `role.describe`
    /// advertises them.
    pub const ALL: [Self; 4] = [
        Self::OwnedBroca,
        Self::OpencodeAiSdk,
        Self::Pi,
        Self::AnthropicMessages,
    ];

    /// The `params.serializer_profile` string that selects this codec.
    pub const fn wire_id(self) -> &'static str {
        match self {
            Self::OwnedBroca => "owned-broca",
            Self::OpencodeAiSdk => "opencode-aisdk",
            Self::Pi => "pi",
            Self::AnthropicMessages => {
                cortexkit_role_llm_runner::serializer_profile::ANTHROPIC_MESSAGES
            }
        }
    }

    /// Takes the plan item's opaque `params`, not the operation envelope.
    pub fn from_params(params: &Value) -> Result<Self, HandlerOutcome> {
        match params.get("serializer_profile") {
            None => Ok(Self::OwnedBroca),
            Some(Value::String(profile)) => Self::ALL
                .into_iter()
                .find(|codec| codec.wire_id() == profile)
                .ok_or_else(Self::unknown_profile),
            Some(_) => Err(Self::unknown_profile()),
        }
    }

    fn unknown_profile() -> HandlerOutcome {
        HandlerOutcome::ErrorWithDetail {
            code: "invalid_params".into(),
            message: "unknown provider serializer profile".into(),
            detail: json!({"field":"params.serializer_profile"}),
        }
    }

    pub fn serializer_profile(self) -> SerializerProfile {
        match self {
            Self::OwnedBroca => SerializerProfile::OwnedBroca,
            Self::OpencodeAiSdk => SerializerProfile::OpencodeAiSdk,
            Self::Pi => SerializerProfile::Pi,
            // The engine's existing Anthropic serializer: the healing and
            // rendering rules of the full-array Claude Code route.
            Self::AnthropicMessages => SerializerProfile::ClaudeCodeAnthropic,
        }
    }

    pub fn decode_message(
        self,
        message: &codec::InboundMessage,
    ) -> Result<ck_wire::CkIngressMessage, HandlerOutcome> {
        match self {
            Self::OwnedBroca => decode_message(message),
            Self::AnthropicMessages => super::codec_anthropic::decode_message(message),
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
        self.prepare_request_from(request, messages, messages.first().map_or(0, |m| m.ordinal))
    }

    pub fn prepare_request_from(
        self,
        request: &mut TransformRequest,
        messages: &[codec::InboundMessage],
        source_from: u64,
    ) -> Result<(), HandlerOutcome> {
        let (ingress, native) = match self {
            Self::Pi => (
                super::codec_pi::decode_messages_from(messages, source_from)?.messages,
                Some(messages.iter().map(|m| m.message.clone()).collect()),
            ),
            Self::OwnedBroca => (
                messages
                    .iter()
                    .map(decode_message)
                    .collect::<Result<Vec<_>, _>>()?,
                None,
            ),
            Self::AnthropicMessages => (
                messages
                    .iter()
                    .map(super::codec_anthropic::decode_message)
                    .collect::<Result<Vec<_>, _>>()?,
                Some(messages.iter().map(|m| m.message.clone()).collect()),
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
        // Every `anthropic-messages` entry is an Anthropic Messages API
        // message, so the engine applies Anthropic's signed-thinking turn rules
        // whatever the session's model is called.
        if self == Self::AnthropicMessages && request.provider_id.is_none() {
            request.provider_id = Some("anthropic".into());
        }
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
            Self::AnthropicMessages => super::codec_anthropic::encode_view(view),
            Self::Pi => super::codec_pi::encode_view(view, request),
            Self::OpencodeAiSdk => super::codec_opencode::encode_view(view, request, context),
        }
    }

    /// For each part of `rendered`, the index of the runner part of the same
    /// message it was decoded from (`None` for an engine-authored part), when
    /// the schema's parts carry no ids of their own to match by. `None` keeps
    /// matching by part id, then by position.
    pub fn part_origins(
        self,
        message: &ck_wire::CkWireMessage,
        rendered: &Value,
    ) -> Option<Vec<Option<usize>>> {
        match self {
            Self::AnthropicMessages => super::codec_anthropic::part_origins(message, rendered),
            Self::OwnedBroca | Self::OpencodeAiSdk | Self::Pi => None,
        }
    }

    /// Decode a runner's transcript entries, oldest first, into the engine's
    /// CK messages. Each entry is decoded on its own, so the result for an
    /// entry never depends on how the transcript was paged. `mid` must be the
    /// runner's own message id (OpenCode `info.id`, a Pi journal entry `id`):
    /// an entry without one is refused, never assigned an id. An
    /// `anthropic-messages` body has no id member, so its `mid` is the one
    /// the runner's read envelope names.
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
        self.prepare_request_from(&mut request, entries, view.range.from)?;
        self.encode_prepared_view(view, &request)
    }

    /// Reuse ingress that the engine already decoded. Recreate only renderer
    /// settings, so engine-only flags and the engine namespace cannot change
    /// native rendering or the session id on synthetic OpenCode messages.
    pub(crate) fn render_prepared_view(
        self,
        view: &transform::compaction::View,
        session: &str,
        source: &TransformRequest,
    ) -> Result<OutboundMessage, HandlerOutcome> {
        if self == Self::OwnedBroca {
            return encode_view(view);
        }
        let mut request: TransformRequest = decode(&json!({"v":2,"kind":"compaction.step",
            "serializer_profile":self.serializer_profile().wire_id(),"session_id":session,
            "render_config":"","messages":[],"tool_present":false,"auto_search_enabled":false}))?;
        request.messages = source.messages.clone();
        request.native_messages = source.native_messages.clone();
        request.serve_native = self == Self::OpencodeAiSdk;
        if self == Self::AnthropicMessages {
            request.provider_id = Some("anthropic".into());
        }
        self.encode_prepared_view(view, &request)
    }

    fn encode_prepared_view(
        self,
        view: &transform::compaction::View,
        request: &TransformRequest,
    ) -> Result<OutboundMessage, HandlerOutcome> {
        let tags = BTreeMap::new();
        self.encode_view(
            view,
            request,
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
    Text {
        text: String,
    },
    Json {
        value: Value,
    },
    Denied {
        reason: String,
    },
    // The tool-plane outage shape: `message` plus five optional siblings, in
    // the Broca capture's order (`kind`, `message`, `module`, `code`,
    // `detail`, `nothing_sent`, `retry`). These fields come from
    // broca-protocol's `ToolOutput::Error` and are not in the llm-runner
    // contract yet. Absent siblings are omitted on re-encode rather than
    // written as null, so today's plain `{"kind":"error","message":...}`
    // still round-trips byte-identically. `deny_unknown_fields` still refuses
    // anything else, so real shape drift keeps failing as `history_unreadable`
    // instead of being misread.
    Error {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        module: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        nothing_sent: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry: Option<String>,
    },
}

/// Model-visible text for an owned-broca `Error` output: `message` plus one
/// line per present field, in broca-protocol's `ToolOutput::error_model_text`
/// order. `nothing_sent` contributes its line only when true; absent fields
/// contribute nothing, and lines are joined with `\n` and no trailing
/// newline. A plain error renders as `message` alone, exactly as today.
fn error_model_text(
    message: &str,
    module: Option<&str>,
    code: Option<&str>,
    detail: Option<&str>,
    nothing_sent: bool,
    retry: Option<&str>,
) -> String {
    let mut text = message.to_string();
    if let Some(module) = module {
        text.push_str("\nmodule: ");
        text.push_str(module);
    }
    if let Some(code) = code {
        text.push_str("\ncode: ");
        text.push_str(code);
    }
    if let Some(detail) = detail {
        text.push_str("\ndetail: ");
        text.push_str(detail);
    }
    if nothing_sent {
        text.push_str("\nnothing was sent");
    }
    if let Some(retry) = retry {
        text.push_str("\nretry: ");
        text.push_str(retry);
    }
    text
}

/// Runner contract `module` rule: 1 to 255 bytes of UTF-8 with no control
/// character. It matches the widest module id the subc daemon registers
/// (spaces, non-ASCII and re-exported `fed:<peer>:<module>` ids included), so
/// a real outage on any registered module never refuses a history page.
/// Excluding control characters also excludes `\n` and `\r`, so the value
/// still renders as a single model-text line.
fn error_module_grammar_ok(value: &str) -> bool {
    !value.is_empty() && value.len() <= 255 && !value.chars().any(char::is_control)
}

/// SUBC runner contract 0.7.8 `code` grammar: `^[a-z][a-z0-9_]{0,63}$`,
/// lowercase snake case starting with a letter, 1 to 64 bytes.
fn error_code_grammar_ok(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'_')
}

/// SUBC runner contract 0.7.8 member rules for an owned-broca `Error` output,
/// checked on the wire value before typed decode (which would erase `null`
/// into `None`): `nothing_sent` is the JSON literal `true` when present;
/// a present string member must be non-empty; no member may be `null`;
/// string members must not contain a newline (each renders as one
/// model-text line, so one would forge a line); `detail` and `retry` have
/// byte limits over the decoded string; and `module`/`code` must meet their
/// grammars. Violations are refused as `history_unreadable` naming the
/// member and the rule.
fn check_error_output(output: &Value) -> Result<(), HandlerOutcome> {
    let refused = |member: &str, rule: String| {
        error(
            "history_unreadable",
            format!("owned-broca error output member {member} {rule}"),
        )
    };
    if output
        .get("nothing_sent")
        .is_some_and(|value| value != &Value::Bool(true))
    {
        return Err(refused(
            "nothing_sent",
            "must be the literal true when present".into(),
        ));
    }
    for key in ["module", "code", "detail", "retry"] {
        match output.get(key) {
            None => {}
            Some(Value::Null) => {
                return Err(refused(key, "must not be null".into()));
            }
            Some(Value::String(text)) => {
                if text.is_empty() {
                    return Err(refused(key, "must not be empty when present".into()));
                }
                if text.contains('\n') || text.contains('\r') {
                    return Err(refused(
                        key,
                        "must not contain a newline, which would forge a line in the model text"
                            .into(),
                    ));
                }
                let limit = match key {
                    "detail" => Some(1024),
                    "retry" => Some(256),
                    _ => None,
                };
                if let Some(limit) = limit {
                    if text.len() > limit {
                        return Err(refused(
                            key,
                            format!(
                                "is {} bytes, over the {limit}-byte runner-contract limit",
                                text.len()
                            ),
                        ));
                    }
                }
                let grammar_ok = match key {
                    "module" => error_module_grammar_ok(text),
                    "code" => error_code_grammar_ok(text),
                    _ => true,
                };
                if !grammar_ok {
                    return Err(refused(key, "breaks its runner-contract grammar".into()));
                }
            }
            Some(_) => {
                return Err(refused(key, "must be a string".into()));
            }
        }
    }
    Ok(())
}

fn native(message: &Value) -> Result<NativeMessage, HandlerOutcome> {
    for block in message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let is_error_output = block.get("type").and_then(Value::as_str) == Some("tool_result")
            && block.pointer("/output/kind").and_then(Value::as_str) == Some("error");
        if is_error_output {
            if let Some(output) = block.get("output") {
                check_error_output(output)?;
            }
        }
    }
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
                    // The composed model text reaches the CK type, so
                    // summarizer input, tag text, token estimates and ctx_expand
                    // all see what the model sees. The structured siblings stay
                    // on the retained native block for re-encoding.
                    NativeOutput::Error {
                        message,
                        module,
                        code,
                        detail,
                        nothing_sent,
                        retry,
                    } => CkOutputKind::ErrorText {
                        text: error_model_text(
                            &message,
                            module.as_deref(),
                            code.as_deref(),
                            detail.as_deref(),
                            nothing_sent.unwrap_or(false),
                            retry.as_deref(),
                        ),
                    },
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
    let ck = CkWireMessage::from_parts(
        parsed.role,
        content,
        None,
        extras,
        // Broca's messages carry no id of their own, so a rendered view is
        // matched back to its source messages by this ordinal. Without it
        // every rendered message looks engine-authored and is served as a
        // copy inside the view's replacement instead of as the runner's own
        // message.
        HarnessMeta {
            ordinal: Some(message.ordinal),
            ..HarnessMeta::default()
        },
    );
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
                        } else if let Some(output) =
                            raw.and_then(|v| v.get("output")).filter(|output| {
                                output.get("kind").and_then(Value::as_str) == Some("error")
                                    && output.get("message").and_then(Value::as_str).is_some()
                            })
                        {
                            // Rebuild the outage shape in the Broca capture's
                            // order. The structured fields ride the retained
                            // native block, never the CK text. An unchanged
                            // block serves the retained output verbatim, so the
                            // runner gets back exactly its bytes. An edited
                            // block is reconciled against the retained field
                            // lines so that what Broca renders to the model
                            // (`message` plus one line per sibling) always
                            // equals the edited CK text: a prefix edit keeps
                            // the siblings with the suffix stripped from
                            // `message`, while a placeholder or any edit to
                            // the field lines becomes a plain error with no
                            // siblings. Absent siblings stay absent.
                            //
                            // `suffix` is the field-lines tail of the composed
                            // text the retained output renders as (empty for a
                            // plain error); `composed` starts with `message`,
                            // so this split is always on a char boundary.
                            let retained_message = output["message"].as_str().unwrap_or_default();
                            let composed = error_model_text(
                                retained_message,
                                output.get("module").and_then(Value::as_str),
                                output.get("code").and_then(Value::as_str),
                                output.get("detail").and_then(Value::as_str),
                                output.get("nothing_sent").and_then(Value::as_bool) == Some(true),
                                output.get("retry").and_then(Value::as_str),
                            );
                            let suffix = &composed[retained_message.len()..];
                            if text == &composed {
                                output.clone()
                            } else if !suffix.is_empty() {
                                match text.strip_suffix(suffix) {
                                    Some(head) => {
                                        let mut value = json!({"kind":"error","message":head});
                                        for key in
                                            ["module", "code", "detail", "nothing_sent", "retry"]
                                        {
                                            if let Some(field) = output.get(key) {
                                                value[key] = field.clone();
                                            }
                                        }
                                        value
                                    }
                                    // The field lines changed: keep only the
                                    // edited text, as a plain error.
                                    None => json!({"kind":"error","message":text}),
                                }
                            } else {
                                json!({"kind":"error","message":text})
                            }
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
    fn broca_decode_carries_the_source_ordinal() {
        let entry = codec::InboundMessage {
            mid: "m7".into(),
            ordinal: 7,
            message: json!({"role":"user","content":[{"type":"text","text":"hi"}]}),
        };
        let decoded = Codec::OwnedBroca.decode_message(&entry).unwrap();
        assert_eq!(decoded.ck.meta.ordinal, Some(7));
        assert_eq!(
            bytes(&encode_message(&decoded.ck).unwrap()).unwrap(),
            bytes(&entry.message).unwrap(),
            "the ordinal is engine metadata and never reaches Broca's wire"
        );
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
