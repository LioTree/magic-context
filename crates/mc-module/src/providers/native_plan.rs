//! Native format pins and immutable route/session plans. Discovery stays held.
use super::*;
use hooks::{claude_code::ClaudeCodeCapabilities, subscription::DeclareRequest};

#[derive(Clone)]
pub(crate) struct NativeConnectionPlan {
    incarnation: u64,
    pins: ClaudeCodeCapabilities,
    request: DeclareRequest,
}

impl McHandler {
    pub(super) fn native_pins(&self) -> ClaudeCodeCapabilities {
        #[cfg(test)]
        if let Some(pins) = self
            .native_bundle_override
            .lock()
            .expect("native pins mutex")
            .clone()
        {
            return pins;
        }
        capability_candidate::CANDIDATE.clone()
    }

    pub(super) async fn admit_native_plan(
        &self,
        channel: u16,
        binding: &SessionBinding,
        method: &str,
        params: &Value,
    ) -> Result<SessionBinding, HandlerOutcome> {
        let pins = self.native_pins();
        pins.validate()
            .map_err(|_| invalid_field("claude_code", "invalid compiled native pins"))?;
        let mut scoped = binding.clone();
        scoped.native_generation = Some(mc_store::provider_records::ProviderGeneration {
            profile: pins.profile_generation.clone(),
            provider: pins.provider_generation.clone(),
        });
        let key = Key::new(&scoped, &scoped.session, &scoped.harness)?;
        let store = self
            .store_for_request()
            .await
            .map_err(StoreRefusal::into_outcome)?;
        let _serial = self.provider_serial.lock_for(&key).await;
        let held = store
            .load_provider_conversation(&key.store_key())
            .map_err(transient)?;
        let pins_json =
            String::from_utf8(serde_jcs::to_vec(&pins).map_err(invalid)?).map_err(invalid)?;
        let request = if method == "transform.declare" {
            declaration(params)?;
            let request: DeclareRequest = decode(params)?;
            if request
                .claude_code
                .as_ref()
                .is_some_and(|selected| selected != &pins)
            {
                return Err(invalid_field(
                    "claude_code",
                    "native selection differs from compiled pins",
                ));
            }
            request
        } else {
            let routes = self
                .native_route_plans
                .lock()
                .expect("native route plans mutex");
            let route = routes
                .get(&channel)
                .filter(|route| route.incarnation == binding.connection_incarnation)
                .ok_or_else(|| {
                    invalid_field(
                        "claude_code",
                        "native route requires a fresh transform.declare",
                    )
                })?;
            if route.pins != pins {
                return Err(invalid_field("claude_code", "active native pins changed"));
            }
            let request = route.request.clone();
            if let Some(params) = params.get("params") {
                if params != &Value::Object(request.params.clone()) {
                    return Err(invalid_field("params", "native plan is frozen"));
                }
            }
            if params
                .get("preset")
                .is_some_and(|preset| preset.as_str() != request.preset.as_deref())
            {
                return Err(invalid_field("params", "native preset is frozen"));
            }
            if params.get("composition").is_some_and(|value| {
                value != &Value::Object(request.composition.clone().unwrap_or_default())
            }) {
                return Err(invalid_field("params", "native composition is frozen"));
            }
            if method == "compaction.setup" {
                let setup: compact::setup::SetupRequest = decode(params)?;
                if setup.claude_code != request.claude_code {
                    return Err(invalid_field(
                        "claude_code",
                        "setup changed native selection",
                    ));
                }
                if setup.preset != request.preset
                    || request.composition.clone().unwrap_or_default() != setup.composition
                {
                    return Err(invalid_field("params", "setup changed frozen plan"));
                }
            }
            request
        };
        let plan_json =
            String::from_utf8(serde_jcs::to_vec(&request).map_err(invalid)?).map_err(invalid)?;
        if let Some(held) = &held {
            let previous: DeclareRequest =
                serde_json::from_str(held.native_plan_json.as_deref().ok_or_else(|| {
                    invalid_field("claude_code", "stored native plan is missing")
                })?)
                .map_err(invalid)?;
            if previous.claude_code != request.claude_code {
                return Err(error(
                    "native_selection_frozen",
                    "native capability selection cannot change within a generation",
                ));
            }
            if held.native_pins_json.as_deref() != Some(&pins_json) {
                return Err(invalid_field("claude_code", "stored native pins differ"));
            }
            if held.native_plan_json.as_deref() != Some(&plan_json) {
                return Err(invalid_field("params", "native session plan is frozen"));
            }
        }
        {
            let routes = self
                .native_route_plans
                .lock()
                .expect("native route plans mutex");
            if let Some(route) = routes
                .get(&channel)
                .filter(|route| route.incarnation == binding.connection_incarnation)
            {
                if route.request != request || route.pins != pins {
                    return Err(invalid_field(
                        "claude_code",
                        "native connection plan is frozen",
                    ));
                }
            }
        }
        if held.is_none() {
            store
                .save_provider_conversation(
                    &key.store_key(),
                    &mc_store::provider_records::ProviderConversation {
                        params_json: serde_json::to_string(&request.params).map_err(invalid)?,
                        preset: request.preset.clone(),
                        engine_namespace: key.engine_key(),
                        native_pins_json: Some(pins_json),
                        native_plan_json: Some(plan_json),
                        ..Default::default()
                    },
                )
                .map_err(transient)?;
        }
        // A reused channel is a different connection even for the same identity.
        // Check the bind incarnation again after awaits before installing its plan.
        let mut bindings = self.bindings.lock().expect("bindings mutex");
        let current = bindings
            .get_mut(&channel)
            .filter(|current| {
                current.connection_incarnation == binding.connection_incarnation
                    && current.principal == binding.principal
                    && current.project_root == binding.project_root
                    && current.session == binding.session
                    && current.harness == binding.harness
            })
            .ok_or_else(|| invalid_field("claude_code", "native route was rebound"))?;
        current.native_generation = scoped.native_generation.clone();
        self.native_route_plans
            .lock()
            .expect("native route plans mutex")
            .insert(
                channel,
                NativeConnectionPlan {
                    incarnation: binding.connection_incarnation,
                    pins,
                    request,
                },
            );
        Ok(scoped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::claude_code_tests as cc;
    fn pins(generation: &str) -> ClaudeCodeCapabilities {
        let mut pins = capability_candidate::CANDIDATE.clone();
        pins.profile_generation = "native-format-v1".into();
        pins.provider_generation = generation.into();
        pins
    }
    fn handler(root: &Path, pins: &ClaudeCodeCapabilities) -> McHandler {
        let h = cc::handler(root, cc::thalamus());
        *h.native_bundle_override.lock().unwrap() = Some(pins.clone());
        h
    }
    fn key(h: &McHandler) -> Key {
        Key::new(&h.facade_binding(7).unwrap(), "cc", "claude-code").unwrap()
    }
    fn value(outcome: HandlerOutcome) -> Value {
        let HandlerOutcome::Response(bytes) = outcome else {
            panic!("{outcome:?}")
        };
        serde_json::from_slice(&bytes).unwrap()
    }
    #[tokio::test]
    async fn native_generations_isolate_messages_views_locks_and_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let a = pins("generation-a");
        let b = pins("generation-b");
        let h1 = handler(dir.path(), &a);
        cc::setup(&h1).await;
        let k1 = key(&h1);
        value(
            cc::call(
                &h1,
                "compaction.step",
                cc::step(r#"{"role":"user","content":"a"}"#),
            )
            .await,
        );
        let h2 = McHandler::new();
        h2.store.set(h1.store.get().unwrap().clone()).ok().unwrap();
        h2.bind_route(7, cc::binding(dir.path(), cc::thalamus()));
        *h2.native_bundle_override.lock().unwrap() = Some(b.clone());
        cc::setup(&h2).await;
        let k2 = key(&h2);
        value(
            cc::call(
                &h2,
                "compaction.step",
                cc::step(r#"{"role":"user","content":"b"}"#),
            )
            .await,
        );
        assert_eq!(k1.session, k2.session);
        assert_eq!(k1.project, k2.project);
        assert_ne!(
            k1.store_key().conversation_key(),
            k2.store_key().conversation_key()
        );
        assert_ne!(k1.engine_key(), k2.engine_key());
        let lock = h1.provider_serial.try_lock_for(&k1).unwrap();
        assert!(h1.provider_serial.try_lock_for(&k2).is_ok());
        drop(lock);
        let store = h1.store.get().unwrap();
        for (key, expected) in [(&k1, "a"), (&k2, "b")] {
            let messages = store.load_provider_messages(&key.store_key(), "L").unwrap();
            assert_eq!(messages.len(), 1);
            assert_eq!(
                serde_json::from_slice::<Value>(&messages[0].message_bytes).unwrap()["message"]
                    ["content"],
                expected
            );
            store
                .save_provider_view(
                    &key.store_key(),
                    &mc_store::provider_records::ProviderView {
                        version: 77,
                        lineage_id: "L".into(),
                        range_from: 0,
                        range_to: 1,
                        replacement_json: json!({"generation":expected}).to_string(),
                        state: "produced".into(),
                    },
                )
                .unwrap();
        }
        drop(h2);
        drop(h1);
        let restarted = handler(dir.path(), &a);
        assert!(
            matches!(cc::call(&restarted,"compaction.step",cc::step(r#"{"role":"user","content":"a"}"#)).await,HandlerOutcome::ErrorWithDetail { detail,.. } if detail["field"]=="claude_code")
        );
        cc::setup(&restarted).await;
        assert_eq!(
            key(&restarted).store_key().conversation_key(),
            k1.store_key().conversation_key()
        );
        let store = restarted.store.get().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(
                &store
                    .load_provider_view(&k1.store_key(), 77)
                    .unwrap()
                    .unwrap()
                    .replacement_json
            )
            .unwrap()["generation"],
            "a"
        );
        assert_eq!(
            serde_json::from_str::<Value>(
                &store
                    .load_provider_view(&k2.store_key(), 77)
                    .unwrap()
                    .unwrap()
                    .replacement_json
            )
            .unwrap()["generation"],
            "b"
        );
        assert!(store
            .load_provider_messages(
                &mc_store::ProviderSessionKey {
                    project_root: dir.path().to_string_lossy().into(),
                    session: "cc".into(),
                    harness: "claude-code".into(),
                    generation: None
                },
                "L"
            )
            .unwrap()
            .is_empty());
    }
    #[tokio::test]
    async fn native_route_plan_rebind_epoch_and_plan_drift_refuse() {
        let dir = tempfile::tempdir().unwrap();
        let p = pins("generation-a");
        let h = handler(dir.path(), &p);
        cc::setup(&h).await;
        let mut drift = json!({"session":"cc","harness":"claude-code","preset":"head","params":{"serializer_profile":"claude-code-anthropic","observation":"answer"}});
        drift["params"]["extra"] = json!(true);
        assert!(
            matches!(cc::call(&h,"transform.declare",drift).await,HandlerOutcome::ErrorWithDetail { detail,.. } if detail["field"]=="params")
        );
        let setup_drift = json!({"session":"cc","harness":"claude-code","request_id":"drift","preset":"head","params":{"serializer_profile":"claude-code-anthropic","observation":"answer"},"composition":{"changed":true},"model":"fixture","now":1});
        assert!(
            matches!(cc::call(&h,"compaction.setup",setup_drift).await,HandlerOutcome::ErrorWithDetail { detail,.. } if detail["field"]=="params")
        );
        let key = key(&h);
        let store = h.store.get().unwrap();
        let mut held = store
            .load_provider_conversation(&key.store_key())
            .unwrap()
            .unwrap();
        let mut changed: Value =
            serde_json::from_str(held.native_pins_json.as_ref().unwrap()).unwrap();
        changed["epochs"]["codec"] = json!(999);
        held.native_pins_json = Some(changed.to_string());
        assert!(store
            .save_provider_conversation(&key.store_key(), &held)
            .is_err());
        let mut changed_build = p.clone();
        changed_build.epochs.insert("codec".into(), 999);
        *h.native_bundle_override.lock().unwrap() = Some(changed_build);
        assert!(
            matches!(cc::call(&h,"compaction.step",cc::step(r#"{"role":"user","content":"a"}"#)).await,HandlerOutcome::ErrorWithDetail { detail,.. } if detail["field"]=="claude_code")
        );
        *h.native_bundle_override.lock().unwrap() = Some(p.clone());
        h.bind_route(7, cc::binding(dir.path(), cc::thalamus()));
        assert!(
            matches!(cc::call(&h,"compaction.step",cc::step(r#"{"role":"user","content":"a"}"#)).await,HandlerOutcome::ErrorWithDetail { detail,.. } if detail["field"]=="claude_code")
        );
        cc::setup(&h).await;
        let mut new = p.clone();
        new.epochs.insert("codec".into(), 2);
        *h.native_bundle_override.lock().unwrap() = Some(new);
        assert!(
            matches!(cc::call(&h,"compaction.step",cc::step(r#"{"role":"user","content":"a"}"#)).await,HandlerOutcome::ErrorWithDetail { detail,.. } if detail["field"]=="claude_code")
        );
    }
}

#[cfg(test)]
mod selected_plan_tests {
    use super::*;
    use crate::providers::claude_code_tests as cc;
    #[tokio::test]
    async fn native_selection_cannot_silently_upgrade_within_a_generation() {
        let dir = tempfile::tempdir().unwrap();
        let h = cc::handler(dir.path(), cc::thalamus());
        cc::setup(&h).await;
        let binding = h.facade_binding(7).unwrap();
        let declare = json!({"preset":"head","params":{"serializer_profile":"claude-code-anthropic","observation":"answer"},"claude_code":h.native_pins()});
        assert!(
            matches!(h.admit_native_plan(7,&binding,"transform.declare",&declare).await,Err(HandlerOutcome::Error {code,..}) if code=="native_selection_frozen")
        );
    }
    #[tokio::test]
    async fn internal_selected_bundle_freezes_full_declare_and_setup_without_publication() {
        let dir = tempfile::tempdir().unwrap();
        let h = cc::handler(dir.path(), cc::thalamus());
        let pins = h.native_pins();
        let binding = h.facade_binding(7).unwrap();
        let declare = json!({"preset":"head","params":{"serializer_profile":"claude-code-anthropic","observation":"answer"},"composition":{},"claude_code":pins});
        h.admit_native_plan(7, &binding, "transform.declare", &declare)
            .await
            .unwrap();
        let scoped = h.facade_binding(7).unwrap();
        let setup = json!({"session":"cc","harness":"claude-code","request_id":"s","preset":"head","params":declare["params"],"composition":{},"claude_code":declare["claude_code"],"model":"fixture","now":1});
        h.admit_native_plan(7, &scoped, "compaction.setup", &setup)
            .await
            .unwrap();
        let mut changed = setup;
        changed["claude_code"]["epochs"]["codec"] = json!(999);
        assert!(
            matches!(h.admit_native_plan(7,&scoped,"compaction.setup",&changed).await,Err(HandlerOutcome::ErrorWithDetail { detail,.. }) if detail["field"]=="claude_code")
        );
        let mut composition = declare;
        composition["composition"] = json!({"changed":true});
        assert!(h
            .admit_native_plan(7, &scoped, "transform.declare", &composition)
            .await
            .is_err());
        let HandlerOutcome::Response(bytes) = describe() else {
            panic!("describe")
        };
        assert!(serde_json::from_slice::<Value>(&bytes)
            .unwrap()
            .get("claude_code")
            .is_none());
    }
}
