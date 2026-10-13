//! Memory retrieval policy, independent of the storage engine and embedding transport.
//!
//! FTS ranks must come from the original index: rebuilding an index over visible rows
//! changes BM25 document frequencies and can change both candidates and their order.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::compartments::{CompartmentChunk, CompartmentHit};
use crate::parity_contract::{Availability, CapabilityResult, EmbeddingIdentity, StoreScope};

pub const FTS_CANDIDATE_LIMIT: usize = 50;
const SEMANTIC_WEIGHT: f64 = 0.7;
const FTS_WEIGHT: f64 = 0.3;
pub const SINGLE_SOURCE_PENALTY: f64 = 0.8;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct DateBounds {
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
}

impl DateBounds {
    pub fn contains(self, timestamp: i64) -> bool {
        self.from_ms.is_none_or(|from| timestamp >= from)
            && self.to_ms.is_none_or(|to| timestamp <= to)
    }
}

#[derive(Debug, Clone)]
pub struct SearchMemory {
    pub id: i64,
    pub category: String,
    pub content: String,
    pub created_at_ms: i64,
    pub source_name: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MemoryFtsHit {
    pub memory_id: i64,
    /// The index's original BM25 value, in ascending order. Scoring uses rank,
    /// not the magnitude of BM25; retain it so adapters can expose index provenance.
    pub bm25: f64,
}

#[derive(Debug, Clone)]
pub struct MemoryVector {
    pub memory_id: i64,
    pub identity: EmbeddingIdentity,
    pub values: Vec<f32>,
}

/// Store reads use authenticated scope. Memory reads must apply active/permanent,
/// expiry, project aliases and workspace shared-category policy before returning rows.
/// FTS date/scope predicates precede LIMIT, but BM25 uses the full persisted index.
/// Chunk reads preserve the store's chunk order, including equal-score chunks.
pub trait RetrievalInputStore: Send + Sync {
    fn read_search_memories(
        &self,
        scope: &StoreScope,
        dates: DateBounds,
    ) -> CapabilityResult<Vec<SearchMemory>>;
    fn search_memory_fts(
        &self,
        scope: &StoreScope,
        query: &str,
        dates: DateBounds,
        limit: usize,
    ) -> CapabilityResult<Vec<MemoryFtsHit>>;
    fn read_memory_vectors(
        &self,
        scope: &StoreScope,
        memory_ids: &[i64],
        identity: &EmbeddingIdentity,
    ) -> CapabilityResult<Vec<MemoryVector>>;
    fn read_compartment_chunks(
        &self,
        scope: &StoreScope,
        dates: DateBounds,
        identity: &EmbeddingIdentity,
    ) -> CapabilityResult<Vec<CompartmentChunk>>;
    /// IDs actually rendered in the frozen baseline and later deltas, not the
    /// wider set of memories eligible for rendering on the next transform.
    fn read_visible_memory_ids(&self, scope: &StoreScope) -> CapabilityResult<BTreeSet<i64>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchType {
    Fts,
    Semantic,
    Hybrid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryHit {
    pub content: String,
    pub score: f64,
    pub memory_id: i64,
    pub category: String,
    pub match_type: MatchType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum SearchHit {
    Memory(MemoryHit),
    Compartment(CompartmentHit),
}

impl SearchHit {
    pub fn score(&self) -> f64 {
        match self {
            Self::Memory(hit) => hit.score,
            Self::Compartment(hit) => hit.score,
        }
    }
    pub fn reported_score(&self) -> String {
        reported_score(self.score())
    }
    pub fn effective_score(&self) -> f64 {
        self.score()
            * match self {
                Self::Memory(_) => 1.3,
                Self::Compartment(_) => 1.275,
            }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetrievalDiagnostics {
    pub suppressed_visible_memory_ids: Vec<i64>,
    /// An unavailable component is different from a successful read with no rows.
    pub components: BTreeMap<String, Availability>,
}

impl RetrievalDiagnostics {
    pub fn take<T>(&mut self, component: &str, result: CapabilityResult<T>) -> Option<T> {
        self.components
            .insert(component.into(), result.availability());
        match result {
            CapabilityResult::Available { value } | CapabilityResult::Degraded { value, .. } => {
                Some(value)
            }
            CapabilityResult::Unavailable { .. } => None,
        }
    }
}

/// Accumulate in f64, as JavaScript does after reading float32 storage. A zero
/// vector or a nonfinite cosine contributes a defined zero semantic score.
pub fn cosine_score(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0;
    let mut norm_a = 0.0;
    let mut norm_b = 0.0;
    for (&a, &b) in a.iter().zip(b) {
        let (a, b) = (f64::from(a), f64::from(b));
        dot += a * b;
        norm_a += a * a;
        norm_b += b * b;
    }
    let score = dot / (norm_a.sqrt() * norm_b.sqrt());
    if score.is_finite() {
        score.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

pub fn rank_memories(
    memories: &[SearchMemory],
    fts: &[MemoryFtsHit],
    vectors: &[MemoryVector],
    query: Option<(&EmbeddingIdentity, &[f32])>,
    visible: &BTreeSet<i64>,
    dates: DateBounds,
    limit: usize,
) -> (Vec<MemoryHit>, Vec<i64>) {
    let fts_scores: BTreeMap<_, _> = fts
        .iter()
        .take(FTS_CANDIDATE_LIMIT)
        .enumerate()
        .map(|(rank, hit)| (hit.memory_id, 1.0 / (rank + 1) as f64))
        .collect();
    let vectors: BTreeMap<_, _> = vectors.iter().map(|v| (v.memory_id, v)).collect();
    let mut hits = Vec::new();
    let mut suppressed = Vec::new();
    for memory in memories.iter().filter(|m| dates.contains(m.created_at_ms)) {
        let fts_score = fts_scores.get(&memory.id).copied();
        let semantic = query.and_then(|(identity, query)| {
            let vector = vectors.get(&memory.id)?;
            if &vector.identity != identity || vector.values.len() != identity.dimensions as usize {
                return None;
            }
            Some(cosine_score(query, &vector.values))
        });
        let (score, match_type) = match (semantic, fts_score) {
            (Some(semantic), Some(fts)) => (
                SEMANTIC_WEIGHT * semantic + FTS_WEIGHT * fts,
                MatchType::Hybrid,
            ),
            (Some(semantic), None) => (semantic * SINGLE_SOURCE_PENALTY, MatchType::Semantic),
            (None, Some(fts)) => (fts * SINGLE_SOURCE_PENALTY, MatchType::Fts),
            (None, None) => continue,
        };
        if score <= 0.0 {
            continue;
        }
        if visible.contains(&memory.id) {
            suppressed.push(memory.id);
            continue;
        }
        hits.push(MemoryHit {
            content: preview(&memory.content),
            score,
            memory_id: memory.id,
            category: memory.category.clone(),
            match_type,
            source_name: memory.source_name.clone(),
        });
    }
    hits.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(a.memory_id.cmp(&b.memory_id))
    });
    hits.truncate(limit);
    suppressed.sort_unstable();
    (hits, suppressed)
}

pub fn sort_supported_hits(hits: &mut [SearchHit]) {
    // Stable sorting preserves lane order when different sources have equal boosts.
    hits.sort_by(|a, b| {
        b.effective_score()
            .total_cmp(&a.effective_score())
            .then_with(|| match (a, b) {
                (SearchHit::Memory(a), SearchHit::Memory(b)) => a.memory_id.cmp(&b.memory_id),
                (SearchHit::Compartment(a), SearchHit::Compartment(b)) => {
                    a.start_ordinal.cmp(&b.start_ordinal)
                }
                _ => std::cmp::Ordering::Equal,
            })
    });
}

fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn trim_query(text: &str) -> &str {
    text.trim_matches(js_space)
}

pub fn preview(text: &str) -> String {
    let mut normalized = String::new();
    let mut space = false;
    for c in text.chars() {
        if js_space(c) {
            space = !normalized.is_empty();
        } else {
            if space {
                normalized.push(' ');
                space = false;
            }
            normalized.push(c);
        }
    }
    let utf16: Vec<_> = normalized.encode_utf16().collect();
    if utf16.len() <= 220 {
        return normalized;
    }
    format!(
        "{}…",
        String::from_utf16_lossy(&utf16[..219]).trim_end_matches(js_space)
    )
}

/// Round the binary value itself, not a rounded intermediate `score * 100`.
/// This implements fixed-two-decimal reporting with ties rounded upwards;
/// multiplying first would incorrectly render values such as 0.615 as 0.62.
pub fn reported_score(score: f64) -> String {
    assert!(score.is_finite() && (0.0..=1.0).contains(&score));
    let bits = score.to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = (bits & ((1u64 << 52) - 1)) | if exponent == 0 { 0 } else { 1u64 << 52 };
    let shift = 52 + 1023 - exponent.max(1);
    let numerator = u128::from(mantissa) * 100;
    let rounded = if shift >= 128 {
        0
    } else {
        let denominator = 1u128 << shift;
        numerator / denominator + u128::from(numerator % denominator >= denominator / 2)
    };
    format!("{}.{:02}", rounded / 100, rounded % 100)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scores_use_binary_to_fixed_rounding() {
        for (input, expected) in [
            (0.125, "0.13"),
            (0.615, "0.61"),
            (0.145, "0.14"),
            (1.0, "1.00"),
            (0.0, "0.00"),
        ] {
            assert_eq!(reported_score(input), expected);
        }
    }

    #[test]
    fn previews_use_ecmascript_whitespace_and_utf16_lengths() {
        assert_eq!(preview("\u{feff}a \n b\u{feff}"), "a b");
        assert_eq!(preview(&"🙂".repeat(110)), "🙂".repeat(110));
        assert_eq!(cosine_score(&[0.0], &[1.0]), 0.0);
        assert_eq!(cosine_score(&[1.0], &[-1.0]), 0.0);
        assert_eq!(cosine_score(&[f32::NAN], &[1.0]), 0.0);
    }
}
