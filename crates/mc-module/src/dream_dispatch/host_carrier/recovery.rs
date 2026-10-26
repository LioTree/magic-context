//! Persistent restart quarantine for process-owned dream claims.

use super::{error, secret};
use crate::dream_runner::CarrierError;
use mc_store::dream_domain::DreamDomainTiming;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// Allow in-flight host shutdown and clock/transport jitter after the bounded
/// child deadline. This is not a lease extension or permission for stale effects.
pub const RESTART_GRACE_MS: i64 = 5_000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Marker {
    version: u32,
    pub epoch: String,
    pub entry_id: String,
    child_id: String,
    invocation: String,
    deadline_ms: i64,
    task_deadline_ms: i64,
    lease_renewal_ms: i64,
    lease_expiry_ms: i64,
    recovery: Option<Horizon>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Horizon {
    renewal_bound_ms: i64,
    retire_at_ms: i64,
}

impl Marker {
    pub fn new(
        epoch: &str,
        entry_id: &str,
        child_id: &str,
        invocation: &str,
        deadline_ms: i64,
        task_deadline_ms: i64,
        timing: &DreamDomainTiming,
    ) -> Self {
        Self {
            version: 1,
            epoch: epoch.into(),
            entry_id: entry_id.into(),
            child_id: child_id.into(),
            invocation: invocation.into(),
            deadline_ms,
            task_deadline_ms,
            lease_renewal_ms: timing.renewed_at_ms,
            lease_expiry_ms: timing.expires_at_ms,
            recovery: None,
        }
    }

    fn validate(&self) -> bool {
        self.version == 1
            && !self.epoch.is_empty()
            && !self.entry_id.is_empty()
            && !self.child_id.is_empty()
            && !self.invocation.is_empty()
            && self.lease_renewal_ms >= 0
            && self.deadline_ms >= self.lease_renewal_ms
            && self.task_deadline_ms >= self.deadline_ms
            && self.lease_expiry_ms >= self.lease_renewal_ms
            && self.recovery.as_ref().is_none_or(|h| {
                h.renewal_bound_ms >= self.lease_renewal_ms
                    && self
                        .deadline_ms
                        .max(h.renewal_bound_ms)
                        .checked_add(RESTART_GRACE_MS)
                        == Some(h.retire_at_ms)
            })
    }
}

fn read_bounded(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(16 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 16 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "oversized_marker",
        ));
    }
    Ok(bytes)
}

fn private_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn sync_directory(root: &Path) -> Result<(), CarrierError> {
    mc_store::private_permissions::sync_directory(root).map_err(|e| error(e.to_string()))
}

fn persist(path: &Path, marker: &Marker, replacing: bool) -> Result<(), CarrierError> {
    let root = path
        .parent()
        .ok_or_else(|| error("marker_parent_missing"))?;
    let target = if replacing {
        root.join(format!("{}.tmp", secret()?))
    } else {
        path.into()
    };
    let result = (|| {
        let mut file = private_file(&target).map_err(|e| error(e.to_string()))?;
        file.write_all(&serde_json::to_vec(marker).map_err(|e| error(e.to_string()))?)
            .and_then(|()| file.sync_all())
            .map_err(|e| error(e.to_string()))?;
        if replacing {
            fs::rename(&target, path).map_err(|e| error(e.to_string()))?;
        }
        sync_directory(root)
    })();
    if replacing && result.is_err() {
        let _ = fs::remove_file(target);
    }
    result
}

/// A stable per-domain lock serializes marker replacement across coordinators.
/// Locking the replaceable marker inode itself would let a waiter unlink a successor.
#[cfg(unix)]
fn lock(root: &Path, key: &str) -> Result<nix::fcntl::Flock<File>, CarrierError> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(root.join(format!("{key}.lock")))
        .map_err(|e| error(e.to_string()))?;
    nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock)
        .map_err(|(_, e)| error(format!("unavailable: recovery_lock: {e}")))
}

#[cfg(windows)]
fn lock(root: &Path, key: &str) -> Result<File, CarrierError> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(format!("{key}.lock")))
        .map_err(|e| error(e.to_string()))?;
    file.try_lock()
        .map_err(|e| error(format!("unavailable: recovery_lock: {e}")))?;
    Ok(file)
}

#[cfg(not(any(unix, windows)))]
fn lock(_root: &Path, _key: &str) -> Result<File, CarrierError> {
    Err(error("unavailable: recovery_lock_unsupported"))
}

