//! Tool-outage 1027 captures through every ck-mc decode path that reads a
//! tool result.
//!
//! The BROCA release adds five optional siblings beside `message` on
//! `ToolOutput::Error` (`module`, `code`, `detail`, `nothing_sent`, `retry`).
//! `message` stays exactly "tool plane unavailable". The captures under
//! `corpus-readonly/tool-outage-1027/` are the real bytes (SHA256SUMS verified
//! before this file was written); each test below feeds those bytes through
//! the real decode function for one path, never a hand-written copy.
//!
//! Paths that decode the already-normalised CK form (notice ingest after
//! decode, tag indexing text extraction, summarizer input, ctx_expand
//! rendering, tool-arc pairing) see the composed model text
//! (`CkOutputKind::ErrorText { text }` holds `message` plus one line per
//! present field): an attributed error renders composed everywhere the model
//! looks, while a plain error still renders as `message` alone. The
//! structured siblings survive serving through the retained native original
//! (unchanged parts) or the rebuilt candidate (edited parts).

use cortexkit_role_llm_runner::history::HistoryEntry;
use cortexkit_role_llm_runner::read::{ReadMessage, ReadPage};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Byte-identical copies of `corpus-readonly/tool-outage-1027/` (SHA256SUMS
/// verified locally with `shasum -a 256 -c SHA256SUMS`: all five OK). They
/// are embedded because that directory is git-ignored and absent on remote
/// builders, so a file read would fail on Linux; the checksum test below
/// proves the embedded bytes are the real captures.
const SESSION_READ_REPLY: &str = r###"{"result":{"messages":[{"written_at":1793072655509,"ordinal":0,"mid":"m0","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"run":{"run_id":"run-sid-ymgP4z4dgxRoNVq2lh3pG4","episode":"run-sid-ymgP4z4dgxRoNVq2lh3pG4","final":false},"tags":[{"part":"m0#0"}]},{"written_at":1793072655523,"ordinal":1,"mid":"m1","message":{"role":"assistant","content":[{"type":"tool_call","tool_call_id":"call-1","tool_name":"work","input":{}}],"origin":{"provider_module_id":"fake","model_id":"fake"}},"run":{"run_id":"run-sid-ymgP4z4dgxRoNVq2lh3pG4","episode":"run-sid-ymgP4z4dgxRoNVq2lh3pG4","final":false},"tool_calls":[{"tool_call_id":"call-1","call_key":"3965cc3e-d216-4b43-a10f-f56e02af0bc4:5","dispatched_to":"work-module","indeterminate":false}],"tags":[{"part":"m1#0"}]},{"written_at":1793072655539,"ordinal":2,"mid":"m2","message":{"role":"tool","content":[{"type":"tool_result","tool_call_id":"call-1","output":{"kind":"error","message":"tool plane unavailable","module":"aft","code":"target_unavailable","detail":"supervised_not_registered","nothing_sent":true,"retry":"the module is restarting or unavailable; retry the call in a minute"},"is_error":true}]},"run":{"run_id":"run-sid-ymgP4z4dgxRoNVq2lh3pG4","episode":"run-sid-ymgP4z4dgxRoNVq2lh3pG4","final":false},"tags":[{"part":"m2#0"}]},{"written_at":1793072655546,"ordinal":3,"mid":"m3","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"origin":{"provider_module_id":"fake","model_id":"fake"}},"run":{"run_id":"run-sid-ymgP4z4dgxRoNVq2lh3pG4","episode":"run-sid-ymgP4z4dgxRoNVq2lh3pG4","final":true},"tags":[{"part":"m3#0"}]}],"head":{"wal_seq":11,"sub_index":0},"lineage_id":"3965cc3e-d216-4b43-a10f-f56e02af0bc4","lineage_state":{"last_run_id":"run-sid-ymgP4z4dgxRoNVq2lh3pG4","state":"completed","reason":"completed","usage":{}}}}"###;

const SESSION_HISTORY_ROW: &str = r###"{
  "message": {
    "content": [
      {
        "is_error": true,
        "output": {
          "code": "target_unavailable",
          "detail": "supervised_not_registered",
          "kind": "error",
          "message": "tool plane unavailable",
          "module": "aft",
          "nothing_sent": true,
          "retry": "the module is restarting or unavailable; retry the call in a minute"
        },
        "tool_call_id": "call-1",
        "type": "tool_result"
      }
    ],
    "role": "tool"
  },
  "mid": "m2",
  "ordinal": 2,
  "run": {
    "episode": "run-sid-ymgP4z4dgxRoNVq2lh3pG4",
    "final": false,
    "run_id": "run-sid-ymgP4z4dgxRoNVq2lh3pG4"
  },
  "tags": [
    {
      "part": "m2#0"
    }
  ],
  "written_at": 1793072655539
}"###;

const TOOL_FINISHED_EVENT: &str = r###"{
  "finished_at": 1793072655539,
  "mid": "m1",
  "outcome": "error",
  "output_bytes": 22,
  "tool_call_id": "call-1",
  "type": "tool_finished"
}"###;

