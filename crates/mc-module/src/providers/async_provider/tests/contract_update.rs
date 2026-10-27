//! compaction-provider 0.7.2's account change, 0.7.1's pruned-reasoning
//! re-reads (with llm-runner 0.7.4's archive pruning), and the async
//! decision log.
use super::*;
use cortexkit_role_llm_runner::archive_prunes_reasoning::kinds;

const ACCOUNT: &str = "Route_1.a-b";

fn decision_lines(rig: &Rig) -> Vec<String> {
    rig.h
        .provider_store
        .async_runtime
        .decision_lines
        .lock()
        .unwrap()
        .clone()
}

/// The decision line logged for notice `seq`.
fn notice_line(rig: &Rig, seq: u64) -> String {
    let marker = format!(" notice seq={seq} ");
    decision_lines(rig)
        .into_iter()
        .rfind(|line| line.contains(&marker))
        .unwrap_or_else(|| {
            panic!(
                "no decision line for notice {seq}: {:?}",
                decision_lines(rig)
            )
        })
}

/// Forty messages read at low usage, with three tool results queued for
/// dropping: cleanup a rebuild may land but a low-usage notice defers.
async fn rig_with_pending_cleanup(dir: &Path) -> Rig {
    let rig = Rig::new(dir).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    assert_eq!(rig.newest(), None, "low usage publishes nothing");
    rig.queue(&[163, 166, 169]).await;
    rig
}

async fn ride_with(rig: &Rig, params: Value) -> Value {
    rig.op("compaction.ride", params).await
}

/// compaction-provider 0.7.2: a ride with cause `account_change` (the runner
/// picked a new account before the request) folds exactly as a
/// `model_change` ride does: one rebuild that also lands the pending cleanup,
/// with the same view and the same bytes. Its decision line names the cause
/// and never the account label.
#[tokio::test]
async fn account_change_ride_folds_exactly_like_model_change() {
    let model_dir = tempfile::tempdir().unwrap();
    let account_dir = tempfile::tempdir().unwrap();
    let model = rig_with_pending_cleanup(model_dir.path()).await;
    let account = rig_with_pending_cleanup(account_dir.path()).await;
    let model_answer = ride_with(
        &model,
        json!({"session_ref":model.reference,"cause":"model_change","deadline_ms":10_000}),
    )
    .await;
    let account_answer = ride_with(
        &account,
        json!({"session_ref":account.reference,"cause":"account_change","account":ACCOUNT,"deadline_ms":10_000}),
    )
    .await;
    assert_eq!(model_answer["answer"], "view", "{model_answer}");
    assert_eq!(account_answer["answer"], "view", "{account_answer}");
    let model_view: view::CompactionView = decode(&model_answer["view"]).unwrap();
    let account_view: view::CompactionView = decode(&account_answer["view"]).unwrap();
    assert_eq!(account_view.view_version, model_view.view_version);
    assert_eq!(account_view.ranges, model_view.ranges);
    assert_eq!(account.render(&account_view), model.render(&model_view));
    assert_eq!(account_answer["cache_ttl"], model_answer["cache_ttl"]);
    // The pending cleanup landed in that one rebuild.
    let dropped = |view: &view::CompactionView| {
        view.ranges.iter().any(|range| match range {
            view::ViewRange::Keep { edits, .. } => edits.iter().any(|edit| edit.ordinal == 21),
            view::ViewRange::Replace { from, to, .. } => *from <= 21 && 21 < *to,
            _ => false,
        })
    };
    assert!(
        dropped(&account_view),
        "the queued drop lands in the rebuild"
    );
    let line = decision_lines(&account)
        .into_iter()
        .find(|line| line.contains("ride cause="))
        .expect("the ride logs its decision");
    assert!(line.starts_with("async decision ride "), "{line}");
    assert!(line.contains("ride cause=account_change"), "{line}");
    assert!(!line.contains(ACCOUNT), "the label is never logged: {line}");
    // The label is stored nowhere: the ride carries no fact ck-mc keeps.
    let store = account.h.store.get().unwrap();
    let raw = store
        .load_async_compaction(&account.reference)
        .unwrap()
        .unwrap();
    assert!(!raw.contains(ACCOUNT), "the ride's label is not stored");
}

