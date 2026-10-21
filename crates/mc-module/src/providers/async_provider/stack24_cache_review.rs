//! Independent cache-review witnesses; these tests do not change provider policy.
//!
//! `Review` adds two observations to the resident-versus-oracle differential
//! that do not depend on the oracle agreeing with the resident:
//!
//! - Served-edit stability: once the runner acknowledged a view, every later
//!   view that keeps the same unchanged source part must keep that part's edit
//!   (the frozen-replay rule). A later view that restores dropped bytes or
//!   rewrites an acknowledged edit is reported with the step that published it.
//! - Reminder echoes: with `echoes`, the fake runner delivers each accepted
//!   `session.send` into the transcript the way a real runner would (a steer
//!   user block, a user message mixing the reminder with authored words, or a
//!   text block inside a tool result), and sometimes the user pastes the text
//!   of a reminder that was already delivered. A view that drops a user text
//!   part which was not a delivered reminder is reported.
use super::*;
use std::collections::VecDeque;

type PartKey = (u64, String, String);

/// A part's edit in one view: `None` when the view keeps the source bytes,
/// `Some(None)` when it drops the part, `Some(Some(bytes))` when it replaces it.
type EditValue = Option<Option<String>>;

struct Snapshot {
    version: u64,
    /// Index of the operation that published this view, in `Pair::log`.
    step: usize,
    /// The publishing operation and the two before it.
    context: String,
    /// The provider's resync generation when it published.
    generation: u64,
    parts: BTreeMap<PartKey, (String, EditValue)>,
}

#[derive(Default)]
pub(super) struct Review {
    pub(super) echoes: bool,
    /// Rendered texts of accepted sends not yet delivered into the transcript.
    queue: VecDeque<String>,
    consumed_sends: usize,
    delivered: Vec<String>,
    /// Parts whose whole text is a delivered reminder.
    echo_parts: BTreeSet<PartKey>,
    /// Parts holding a user's paste of an already delivered reminder.
    pasted_parts: BTreeSet<PartKey>,
    /// Every acknowledgement in the order the runner sent it: the index of
    /// the operation carrying it, and the version it names.
    acks: Vec<(usize, u64)>,
    snapshots: Vec<Snapshot>,
    /// Tags an agent `ctx_reduce` named; dropping their parts is requested.
    pub(super) requested: BTreeSet<u64>,
    pub(super) violations: Vec<String>,
    pub(super) counts: BTreeMap<String, u64>,
}

fn rendered_send(params: &Value) -> Option<String> {
    let request: cortexkit_role_llm_runner::send::SendRequest =
        serde_json::from_value(params.clone()).ok()?;
    let order = request.delivery_order().ok()??;
    match order.template {
        Some(template) => cortexkit_role_llm_runner::delivery_order::render(
            &crate::runner_reminders::templates(),
            &template,
            |_| true,
        )
        .ok(),
        None => request.prompt.clone(),
    }
}

fn user_body(profile: Profile, n: u64, texts: &[String]) -> Value {
    match profile {
        Profile::OpenCode => {
            json!({"info":{"id":format!("m{n}"),"role":"user","time":{"created":1}},
            "parts":texts.iter().enumerate().map(|(i, text)| json!({"id":format!("p{n}r{i}"),"type":"text","text":text})).collect::<Vec<_>>()})
        }
        Profile::Pi => {
            json!({"type":"message","id":format!("m{n}"),"parentId":format!("m{}", n.saturating_sub(1)),
            "timestamp":"2026-05-01T16:52:33.700Z","message":{"role":"user",
            "content":texts.iter().map(|text| json!({"type":"text","text":text})).collect::<Vec<_>>()}})
        }
        Profile::Broca | Profile::Anthropic => json!({"role":"user",
            "content":texts.iter().map(|text| json!({"type":"text","text":text})).collect::<Vec<_>>()}),
    }
}

fn is_user(profile: Profile, message: &Value) -> bool {
    let role = match profile {
        Profile::OpenCode => message.pointer("/info/role"),
        Profile::Pi => message.pointer("/message/role"),
        _ => message.get("role"),
    };
    role.and_then(Value::as_str) == Some("user")
}

impl Review {
    pub(super) fn collect_sends(&mut self, sends: &[Value]) {
        for params in sends.iter().skip(self.consumed_sends) {
            *self.counts.entry("sends".into()).or_default() += 1;
            if let Some(text) = rendered_send(params) {
                self.queue.push_back(text);
            }
        }
        self.consumed_sends = sends.len();
    }

