//! Immutable Anthropic replacement bytes belong to one route's project/session,
//! codec/provider generation and transcript branch; another route cannot borrow them.
//! The branch a view belongs to is the lineage it was built on, not the lineage
//! that stepped last (see `provider_native_view_read`).
use super::*;
use compact::view::{
    FrozenView, NativeEndpoint, RawPayload, ViewReadAnswer, ViewReadRefusal, ViewReadRequest,
    ViewRef,
};

fn invalid_view() -> HandlerOutcome {
    error(
        "native_view_invalid",
        "native view bytes, scope or boundary differ from the frozen object",
    )
}

pub(super) fn frozen_for_plan(
    key: &Key,
    engine: &transform::compaction::View,
    conversation: &mc_store::provider_records::ProviderConversation,
    endpoint: Option<&NativeEndpoint>,
    raw: &[String],
) -> Result<Option<Box<FrozenView>>, HandlerOutcome> {
    let plan: hooks::subscription::DeclareRequest = serde_json::from_str(
        conversation
            .native_plan_json
            .as_deref()
            .ok_or_else(invalid_view)?,
    )
    .map_err(|_| invalid_view())?;
    if endpoint.is_none() && plan.claude_code.is_none() {
        return Ok(None);
    }
    freeze(key, engine, endpoint, raw).map(|view| Some(Box::new(view)))
}

pub(super) fn identity(
    key: &Key,
    engine: &transform::compaction::View,
    label: &str,
    bytes: &str,
) -> ViewRef {
    let coordinates = json!([
        label,
        key.store_key().conversation_key(),
        engine.compaction_id,
        engine.version,
        engine.range.lineage_id,
        engine.range.from,
        engine.range.to
    ]);
    ViewRef {
        view_id: format!(
            "mc-native-view:{}",
            sha256_hex(&serde_json::to_vec(&coordinates).expect("view coordinates"))
        ),
        version: engine.version,
        byte_length: bytes.len() as u64,
        sha256: sha256_hex(bytes.as_bytes()),
    }
}

pub(super) fn freeze(
    key: &Key,
    engine: &transform::compaction::View,
    endpoint: Option<&NativeEndpoint>,
    raw: &[String],
) -> Result<FrozenView, HandlerOutcome> {
    let generation = key.generation.as_ref().ok_or_else(invalid_view)?;
    let endpoint = endpoint
        .ok_or_else(|| {
            error(
                "native_endpoint_missing",
                "native replacement has no covered original endpoint",
            )
        })?
        .clone();
    let bytes = format!("[{}]", raw.join(","));
    let view = FrozenView {
        view: identity(key, engine, "full", &bytes),
        profile: "claude-code-anthropic".into(),
        profile_generation: generation.profile.clone(),
        provider_generation: generation.provider.clone(),
        lineage_id: engine.range.lineage_id.clone(),
        endpoint,
        payload: RawPayload::Inline { bytes },
        cut_replacement_ref: None,
        retained_tail: None,
    };
    view.validate().map_err(|_| invalid_view())?;
    Ok(view)
}

