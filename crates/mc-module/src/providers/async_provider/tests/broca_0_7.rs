//! Broca 0.7 `session.read` captures through the compaction provider's live
//! transcript-read paths: the resumable read shared by notice processing,
//! tag catch-up and ceiling rides, notice ingest, and the offline import.
//!
//! The approved capture is an inline-mode page: it carries no content
//! digests, exactly like any inline page ck-mc could serve before 0.7. The
//! live lane always reads descriptors mode, so the tests below serve the
//! capture's messages with the runner digests added the same way every other
//! lane test serves entries (`serve_descriptors`), then read them through the
//! real lane functions. What is asserted about the wire itself — the recorded
//! call key, the strict message decode, the envelope — needs no digests and
//! runs on the capture bytes as served.

use super::*;

const APPROVED_READ: &[u8] =
    include_bytes!("../../../../testdata/broca-0.7/approved.session.read.json");
const DESCRIBE_AFTER: &[u8] =
    include_bytes!("../../../../testdata/broca-0.7/role.describe.after.json");

fn approved_page() -> Value {
    let reply: Value = serde_json::from_slice(APPROVED_READ).expect("approved read parses");
    crate::session_resolver::read_runner_reply(reply).expect("approved read keeps its envelope")
}

/// The capture's messages with runner digests, as a descriptors-mode read
/// serves them. Attribution and bodies are untouched: only digests are added.
fn approved_described_page() -> Value {
    let answer = approved_page();
    let messages: Vec<ReadMessage> =
        serde_json::from_value(answer["messages"].clone()).expect("approved messages decode");
    let messages = messages
        .iter()
        .map(|entry| serde_json::to_value(serve_descriptors(entry)).expect("described"))
        .collect();
    let mut page = answer.clone();
    page["messages"] = Value::Array(messages);
    page
}

async fn owned_broca_rig(dir: &Path) -> Rig {
    Rig::open(
        dir,
        "thalamus-harness",
        "opencode",
        json!({"serializer_profile":"owned-broca"}),
    )
    .await
}

/// The resumable read shared by notice processing, tag catch-up for
/// `ctx_reduce`, and ceiling rides: the approved page completes it, and a
/// second decode of the held entries is stable, so a retry never sees a
/// changed transcript.
#[tokio::test]
async fn broca_0_7_approved_page_completes_a_resumable_read() {
    let dir = tempfile::tempdir().unwrap();
    let rig = owned_broca_rig(dir.path()).await;
    let page = approved_described_page();
    *rig.runner.page_override.lock().unwrap() = Some(page.clone());
    let mut state = rig.state();
    state.lineage = Some(page["lineage_id"].as_str().expect("lineage").into());
    let read = rig
        .h
        .read_async_resumable(&mut state, 0, Duration::from_secs(5))
        .await;
    assert!(
        matches!(read, Ok(ReadProgress::Complete)),
        "approved page did not complete the resumable read"
    );
    assert_eq!(state.entries.len(), 4);
    let held = state
        .entries
        .get(&1)
        .expect("assistant entry")
        .read()
        .unwrap();
    assert_eq!(held.tool_calls.len(), 1);
    assert_eq!(held.tool_calls[0].tool_call_id, "approved-call");
    assert_eq!(
        held.tool_calls[0].call_key.as_deref(),
        Some("8fc1fdb7-1e03-4f62-a690-6bcfe91075b6:5"),
        "the recorded preparation key survives the read, not the intent sequence"
    );
    // A re-read decodes the same entries: the stability check the lane runs
    // before holding anything would not fire on this page.
    let fresh: Vec<ReadMessage> =
        serde_json::from_value(page["messages"].clone()).expect("approved messages decode");
    for entry in fresh {
        let ordinal = entry.ordinal;
        let held_entry = state.entries.get(&ordinal).expect("held").read().unwrap();
        assert!(
            stable_entry(&held_entry, &entry),
            "ordinal {ordinal} is stable"
        );
    }
}

/// Notice ingest persists the approved transcript: the held entries pass the
/// strict owned-broca message decode and save beside the record.
#[tokio::test]
async fn broca_0_7_notice_ingest_persists_the_approved_transcript() {
    let dir = tempfile::tempdir().unwrap();
    let rig = owned_broca_rig(dir.path()).await;
    let page = approved_described_page();
    *rig.runner.page_override.lock().unwrap() = Some(page.clone());
    let mut state = rig.state();
    state.lineage = Some(page["lineage_id"].as_str().expect("lineage").into());
    let read = rig
        .h
        .read_async_resumable(&mut state, 0, Duration::from_secs(5))
        .await;
    assert!(
        matches!(read, Ok(ReadProgress::Complete)),
        "approved page did not complete the resumable read"
    );
    let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone())).unwrap();
    let store = rig.h.store.get().unwrap();
    state
        .ingest_read(store, codec)
        .unwrap_or_else(|error| panic!("ingest: {error:?}"));
    let reloaded = rig.state();
    assert_eq!(reloaded.entries.len(), 4);
    let held = reloaded
        .entries
        .get(&1)
        .expect("assistant entry")
        .read()
        .unwrap();
    assert_eq!(held.tool_calls[0].tool_call_id, "approved-call");
}