    /// The runner's message `n` when it carries a reminder echo or a user's
    /// paste of one, else `None` for the ordinary fixture message.
    pub(super) fn message(&mut self, profile: Profile, n: u64, salt: u64) -> Option<ReadMessage> {
        if !self.echoes {
            return None;
        }
        let user_slot = if profile == Profile::OpenCode {
            n.is_multiple_of(5)
        } else {
            n.is_multiple_of(4)
        };
        let tool_slot = matches!(profile, Profile::Anthropic | Profile::Pi) && n % 8 == 2;
        let authored = format!("user {n}.{salt} ") + &"durable words ".repeat(12);
        let mid = format!("m{n}");
        let mut entry = if user_slot && !self.queue.is_empty() {
            let text = self.queue.pop_front().unwrap();
            self.delivered.push(text.clone());
            let texts = if n % 3 == 1 {
                *self.counts.entry("mixed_echoes".into()).or_default() += 1;
                vec![text, authored]
            } else {
                *self.counts.entry("steer_echoes".into()).or_default() += 1;
                vec![text]
            };
            self.echo_parts.insert((n, mid.clone(), "0".into()));
            let rows = (0..texts.len() as u64)
                .map(|part| tags::PartTag::tagged(part.to_string(), tag(n, part)))
                .collect();
            ReadMessage::new(n, mid, user_body(profile, n, &texts)).with_tags(rows)
        } else if user_slot && n.is_multiple_of(7) && !self.delivered.is_empty() {
            // The user pastes the exact text of a reminder delivered earlier.
            let text = self.delivered.last().unwrap().clone();
            *self.counts.entry("pastes".into()).or_default() += 1;
            self.pasted_parts.insert((n, mid.clone(), "0".into()));
            ReadMessage::new(n, mid, user_body(profile, n, &[text]))
                .with_tags(vec![tags::PartTag::tagged("0", tag(n, 0))])
        } else if tool_slot && !self.queue.is_empty() {
            let text = self.queue.pop_front().unwrap();
            self.delivered.push(text.clone());
            *self.counts.entry("tool_result_echoes".into()).or_default() += 1;
            let mut entry = message(profile, n, salt);
            if profile == Profile::Pi {
                entry.message["message"]["content"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"type":"text","text":text}));
                entry.tags.push(tags::PartTag::untagged("1"));
                self.echo_parts.insert((n, mid, "1".into()));
            } else {
                let output = entry.message["content"][0]["content"].take();
                entry.message["content"][0]["content"] =
                    json!([{"type":"text","text":output},{"type":"text","text":text}]);
            }
            return Some(entry);
        } else {
            return None;
        };
        entry.written_at = Some(1_000_000 + n * 7_000);
        Some(entry)
    }

    pub(super) fn acknowledge(&mut self, step: usize, version: u64) {
        self.acks.push((step, version));
    }

    /// Record a newly published view. `log` holds the operations so far, the
    /// last being the one that published it; `coverage` and `generation` are
    /// the provider's historian coverage and resync generation at that point.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn record_view(
        &mut self,
        profile: Profile,
        version: u64,
        view: &view::CompactionView,
        entries: &[ReadMessage],
        log: &[String],
        coverage: Option<u64>,
        generation: u64,
        model: &str,
    ) {
        let step = log.len();
        let context = log
            .iter()
            .rev()
            .take(3)
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join(" <- ");
        let mut parts = BTreeMap::new();
        for range in &view.ranges {
            let view::ViewRange::Keep { from, to, edits } = range else {
                continue;
            };
            for entry in entries
                .iter()
                .filter(|e| e.ordinal >= *from && e.ordinal < *to)
            {
                let digest = contract::digest::content_digest(&entry.message);
                let sources = parts_of(&entry.message);
                let dropped_parts = entry
                    .tags
                    .iter()
                    .filter(|row| {
                        edits.iter().any(|edit| {
                            edit.ordinal == entry.ordinal
                                && edit.mid == entry.mid
                                && edit.part == row.part
                                && edit.bytes.is_none()
                        })
                    })
                    .count();
                for (index, row) in entry.tags.iter().enumerate() {
                    let key = (entry.ordinal, entry.mid.clone(), row.part.clone());
                    let edit = edits.iter().find(|edit| {
                        edit.ordinal == entry.ordinal
                            && edit.mid == entry.mid
                            && edit.part == row.part
                    });
                    let value = edit.map(|edit| edit.bytes.clone());
                    let text_part = sources
                        .get(index)
                        .is_some_and(|part| part.is_string() || part["type"] == "text");
                    // Covered messages may be removed whole. A drop is reported for live,
                    // uncovered user text that is not a delivered reminder, unless an agent
                    // `ctx_reduce` requested it or the words are still in the model input
                    // (that exemption does not cover a user's paste of a reminder).
                    let live = coverage.is_none_or(|covered| entry.ordinal > covered);
                    // A replacement inserted at the start of the model input may still
                    // carry the part's words after the source part is dropped.
                    let still_served = sources
                        .get(index)
                        .and_then(|part| part.as_str().or_else(|| part["text"].as_str()))
                        .is_some_and(|text| {
                            let probe: String = text.chars().take(40).collect();
                            model.contains(&probe)
                        });
                    let requested = row
                        .tag
                        .as_deref()
                        .and_then(tags::parse_tag)
                        .is_some_and(|tag| self.requested.contains(&tag));
                    if matches!(value, Some(None))
                        && text_part
                        && live
                        && !requested
                        && (!still_served || self.pasted_parts.contains(&key))
                        && is_user(profile, &entry.message)
                        && !self.echo_parts.contains(&key)
                    {
                        let kind = if self.pasted_parts.contains(&key) {
                            "pasted reminder text"
                        } else {
                            "authored user text"
                        };
                        let whole = if dropped_parts == entry.tags.len() {
                            "whole message"
                        } else {
                            "single part"
                        };
                        self.violations.push(format!(
                            "AUTHORED view {version} ({context}) dropped {kind} ({whole}) at {key:?}"
                        ));
                    }
                    if self.echo_parts.contains(&key) && matches!(value, Some(None)) {
                        *self
                            .counts
                            .entry("echo_part_strips_in_views".into())
                            .or_default() += 1;
                    }
                    parts.insert(key, (digest.clone(), value));
                }
            }
        }
        self.snapshots.push(Snapshot {
            version,
            step,
            context,
            generation,
            parts,
        });
    }

    /// Compare every view with the view the runner had most recently
    /// acknowledged before it was published.
    pub(super) fn check_served_edits(&mut self) {
        let by_version: BTreeMap<u64, usize> = self
            .snapshots
            .iter()
            .enumerate()
            .map(|(index, snapshot)| (snapshot.version, index))
            .collect();
        for snapshot in &self.snapshots {
            let Some(served) = self
                .acks
                .iter()
                .rev()
                .find(|(step, version)| *step < snapshot.step && *version < snapshot.version)
                .and_then(|(_, version)| by_version.get(version))
                .map(|index| &self.snapshots[*index])
            else {
                continue;
            };
            for (key, (digest, value)) in &snapshot.parts {
                let Some((served_digest, served_value)) = served.parts.get(key) else {
                    continue;
                };
                if served_digest != digest || served_value.is_none() || served_value == value {
                    continue;
                }
                let change = if value.is_none() {
                    "RESTORED source bytes"
                } else {
                    "REWROTE the edit"
                };
                let across = if served.generation == snapshot.generation {
                    "same generation".to_owned()
                } else {
                    format!(
                        "across resync g{}->g{}",
                        served.generation, snapshot.generation
                    )
                };
                self.violations.push(format!(
                    "{change} [{across}] view {} ({}) at {key:?}; acknowledged view {} ({}) served {served_value:?}; now {value:?}",
                    snapshot.version, snapshot.context, served.version, served.context
                ));
            }
        }
        *self.counts.entry("views".into()).or_default() += self.snapshots.len() as u64;
    }
}