const TOOL_FINISHED_FRAME: &str = r###"{"kind":"control","cursor":{"wal_seq":6,"sub_index":0},"unit":{"type":"tool_result","result":{"tool_call_id":"call-1","output":{"kind":"error","message":"tool plane unavailable","module":"aft","code":"target_unavailable","detail":"supervised_not_registered","nothing_sent":true,"retry":"the module is restarting or unavailable; retry the call in a minute"},"is_error":true}},"seq":10,"event":{"type":"tool_finished","mid":"m1","tool_call_id":"call-1","outcome":"error","output_bytes":22,"finished_at":1793072655539}}"###;

const TOOL_RESULT_RECORD: &str = r###"{"requires":["tool-times/v1"],"record":{"type":"tool_result","finished_at_ms":1793072655539,"batch_id":"run-sid-ymgP4z4dgxRoNVq2lh3pG4-b1","result":{"tool_call_id":"call-1","output":{"kind":"error","message":"tool plane unavailable","module":"aft","code":"target_unavailable","detail":"supervised_not_registered","nothing_sent":true,"retry":"the module is restarting or unavailable; retry the call in a minute"},"is_error":true},"outcome":"completed"}}"###;

fn corpus_bytes(name: &str) -> Vec<u8> {
    match name {
        "session_read.reply.json" => SESSION_READ_REPLY.as_bytes().to_vec(),
        "session_history.row.json" => SESSION_HISTORY_ROW.as_bytes().to_vec(),
        "tool_finished.event.json" => TOOL_FINISHED_EVENT.as_bytes().to_vec(),
        "tool_finished.frame.json" => TOOL_FINISHED_FRAME.as_bytes().to_vec(),
        "tool_result.record.json" => TOOL_RESULT_RECORD.as_bytes().to_vec(),
        other => panic!("unknown capture {other}"),
    }
}

