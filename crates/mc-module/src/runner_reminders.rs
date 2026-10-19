//! Runner-lane reminders are sends, never edits to a tool result or user message.
//! Synchronous provider hooks deliberately do not call this module.

use cortexkit_role_llm_runner::delivery_order::{self, PlanSender, Slot, Template, TemplateUse};
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, path::Path, time::Duration};

use crate::{session_resolver::ProviderRunner, transform};

const MAX: i64 = i64::MAX;
const DELIVERY: [&str; 3] = ["turn_system", "tool_result", "steer"];
const SEARCH_DELIVERY: [&str; 2] = ["tool_result", "steer"];
/// All reminder kinds expire five minutes after the observation that produced them.
pub const REMINDER_TTL_MS: u64 = 300_000;

const BODIES: [(&str, &str); 5] = [
    ("gentle", "Housekeeping: {summary} are reclaimable. Stamp each output with ctx_reduce as soon as you've taken what you need from it; don't wait for the task to finish."),
    ("firm", "{summary} are reclaimable. Make a ctx_reduce pass now over the outputs you've already used, then continue."),
    ("urgent", "{summary} are still unstamped. Call ctx_reduce now, before your next tool call, on every output you've already used."),
    ("sticky", "Still unstamped: {summary}. Stamp the ones you've used with ctx_reduce now."),
    ("channel2", "Your next step: call ctx_reduce on the outputs you've already used ({summary}). Then continue your task."),
];

/// Fixed global plan templates. Hint slots are session-assigned tags, not tool names.
/// The digest is computed over the role's `{id,text,slots}` object, without metadata.
pub fn templates() -> Vec<Template> {
    let mut templates = Vec::new();
    for (kind, body) in BODIES {
        for count in ["zero", "one", "many"] {
            for hints in 0..=4 {
                let mut slots =
                    BTreeMap::from([("tokens_k".into(), Slot::Integer { min: 0, max: MAX })]);
                let outputs = match count {
                    "zero" => "spent tool outputs",
                    "one" => "1 spent tool output",
                    _ => {
                        slots.insert("count".into(), Slot::Integer { min: 2, max: MAX });
                        "{count} spent tool outputs"
                    }
                };
                let summary = format!("{outputs} (~{{tokens_k}}k tokens)");
                let mut text = if kind == "channel2" {
                    String::new()
                } else {
                    "\n\n".into()
                };
                text.push_str("<system-reminder>\n");
                text.push_str(&body.replace("{summary}", &summary));
                if hints > 0 {
                    text.push_str("\noldest reclaimable: ");
                    for i in 0..hints {
                        if i > 0 {
                            text.push_str(" · ");
                        }
                        text.push_str(&format!("{{tag{i}}}"));
                        slots.insert(format!("tag{i}"), Slot::Tag);
                    }
                    text.push('.');
                }
                text.push_str("\n</system-reminder>");
                templates.push(Template::new(
                    format!("mc.ctx_reduce.{kind}.{count}.h{hints}.v1"),
                    text,
                    slots,
                ));
            }
        }
    }
    let units = |values: &[&str]| Slot::Enum {
        values: values.iter().map(|v| (*v).into()).collect(),
    };
    let major = Slot::Integer { min: 1, max: MAX };
    templates.push(Template::new(
        "mc.time.single.v1",
        "<!-- +{major}{unit} -->\n",
        BTreeMap::from([
            ("major".into(), major.clone()),
            ("unit".into(), units(&["m", "h", "d", "w"])),
        ]),
    ));
    templates.push(Template::new(
        "mc.time.compound.v1",
        "<!-- +{major}{major_unit} {minor}{minor_unit} -->\n",
        BTreeMap::from([
            ("major".into(), major),
            ("minor".into(), Slot::Integer { min: 1, max: 59 }),
            ("major_unit".into(), units(&["h", "d", "w"])),
            ("minor_unit".into(), units(&["m", "h", "d"])),
        ]),
    ));
    templates
}