/// compaction-provider 0.7.2: the account label is required on an
/// `account_change` ride and must be 1-64 bytes of `[A-Za-z0-9._-]`. A
/// missing or malformed one is refused naming the `account` member, and the
/// refusal never echoes the label.
#[tokio::test]
async fn account_change_ride_without_a_valid_account_is_refused_by_member() {
    let dir = tempfile::tempdir().unwrap();
    let rig = rig_with_pending_cleanup(dir.path()).await;
    for account in [
        None,
        Some(""),
        Some("route/account"),
        Some(&*"a".repeat(65)),
    ] {
        let mut params =
            json!({"session_ref":rig.reference,"cause":"account_change","deadline_ms":10_000});
        if let Some(account) = account {
            params["account"] = json!(account);
        }
        match rig
            .h
            .dispatch_value(7, json!({"method":"compaction.ride","params":params}))
            .await
        {
            HandlerOutcome::ErrorWithDetail {
                code,
                detail,
                message,
            } => {
                assert_eq!(code, "invalid_params", "{account:?}");
                assert_eq!(detail, json!({"field":"account"}), "{account:?}");
                if let Some(label) = account.filter(|label| !label.is_empty()) {
                    assert!(!message.contains(label), "{message}");
                }
            }
            other => panic!("{account:?} was not refused: {other:?}"),
        }
    }
    assert_eq!(rig.newest(), None, "a refused ride rebuilds nothing");
}

/// compaction-provider 0.7.2: the `account_change:<account>` notice event
/// reports a switch the runner learned only after the new account's cache
/// was written. ck-mc records it with the notice and never rebuilds for it:
/// the pending cleanup a rebuild would land stays pending, and the decision
/// line names the event without its label.
#[tokio::test]
async fn account_change_notice_event_is_recorded_and_never_rebuilds() {
    let dir = tempfile::tempdir().unwrap();
    let rig = rig_with_pending_cleanup(dir.path()).await;
    let pending = rig.pending_targets();
    assert!(!pending.is_empty());
    rig.notice_with(
        2,
        1_000,
        None,
        None,
        vec![notice::Event::AccountChange(ACCOUNT.into())],
    )
    .await;
    assert_eq!(rig.newest(), None, "the event never rebuilds");
    assert_eq!(rig.pending_targets(), pending, "nothing landed");
    let state = rig.state();
    assert_eq!(
        state.acknowledgements,
        vec![format!("account_change:{ACCOUNT}")],
        "the notice's event is recorded with the notice"
    );
    let line = notice_line(&rig, 2);
    assert!(line.starts_with("async decision defer "), "{line}");
    assert!(line.contains("events=[account_change]"), "{line}");
    assert!(!line.contains(ACCOUNT), "the label is never logged: {line}");
}

/// The last held message of the pruning fixture: an assistant message whose
/// reasoning part comes before its text.
const PRUNED_ORDINAL: u64 = 39;

fn reasoning_fixture(rig: &Rig) -> (Value, Value) {
    let mut entries = rig.runner.entries.lock().unwrap();
    let entry = entries
        .iter_mut()
        .find(|entry| entry.ordinal == PRUNED_ORDINAL)
        .unwrap();
    let original = json!({"id":"p39r","type":"reasoning","text":"weighing which file to read next","metadata":{"anthropic":{"signature":"invented-signature-39"}}});
    let text = entry.message["parts"][0].clone();
    entry.message["parts"] = json!([original.clone(), text]);
    entry.tags = vec![
        tags::PartTag::untagged("0"),
        tags::PartTag::tagged("1", format!("§{}§", 100 + PRUNED_ORDINAL * 3)),
    ];
    let mut pruned = entry.message.clone();
    pruned["parts"][0] = json!({"id":"p39r","type":"reasoning","text":""});
    (original, pruned)
}

/// Serve message 39 pruned at rest, listing its reasoning part as `kind`
/// with `sha256`.
fn prune(rig: &Rig, pruned: Value, kind: &str, sha256: String, bytes: u64) {
    rig.runner.pruned.lock().unwrap().insert(
        PRUNED_ORDINAL,
        (
            pruned,
            vec![json!({"mid":format!("m{PRUNED_ORDINAL}"),"part":"0","kind":kind,"bytes":bytes,"sha256":sha256})],
        ),
    );
}

