//! A conversation that begins at a cut, against full processing of the
//! whole lineage.
//!
//! Each session builds a transcript whose compartments cover most of it.
//! The full side, a provider that reads every row, takes notices until it
//! has published and applied a view covering the history. The cut is put at
//! the newest historian restart point at or below that coverage. The other
//! side then either begins its conversation at that cut, from the
//! compartments and the seed the full side's rows give (it never reads a row
//! below the cut), or reads the same notices and prunes every row below the
//! cut. Both sides then receive the same randomized steps: notices, folds,
//! `ctx_reduce` drops, rides, flushes, commands, restarts and the reminders
//! the notices send. After every step the views published after the cut
//! (every byte), answers, reminder sends, the historian's next input and the
//! engine state that is not keyed to a row below the cut must be identical.
//!
//! The reference is full processing at the moment its fold made the cut, not
//! a from-scratch pass over the whole lineage: a lineage begins at a cut only
//! because such a fold committed coverage through it.
//!
//! One case is excluded on purpose: `ctx_reduce` naming a tag from below
//! the cut, which a conversation that begins at the cut answers as already
//! in the history summary
//! (`ctx_reduce_naming_a_tag_below_the_cut_answers_it_is_already_summarized`).
use super::*;
use subc_protocol::scope::{ScopeKind, ScopeStamp};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CutMode {
    /// The cut side begins its conversation at the cut.
    BeginAtCut,
    /// The cut side reads everything, then prunes below the cut.
    PruneInPlace,
}

fn owner_stamp() -> ScopeStamp {
    ScopeStamp::new(
        subc_protocol::Principal::Reserved {
            module_id: "prefrontal-core".into(),
        },
        "person-session",
        1,
        ScopeKind::Head,
    )
    .with_owner_authorized(true)
}

/// Let `side` take user commands, as a person's session would.
fn attest(side: &Side) {
    let mut binding = side.h.facade_binding(7).unwrap();
    binding.scope = Some(owner_stamp());
    side.h.bind_route(7, binding);
}

/// True when `text` names a fixture message (`m<n>`, alone or as a block
/// `m<n>#<k>`, possibly after a `prefix:`) whose ordinal is below `first`.
fn names_below(text: &str, first: u64) -> bool {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let starts = index == 0 || matches!(bytes[index - 1], b':' | b'\0' | b' ' | b'"');
        if bytes[index] == b'm' && starts {
            let digits = bytes[index + 1..]
                .iter()
                .take_while(|b| b.is_ascii_digit())
                .count();
            let after = bytes.get(index + 1 + digits).copied();
            if digits > 0 && matches!(after, None | Some(b'#' | b'\0' | b'"' | b' ')) {
                let number = text[index + 1..index + 1 + digits].parse::<u64>().unwrap();
                if number < first {
                    return true;
                }
            }
        }
        index += 1;
    }
    false
}

/// `value` without anything keyed to a message below `first`: object
/// members whose key names one, array items that are such a string or an
/// object with such a top-level string, clock readings, and members left
/// empty (a set serialized only when it has members).
fn without_rows_below(value: Value, first: u64) -> Value {
    let empty = |value: &Value| match value {
        Value::Null => true,
        Value::Array(items) => items.is_empty(),
        Value::Object(map) => map.is_empty(),
        _ => false,
    };
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(key, _)| !names_below(key, first))
                .filter(|(key, _)| {
                    !key.ends_with("_at_ms") && key != "at_ms" && key != "expiry_cutoff_ms"
                })
                .map(|(key, member)| (key, without_rows_below(member, first)))
                .filter(|(_, member)| !empty(member))
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .filter(|item| match item {
                    Value::String(text) => !names_below(text, first),
                    Value::Object(map) => !map
                        .values()
                        .any(|member| member.as_str().is_some_and(|s| names_below(s, first))),
                    _ => true,
                })
                .map(|item| without_rows_below(item, first))
                .collect(),
        ),
        other => other,
    }
}

/// Where `full` and `cut` first differ, as a path and the two values there.
fn first_difference(full: &Value, cut: &Value, path: String) -> String {
    match (full, cut) {
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys()) {
                if a.get(key) != b.get(key) {
                    return match (a.get(key), b.get(key)) {
                        (Some(x), Some(y)) => first_difference(x, y, format!("{path}.{key}")),
                        (x, y) => format!("{path}.{key}: full={x:?} cut={y:?}"),
                    };
                }
            }
            format!("{path}: equal")
        }
        (Value::Array(a), Value::Array(b)) => match a.iter().zip(b).position(|(x, y)| x != y) {
            Some(at) => first_difference(&a[at], &b[at], format!("{path}[{at}]")),
            None => format!(
                "{path}: lengths full={} cut={}, extra full={:?} cut={:?}",
                a.len(),
                b.len(),
                a.get(b.len()),
                b.get(a.len())
            ),
        },
        (x, y) => format!("{path}: full={x} cut={y}"),
    }
}