/// Core copies `sender` into the session plan's `senders` array. Descriptive
/// digests and delivery preferences are outside the plan's strict template object.
pub fn catalog() -> Value {
    let templates = templates();
    json!({
        "sender": PlanSender::new("magic-context").with_templates(templates.clone()),
        "templates": templates.iter().map(|t| json!({"id":t.id,"digest":delivery_order::template_digest(t),"delivery":DELIVERY})).collect::<Vec<_>>(),
        "search_hint": {"delivery":SEARCH_DELIVERY,"authority":"user"},
        "ttl_ms": REMINDER_TTL_MS,
    })
}

fn template_use(id: &str, slots: Map<String, Value>) -> TemplateUse {
    let templates = templates();
    let template = templates
        .iter()
        .find(|t| t.id == id)
        .expect("known reminder template");
    TemplateUse::new(id, delivery_order::template_digest(template), slots)
}

fn reduce_use(kind: &str, tokens: i64, count: usize, tags: &[u64]) -> TemplateUse {
    let count_kind = match count {
        0 => "zero",
        1 => "one",
        _ => "many",
    };
    let hints = tags.len().min(4);
    let mut slots = Map::from_iter([(
        "tokens_k".into(),
        json!((tokens.max(0) as f64 / 1000.0).round() as i64),
    )]);
    if count > 1 {
        slots.insert("count".into(), json!(count.min(MAX as usize)));
    }
    for (i, tag) in tags.iter().take(4).enumerate() {
        slots.insert(format!("tag{i}"), json!(format!("§{tag}§")));
    }
    template_use(
        &format!("mc.ctx_reduce.{kind}.{count_kind}.h{hints}.v1"),
        slots,
    )
}

fn time_use(gap_ms: i64) -> Option<TemplateUse> {
    let prefix = transform::temporal_gap_prefix(gap_ms)?;
    let gap = prefix.strip_prefix("<!-- +")?.strip_suffix(" -->\n")?;
    let parse = |part: &str| -> Option<(i64, String)> {
        Some((
            part[..part.len() - 1].parse().ok()?,
            part[part.len() - 1..].into(),
        ))
    };
    let mut parts = gap.split(' ');
    let (major, unit) = parse(parts.next()?)?;
    Some(if let Some(minor) = parts.next() {
        let (minor, minor_unit) = parse(minor)?;
        template_use(
            "mc.time.compound.v1",
            json!({"major":major,"major_unit":unit,"minor":minor,"minor_unit":minor_unit})
                .as_object()?
                .clone(),
        )
    } else {
        template_use(
            "mc.time.single.v1",
            json!({"major":major,"unit":unit}).as_object()?.clone(),
        )
    })
}

/// The notice handler persists this beside its cursor, under its conversation lock.
/// Cadence is advanced only after the runner accepts the corresponding send.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct ReminderState {
    pub meta: mc_store::ModuleMeta,
    last_tool_tag: Option<u64>,
    last_time_message: Option<String>,
    last_search_message: Option<String>,
}

/// Facts derived from the runner transcript, not from an untrusted notice body.
/// The handler supplies the same measured baseline and hint selection as the
/// synchronous policy. A ready search hint has already passed lexical-search,
/// score, prompt-length and already-shown-memory guards; no search is awaited.
pub struct ReminderConditions<'a> {
    pub notice_id: &'a str,
    pub now_ms: u64,
    pub real_user_turn_count: u64,
    pub baseline: Option<&'a mc_store::TailHygieneBaseline>,
    /// Newest eligible, unreduced, unserved tool result with text output.
    pub newest_tool_tag: Option<u64>,
    /// Already filtered for protection, queued drops, tiny and control outputs.
    pub oldest_reclaimable_tags: &'a [u64],
    /// Separate channel-2 selection: unqueued, unprotected tool tags >=100 tokens.
    pub channel2_tags: &'a [u64],
    pub drops_applied: bool,
    /// A fresh measurement, rather than a cached/invalid baseline.
    pub baseline_refreshed: bool,
    /// True only when a hard fold actually advanced transcript coverage.
    pub hard_fold_coverage_advanced: bool,
    /// An authored user message eligible for a temporal marker and/or search hint.
    pub user_message_id: Option<&'a str>,
    pub temporal_enabled: bool,
    /// Created time minus the preceding message's completed (else created) time.
    pub gap_ms: Option<i64>,
    pub ready_search_hint: Option<&'a str>,
}

#[derive(Debug, Default)]
pub struct ReminderOutcome {
    pub issued: Vec<Value>,
    pub not_due: Vec<&'static str>,
    pub errors: Vec<String>,
}