async fn pruning_rig(dir: &Path) -> (Rig, Value, Value) {
    let rig = Rig::new(dir).await;
    rig.fill(40);
    let (original, pruned) = reasoning_fixture(&rig);
    rig.notice(1, 1_000, None).await;
    assert_eq!(rig.newest(), None);
    rig.queue(&[163, 166, 169]).await;
    (rig, original, pruned)
}

/// llm-runner 0.7.4 / compaction-provider 0.7.1: after the runner prunes
/// reasoning in an archived idle session, the re-read of a held message may
/// differ from the held copy only in the parts the page lists in
/// `pruned_reasoning`, with matching write-time digests. ck-mc accepts that
/// instead of refusing "async entry changed on re-read": the held copy and
/// its stored row are replaced in place, the lineage and generation do not
/// move, and the notice runs exactly one rebuild, which also lands the
/// pending cleanup. The next notice is ordinary again.
#[tokio::test]
async fn pruned_reasoning_reread_is_accepted_with_one_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, original, pruned) = pruning_rig(dir.path()).await;
    let control_dir = tempfile::tempdir().unwrap();
    let (control, _, _) = pruning_rig(control_dir.path()).await;
    let before = rig.state();
    prune(
        &rig,
        pruned.clone(),
        kinds::REASONING,
        contract::digest::content_digest(&original),
        serde_jcs::to_vec(&original).unwrap().len() as u64,
    );
    rig.notice(2, 1_000, None).await;
    control.notice(2, 1_000, None).await;
    assert_eq!(control.newest(), None, "without pruning the notice defers");
    let rebuilt = rig.newest().expect("the pruned re-read rebuilds once");
    let after = rig.state();
    assert_eq!(after.generation, before.generation, "no reset");
    assert_eq!(after.lineage, before.lineage);
    assert!(!after.resync);
    assert!(!after.pruned_rebuild_pending, "the one rebuild is spent");
    let held = after.entries.get(&PRUNED_ORDINAL).unwrap().read().unwrap();
    assert_eq!(held.message, pruned, "the stored row holds the pruned copy");
    assert_eq!(
        held.part_digests,
        before
            .entries
            .get(&PRUNED_ORDINAL)
            .unwrap()
            .read()
            .unwrap()
            .part_digests
    );
    let line = notice_line(&rig, 2);
    assert!(line.starts_with("async decision execute "), "{line}");
    assert!(line.contains("+pruned_reasoning_rebuild"), "{line}");
    assert!(
        rig.pending_targets().len() < 3,
        "the rebuild landed the cleanup"
    );
    rig.notice(3, 1_000, Some(rebuilt)).await;
    assert_eq!(
        rig.newest(),
        Some(rebuilt),
        "the next notice does not rebuild again"
    );
    assert!(!notice_line(&rig, 3).contains("pruned_reasoning_rebuild"));
}

/// The re-read rule is narrow: a listed digest that is not the part's
/// write-time digest, a kind the contract does not define, an unlisted
/// change and a listed part whose type changed are each still a changed
/// transcript, refused exactly as before.
#[tokio::test]
async fn pruned_reasoning_reread_outside_the_rule_is_still_refused() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, original, pruned) = pruning_rig(dir.path()).await;
    let digest = contract::digest::content_digest(&original);
    let bytes = serde_jcs::to_vec(&original).unwrap().len() as u64;
    let mut retyped = pruned.clone();
    retyped["parts"][0]["type"] = json!("text");
    let mut unlisted = pruned.clone();
    unlisted["parts"][1]["text"] = json!("rewritten text");
    for (name, served, kind, sha256) in [
        (
            "wrong digest",
            pruned.clone(),
            kinds::REASONING,
            "0".repeat(64),
        ),
        (
            "unknown kind",
            pruned.clone(),
            "future_kind",
            digest.clone(),
        ),
        (
            "unlisted change",
            unlisted,
            kinds::REASONING,
            digest.clone(),
        ),
        ("type changed", retyped, kinds::REASONING, digest.clone()),
    ] {
        prune(&rig, served, kind, sha256, bytes);
        let mut state = rig.state();
        let from = state.read_from();
        let read = rig
            .h
            .read_async_resumable(&mut state, from, Duration::from_secs(5))
            .await;
        match read {
            Err(HandlerOutcome::Error { message, .. }) => {
                assert_eq!(message, "async entry changed on re-read", "{name}")
            }
            other => panic!("{name}: {:?}", other.map(|_| ())),
        }
        assert!(!state.pruned_rebuild_pending, "{name}");
    }
    // Without any listing the changed message is refused too.
    rig.runner.pruned.lock().unwrap().clear();
    rig.runner
        .pruned
        .lock()
        .unwrap()
        .insert(PRUNED_ORDINAL, (pruned, Vec::new()));
    let mut state = rig.state();
    let from = state.read_from();
    assert!(rig
        .h
        .read_async_resumable(&mut state, from, Duration::from_secs(5))
        .await
        .is_err());
}

