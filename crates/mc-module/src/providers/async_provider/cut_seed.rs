//! What a conversation keeps of the transcript below a cut.
//!
//! Once the runner starts a lineage after a cut, the messages below the cut
//! are never read again. Everything ck-mc still needs from them is captured
//! here, once, while the old lineage's rows are still held: the system and
//! lineage-anchor messages (whose content the history head renders), the cut
//! message's times, the counts the reminder and historian cadences and the
//! historian input index carry forward, the protected tag rows below the cut,
//! the tag numbers that existed there, and the newest todo state.
//!
//! A seed is fixed-size apart from its context sources, which hold only
//! system and anchor messages and are refused above `MAX_CONTEXT_BYTES`.
//!
//! Every field has a fallback for a cut ck-mc never held the rows for (for
//! example a host marker written before ck-mc served the session, found
//! again only by the cut message's id). `CutSeed::without_rows` builds that
//! seed; each fallback and its effect is documented on the field.
// Capture, pruning and the lineage that begins at a cut are driven by the
// cut descent and the Setups of later work; until those call them, only
// tests do.
#![cfg_attr(not(test), allow(dead_code))]
use super::*;
use std::collections::HashSet;

/// The record format that knows about cut seeds. A stored record of an
/// older version is discarded and rebuilt (see `discard_older_record`).
pub(super) const RECORD_VERSION: u32 = 2;

/// Context sources larger than this are refused at capture
/// (`cut_seed_oversize`); the view then publishes no cut.
const MAX_CONTEXT_BYTES: usize = 256 * 1024;

/// The bound `LogicalPrefix::certify` applies to protected rows.
const MAX_PROTECTION_ROWS: usize = 4_096;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(crate) struct SeedProtection {
    pub floor: u64,
    pub ratio: f64,
    /// `(tag number, block id, kind, tokens, created at ms)` of the protected
    /// tool tags below the cut, as `LogicalPrefix` keeps them.
    pub rows: Vec<(i64, String, String, i64, i64)>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct SeedTodo {
    pub state_json: String,
    pub owner_message_id: String,
    pub state_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(crate) struct CutSeed {
    /// The first ordinal of the lineage after the cut (F); the cut is F - 1.
    pub first_ordinal: u64,
    /// The first ordinal of the lineage the cut was taken from. The engine's
    /// ranges keep starting there, so its view of the conversation is the
    /// one full processing would hold. Fallback: 0.
    pub lineage_from: u64,
    /// The cut message's id and served digest. Fallback: the id the runner
    /// names and an empty digest (nothing compares it before a revert).
    pub cut_mid: String,
    pub cut_digest: String,
    /// The compartment sequence and flat boundary the history covered when
    /// the seed was taken. Fallback: the newest compartment's.
    pub compartment_seq: i64,
    pub boundary_id: String,
    /// System messages and the lineage-anchor message below the cut, whole,
    /// because the history head renders covered system text. Fallback:
    /// empty, so the head lists no covered system messages. OpenCode and
    /// Claude Code transcripts carry no system rows, so in practice nothing
    /// changes; the async lane never detects an anchor.
    pub context_sources: BTreeMap<u64, InboundMessage>,
    /// The cut message's `(created_at_ms, completed_at_ms)`. Fallback:
    /// unknown, so the first window message gets no temporal-gap marker.
    pub time_basis: Option<(Option<i64>, Option<i64>)>,
    /// Authored user turns below the cut as the engine counts them
    /// (`LogicalPrefix::covered_user_turns`), for Channel-1 cadence.
    /// Fallback: 0, so that cadence counts as if the conversation began at
    /// the cut.
    pub covered_user_turns: u64,
    /// The provider's running totals below the cut: authored users (reminder
    /// echoes excluded), tool results and messages. Fallback: 0, 0 and
    /// `first_ordinal - lineage_from`. A zero tool-result base makes the
    /// historian cadence see fewer results than it last recorded, which it
    /// reads as a change, so one historian evaluation may run early.
    pub real_users: u64,
    pub tool_results: u64,
    pub messages: u64,
    /// The newest authored user message below the cut. Fallback: none, so the
    /// historian cadence sees no user turn until the next one.
    pub last_user: Option<(u64, String)>,
    /// Some tool result below the cut named no earlier call: the engine then
    /// always runs instead of being skipped. Fallback: false.
    pub orphan_result: bool,
    /// Protected tool tags below the cut. Fallback: none, so the protection
    /// window is computed over the window's tags only; tags below the cut
    /// have no live source either way.
    pub protection: Option<SeedProtection>,
    /// Inclusive tag-number ranges that existed below the cut, so
    /// `ctx_reduce` naming one answers that it is already in the history
    /// summary. Fallback: empty, so such a number answers "not found".
    pub pre_cut_tags: Vec<(u64, u64)>,
    /// The highest tag number below the cut (0 when none).
    pub max_tag: u64,
    /// The newest todo state when the seed was taken. Fallback: none, so no
    /// synthetic todo pair shows until the next `todowrite` in the window.
    pub todo: Option<SeedTodo>,
}

/// One named refusal to capture a seed. The cut is then not taken.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum CaptureRefusal {
    /// The record does not hold the cut message and the first window message.
    Unheld,
    /// The compartments do not cover every message below the cut.
    NotCovered,
    /// A tool call below the cut has its result at or after it.
    SplitsToolArc,
    /// The first window message is not a historian restart point, so the
    /// historian input would start elsewhere in a lineage that begins there.
    NotAtRestartPoint,
    /// The context sources exceed `MAX_CONTEXT_BYTES`.
    Oversize,
}

impl CaptureRefusal {
    pub(super) fn code(&self) -> &'static str {
        match self {
            Self::Unheld => "cut_seed_unheld",
            Self::NotCovered => "cut_not_covered",
            Self::SplitsToolArc => "cut_splits_tool_arc",
            Self::NotAtRestartPoint => "cut_not_at_restart_point",
            Self::Oversize => "cut_seed_oversize",
        }
    }
}