struct PreparedSend {
    kind: &'static str,
    template: Option<TemplateUse>,
    prompt: String,
    expires_at_ms: u64,
}

impl PreparedSend {
    fn reminder(kind: &'static str, template: TemplateUse, now_ms: u64) -> Self {
        Self {
            kind,
            template: Some(template),
            prompt: String::new(),
            expires_at_ms: now_ms.saturating_add(REMINDER_TTL_MS),
        }
    }

    fn request(&self, project: &Path, session: &str, notice: &str) -> Value {
        // The immutable payload, not the replacement key, identifies a retry.
        let identity = json!([
            project.to_string_lossy(),
            session,
            notice,
            self.kind,
            self.template,
            self.prompt,
            self.expires_at_ms
        ]);
        let send_id =
            crate::sha256_hex(&serde_jcs::to_vec(&identity).expect("send identity serializes"));
        self.wire_request(send_id)
    }

    fn wire_request(&self, _send_id: String) -> Value {
        // Replaced with the runner crate's array-delivery builder once pinned.
        unimplemented!("awaiting the array-delivery contract revision")
    }
}

async fn issue(
    runner: &dyn ProviderRunner,
    project: &Path,
    session: &str,
    notice: &str,
    send: PreparedSend,
    outcome: &mut ReminderOutcome,
) -> bool {
    let request = send.request(project, session, notice);
    match runner
        .call(
            project,
            session,
            "session.send",
            request.clone(),
            Duration::from_millis(1_500),
        )
        .await
    {
        Ok(reply) if accepted(&reply) => {
            outcome.issued.push(request);
            true
        }
        Ok(reply) => {
            outcome.errors.push(format!("{}: {reply}", send.kind));
            false
        }
        Err(error) => {
            outcome.errors.push(format!("{}: {error}", send.kind));
            false
        }
    }
}

fn accepted(reply: &Value) -> bool {
    use cortexkit_role_llm_runner::send::{SendReply, SendState};
    let body = reply.get("result").unwrap_or(reply);
    serde_json::from_value::<SendReply>(body.clone()).is_ok_and(|reply| {
        matches!(
            reply.send_state(),
            SendState::Pending | SendState::Active | SendState::Finished | SendState::Paused
        )
    })
}

