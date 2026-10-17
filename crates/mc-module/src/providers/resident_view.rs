use super::compaction::HostView;
use super::resident_bytes::{ByteArena, Document};
use super::*;
use std::borrow::Cow;
use std::collections::HashMap;

pub(super) fn canonical_engine_bytes<'a>(
    messages: &[ck_wire::CkWireMessage],
    served: &'a [transform::ServedMessage],
) -> Vec<Cow<'a, [u8]>> {
    let by_mid: HashMap<_, _> = served
        .iter()
        .filter_map(|message| Some((message.meta.harness_id.as_deref()?, message)))
        .collect();
    messages
        .iter()
        .enumerate()
        .map(|(position, message)| {
            let cached = message
                .meta
                .harness_id
                .as_deref()
                .and_then(|mid| by_mid.get(mid).copied())
                .or_else(|| served.get(position));
            if let Some(cached) = cached.filter(|cached| message == &***cached) {
                Cow::Borrowed(cached.canonical_bytes())
            } else {
                Cow::Owned(message.to_canonical_json_vec().expect("CK message JSON"))
            }
        })
        .collect()
}

fn mid_hash(mid: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    mid.hash(&mut hash);
    hash.finish()
}

pub(super) struct ResidentView {
    pub metadata: HostView,
    pub engine: Vec<Document>,
    pub native: Vec<Document>,
    pub encoding_key: Option<[u8; 32]>,
    positions: HashMap<(u64, u64), Vec<usize>>,
}

impl ResidentView {
    pub fn metadata_of(view: &HostView) -> HostView {
        let mut wire = view.wire.clone();
        wire.replacement.clear();
        HostView {
            engine: transform::compaction::View {
                compaction_id: view.engine.compaction_id.clone(),
                version: view.engine.version,
                range: view.engine.range.clone(),
                replacement: Vec::new(),
            },
            wire,
            coverage: view.coverage.clone(),
            raw_replacement: view.raw_replacement.clone(),
            head_slots: view.head_slots.clone(),
            cut_replacement: view.cut_replacement.clone(),
        }
    }
    pub fn store(
        arena: &mut ByteArena,
        view: &HostView,
        encoding_key: Option<[u8; 32]>,
        encoded: Option<&[Cow<'_, [u8]>]>,
    ) -> Result<Self, HandlerOutcome> {
        let engine = if let Some(encoded) = encoded {
            encoded.iter().map(|bytes| arena.insert(bytes)).collect()
        } else {
            view.engine
                .replacement
                .iter()
                .map(|message| {
                    message
                        .to_canonical_json_vec()
                        .map(|bytes| arena.insert(&bytes))
                        .map_err(transient)
                })
                .collect::<Result<_, _>>()?
        };
        let native = view
            .wire
            .replacement
            .iter()
            .map(|message| {
                serde_json::to_vec(message)
                    .map(|bytes| arena.insert(&bytes))
                    .map_err(transient)
            })
            .collect::<Result<_, _>>()?;
        let metadata = Self::metadata_of(view);
        let mut positions: HashMap<(u64, u64), Vec<usize>> = HashMap::new();
        for (position, message) in view.engine.replacement.iter().enumerate() {
            if let (Some(mid), Some(ordinal)) = (&message.meta.harness_id, message.meta.ordinal) {
                positions
                    .entry((ordinal, mid_hash(mid)))
                    .or_default()
                    .push(position);
            }
        }
        Ok(Self {
            metadata,
            engine,
            native,
            encoding_key,
            positions,
        })
    }

    pub fn load(&self, arena: &ByteArena) -> Result<HostView, HandlerOutcome> {
        let mut view = self.metadata.clone();
        view.engine.replacement = self
            .engine
            .iter()
            .map(|&document| serde_json::from_slice(&arena.bytes(document)).map_err(transient))
            .collect::<Result<_, _>>()?;
        view.wire.replacement = self
            .native
            .iter()
            .map(|&document| serde_json::from_slice(&arena.bytes(document)).map_err(transient))
            .collect::<Result<_, _>>()?;
        Ok(view)
    }

    pub fn release(self, arena: &mut ByteArena) {
        for document in self.engine.into_iter().chain(self.native) {
            arena.release(document);
        }
    }

    pub fn engine_matches(
        &self,
        arena: &ByteArena,
        position: usize,
        message: &ck_wire::CkWireMessage,
    ) -> bool {
        self.engine.get(position).is_some_and(|&document| {
            arena.equals(
                document,
                &message.to_canonical_json_vec().expect("CK message JSON"),
            )
        })
    }

    pub fn native_matches(&self, arena: &ByteArena, position: usize, message: &Value) -> bool {
        self.native.get(position).is_some_and(|&document| {
            arena.equals(
                document,
                &serde_json::to_vec(message).expect("native message JSON"),
            )
        })
    }

    pub fn retained_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + serde_json::to_vec(&self.metadata).expect("view metadata JSON").len() * 4
            + self.metadata.engine.compaction_id.capacity()
            + self.metadata.engine.range.lineage_id.capacity()
            + self.metadata.wire.compaction_id.capacity()
            + self
                .metadata
                .coverage
                .as_ref()
                .map_or(0, |coverage| coverage.end_mid.capacity())
            + (self.engine.capacity() + self.native.capacity()) * std::mem::size_of::<Document>()
            + crate::retained_size::hash_map_allocation_bytes(&self.positions)
            + self
                .positions
                .values()
                .map(|positions| positions.capacity() * std::mem::size_of::<usize>())
                .sum::<usize>()
    }
}

impl super::view_recipe::RecipeBase for AppliedView<'_> {
    fn version(&self) -> u64 {
        self.view.metadata.engine.version
    }
    fn lineage(&self) -> &str {
        &self.view.metadata.engine.range.lineage_id
    }
    fn same_slot(&self, position: usize, ck: &ck_wire::CkWireMessage, wire: &Value) -> bool {
        self.view.engine_matches(self.arena, position, ck)
            && self.view.native_matches(self.arena, position, wire)
    }
    fn same_native(&self, mid: &str, ordinal: u64, ck: &[u8], wire: &Value) -> bool {
        self.view
            .positions
            .get(&(ordinal, mid_hash(mid)))
            .is_some_and(|positions| {
                positions.iter().any(|&position| {
                    self.view
                        .engine
                        .get(position)
                        .is_some_and(|&document| self.arena.equals(document, ck))
                        && self.view.native_matches(self.arena, position, wire)
                })
            })
    }
}

pub(super) struct AppliedView<'a> {
    pub view: &'a ResidentView,
    pub arena: &'a ByteArena,
}
impl transform::compaction::AppliedComparison for AppliedView<'_> {
    fn matches(
        &self,
        candidate: &transform::compaction::View,
        raw: &[ck_wire::CkIngressMessage],
    ) -> bool {
        let applied = &self.view.metadata.engine;
        if applied.range.lineage_id != candidate.range.lineage_id
            || applied.range.from != candidate.range.from
        {
            return false;
        }
        let added = raw
            .iter()
            .filter(|message| message.ordinal >= applied.range.to)
            .map(|message| &message.ck)
            .collect::<Vec<_>>();
        if self.view.engine.len() + added.len() != candidate.replacement.len() {
            return false;
        }
        candidate
            .replacement
            .iter()
            .enumerate()
            .all(|(position, message)| {
                if position < self.view.engine.len() {
                    self.view.engine_matches(self.arena, position, message)
                } else {
                    added[position - self.view.engine.len()]
                        .to_canonical_json_vec()
                        .unwrap()
                        == message.to_canonical_json_vec().unwrap()
                }
            })
    }
}