pub(super) fn validate(key: &Key, host: &compaction::HostView) -> Result<(), HandlerOutcome> {
    // The initial native Setup is an empty insertion, so no original part is
    // covered and there are no replacement bytes requiring a native endpoint.
    if host.engine.range.from == 0
        && host.engine.range.to == 0
        && host.engine.replacement.is_empty()
        && host.wire.range.from == 0
        && host.wire.range.to == 0
        && host.wire.replacement.is_empty()
        && host.wire.raw_view.is_none()
        && host.coverage.is_none()
        && host.raw_replacement.as_ref().is_some_and(Vec::is_empty)
        && host.wire.version == host.engine.version
        && host.wire.compaction_id == host.engine.compaction_id
    {
        return Ok(());
    }
    // Plans without a Claude Code capability selection use ordinary working-range
    // replacements. Until compaction replaces a history prefix with a summary,
    // there is no original covered endpoint to identify for a hook prefix cut.
    if host.wire.raw_view.is_none() && host.coverage.is_none() {
        let raw = host.raw_replacement.as_ref().ok_or_else(invalid_view)?;
        if host.wire.version == host.engine.version
            && host.wire.compaction_id == host.engine.compaction_id
            && host.wire.range.from == host.engine.range.from
            && host.wire.range.to == host.engine.range.to
            && raw
                .iter()
                .map(|raw| serde_json::from_str::<Value>(raw))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| invalid_view())?
                == host.wire.replacement
        {
            return Ok(());
        }
        return Err(invalid_view());
    }
    let frozen = host.wire.raw_view.as_deref().ok_or_else(invalid_view)?;
    let raw = host.raw_replacement.as_deref().ok_or_else(invalid_view)?;
    let endpoint = host
        .coverage
        .as_ref()
        .and_then(|coverage| coverage.endpoint.as_ref());
    let expected = freeze(key, &host.engine, endpoint, raw)?;
    if frozen.view != expected.view
        || frozen.profile != expected.profile
        || frozen.profile_generation != expected.profile_generation
        || frozen.provider_generation != expected.provider_generation
        || frozen.lineage_id != expected.lineage_id
        || frozen.endpoint != expected.endpoint
        || frozen.payload != expected.payload
        || host.wire.version != host.engine.version
        || host.wire.compaction_id != host.engine.compaction_id
        || host.wire.range.from != host.engine.range.from
        || host.wire.range.to != host.engine.range.to
        || host
            .coverage
            .as_ref()
            .is_none_or(|coverage| coverage.end_mid != frozen.endpoint.message_id)
    {
        return Err(invalid_view());
    }
    frozen.validate().map_err(|_| invalid_view())?;
    super::native_cut::validate(key, host)?;
    let RawPayload::Inline { bytes } = &frozen.payload else {
        return Err(invalid_view());
    };
    if serde_json::from_str::<Vec<Value>>(bytes).map_err(|_| invalid_view())?
        != host.wire.replacement
    {
        return Err(invalid_view());
    }
    Ok(())
}

fn page(
    request: &ViewReadRequest,
    view: &ViewRef,
    raw: &str,
    page_cap: usize,
) -> Result<ViewReadAnswer, ViewReadRefusal> {
    if request.view_id != view.view_id || request.version != view.version {
        return Err(ViewReadRefusal::UnknownVersion);
    }
    view.check_bytes(raw.as_bytes())?;
    if request.sha256 != view.sha256 {
        return Err(ViewReadRefusal::DigestMismatch);
    }
    let cursor =
        usize::try_from(request.byte_cursor).map_err(|_| ViewReadRefusal::InvalidCursor)?;
    if cursor > raw.len() || !raw.is_char_boundary(cursor) {
        return Err(ViewReadRefusal::InvalidCursor);
    }
    let mut end = cursor.saturating_add(page_cap).min(raw.len());
    while !raw.is_char_boundary(end) {
        end -= 1;
    }
    loop {
        let answer = ViewReadAnswer::Page {
            request_id: request.request_id.clone(),
            view: view.clone(),
            byte_cursor: request.byte_cursor,
            bytes: raw[cursor..end].to_owned(),
            next_byte_cursor: (end < raw.len()).then_some(end as u64),
        };
        if serde_json::to_vec(&answer)
            .map_err(|_| ViewReadRefusal::EnvelopeTooLarge)?
            .len()
            < HOST_ENVELOPE_BYTES
        {
            return if end == cursor && cursor != raw.len() {
                Err(ViewReadRefusal::EnvelopeTooLarge)
            } else {
                Ok(answer)
            };
        }
        if end == cursor {
            return Err(ViewReadRefusal::EnvelopeTooLarge);
        }
        end = cursor + (end - cursor) / 2;
        while !raw.is_char_boundary(end) {
            end -= 1;
        }
    }
}