/// Send best-effort reminders without modifying stored tool results or user messages.
///
/// `send_due_reminders(runner.as_ref(), project_root, session, &mut state, &conditions).await`
/// is called after reading new transcript entries and measuring their reclaimable
/// context. Serialize calls per conversation, and persist `state` with the last
/// processed transcript position. `runner` must route to this session's runner.
/// Search results are optional: the user's message never waits for a search.
/// `conditions.baseline` carries the usage/window-adjusted hygiene measurement;
/// `newest_tool_tag` must satisfy the eligibility documented on that field.
pub async fn send_due_reminders(
    runner: &dyn ProviderRunner,
    project_root: &Path,
    session: &str,
    state: &mut ReminderState,
    conditions: &ReminderConditions<'_>,
) -> ReminderOutcome {
    let mut outcome = ReminderOutcome::default();
    // Older runners may ignore unknown fields and start an unwanted run. Never
    // send until discovery explicitly promises ordered, non-starting delivery.
    let description = match runner
        .call(
            project_root,
            session,
            "role.describe",
            json!({}),
            Duration::from_millis(1_500),
        )
        .await
    {
        Ok(value) => value,
        Err(error) => {
            outcome.errors.push(error.to_string());
            return outcome;
        }
    };
    let description = description.get("result").unwrap_or(&description);
    if cortexkit_role_llm_runner::describe::check_describe(description).is_err()
        || !description["capabilities"]
            .as_array()
            .is_some_and(|caps| caps.iter().any(|cap| cap == "delivery_order"))
    {
        outcome.not_due.push("runner_missing_delivery_order");
        return outcome;
    }

    let mut next = state.meta.clone();
    next.tail_hygiene_baseline = conditions.baseline.cloned();
    let mut baseline = next.tail_hygiene_baseline.clone();
    transform::apply_channel1_compliance_grace(&mut next, &mut baseline, conditions.drops_applied);
    let decision =
        transform::decide_channel1(baseline.as_ref(), &next, conditions.real_user_turn_count);
    let carrier = conditions
        .newest_tool_tag
        .filter(|tag| Some(*tag) != state.last_tool_tag);
    if decision.fire && !conditions.drops_applied && carrier.is_some() {
        let kind = if decision.sticky {
            "sticky"
        } else {
            match decision.level {
                transform::Channel1Level::Gentle => "gentle",
                transform::Channel1Level::Firm => "firm",
                transform::Channel1Level::Urgent => "urgent",
            }
        };
        let count = transform::reclaimable_tool_output_count(baseline.as_ref());
        let use_ = reduce_use(
            kind,
            decision.reclaimable_tokens,
            count,
            conditions.oldest_reclaimable_tags,
        );
        if issue(
            runner,
            project_root,
            session,
            conditions.notice_id,
            PreparedSend::reminder("ctx_reduce", use_, conditions.now_ms),
            &mut outcome,
        )
        .await
        {
            transform::commit_channel1_fire(
                &decision,
                &mut next,
                conditions.real_user_turn_count,
                count,
                &[],
            );
            state.last_tool_tag = carrier;
            state.meta = next;
        }
    } else {
        if !decision.fire && !conditions.drops_applied {
            transform::apply_channel1_decision_state(&mut next, &decision);
        }
        state.meta = next;
        outcome.not_due.push("ctx_reduce_cadence_or_carrier");
    }

    let pressure = baseline
        .as_ref()
        .filter(|b| b.evaluable && !b.generation_invalidated)
        .is_some_and(|b| {
            let (u, t) = crate::tail_hygiene::effective_tail_hygiene(b);
            u >= crate::tail_hygiene::CHANNEL2_FLOOR_TOKENS
                && u as f64 / t.max(1) as f64 >= crate::tail_hygiene::CHANNEL2_SEVERITY_THRESHOLD
        });
    let collapse = conditions.baseline_refreshed
        && baseline.as_ref().is_some_and(|b| {
            b.evaluable
                && !b.generation_invalidated
                && crate::tail_hygiene::effective_tail_hygiene(b).0
                    < crate::tail_hygiene::CHANNEL1_FLOOR_TOKENS
        });
    if conditions.hard_fold_coverage_advanced || collapse {
        state.meta.channel2_pressure_latched = false;
    }
    if pressure && !state.meta.channel2_pressure_latched {
        let (u, _) = crate::tail_hygiene::effective_tail_hygiene(
            baseline.as_ref().expect("evaluable baseline"),
        );
        let use_ = reduce_use(
            "channel2",
            u,
            transform::reclaimable_tool_output_count(baseline.as_ref()),
            conditions.channel2_tags,
        );
        if issue(
            runner,
            project_root,
            session,
            conditions.notice_id,
            PreparedSend::reminder("ctx_reduce", use_, conditions.now_ms),
            &mut outcome,
        )
        .await
        {
            state.meta.channel2_pressure_latched = true;
        }
    } else {
        outcome.not_due.push("channel2_pressure_or_latch");
    }

    if let Some(mid) = conditions.user_message_id {
        let marker = conditions
            .temporal_enabled
            .then(|| conditions.gap_ms.and_then(time_use))
            .flatten();
        if let Some(marker) = marker.filter(|_| state.last_time_message.as_deref() != Some(mid)) {
            if issue(
                runner,
                project_root,
                session,
                conditions.notice_id,
                PreparedSend::reminder("time", marker, conditions.now_ms),
                &mut outcome,
            )
            .await
            {
                state.last_time_message = Some(mid.into());
            }
        } else {
            outcome.not_due.push("time_disabled_short_gap_or_replay");
        }
        if let Some(hint) = conditions
            .ready_search_hint
            .filter(|hint| !hint.is_empty())
            .filter(|_| state.last_search_message.as_deref() != Some(mid))
        {
            let send = PreparedSend {
                kind: "search_hint",
                template: None,
                prompt: hint.into(),
                expires_at_ms: conditions.now_ms.saturating_add(REMINDER_TTL_MS),
            };
            if issue(
                runner,
                project_root,
                session,
                conditions.notice_id,
                send,
                &mut outcome,
            )
            .await
            {
                state.last_search_message = Some(mid.into());
            }
        } else {
            outcome.not_due.push("search_not_ready_or_replay");
        }
    } else {
        outcome.not_due.push("no_eligible_user_message");
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_resolver::SessionResolveError;
    use std::sync::Mutex;

    #[test]
    fn templates_render_typescript_fixture_bytes() {
        let fixture: Value =
            serde_json::from_str(include_str!("../testdata/runner-reminder-fixture.json")).unwrap();
        let templates = templates();
        assert_eq!(templates.len(), 77);
        let mut covered = std::collections::BTreeSet::new();
        for case in fixture["reduce"].as_array().unwrap() {
            let tags: Vec<u64> = serde_json::from_value(case["tags"].clone()).unwrap();
            let use_ = reduce_use(
                case["kind"].as_str().unwrap(),
                case["tokens"].as_i64().unwrap(),
                case["count"].as_u64().unwrap() as usize,
                &tags,
            );
            let rendered =
                delivery_order::render(&templates, &use_, |n| tags.contains(&n)).unwrap();
            assert_eq!(rendered, case["expected"].as_str().unwrap(), "{}", use_.id);
            covered.insert(use_.id);
        }
        for case in fixture["time"].as_array().unwrap() {
            let use_ = time_use(case["gap_ms"].as_i64().unwrap());
            let rendered = use_
                .as_ref()
                .map(|use_| delivery_order::render(&templates, use_, |_| false).unwrap());
            assert_eq!(rendered.as_deref(), case["expected"].as_str());
            if let Some(use_) = use_ {
                covered.insert(use_.id);
            }
        }
        assert_eq!(
            covered.len(),
            templates.len(),
            "every template needs an oracle case"
        );
    }

    #[test]
    fn template_catalog_rejects_string_slots() {
        let catalog = catalog();
        if std::env::var_os("MC_PRINT_REMINDER_CATALOG").is_some() {
            println!("REMINDER_CATALOG={catalog}");
        }
        let plan = json!({"senders":[catalog["sender"].clone()]});
        delivery_order::check_plan(plan.as_object().unwrap(), &["delivery_order"]).unwrap();
        let senders = delivery_order::plan_senders(plan.as_object().unwrap()).unwrap();
        assert!(!senders[0].idle_start);
        for template in &senders[0].templates {
            let published = catalog["templates"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["id"] == template.id)
                .unwrap();
            assert_eq!(
                published["digest"],
                delivery_order::template_digest(template)
            );
            for slot in template.slots.values() {
                assert!(matches!(
                    slot,
                    Slot::Integer { .. } | Slot::Percentage | Slot::Tag | Slot::Enum { .. }
                ));
            }
        }
        let use_ = reduce_use("gentle", 30_000, 7, &[12]);
        let mut string_value = use_.clone();
        string_value.slots.insert("tokens_k".into(), json!("30"));
        assert!(delivery_order::render(&templates(), &string_value, |_| true).is_err());
        assert!(
            delivery_order::render(&templates(), &use_, |_| false).is_err(),
            "unassigned tags must not render"
        );
    }

    #[derive(Default)]
    struct FakeRunner {
        sends: Mutex<Vec<Value>>,
        missing_capability: bool,
        refuse: bool,
    }

    #[subc_client_rs::async_trait]
    impl ProviderRunner for FakeRunner {
        async fn call(
            &self,
            _: &Path,
            session: &str,
            method: &str,
            params: Value,
            _: Duration,
        ) -> Result<Value, SessionResolveError> {
            assert_eq!(session, "reminder-test");
            match method {
                "role.describe" => Ok(json!({
                    "majors":[{"version":"llm-runner/v1","ops":["role.describe","session.baseline","session.send"]}],
                    "implementation_version":"fake", "session_capabilities_from":"baseline",
                    "capabilities":if self.missing_capability {vec![]} else {vec!["delivery_order"]}
                })),
                "session.send" => {
                    self.sends.lock().unwrap().push(params);
                    if self.refuse {
                        Ok(json!({"error":{"code":"invalid_params"}}))
                    } else {
                        Ok(json!({"state":"pending","submission_id":"q"}))
                    }
                }
                _ => panic!("unexpected callback {method}"),
            }
        }
    }

    fn baseline(u: i64, t: i64) -> mc_store::TailHygieneBaseline {
        mc_store::TailHygieneBaseline {
            baseline_u: u,
            baseline_t: t,
            evaluable: true,
            ..Default::default()
        }
    }

    fn conditions(baseline: &mc_store::TailHygieneBaseline) -> ReminderConditions<'_> {
        ReminderConditions {
            notice_id: "advance:7",
            now_ms: 1_000_000,
            real_user_turn_count: 1,
            baseline: Some(baseline),
            newest_tool_tag: Some(21),
            oldest_reclaimable_tags: &[12, 15],
            channel2_tags: &[12],
            drops_applied: false,
            baseline_refreshed: true,
            hard_fold_coverage_advanced: false,
            user_message_id: Some("user-1"),
            temporal_enabled: true,
            gap_ms: Some(7_260_000),
            ready_search_hint: Some(
                "\n\n<ctx-search-hint>Recovered memory is not system text.</ctx-search-hint>",
            ),
        }
    }

    async fn sends() -> Vec<Value> {
        let runner = FakeRunner::default();
        let baseline = baseline(30_000, 100_000);
        let outcome = send_due_reminders(
            &runner,
            Path::new("/throwaway/reminders"),
            "reminder-test",
            &mut ReminderState::default(),
            &conditions(&baseline),
        )
        .await;
        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
        assert_eq!(outcome.issued.len(), 3);
        runner.sends.into_inner().unwrap()
    }

    #[tokio::test]
    async fn fake_runner_delivery_list_is_exact() {
        let sends = sends().await;
        assert_eq!(
            sends[0]["delivery"],
            json!(["turn_system", "tool_result", "steer"])
        );
        assert_eq!(
            sends[1]["delivery"],
            json!(["turn_system", "tool_result", "steer"])
        );
        assert_eq!(sends[2]["delivery"], json!(["tool_result", "steer"]));
        for send in sends {
            assert!(send.get("delivery_order").is_none());
        }
    }

    #[tokio::test]
    async fn fake_runner_requires_dedupe_per_kind() {
        let sends = sends().await;
        assert_eq!(sends[0]["dedupe_key"], "mc.ctx_reduce");
        assert_eq!(sends[1]["dedupe_key"], "mc.time");
        assert_eq!(sends[2]["dedupe_key"], "mc.search_hint");
    }

    #[tokio::test]
    async fn fake_runner_receives_templates_slots_expiry_and_user_search() {
        let sends = sends().await;
        assert_eq!(
            sends[0]["template"]["id"],
            "mc.ctx_reduce.gentle.zero.h2.v1"
        );
        assert_eq!(
            sends[0]["template"]["slots"],
            json!({"tokens_k":30,"tag0":"§12§","tag1":"§15§"})
        );
        assert_eq!(sends[1]["template"]["id"], "mc.time.compound.v1");
        assert_eq!(
            sends[1]["template"]["slots"],
            json!({"major":2,"major_unit":"h","minor":1,"minor_unit":"m"})
        );
        assert_eq!(sends[0]["prompt"], "");
        assert_eq!(sends[1]["prompt"], "");
        assert!(sends[2].get("template").is_none());
        assert!(sends[2]["prompt"]
            .as_str()
            .unwrap()
            .contains("Recovered memory"));
        for send in sends {
            assert_eq!(send["expires_at_ms"], 1_300_000);
            assert!(!send["send_id"].as_str().unwrap().is_empty());
            if let Some(template) = send.get("template") {
                let use_: TemplateUse = serde_json::from_value(template.clone()).unwrap();
                delivery_order::render(&templates(), &use_, |n| [12, 15].contains(&n)).unwrap();
            }
        }
    }

    #[tokio::test]
    async fn reminder_cadence_grace_replay_and_capability_guards() {
        let runner = FakeRunner::default();
        let root = Path::new("/throwaway/reminders");
        let baseline = baseline(30_000, 100_000);
        let mut conditions = conditions(&baseline);
        let mut state = ReminderState::default();
        let first =
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions).await;
        assert_eq!(first.issued.len(), 3);
        let replay =
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions).await;
        assert!(replay.issued.is_empty());
        conditions.real_user_turn_count = 6;
        conditions.newest_tool_tag = Some(22);
        let grown = self::baseline(60_000, 110_000);
        conditions.baseline = Some(&grown);
        let firm =
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions).await;
        assert_eq!(
            firm.issued[0]["template"]["id"],
            "mc.ctx_reduce.firm.zero.h2.v1"
        );
        conditions.drops_applied = true;
        conditions.newest_tool_tag = Some(23);
        let applied =
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions).await;
        assert!(applied.issued.is_empty());
        let unsupported = FakeRunner {
            missing_capability: true,
            ..Default::default()
        };
        let no_cap = send_due_reminders(
            &unsupported,
            root,
            "reminder-test",
            &mut ReminderState::default(),
            &conditions,
        )
        .await;
        assert_eq!(no_cap.not_due, ["runner_missing_delivery_order"]);
        assert!(unsupported.sends.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn runner_refusal_does_not_consume_cadence_and_retry_ids_are_stable() {
        let runner = FakeRunner {
            refuse: true,
            ..Default::default()
        };
        let root = Path::new("/throwaway/reminders");
        let baseline = baseline(30_000, 100_000);
        let conditions = conditions(&baseline);
        let mut state = ReminderState::default();
        let first =
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions).await;
        let second =
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions).await;
        assert_eq!(first.errors.len(), 3);
        assert_eq!(second.errors.len(), 3);
        assert_eq!(state.meta.channel1_last_fire_ordinal, 0);
        let attempts = runner.sends.lock().unwrap();
        assert_eq!(&attempts[..3], &attempts[3..]);
    }

    #[tokio::test]
    async fn sticky_repeat_keeps_regrowth_and_five_user_turn_guards() {
        let runner = FakeRunner::default();
        let root = Path::new("/throwaway/reminders");
        let initial = baseline(40_000, 200_000);
        let mut conditions = conditions(&initial);
        conditions.user_message_id = None;
        let mut state = ReminderState::default();
        assert_eq!(
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions)
                .await
                .issued
                .len(),
            1
        );
        let grown = baseline(65_000, 200_000);
        conditions.baseline = Some(&grown);
        conditions.newest_tool_tag = Some(22);
        conditions.real_user_turn_count = 5;
        assert!(
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions)
                .await
                .issued
                .is_empty()
        );
        conditions.real_user_turn_count = 6;
        let repeated =
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions).await;
        assert_eq!(repeated.issued.len(), 1);
        assert_eq!(
            repeated.issued[0]["template"]["id"],
            "mc.ctx_reduce.sticky.zero.h2.v1"
        );
    }

    #[tokio::test]
    async fn channel2_latch_rearms_on_measured_collapse_or_coverage_advance() {
        let runner = FakeRunner::default();
        let root = Path::new("/throwaway/reminders");
        let pressure = baseline(80_000, 100_000);
        let mut conditions = conditions(&pressure);
        conditions.user_message_id = None;
        conditions.newest_tool_tag = None;
        let mut state = ReminderState::default();
        let first =
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions).await;
        assert_eq!(first.issued.len(), 1);
        assert_eq!(
            first.issued[0]["template"]["id"],
            "mc.ctx_reduce.channel2.zero.h1.v1"
        );
        let lower = baseline(40_000, 100_000);
        conditions.baseline = Some(&lower);
        assert!(
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions)
                .await
                .issued
                .is_empty()
        );
        conditions.baseline = Some(&pressure);
        assert!(
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions)
                .await
                .issued
                .is_empty()
        );
        let collapse = baseline(20_000, 100_000);
        conditions.baseline = Some(&collapse);
        send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions).await;
        conditions.baseline = Some(&pressure);
        assert_eq!(
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions)
                .await
                .issued
                .len(),
            1
        );
        conditions.hard_fold_coverage_advanced = true;
        assert_eq!(
            send_due_reminders(&runner, root, "reminder-test", &mut state, &conditions)
                .await
                .issued
                .len(),
            1
        );
    }

    #[test]
    fn unknown_or_refused_send_reply_is_not_acceptance() {
        assert!(!accepted(&json!({})));
        assert!(!accepted(&json!({"state":"future_unknown_state"})));
        assert!(!accepted(&json!({"error":{"code":"invalid_params"}})));
        assert!(accepted(
            &json!({"result":{"state":"pending","submission_id":"q"}})
        ));
    }
}