/// The resident path and the full-recompute oracle agree on a pruned
/// re-read: the same views, versions and decisions on both sides.
#[tokio::test]
async fn pruned_reasoning_reread_matches_the_full_recompute_oracle() {
    let dir = tempfile::tempdir().unwrap();
    let (rig, original, pruned) = pruning_rig(dir.path()).await;
    let oracle_dir = tempfile::tempdir().unwrap();
    let (oracle, _, _) = pruning_rig(oracle_dir.path()).await;
    oracle
        .h
        .provider_store
        .async_runtime
        .resident
        .lock()
        .unwrap()
        .oracle = true;
    for side in [&rig, &oracle] {
        prune(
            side,
            pruned.clone(),
            kinds::REASONING,
            contract::digest::content_digest(&original),
            serde_jcs::to_vec(&original).unwrap().len() as u64,
        );
        side.notice(2, 1_000, None).await;
    }
    let resident_view = rig.get(rig.newest().unwrap()).await;
    let oracle_view = oracle.get(oracle.newest().unwrap()).await;
    assert_eq!(resident_view.view_version, oracle_view.view_version);
    assert_eq!(resident_view.ranges, oracle_view.ranges);
    assert_eq!(rig.render(&resident_view), oracle.render(&oracle_view));
}

/// Setup's ready answer opts in to archive pruning: compaction-provider
/// 0.7.1's `accepts: ["pruned_reasoning"]`, the exact name.
#[tokio::test]
async fn setup_answer_accepts_pruned_reasoning() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    let answer: compact::setup::SetupAnswer = decode(&rig.state().initial).unwrap();
    assert_eq!(
        answer.accepts(),
        &[compact::setup::ACCEPTS_PRUNED_REASONING]
    );
    assert_eq!(rig.state().initial["accepts"], json!(["pruned_reasoning"]));
}

/// A finished summary at low usage publishes nothing; the next notice at
/// the execute threshold publishes it. Each notice logs one decision line
/// with the usage it saw, the threshold and that a summary is waiting.
#[tokio::test]
async fn finished_summary_waits_for_the_execute_threshold() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(40);
    rig.notice(1, 1_000, None).await;
    assert_eq!(rig.newest(), None);
    let first = notice_line(&rig, 1);
    assert!(first.contains("summary_waiting=false"), "{first}");
    // A summary completes: the historian publishes compartments. Unlike a
    // flush, that arms no soft refresh.
    let namespace = rig.state().namespace();
    rig.h
        .store
        .get()
        .unwrap()
        .replace_compartments(
            &namespace,
            &[mc_store::StoredCompartment {
                sequence: 1,
                start_message: 0,
                end_message: 20,
                end_message_id: "m20#0".into(),
                title: "history".into(),
                content: "the finished summary".into(),
                p1: Some("the finished summary".into()),
                importance: 50,
                ..Default::default()
            }],
        )
        .unwrap();
    rig.notice(2, 1_000, None).await;
    assert_eq!(rig.newest(), None, "low usage publishes nothing");
    let low = notice_line(&rig, 2);
    assert!(low.starts_with("async decision defer "), "{low}");
    assert!(low.contains("usage=1.0%"), "{low}");
    assert!(low.contains("threshold=65.0%"), "{low}");
    assert!(low.contains("summary_waiting=true"), "{low}");
    rig.notice(3, 70_000, None).await;
    let version = rig.newest().expect("the execute threshold publishes it");
    let view = rig.get(version).await;
    let rendered = String::from_utf8(rig.render(&view)).unwrap();
    assert!(
        rendered.contains("the finished summary"),
        "the summary is in the view"
    );
    let high = notice_line(&rig, 3);
    assert!(high.starts_with("async decision execute "), "{high}");
    assert!(high.contains("usage=70.0%"), "{high}");
    assert!(high.contains("threshold=65.0%"), "{high}");
    assert!(high.contains("summary_waiting=true"), "{high}");
}

