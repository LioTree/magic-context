//! Tests for exact hook-replacement tails and requests queued across connection
//! rebinding. Each test uses a temporary store, without live stores or LLM runners.
use super::*;
use crate::providers::claude_code_tests as cc;
use native_cut::attach;

fn review_request(entries: &[(&str, &str)]) -> TransformRequest {
    let messages = entries
        .iter()
        .enumerate()
        .map(|(ordinal, (mid, raw))| compact::status::StatusMessage {
            mid: (*mid).into(),
            ordinal: ordinal as u64,
            message: codec_claude_code::from_wire(&serde_json::from_str(raw).unwrap(), Some(raw))
                .unwrap(),
            raw_message: None,
        })
        .collect::<Vec<_>>();
    let mut request: TransformRequest = decode(&json!({"v":2,"kind":"compaction.step","serializer_profile":"claude-code-anthropic","session_id":"main","render_config":"","messages":[],"tool_present":false,"auto_search_enabled":false})).unwrap();
    codec::Codec::ClaudeCodeAnthropic
        .prepare_request(&mut request, &messages)
        .unwrap();
    request
}

fn review_engine(request: &TransformRequest) -> transform::compaction::View {
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
    transform::compaction::View {
        compaction_id: "compaction".into(),
        version: 5,
        range: transform::compaction::Range {
            lineage_id: "L".into(),
            from: 0,
            to: request.messages.len() as u64,
        },
        replacement,
    }
}

