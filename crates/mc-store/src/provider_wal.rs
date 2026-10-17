//! Resident providers move routine WAL checkpoint I/O off the serving connection.
//! The default store policy is unchanged until an authorized provider opts in.
use crate::{single_store_domain, McStore, McStoreError};
use cortexkit_store::SqliteStore;
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::{mpsc, Mutex};
use std::thread::JoinHandle;

const SOFT_BYTES: u64 = 4 * 1024 * 1024;
const HARD_BYTES: u64 = 64 * 1024 * 1024;
const WARNING_BYTES: u64 = 256 * 1024 * 1024;

fn prime_tx(conn: &rusqlite::Transaction<'_>) -> rusqlite::Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    conn.pragma_update(None, "user_version", version)
}

fn wal_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push("-wal");
    name.into()
}
fn wal_bytes(path: &Path) -> u64 {
    std::fs::metadata(wal_path(path)).map_or(0, |meta| meta.len())
}

fn hard_frame_limit(conn: &Connection) -> rusqlite::Result<u64> {
    let page_size: u64 = conn.pragma_query_value(None, "page_size", |row| row.get(0))?;
    // Include SQLite's 32-byte WAL header and 24-byte frame headers in the bound.
    Ok(((HARD_BYTES - 32) / (page_size + 24)).max(1))
}

fn configure_shared_writer(conn: &Connection) -> rusqlite::Result<()> {
    // All harnesses, historian and tag writers share this connection. Keep
    // SQLite's non-waiting PASSIVE commit hook as the hard-limit backstop even
    // when no resident request is available to notify the maintenance thread.
    conn.pragma_update(None, "wal_autocheckpoint", hard_frame_limit(conn)?)?;
    // A completed PASSIVE checkpoint rewinds on the next write. Keep a small
    // reusable allocation below the notification threshold, not the old high
    // water size. This avoids false size triggers without reallocating each WAL.
    conn.pragma_update(None, "journal_size_limit", SOFT_BYTES / 2)
}

#[derive(Default)]
struct Episodes {
    hard: bool,
    pinned: bool,
    warning: bool,
}

pub(crate) struct ProviderWal {
    path: PathBuf,
    pending: Option<mpsc::SyncSender<Option<mpsc::Sender<()>>>>,
    worker: Option<JoinHandle<()>>,
    episodes: Mutex<Episodes>,
    #[cfg(any(test, feature = "test-support"))]
    stalled: Arc<std::sync::atomic::AtomicBool>,
    #[cfg(any(test, feature = "test-support"))]
    checkpoint: Arc<Mutex<Option<(i64, i64, i64)>>>,
    #[cfg(any(test, feature = "test-support"))]
    prime_enabled: Arc<std::sync::atomic::AtomicBool>,
}

fn passive(conn: &Connection) -> rusqlite::Result<(i64, i64, i64)> {
    conn.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    })
}