fn parts_of(message: &Value) -> Vec<Value> {
    parts(message).unwrap().into_owned()
}

/// One differential session with the review observations; returns the
/// violations and counters instead of failing, so a campaign lists them all.
async fn review_session(
    profile: Profile,
    seed: u64,
    steps: u64,
    echoes: bool,
) -> (Vec<String>, BTreeMap<String, u64>, Vec<String>) {
    let pair = session_pair_with(profile, seed, steps, echoes).await;
    let mut review = pair.review.borrow_mut();
    review.check_served_edits();
    (
        std::mem::take(&mut review.violations),
        review.counts.clone(),
        pair.log.clone(),
    )
}

/// The randomized differential with the review observations: sessions
/// `MC_STACK24_FIRST_SEED`.. (default 1000) over all four schemas,
/// `MC_STACK24_SESSIONS` (default 400) sessions of `MC_STACK24_STEPS`
/// (default 24) steps, with runner reminder echoes when `MC_STACK24_ECHOES=1`.
/// Divergences from the oracle and review violations are listed together.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "long randomized review campaign; run explicitly with --ignored"]
async fn stack24_review_campaign() {
    let var = |name: &str, default: u64| {
        std::env::var(name)
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(default)
    };
    let sessions = var("MC_STACK24_SESSIONS", 400);
    let steps = var("MC_STACK24_STEPS", 24);
    let first = var("MC_STACK24_FIRST_SEED", 1_000);
    let echoes = var("MC_STACK24_ECHOES", 0) == 1;
    // Bound parallel sessions on busy runners instead of extending compaction.ride request deadlines.
    let concurrency = var("MC_STACK24_CONCURRENCY", 8).max(1) as usize;
    let mut failures = Vec::new();
    let mut totals: BTreeMap<String, u64> = BTreeMap::new();
    let mut classes: BTreeMap<String, u64> = BTreeMap::new();
    let mut tasks = Vec::new();
    for index in 0..sessions {
        let profile = PROFILES[(index % 4) as usize];
        let seed = first + index;
        tasks.push((
            seed,
            profile,
            tokio::spawn(review_session(profile, seed, steps, echoes)),
        ));
        if tasks.len() == concurrency || index + 1 == sessions {
            for (seed, profile, task) in std::mem::take(&mut tasks) {
                match task.await {
                    Ok((violations, counts, log)) => {
                        for (name, count) in counts {
                            *totals.entry(name).or_default() += count;
                        }
                        for step in log {
                            let class = step.split(" est=").next().unwrap_or(&step);
                            let class = if class.starts_with("notice") {
                                "notice"
                            } else {
                                class
                            };
                            *classes.entry(class.to_owned()).or_default() += 1;
                        }
                        for violation in violations {
                            failures.push(format!("seed {seed} {profile:?} REVIEW {violation}"));
                        }
                    }
                    Err(error) => {
                        let message = error
                            .try_into_panic()
                            .ok()
                            .and_then(|panic| {
                                panic
                                    .downcast_ref::<String>()
                                    .cloned()
                                    .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                            })
                            .unwrap_or_default();
                        failures.push(format!(
                            "seed {seed} {profile:?} DIVERGENCE {}",
                            message.chars().take(1_500).collect::<String>()
                        ));
                    }
                }
            }
        }
    }
    eprintln!(
        "stack24 review: {sessions} sessions from seed {first}, {steps} steps, echoes={echoes}; {} findings; counts={totals:?}; operations={classes:?}; resident skipped {} engine passes",
        failures.len(),
        resident::counters::skipped_engine_passes()
    );
    for failure in &failures {
        eprintln!("FINDING {failure}");
    }
    assert!(failures.is_empty(), "{} findings", failures.len());
}