/// The engine state the differential compares: the namespace's meta, its
/// frozen unit keys, its boundary and its tag rows, without what is keyed to
/// a row below the cut.
fn engine_state(side: &Side, reference: &str, first: u64) -> Value {
    let store = side.store();
    let head = load_head(store, reference).unwrap().unwrap();
    let namespace = head.namespace();
    let loaded = store.load(&namespace).unwrap();
    let mut meta = serde_json::to_value(&loaded.meta).unwrap();
    meta["frozen_unit_keys"] = json!(loaded
        .core
        .frozen_units
        .iter()
        .map(|unit| unit.key.clone())
        .collect::<Vec<_>>());
    meta["boundary_id"] = json!(loaded.core.boundary_id);
    // Both revisions hash the store's own compartment-history generation, a
    // random id each store mints, not anything derived from the transcript.
    if let Value::Object(fields) = &mut meta {
        fields.remove("m1_external_revision");
        fields.remove("m1_history_revision");
        // An execute watermark below the cut selects no arc of the window,
        // exactly as no watermark does (`select_two_pass`), and a later one
        // takes the maximum.
        if fields
            .get("last_execute_ordinal")
            .and_then(Value::as_u64)
            .is_some_and(|ordinal| ordinal < first)
        {
            fields.insert("last_execute_ordinal".into(), json!(0));
        }
        // The one engine field the differential tolerates. Full processing
        // freezes `publication_floor_ordinal` on its first Hard pass by
        // walking live blocks newest-first, so it can land below the cut; a
        // lineage that begins at the cut computes it over its own rows, so
        // it is never below the cut. It is read only for the legacy
        // boundary-divergence allowance, and only when the namespace lacks
        // rendered m0/m1 coverage (`detect_boundary_divergence_candidate`),
        // which a namespace that has folded always has: checked here. Below
        // the cut it is compared clamped to the cut.
        if let Some(floor) = fields
            .get("publication_floor_ordinal")
            .and_then(Value::as_u64)
            .filter(|floor| *floor < first)
        {
            assert!(
                loaded.meta.rendered_m0_coverage.is_some()
                    && loaded.meta.rendered_m1_coverage.is_some(),
                "publication floor {floor} below the cut {first} in a namespace without rendered coverage"
            );
            fields.insert("publication_floor_ordinal".into(), json!(first));
        }
    }
    // With runner-owned tags the hygiene numbers parts by their position in
    // the engine's request (`tag_rows_for_hygiene` when no overlay tags
    // them), so they and the signature over them differ between a full pass
    // and a prefix pass of the same conversation; nothing renders them.
    if let Some(baseline) = meta
        .get_mut("tail_hygiene_baseline")
        .and_then(Value::as_object_mut)
    {
        baseline.remove("content_signature");
        // The generation counts re-measurements. A full pass's measurement
        // is re-measured once when the conversation's passes take the
        // prefix shape (the positional numbering above changes); a lineage
        // that begins at a cut starts in that shape. The parts and totals
        // are compared.
        baseline.remove("baseline_generation");
        for key in ["parts", "baseline_parts"] {
            if let Some(parts) = baseline.get_mut(key).and_then(Value::as_array_mut) {
                for part in parts.iter_mut().filter_map(Value::as_object_mut) {
                    part.remove("tag_number");
                }
            }
        }
    }
    meta["tag_rows"] = json!(store
        .load_tags_after(&namespace, i64::MIN)
        .unwrap()
        .iter()
        .map(|row| format!(
            "{} {} {} {}",
            row.tag_number, row.block_id, row.kind, row.token_count
        ))
        .collect::<Vec<_>>());
    without_rows_below(meta, first)
}

/// What the historian's next evaluation would read: its window and its
/// prepared input messages.
fn historian_input(side: &Side, reference: &str) -> String {
    let store = side.store();
    let mut state = load(store, reference).unwrap().unwrap();
    let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone())).unwrap();
    state.fold_entries(codec, None).unwrap();
    let (coverage, window) = historian_tail::applied_window(
        store,
        &state.namespace(),
        &state.aggregates.historian_input,
    )
    .unwrap();
    let through = state.entries.last_key_value().map(|(n, _)| *n);
    let mut parsed = side.h.async_historian_request(&state).unwrap();
    historian_tail::prepare_input(
        store,
        reference,
        window.through(through),
        codec,
        &mut parsed,
        &state.reminder_echoes,
    )
    .unwrap();
    format!(
        "coverage={coverage:?} users={} tools={} messages={:?}",
        state.aggregates.real_users, state.aggregates.tool_results, parsed.messages
    )
}

impl Pair {
    /// After a step: nothing read below the cut, and the historian input and
    /// the engine state compared (`both` already compared views, answers,
    /// decisions and sends).
    fn check_cut(&self, first: u64) {
        if std::env::var_os("MC_CUT_TRACE").is_some() {
            // `replay_cut_session` prints the state instead.
            return;
        }
        let label = self.log.last().cloned().unwrap_or_default();
        assert_eq!(
            *self.resident.runner.reads_below_floor.lock().unwrap(),
            Vec::<u64>::new(),
            "{:?}: the cut side read below its cut {first} at {label}; steps={:?}",
            self.profile,
            self.log
        );
        let full = historian_input(&self.oracle, &self.reference);
        let cut = historian_input(&self.resident, &self.reference);
        if full != cut {
            let at = full
                .chars()
                .zip(cut.chars())
                .position(|(a, b)| a != b)
                .unwrap_or(full.len().min(cut.len()));
            let around = |text: &str| {
                text.chars()
                    .skip(at.saturating_sub(300))
                    .take(900)
                    .collect::<String>()
            };
            panic!(
                "{:?}: historian input diverged after {label} (cut {first}) at char {at}\nfull …{}\ncut  …{}\nsteps={:?}",
                self.profile,
                around(&full),
                around(&cut),
                self.log
            );
        }
        let full = engine_state(&self.oracle, &self.reference, first);
        let cut = engine_state(&self.resident, &self.reference, first);
        if full != cut {
            let (Value::Object(full), Value::Object(cut)) = (&full, &cut) else {
                unreachable!()
            };
            // Engine state differences are recorded and the session goes on,
            // so a later step shows whether one reaches served bytes (those
            // fail at once); the session fails at its end on any of them.
            let mut mismatches = self.engine_mismatches.borrow_mut();
            for key in full.keys().chain(cut.keys()) {
                if full.get(key) != cut.get(key) && !mismatches.contains_key(key) {
                    let detail = match (full.get(key), cut.get(key)) {
                        (Some(x), Some(y)) => first_difference(x, y, key.clone()),
                        (x, y) => format!("{key}: full={x:?} cut={y:?}"),
                    };
                    mismatches.insert(
                        key.clone(),
                        format!("{detail} (first after {label}, step {})", self.log.len()),
                    );
                }
            }
        }
    }

    /// The tags the runner shows on messages at or after `first`.
    fn window_tags(&self, first: u64) -> Vec<u64> {
        let mut entries = self.transcript.entries.lock().unwrap();
        renumber(&mut entries);
        entries
            .iter()
            .filter(|entry| entry.ordinal >= first)
            .flat_map(|entry| entry.tags.iter().filter_map(|row| row.tag.as_deref()))
            .filter_map(tags::parse_tag)
            .collect()
    }

