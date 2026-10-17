//! Keep synchronous store and encoding work off the module's control-plane runtime.

use crate::{
    reply_pages::{accepts_reply_pages, ReplyPages},
    McHandler,
};
use std::{
    sync::{Arc, Mutex},
    time::SystemTime,
};
use subc_client_rs::{
    async_trait, ConnectionEnd, HandlerOutcome, HealthReport, ModuleHandler, RequestCtx,
    RouteBindRequest, RouteCloseReason, RouteHandle,
};
use subc_protocol::ModuleHelloAckBody;

/// Production SDK adapter: dispatch runs on the blocking pool; health and route
/// lifecycle hooks remain on the control-plane runtime.
pub struct McTransportHandler<H: ModuleHandler = McHandler> {
    inner: Arc<H>,
    replies: Arc<Mutex<ReplyPages>>,
    admission: Option<Arc<crate::transport_admission::Admission>>,
}

impl<H: ModuleHandler> McTransportHandler<H> {
    /// Production adapters always carry the admission layer that orders the
    /// resident step engine's requests per route.
    pub fn new(inner: H) -> Self {
        Self {
            inner: Arc::new(inner),
            replies: Arc::new(Mutex::new(ReplyPages::default())),
            admission: Some(Arc::new(crate::transport_admission::Admission::default())),
        }
    }

    /// Test builds only: `false` removes the admission layer so differentials
    /// can run the non-resident step oracle on its original dispatch path.
    #[cfg(test)]
    pub fn with_resident_admission(mut self, enabled: bool) -> Self {
        self.admission =
            enabled.then(|| Arc::new(crate::transport_admission::Admission::default()));
        self
    }

    async fn remove_reply_channel(&self, channel: u16) {
        let replies = Arc::clone(&self.replies);
        let _ = tokio::task::spawn_blocking(move || {
            replies
                .lock()
                .expect("reply pages mutex")
                .remove_channel(channel);
        })
        .await;
    }
}

#[async_trait]
impl<H: ModuleHandler> ModuleHandler for McTransportHandler<H> {
    async fn on_hello_ack(&self, ack: &ModuleHelloAckBody) {
        self.inner.on_hello_ack(ack).await;
    }
    async fn on_bind(&self, req: &RouteBindRequest) -> subc_client_rs::BindDecision {
        self.remove_reply_channel(req.handle.channel).await;
        if let Some(admission) = &self.admission {
            admission.bind(req);
        }
        self.inner.on_bind(req).await
    }
    async fn on_route_gone(&self, handle: &RouteHandle) {
        if let Some(admission) = &self.admission {
            admission.remove(handle);
        }
        self.remove_reply_channel(handle.channel).await;
        self.inner.on_route_gone(handle).await;
    }
    async fn on_bound(&self, handle: &RouteHandle) {
        self.inner.on_bound(handle).await;
    }
    async fn on_draining(&self, reason: RouteCloseReason, deadline: SystemTime) {
        self.inner.on_draining(reason, deadline).await;
    }
    async fn on_connection_end(&self, end: ConnectionEnd) {
        self.inner.on_connection_end(end).await;
    }
    async fn health(&self) -> HealthReport {
        self.inner.health().await
    }
    async fn handle(&self, ctx: RequestCtx, body: Vec<u8>) -> HandlerOutcome {
        let inner = Arc::clone(&self.inner);
        let replies = Arc::clone(&self.replies);
        let runtime = tokio::runtime::Handle::current();
        let route = ctx.route_handle();
        let channel = (route.channel, route.epoch);
        let admitted = if let Some(admission) = &self.admission {
            match admission.admit(&route, &body).await {
                Ok(admitted) => admitted,
                Err(refusal) => return refusal,
            }
        } else {
            None
        };
        match tokio::task::spawn_blocking(move || {
            #[cfg(test)]
            crate::transport_admission::LAST_WAIT_MS
                .with(|last| last.set(admitted.as_ref().map_or(0.0, |a| a.wait_ms)));
            // Keep ownership through cancellation: dropping the response future
            // must not release ordering or CPU slots while its worker still runs.
            let _admitted = admitted;
            if let Ok(request) =
                serde_json::from_slice::<serde_json::Value>(if body.len() <= 1024 {
                    &body
                } else {
                    b"null"
                })
            {
                if request.get("method").and_then(|v| v.as_str()) == Some("reply.page") {
                    if let (Some(id), Some(index)) = (
                        request.get("reply_page_id").and_then(|v| v.as_str()),
                        request
                            .get("reply_page_index")
                            .and_then(|v| v.as_u64())
                            .and_then(|n| usize::try_from(n).ok()),
                    ) {
                        return replies
                            .lock()
                            .expect("reply pages mutex")
                            .page(channel, id, index);
                    }
                    return HandlerOutcome::Error {
                        code: "bad_request".into(),
                        message: "invalid reply page request".into(),
                    };
                }
            }
            // The current-thread runtime must keep reading control frames while a
            // transform synchronously projects history, accesses SQLite and encodes JSON.
            let accept_reply_pages = accepts_reply_pages(&body);
            let outcome = runtime.block_on(inner.handle(ctx, body));
            replies
                .lock()
                .expect("reply pages mutex")
                .bound(channel, outcome, accept_reply_pages)
        })
        .await
        {
            Ok(outcome) => outcome,
            Err(error) => HandlerOutcome::Error {
                code: "dispatch_failed".into(),
                message: error.to_string(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_adapter_always_has_admission_layer() {
        let adapter = McTransportHandler::new(McHandler::new());
        assert!(adapter.admission.is_some());
    }

    #[test]
    fn disabled_resident_adapter_has_no_admission_layer() {
        let adapter = McTransportHandler::new(McHandler::new()).with_resident_admission(false);
        assert!(adapter.admission.is_none());
    }
}