/// `ctx_reduce` catch-up and the ceiling ride read through `read_async`: the
/// approved page reads cleanly there too, with the recorded key intact.
#[tokio::test]
async fn broca_0_7_catchup_and_ride_reads_see_the_recorded_key() {
    let dir = tempfile::tempdir().unwrap();
    let rig = owned_broca_rig(dir.path()).await;
    let page = approved_described_page();
    *rig.runner.page_override.lock().unwrap() = Some(page.clone());
    let mut state = rig.state();
    state.lineage = Some(page["lineage_id"].as_str().expect("lineage").into());
    rig.h
        .read_async(&mut state, 0, Duration::from_secs(5))
        .await
        .unwrap_or_else(|error| panic!("read_async: {error:?}"));
    let held = state
        .entries
        .get(&1)
        .expect("assistant entry")
        .read()
        .unwrap();
    assert_eq!(
        held.tool_calls[0].call_key.as_deref(),
        Some("8fc1fdb7-1e03-4f62-a690-6bcfe91075b6:5")
    );
}

/// The lineage window opens on `session.head`: the never-written answer the
/// lane reads before any append and the completed 0.7 head both decode, with
/// lineage fields intact where a lineage exists.
#[test]
fn broca_0_7_head_window_reads_both_head_shapes() {
    // The never-written answer: no lineage, first ordinal zero.
    let empty: cortexkit_role_llm_runner::read::HeadMeta =
        crate::providers::decode(&json!({"first_ordinal": 0}))
            .unwrap_or_else(|error| panic!("{error:?}"));
    assert_eq!(empty.first_ordinal, Some(0));
    assert!(empty.lineage_id.is_none());
    // The completed 0.7 head: lineage and first ordinal intact.
    let answer: Value = serde_json::from_slice(include_bytes!(
        "../../../../testdata/broca-0.7/session.head.completed.json"
    ))
    .expect("completed head parses");
    let answer = crate::session_resolver::read_runner_reply(answer).expect("head envelope");
    let head: cortexkit_role_llm_runner::read::HeadMeta =
        crate::providers::decode(&answer).unwrap_or_else(|error| panic!("{error:?}"));
    assert!(head.lineage_consistent());
    assert_eq!(head.first_ordinal, Some(0));
    assert!(head.lineage_id.is_some());
}

/// The offline import serves bare export lines: one `ReadPage` per line,
/// decoded again when served, with the runner's own describe verbatim.
#[tokio::test]
async fn broca_0_7_offline_import_serves_bare_export_lines() {
    use crate::providers::offline_first_pass_engine::{PagesRunner, ServedPage};
    use crate::session_resolver::{ProviderRunner, RunnerBindIdentity};
    // A bare export line is the page without its reply envelope, as the
    // offline exporter writes it; derivation is mechanical, not editorial.
    let answer = approved_page();
    let line = serde_json::to_string(&answer).expect("bare page line");
    let describe_reply: Value = serde_json::from_slice(DESCRIBE_AFTER).expect("describe parses");
    let describe = crate::session_resolver::read_runner_reply(describe_reply).expect("envelope");
    let runner = PagesRunner::new(
        vec![ServedPage {
            first: 0,
            last: 3,
            line,
        }],
        describe.clone(),
    );
    let route = crate::route_targets::SessionRunnerRoute::for_principal(
        Some(&subc_protocol::Principal::Reserved {
            module_id: "broca".into(),
        }),
        "s",
    )
    .expect("broca is a session runner module");
    let identity = RunnerBindIdentity {
        project_root: PathBuf::from("/project"),
        harness: "broca".into(),
        session: "s".into(),
    };
    let budget = Duration::from_secs(5);
    let served = runner
        .call_for_identity(&route, &identity, "role.describe", json!({}), budget)
        .await
        .expect("describe served verbatim");
    assert_eq!(served, describe);
    let head = runner
        .call_for_identity(&route, &identity, "session.head", json!({}), budget)
        .await
        .expect("head served");
    let head: cortexkit_role_llm_runner::read::HeadMeta =
        serde_json::from_value(head).expect("empty head decodes");
    assert_eq!(head.first_ordinal, Some(0));
    let page = runner
        .call_for_identity(
            &route,
            &identity,
            "session.read",
            json!({"from_ordinal":1,"media":"descriptors","lineage_id":answer["lineage_id"]}),
            budget,
        )
        .await
        .expect("page served");
    let page: cortexkit_role_llm_runner::read::ReadPage =
        serde_json::from_value(page).expect("served page decodes");
    assert_eq!(page.messages.len(), 3);
    assert_eq!(page.messages[0].ordinal, 1);
    let attributed = page
        .messages
        .iter()
        .find(|entry| entry.ordinal == 1)
        .unwrap();
    assert_eq!(
        attributed.tool_calls[0].call_key.as_deref(),
        Some("8fc1fdb7-1e03-4f62-a690-6bcfe91075b6:5")
    );
}