    /// The tags the runner shows on messages below `first`.
    fn tags_below(&self, first: u64) -> Vec<u64> {
        let mut entries = self.transcript.entries.lock().unwrap();
        renumber(&mut entries);
        entries
            .iter()
            .filter(|entry| entry.ordinal < first)
            .flat_map(|entry| entry.tags.iter().filter_map(|row| row.tag.as_deref()))
            .filter_map(tags::parse_tag)
            .collect()
    }

    /// One randomized step of the cut differential. Steps that rewrite or
    /// cut the transcript, change lineage or rewind the history are replaced
    /// by an ordinary append, because a conversation that begins at a cut
    /// does not handle them yet; historian publications only move coverage
    /// forward; `ctx_reduce` names window tags.
    async fn cut_step(&mut self, rng: &mut Rng, first: u64, history_end: &mut u64) {
        let roll = rng.below(100);
        match roll {
            45..=52 => {
                let known = self.window_tags(first);
                let mut drop = (0..1 + rng.below(3))
                    .filter_map(|_| known.get(rng.below(known.len() as u64) as usize))
                    .map(u64::to_string)
                    .collect::<Vec<_>>();
                if rng.chance(20) {
                    drop.push("999999".into());
                }
                let request = json!({"name":"ctx_reduce","arguments":{"drop":drop.join(",")}});
                self.both("ctx_reduce", |side| {
                    Box::pin(side.dispatch(request.clone()))
                })
                .await;
            }
            53..=60 => {
                let last = self
                    .transcript
                    .entries
                    .lock()
                    .unwrap()
                    .last()
                    .map_or(0, |entry| entry.ordinal);
                let room = last.saturating_sub(*history_end + 4);
                if room > 0 {
                    *history_end += 1 + rng.below(room);
                    let end = *history_end;
                    let reference = self.reference.clone();
                    self.both("historian publish", |side| {
                        let reference = reference.clone();
                        Box::pin(async move { publish_history(side, &reference, end) })
                    })
                    .await;
                }
                self.append(1 + rng.below(3));
                self.notice(rng, None).await;
            }
            76..=79 => {
                let command = if rng.chance(50) {
                    "ctx-status"
                } else {
                    "ctx-flush"
                };
                let request = json!({"name":"user_command.invoke","call_key":format!("command-{}-{}", self.seq, self.log.len()),"arguments":{"command":command,"input":""}});
                self.both(&format!("command {command}"), |side| {
                    Box::pin(side.dispatch(request.clone()))
                })
                .await;
            }
            80..=92 => self.step_roll(rng, 0).await,
            _ => self.step_roll(rng, roll).await,
        }
    }
}

/// A seeded session through the cut and its first notice on both sides.
/// Returns the pair, the generator, the cut's first ordinal and the
/// history's coverage end.
async fn cut_session_start(
    profile: Profile,
    number: u64,
    mode: CutMode,
) -> Option<(Pair, Rng, u64, u64)> {
    let mut rng = Rng(number.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let tiny_budget = rng.chance(10);
    let inject_docs = rng.chance(30);
    let mut pair = Pair::open_with(profile, tiny_budget, Some("L"), inject_docs, false).await;
    attest(&pair.resident);
    attest(&pair.oracle);
    pair.append(150 + rng.below(80));
    let last = pair.transcript.entries.lock().unwrap().len() as u64 - 1;
    // End the history on a turn's closing answer: a compartment ending
    // between a tool call and its result is refused until the result is
    // covered too, and such a session would never apply a view.
    let history_end = last - (6 + rng.below(30));
    let history_end = history_end - history_end % 4 + 3;
    let reference = pair.reference.clone();
    pair.both("history covering the cut", |side| {
        let reference = reference.clone();
        Box::pin(async move { publish_history(side, &reference, history_end) })
    })
    .await;
    // The full side reads everything first; its rows give the seed. The cut
    // is taken once a view covering it is applied (coverage reaches it), as
    // a runner applies a cut only with the view that carries it.
    let deliver = |side: &Side, message: cortexkit_bus_trait::Message| {
        let h = Arc::clone(&side.h);
        async move {
            match h.advance_compaction("fixture", &message).await {
                Ok(()) => "ok".to_owned(),
                Err(error) => format!("{error:?}"),
            }
        }
    };
    let mut opening = Vec::new();
    let mut full_answers = Vec::new();
    let (codec, first) = loop {
        pair.seq += 1;
        let message = pair.notice_message(&mut rng, None);
        full_answers.push(deliver(&pair.oracle, message.clone()).await);
        pair.oracle.settle().await;
        opening.push(message);
        let store = pair.oracle.store();
        let mut state = load(store, &pair.reference).unwrap().unwrap();
        let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone())).unwrap();
        state.fold_entries(codec, None).unwrap();
        let coverage = store
            .load_meta(&state.namespace())
            .unwrap()
            .meta
            .coverage_ordinal;
        let first = coverage.and_then(|coverage| {
            state
                .aggregates
                .historian_input
                .restart_at_or_below(coverage.min(history_end))
        });
        if let Some(first) = first.filter(|first| *first > 0) {
            break (codec, first);
        }
        if opening.len() == 12 {
            // No view covering the history was applied: nothing to cut.
            SKIPPED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return None;
        }
    };
    let seed_from = |state: &mut State, store: &McStore| {
        state
            .capture_cut_seed(store, codec, first)
            .unwrap()
            .unwrap_or_else(|refusal| panic!("{profile:?} seed {number}: {}", refusal.code()))
    };
    let mut cut_answers = Vec::new();
    match mode {
        CutMode::BeginAtCut => {
            // Full processing has published and applied the view that
            // covers the cut; the lineage after the cut begins there, from
            // the compartments and the seed, and both sides take the same
            // later steps. Views, sends and versions are compared from here.
            let mut state = load(pair.oracle.store(), &pair.reference).unwrap().unwrap();
            let seed = seed_from(&mut state, pair.oracle.store());
            *pair.resident.runner.floor.lock().unwrap() = Some(first);
            let side = &pair.resident;
            let mut cut = side
                .h
                .checkout(side.store(), &pair.reference)
                .unwrap()
                .unwrap();
            cut.engine.version_high_water = state.engine.version_high_water;
            let boundary = seed.boundary_id.clone();
            cut.begin_at_cut(side.store(), seed).unwrap();
            if std::env::var_os("MC_CUT_TRACE").is_some() {
                let meta = side.store().load(&cut.namespace()).unwrap();
                eprintln!(
                    "REPLAY seeded boundary {boundary:?}: coverage={:?} boundary={:?} initialized={} pending={}",
                    meta.meta.coverage_ordinal,
                    meta.core.boundary_id,
                    meta.meta.initialized,
                    meta.meta.bootstrap_seed_fold_pending
                );
            }
            side.h.checkin(cut);
            let (_, high) = pair.oracle.views(&pair.reference);
            let high = high.unwrap_or(0);
            rusqlite::Connection::open(&side.db)
                .unwrap()
                .execute(
                    "UPDATE mc_async_compaction SET version_high_water=?1 WHERE session_ref=?2",
                    rusqlite::params![high, pair.reference],
                )
                .unwrap();
            pair.compare_from_version = high as u64;
            pair.cut_mode = true;
            for runner in [&pair.resident.runner, &pair.oracle.runner] {
                runner.sends.lock().unwrap().clear();
                runner.raw_sends.lock().unwrap().clear();
            }
            cut_answers = full_answers.clone();
        }
        CutMode::PruneInPlace => {
            let side = &pair.resident;
            for message in &opening {
                cut_answers.push(deliver(side, message.clone()).await);
                side.settle().await;
            }
            let mut cut = side
                .h
                .checkout(side.store(), &pair.reference)
                .unwrap()
                .unwrap();
            let seed = seed_from(&mut cut, side.store());
            cut.prune_below_cut(side.store(), seed)
                .unwrap()
                .unwrap_or_else(|refusal| panic!("{profile:?} seed {number}: {refusal:?}"));
            side.h.checkin(cut);
            *side.runner.floor.lock().unwrap() = Some(first);
        }
    }
    pair.log
        .push(format!("{} opening notices, cut at {first}", opening.len()));
    // `replay_cut_session` looks at a diverging opening instead of failing.
    // A lineage that begins at the cut has seen none of the opening notices:
    // the comparison starts with the next step.
    if std::env::var_os("MC_CUT_TRACE").is_none() && mode == CutMode::PruneInPlace {
        assert_eq!(
            cut_answers, full_answers,
            "{profile:?} seed {number}: opening notices"
        );
        pair.compare("opening notices");
        pair.check_cut(first);
    }
    if mode == CutMode::BeginAtCut {
        pair.record_only = std::env::var_os("MC_CUT_TRACE").is_some();
        // The lineage after the cut starts with a notice, as a runner's does.
        pair.append(1);
        pair.notice(&mut rng, None).await;
        pair.check_cut(first);
    }
    Some((pair, rng, first, history_end))
}

