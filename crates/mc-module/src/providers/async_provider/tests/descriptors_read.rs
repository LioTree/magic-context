//! ck-mc's async lane reads its runner in descriptors mode: payloads arrive as
//! refs, every identity is the runner's served digest, sizes come from the
//! refs, and tag numbers are only ever the ones the current read shows.
use super::*;

/// The base64 of a 1920x1080 PNG from the shared image-token fixture.
fn png_1920x1080() -> String {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../../../testdata/image-token-parity.json")).unwrap();
    let case = cases
        .iter()
        .find(|case| case["name"] == "png-1920x1080")
        .unwrap();
    case["url"]
        .as_str()
        .unwrap()
        .split_once(',')
        .unwrap()
        .1
        .to_owned()
}

fn tagged(n: u64) -> tags::PartTag {
    tags::PartTag::tagged("0", format!("§{n}§"))
}

/// An Anthropic transcript with a screenshot-only tool result and a tool
/// result over `PART_INLINE_MAX`, which is the newest message.
fn transcript(large: &str) -> Vec<ReadMessage> {
    let image = json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":png_1920x1080()}});
    let call = |id: &str| json!({"type":"tool_use","id":id,"name":"read","input":{"path":"f"}});
    vec![
        ReadMessage::new(0, "m0", json!({"role":"user","content":"start the task"}))
            .with_tags(vec![tagged(1)]),
        ReadMessage::new(
            1,
            "m1",
            json!({"role":"assistant","content":[{"type":"text","text":"looking"}, call("c1")]}),
        )
        .with_tags(vec![tagged(2), tags::PartTag::untagged("1")]),
        ReadMessage::new(
            2,
            "m2",
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","content":[image]}]}),
        )
        .with_tags(vec![tagged(3)]),
        ReadMessage::new(
            3,
            "m3",
            json!({"role":"assistant","content":[{"type":"text","text":"reading"}, call("c2")]}),
        )
        .with_tags(vec![tagged(4), tags::PartTag::untagged("1")]),
        ReadMessage::new(
            4,
            "m4",
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":"c2","content":large}]}),
        )
        .with_tags(vec![tagged(5)]),
    ]
}

#[tokio::test]
async fn a_described_read_keeps_the_served_identity_and_sizes_each_payload_from_its_ref() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::open(
        dir.path(),
        "thalamus-harness",
        "claude-code",
        json!({"serializer_profile":"anthropic-messages"}),
    )
    .await;
    let large = "a line of ordinary tool output text\n".repeat(9_000);
    *rig.runner.entries.lock().unwrap() = transcript(&large);
    // The notice's digest is the runner's, over the full inline message; the
    // newest message is the described one.
    rig.notice(1, 1_000, None).await;
    let state = rig.state();
    assert!(!state.resync && state.failure.is_none());
    assert_eq!(state.entries.len(), 5);
    assert!(rig
        .runner
        .reads
        .lock()
        .unwrap()
        .iter()
        .all(|params| params["media"] == "descriptors"));

    // What ck-mc holds is what the runner served: refs, never the bytes,
    // with the served digests.
    let image = state.entries[&2].read().unwrap();
    let held = image.message.to_string();
    assert!(held.contains("media_ref") && !held.contains(&png_1920x1080()));
    assert!(image.digest.is_some() && image.part_digests.is_some());
    let text = state.entries[&4].read().unwrap();
    assert!(text.message.to_string().contains("text_ref"));
    assert!(text.message.to_string().len() < 8_192);

    // Sizes come from the refs: the screenshot by its dimensions (2,765
    // tokens by standalone's rule), the large text by its whole size.
    let rows = rig
        .h
        .store
        .get()
        .unwrap()
        .load_tags_for_session(&state.namespace())
        .unwrap();
    let tokens = |number: i64| {
        rows.iter()
            .find(|row| row.tag_number == number)
            .unwrap_or_else(|| panic!("no tag row {number}: {rows:?}"))
            .token_count
    };
    let screenshot = tokens(3);
    assert!((2_765..2_780).contains(&screenshot), "{screenshot}");
    let whole = mc_tokenizer::estimate_tokens(&large) as i64;
    let sized = tokens(5);
    assert!(
        sized * 10 >= whole * 9 && sized * 10 <= whole * 11,
        "large text sized {sized}, whole {whole}"
    );

    // A view never carries ck-mc's stand-in for a described payload.
    for version in state.published_engine.keys() {
        let view = rig.get(*version).await;
        let bytes = serde_json::to_string(&view).unwrap();
        assert!(!bytes.contains("ck-mc: text continues"), "{bytes}");
    }
}

/// A revert with a fork descent renumbers the parts after the cut, reusing
/// numbers the left lineage showed on other parts. `ctx_reduce` resolves a
/// number by the read of the current lineage, never by what an earlier read
/// stored for it, and the engine's tag table follows.
#[tokio::test]
async fn ctx_reduce_resolves_a_reused_number_by_the_current_read() {
    let dir = tempfile::tempdir().unwrap();
    let rig = Rig::new(dir.path()).await;
    rig.fill(12);
    rig.notice(1, 1_000, None).await;
    let reused = 100 + 7 * 3;
    let digest = contract::digest::content_digest(&rig.state().entries[&5].read().unwrap().message);
    {
        let mut entries = rig.runner.entries.lock().unwrap();
        entries.truncate(6);
        for n in 6..9u64 {
            let part = json!({"id":format!("q{n}"),"type":"tool","tool":"read","callID":format!("again{n}"),
                "state":{"status":"completed","input":{"path":format!("other{n}")},"output":"a different output ".repeat(400)}});
            entries.push(
                ReadMessage::new(
                    n,
                    format!("n{n}"),
                    json!({"info":{"id":format!("n{n}"),"role":"assistant","time":{"created":1}},"parts":[part]}),
                )
                .with_tags(vec![tags::PartTag::tagged("0", format!("§{}§", 100 + n * 3))]),
            );
        }
    }
    *rig.runner.lineage.lock().unwrap() = "L2".into();
    rig.notice_with_descent(2, 1_000, None, Some(format!("L:5:{digest}")))
        .await;
    assert_eq!(rig.state().lineage.as_deref(), Some("L2"));
    rig.queue(&[reused]).await;
    assert_eq!(rig.pending_targets(), vec!["n7#1".to_string()]);
    let row = rig
        .h
        .store
        .get()
        .unwrap()
        .load_tags_for_session(&rig.state().namespace())
        .unwrap()
        .into_iter()
        .find(|row| row.tag_number == reused as i64)
        .unwrap();
    assert_eq!(row.block_id, "n7#1");
}