impl McHandler {
    pub(super) async fn provider_native_view_read(
        &self,
        binding: SessionBinding,
        params: &Value,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        if serde_json::to_vec(params).map_err(invalid)?.len() >= HOST_ENVELOPE_BYTES {
            return Err(invalid_field(
                "raw_view",
                "view read exceeds the native envelope ceiling",
            ));
        }
        let request: ViewReadRequest = decode(params)?;
        if request.request_id.is_empty() || request.request_id.len() > 256 {
            return Err(invalid_field(
                "request_id",
                "view read request identity must be nonempty and bounded",
            ));
        }
        let key = Key::new(&binding, &binding.session, &binding.harness)?;
        let store = self
            .store_for_request()
            .await
            .map_err(StoreRefusal::into_outcome)?;
        let _serial = self.provider_serial.lock_for(&key).await;
        let _route = self.native_publication_fence(&binding)?;
        let result = (|| {
            let pins = self.native_pins();
            if !pins.raw_view_read {
                return Err(ViewReadRefusal::UnavailableLane);
            }
            let conversation = store
                .load_provider_conversation(&key.store_key())
                .map_err(|_| ViewReadRefusal::InvalidView)?
                .ok_or(ViewReadRefusal::UnavailableLane)?;
            // The recipe resolver streams the stored raw messages and checks the
            // frozen digests and lengths before materializing the inline bytes.
            let host = super::view_recipe::load(&store, &key, request.version)
                .map_err(|_| ViewReadRefusal::InvalidView)?
                .ok_or(ViewReadRefusal::UnknownVersion)?;
            // Replacement bytes are served only for their own transcript branch,
            // and the anchor is the view's own lineage, not whichever lineage
            // stepped last: a fork and its parent step in turn, and each reads
            // the view its own step was just answered with. So a view is
            // readable when it is on the conversation's current lineage, or
            // when it is the view its own, still-held lineage was named in its
            // newest step answer. The read request does not identify the
            // reader's lineage, so the second case is decided by the view alone.
            let answered = store
                .provider_lineage_answered_views(&key.store_key())
                .map_err(|_| ViewReadRefusal::InvalidView)?;
            let own_branch = host.engine.range.lineage_id == conversation.lineage_id
                || answered.get(&host.engine.range.lineage_id) == Some(&request.version);
            if host.engine.version != request.version || !own_branch {
                return Err(ViewReadRefusal::UnknownVersion);
            }
            validate(&key, &host).map_err(|_| ViewReadRefusal::InvalidView)?;
            let frozen = host
                .wire
                .raw_view
                .as_deref()
                .ok_or(ViewReadRefusal::InvalidView)?;
            let RawPayload::Inline { bytes } = &frozen.payload else {
                return Err(ViewReadRefusal::InvalidView);
            };
            if let Some(cut) = &host.cut_replacement {
                if request.view_id == cut.reference.view_id {
                    return page(
                        &request,
                        &cut.reference,
                        &cut.bytes,
                        pins.caps.view_page_bytes,
                    );
                }
            }
            page(&request, &frozen.view, bytes, pins.caps.view_page_bytes)
        })();
        bytes(&result.unwrap_or_else(|code| ViewReadAnswer::Refuse {
            request_id: request.request_id,
            code,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RAW: &str = r#"{ "content":[{"type":"thinking","thinking":"caf\u00e9","signature":"sig\\x"},{"type":"redacted_thinking","data":"opaque=="}], "role":"assistant" }"#;

    #[tokio::test]
    async fn negotiated_native_publication_requires_original_endpoint() {
        use crate::providers::claude_code_tests as cc;
        let dir = tempfile::tempdir().unwrap();
        let h = cc::handler(dir.path(), cc::thalamus());
        let binding = h.facade_binding(7).unwrap();
        let declare = json!({"preset":"head","params":{"serializer_profile":"claude-code-anthropic","observation":"answer"},"composition":{},"claude_code":h.native_pins()});
        h.admit_native_plan(7, &binding, "transform.declare", &declare)
            .await
            .unwrap();
        let binding = h.facade_binding(7).unwrap();
        let setup = json!({"session":"cc","harness":"claude-code","request_id":"setup","preset":"head","params":declare["params"],"composition":{},"claude_code":declare["claude_code"],"model":"fixture","context_window":100000,"lineage_id":"L","now":1});
        h.provider_setup(binding.clone(), &setup).await.unwrap();
        let mut status = cc::step(r#"{ "role":"user","content":"not folded" }"#);
        status["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
        let response = h.provider_step(binding, &status).await.unwrap();
        let answer: Value = serde_json::from_slice(&response).unwrap();
        assert_eq!(answer["answer"], "refuse");
        assert_eq!(answer["provider_code"], "native_endpoint_missing");
        assert!(answer.get("compaction").is_none());
    }

    fn fixture() -> (Key, compaction::HostView) {
        let key = Key {
            project: PathBuf::from("/project"),
            session: "agent".into(),
            harness: "claude-code".into(),
            generation: Some(mc_store::provider_records::ProviderGeneration {
                profile: "native-v1".into(),
                provider: "provider-v1".into(),
            }),
        };
        let engine = transform::compaction::View {
            compaction_id: "compaction".into(),
            version: 7,
            range: transform::compaction::Range {
                lineage_id: "L".into(),
                from: 0,
                to: 2,
            },
            replacement: vec![],
        };
        let raw = vec![RAW.into()];
        let endpoint = NativeEndpoint {
            message_id: "m".into(),
            part_index: 1,
        };
        let wire = compact::answer::CompactionMessage::new(
            "compaction",
            7,
            compact::answer::Range::new(0, 2),
            vec![serde_json::from_str(RAW).unwrap()],
        )
        .with_raw_view(freeze(&key, &engine, Some(&endpoint), &raw).unwrap());
        (
            key,
            compaction::HostView {
                engine,
                wire,
                coverage: Some(compaction::HostCoverage {
                    end_mid: "m".into(),
                    ordinal: 0,
                    endpoint: Some(endpoint),
                }),
                raw_replacement: Some(raw),
                head_slots: None,
                cut_replacement: None,
            },
        )
    }

    #[test]
    fn frozen_native_view_preserves_actual_signed_bytes_and_rejects_scope_or_digest_drift() {
        let (key, mut host) = fixture();
        validate(&key, &host).unwrap();
        let frozen = host.wire.raw_view.as_deref().unwrap();
        let RawPayload::Inline { bytes } = &frozen.payload else {
            panic!("inline")
        };
        assert_eq!(bytes, &format!("[{RAW}]"));
        assert_eq!(frozen.view.byte_length, bytes.len() as u64);
        assert_eq!(frozen.profile_generation, "native-v1");
        assert_eq!(frozen.provider_generation, "provider-v1");
        let mut other = key.clone();
        other.generation.as_mut().unwrap().provider = "provider-v2".into();
        assert!(validate(&other, &host).is_err());
        other = key.clone();
        other.session = "subagent".into();
        assert!(validate(&other, &host).is_err());
        host.wire.raw_view.as_mut().unwrap().view.sha256 = "0".repeat(64);
        assert!(validate(&key, &host).is_err());
        host.wire.raw_view = Some(Box::new(
            freeze(
                &key,
                &host.engine,
                host.coverage.as_ref().unwrap().endpoint.as_ref(),
                host.raw_replacement.as_deref().unwrap(),
            )
            .unwrap(),
        ));
        host.wire.raw_view.as_mut().unwrap().endpoint.part_index = 0;
        assert!(validate(&key, &host).is_err());
    }

    #[test]
    fn frozen_pages_rejoin_utf8_and_refuse_wrong_identity_digest_and_cursor() {
        let raw = "雪\\\"\n".repeat(HOST_ENVELOPE_BYTES / 4);
        let view = ViewRef {
            view_id: "frozen".into(),
            version: 5,
            byte_length: raw.len() as u64,
            sha256: sha256_hex(raw.as_bytes()),
        };
        let mut request = ViewReadRequest {
            request_id: "read".into(),
            view_id: view.view_id.clone(),
            version: 5,
            sha256: view.sha256.clone(),
            byte_cursor: 0,
        };
        let mut joined = String::new();
        let mut pages = 0;
        loop {
            let answer = page(&request, &view, &raw, HOST_ENVELOPE_BYTES - 1).unwrap();
            assert!(serde_json::to_vec(&answer).unwrap().len() < HOST_ENVELOPE_BYTES);
            let ViewReadAnswer::Page {
                bytes,
                next_byte_cursor,
                ..
            } = answer
            else {
                panic!("page")
            };
            joined.push_str(&bytes);
            pages += 1;
            let Some(cursor) = next_byte_cursor else {
                break;
            };
            request.byte_cursor = cursor;
        }
        assert_eq!(joined, raw);
        assert!(pages > 1);
        request.byte_cursor = 1;
        assert_eq!(
            page(&request, &view, &raw, 32),
            Err(ViewReadRefusal::InvalidCursor)
        );
        request.byte_cursor = 0;
        request.sha256 = "0".repeat(64);
        assert_eq!(
            page(&request, &view, &raw, 32),
            Err(ViewReadRefusal::DigestMismatch)
        );
        request.sha256 = view.sha256.clone();
        request.view_id = "borrowed".into();
        assert_eq!(
            page(&request, &view, &raw, 32),
            Err(ViewReadRefusal::UnknownVersion)
        );
        request.view_id = view.view_id.clone();
        request.version = 6;
        assert_eq!(
            page(&request, &view, &raw, 32),
            Err(ViewReadRefusal::UnknownVersion)
        );
    }
}