async fn cut_session(profile: Profile, seed: u64, steps: u64, mode: CutMode) {
    let Some((mut pair, mut rng, first, mut history_end)) =
        cut_session_start(profile, seed, mode).await
    else {
        return;
    };
    for _ in 0..steps {
        pair.cut_step(&mut rng, first, &mut history_end).await;
        pair.check_cut(first);
    }
    let mismatches = pair.engine_mismatches.borrow();
    assert!(
        mismatches.is_empty(),
        "{profile:?}: engine state diverged (cut {first}): {:?}; steps={:?}",
        mismatches.values().collect::<Vec<_>>(),
        pair.log
    );
}

/// Sessions whose opening notices applied no view covering the history, so
/// no cut was taken.
static SKIPPED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Run `sessions` seeded sessions from `first_seed` over all four schemas,
/// in parallel batches, and list every divergence together.
async fn cut_differential(sessions: u64, steps: u64, first_seed: u64, mode: CutMode) {
    let mut failures = Vec::new();
    let mut tasks = Vec::new();
    for index in 0..sessions {
        let profile = PROFILES[(index % 4) as usize];
        let seed = first_seed + index;
        tasks.push((
            seed,
            profile,
            tokio::spawn(async move {
                cut_session(profile, seed, steps, mode).await;
            }),
        ));
        if tasks.len() == 8 || index + 1 == sessions {
            for (seed, profile, task) in std::mem::take(&mut tasks) {
                if let Err(error) = task.await {
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
                        "seed {seed} {profile:?}: {}",
                        message.chars().take(2_000).collect::<String>()
                    ));
                }
            }
        }
    }
    eprintln!(
        "cut differential {mode:?}: {sessions} sessions, {steps} steps each, {} diverged, {} without a cut so far",
        failures.len(),
        SKIPPED.load(std::sync::atomic::Ordering::Relaxed)
    );
    for failure in &failures {
        eprintln!("CUT DIVERGENCE {failure}");
    }
    assert!(failures.is_empty(), "{} sessions diverged", failures.len());
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