/// Compress sorted, deduplicated numbers into inclusive ranges.
fn ranges(numbers: impl IntoIterator<Item = u64>) -> Vec<(u64, u64)> {
    let mut out: Vec<(u64, u64)> = Vec::new();
    for number in numbers {
        match out.last_mut() {
            Some((_, hi)) if number == *hi + 1 => *hi = number,
            Some((_, hi)) if number <= *hi => {}
            _ => out.push((number, number)),
        }
    }
    out
}

/// The block's message id: the part before `#`, or the whole id.
fn block_mid(block: &str) -> &str {
    ck_wire::split_block_id(block).map_or(block, |(mid, _)| mid)
}

impl CutSeed {
    /// The baseline slot a seed is stored in.
    pub(super) fn slot(first_ordinal: u64) -> String {
        format!("cut:{first_ordinal}")
    }

    /// A seed for a cut ck-mc never held the rows for: every field at its
    /// documented fallback.
    pub(super) fn without_rows(
        first_ordinal: u64,
        cut_mid: String,
        compartment_seq: i64,
        boundary_id: String,
    ) -> Self {
        Self {
            first_ordinal,
            lineage_from: 0,
            cut_mid,
            cut_digest: String::new(),
            compartment_seq,
            boundary_id,
            context_sources: BTreeMap::new(),
            time_basis: None,
            covered_user_turns: 0,
            real_users: 0,
            tool_results: 0,
            messages: first_ordinal,
            last_user: None,
            orphan_result: false,
            protection: None,
            pre_cut_tags: Vec::new(),
            max_tag: 0,
            todo: None,
        }
    }

    /// True when `number` was a tag below the cut.
    pub(super) fn tagged_below(&self, number: u64) -> bool {
        self.pre_cut_tags
            .iter()
            .any(|(lo, hi)| (*lo..=*hi).contains(&number))
    }

    /// The running totals as they stood just below the cut, from which a
    /// fold over the window continues.
    pub(super) fn base_aggregates(&self) -> resident::Aggregates {
        resident::Aggregates {
            through: self.first_ordinal.checked_sub(1),
            real_users: self.real_users,
            tool_results: self.tool_results,
            last_user: self.last_user.clone(),
            open_calls: BTreeSet::new(),
            orphan_result: self.orphan_result,
            historian_input: historian_tail::InputIndex::seeded(self.first_ordinal, self.messages),
        }
    }