impl ProviderWal {
    fn start(path: &Path, writer: Arc<SqliteStore>) -> Result<Self, McStoreError> {
        // The worker owns the fenced writer, not McStore, so joining it during
        // McStore teardown cannot create an ownership cycle.
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(single_store_domain::context_sql_error)?;
        conn.busy_timeout(std::time::Duration::ZERO)
            .map_err(single_store_domain::context_sql_error)?;
        single_store_domain::set_wal_synchronous_normal(&conn)
            .map_err(single_store_domain::context_sql_error)?;
        conn.pragma_update(None, "wal_autocheckpoint", 0)
            .map_err(single_store_domain::context_sql_error)?;
        let (sender, receiver) = mpsc::sync_channel::<Option<mpsc::Sender<()>>>(1);
        let worker_path = path.to_owned();
        #[cfg(any(test, feature = "test-support"))]
        let stalled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        #[cfg(any(test, feature = "test-support"))]
        let worker_stalled = stalled.clone();
        #[cfg(any(test, feature = "test-support"))]
        let checkpoint = Arc::new(Mutex::new(None));
        #[cfg(any(test, feature = "test-support"))]
        let worker_checkpoint = checkpoint.clone();
        #[cfg(any(test, feature = "test-support"))]
        let prime_enabled = Arc::new(std::sync::atomic::AtomicBool::new(true));
        #[cfg(any(test, feature = "test-support"))]
        let worker_prime_enabled = prime_enabled.clone();
        let worker = std::thread::Builder::new()
            .name("mc-provider-wal".into())
            .spawn(move || {
                while let Ok(acknowledge) = receiver.recv() {
                    let checkpoint = || {
                        #[cfg(any(test, feature = "test-support"))]
                        if worker_stalled.load(std::sync::atomic::Ordering::Acquire) {
                            return;
                        }
                        if wal_bytes(&worker_path) < SOFT_BYTES {
                            return;
                        }
                        match passive(&conn) {
                            Ok((busy, frames, copied)) => {
                                #[cfg(any(test, feature = "test-support"))]
                                { *worker_checkpoint.lock().unwrap() = Some((busy, frames, copied)); }
                                tracing::debug!(
                                    busy,
                                    frames,
                                    copied,
                                    "provider WAL maintenance checkpoint"
                                );
                                // Only maintenance runs the TRUNCATE checkpoint mode.
                                // The writer may resize an already rewound file to its
                                // journal_size_limit. A racing reader/writer makes this
                                // explicit checkpoint return BUSY without waiting.
                                if busy == 0
                                    && frames == copied
                                    && wal_bytes(&worker_path) >= HARD_BYTES
                                {
                                    let _ = conn.query_row(
                                        "PRAGMA wal_checkpoint(TRUNCATE)",
                                        [],
                                        |row| row.get::<_, i64>(0),
                                    );
                                }
                                #[cfg(any(test, feature = "test-support"))]
                                if !worker_prime_enabled.load(std::sync::atomic::Ordering::Acquire) { return; }
                                if busy == 0 && frames > 0 && frames == copied {
                                    // Restart the drained log on this dedicated OS thread,
                                    // never a Tokio serving worker. Acquiring the fenced
                                    // writer can wait for an in-flight request; a request
                                    // arriving during this prime can still wait for its
                                    // header fsync. Attempt once, never retry on failure.
                                    let result = writer.with_conn_fenced(prime_tx);
                                    if let Err(error) = result {
                                        tracing::debug!(%error, "provider WAL post-checkpoint prime skipped");
                                    }
                                }
                            }
                            Err(error) => {
                                tracing::warn!(%error, "provider WAL maintenance checkpoint failed")
                            }
                        }
                    };
                    checkpoint();
                    if let Some(acknowledge) = acknowledge {
                        let _ = acknowledge.send(());
                    }
                }
            })
            .map_err(|error| {
                McStoreError::Serde(format!("provider WAL worker unavailable: {error}"))
            })?;
        Ok(Self {
            path: path.to_owned(),
            pending: Some(sender),
            worker: Some(worker),
            episodes: Mutex::new(Episodes::default()),
            #[cfg(any(test, feature = "test-support"))]
            stalled,
            #[cfg(any(test, feature = "test-support"))]
            checkpoint,
            #[cfg(any(test, feature = "test-support"))]
            prime_enabled,
        })
    }

    fn before_call(&self, store: &McStore) {
        let bytes = wal_bytes(&self.path);
        let mut episodes = self.episodes.lock().expect("WAL episodes");
        if bytes < HARD_BYTES {
            *episodes = Episodes::default();
            return;
        }
        if !episodes.hard {
            tracing::warn!(
                wal_bytes = bytes,
                hard_limit_bytes = HARD_BYTES,
                "provider WAL synchronous PASSIVE fallback"
            );
            episodes.hard = true;
        }
        // PASSIVE does not invoke a busy handler or wait for external readers or
        // writers. A stalled worker with no pinned reader can rewind after this.
        match store.inner.with_conn(passive) {
            Ok((busy, frames, copied)) => {
                let pinned = busy != 0 || copied < frames;
                if pinned && !episodes.pinned {
                    tracing::warn!(
                        busy,
                        frames,
                        copied,
                        wal_bytes = bytes,
                        reader = "external SQLite reader or writer; process identity unavailable",
                        "provider WAL pinned; serving remains available"
                    );
                }
                episodes.pinned = pinned;
            }
            Err(error) => tracing::warn!(%error, "provider WAL fallback checkpoint failed"),
        }
        if bytes >= WARNING_BYTES && !episodes.warning {
            tracing::warn!(
                wal_bytes = bytes,
                warning_limit_bytes = WARNING_BYTES,
                "provider WAL exceeds pinned-reader warning limit"
            );
            episodes.warning = true;
        }
    }