/// Known limitation: a lineage that begins at a cut does not yet carry the engine state
/// full processing holds for rows at or after the cut when it makes the cut
/// (reductions frozen on window blocks, the emergency latches, queued drops
/// and acknowledged native edits), so under pressure it serves outputs full
/// processing has dropped. Ignored until that state is carried.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "red until the window's engine state is carried into a lineage that begins at a cut"]
async fn a_lineage_that_begins_at_a_cut_serves_what_full_processing_serves() {
    cut_differential(8, 20, 7_000, CutMode::BeginAtCut).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn a_conversation_pruned_below_its_cut_serves_what_full_processing_serves() {
    cut_differential(8, 20, 8_000, CutMode::PruneInPlace).await;
}

/// The full cut differential: `MC_CUT_DIFFERENTIAL_SESSIONS` sessions
/// (default 300) of `MC_CUT_DIFFERENTIAL_STEPS` steps (default 24) from seed
/// `MC_CUT_DIFFERENTIAL_FIRST_SEED`.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "long randomized cut differential; run explicitly with --ignored"]
async fn cut_lineages_serve_what_full_processing_serves_over_many_sessions() {
    let sessions = env_u64("MC_CUT_DIFFERENTIAL_SESSIONS", 300);
    let steps = env_u64("MC_CUT_DIFFERENTIAL_STEPS", 24);
    let first = env_u64("MC_CUT_DIFFERENTIAL_FIRST_SEED", 10_000);
    // `MC_CUT_DIFFERENTIAL_MODE`: `begin`, `prune` or both (default).
    let mode = std::env::var("MC_CUT_DIFFERENTIAL_MODE").unwrap_or_default();
    if mode != "prune" {
        cut_differential(sessions, steps, first, CutMode::BeginAtCut).await;
    }
    if mode != "begin" {
        cut_differential(sessions, steps, first + 100_000, CutMode::PruneInPlace).await;
    }
}

/// A pair whose two sides read the whole transcript, through an applied
/// view that covers the history: the state a cut is taken from. Returns the
/// pair, the generator and the cut's first ordinal.
async fn covered_pair(profile: Profile, number: u64) -> (Pair, Rng, u64) {
    let mut rng = Rng(number.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let mut pair = Pair::open_with(profile, false, Some("L"), false, false).await;
    attest(&pair.resident);
    attest(&pair.oracle);
    pair.append(200);
    let reference = pair.reference.clone();
    pair.both("history", |side| {
        let reference = reference.clone();
        Box::pin(async move { publish_history(side, &reference, 180) })
    })
    .await;
    for _ in 0..12 {
        pair.notice(&mut rng, None).await;
        let store = pair.resident.store();
        let head = load_head(store, &pair.reference).unwrap().unwrap();
        let coverage = store
            .load_meta(&head.namespace())
            .unwrap()
            .meta
            .coverage_ordinal;
        let mut state = load(store, &pair.reference).unwrap().unwrap();
        let codec = codec::Codec::from_params(&Value::Object(state.setup.params.clone())).unwrap();
        state.fold_entries(codec, None).unwrap();
        if let Some(first) = coverage
            .and_then(|coverage| {
                state
                    .aggregates
                    .historian_input
                    .restart_at_or_below(coverage)
            })
            .filter(|first| *first > 0)
        {
            return (pair, rng, first);
        }
    }
    panic!("{profile:?} seed {number}: no view covering the history was applied");
}

fn codec_of(state: &State) -> codec::Codec {
    codec::Codec::from_params(&Value::Object(state.setup.params.clone())).unwrap()
}

/// The seed holds what the rows below the cut give: the provider's running
/// totals, the engine's covered user turns (the same whether taken from a
/// certificate or counted from the rows), the cut message's times, the system
/// rows and the tag numbers below the cut.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cut_seed_holds_the_facts_a_full_pass_derives() {
    for (index, profile) in PROFILES.into_iter().enumerate() {
        let (pair, _, first) = covered_pair(profile, 600 + index as u64).await;
        let store = pair.resident.store();
        let mut certified = load(store, &pair.reference).unwrap().unwrap();
        let codec = codec_of(&certified);
        assert!(
            certified.logical_prefix.is_some(),
            "{profile:?}: no certificate"
        );
        let seed = certified
            .capture_cut_seed(store, codec, first)
            .unwrap()
            .unwrap();
        let mut uncertified = load(store, &pair.reference).unwrap().unwrap();
        uncertified.logical_prefix = None;
        let counted = uncertified
            .capture_cut_seed(store, codec, first)
            .unwrap()
            .unwrap();
        assert_eq!(
            seed.covered_user_turns, counted.covered_user_turns,
            "{profile:?}: covered user turns from the certificate and from the rows"
        );
        assert_eq!(
            seed.context_sources.keys().collect::<Vec<_>>(),
            counted.context_sources.keys().collect::<Vec<_>>(),
            "{profile:?}: context sources"
        );
        // The running totals of a record holding only the rows below the cut.
        let mut below = load(store, &pair.reference).unwrap().unwrap();
        below.truncate_entries(Some(first - 1));
        below.fold_entries(codec, None).unwrap();
        assert_eq!(
            (
                seed.real_users,
                seed.tool_results,
                seed.messages,
                seed.last_user.clone(),
                seed.orphan_result
            ),
            (
                below.aggregates.real_users,
                below.aggregates.tool_results,
                below.aggregates.historian_input.count(),
                below.aggregates.last_user.clone(),
                below.aggregates.orphan_result
            ),
            "{profile:?}: running totals below the cut"
        );
        let cut =
            decoded_entry(codec, &certified.entries[&(first - 1)].inbound().unwrap()).unwrap();
        assert_eq!(
            seed.time_basis,
            Some((cut.ck.meta.created_at_ms, cut.ck.meta.completed_at_ms)),
            "{profile:?}: time basis"
        );
        let systems = certified
            .entries
            .range(..first)
            .filter(|(_, entry)| {
                decoded_entry(codec, &entry.inbound().unwrap())
                    .unwrap()
                    .ck
                    .role
                    == "system"
            })
            .map(|(ordinal, _)| *ordinal)
            .collect::<Vec<_>>();
        assert_eq!(
            seed.context_sources.keys().copied().collect::<Vec<_>>(),
            systems,
            "{profile:?}: system rows below the cut"
        );
        let mut numbers = pair.tags_below(first);
        numbers.sort_unstable();
        let mut seeded = seed
            .pre_cut_tags
            .iter()
            .flat_map(|(lo, hi)| *lo..=*hi)
            .collect::<Vec<_>>();
        seeded.sort_unstable();
        assert_eq!(seeded, numbers, "{profile:?}: tags below the cut");
        assert_eq!(seed.max_tag, numbers.last().copied().unwrap_or(0));
        assert_eq!(seed.first_ordinal, first);
        assert_eq!(seed.cut_mid, format!("m{}", first - 1));
        assert!(seed.protection.is_some());
    }
}

/// After pruning below a cut, no table holds a row of a message below it:
/// held entries, the namespace's per-message rows, its cache state, and the
/// record's frozen edits. The compartments (the history), the cut seed and
/// the certificate stand for those rows and keep naming them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pruning_below_a_cut_leaves_no_row_below_it_in_any_table() {
    for (index, profile) in PROFILES.into_iter().enumerate() {
        let (pair, _, first) = covered_pair(profile, 700 + index as u64).await;
        let side = &pair.resident;
        let mut state = side
            .h
            .checkout(side.store(), &pair.reference)
            .unwrap()
            .unwrap();
        let codec = codec_of(&state);
        let seed = state
            .capture_cut_seed(side.store(), codec, first)
            .unwrap()
            .unwrap();
        let kept = seed
            .context_sources
            .values()
            .map(|source| source.mid.clone())
            .collect::<HashSet<_>>();
        let namespace = state.namespace();
        state.prune_below_cut(side.store(), seed).unwrap().unwrap();
        side.h.checkin(state);
        let below = |text: &str| {
            names_below(text, first)
                && !kept
                    .iter()
                    .any(|mid| text == mid || text.contains(&format!("{mid}#")))
        };
        let conn = rusqlite::Connection::open(&side.db).unwrap();
        let tables = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let mut swept = 0;
        for table in tables {
            let columns = conn
                .prepare(&format!("PRAGMA table_info({table})"))
                .unwrap()
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            let key = ["session_id", "engine_namespace"]
                .into_iter()
                .find(|column| columns.iter().any(|c| c == column));
            let ids = columns
                .iter()
                .filter(|c| matches!(c.as_str(), "block_id" | "mid" | "target_id"))
                .collect::<Vec<_>>();
            if let Some(key) = key.filter(|_| !ids.is_empty()) {
                for id in ids {
                    let values = conn
                        .prepare(&format!("SELECT {id} FROM {table} WHERE {key}=?1"))
                        .unwrap()
                        .query_map([&namespace], |row| row.get::<_, String>(0))
                        .unwrap()
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .unwrap();
                    swept += 1;
                    assert!(
                        !values.iter().any(|value| below(value)),
                        "{profile:?}: {table}.{id} keeps a row below the cut {first}: {values:?}"
                    );
                }
            }
            if columns.iter().any(|c| c == "session_ref") && columns.iter().any(|c| c == "ordinal")
            {
                let count: i64 = conn
                    .query_row(
                        &format!(
                            "SELECT count(*) FROM {table} WHERE session_ref=?1 AND ordinal<?2"
                        ),
                        rusqlite::params![pair.reference, first as i64],
                        |row| row.get(0),
                    )
                    .unwrap();
                swept += 1;
                assert_eq!(
                    count, 0,
                    "{profile:?}: {table} keeps ordinals below {first}"
                );
            }
        }
        assert!(
            swept >= 6,
            "{profile:?}: the sweep found {swept} keyed columns"
        );
        let loaded = side.store().load(&namespace).unwrap();
        for unit in &loaded.core.frozen_units {
            // Keys without a target (`m0`, `m1`, `history`) are the head's.
            assert!(
                !unit.key.contains(':') || !below(&unit.key),
                "{profile:?}: frozen unit {}",
                unit.key
            );
        }
        for mid in loaded.meta.block_identity_by_mid.keys() {
            assert!(!below(mid), "{profile:?}: block identity of {mid}");
        }
        let held = load(side.store(), &pair.reference).unwrap().unwrap();
        assert_eq!(held.entries.first_key_value().map(|(n, _)| *n), Some(first));
        assert!(held
            .tag_index
            .values()
            .all(|address| address.ordinal >= first));
        assert!(held.mid_index.values().all(|ordinal| *ordinal >= first));
        assert!(!below(&held.frozen_edits.json().unwrap()));
        assert_eq!(held.cut_seed.as_ref().unwrap().first_ordinal, first);
    }
}