    /// The todo scan a lineage beginning at the cut starts with: everything
    /// below the cut already scanned, no call waiting for its result (a cut
    /// never splits a tool arc).
    pub(super) fn todo_scan(&self, lineage: &str) -> super::super::runner_todo::TodoScan {
        super::super::runner_todo::TodoScan {
            lineage: lineage.into(),
            through: self.first_ordinal.checked_sub(1),
            pending: BTreeMap::new(),
        }
    }

    /// The engine's logical prefix standing for the rows below the cut.
    pub(super) fn prefix(
        &self,
        lineage: &str,
        generation: u64,
        revert_epoch: u64,
    ) -> transform::compaction::LogicalPrefix {
        let (floor, ratio, rows) = self.protection.as_ref().map_or_else(
            || (u64::MAX, f64::MIN, Vec::new()),
            |protection| (protection.floor, protection.ratio, protection.rows.clone()),
        );
        transform::compaction::LogicalPrefix::for_cut(
            transform::compaction::CutPrefixFacts {
                lineage_from: self.lineage_from,
                first_ordinal: self.first_ordinal,
                covered_user_turns: self.covered_user_turns,
                context_sources: self.context_sources.clone(),
                compartment_seq: self.compartment_seq,
                boundary: self.boundary_id.clone(),
                revert_epoch,
                protection_floor: floor,
                protection_ratio: ratio,
                protection_tags: rows,
                max_tag: self.max_tag as i64,
                time_basis: self.time_basis,
            },
            lineage,
            generation,
        )
    }

    pub(super) fn retained_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.cut_mid.len()
            + self.cut_digest.len()
            + self.boundary_id.len()
            + self
                .context_sources
                .values()
                .map(|source| 128 + crate::retained_size::value_retained_bytes(&source.message))
                .sum::<usize>()
            + self.protection.as_ref().map_or(0, |protection| {
                protection
                    .rows
                    .iter()
                    .map(|(_, id, kind, _, _)| 64 + id.len() + kind.len())
                    .sum()
            })
            + self.pre_cut_tags.len() * 16
            + self
                .todo
                .as_ref()
                .map_or(0, |todo| todo.state_json.len() + 128)
    }
}

/// The held entries `ordinals` prepared as the engine would see them: decoded
/// with the conversation's codec, reminder echoes marked, Pi positions
/// counted from `source_from`.
fn prepared(
    state: &State,
    codec: codec::Codec,
    ordinals: std::ops::Range<u64>,
    source_from: u64,
) -> Result<TransformRequest, HandlerOutcome> {
    let messages = inbound_messages(state.entries.range(ordinals).map(|(_, entry)| entry))?;
    let mut request: TransformRequest = decode(
        &json!({"v":2,"kind":"compaction.step","session_id":state.namespace(),"messages":[],"render_config":"cut-seed","tool_present":false,"auto_search_enabled":false}),
    )?;
    if messages.is_empty() {
        return Ok(request);
    }
    state.reminder_echoes.prepare_with(
        codec,
        &mut request,
        &messages,
        false,
        |request, entries| codec.prepare_request_from(request, entries, source_from),
    )?;
    Ok(request)
}

/// Authored user turns among `ordinals` as the engine counts them, outside
/// `context`.
fn user_turns(
    state: &State,
    codec: codec::Codec,
    ordinals: std::ops::Range<u64>,
    source_from: u64,
    context: &BTreeSet<u64>,
) -> Result<u64, HandlerOutcome> {
    let end = ordinals.end;
    let request = prepared(state, codec, ordinals, source_from)?;
    let projection = ck_wire::project_messages(&request.messages).map_err(transient)?;
    Ok(transform::compaction::user_turns_below(
        &projection.blocks,
        end,
        context,
    ))
}

impl AsyncRecord {
    /// The ordinal the next transcript read starts at: the newest held entry
    /// (read again to check the overlap), or the first ordinal of the
    /// lineage when nothing is held. A lineage that begins at a cut is never
    /// read below its first ordinal.
    pub(super) fn read_from(&self) -> u64 {
        self.entries.last_key_value().map_or_else(
            || self.cut_seed.as_ref().map_or(0, |seed| seed.first_ordinal),
            |(n, _)| *n,
        )
    }

