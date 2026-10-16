//! Resident-provider admission before entering Tokio's shared blocking pool.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::Duration,
};
use tokio::sync::{OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};

#[cfg(test)]
thread_local! {
    pub(crate) static LAST_WAIT_MS: std::cell::Cell<f64> = const { std::cell::Cell::new(0.0) };
}

#[cfg(test)]
pub(crate) fn hold_free_long_slots() -> Option<OwnedSemaphorePermit> {
    let slots = long_slots();
    let free = slots.available_permits() as u32;
    (free > 0).then(|| slots.try_acquire_many_owned(free).unwrap())
}

// Leave CPU capacity for hooks: at most one long provider call per four CPUs,
// with one slot on smaller machines. This is process-wide, not per route/session.
fn long_slots() -> Arc<Semaphore> {
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SLOTS
        .get_or_init(|| {
            Arc::new(Semaphore::new(
                (std::thread::available_parallelism().map_or(1, usize::from) / 4).max(1),
            ))
        })
        .clone()
}

// The host's ordinary step budget defaults to 2 s. Bound admission to 500 ms
// rather than letting a busy fleet consume that entire budget before work starts.
const QUEUE_BUDGET: Duration = Duration::from_millis(500);

pub(crate) struct Admission {
    slots: Arc<Semaphore>,
    routes: Mutex<HashMap<(u16, u32), String>>,
    sessions: Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
}

pub(crate) struct Admitted {
    _session: OwnedMutexGuard<()>,
    _long: Option<OwnedSemaphorePermit>,
    #[cfg(test)]
    pub(crate) wait_ms: f64,
}

impl Default for Admission {
    fn default() -> Self {
        Self {
            slots: long_slots(),
            routes: Mutex::default(),
            sessions: Mutex::default(),
        }
    }
}

impl Admission {
    pub(crate) fn bind(&self, request: &subc_client_rs::RouteBindRequest) {
        self.routes.lock().unwrap().insert(
            (request.handle.channel, request.handle.epoch),
            serde_json::to_string(&(
                &request.identity.project_root,
                &request.identity.harness,
                &request.identity.session,
            ))
            .expect("route identity"),
        );
    }

    pub(crate) fn remove(&self, route: &subc_client_rs::RouteHandle) {
        self.routes
            .lock()
            .unwrap()
            .remove(&(route.channel, route.epoch));
    }

    pub(crate) async fn admit(
        &self,
        route: &subc_client_rs::RouteHandle,
        body: &[u8],
    ) -> Result<Option<Admitted>, subc_client_rs::HandlerOutcome> {
        let request: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
        let method = request["method"].as_str().unwrap_or("");
        if method != "transform.hook"
            && method != "transform.declare"
            && !method.starts_with("compaction.")
        {
            return Ok(None);
        }
        let Some(key) = self
            .routes
            .lock()
            .unwrap()
            .get(&(route.channel, route.epoch))
            .cloned()
        else {
            return Err(crate::providers::transient(
                "provider admission requires a bound route; retry",
            ));
        };
        self.acquire(key, method).await.map(Some)
    }

    async fn acquire(
        &self,
        key: String,
        method: &str,
    ) -> Result<Admitted, subc_client_rs::HandlerOutcome> {
        #[cfg(test)]
        let started = std::time::Instant::now();
        let session = {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.retain(|_, lock| lock.strong_count() > 0);
            if let Some(lock) = sessions.get(&key).and_then(Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(tokio::sync::Mutex::new(()));
                sessions.insert(key, Arc::downgrade(&lock));
                lock
            }
        };
        // Acquire the FIFO session lock before the long-call slot. A later hook
        // cannot overtake its own queued fold, but other sessions bypass that queue.
        let deadline = tokio::time::Instant::now() + QUEUE_BUDGET;
        let session = if method == "transform.hook" {
            session.lock_owned().await
        } else {
            tokio::time::timeout_at(deadline, session.lock_owned())
                .await
                .map_err(|_| {
                    crate::providers::transient("provider admission busy; retry the step")
                })?
        };
        let long = if method == "transform.hook" {
            None
        } else {
            Some(
                tokio::time::timeout_at(deadline, self.slots.clone().acquire_owned())
                    .await
                    .map_err(|_| {
                        crate::providers::transient("provider admission busy; retry the step")
                    })?
                    .expect("provider admission semaphore remains open"),
            )
        };
        Ok(Admitted {
            _session: session,
            _long: long,
            #[cfg(test)]
            wait_ms: started.elapsed().as_secs_f64() * 1000.0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn admission() -> Admission {
        Admission {
            slots: Arc::new(Semaphore::new(1)),
            routes: Mutex::default(),
            sessions: Mutex::default(),
        }
    }

    #[tokio::test]
    async fn hook_bypasses_full_fold_pool_but_same_session_is_fifo() {
        let admission = admission();
        let fold = admission
            .acquire("B".into(), "compaction.step")
            .await
            .unwrap();
        let other = tokio::time::timeout(
            Duration::from_secs(1),
            admission.acquire("A".into(), "transform.hook"),
        )
        .await
        .unwrap()
        .unwrap();
        drop(other);
        let mut first = Box::pin(admission.acquire("B".into(), "transform.hook"));
        let mut second = Box::pin(admission.acquire("B".into(), "compaction.step"));
        assert!(tokio::time::timeout(Duration::from_millis(10), &mut first)
            .await
            .is_err());
        assert!(tokio::time::timeout(Duration::from_millis(10), &mut second)
            .await
            .is_err());
        drop(fold);
        let first = first.await.unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(10), &mut second)
            .await
            .is_err());
        drop(first);
        second.await.unwrap();
    }

    #[tokio::test]
    async fn long_queue_refuses_retryably_before_host_step_budget() {
        let admission = admission();
        let _fold = admission
            .acquire("B".into(), "compaction.step")
            .await
            .unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            admission.acquire("A".into(), "compaction.step"),
        )
        .await
        .unwrap();
        assert!(
            matches!(result, Err(subc_client_rs::HandlerOutcome::Error { ref code, .. }) if code == "transient")
        );
    }
}
