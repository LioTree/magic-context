//! Native edits already acknowledged by the runner, independent of engine cache eviction.
use super::*;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
struct FrozenPart {
    mid: String,
    part: String,
    digest: String,
    bytes: Option<String>,
}

impl FrozenPart {
    fn retained_bytes(&self) -> usize {
        192 + self.mid.len() * 2
            + self.part.len() * 2
            + self.digest.len()
            + self.bytes.as_ref().map_or(0, String::len)
    }
}

#[derive(Default)]
pub(super) struct FrozenEdits {
    parts: BTreeMap<(String, String, String), FrozenPart>,
    pub(super) retained_bytes: usize,
    pub(super) dirty: bool,
}

impl Serialize for FrozenEdits {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.parts.values())
    }
}

impl<'de> Deserialize<'de> for FrozenEdits {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let parts = Vec::<FrozenPart>::deserialize(deserializer)?;
        let mut edits = Self::default();
        for part in parts {
            edits.insert(part);
        }
        edits.dirty = false;
        Ok(edits)
    }
}

impl FrozenEdits {
    pub(super) fn from_json(json: &str) -> Result<Self, HandlerOutcome> {
        serde_json::from_str(json).map_err(transient)
    }

    pub(super) fn json(&self) -> Result<String, HandlerOutcome> {
        serde_json::to_string(self).map_err(transient)
    }

    fn insert(&mut self, part: FrozenPart) {
        let key = (part.mid.clone(), part.part.clone(), part.digest.clone());
        if self.parts.get(&key) == Some(&part) {
            return;
        }
        self.retained_bytes += part.retained_bytes() + part.digest.len();
        if let Some(old) = self.parts.insert(key, part) {
            self.retained_bytes -= old.retained_bytes() + old.digest.len();
        }
        self.dirty = true;
    }

    /// Record a whole-part drop that was applied before ck-mc served the session:
    /// a reduction the standalone plugin applied before the offline move.
    pub(super) fn insert_drop(&mut self, mid: &str, part: &str, digest: &str) {
        self.insert(FrozenPart {
            mid: mid.to_owned(),
            part: part.to_owned(),
            digest: digest.to_owned(),
            bytes: None,
        });
    }

    pub(super) fn merge(&mut self, acknowledged: &Self) {
        for part in acknowledged.parts.values() {
            self.insert(part.clone());
        }
    }

    /// Capture the actual native bytes, not a newly rendered reduction whose tags may differ.
    pub(super) fn capture(
        &mut self,
        view: &view::CompactionView,
        entries: &BTreeMap<u64, Arc<HeldEntry>>,
    ) -> Result<(), HandlerOutcome> {
        for range in &view.ranges {
            let view::ViewRange::Keep { edits, .. } = range else {
                continue;
            };
            let mut source = None;
            for edit in edits {
                if source
                    .as_ref()
                    .is_none_or(|entry: &ReadMessage| entry.ordinal != edit.ordinal)
                {
                    source = entries
                        .get(&edit.ordinal)
                        .map(|entry| entry.read())
                        .transpose()?;
                }
                let Some(entry) = source.as_ref().filter(|entry| entry.mid == edit.mid) else {
                    continue;
                };
                if !entry.tags.iter().any(|row| row.part == edit.part) {
                    continue;
                }
                let Ok(digest) = served_part_digest(entry, &edit.part) else {
                    continue;
                };
                let part = FrozenPart {
                    mid: edit.mid.clone(),
                    part: edit.part.clone(),
                    digest,
                    bytes: edit.bytes.clone(),
                };
                self.insert(part);
            }
        }
        Ok(())
    }

    /// Re-anchor by source identity, never by an ordinal retained from another lineage.
    pub(super) fn apply(
        &self,
        state: &State,
        ranges: &mut [view::ViewRange],
    ) -> Result<(), HandlerOutcome> {
        let mut anchored: BTreeMap<u64, Vec<view::PartEdit>> = BTreeMap::new();
        let mut sources = HashMap::new();
        for part in self.parts.values() {
            let Some(ordinal) = state.mid_index.get(&part.mid) else {
                continue;
            };
            if !sources.contains_key(ordinal) {
                sources.insert(*ordinal, state.entries[ordinal].read()?);
            }
            let entry = &sources[ordinal];
            if !entry.tags.iter().any(|row| row.part == part.part)
                || served_part_digest(entry, &part.part).ok().as_ref() != Some(&part.digest)
            {
                continue;
            }
            let edit = match &part.bytes {
                Some(bytes) => view::PartEdit::replace(*ordinal, &part.mid, &part.part, bytes),
                None => view::PartEdit::drop(*ordinal, &part.mid, &part.part),
            };
            anchored.entry(*ordinal).or_default().push(edit);
        }
        for range in ranges {
            let view::ViewRange::Keep { from, to, edits } = range else {
                continue;
            };
            for (_, saved) in anchored.range(*from..*to) {
                for part in saved {
                    // A permitted pass may remove more content, but it must not restore a source
                    // part just because a generation reset discarded its old engine unit.
                    if !edits
                        .iter()
                        .any(|edit| edit.ordinal == part.ordinal && edit.part == part.part)
                    {
                        edits.push(part.clone());
                    }
                }
            }
            edits.sort_by(|a, b| (a.ordinal, &a.part).cmp(&(b.ordinal, &b.part)));
        }
        Ok(())
    }
}

/// Keep publication-time provenance for versions whose engine baselines are
/// retired during a resync before acknowledgement. Native views remain immutable.
#[derive(Default)]
pub(super) struct RetiredViews {
    pub(super) views: BTreeMap<u64, Arc<FrozenEdits>>,
    pub(super) dirty: bool,
}

impl RetiredViews {
    pub(super) fn from_json(json: &str) -> Result<Self, HandlerOutcome> {
        let views: BTreeMap<u64, FrozenEdits> = serde_json::from_str(json).map_err(transient)?;
        Ok(Self {
            views: views
                .into_iter()
                .map(|(n, edits)| (n, Arc::new(edits)))
                .collect(),
            dirty: false,
        })
    }

    pub(super) fn json(&self) -> Result<String, HandlerOutcome> {
        serde_json::to_string(
            &self
                .views
                .iter()
                .map(|(n, edits)| (n, edits.as_ref()))
                .collect::<BTreeMap<_, _>>(),
        )
        .map_err(transient)
    }

    pub(super) fn retain_from(&mut self, floor: u64) {
        let before = self.views.len();
        self.views.retain(|version, _| *version >= floor);
        self.dirty |= self.views.len() != before;
    }
}
