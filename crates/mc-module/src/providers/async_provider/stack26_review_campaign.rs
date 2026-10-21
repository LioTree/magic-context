//! Temporary audit extension: native pairing and real person-command entry points.
use super::*;

pub(super) fn check_views(pair: &Pair, checked: &mut BTreeSet<u64>) {
    for (version, raw) in pair.resident.views(&pair.reference).0 {
        if !checked.insert(version) {
            continue;
        }
        let view: view::CompactionView = serde_json::from_str(&raw).unwrap();
        let mut messages: Vec<Value> = serde_json::from_slice(&pair.model_bytes(&view)).unwrap();
        let appended = pair.transcript.entries.lock().unwrap().iter().filter(|entry| entry.ordinal > view.covers_through.ordinal).count();
        messages.truncate(messages.len() - appended);
        let mut calls = BTreeSet::new();
        let mut results = BTreeSet::new();
        let mut unnamed = 0;
        for message in messages {
            if message["role"] == "toolResult" {
                results.insert(message["toolCallId"].as_str().unwrap().to_owned());
            }
            let content = message.get("parts").or_else(|| message.get("content"));
            for part in content.and_then(Value::as_array).into_iter().flatten() {
                match part["type"].as_str().unwrap_or("") {
                    "tool_use" | "toolCall" | "tool_call" => {
                        if let Some(id) = part.get("id").or_else(|| part.get("tool_call_id")).and_then(Value::as_str) {
                            calls.insert(id.to_owned());
                        } else {
                            unnamed += 1;
                        }
                    }
                    "tool_result" => {
                        results.insert(part.get("tool_use_id").or_else(|| part.get("tool_call_id")).and_then(Value::as_str).unwrap().to_owned());
                    }
                    "tool" => assert!(part["state"]["output"].is_string(), "completed OpenCode tool without output"),
                    _ => {}
                }
            }
        }
        let missing: Vec<_> = calls.difference(&results).collect();
        assert!(missing.is_empty(), "ORPHAN {:?} v{version} calls without results: {missing:?}; steps={:?}", pair.profile, pair.log);
        assert!(results.difference(&calls).count() >= unnamed, "id-less Pi calls without corresponding results");
    }
}

pub(super) async fn command(pair: &mut Pair, command: &str) {
    let before = pair.newest_versions();
    let key = format!("review-{}", pair.log.len());
    let mut replies = Vec::new();
    for side in [&pair.resident, &pair.oracle] {
        let mut binding = side.h.facade_binding(7).unwrap();
        binding.scope = Some(subc_protocol::scope::ScopeStamp::new(
            subc_protocol::Principal::Reserved { module_id: "prefrontal-core".into() },
            "person-session", 1, subc_protocol::scope::ScopeKind::Head,
        ).with_owner_authorized(true));
        side.h.bind_route(7, binding);
        let reply = side.dispatch(json!({"name":"user_command.invoke","call_key":key,
            "arguments":{"command":command,"input":if command == "ctx-wrapup" { "keep-1000000" } else { "" }}})).await;
        let Ok(reply) = serde_json::from_str::<Value>(&reply) else {
            replies.push(reply);
            continue;
        };
        if reply["state"] == "accepted" {
            let terminal = tokio::time::timeout(Duration::from_secs(20), async {
                loop {
                    let raw = side.dispatch(json!({"name":"late_results","arguments":{"since":null}})).await;
                    let late: Value = serde_json::from_str(&raw).unwrap();
                    if let Some(result) = late["entries"].as_array().unwrap().iter().find(|entry| entry["kind"] == "result" && entry["call_key"] == key) {
                        if result["result"]["state"] != "done" {
                            eprintln!("COMMAND {command} profile={:?} oracle={} detail={} steps={:?}", pair.profile, side.h.async_oracle(), result["result"], pair.log);
                        }
                        break result["result"]["state"].to_string();
                    }
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            }).await.expect("command completed");
            replies.push(terminal);
        } else {
            replies.push(reply["state"].to_string());
        }
        side.settle().await;
    }
    assert_eq!(replies[0], replies[1], "{command} outcome");
    pair.log.push(format!("user_command.invoke {command} {}", replies[0]));
    pair.compare(command);
    if command != "ctx-flush" {
        assert_eq!(before, pair.newest_versions(), "{command} must not grant rebuild permission");
    }
}