/// Pruning is refused while a view this conversation holds renders a row
/// below the cut: the transition must never remove what a later view could
/// serve.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pruning_refuses_while_a_held_view_renders_below_the_cut() {
    let (pair, _, _) = covered_pair(Profile::Broca, 750).await;
    let side = &pair.resident;
    let mut state = side
        .h
        .checkout(side.store(), &pair.reference)
        .unwrap()
        .unwrap();
    let codec = codec_of(&state);
    // The newest restart point: the view still keeps the rows before it.
    let newest = *state.entries.last_key_value().unwrap().0;
    state.fold_entries(codec, None).unwrap();
    let first = state
        .aggregates
        .historian_input
        .restart_at_or_below(newest)
        .unwrap();
    let seed =
        cut_seed::CutSeed::without_rows(first, format!("m{}", first - 1), 1, "m180#0".into());
    assert_eq!(
        state.prune_below_cut(side.store(), seed).unwrap(),
        Err(cut_seed::PruneRefusal::RenderedBelow)
    );
    assert!(state.entries.contains_key(&0), "nothing was pruned");
    side.h.checkin(state);
}

/// A stored record from before cut seeds is rebuilt in the next generation
/// at its next notice, not read as it is.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_record_from_before_cut_seeds_is_rebuilt() {
    let mut pair = Pair::open_with(Profile::OpenCode, false, Some("L"), false, false).await;
    pair.append(12);
    let mut rng = Rng(5);
    pair.notice(&mut rng, None).await;
    for side in [&pair.resident, &pair.oracle] {
        let conn = rusqlite::Connection::open(&side.db).unwrap();
        conn.execute(
            "UPDATE mc_async_compaction SET state_json=json_remove(state_json,'$.record_version') WHERE session_ref=?1",
            [&pair.reference],
        )
        .unwrap();
        side.h
            .provider_store
            .async_runtime
            .resident
            .lock()
            .unwrap()
            .forget(&pair.reference);
    }
    let before = load_head(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    assert_eq!(before.record_version, 0);
    pair.append(2);
    pair.notice(&mut rng, None).await;
    let after = load_head(pair.resident.store(), &pair.reference)
        .unwrap()
        .unwrap();
    assert_eq!(after.record_version, cut_seed::RECORD_VERSION);
    assert_eq!(after.generation, before.generation + 1);
}