fn review_host(
    request: &TransformRequest,
    engine: transform::compaction::View,
) -> (Key, compaction::HostView) {
    let key = Key {
        project: PathBuf::from("/project"),
        session: "main".into(),
        harness: "claude-code".into(),
        generation: Some(mc_store::provider_records::ProviderGeneration {
            profile: "format".into(),
            provider: "provider".into(),
        }),
    };
    let endpoint = compact::view::NativeEndpoint {
        message_id: "covered".into(),
        part_index: 0,
    };
    let (mut wire, raw) = codec_claude_code::encode_view(&engine, request, Some(0)).unwrap();
    wire.raw_view = Some(Box::new(
        native_view::freeze(&key, &engine, Some(&endpoint), &raw).unwrap(),
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
    (key, host)
}

#[test]
fn review_hook_cut_identical_messages_keep_distinct_ordered_handles() {
    const SAME: &str = r#"{ "role":"user", "content":"identical\u0021" }"#;
    let request = review_request(&[
        ("covered", r#"{"role":"user","content":"history"}"#),
        ("left", SAME),
        ("right", SAME),
    ]);
    let engine = review_engine(&request);
    let (key, mut host) = review_host(&request, engine.clone());
    attach(&key, &mut host, &request).unwrap();
    let tail = host
        .wire
        .raw_view
        .as_ref()
        .unwrap()
        .retained_tail
        .as_ref()
        .unwrap();
    assert_eq!(
        tail.iter()
            .map(|part| part.engine_handle.as_str())
            .collect::<Vec<_>>(),
        ["left#0", "right#0"]
    );
    let head = &host.cut_replacement.as_ref().unwrap().bytes;
    let compact::view::RawPayload::Inline { bytes: full } =
        &host.wire.raw_view.as_ref().unwrap().payload
    else {
        panic!("expected inline view")
    };
    assert_eq!(
        format!("[{},{}]", &head[1..head.len() - 1], [SAME, SAME].join(",")),
        *full
    );

    // The retained left/right messages have equal bytes but distinct gateway MIDs.
    let mut swapped = engine.clone();
    swapped.replacement.swap(3, 4);
    let (key, mut host) = review_host(&request, swapped);
    assert!(
        matches!(attach(&key, &mut host, &request), Err(HandlerOutcome::Error { code, .. }) if code == "native_hook_cut_unrepresentable")
    );
    assert!(host.cut_replacement.is_none());
    assert!(host
        .wire
        .raw_view
        .as_ref()
        .unwrap()
        .cut_replacement_ref
        .is_none());

    let mut removed = engine;
    removed.replacement.pop();
    let (key, mut host) = review_host(&request, removed);
    assert!(
        matches!(attach(&key, &mut host, &request), Err(HandlerOutcome::Error { code, .. }) if code == "native_hook_cut_unrepresentable")
    );
    assert!(host.cut_replacement.is_none());
}

#[test]
fn review_hook_cut_rendered_tail_edit_refuses_before_reference_publication() {
    let request = review_request(&[
        ("covered", r#"{"role":"user","content":"history"}"#),
        ("tail", r#"{ "role":"user", "content":"original\u0021" }"#),
    ]);
    let mut engine = review_engine(&request);
    engine.replacement.last_mut().unwrap().content[0].kind = ck_wire::CkKind::Text {
        text: "edited!".into(),
    };
    let (key, mut host) = review_host(&request, engine);
    assert!(host
        .raw_replacement
        .as_ref()
        .unwrap()
        .last()
        .unwrap()
        .contains("edited!"));
    assert!(
        matches!(attach(&key, &mut host, &request), Err(HandlerOutcome::Error { code, .. }) if code == "native_hook_cut_unrepresentable")
    );
    assert!(host.cut_replacement.is_none());
    let frozen = host.wire.raw_view.as_ref().unwrap();
    assert!(frozen.cut_replacement_ref.is_none());
    assert!(frozen.retained_tail.is_none());
}

#[test]
fn review_hook_cut_retained_signed_thinking_rejects_changed_binding() {
    let request = review_request(&[
        ("covered", r#"{"role":"user","content":"history"}"#),
        (
            "signed",
            r#"{ "role":"assistant", "content":[{"type":"thinking","thinking":"private","signature":"s"},{"type":"text","text":"tail"}] }"#,
        ),
    ]);
    let mut unchanged = review_engine(&request);
    unchanged.replacement = request
        .messages
        .iter()
        .map(|entry| entry.ck.clone())
        .collect();
    assert!(codec_claude_code::encode_view(&unchanged, &request, None).is_ok());
    let cut = review_engine(&request);
    assert!(
        matches!(codec_claude_code::encode_view(&cut, &request, Some(0)), Err(HandlerOutcome::Error { code, .. }) if code == "signed_prefix_edit")
    );
}

fn pins(generation: &str) -> hooks::claude_code::ClaudeCodeCapabilities {
    let mut pins = capability_candidate::CANDIDATE.clone();
    pins.profile_generation = "native-format-v1".into();
    pins.provider_generation = generation.into();
    pins
}

fn key(h: &McHandler) -> Key {
    Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap()
}

#[tokio::test]
async fn review_witness_old_generation_step_commits_after_rebind() {
    use std::future::Future;
    use std::task::{Context, Poll, Waker};

    let dir = tempfile::tempdir().unwrap();
    let h = cc::handler(dir.path(), cc::thalamus());
    *h.native_bundle_override.lock().unwrap() = Some(pins("generation-a"));
    cc::setup(&h).await;
    let old_key = key(&h);
    let params = cc::step(r#"{"role":"user","content":"late old generation"}"#);
    let serial = h.provider_serial.lock_for(&old_key).await;
    let mut pending = Box::pin(cc::call(&h, "compaction.step", params));
    let mut cx = Context::from_waker(Waker::noop());
    assert!(matches!(pending.as_mut().poll(&mut cx), Poll::Pending));
    // The dispatch first locks to validate its plan, then locks again to write.
    // Queue another lock holder between those phases so the connection can be
    // rebound after validation but before the old request writes or responds.
    let mut competing = Box::pin(h.provider_serial.lock_for(&old_key));
    assert!(matches!(competing.as_mut().poll(&mut cx), Poll::Pending));
    drop(serial);
    assert!(matches!(pending.as_mut().poll(&mut cx), Poll::Pending));
    let serial = match competing.as_mut().poll(&mut cx) {
        Poll::Ready(serial) => serial,
        Poll::Pending => panic!("competing operation should own the serial lock"),
    };
    assert!(matches!(
        pending
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop())),
        Poll::Pending
    ));
    assert!(h
        .store
        .get()
        .unwrap()
        .load_provider_messages(&old_key.store_key(), "L")
        .unwrap()
        .is_empty());

    h.bind_route(7, cc::binding(dir.path(), cc::thalamus()));
    *h.native_bundle_override.lock().unwrap() = Some(pins("generation-b"));
    cc::setup(&h).await;
    let new_key = key(&h);
    assert_ne!(
        old_key.store_key().conversation_key(),
        new_key.store_key().conversation_key()
    );
    drop(serial);

    // The queued request belongs to the replaced connection and generation;
    // accepting its write and response after the new Setup demonstrates the defect.
    let HandlerOutcome::Response(bytes) = pending.await else {
        panic!("old admitted step no longer publishes a response")
    };
    let answer: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(answer["answer"], "compaction_message");
    let store = h.store.get().unwrap();
    assert_eq!(
        store
            .load_provider_messages(&old_key.store_key(), "L")
            .unwrap()
            .len(),
        1
    );
    assert!(store
        .load_provider_messages(&new_key.store_key(), "L")
        .unwrap()
        .is_empty());
}