fn corpus_json(name: &str) -> Value {
    serde_json::from_slice(&corpus_bytes(name))
        .unwrap_or_else(|error| panic!("parse {name}: {error}"))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The five captures are byte-identical to the recorded outage. A drift shows
/// up here, not downstream.
#[test]
fn tool_outage_captures_match_their_checksums() {
    for (name, expected) in [
        (
            "session_read.reply.json",
            "9d6444a9e10714592af290d7ccbb95484a32eb4d3db8fee7f1ea9c519ce066a1",
        ),
        (
            "session_history.row.json",
            "2b3352fd8822ae5fc09b566e45e9f31015da5810498c3aa4cb7d37e1ba90a886",
        ),
        (
            "tool_finished.event.json",
            "7a6673fe6f9beca63da8b0bc82664c515b9ce08ab6ee0b2da711bfa336fd10a8",
        ),
        (
            "tool_finished.frame.json",
            "f80a0ae97645451405cbb35c549e2c1944bb79476597f841f54a46d3a55eaa08",
        ),
        (
            "tool_result.record.json",
            "2a8d37e5fd5e5535354bd633b208ab177ba89d882a058630496550300d82e188",
        ),
    ] {
        assert_eq!(
            hex(&Sha256::digest(corpus_bytes(name))),
            expected,
            "{name} drifted"
        );
    }
}

/// The one strict envelope every unary path shares
/// (`session_resolver::read_runner_reply`): the outage reply keeps exactly one
/// `result` member, so the envelope passes and the new siblings (inside
/// `result.messages[].message.content[].output`) never touch it.
#[test]
fn tool_outage_strict_envelope_accepts_the_reply() {
    let reply = corpus_json("session_read.reply.json");
    assert!(reply.get("result").is_some(), "reply keeps its envelope");
    assert_eq!(
        reply.as_object().map(|map| map.len()),
        Some(1),
        "envelope is exactly one result member"
    );
    let answer = crate::session_resolver::read_runner_reply(reply)
        .unwrap_or_else(|error| panic!("envelope: {error:?}"));
    assert!(answer.get("messages").is_some(), "answer holds messages");
    assert_eq!(answer["messages"].as_array().map(Vec::len), Some(4));
}

/// `session.read` page and message list decode leniently (external
/// `ReadPage`/`ReadMessage`: `#[non_exhaustive]`, no `deny_unknown_fields`,
/// `message` is a `Value`): the outage page decodes with lineage intact and
/// the tool result entry keeps its attribution.
#[test]
fn tool_outage_read_page_and_messages_decode_leniently() {
    let reply = corpus_json("session_read.reply.json");
    let answer = crate::session_resolver::read_runner_reply(reply).expect("envelope");
    let page: ReadPage =
        crate::providers::decode(&answer).unwrap_or_else(|error| panic!("ReadPage: {error:?}"));
    assert!(page.lineage_consistent());
    assert_eq!(page.messages.len(), 4);
    let messages: Vec<ReadMessage> =
        crate::providers::decode(&answer["messages"]).expect("messages decode");
    assert_eq!(messages.len(), 4);
    let result = messages
        .iter()
        .find(|entry| entry.ordinal == 2)
        .expect("tool message");
    assert_eq!(result.mid, "m2");
    // The entry's top-level `role` is optional and absent here; the runner's
    // role lives inside `message.role`.
    assert_eq!(result.message["role"], serde_json::json!("tool"));
    // The output keeps the outage siblings verbatim on the wire value.
    let output = result.message.pointer("/content/0/output").expect("output");
    assert_eq!(output["kind"], serde_json::json!("error"));
    assert_eq!(
        output["message"],
        serde_json::json!("tool plane unavailable")
    );
    assert_eq!(output["module"], serde_json::json!("aft"));
    assert_eq!(output["code"], serde_json::json!("target_unavailable"));
    assert_eq!(
        output["detail"],
        serde_json::json!("supervised_not_registered")
    );
    assert_eq!(output["nothing_sent"], serde_json::json!(true));
    assert!(output["retry"]
        .as_str()
        .is_some_and(|retry| !retry.is_empty()));
}

/// The owned-broca native codec accepts the five outage siblings
/// (`providers/codec.rs`: `NativeOutput::Error` with optional `module`,
/// `code`, `detail`, `nothing_sent`, `retry`, still under
/// `deny_unknown_fields`): every capture message decodes, the tool result's
/// CK text is exactly the composed model text, and re-encoding the decoded
/// message is byte-identical to the runner's bytes.
#[test]
fn tool_outage_owned_broca_accepts_and_round_trips_byte_identically() {
    let expected = "tool plane unavailable\nmodule: aft\ncode: target_unavailable\ndetail: supervised_not_registered\nnothing was sent\nretry: the module is restarting or unavailable; retry the call in a minute";
    let reply = corpus_json("session_read.reply.json");
    let answer = crate::session_resolver::read_runner_reply(reply).expect("envelope");
    let messages: Vec<ReadMessage> =
        crate::providers::decode(&answer["messages"]).expect("messages decode");
    for entry in &messages {
        let inbound = crate::providers::codec::InboundMessage {
            ordinal: entry.ordinal,
            mid: entry.mid.clone(),
            message: entry.message.clone(),
        };
        let decoded = crate::providers::codec::Codec::OwnedBroca
            .decode_message(&inbound)
            .unwrap_or_else(|error| panic!("ordinal {}: {error:?}", entry.ordinal));
        assert_eq!(decoded.mid, entry.mid);
        if entry.ordinal == 2 {
            // The CK text is the composed model text, so summarizer input,
            // tag text and token estimates all see what the model sees.
            let kind = &decoded.ck.content[0].kind;
            let crate::ck_wire::CkKind::ToolResult { output, .. } = kind else {
                panic!("m2 must decode to a tool result");
            };
            assert_eq!(
                crate::tail_hygiene::tool_output_content(&output.kind),
                expected,
                "downstream readers see the composed model text"
            );
            let kind_value = serde_json::to_value(kind).expect("CK kind serializes");
            for sibling in ["module", "code", "detail", "nothing_sent", "retry"] {
                assert!(
                    kind_value
                        .pointer(&format!("/output/kind/{sibling}"))
                        .is_none()
                        && kind_value.get(sibling).is_none(),
                    "sibling {sibling} must not reach the CK type as a field"
                );
            }
        }
        let encoded = crate::providers::codec::encode_message(&decoded.ck)
            .unwrap_or_else(|error| panic!("ordinal {}: {error:?}", entry.ordinal));
        assert_eq!(
            crate::providers::bytes(&encoded).expect("encode bytes"),
            crate::providers::bytes(&entry.message).expect("runner bytes"),
            "ordinal {} re-encodes byte-identically",
            entry.ordinal
        );
    }
}

/// Today's plain error (only `message`, no siblings) still round-trips
/// byte-identically: absent siblings are omitted, never written as null.
#[test]
fn tool_outage_plain_error_round_trips_without_siblings() {
    let native = serde_json::json!({"role":"tool","content":[{"type":"tool_result","tool_call_id":"c","output":{"kind":"error","message":"boom"},"is_error":true}]});
    let inbound = crate::providers::codec::InboundMessage {
        ordinal: 9,
        mid: "m9".into(),
        message: native.clone(),
    };
    let decoded = crate::providers::codec::Codec::OwnedBroca
        .decode_message(&inbound)
        .expect("plain error decodes");
    let encoded = crate::providers::codec::encode_message(&decoded.ck).expect("encodes");
    assert_eq!(
        crate::providers::bytes(&encoded).expect("encode bytes"),
        crate::providers::bytes(&native).expect("runner bytes")
    );
    assert_eq!(
        encoded.pointer("/content/0/output").expect("output"),
        &serde_json::json!({"kind":"error","message":"boom"})
    );
}

/// An unrelated unknown member is still refused as `history_unreadable`:
/// the codec tolerates exactly the five outage siblings, nothing else.
#[test]
fn tool_outage_unknown_member_is_still_refused() {
    let native = serde_json::json!({"role":"tool","content":[{"type":"tool_result","tool_call_id":"c","output":{"kind":"error","message":"boom","foo":1},"is_error":true}]});
    let inbound = crate::providers::codec::InboundMessage {
        ordinal: 9,
        mid: "m9".into(),
        message: native,
    };
    let error = crate::providers::codec::Codec::OwnedBroca
        .decode_message(&inbound)
        .expect_err("unknown member must be refused");
    let rendered = format!("{error:?}");
    assert!(
        rendered.contains("history_unreadable"),
        "refusal names history_unreadable: {rendered}"
    );
    assert!(
        rendered.contains("foo"),
        "refusal names the unknown member: {rendered}"
    );
}

/// `nothing_sent` is the JSON literal `true` when present: `false`, `null`,
/// or any other value is a profile violation refused as `history_unreadable`.
#[test]
fn tool_outage_nothing_sent_non_true_is_refused() {
    for value in [
        serde_json::json!(false),
        serde_json::json!(null),
        serde_json::json!("true"),
        serde_json::json!(0),
    ] {
        let native = serde_json::json!({"role":"tool","content":[{"type":"tool_result","tool_call_id":"c","output":{"kind":"error","message":"boom","nothing_sent":value},"is_error":true}]});
        let inbound = crate::providers::codec::InboundMessage {
            ordinal: 9,
            mid: "m9".into(),
            message: native,
        };
        let error = crate::providers::codec::Codec::OwnedBroca
            .decode_message(&inbound)
            .expect_err(format!("nothing_sent:{value} must be refused").as_str());
        let rendered = format!("{error:?}");
        assert!(
            rendered.contains("history_unreadable"),
            "refusal names history_unreadable: {rendered}"
        );
        assert!(
            rendered.contains("nothing_sent"),
            "refusal names the violating field: {rendered}"
        );
    }
}

/// A present string member must be non-empty: `"detail": ""` and
/// `"retry": ""` are profile violations, while 1-byte values decode.
#[test]
fn tool_outage_empty_member_is_refused() {
    for key in ["module", "code", "detail", "retry"] {
        let native = serde_json::json!({"role":"tool","content":[{"type":"tool_result","tool_call_id":"c","output":{"kind":"error","message":"boom",key:""},"is_error":true}]});
        let inbound = crate::providers::codec::InboundMessage {
            ordinal: 9,
            mid: "m9".into(),
            message: native,
        };
        let error = crate::providers::codec::Codec::OwnedBroca
            .decode_message(&inbound)
            .expect_err(format!("{key}:empty must be refused").as_str());
        let rendered = format!("{error:?}");
        assert!(
            rendered.contains("history_unreadable") && rendered.contains(key),
            "refusal names the member and the rule: {rendered}"
        );
    }
    // 1-byte values are accepted.
    for (key, value) in [
        ("module", "a"),
        ("code", "a"),
        ("detail", "a"),
        ("retry", "a"),
    ] {
        let native = serde_json::json!({"role":"tool","content":[{"type":"tool_result","tool_call_id":"c","output":{"kind":"error","message":"boom",key:value},"is_error":true}]});
        let inbound = crate::providers::codec::InboundMessage {
            ordinal: 9,
            mid: "m9".into(),
            message: native,
        };
        crate::providers::codec::Codec::OwnedBroca
            .decode_message(&inbound)
            .unwrap_or_else(|error| panic!("{key}:1-byte must decode: {error:?}"));
    }
}

/// No member may be `null`: each of the five is refused naming the member.
#[test]
fn tool_outage_null_member_is_refused() {
    for key in ["module", "code", "detail", "nothing_sent", "retry"] {
        let native = serde_json::json!({"role":"tool","content":[{"type":"tool_result","tool_call_id":"c","output":{"kind":"error","message":"boom",key:null},"is_error":true}]});
        let inbound = crate::providers::codec::InboundMessage {
            ordinal: 9,
            mid: "m9".into(),
            message: native,
        };
        let error = crate::providers::codec::Codec::OwnedBroca
            .decode_message(&inbound)
            .expect_err(format!("{key}:null must be refused").as_str());
        let rendered = format!("{error:?}");
        assert!(
            rendered.contains("history_unreadable") && rendered.contains(key),
            "refusal names the member and the rule: {rendered}"
        );
    }
}

/// A string member carrying `\n` or `\r` would forge a line in the model
/// text (`detail` carrying `"\nnothing was sent"` would fake the
/// `nothing_sent` line), so it is refused; the same text without newlines
/// decodes.
#[test]
fn tool_outage_newline_member_is_refused() {
    for key in ["module", "code", "detail", "retry"] {
        for forged in ["a\nb", "a\rb", "x\nnothing was sent"] {
            let native = serde_json::json!({"role":"tool","content":[{"type":"tool_result","tool_call_id":"c","output":{"kind":"error","message":"boom",key:forged},"is_error":true}]});
            let inbound = crate::providers::codec::InboundMessage {
                ordinal: 9,
                mid: "m9".into(),
                message: native,
            };
            let error = crate::providers::codec::Codec::OwnedBroca
                .decode_message(&inbound)
                .expect_err(format!("{key}:{forged:?} must be refused").as_str());
            let rendered = format!("{error:?}");
            assert!(
                rendered.contains("history_unreadable") && rendered.contains(key),
                "refusal names the member and the rule: {rendered}"
            );
        }
        let plain = match key {
            "module" => "a:b",
            "code" => "ab",
            _ => "a b",
        };
        let native = serde_json::json!({"role":"tool","content":[{"type":"tool_result","tool_call_id":"c","output":{"kind":"error","message":"boom",key:plain},"is_error":true}]});
        let inbound = crate::providers::codec::InboundMessage {
            ordinal: 9,
            mid: "m9".into(),
            message: native,
        };
        crate::providers::codec::Codec::OwnedBroca
            .decode_message(&inbound)
            .unwrap_or_else(|error| panic!("{key}:plain text must decode: {error:?}"));
    }
}

/// Byte limits are over the decoded string: `detail` accepts exactly 1,024
/// bytes and refuses 1,025; `retry` accepts 256 and refuses 257. A multibyte
/// character counts its UTF-8 bytes ("é" is 2), so the boundary is probed
/// with it too.
#[test]
fn tool_outage_detail_retry_length_limits() {
    for (key, limit) in [("detail", 1024), ("retry", 256)] {
        let inside = "é".repeat(limit / 2);
        assert_eq!(inside.len(), limit);
        let native = serde_json::json!({"role":"tool","content":[{"type":"tool_result","tool_call_id":"c","output":{"kind":"error","message":"boom",key:inside},"is_error":true}]});
        let inbound = crate::providers::codec::InboundMessage {
            ordinal: 9,
            mid: "m9".into(),
            message: native,
        };
        crate::providers::codec::Codec::OwnedBroca
            .decode_message(&inbound)
            .unwrap_or_else(|error| panic!("{key}:{limit} bytes must decode: {error:?}"));
        let outside = format!("{}é", "a".repeat(limit - 1));
        assert_eq!(outside.len(), limit + 1);
        let native = serde_json::json!({"role":"tool","content":[{"type":"tool_result","tool_call_id":"c","output":{"kind":"error","message":"boom",key:outside},"is_error":true}]});
        let inbound = crate::providers::codec::InboundMessage {
            ordinal: 9,
            mid: "m9".into(),
            message: native,
        };
        let error = crate::providers::codec::Codec::OwnedBroca
            .decode_message(&inbound)
            .expect_err(format!("{key}:{} bytes must be refused", limit + 1).as_str());
        let rendered = format!("{error:?}");
        assert!(
            rendered.contains("history_unreadable") && rendered.contains(key),
            "refusal names the member and the rule: {rendered}"
        );
    }
}

/// Grammar boundaries from the runner contract: `module` is 1-128 bytes of
/// printable ASCII (no space); `code` is `^[a-z][a-z0-9_]{0,63}$`.
#[test]
fn tool_outage_module_code_grammar_boundaries() {
    let module_128 = "a".repeat(128);
    let module_129 = "a".repeat(129);
    for (value, ok) in [
        ("", false),
        ("a", true),
        ("fed:peer:work", true),
        ("has space", false),
        ("tab\there", false),
        (module_128.as_str(), true),
        (module_129.as_str(), false),
    ] {
        let native = serde_json::json!({"role":"tool","content":[{"type":"tool_result","tool_call_id":"c","output":{"kind":"error","message":"boom","module":value},"is_error":true}]});
        let inbound = crate::providers::codec::InboundMessage {
            ordinal: 9,
            mid: "m9".into(),
            message: native,
        };
        let decoded = crate::providers::codec::Codec::OwnedBroca.decode_message(&inbound);
        assert_eq!(decoded.is_ok(), ok, "module:{value:?} must decode={ok}");
    }
    let code_64 = format!("a{}", "b_".repeat(63 / 2) + "c");
    assert_eq!(code_64.len(), 64);
    let code_65 = format!("{code_64}d");
    for (value, ok) in [
        ("a".to_string(), true),
        ("target_unavailable".to_string(), true),
        ("A".to_string(), false),
        ("Target".to_string(), false),
        ("1abc".to_string(), false),
        ("_abc".to_string(), false),
        (code_64.clone(), true),
        (code_65.clone(), false),
    ] {
        let native = serde_json::json!({"role":"tool","content":[{"type":"tool_result","tool_call_id":"c","output":{"kind":"error","message":"boom","code":value},"is_error":true}]});
        let inbound = crate::providers::codec::InboundMessage {
            ordinal: 9,
            mid: "m9".into(),
            message: native,
        };
        let decoded = crate::providers::codec::Codec::OwnedBroca.decode_message(&inbound);
        assert_eq!(decoded.is_ok(), ok, "code:{value:?} must decode={ok}");
        if !ok {
            let rendered = format!("{:?}", decoded.err());
            assert!(
                rendered.contains("history_unreadable") && rendered.contains("code"),
                "refusal names the member and the rule: {rendered}"
            );
        }
    }
}

/// Each present field contributes exactly its one line, in
/// `error_model_text` order; absent fields contribute nothing.
#[test]
fn tool_outage_each_field_composes_its_own_line() {
    for (siblings, expected) in [
        (serde_json::json!({}), "boom"),
        (serde_json::json!({"module":"aft"}), "boom\nmodule: aft"),
        (
            serde_json::json!({"code":"target_unavailable"}),
            "boom\ncode: target_unavailable",
        ),
        (serde_json::json!({"detail":"gone"}), "boom\ndetail: gone"),
        (
            serde_json::json!({"nothing_sent":true}),
            "boom\nnothing was sent",
        ),
        (serde_json::json!({"retry":"later"}), "boom\nretry: later"),
    ] {
        let mut output = serde_json::json!({"kind":"error","message":"boom"});
        for (key, value) in siblings.as_object().expect("siblings") {
            output[key] = value.clone();
        }
        let native = serde_json::json!({"role":"tool","content":[{"type":"tool_result","tool_call_id":"c","output":output,"is_error":true}]});
        let inbound = crate::providers::codec::InboundMessage {
            ordinal: 9,
            mid: "m9".into(),
            message: native,
        };
        let decoded = crate::providers::codec::Codec::OwnedBroca
            .decode_message(&inbound)
            .unwrap_or_else(|error| panic!("{siblings}: {error:?}"));
        let crate::ck_wire::CkKind::ToolResult { output, .. } = &decoded.ck.content[0].kind else {
            panic!("{siblings}: must decode to a tool result");
        };
        assert_eq!(
            crate::tail_hygiene::tool_output_content(&output.kind),
            expected,
            "siblings {siblings}"
        );
    }
}

/// When ck-mc edits an outage error's text in a view (tag prefix, drop
/// placeholder, reminder), the edit flows into `message` and the structured
/// siblings are preserved alongside: the runner still gets the fields, with
/// the edited text. Unchanged blocks instead serve the retained original
/// verbatim (covered by the round-trip tests above).
#[test]
fn tool_outage_edited_text_keeps_the_siblings() {
    let reply = corpus_json("session_read.reply.json");
    let answer = crate::session_resolver::read_runner_reply(reply).expect("envelope");
    let messages: Vec<ReadMessage> =
        crate::providers::decode(&answer["messages"]).expect("messages decode");
    let entry = messages
        .iter()
        .find(|entry| entry.ordinal == 2)
        .expect("tool");
    let inbound = crate::providers::codec::InboundMessage {
        ordinal: entry.ordinal,
        mid: entry.mid.clone(),
        message: entry.message.clone(),
    };
    let mut decoded = crate::providers::codec::Codec::OwnedBroca
        .decode_message(&inbound)
        .expect("outage decodes");
    // Mimic a tag prefix, which prepends to the error text in place.
    let crate::ck_wire::CkKind::ToolResult { output, .. } = &mut decoded.ck.content[0].kind else {
        panic!("m2 must decode to a tool result");
    };
    let crate::ck_wire::CkOutputKind::ErrorText { text } = &mut output.kind else {
        panic!("m2 must decode to error text");
    };
    text.insert_str(0, "§12§ ");
    decoded.ck.mark_modified();
    decoded.ck.content[0].mark_modified();
    let encoded = crate::providers::codec::encode_message(&decoded.ck).expect("encodes");
    let output = encoded.pointer("/content/0/output").expect("output");
    assert_eq!(output["kind"], serde_json::json!("error"));
    assert!(
        output["message"]
            .as_str()
            .is_some_and(|message| message.starts_with("§12§ tool plane unavailable\n")),
        "the edit is carried in message: {output}"
    );
    for (key, value) in [
        ("module", serde_json::json!("aft")),
        ("code", serde_json::json!("target_unavailable")),
        ("detail", serde_json::json!("supervised_not_registered")),
        ("nothing_sent", serde_json::json!(true)),
    ] {
        assert_eq!(output[key], value, "sibling {key} is preserved");
    }
    assert!(
        output["retry"]
            .as_str()
            .is_some_and(|retry| !retry.is_empty()),
        "sibling retry is preserved"
    );
}
/// runner's bytes for that part: the view path re-encodes from the retained
/// original, so the siblings survive it.
#[test]
fn tool_outage_view_serving_returns_the_runner_bytes() {
    let reply = corpus_json("session_read.reply.json");
    let answer = crate::session_resolver::read_runner_reply(reply).expect("envelope");
    let messages: Vec<ReadMessage> =
        crate::providers::decode(&answer["messages"]).expect("messages decode");
    let entries: Vec<crate::providers::codec::InboundMessage> = messages
        .iter()
        .map(|entry| crate::providers::codec::InboundMessage {
            ordinal: entry.ordinal,
            mid: entry.mid.clone(),
            message: entry.message.clone(),
        })
        .collect();
    let replacement: Vec<crate::ck_wire::CkWireMessage> = entries
        .iter()
        .map(|entry| {
            crate::providers::codec::Codec::OwnedBroca
                .decode_message(entry)
                .expect("outage entry decodes")
                .ck
        })
        .collect();
    let view = crate::transform::compaction::View {
        compaction_id: "compact".into(),
        version: 1,
        range: crate::transform::compaction::Range {
            lineage_id: answer["lineage_id"].as_str().expect("lineage").into(),
            from: 0,
            to: entries.len() as u64,
        },
        replacement,
    };
    let rendered = crate::providers::codec::Codec::OwnedBroca
        .render_view(&view, "session", &entries)
        .expect("view renders");
    assert_eq!(
        crate::providers::bytes(&rendered.replacement).expect("rendered bytes"),
        crate::providers::bytes(
            &entries
                .iter()
                .map(|entry| &entry.message)
                .collect::<Vec<_>>()
        )
        .expect("runner bytes")
    );
}

/// The other native codecs never read Broca's wire: an owned-broca message is
/// refused by schema (missing `info`/`parts`, journal `id`, or Anthropic
/// role), not by the outage siblings. The outage changes nothing for them.
#[test]
fn tool_outage_other_native_codecs_refuse_broca_schema_unchanged() {
    let reply = corpus_json("session_read.reply.json");
    let answer = crate::session_resolver::read_runner_reply(reply).expect("envelope");
    let messages: Vec<ReadMessage> =
        crate::providers::decode(&answer["messages"]).expect("messages decode");
    let entry = messages
        .iter()
        .find(|entry| entry.ordinal == 2)
        .expect("tool message");
    let inbound = crate::providers::codec::InboundMessage {
        ordinal: entry.ordinal,
        mid: entry.mid.clone(),
        message: entry.message.clone(),
    };
    for codec in [
        crate::providers::codec::Codec::OpencodeAiSdk,
        crate::providers::codec::Codec::Pi,
        crate::providers::codec::Codec::AnthropicMessages,
    ] {
        let error = codec
            .decode_message(&inbound)
            .expect_err(format!("{codec:?} must refuse Broca schema").as_str());
        assert!(
            format!("{error:?}").contains("history_unreadable"),
            "{codec:?}: {error:?}"
        );
    }
}

/// `session.history` entries decode leniently (external `HistoryEntry`:
/// `#[non_exhaustive]`, no deny, `message` is a `Value`): the outage row
/// decodes with its tags intact, and its inner message decodes and
/// re-encodes byte-identically through the owned-broca codec.
#[test]
fn tool_outage_history_row_decodes_and_round_trips() {
    let row: HistoryEntry = serde_json::from_slice(&corpus_bytes("session_history.row.json"))
        .unwrap_or_else(|error| panic!("HistoryEntry: {error}"));
    assert_eq!(row.mid, "m2");
    assert_eq!(row.ordinal, Some(2));
    assert_eq!(row.tags.len(), 1);
    let output = row.message.pointer("/content/0/output").expect("output");
    assert_eq!(
        output["message"],
        serde_json::json!("tool plane unavailable")
    );
    let inbound = crate::providers::codec::InboundMessage {
        ordinal: row.ordinal.unwrap(),
        mid: row.mid.clone(),
        message: row.message.clone(),
    };
    let decoded = crate::providers::codec::Codec::OwnedBroca
        .decode_message(&inbound)
        .expect("history row inner message decodes");
    let encoded = crate::providers::codec::encode_message(&decoded.ck).expect("encodes");
    assert_eq!(
        crate::providers::bytes(&encoded).expect("encode bytes"),
        crate::providers::bytes(&row.message).expect("runner bytes")
    );
}

/// Live subscription units are wake hints only
/// (`runner_follow::control_wake` checks `kind == "control"`): the outage
/// frame wakes, the bare event does not, and the new siblings ride beside the
/// fields ck-mc checks instead of changing them.
#[test]
fn tool_outage_live_units_wake_by_kind_only() {
    let frame = corpus_json("tool_finished.frame.json");
    assert_eq!(frame["kind"], serde_json::json!("control"));
    assert!(
        crate::runner_follow::control_wake(&frame),
        "control frame stays a wake hint"
    );
    assert_eq!(frame["event"]["tool_call_id"], serde_json::json!("call-1"));
    assert_eq!(frame["event"]["outcome"], serde_json::json!("error"));
    // The unit's tool result carries the outage error verbatim.
    let output = frame.pointer("/unit/result/output").expect("unit output");
    assert_eq!(output["kind"], serde_json::json!("error"));
    assert_eq!(
        output["message"],
        serde_json::json!("tool plane unavailable")
    );
    assert_eq!(output["module"], serde_json::json!("aft"));
    // The bare event bytes are the frame's nested event, not a re-serialised
    // projection: the frame nests the bare twin verbatim.
    let bare: Value = serde_json::from_slice(&corpus_bytes("tool_finished.event.json"))
        .expect("bare event parses");
    assert_eq!(
        &frame["event"], &bare,
        "frame nests the bare event verbatim"
    );
    assert!(
        !crate::runner_follow::control_wake(&bare),
        "a bare tool_finished event is not a control wake"
    );
    // ck-mc has no typed decode for the bare event or for the unit's result:
    // the only readers are the wake predicate above (historian producer and
    // broca carrier call it; see historian_producer.rs and
    // dream_dispatch/broca_carrier.rs). A bare `tool_finished` event is never
    // sent as a unary reply, so the strict envelope would reject it by name
    // rather than misread it.
}

/// The gated WAL `tool_result` record carries `tool-times/v1` (a known
/// feature) and the outage error as an opaque `Value`: ck-mc never decodes WAL
/// records (only the dashboard WAL reader does), and the JSON shape keeps the
/// outage siblings beside `message` with `message` unchanged.
#[test]
fn tool_outage_wal_tool_result_record_shape() {
    let envelope = corpus_json("tool_result.record.json");
    assert_eq!(
        envelope["requires"],
        serde_json::json!(["tool-times/v1"]),
        "gated on a feature ck-mc does not read"
    );
    let record = &envelope["record"];
    assert_eq!(record["type"], serde_json::json!("tool_result"));
    let output = record.pointer("/result/output").expect("output");
    assert_eq!(output["kind"], serde_json::json!("error"));
    assert_eq!(
        output["message"],
        serde_json::json!("tool plane unavailable")
    );
    assert_eq!(output["module"], serde_json::json!("aft"));
    assert_eq!(output["code"], serde_json::json!("target_unavailable"));
}

/// Once decoded (or for any pre-outage error with the same `message`), every
/// model-visible rendering reads only the `message` text: the extra siblings
/// never reach the CK type, so summarizer input, ctx_expand views and tag text
/// stay byte-identical for the plain `message`.
#[test]
fn tool_outage_model_visible_text_stays_the_plain_message() {
    use crate::ck_wire::{CkOutputKind, CkToolOutput};
    let output = CkToolOutput::bare(CkOutputKind::ErrorText {
        text: "tool plane unavailable".into(),
    });
    // Tail-hygiene measurement, the shared tool-output text reader.
    assert_eq!(
        crate::tail_hygiene::tool_output_content(&output.kind),
        "tool plane unavailable"
    );
    // CK projection keeps the error text as the block's scalar text; the
    // retained original is absent for a bare block, so nothing extra renders.
    // A tool result pairs with its call, so project the call with it.
    let call = crate::ck_wire::CkIngressMessage {
        mid: "m1".into(),
        ordinal: 1,
        ck: crate::ck_wire::CkWireMessage::from_parts(
            "assistant",
            vec![crate::ck_wire::CkWireBlock::bare(
                crate::ck_wire::CkKind::ToolCall {
                    id: "call-1".into(),
                    name: "work".into(),
                    input: serde_json::json!({}),
                    provider_executed: false,
                },
            )],
            None,
            crate::ck_wire::ProviderExtras::new(),
            crate::ck_wire::HarnessMeta::default(),
        ),
    };
    let message = crate::ck_wire::CkIngressMessage {
        mid: "m2".into(),
        ordinal: 2,
        ck: crate::ck_wire::CkWireMessage::from_parts(
            "tool",
            vec![crate::ck_wire::CkWireBlock::bare(
                crate::ck_wire::CkKind::ToolResult {
                    id: "call-1".into(),
                    tool_name: String::new(),
                    output,
                    provider_executed: false,
                },
            )],
            None,
            crate::ck_wire::ProviderExtras::new(),
            crate::ck_wire::HarnessMeta::default(),
        ),
    };
    let messages = [call, message];
    let projection = crate::ck_wire::project_messages(&messages).expect("projects");
    assert_eq!(projection.blocks.len(), 2);
    assert_eq!(projection.blocks[1].kind_tag, "tool_result");
    assert_eq!(
        projection.blocks[1].output_kind.as_deref(),
        Some("error_text")
    );
    assert_eq!(
        projection.blocks[1].wire().kind,
        messages[1].ck.content[0].kind,
        "projection round-trips the error text"
    );
    // Tool-arc pairing keys on the call id, never on output content.
    assert_eq!(projection.blocks[1].tool_call_id.as_deref(), Some("call-1"));
    assert!(projection.blocks[1].arc_id.is_some());
    assert_eq!(projection.blocks[1].arc_id, projection.blocks[0].arc_id);
}