/// A seed for a cut ck-mc never held the rows for: every field at its
/// fallback, and the engine prefix and running totals built from it.
#[test]
fn a_seed_without_rows_has_a_fallback_for_every_field() {
    let seed = cut_seed::CutSeed::without_rows(50, "m49".into(), 3, "m49#0".into());
    assert_eq!(seed.lineage_from, 0);
    assert_eq!(seed.cut_digest, "");
    assert!(seed.context_sources.is_empty());
    assert_eq!(seed.time_basis, None);
    assert_eq!(
        (seed.covered_user_turns, seed.real_users, seed.tool_results),
        (0, 0, 0)
    );
    assert_eq!(
        seed.messages, 50,
        "positions still count from the lineage start"
    );
    assert_eq!(seed.last_user, None);
    assert!(!seed.orphan_result);
    assert_eq!(seed.protection, None);
    assert!(seed.pre_cut_tags.is_empty() && !seed.tagged_below(7));
    assert_eq!(seed.todo, None);
    let aggregates = seed.base_aggregates();
    assert_eq!(aggregates.through, Some(49));
    assert_eq!(aggregates.historian_input.count(), 50);
    let prefix = seed.prefix("L", 0, 0);
    assert!(prefix.is_cut());
    assert_eq!((prefix.from, prefix.tail_from), (0, 50));
    assert_eq!(prefix.covered_user_turns, 0);
    assert_eq!(prefix.cut_time_basis, None);
}

/// `ctx_reduce` naming a tag from below the cut answers that it is already
/// in the history summary: its content is out of the model's context, so
/// nothing is queued. The cut differential leaves this case out because a
/// conversation that read those rows answers differently.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ctx_reduce_naming_a_tag_below_the_cut_answers_it_is_already_summarized() {
    let Some((mut pair, mut rng, first, _)) =
        cut_session_start(Profile::Broca, 7_004, CutMode::BeginAtCut).await
    else {
        panic!("the session takes a cut");
    };
    // Only the cut side's replies matter here, not the differential.
    pair.record_only = true;
    pair.append(2);
    pair.notice(&mut rng, None).await;
    let below = pair.tags_below(first);
    let pre = *below.last().unwrap();
    let window = pair.window_tags(first)[0];
    let pending = |side: &Side| {
        let head = load_head(side.store(), &pair.reference).unwrap().unwrap();
        side.store()
            .load_pending_agent_drops(&head.namespace())
            .unwrap()
            .len()
    };
    let answer = pair
        .resident
        .dispatch(json!({"name":"ctx_reduce","arguments":{"drop":pre.to_string()}}))
        .await;
    assert!(
        answer.contains(&format!(
            "Nothing to drop: tags {pre} are already in the history summary."
        )) && !answer.contains("\"isError\":true"),
        "{answer}"
    );
    assert_eq!(pending(&pair.resident), 0, "nothing is queued");
    let answer = pair
        .resident
        .dispatch(json!({"name":"ctx_reduce","arguments":{"drop":format!("{pre},{window}")}}))
        .await;
    assert!(
        answer.contains(&format!(
            "1 tag stamped. tags {pre} already in the history summary, nothing to drop"
        )),
        "{answer}"
    );
    assert_eq!(pending(&pair.resident), 1, "only the window tag is queued");
}

