//! Separate namespaces for engine policy and native bridge settings.
//!
//! The existing loader remains unchanged. A future trusted resolver produces CoreConfig;
//! core callbacks receive only that projection, never the bridge namespace.

use serde::{Deserialize, Serialize};

use crate::config::McModuleConfig;
use crate::parity_contract::{Availability, CapabilityResult, Generation};

#[derive(Debug, Clone)]
pub struct CoreConfig {
    pub effective: McModuleConfig,
    pub generation: Generation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BridgeConfig {
    pub native_schema_dialect: String,
    pub notifications_enabled: bool,
    pub status_ui_enabled: bool,
    pub discovery_namespace: String,
}

/// Distinct types prevent native UI and transport options from entering engine policy.
#[derive(Debug, Clone)]
pub struct ConfigNamespaces {
    core: CoreConfig,
    bridge: BridgeConfig,
}

impl ConfigNamespaces {
    pub fn new(core: CoreConfig, bridge: BridgeConfig) -> Self {
        Self { core, bridge }
    }

    pub fn core(&self) -> &CoreConfig {
        &self.core
    }

    pub fn bridge(&self) -> &BridgeConfig {
        &self.bridge
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigResolveRequest {
    pub user_config_path: String,
    pub project_root: String,
    pub generation: Generation,
}

pub trait CoreConfigResolver: Send + Sync {
    fn availability(&self) -> Availability;
    fn resolve(&self, request: &ConfigResolveRequest) -> CapabilityResult<CoreConfig>;
}

pub struct UnavailableConfigResolver;
pub static UNAVAILABLE: UnavailableConfigResolver = UnavailableConfigResolver;

impl CoreConfigResolver for UnavailableConfigResolver {
    fn availability(&self) -> Availability {
        mc_store::parity_schema_manifest::unavailable("config_parity")
    }

    fn resolve(&self, _: &ConfigResolveRequest) -> CapabilityResult<CoreConfig> {
        CapabilityResult::unavailable("config_parity")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_settings_are_not_part_of_the_core_projection() {
        let config = ConfigNamespaces::new(
            CoreConfig {
                effective: McModuleConfig::default(),
                generation: Generation(7),
            },
            BridgeConfig {
                native_schema_dialect: "pi".into(),
                notifications_enabled: false,
                status_ui_enabled: false,
                discovery_namespace: "fixture".into(),
            },
        );
        assert_eq!(config.core().generation, Generation(7));
        assert!(!config.bridge().status_ui_enabled);
        let request = ConfigResolveRequest {
            user_config_path: "/nonexistent/user.jsonc".into(),
            project_root: "/nonexistent/project".into(),
            generation: Generation(7),
        };
        assert!(matches!(
            UNAVAILABLE.resolve(&request),
            CapabilityResult::Unavailable { .. }
        ));
        assert!(matches!(
            UNAVAILABLE.availability(),
            Availability::Unavailable { .. }
        ));
    }

    #[test]
    fn bridge_namespace_rejects_core_policy_fields() {
        let bridge = serde_json::json!({
            "native_schema_dialect": "pi", "notifications_enabled": true,
            "status_ui_enabled": true, "discovery_namespace": "fixture",
            "memory_budget_tokens": 1
        });
        assert!(serde_json::from_value::<BridgeConfig>(bridge).is_err());
    }
}