    /// The first ordinal of the lineage this record's ordinals count from.
    pub(super) fn lineage_from(&self) -> u64 {
        self.cut_seed.as_ref().map_or_else(
            || self.entries.first_key_value().map_or(0, |(n, _)| *n),
            |seed| seed.lineage_from,
        )
    }

    /// Capture the seed for a cut whose first window ordinal is `first`,
    /// while the rows below it are still held. The work is bounded by the
    /// window and the span between the cut and the current certificate,
    /// except for a record with no certificate, whose rows below the cut are
    /// decoded once.
    pub(super) fn capture_cut_seed(
        &mut self,
        store: &McStore,
        codec: codec::Codec,
        first: u64,
    ) -> Result<Result<CutSeed, CaptureRefusal>, HandlerOutcome> {
        let previous = self.cut_seed.clone();
        let base = previous.as_ref().map_or_else(
            || self.entries.first_key_value().map_or(0, |(n, _)| *n),
            |seed| seed.first_ordinal,
        );
        let lineage_from = self.lineage_from();
        let Some(cut) = first.checked_sub(1) else {
            return Ok(Err(CaptureRefusal::Unheld));
        };
        if first <= base || !self.entries.contains_key(&cut) || !self.entries.contains_key(&first) {
            return Ok(Err(CaptureRefusal::Unheld));
        }
        let namespace = self.namespace();
        let loaded = store.load(&namespace).map_err(transient)?;
        let compartments = store.load_compartments(&namespace).map_err(transient)?;
        let mut next = lineage_from as i64;
        let mut sorted = compartments.iter().collect::<Vec<_>>();
        sorted.sort_by_key(|c| c.start_message);
        for compartment in sorted {
            if compartment.start_message <= next && compartment.end_message >= next {
                next = compartment.end_message.saturating_add(1);
            }
        }
        // The compartments must cover every message below the cut, and the
        // engine must have folded through it: a runner applies a cut only
        // with a view whose history covers it.
        if loaded
            .meta
            .coverage_ordinal
            .is_none_or(|coverage| coverage < cut)
            || next <= cut as i64
        {
            return Ok(Err(CaptureRefusal::NotCovered));
        }
        let newest_compartment = compartments.iter().max_by_key(|c| c.sequence);
        // The running totals cover every held entry; subtract the window.
        self.fold_entries(codec, None)?;
        let mut window_users = 0u64;
        let mut window_tools = 0u64;
        for (_, entry) in self.entries.range(first..) {
            let mut message = decoded_entry(codec, &entry.inbound()?)?;
            self.reminder_echoes.annotate(&mut message);
            window_users += u64::from(self.reminder_echoes.authored(&message));
            window_tools += message
                .ck
                .content
                .iter()
                .filter(|block| matches!(block.kind, ck_wire::CkKind::ToolResult { .. }))
                .count() as u64;
        }
        // A tool result in the window whose call is not in the window would
        // be split from it by the cut. Checked on the window as the engine
        // decodes it, where positional fallback ids agree.
        let end = self.entries.last_key_value().map_or(first, |(n, _)| n + 1);
        let window = prepared(self, codec, first..end, lineage_from)?;
        let mut calls = HashSet::new();
        for message in &window.messages {
            for block in &message.ck.content {
                match &block.kind {
                    ck_wire::CkKind::ToolCall {
                        id,
                        provider_executed: false,
                        ..
                    } => {
                        calls.insert(id.clone());
                    }
                    ck_wire::CkKind::ToolResult {
                        id,
                        provider_executed: false,
                        ..
                    } if !calls.contains(id) => return Ok(Err(CaptureRefusal::SplitsToolArc)),
                    _ => {}
                }
            }
        }
        let window_count = self.entries.range(first..).count() as u64;
        let aggregates = &self.aggregates;
        if !aggregates.historian_input.is_start(first) {
            return Ok(Err(CaptureRefusal::NotAtRestartPoint));
        }
        let mut last_user = aggregates
            .last_user
            .clone()
            .filter(|(ordinal, _)| *ordinal < first);
        if aggregates
            .last_user
            .as_ref()
            .is_some_and(|(ordinal, _)| *ordinal >= first)
        {
            // The newest authored user is in the window: find the newest one
            // below the cut, walking back from it.
            last_user = previous.as_ref().and_then(|seed| seed.last_user.clone());
            for (ordinal, entry) in self.entries.range(base..first).rev() {
                let mut message = decoded_entry(codec, &entry.inbound()?)?;
                self.reminder_echoes.annotate(&mut message);
                if self.reminder_echoes.authored(&message) {
                    last_user = Some((*ordinal, entry.mid.clone()));
                    break;
                }
            }
        }
        let real_users = aggregates.real_users.saturating_sub(window_users);
        let tool_results = aggregates.tool_results.saturating_sub(window_tools);
        let messages = aggregates
            .historian_input
            .count()
            .saturating_sub(window_count);
        let orphan_result = aggregates.orphan_result;
        // A certificate whose omitted input is unchanged carries the engine's
        // own count, context and protection below its tail.
        let certificate = self
            .logical_prefix
            .clone()
            .filter(|prefix| !prefix.is_cut())
            .filter(|prefix| prefix.tail_from > base || previous.is_none())
            .filter(|prefix| {
                self.entries
                    .matches(self.prefix_input_proof.as_ref(), prefix.tail_from)
            });
        let anchor_mid = loaded
            .meta
            .anchor_block_id
            .as_deref()
            .map(|block| block_mid(block).to_owned());
        let system_rows = |state: &Self,
                           span: std::ops::Range<u64>|
         -> Result<BTreeMap<u64, InboundMessage>, HandlerOutcome> {
            let mut sources = BTreeMap::new();
            for (ordinal, entry) in state.entries.range(span) {
                let inbound = entry.inbound()?;
                let decoded = decoded_entry(codec, &inbound)?;
                if decoded.ck.role == "system" || anchor_mid.as_deref() == Some(entry.mid.as_str())
                {
                    sources.insert(*ordinal, inbound);
                }
            }
            Ok(sources)
        };
        let mut context_sources = previous
            .as_ref()
            .map(|seed| seed.context_sources.clone())
            .unwrap_or_default();
        let covered_user_turns = match &certificate {
            Some(prefix) => {
                let tail = prefix.tail_from;
                context_sources.extend(
                    prefix
                        .context_sources
                        .iter()
                        .filter(|(ordinal, _)| **ordinal < first)
                        .map(|(ordinal, source)| (*ordinal, source.clone())),
                );
                if tail <= first {
                    let span = system_rows(self, tail..first)?;
                    let context = span.keys().copied().collect();
                    context_sources.extend(span);
                    prefix.covered_user_turns
                        + user_turns(self, codec, tail..first, lineage_from, &context)?
                } else {
                    let context = prefix.context_ordinals.clone();
                    prefix.covered_user_turns.saturating_sub(user_turns(
                        self,
                        codec,
                        first..tail,
                        lineage_from,
                        &context,
                    )?)
                }
            }
            None => {
                let span = system_rows(self, base..first)?;
                let context = span.keys().copied().collect();
                context_sources.extend(span);
                previous.as_ref().map_or(0, |seed| seed.covered_user_turns)
                    + user_turns(self, codec, base..first, lineage_from, &context)?
            }
        };
        let context_bytes = context_sources
            .values()
            .map(|source| source.message.to_string().len())
            .sum::<usize>();
        if context_bytes > MAX_CONTEXT_BYTES {
            return Ok(Err(CaptureRefusal::Oversize));
        }
        let cut_entry = self.entries[&cut].read()?;
        let cut_decoded = decoded_entry(codec, &self.entries[&cut].inbound()?)?;
        let time_basis = Some((
            cut_decoded.ck.meta.created_at_ms,
            cut_decoded.ck.meta.completed_at_ms,
        ));
        // Protected tool tags whose block is not in the window.
        let below = |block: &str| {
            self.mid_index
                .get(block_mid(block))
                .is_none_or(|ordinal| *ordinal < first)
        };
        let protection = match &certificate {
            Some(prefix) => {
                let (floor, ratio, rows) = prefix.protection();
                SeedProtection {
                    floor,
                    ratio,
                    rows: rows.iter().filter(|row| below(&row.1)).cloned().collect(),
                }
            }
            None => {
                let model = self
                    .conditions
                    .as_ref()
                    .and_then(|conditions| conditions.get("model"))
                    .map(String::as_str)
                    .unwrap_or(&self.setup.model);
                let floor = loaded.meta.protected_tokens_effective.unwrap_or(0);
                let ratio =
                    crate::decision_calibration::DecisionCalibration::for_model(Some(model))
                        .tools_ratio;
                let rows = store
                    .load_tags_after(&namespace, i64::MIN)
                    .map_err(transient)?;
                let window =
                    crate::protection_window::ProtectionWindow::from_persisted_rows_calibrated(
                        &rows, floor, ratio,
                    );
                SeedProtection {
                    floor,
                    ratio,
                    rows: window
                        .member_rows
                        .into_iter()
                        .filter(|row| below(&row.block_id))
                        .map(|row| {
                            (
                                row.tag_number,
                                row.block_id,
                                row.kind,
                                row.token_count,
                                row.created_at_ms,
                            )
                        })
                        .collect(),
                }
            }
        };
        if protection.rows.len() > MAX_PROTECTION_ROWS {
            return Ok(Err(CaptureRefusal::Oversize));
        }
        let mut numbers = self
            .tag_index
            .iter()
            .filter(|(_, address)| address.ordinal < first)
            .filter_map(|(tag, _)| tags::parse_tag(tag))
            .collect::<Vec<_>>();
        numbers.sort_unstable();
        let mut pre_cut_tags = previous
            .as_ref()
            .map(|seed| seed.pre_cut_tags.clone())
            .unwrap_or_default();
        pre_cut_tags.extend(ranges(numbers.iter().copied()));
        pre_cut_tags.sort_unstable();
        let max_tag = numbers
            .last()
            .copied()
            .into_iter()
            .chain(previous.as_ref().map(|seed| seed.max_tag))
            .max()
            .unwrap_or(0);
        let todo = match (
            &loaded.meta.last_todo_state,
            &loaded.meta.last_todo_state_owner_message_id,
            &loaded.meta.last_todo_state_hash,
        ) {
            (Some(state_json), Some(owner), Some(hash)) => Some(SeedTodo {
                state_json: state_json.clone(),
                owner_message_id: owner.clone(),
                state_hash: hash.clone(),
            }),
            _ => None,
        };
        Ok(Ok(CutSeed {
            first_ordinal: first,
            lineage_from,
            cut_mid: cut_entry.mid.clone(),
            cut_digest: served_digest(&cut_entry)?,
            compartment_seq: loaded.meta.coverage_compartment_seq.unwrap_or_else(|| {
                newest_compartment.map_or(loaded.meta.folded_compartment_seq, |c| c.sequence)
            }),
            boundary_id: if loaded.core.boundary_id.is_empty() {
                newest_compartment.map_or_else(String::new, |c| c.end_message_id.clone())
            } else {
                loaded.core.boundary_id.clone()
            },
            context_sources,
            time_basis,
            covered_user_turns,
            real_users,
            tool_results,
            messages,
            last_user,
            orphan_result,
            protection: Some(protection),
            pre_cut_tags,
            max_tag,
            todo,
        }))
    }
}

