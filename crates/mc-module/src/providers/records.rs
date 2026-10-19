//! Conversation identity and durable tool catalogs shared by provider engines.
use super::*;
use serde::Deserialize;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Key {
    pub project: PathBuf,
    pub session: String,
    pub harness: String,
}

impl Key {
    pub fn new(
        binding: &SessionBinding,
        session: &str,
        harness: &str,
    ) -> Result<Self, HandlerOutcome> {
        if session.trim().is_empty() {
            return Err(session_unresolved_error());
        }
        if harness.trim().is_empty() {
            return Err(invalid("harness must be non-empty"));
        }
        Ok(Self {
            project: binding.project_root.clone(),
            session: session.trim().into(),
            harness: harness.into(),
        })
    }

    pub fn engine_key(&self) -> String {
        // Length-framed JSON avoids collisions between handles containing separators,
        // and separates the legacy engine namespace from runner conversations.
        format!(
            "mc-provider:{}",
            sha256_hex(&serde_json::to_vec(self).expect("session key JSON"))
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Catalog {
    pub compacting: bool,
    pub tools: BTreeSet<String>,
}

/// A typed adapter over the handler's main store slot. It owns no connection,
/// policy or schema: store open and migrations finish before the slot is filled.
pub struct Storage {
    store: Arc<OnceLock<Arc<McStore>>>,
    /// If storage cannot record admission, the process remembers that fact until
    /// a full successful refetch. Discovery still serves its unchanged bytes.
    catalog_failures: Mutex<BTreeMap<(PathBuf, String), String>>,
    pub(crate) async_runtime: super::async_provider::Runtime,
}

impl Storage {
    pub fn new(store: Arc<OnceLock<Arc<McStore>>>) -> Self {
        Self {
            store,
            catalog_failures: Mutex::new(BTreeMap::new()),
            async_runtime: Default::default(),
        }
    }

    pub fn record_catalog_failure(&self, binding: &SessionBinding, error: &HandlerOutcome) {
        let reason = match error {
            HandlerOutcome::Error { code, message }
            | HandlerOutcome::ErrorWithDetail { code, message, .. } => format!("{code}: {message}"),
            _ => "catalog persistence failed".to_string(),
        };
        tracing::warn!(
            reason,
            "mc-module: tool catalog served without durable provider admission"
        );
        self.catalog_failures
            .lock()
            .expect("catalog failures")
            .insert(
                (binding.project_root.clone(), binding.session.trim().into()),
                reason,
            );
    }

    pub fn clear_catalog_failure(&self, binding: &SessionBinding) {
        self.catalog_failures
            .lock()
            .expect("catalog failures")
            .remove(&(binding.project_root.clone(), binding.session.trim().into()));
    }

    pub fn catalog_refusal(
        &self,
        binding: &SessionBinding,
        session: &str,
    ) -> Option<HandlerOutcome> {
        self.catalog_failures.lock().expect("catalog failures").get(&(binding.project_root.clone(),session.trim().into())).map(|reason|HandlerOutcome::ErrorWithDetail {
            code:"provider_catalog_unpersisted".into(),
            message:"The admitted tool catalog was not persisted; fetch tool.catalog again after storage is available".into(),
            detail:json!({"cause":reason}),
        })
    }

    fn store(&self) -> Result<&McStore, HandlerOutcome> {
        self.store
            .get()
            .map(Arc::as_ref)
            .ok_or_else(|| transient("provider store is not open"))
    }

    pub fn tool_key(&self, binding: &SessionBinding) -> Result<Key, HandlerOutcome> {
        if let Some(refusal) = self.catalog_refusal(binding, &binding.session) {
            return Err(refusal);
        }
        let keys = self
            .store()?
            .provider_session_keys(
                &binding.project_root.to_string_lossy(),
                binding.session.trim(),
            )
            .map_err(transient)?;
        let [key] = keys.as_slice() else {
            return Err(session_unresolved_error());
        };
        Key::new(binding, &binding.session, &key.harness)
    }

    pub fn save_catalog(
        &self,
        binding: &SessionBinding,
        catalog: &Catalog,
    ) -> Result<(), HandlerOutcome> {
        self.store()?
            .save_provider_catalog(
                &binding.project_root.to_string_lossy(),
                binding.session.trim(),
                &serde_json::to_string(catalog).map_err(transient)?,
            )
            .map_err(transient)
    }

    pub fn catalog(&self, binding: &SessionBinding) -> Result<Option<Catalog>, HandlerOutcome> {
        self.store()?
            .load_provider_catalog(
                &binding.project_root.to_string_lossy(),
                binding.session.trim(),
            )
            .map_err(transient)?
            .map(|raw| serde_json::from_str(&raw).map_err(transient))
            .transpose()
    }
}

impl Key {
    pub fn store_key(&self) -> mc_store::ProviderSessionKey {
        mc_store::ProviderSessionKey {
            project_root: self.project.to_string_lossy().into_owned(),
            session: self.session.clone(),
            harness: self.harness.clone(),
            generation: None,
        }
    }
}