#[tokio::test]
async fn stack24_seed_1379_completes_without_a_tool_pairing_panic() {
    session(Profile::Anthropic, 1379, 32).await;
}

#[tokio::test]
async fn stack24_full_processing_seed_1379_control() {
    let seed = 1379u64;
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let tiny_budget = rng.chance(10);
    let setup_lineage = (!rng.chance(25)).then_some("L");
    let inject_docs = rng.chance(30);
    let mut pair = Pair::open(Profile::Anthropic, tiny_budget, setup_lineage, inject_docs).await;
    pair.resident
        .h
        .provider_store
        .async_runtime
        .resident
        .lock()
        .unwrap()
        .oracle = true;
    let mostly_covered = rng.chance(50);
    pair.append(if mostly_covered {
        192 + rng.below(40)
    } else {
        16 + rng.below(40)
    });
    if mostly_covered {
        let end = pair.transcript.entries.lock().unwrap().len() as u64 - 12;
        let reference = pair.reference.clone();
        pair.both("initial mostly-covered history", |side| {
            let reference = reference.clone();
            Box::pin(async move { publish_history(side, &reference, end) })
        })
        .await;
    }
    pair.notice(&mut rng, None).await;
    for _ in 0..32 {
        // The transcript shape before each operation locates the step that
        // leaves an invocation without its result.
        let shape: Vec<String> = pair
            .transcript
            .entries
            .lock()
            .unwrap()
            .iter()
            .rev()
            .take(6)
            .map(|entry| {
                let blocks = entry.message["content"]
                    .as_array()
                    .map(|blocks| {
                        blocks
                            .iter()
                            .map(|b| {
                                format!(
                                    "{}:{}",
                                    b["type"].as_str().unwrap_or("?"),
                                    b["id"].as_str().or(b["tool_use_id"].as_str()).unwrap_or("")
                                )
                            })
                            .collect::<Vec<_>>()
                            .join(",")
                    })
                    .unwrap_or_else(|| "text".into());
                format!("{}={} [{blocks}]", entry.ordinal, entry.message["role"])
            })
            .collect();
        eprintln!("seed 1379 after {:?}: newest {shape:?}", pair.log.last());
        pair.step(&mut rng).await;
    }
}