/// One named refusal to prune below a cut.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum PruneRefusal {
    /// The seed is not for a cut above this record's current first row, or
    /// the record does not hold its first window message.
    NotAhead,
    /// A view this record still serves or may serve renders a row below the
    /// cut.
    RenderedBelow,
}

/// The message a frozen engine unit edits, by its key: `red:` and `cav:`
/// name a block, `strip:<kind>:` a block or a message.
fn frozen_unit_mid(key: &str) -> Option<&str> {
    if let Some(block) = key
        .strip_prefix("red:")
        .or_else(|| key.strip_prefix("cav:"))
    {
        return Some(block_mid(block));
    }
    let rest = key.strip_prefix("strip:")?;
    let (_, target) = rest.rsplit_once(':')?;
    Some(block_mid(target))
}

impl AsyncRecord {
    /// The running totals a fold over the held entries starts from: what the
    /// cut seed stands for, or nothing.
    pub(super) fn base_aggregates(&self) -> resident::Aggregates {
        self.cut_seed
            .as_ref()
            .map_or_else(Default::default, |seed| seed.base_aggregates())
    }

    /// Begin this conversation at a cut: the record holds no rows yet and
    /// its first read starts at the seed's first ordinal. Its engine
    /// namespace has the compartments covering everything below the cut and
    /// nothing derived from the transcript; the first engine pass is the
    /// engine's own bootstrap over the seed's context sources and the window
    /// (see `async_engine`).
    pub(super) fn begin_at_cut(
        &mut self,
        store: &McStore,
        seed: CutSeed,
    ) -> Result<(), HandlerOutcome> {
        if !self.entries.is_empty() {
            return Err(invalid(
                "a conversation begins at a cut only before it holds rows",
            ));
        }
        // Commit the history's coverage through the cut in the engine
        // namespace first, as the fold that made the cut did: the seeded
        // boundary adopts it from the compartments, and the engine's first
        // pass is its own bootstrap fold over a namespace whose rows below
        // the cut are covered history, not tail.
        if !seed.boundary_id.is_empty() {
            // Setup's initial view initializes the namespace without folding
            // anything. A namespace that has covered nothing takes the seed
            // as a fresh one would; one with coverage keeps its own boundary.
            let namespace = self.namespace();
            let loaded = store.load_meta(&namespace).map_err(transient)?;
            if loaded.meta.initialized && loaded.meta.coverage_ordinal.is_none() {
                let mut meta = loaded.meta;
                meta.initialized = false;
                store
                    .commit_meta(&namespace, loaded.row_version, &meta)
                    .map_err(transient)?;
            }
            store
                .apply_authority_state_sync(mc_store::ModuleStateSyncRequest {
                    resolved_compartment_boundaries: &[],
                    session_id: &self.namespace(),
                    project_path: &self.key.project.to_string_lossy(),
                    shadow_generation: 0,
                    expected_shadow_seq: 0,
                    seed_boundary_id: Some(&seed.boundary_id),
                    drop_seeds: &[],
                    drop_seed_skipped: 0,
                    strip_seeds: &[],
                    strip_seed_skipped: 0,
                    reasoning_cleared_through_tag: None,
                    last_todo_state: None,
                    pending_agent_drops: &[],
                    pending_agent_drops_skipped: 0,
                    user_hint_seeds: &[],
                    auto_search_hint_skipped: 0,
                    note_nudge_anchors: None,
                    todo_synthetic_anchor: None,
                    todo_synthetic_anchor_present: false,
                    emergency_latches: None,
                    pending_compaction_marker: None,
                    deferred_execute_state: None,
                    channel2_nudge_state: None,
                    acked_watermarks: Value::Null,
                })
                .map_err(|error| transient(format!("{error:?}")))?;
        }
        if let Some(todo) = &seed.todo {
            store
                .set_todo_state(
                    &self.namespace(),
                    &todo.state_json,
                    &todo.owner_message_id,
                    &todo.state_hash,
                )
                .map_err(transient)?;
        }
        self.todo_scan = self
            .lineage
            .as_deref()
            .map(|lineage| seed.todo_scan(lineage));
        self.cut_first_ordinal = Some(seed.first_ordinal);
        self.cut_seed = Some(Arc::new(seed));
        self.aggregates = self.base_aggregates();
        self.journal.cut_seed_dirty = true;
        self.save(store, &[])
    }

