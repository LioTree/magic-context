//! The project scope a dream run registers for itself, and the names it mints.
//!
//! A dream run belongs to a project, not to any conversation, so ck-mc
//! registers its own scope for each run with the daemon (`scope.sync`, owner =
//! ck-mc) and selects and sends under it. The rules that scope keeps are the
//! ones the daemon, the runners and routing agreed on:
//!
//! - kind `Ephemeral`, a fresh ref per run and epoch 1;
//! - `project_id` is only ever Entorhinal's answer for that exact folder, never
//!   derived from a path, a git remote or the store's own project key
//!   ([`EntorhinalProjectId`] can only be made from a lookup answer);
//! - `workdir` is the folder the run works in;
//! - no `parent`, and no attributes: a dreamer acts for no agent, so neither
//!   `agent_id` nor `delegates` is set;
//! - when the run calls tools, the chosen runner's principal is listed in
//!   `carriers`, allowed to open routes only to the tool modules the run needs.

use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use subc_protocol::scope::{ScopeCarrier, ScopeKind, ScopeRecord};
use subc_protocol::Principal;

/// Every routed dream session id starts with this prefix, then
/// `<project_id>:<run>`. Like the older `mc-dream-` prefix, it keeps a route
/// bound to such a session away from the foreground memory facade.
pub const SESSION_PREFIX: &str = "mc-dream:";
/// The ref prefix of a dream run's scope.
pub const SCOPE_REF_PREFIX: &str = "mc-dream-run:";
/// The epoch every dream scope is registered at: each run has a fresh ref, so
/// no ref is ever reused for a second session.
pub const SCOPE_EPOCH: u64 = 1;

/// A project id as Entorhinal answered it for one folder.
///
/// The only constructor takes a lookup answer, so code that has a path or a
/// store key in hand cannot turn it into a scope's project id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntorhinalProjectId(String);

impl EntorhinalProjectId {
    /// Accept Entorhinal's answer for a folder. `None` unless it is a registered
    /// `pj-` id.
    pub fn from_lookup_answer(answer: &str) -> Option<Self> {
        crate::project_identity::is_project_pin(answer).then(|| Self(answer.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// 32 lowercase hex characters, fresh for each call. The standard library's
/// `RandomState` is seeded from the operating system once per process and
/// re-keyed for every instance; mixing in a counter, the clock and the process
/// id keeps ids distinct even across processes started in the same instant.
/// Unlike reading `/dev/urandom`, this also works on Windows.
pub(crate) fn fresh_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let half = || {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(sequence);
        hasher.write_u128(nanos);
        hasher.write_u32(std::process::id());
        hasher.finish()
    };
    format!("{:016x}{:016x}", half(), half())
}

/// The child session one runner run binds: `mc-dream:<project_id>:<run>`, with
/// a fresh run id every time. A runner keys sessions by their name within its
/// harness, so a name reused for a second run (for example a fixed name per
/// task) would land in the earlier run's session.
pub fn session_name(project_id: &EntorhinalProjectId) -> String {
    format!("{SESSION_PREFIX}{}:{}", project_id.as_str(), fresh_id())
}

/// One dream run's scope as ck-mc registers it.
///
/// `record` holds the members the pinned subc protocol already defines. The
/// project id and folder are kept beside it: the pinned `ScopeRecord` has no
/// `project_id` or `workdir` member yet (see `wire::ProductionWire`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DreamScope {
    pub record: ScopeRecord,
    pub project_id: EntorhinalProjectId,
    pub workdir: PathBuf,
}

impl DreamScope {
    /// A fresh scope for one run of a project, in `workdir`.
    pub fn new(project_id: EntorhinalProjectId, workdir: &Path) -> Self {
        Self {
            record: ScopeRecord::new(
                format!("{SCOPE_REF_PREFIX}{}", fresh_id()),
                SCOPE_EPOCH,
                ScopeKind::Ephemeral,
            ),
            project_id,
            workdir: workdir.to_path_buf(),
        }
    }

    pub fn scope_ref(&self) -> &str {
        &self.record.scope_ref
    }

    /// Let `runner_module` open routes under this scope, only to `tool_modules`.
    /// Replaces any earlier carrier: after a re-select, the runner that was
    /// dropped loses its authority under the scope. With no tool modules the
    /// run calls no tools and no carrier is listed.
    pub fn carry_for(&mut self, runner_module: &str, tool_modules: Vec<String>) {
        let carriers = if tool_modules.is_empty() {
            Vec::new()
        } else {
            vec![ScopeCarrier::new(Principal::Reserved {
                module_id: runner_module.to_owned(),
            })
            .with_targets(Some(tool_modules))]
        };
        self.record = self.record.clone().with_carriers(carriers);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_registered_entorhinal_answer_is_a_project_id() {
        assert!(EntorhinalProjectId::from_lookup_answer("pj-abc_1").is_some());
        for derived in [
            "git:abc",
            "dir:/work/p",
            "/work/p",
            "",
            "pj-",
            "pj-implicit1-x",
        ] {
            assert_eq!(
                EntorhinalProjectId::from_lookup_answer(derived),
                None,
                "{derived}"
            );
        }
    }

    #[test]
    fn session_names_are_fresh_and_carry_the_project() {
        let project = EntorhinalProjectId::from_lookup_answer("pj-one").unwrap();
        let first = session_name(&project);
        let second = session_name(&project);
        assert_ne!(first, second);
        assert!(first.starts_with("mc-dream:pj-one:"), "{first}");
        assert_eq!(first.len(), "mc-dream:pj-one:".len() + 32);
    }
}
