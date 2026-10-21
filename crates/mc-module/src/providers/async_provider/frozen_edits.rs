//! Native edits already acknowledged by the runner, independent of engine cache eviction.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
struct FrozenPart {
    mid: String,
    part: String,
    digest: String,
    bytes: Option<String>,
}

#[derive(Default)]
pub(super) struct FrozenEdits {
    parts: BTreeMap<(String, String), FrozenPart>,
    pub(super) dirty: bool,
}

impl FrozenEdits {
    pub(super) fn from_json(json: &str) -> Result<Self, HandlerOutcome> {
        let parts: Vec<FrozenPart> = serde_json::from_str(json).map_err(transient)?;
        Ok(Self {
            parts: parts
                .into_iter()
                .map(|part| ((part.mid.clone(), part.part.clone()), part))
                .collect(),
            dirty: false,
        })
    }

    pub(super) fn json(&self) -> Result<String, HandlerOutcome> {
        serde_json::to_string(&self.parts.values().collect::<Vec<_>>()).map_err(transient)
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
                let Some(index) = entry.tags.iter().position(|row| row.part == edit.part) else {
                    continue;
                };
                let native = parts(&entry.message)?;
                let Some(part) = native.get(index) else {
                    continue;
                };
                self.parts.insert(
                    (edit.mid.clone(), edit.part.clone()),
                    FrozenPart {
                        mid: edit.mid.clone(),
                        part: edit.part.clone(),
                        digest: contract::digest::content_digest(part),
                        bytes: edit.bytes.clone(),
                    },
                );
                self.dirty = true;
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
            let Some(index) = entry.tags.iter().position(|row| row.part == part.part) else {
                continue;
            };
            let native = parts(&entry.message)?;
            if native
                .get(index)
                .is_none_or(|source| contract::digest::content_digest(source) != part.digest)
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