    /// Remove every row below the seed's cut from this record and its engine
    /// namespace, and keep the seed. Permitted only when nothing a held view
    /// renders lies below the cut, so no later view can need a removed row.
    pub(super) fn prune_below_cut(
        &mut self,
        store: &McStore,
        seed: CutSeed,
    ) -> Result<Result<(), PruneRefusal>, HandlerOutcome> {
        let first = seed.first_ordinal;
        let base = self.cut_seed.as_ref().map_or(0, |held| held.first_ordinal);
        if first <= base || !self.entries.contains_key(&first) {
            return Ok(Err(PruneRefusal::NotAhead));
        }
        for view in self
            .produced_view
            .iter()
            .chain(&self.applied_view)
            .chain(self.published_engine.values())
        {
            if view.view()?.replacement.iter().any(|message| {
                !message.meta.synthetic && message.meta.ordinal.is_some_and(|n| n < first)
            }) {
                return Ok(Err(PruneRefusal::RenderedBelow));
            }
        }
        let kept: HashSet<&str> = seed
            .context_sources
            .values()
            .map(|source| source.mid.as_str())
            .collect();
        let below: HashSet<String> = self
            .entries
            .range(..first)
            .map(|(_, entry)| entry.mid.clone())
            .filter(|mid| !kept.contains(mid.as_str()))
            .collect();
        self.entries.retain(|ordinal, _| *ordinal >= first);
        self.mid_index.retain(|_, ordinal| *ordinal >= first);
        self.tag_index.retain(|_, address| address.ordinal >= first);
        self.reminder_echoes.truncate_below(first);
        self.frozen_edits.forget_mids(&below);
        self.retired_frozen.forget_mids(&below);
        self.aggregates.historian_input.truncate_below(first);
        self.entry_bytes = (None, 0);
        // A certificate whose tail is at or after the cut still describes the
        // held rows it omits: re-prove them without the removed ones.
        match self.logical_prefix.as_ref().map(|prefix| prefix.tail_from) {
            Some(tail) if tail >= first => {
                self.prefix_input_proof = Some(self.entries.proof_before(tail));
            }
            _ => {
                self.logical_prefix = None;
                self.prefix_input_proof = None;
            }
        }
        let namespace = self.namespace();
        let mids = below.iter().cloned().collect::<Vec<_>>();
        store
            .prune_namespace_messages(&namespace, &mids)
            .map_err(transient)?;
        let mut pruned = false;
        for _ in 0..4 {
            let mut loaded = store.load(&namespace).map_err(transient)?;
            if loaded.row_version.is_none() {
                pruned = true;
                break;
            }
            loaded
                .core
                .frozen_units
                .retain(|unit| frozen_unit_mid(&unit.key).is_none_or(|mid| !below.contains(mid)));
            let meta = &mut loaded.meta;
            meta.block_identity_by_mid
                .retain(|mid, _| !below.contains(mid));
            for set in [
                &mut meta.protected_tool_block_ids,
                &mut meta.pending_tag_block_ids,
                &mut meta.pending_user_hint_block_ids,
            ] {
                set.retain(|block| !below.contains(block_mid(block)));
            }
            meta.reclassified_synthetic_mids
                .retain(|mid| !below.contains(mid));
            match store.commit(&namespace, loaded.row_version, &loaded.core, &loaded.meta) {
                Ok(_) => {
                    pruned = true;
                    break;
                }
                Err(mc_store::McStoreError::CasConflict { .. }) => continue,
                Err(error) => return Err(transient(error)),
            }
        }
        if !pruned {
            return Err(transient(
                "engine state kept changing while pruning below a cut",
            ));
        }
        self.journal.truncate_below = Some(first);
        self.journal.persisted_through = self.entries.last_key_value().map(|(n, _)| *n);
        self.cut_first_ordinal = Some(first);
        self.cut_seed = Some(Arc::new(seed));
        self.journal.cut_seed_dirty = true;
        self.save(store, &[])?;
        Ok(Ok(()))
    }
}