/// The decoded reasoning blocks of one message.
fn reasoning_blocks(codec: codec::Codec, message: Value) -> Vec<ck_wire::CkKind> {
    let decoded = codec
        .decode_message(&InboundMessage {
            ordinal: 1,
            mid: "m1".into(),
            message,
        })
        .unwrap_or_else(|error| panic!("{codec:?}: {error:?}"));
    decoded
        .ck
        .content
        .into_iter()
        .map(|block| block.kind)
        .filter(|kind| {
            matches!(
                kind,
                ck_wire::CkKind::Reasoning { .. } | ck_wire::CkKind::RedactedReasoning { .. }
            )
        })
        .collect()
}

/// Archive pruning empties reasoning to `text: ""` with no signature. That
/// shape decodes in all four native formats as empty reasoning, never a
/// refusal; owned-broca's pruned `redacted_reasoning` keeps its required
/// `data: ""` and its `provider_format`, and both owned-broca blocks go back
/// to the runner as its own bytes. The owned-broca samples are llm-runner
/// 0.7.9's published pruning vectors.
#[test]
fn empty_reasoning_decodes_in_all_four_formats() {
    let empty = ck_wire::CkKind::Reasoning {
        text: String::new(),
        signature: None,
    };
    let vectors: Value = serde_json::from_str(
        cortexkit_role_llm_runner::vectors::file("archive-prunes-reasoning.json").unwrap(),
    )
    .unwrap();
    let mut broca_blocks = 0;
    for case in vectors["cases"].as_array().unwrap() {
        let served = &case["served"];
        let expected = match served["type"].as_str().unwrap() {
            "reasoning" => empty.clone(),
            "redacted_reasoning" if served["data"] == "" => ck_wire::CkKind::RedactedReasoning {
                data: String::new(),
            },
            // The other pruning kinds are shapes owned-broca's schema does
            // not have (`text_with_state`, a generic `tool_call`).
            _ => continue,
        };
        let message = json!({"role":"assistant","content":[served]});
        assert_eq!(
            reasoning_blocks(codec::Codec::OwnedBroca, message.clone()),
            vec![expected]
        );
        let decoded = codec::Codec::OwnedBroca
            .decode_message(&InboundMessage {
                ordinal: 1,
                mid: "m1".into(),
                message: message.clone(),
            })
            .unwrap();
        assert_eq!(
            bytes(&codec::encode_message(&decoded.ck).unwrap()).unwrap(),
            bytes(&message).unwrap(),
            "{served}: goes back as the runner's bytes"
        );
        broca_blocks += 1;
    }
    assert_eq!(broca_blocks, 2, "the reasoning and redacted vectors ran");
    for (codec, message) in [
        (
            codec::Codec::AnthropicMessages,
            json!({"role":"assistant","content":[{"type":"thinking","thinking":""},{"type":"text","text":"done"}]}),
        ),
        (
            codec::Codec::OpencodeAiSdk,
            json!({"info":{"id":"m1","role":"assistant","time":{"created":1}},"parts":[{"id":"p1r","type":"reasoning","text":""},{"id":"p1t","type":"text","text":"done"}]}),
        ),
        (
            codec::Codec::Pi,
            json!({"type":"message","id":"m1","parentId":"m0","timestamp":"2026-05-01T16:52:33.700Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":""},{"type":"text","text":"done"}]}}),
        ),
    ] {
        assert_eq!(
            reasoning_blocks(codec, message),
            vec![empty.clone()],
            "{codec:?}"
        );
    }
}
