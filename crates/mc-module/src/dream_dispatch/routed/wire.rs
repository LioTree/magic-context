//! Everything a routed dream run asks of the outside world, behind one trait:
//! Entorhinal's project lookup, the daemon's `scope.sync`, the routing/v1
//! provider and the chosen runner's llm-runner ops on a route under the run's
//! scope. Tests drive the dreamer with a fake; production uses
//! [`ProductionWire`].

use std::path::Path;

use cortexkit_role_routing::{
    errors::{Refusal, RefusalCode},
    report::{ReportAnswer, ReportRequest},
    select::SelectRequest,
};
use serde_json::Value;
use subc_client_rs::async_trait;

use super::scope::{DreamScope, EntorhinalProjectId};
use crate::dream_dispatch::broca_carrier::PortError;
use crate::model_work::RoutingCatalog;

/// A dream run cannot register its project scope with this build. Production
/// answers it until the subc SDK can carry a scope's project and folder.
pub const SCOPE_UNSUPPORTED: &str = "mc_dream_scope_unsupported";

/// A refusal from the scope seam, by name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireRefusal {
    pub code: String,
    pub detail: String,
}

/// The identity a runner run is bound to: the runner module, the harness that
/// runner hosts the session on, and the session name ck-mc minted. The project
/// root of the binding is the run scope's `workdir`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerBind {
    pub module: String,
    pub harness: String,
    pub session: String,
}

#[async_trait]
pub trait DreamWire: Send + Sync {
    /// Whether this build can register a project scope at all. A run takes the
    /// routed path only when it can; the refusal names what is missing.
    fn scope_support(&self) -> Result<(), WireRefusal>;
    /// Entorhinal's project id for exactly this folder, or `None` when it has no
    /// registered answer. Never a derived identity.
    async fn lookup_project(&self, workdir: &Path) -> Option<EntorhinalProjectId>;
    /// Register (or update) `scope` with the daemon, ck-mc as its owner.
    async fn sync_scope(&self, scope: &DreamScope) -> Result<(), WireRefusal>;
    /// End `scope`; nothing more runs under it.
    async fn end_scope(&self, scope: &DreamScope);
    /// The routing/v1 providers in the module catalog right now.
    fn routing_catalog(&self) -> RoutingCatalog;
    /// `route.select` on a route opened under `scope`. Answers the provider's
    /// answer as sent, so members this crate version does not decode (such as a
    /// runner's hosted harness) are still visible to the caller.
    async fn select(
        &self,
        scope: &DreamScope,
        provider: &str,
        request: &SelectRequest,
    ) -> Result<Value, Refusal>;
    /// `route.report` on a route opened under `scope`.
    async fn report(
        &self,
        scope: &DreamScope,
        provider: &str,
        request: &ReportRequest,
    ) -> Result<ReportAnswer, Refusal>;
    /// One llm-runner op on a route to `bind.module` under `scope`, bound to
    /// `bind`'s harness and session with `scope.workdir` as the project root.
    async fn runner_call(
        &self,
        scope: &DreamScope,
        bind: &RunnerBind,
        op: &str,
        params: Value,
    ) -> Result<Value, PortError>;
    /// The next unit of the bound session's `session.subscribe` stream.
    async fn runner_next_unit(
        &self,
        scope: &DreamScope,
        bind: &RunnerBind,
    ) -> Result<Option<Value>, PortError>;
    /// Close the bound session's routes. Never a deletion.
    async fn runner_release(&self, scope: &DreamScope, bind: &RunnerBind);
}

/// The production wire of this build: it cannot register a dream scope.
///
/// ck-mc pins subc-protocol 0.32.8, whose `ScopeRecord` has no `project_id` or
/// `workdir` member (they arrive in subc-protocol 0.32.12), so a project scope
/// carrying them cannot be sent. Rather than register a scope routing and the
/// runners could not attribute, every operation refuses with
/// [`SCOPE_UNSUPPORTED`], and the dreamer keeps its older transports. Replacing
/// this needs the SDK bump, a `ModuleHandle` for `scope.sync`, and live routing
/// catalog discovery.
pub struct ProductionWire;

const UNSUPPORTED_DETAIL: &str = "a dream project scope needs subc-protocol >= 0.32.12 \
    (ScopeRecord.project_id and ScopeRecord.workdir); this build pins subc-protocol 0.32.8";

fn unsupported() -> WireRefusal {
    WireRefusal {
        code: SCOPE_UNSUPPORTED.into(),
        detail: UNSUPPORTED_DETAIL.into(),
    }
}

fn unsupported_refusal() -> Refusal {
    Refusal::new(RefusalCode::InvalidRequest, UNSUPPORTED_DETAIL)
}

fn unsupported_port() -> PortError {
    PortError {
        code: SCOPE_UNSUPPORTED.into(),
        message: UNSUPPORTED_DETAIL.into(),
        detail: Value::Null,
        outcome_unknown: false,
    }
}

#[async_trait]
impl DreamWire for ProductionWire {
    fn scope_support(&self) -> Result<(), WireRefusal> {
        Err(unsupported())
    }
    async fn lookup_project(&self, _: &Path) -> Option<EntorhinalProjectId> {
        None
    }
    async fn sync_scope(&self, _: &DreamScope) -> Result<(), WireRefusal> {
        Err(unsupported())
    }
    async fn end_scope(&self, _: &DreamScope) {}
    fn routing_catalog(&self) -> RoutingCatalog {
        RoutingCatalog {
            generation: 0,
            providers: Vec::new(),
        }
    }
    async fn select(&self, _: &DreamScope, _: &str, _: &SelectRequest) -> Result<Value, Refusal> {
        Err(unsupported_refusal())
    }
    async fn report(
        &self,
        _: &DreamScope,
        _: &str,
        _: &ReportRequest,
    ) -> Result<ReportAnswer, Refusal> {
        Err(unsupported_refusal())
    }
    async fn runner_call(
        &self,
        _: &DreamScope,
        _: &RunnerBind,
        _: &str,
        _: Value,
    ) -> Result<Value, PortError> {
        Err(unsupported_port())
    }
    async fn runner_next_unit(
        &self,
        _: &DreamScope,
        _: &RunnerBind,
    ) -> Result<Option<Value>, PortError> {
        Err(unsupported_port())
    }
    async fn runner_release(&self, _: &DreamScope, _: &RunnerBind) {}
}