/// Replay one cut-differential session (`MC_CUT_SEED`, profile index
/// `MC_CUT_PROFILE`, `MC_CUT_PRUNE=1` for the pruning mode), printing a
/// line of engine state per side after every step. Diagnostic only.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "diagnostic replay of one cut-differential session"]
async fn replay_cut_session() {
    let seed = env_u64("MC_CUT_SEED", 7_007);
    let profile = PROFILES[env_u64("MC_CUT_PROFILE", 3) as usize];
    let mode = if env_u64("MC_CUT_PRUNE", 0) == 1 {
        CutMode::PruneInPlace
    } else {
        CutMode::BeginAtCut
    };
    let Some((mut pair, mut rng, first, mut history_end)) =
        cut_session_start(profile, seed, mode).await
    else {
        panic!("no cut");
    };
    {
        let line = |side: &Side| {
            let head = load_head(side.store(), &pair.reference).unwrap().unwrap();
            format!(
                "seq={} completed={} read_outcome={:?} failure={:?} engine_failed={} resync={}",
                head.seq,
                head.completed_seq,
                head.read_outcome,
                head.failure,
                head.engine_failed,
                head.resync
            )
        };
        eprintln!(
            "REPLAY record full {}\n  cut {}\n  answers {:?}",
            line(&pair.oracle),
            line(&pair.resident),
            pair.mismatches
        );
        let full = load(pair.oracle.store(), &pair.reference).unwrap().unwrap();
        let cut = load(pair.resident.store(), &pair.reference)
            .unwrap()
            .unwrap();
        let protection = |prefix: Option<&Arc<transform::compaction::LogicalPrefix>>| {
            prefix.map(|prefix| {
                let (floor, ratio, rows) = prefix.protection();
                (
                    prefix.tail_from,
                    floor,
                    ratio,
                    rows.iter()
                        .map(|row| (row.0, row.1.clone()))
                        .collect::<Vec<_>>(),
                )
            })
        };
        eprintln!(
            "REPLAY cut {first}: seed protection {:?} max_tag {}\n  full certificate {:?}\n  cut certificate {:?}",
            cut.cut_seed.as_ref().map(|seed| seed.protection.clone()),
            cut.cut_seed.as_ref().map_or(0, |seed| seed.max_tag),
            protection(full.logical_prefix.as_ref()),
            protection(cut.logical_prefix.as_ref()),
        );
        let parts = |side: &Side| {
            let head = load_head(side.store(), &pair.reference).unwrap().unwrap();
            let meta = side.store().load(&head.namespace()).unwrap().meta;
            (
                meta.protected_tokens_effective,
                meta.tail_hygiene_baseline
                    .map(|baseline| {
                        baseline
                            .baseline_parts
                            .iter()
                            .filter(|part| part.protected)
                            .map(|part| part.key.replace('\0', "/"))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default(),
            )
        };
        eprintln!(
            "REPLAY protected full {:?}\n  protected cut {:?}",
            parts(&pair.oracle),
            parts(&pair.resident)
        );
    }
    let line = |side: &Side, reference: &str| {
        let head = load_head(side.store(), reference).unwrap().unwrap();
        let loaded = side.store().load(&head.namespace()).unwrap();
        let meta = &loaded.meta;
        format!(
            "coverage={:?} execute={} floor={:?} hygiene_gen={:?} reds={:?} prefix={:?}",
            meta.coverage_ordinal,
            meta.last_execute_ordinal,
            meta.publication_floor_ordinal,
            meta.tail_hygiene_baseline
                .as_ref()
                .map(|baseline| baseline.baseline_generation),
            loaded
                .core
                .frozen_units
                .iter()
                .filter(|unit| unit.key.starts_with("red:"))
                .map(|unit| unit.key.clone())
                .collect::<Vec<_>>(),
            head.logical_prefix.as_ref().map(|prefix| prefix.tail_from)
        )
    };
    let passes = |side: &Side| cut_seed::pass_trace::take(Arc::as_ptr(&side.h) as usize);
    {
        let full = engine_state(&pair.oracle, &pair.reference, first);
        let cut = engine_state(&pair.resident, &pair.reference, first);
        if let (Value::Object(full), Value::Object(cut)) = (&full, &cut) {
            for key in full.keys().chain(cut.keys()).collect::<BTreeSet<_>>() {
                if full.get(key) != cut.get(key) {
                    eprintln!(
                        "REPLAY differs {key}: full={} cut={}",
                        full.get(key).map_or_else(String::new, |v| v
                            .to_string()
                            .chars()
                            .take(600)
                            .collect()),
                        cut.get(key).map_or_else(String::new, |v| v
                            .to_string()
                            .chars()
                            .take(600)
                            .collect())
                    );
                }
            }
        }
    }
    eprintln!(
        "REPLAY opening\n  full {} {:?}\n  cut  {} {:?}",
        line(&pair.oracle, &pair.reference),
        passes(&pair.oracle),
        line(&pair.resident, &pair.reference),
        passes(&pair.resident)
    );
    for step in 0..env_u64("MC_CUT_STEPS", 24) {
        pair.cut_step(&mut rng, first, &mut history_end).await;
        eprintln!(
            "REPLAY step {step} {}\n  full {}\n  cut  {}",
            pair.log.last().unwrap(),
            line(&pair.oracle, &pair.reference),
            line(&pair.resident, &pair.reference)
        );
    }
}

/// A conversation that begins at a cut never asks the runner for a row
/// below it: its first read starts at the cut, and every later read at its
/// newest held row.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_lineage_that_begins_at_a_cut_reads_nothing_below_it() {
    for (index, profile) in PROFILES.into_iter().enumerate() {
        let Some((mut pair, mut rng, first, _)) =
            cut_session_start(profile, 7_100 + index as u64, CutMode::BeginAtCut).await
        else {
            continue;
        };
        // Only the cut side's reads matter here, not the differential.
        pair.record_only = true;
        for _ in 0..3 {
            pair.append(2);
            pair.notice(&mut rng, None).await;
        }
        assert_eq!(
            *pair.resident.runner.reads_below_floor.lock().unwrap(),
            Vec::<u64>::new(),
            "{profile:?}: reads below the cut {first}"
        );
        let state = load(pair.resident.store(), &pair.reference)
            .unwrap()
            .unwrap();
        assert_eq!(
            state.entries.first_key_value().map(|(n, _)| *n),
            Some(first),
            "{profile:?}"
        );
    }
}

impl Pair {
    /// The cut-mode comparison after a step: the model bytes of the newest
    /// view each side would serve, the record decisions that do not name
    /// view versions, the queued drops and the reminder sends.
    pub(super) fn compare_newest(&self, label: &str) {
        let newest = |side: &Side| {
            side.views(&self.reference)
                .0
                .last()
                .map(|(_, json)| serde_json::from_str::<view::CompactionView>(json).unwrap())
        };
        let (cut, full) = (newest(&self.resident), newest(&self.oracle));
        // The full side's newest view may predate the cut (it needed no
        // new one); the cut side has one once it took its first notice.
        if let (Some(cut), Some(full)) = (&cut, &full) {
            let cut_model: Vec<Value> = serde_json::from_slice(&self.model_bytes(cut)).unwrap();
            let full_model: Vec<Value> = serde_json::from_slice(&self.model_bytes(full)).unwrap();
            if cut_model != full_model {
                let first = cut_model
                    .iter()
                    .zip(&full_model)
                    .position(|(a, b)| a != b)
                    .unwrap_or(cut_model.len().min(full_model.len()));
                panic!(
                    "{:?} served bytes after {label}, first={first}, cut={:?}, full={:?}, steps={:?}",
                    self.profile,
                    cut_model.get(first),
                    full_model.get(first),
                    self.log
                );
            }
        }
        // Whether the latest notice completed, not the sequence it completed:
        // the full side also completed notices from before the cut.
        let decisions = |side: &Side| {
            let state = load_head(side.store(), &self.reference).unwrap()?;
            Some(format!(
                "seq={} completed_latest={} generation={} resync={} lineage={:?}",
                state.seq,
                state.completed_seq == state.seq,
                state.generation,
                state.resync,
                state.lineage
            ))
        };
        assert_eq!(
            decisions(&self.resident),
            decisions(&self.oracle),
            "{:?} record decisions diverged after {label}; steps: {:?}",
            self.profile,
            self.log
        );
        let pending = |side: &Side| {
            let head = load_head(side.store(), &self.reference).unwrap().unwrap();
            let mut targets = side
                .store()
                .load_pending_agent_drops(&head.namespace())
                .unwrap()
                .into_iter()
                .map(|drop| drop.target_id)
                .collect::<Vec<_>>();
            targets.sort();
            targets
        };
        assert_eq!(
            pending(&self.resident),
            pending(&self.oracle),
            "{:?} pending target identities diverged after {label}; steps={:?}",
            self.profile,
            self.log
        );
        assert_eq!(
            *self.resident.runner.sends.lock().unwrap(),
            *self.oracle.runner.sends.lock().unwrap(),
            "{:?} reminder sends diverged after {label}; steps: {:?}",
            self.profile,
            self.log
        );
    }
}
