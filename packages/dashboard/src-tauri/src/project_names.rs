//! Process-local Entorhinal labels. Database reads only consult the cached map;
//! the daemon is contacted at startup and when the user explicitly refreshes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use subc_client_rs::{
    CallError, CallOptions, CloseRouteOptions, ConsumerOptions, RetryBackoff, SubcConsumer,
};
use subc_protocol::{BindIdentity, RouteTarget};
use tokio::sync::Mutex;

pub const ENTORHINAL_RESOLVE_DEADLINE_MS: u64 = 500;
const DEADLINE: Duration = Duration::from_millis(ENTORHINAL_RESOLVE_DEADLINE_MS);
pub type ProjectNames = HashMap<String, String>;

#[derive(Default)]
pub struct ProjectNameCache {
    initialized: Mutex<bool>,
    names: RwLock<ProjectNames>,
}

impl ProjectNameCache {
    pub async fn initialize(&self, connection_file: &Path) {
        let mut initialized = self.initialized.lock().await;
        if !*initialized {
            self.reload(connection_file).await;
            *initialized = true;
        }
    }

    pub async fn refresh(&self, connection_file: &Path) {
        let mut initialized = self.initialized.lock().await;
        self.reload(connection_file).await;
        *initialized = true;
    }

    async fn reload(&self, connection_file: &Path) {
        let names = match enumerate_names(connection_file).await {
            Ok(names) => names,
            Err(error) => {
                eprintln!("Entorhinal project names unavailable: {error}");
                ProjectNames::new()
            }
        };
        *self
            .names
            .write()
            .unwrap_or_else(|error| error.into_inner()) = names;
    }

    pub fn snapshot(&self) -> ProjectNames {
        self.names
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
}

pub fn cache() -> &'static ProjectNameCache {
    static CACHE: OnceLock<ProjectNameCache> = OnceLock::new();
    CACHE.get_or_init(ProjectNameCache::default)
}

pub fn connection_file() -> PathBuf {
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".local/share"));
    data_home.join("cortexkit/run/subc-connection.json")
}

/// Registered identities never use directory or session labels: a rename or a
/// worktree's basename must not hide the registered name or the unknown-id marker.
pub fn pj_label(identity: &str, names: &ProjectNames) -> Option<String> {
    let rest = identity.strip_prefix("pj-")?;
    Some(
        names
            .get(identity)
            .cloned()
            .unwrap_or_else(|| format!("pj-{}…", rest.chars().take(10).collect::<String>())),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnumeratedProject {
    project_id: String,
    name: Option<String>,
    #[serde(default)]
    implicit: bool,
}

#[derive(Deserialize)]
struct Enumeration {
    projects: Vec<EnumeratedProject>,
}

pub(crate) fn parse_names(bytes: &[u8]) -> Result<ProjectNames, String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let payload = value.get("result").unwrap_or(&value);
    let enumeration: Enumeration =
        serde_json::from_value(payload.clone()).map_err(|e| e.to_string())?;
    Ok(enumeration
        .projects
        .into_iter()
        .filter_map(|project| {
            let name = project.name.filter(|name| !name.is_empty())?;
            if project.implicit
                || !project.project_id.starts_with("pj-")
                || project.project_id.starts_with("pj-implicit1-")
            {
                return None;
            }
            Some((project.project_id, name))
        })
        .collect())
}

async fn enumerate_names(connection_file: &Path) -> Result<ProjectNames, String> {
    if !connection_file.is_file() {
        return Ok(ProjectNames::new());
    }
    // One timeout covers connect, route-open, call, and cleanup. A late reply
    // cannot replace the cache because only the completed attempt returns names.
    tokio::time::timeout(DEADLINE, async {
        let retry = RetryBackoff {
            base: Duration::from_millis(25),
            cap: Duration::from_millis(50),
            max_attempts: 1,
        };
        let consumer = SubcConsumer::connect(
            connection_file,
            ConsumerOptions {
                handshake_timeout: DEADLINE,
                call_timeout: DEADLINE,
                reconnect_backoff: retry,
                ..ConsumerOptions::default()
            },
        )
        .await
        .map_err(|e| e.to_string())?;
        let target = RouteTarget::ManagementSurface {
            module_id: "entorhinal".to_string(),
        };
        let identity = BindIdentity::new(
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
            "magic-context-dashboard",
            format!("dashboard-{}", std::process::id()),
        );
        let response = consumer
            .call(
                target.clone(),
                identity.clone(),
                serde_json::to_vec(&json!({"method": "enumerate", "params": {}})).unwrap(),
                CallOptions {
                    timeout: DEADLINE,
                    route_retry: retry,
                    route_retry_deadline: DEADLINE,
                    ..CallOptions::default()
                },
            )
            .await;
        consumer
            .close_route(target, identity, CloseRouteOptions::default())
            .await;
        consumer.close().await;
        match response {
            Err(CallError::Module(body)) if body.code == "unknown_module" => {
                Ok(ProjectNames::new())
            }
            other => parse_names(&other.map_err(|e| e.to_string())?),
        }
    })
    .await
    .map_err(|_| "enumerate deadline exceeded".to_string())?
}