/// Reserve a new marker, or freeze and enforce the old marker's finite horizon.
/// The caller holds its queue mutex until stale local records have also been revoked.
pub(super) fn reserve(
    root: &Path,
    key: &str,
    new: &Marker,
    now: i64,
    timing: Option<&DreamDomainTiming>,
) -> Result<(PathBuf, Option<String>), CarrierError> {
    fs::create_dir_all(root).map_err(|e| error(e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))
            .map_err(|e| error(e.to_string()))?;
    }
    let _lock = lock(root, key)?;
    let path = root.join(format!("{key}.active"));
    let mut retired = None;
    match read_bounded(&path) {
        Ok(bytes) => {
            let mut old = match serde_json::from_slice::<Marker>(&bytes) {
                Ok(marker) if marker.validate() => marker,
                _ => return unknown(&path, "corrupt_marker"),
            };
            if old.recovery.is_none() {
                // The row timestamps the latest lease acquisition or renewal. If a
                // new holder acquired it, the old lease could not renew after that
                // timestamp. Release deletes the row; DomainControl refuses renewal
                // past the task deadline, which bounds missing renewal history.
                let renewal_bound_ms = timing
                    .map_or(old.task_deadline_ms.max(old.lease_expiry_ms), |t| {
                        t.renewed_at_ms
                    })
                    .max(old.lease_renewal_ms);
                let retire_at_ms = old
                    .deadline_ms
                    .max(renewal_bound_ms)
                    .checked_add(RESTART_GRACE_MS)
                    .ok_or_else(|| error("unavailable: deadline_unknown"))?;
                old.recovery = Some(Horizon {
                    renewal_bound_ms,
                    retire_at_ms,
                });
                // Sync the first observed horizon once. Neither later renewals nor
                // another restart may push this old child's quarantine further out.
                persist(&path, &old, true)?;
            }
            let horizon = old
                .recovery
                .as_ref()
                .ok_or_else(|| error("unavailable: deadline_unknown"))?;
            if now < horizon.retire_at_ms {
                return Err(error(format!(
                    "unavailable: dream_restart_quarantine_until:{}",
                    horizon.retire_at_ms
                )));
            }
            fs::remove_file(&path).map_err(|e| error(e.to_string()))?;
            sync_directory(root)?;
            tracing::warn!(event = "dream_child_restart_retired", entry_id = %old.entry_id,
                marker = %path.display(), renewal_bound_ms = horizon.renewal_bound_ms,
                deadline_ms = old.deadline_ms, retire_at_ms = horizon.retire_at_ms,
                grace_ms = RESTART_GRACE_MS, "retired expired dream attempt after restart quarantine");
            retired = Some(old.entry_id);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return unknown(&path, &e.to_string()),
    }
    persist(&path, new, false)?;
    Ok((path, retired))
}

fn unknown<T>(path: &Path, reason: &str) -> Result<T, CarrierError> {
    tracing::error!(event = "dream_child_restart_deadline_unknown", marker = %path.display(),
        reason, "dream domain unavailable because its prior deadline cannot be established");
    Err(error("unavailable: deadline_unknown"))
}

/// A late cleanup from another coordinator may acknowledge its own retirement,
/// but must never unlink the marker that now belongs to a replacement attempt.
pub(super) fn release(path: &Path, entry_id: &str, epoch: &str) -> Result<(), CarrierError> {
    let root = path
        .parent()
        .ok_or_else(|| error("marker_parent_missing"))?;
    let key = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| error("marker_key_missing"))?;
    let _lock = lock(root, key)?;
    let bytes = match read_bounded(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return unknown(path, &e.to_string()),
    };
    let marker = match serde_json::from_slice::<Marker>(&bytes) {
        Ok(marker) if marker.validate() => marker,
        _ => return unknown(path, "corrupt_marker"),
    };
    if marker.entry_id == entry_id && marker.epoch == epoch {
        fs::remove_file(path).map_err(|e| error(e.to_string()))?;
        sync_directory(root)?;
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn marker_persist_round_trips_and_replaces_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("marker.json");
        let mut marker = Marker {
            version: 1,
            epoch: "first".into(),
            entry_id: "entry".into(),
            child_id: "child".into(),
            invocation: "invocation".into(),
            deadline_ms: 10,
            task_deadline_ms: 20,
            lease_renewal_ms: 0,
            lease_expiry_ms: 30,
            recovery: None,
        };
        persist(&path, &marker, false).unwrap();
        let loaded: Marker = serde_json::from_slice(&read_bounded(&path).unwrap()).unwrap();
        assert_eq!(loaded.epoch, "first");
        marker.epoch = "replacement".into();
        persist(&path, &marker, true).unwrap();
        let loaded: Marker = serde_json::from_slice(&read_bounded(&path).unwrap()).unwrap();
        assert_eq!(loaded.epoch, "replacement");
        assert!(loaded.validate());
    }

    #[test]
    fn recovery_lock_serializes_and_releases() {
        let directory = tempfile::tempdir().unwrap();
        let first = lock(directory.path(), "claim").unwrap();
        assert!(lock(directory.path(), "claim").is_err());
        drop(first);
        drop(lock(directory.path(), "claim").unwrap());
    }
}