    fn after_call(&self) {
        if wal_bytes(&self.path) >= SOFT_BYTES {
            // One outstanding notification per store; no unbounded task queue.
            if let Some(sender) = &self.pending {
                let _ = sender.try_send(None);
            }
        }
    }
}

impl Drop for ProviderWal {
    fn drop(&mut self) {
        self.pending.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl McStore {
    /// Pay WAL's first-header sync on the startup worker, before publishing the
    /// serving store. NORMAL still syncs a fresh WAL header on its first commit.
    /// Rewriting the unchanged user version dirties page one without changing
    /// application rows, the schema or the sync policy. The usual fenced writer
    /// still checks the lease epoch and commits this write.
    pub fn prime_wal_for_serving(&self) -> Result<(), McStoreError> {
        let wal = self.inner.with_conn(|conn| {
            conn.pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
        })?;
        if wal.eq_ignore_ascii_case("wal") {
            self.inner.with_conn_fenced(prime_tx)?;
        }
        Ok(())
    }

    /// Called by ck-mc's resident step engine after validating the session/harness
    /// route and plan.
    /// Failure retains SQLite's ordinary autocheckpoint policy rather than refusing.
    pub fn prepare_provider_wal(&self) {
        let mut state = self.provider_wal.lock().expect("provider WAL state");
        if state.is_none() {
            let Some(path) = &self.move_path else {
                return;
            };
            let opened = ProviderWal::start(path, Arc::clone(&self.inner)).and_then(|worker| {
                self.inner.with_conn(configure_shared_writer)?;
                Ok(worker)
            });
            match opened {
                Ok(worker) => *state = Some(worker),
                Err(error) => {
                    tracing::warn!(%error, "provider WAL maintenance unavailable; keeping autocheckpoint");
                    return;
                }
            }
        }
        state.as_ref().unwrap().before_call(self);
    }

    pub fn finish_provider_wal(&self) {
        if let Some(state) = self
            .provider_wal
            .lock()
            .expect("provider WAL state")
            .as_ref()
        {
            state.after_call();
        }
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn stall_provider_wal_for_test(&self, stalled: bool) {
        if let Some(state) = self
            .provider_wal
            .lock()
            .expect("provider WAL state")
            .as_ref()
        {
            state
                .stalled
                .store(stalled, std::sync::atomic::Ordering::Release);
        }
    }
}

#[cfg(test)]
#[path = "provider_wal_tests.rs"]
mod tests;

#[cfg(any(test, feature = "test-support"))]
impl McStore {
    pub fn set_provider_wal_prime_for_test(&self, enabled: bool) {
        self.provider_wal
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .prime_enabled
            .store(enabled, std::sync::atomic::Ordering::Release);
    }

    pub fn provider_wal_checkpoint_for_test(&self) -> Option<(i64, i64, i64)> {
        let state = self.provider_wal.lock().unwrap();
        let checkpoint = *state.as_ref().unwrap().checkpoint.lock().unwrap();
        checkpoint
    }

    pub fn flush_provider_wal_for_test(&self) {
        let state = self.provider_wal.lock().expect("provider WAL state");
        let state = state.as_ref().expect("provider WAL enabled");
        let (sender, receiver) = mpsc::channel();
        state.pending.as_ref().unwrap().send(Some(sender)).unwrap();
        receiver
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("checkpoint worker completes");
    }
}
