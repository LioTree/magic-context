//! Prevent concurrent Rust and TypeScript dream tasks from writing the same domain
//! by sharing lease rows in context.db's existing dream_state table.

/// Identifies one holder of a dream-task conflict domain. This does not grant
/// compartment publication rights. Writers check holder and generation inside
/// their write transaction so a successor's lease cannot authorize stale effects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DreamDomainLease {
    pub key: String,
    pub holder: String,
    pub generation: u64,
    pub expires_at_ms: i64,
}