/// Discard a stored record written before cut seeds existed: it is rebuilt
/// through the reset a lineage change takes, in the next generation, and its
/// next read starts from the runner's first ordinal. Such records exist only
/// in tests; there is no migration.
pub(super) fn discard_older_record(
    state: &mut AsyncRecord,
    store: &McStore,
) -> Result<bool, HandlerOutcome> {
    if state.record_version >= RECORD_VERSION {
        return Ok(false);
    }
    state.record_version = RECORD_VERSION;
    state.cut_first_ordinal = None;
    state.cut_seed = None;
    state.reset(store)?;
    Ok(true)
}

/// Engine passes by provider instance, for tests that compare how two
/// providers handled the same notices.
#[cfg(test)]
pub(super) mod pass_trace {
    use std::sync::Mutex;

    static PASSES: Mutex<Vec<(usize, String)>> = Mutex::new(Vec::new());

    pub fn record(provider: usize, line: String) {
        PASSES.lock().unwrap().push((provider, line));
    }

    /// The passes `provider` ran since the last call, in order.
    pub fn take(provider: usize) -> Vec<String> {
        let mut passes = PASSES.lock().unwrap();
        let (taken, kept) = std::mem::take(&mut *passes)
            .into_iter()
            .partition::<Vec<_>, _>(|(owner, _)| *owner == provider);
        *passes = kept;
        taken.into_iter().map(|(_, line)| line).collect()
    }
}
