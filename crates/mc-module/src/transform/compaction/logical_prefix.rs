//! A covered logical prefix omits source rows only after a successful rebuild
//! certifies them as covered. It retains the live boundary,
//! system sources, and an arc-safe consecutive suffix with original ordinals.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Coverage {
    sequence: i64,
    from: i64,
    to: i64,
    boundary: String,
}

impl From<&StoredCompartment> for Coverage {
    fn from(c: &StoredCompartment) -> Self {
        Self {
            sequence: c.sequence,
            from: c.start_message,
            to: c.end_message,
            boundary: c.end_message_id.clone(),
        }
    }
}

fn coverage_preserved(old: &[Coverage], current: &[StoredCompartment]) -> bool {
    let mut ranges = current.iter().collect::<Vec<_>>();
    ranges.sort_by_key(|c| c.start_message);
    old.iter().all(|old| {
        let mut next = old.from;
        for c in &ranges {
            if c.start_message <= next && c.end_message >= next {
                next = c.end_message.saturating_add(1);
            }
        }
        next > old.to
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct LogicalPrefix {
    pub(crate) lineage: String,
    pub(crate) generation: u64,
    pub(crate) from: u64,
    pub(crate) tail_from: u64,
    /// Authored user turns omitted from the projection. Channel-1 cadence
    /// counts the whole conversation even when its model input is bounded.
    pub(crate) covered_user_turns: u64,
    /// Source extent observed when this rebuild certified the omitted prefix.
    certified_through: u64,
    coverage: u64,
    boundary: String,
    sequence: i64,
    revert_epoch: u64,
    compartments: Vec<Coverage>,
    /// Ordinals of original system messages and the source message containing
    /// the durable lineage anchor; all must remain available before the cut.
    pub(crate) context_ordinals: BTreeSet<u64>,
    /// Native source messages with their content, not just identities: a hard rebuild must
    /// render the covered system content again without decoding covered rows.
    pub(crate) context_sources: BTreeMap<u64, crate::providers::codec::InboundMessage>,
    /// A frozen target can be absent because its source is covered; that absence
    /// alone does not mean a revert removed it from the transcript.
    covered_targets: BTreeSet<String>,
    /// Source invocation and result ordinals for arcs crossing coverage. The
    /// suffix begins before their invocations, so native blocks stay intact.
    crossing_arcs: Vec<(u64, u64)>,
    tag_summary: (u64, usize, i64),
    protection_floor: u64,
    protection_ratio: f64,
    /// Global newest tool-tag suffix, including protected tags whose sources
    /// are no longer live. Protection is based on persisted tags, not messages.
    protection_tags: Vec<(i64, String, String, i64, i64)>,
}

impl LogicalPrefix {
    pub(crate) fn matches(
        &self,
        lineage: &str,
        generation: u64,
        loaded: &mc_store::LoadedState,
        compartments: &[StoredCompartment],
    ) -> bool {
        self.lineage == lineage
            && self.generation == generation
            && loaded.core.boundary_id == self.boundary
            && loaded.meta.coverage_ordinal == Some(self.coverage)
            && meta_coverage_compartment_seq(&loaded.meta) == self.sequence
            && loaded.meta.revert_epoch == self.revert_epoch
            && self.from < self.tail_from
            && self.tail_from <= self.coverage
            && self.context_sources.keys().eq(self.context_ordinals.iter())
            && coverage_preserved(&self.compartments, compartments)
            && self.crossing_arcs.iter().all(|(call, result)| {
                *call >= self.tail_from && *call <= self.coverage && *result > self.coverage
            })
    }

    /// Mint only after Hard, MigrateHard or Soft passed the live coverage and
    /// identity guards. Defer cannot authorize omitting more source input.
    pub(crate) fn certify(
        store: &McStore,
        req: &TransformRequest,
        projection: &FlatProjection,
        loaded: &mc_store::LoadedState,
        compartments: &[StoredCompartment],
        lineage: &str,
        generation: u64,
    ) -> Option<Self> {
        let coverage = loaded.meta.coverage_ordinal?;
        let sequence = meta_coverage_compartment_seq(&loaded.meta);
        let applied = compartments
            .iter()
            .filter(|c| c.sequence <= sequence)
            .cloned()
            .collect::<Vec<_>>();
        // A historian may publish between the engine commit and this read.
        // Certify only the compartments that the engine actually adopted, not
        // the newer catalog head or a replacement that rewound its coverage.
        let boundary = applied.iter().find(|c| c.sequence == sequence)?;
        if boundary.end_message != coverage as i64
            || boundary.end_message_id != loaded.core.boundary_id
            || req.logical_prefix.as_ref().is_some_and(|old| {
                old.coverage > coverage || !coverage_preserved(&old.compartments, &applied)
            })
        {
            return None;
        }
        let live = projection
            .blocks
            .iter()
            .filter(|b| !b.synthetic)
            .collect::<Vec<_>>();
        if first_uncovered_live_block(&applied, &live, Some(coverage)).is_some() {
            return None;
        }
        let protection_floor = loaded.meta.protected_tokens_effective.unwrap_or(0);
        let protection_ratio =
            crate::decision_calibration::DecisionCalibration::for_model(req.model_key.as_deref())
                .tools_ratio;
        let rows = if let Some(prefix) = &req.logical_prefix {
            prefix
                .protection_rows(store, &req.session_id, protection_floor, protection_ratio)
                .ok()??
        } else {
            load_cached_tags(store, &req.session_id)
                .ok()?
                .as_ref()
                .clone()
        };
        let protection = crate::protection_window::ProtectionWindow::from_persisted_rows_calibrated(
            &rows,
            protection_floor,
            protection_ratio,
        );
        let summary = store.tag_cache_summary(&req.session_id).ok()?;
        let from = req.logical_prefix.as_ref().map_or_else(
            || req.messages.first().map_or(0, |m| m.ordinal),
            |prefix| prefix.from,
        );
        let mut tail_from = coverage;
        // Move the cut backwards until no completed tool arc crosses it. This
        // retains entire native invocations, including signed reasoning siblings.
        loop {
            let moved = split_coverage_tool_arcs(projection, tail_from.checked_sub(1))
                .iter()
                .filter_map(|arc| req.messages.iter().find(|m| m.mid == arc.invocation_mid))
                .map(|m| m.ordinal)
                .min()
                .unwrap_or(tail_from);
            if moved == tail_from {
                break;
            }
            tail_from = moved;
        }
        // Exceptional arcs cannot turn the optimization into another full walk.
        // Leave the raw rows authoritative and use the full path for this shape.
        if tail_from <= from || coverage.saturating_sub(tail_from) > 256 {
            tracing::debug!(session_id=%req.session_id, tail_from, coverage, reason="arc_safe_cut_span", "using full-lineage input");
            return None;
        }
        let anchor = loaded
            .meta
            .anchor_block_id
            .as_deref()
            .and_then(split_block_id);
        let context_ordinals: BTreeSet<u64> = req
            .messages
            .iter()
            .filter(|m| {
                m.ordinal < tail_from
                    && (m.ck.role == "system" || anchor.is_some_and(|(mid, _)| mid == m.mid))
            })
            .map(|m| m.ordinal)
            .collect();
        let covered_user_turns = req
            .logical_prefix
            .as_ref()
            .map_or(0, |p| p.covered_user_turns)
            .saturating_add(
                projection
                    .blocks
                    .iter()
                    .filter(|b| {
                        b.ordinal < tail_from
                            && !context_ordinals.contains(&b.ordinal)
                            && b.role == "user"
                            && !b.synthetic
                    })
                    .map(|b| b.mid.as_str())
                    .collect::<HashSet<_>>()
                    .len() as u64,
            );
        let required_targets = loaded
            .core
            .frozen_units
            .iter()
            .filter_map(|unit| {
                unit.key
                    .strip_prefix("red:")
                    .or_else(|| unit.key.strip_prefix(CAV_KEY_PREFIX))
            })
            .collect::<HashSet<_>>();
        let covered_targets = projection
            .blocks
            .iter()
            .filter(|b| b.ordinal < tail_from)
            .filter(|b| required_targets.contains(b.id.as_str()))
            .map(|b| b.id.clone())
            .chain(req.logical_prefix.iter().flat_map(|p| {
                p.covered_targets
                    .iter()
                    .filter(|id| required_targets.contains(id.as_str()))
                    .cloned()
            }))
            .collect();
        let crossing_arcs = split_coverage_tool_arcs(projection, Some(coverage))
            .iter()
            .filter_map(|arc| {
                req.messages
                    .iter()
                    .find(|m| m.mid == arc.invocation_mid)
                    .map(|m| (m.ordinal, arc.result_ordinal))
            })
            .collect::<Vec<_>>();
        if crossing_arcs.len() > 64 || protection.member_rows.len() > 4096 {
            tracing::debug!(session_id=%req.session_id, reason="prefix_exception_limit", "using full-lineage input");
            return None;
        }
        Some(Self {
            lineage: lineage.into(),
            generation,
            from,
            tail_from,
            covered_user_turns,
            certified_through: req.messages.last()?.ordinal,
            coverage,
            boundary: loaded.core.boundary_id.clone(),
            sequence,
            revert_epoch: loaded.meta.revert_epoch,
            compartments: applied.iter().map(Coverage::from).collect(),
            context_ordinals,
            context_sources: BTreeMap::new(),
            covered_targets,
            crossing_arcs,
            tag_summary: (summary.generation, summary.count, summary.max_tag_number),
            protection_floor,
            protection_ratio,
            protection_tags: protection
                .member_rows
                .into_iter()
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
        })
    }

    pub(crate) fn protection_rows(
        &self,
        store: &McStore,
        session: &str,
        floor: u64,
        ratio: f64,
    ) -> Result<Option<Vec<mc_store::McTagRow>>, TransformError> {
        let summary = store.tag_cache_summary(session)?;
        let (generation, count, max) = self.tag_summary;
        if floor > self.protection_floor
            || ratio < self.protection_ratio
            || summary.generation < generation
            || summary.count < count
            || summary.max_tag_number < max
            || summary.generation.saturating_sub(generation)
                != summary.count.saturating_sub(count) as u64
        {
            return Ok(None);
        }
        let mut rows = self
            .protection_tags
            .iter()
            .map(|(number, id, kind, tokens, created)| mc_store::McTagRow {
                tag_number: *number,
                block_id: id.clone(),
                kind: kind.clone(),
                token_count: *tokens,
                created_at_ms: *created,
                source_bytes: Arc::from([]),
            })
            .collect::<Vec<_>>();
        if summary.generation != generation {
            rows.extend(store.load_tags_after(session, max)?);
        }
        Ok(Some(rows))
    }

    pub(super) fn working_range(
        &self,
        status: &Status,
        messages: &[CkIngressMessage],
    ) -> Result<Range, TransformError> {
        if self.lineage != status.lineage_id
            || status
                .newest_ordinal
                .is_none_or(|newest| newest < self.certified_through)
            || messages
                .iter()
                .filter(|m| m.ordinal < self.tail_from)
                .any(|m| !self.context_ordinals.contains(&m.ordinal))
        {
            return Err(TransformError::OrdinalViolation);
        }
        let start = messages.partition_point(|m| m.ordinal < self.tail_from);
        if messages.get(start).map(|m| m.ordinal) != Some(self.tail_from)
            || !messages[..start]
                .iter()
                .map(|m| &m.ordinal)
                .eq(self.context_ordinals.iter())
        {
            return Err(TransformError::OrdinalViolation);
        }
        let mut range = super::working_range(status, &messages[start..])?;
        range.from = self.from;
        Ok(range)
    }

    pub(crate) fn prune_covered_units(&self, core: &mut CoreState) {
        core.frozen_units.retain(|unit| {
            !unit
                .key
                .strip_prefix("red:")
                .or_else(|| unit.key.strip_prefix(CAV_KEY_PREFIX))
                .is_some_and(|target| self.covered_targets.contains(target))
        });
    }

    pub(crate) fn prove_membership(&mut self, source: &CkIngressMessage) -> bool {
        // Synthetic rows are normalized before projection. Their raw block
        // positions are not a coverage proof; validate them with full input.
        if source.ck.meta.synthetic
            || source.ck.content.iter().any(|block| match &block.kind {
                ck_wire::CkKind::ToolCall { id, .. } | ck_wire::CkKind::ToolResult { id, .. } => {
                    is_synthetic_todo_id(id)
                }
                _ => false,
            })
        {
            return false;
        }
        if source.ordinal < self.tail_from {
            self.covered_targets.extend(
                source
                    .ck
                    .content
                    .iter()
                    .enumerate()
                    .map(|(index, _)| format!("{}#{index}", source.mid)),
            );
        }
        true
    }

    pub(crate) fn covers_target(&self, target: &str) -> bool {
        self.covered_targets.contains(target)
    }

    pub(crate) fn retained_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.lineage.capacity()
            + self.boundary.capacity()
            + self
                .context_sources
                .values()
                .map(|source| {
                    128 + source.mid.capacity()
                        + crate::retained_size::value_retained_bytes(&source.message)
                })
                .sum::<usize>()
            + self.context_ordinals.len() * 40
            + self
                .covered_targets
                .iter()
                .map(|id| 64 + id.capacity())
                .sum::<usize>()
            + self
                .compartments
                .iter()
                .map(|c| 64 + c.boundary.capacity())
                .sum::<usize>()
            + self.crossing_arcs.capacity() * 16
            + self
                .protection_tags
                .iter()
                .map(|(_, id, kind, _, _)| 64 + id.capacity() + kind.capacity())
                .sum::<usize>()
    }
}
