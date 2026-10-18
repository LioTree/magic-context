//! Lifecycle teardown for the authenticated host bridge.
use super::*;

pub(super) fn conversation_missing() -> HandlerOutcome {
    error(
        "provider_conversation_missing",
        "provider conversation does not exist; declare it before use",
    )
}

impl McHandler {
    pub(super) async fn provider_delete(
        &self,
        binding: &SessionBinding,
        params: &Value,
    ) -> Result<Vec<u8>, HandlerOutcome> {
        let session = params
            .get("session")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_field("session", "session is required"))?;
        let harness = params
            .get("harness")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_field("harness", "harness is required"))?;
        let key = Key::new(binding, session, harness)?;
        let store = self
            .store_for_request()
            .await
            .map_err(StoreRefusal::into_outcome)?;
        // The same lock covers the entire step, including publication. Either
        // publication wins and is removed here, or the step sees no conversation.
        let _serial = self.provider_serial.lock_for(&key).await;
        store
            .delete_provider_conversation(&key.store_key())
            .map_err(transient)?;
        self.provider_resident
            .remove(store.tag_cache_namespace(), &key);
        bytes(&json!({"answer":"deleted"}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::{poll_fn, Future},
        task::Poll,
    };

    fn fixture(root: &Path, harness: &str) -> (McHandler, SessionBinding, Key) {
        let h = super::super::claude_code_tests::handler(root, None);
        let mut binding = super::super::claude_code_tests::binding(
            root,
            Some(subc_protocol::Principal::Reserved {
                module_id: "thalamus-harness".into(),
            }),
        );
        binding.harness = harness.into();
        binding.session = "s".into();
        binding.scope = Some(super::super::host_lane_tests::scope());
        let key = Key::new(&binding, "s", harness).unwrap();
        h.bind_route(7, binding.clone());
        (h, binding, key)
    }

    fn response(result: HandlerOutcome) -> Vec<u8> {
        match result {
            HandlerOutcome::Response(bytes) => bytes,
            other => panic!("{other:?}"),
        }
    }

    async fn create(h: &McHandler, harness: &str) {
        let plan = json!({"serializer_profile":if harness == "pi" { "pi" } else { "opencode-aisdk" },"observation":"answer"});
        response(
            super::super::claude_code_tests::call(
                h,
                "transform.declare",
                json!({"session":"s","harness":harness,"preset":"head","params":plan}),
            )
            .await,
        );
        response(super::super::claude_code_tests::call(h,"compaction.setup", json!({"session":"s","harness":harness,"request_id":"setup","preset":"head","params":plan,"model":"fixture","context_window":100000,"composition":{},"lineage_id":"L","now":1})).await);
    }

    fn step(harness: &str) -> Value {
        json!({"session":"s","harness":harness,"request_id":"step","lineage_id":"L","step_id":"1","step_kind":"user_turn","model":"fixture","context_window":100000,"estimate":{"request_tokens":1},"messages":[],"now":2})
    }

    #[tokio::test]
    async fn bridge_delete_is_idempotent_and_evicts_resident_state() {
        for harness in ["opencode", "opencode2", "pi"] {
            let dir = tempfile::tempdir().unwrap();
            let (h, _, key) = fixture(dir.path(), harness);
            create(&h, harness).await;
            response(
                super::super::claude_code_tests::call(&h, "compaction.step", step(harness)).await,
            );
            let store = h.store.get().unwrap();
            h.provider_resident
                .begin(store.tag_cache_namespace(), &key)
                .unwrap()
                .unwrap()
                .publish();
            assert_eq!(
                h.provider_resident
                    .session_stats(store.tag_cache_namespace(), &key)["ready"],
                true
            );
            let params = json!({"session":"s","harness":harness});
            let first = response(
                super::super::claude_code_tests::call(&h, "compaction.delete", params.clone())
                    .await,
            );
            assert_eq!(first, br#"{"answer":"deleted"}"#);
            assert_eq!(
                response(
                    super::super::claude_code_tests::call(&h, "compaction.delete", params).await
                ),
                first
            );
            assert_eq!(h.provider_resident.stats()["sessions"], 0);
            assert!(store
                .load_provider_conversation(&key.store_key())
                .unwrap()
                .is_none());
            match super::super::claude_code_tests::call(&h, "compaction.step", step(harness)).await
            {
                HandlerOutcome::Error { code, .. } => {
                    assert_eq!(code, "provider_conversation_missing")
                }
                other => panic!("{other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn bridge_delete_and_step_serialize_in_both_orders() {
        for delete_first in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let (h, binding, key) = fixture(dir.path(), "opencode");
            create(&h, "opencode").await;
            let held = h.provider_serial.lock_for(&key).await;
            let params = json!({"session":"s","harness":"opencode"});
            let step_params = step("opencode");
            let mut stepping = Box::pin(h.provider_step(7, binding.clone(), &step_params));
            let mut deleting = Box::pin(h.provider_delete(&binding, &params));
            // Poll each real operation into the mutex queue in a known order.
            poll_fn(|cx| {
                if delete_first {
                    assert!(deleting.as_mut().poll(cx).is_pending());
                    assert!(stepping.as_mut().poll(cx).is_pending());
                } else {
                    assert!(stepping.as_mut().poll(cx).is_pending());
                    assert!(deleting.as_mut().poll(cx).is_pending());
                }
                Poll::Ready(())
            })
            .await;
            drop(held);
            let (stepped, deleted) = tokio::join!(stepping, deleting);
            assert_eq!(deleted.unwrap(), br#"{"answer":"deleted"}"#);
            if delete_first {
                assert!(
                    matches!(stepped, Err(HandlerOutcome::Error { code, .. }) if code == "provider_conversation_missing")
                );
            } else {
                assert!(stepped.is_ok(), "{stepped:?}");
            }
            assert!(h
                .store
                .get()
                .unwrap()
                .load_provider_conversation(&key.store_key())
                .unwrap()
                .is_none());
        }
    }

    #[tokio::test]
    async fn bridge_delete_rejects_foreign_session_and_harness() {
        let dir = tempfile::tempdir().unwrap();
        let (h, _, key) = fixture(dir.path(), "opencode");
        create(&h, "opencode").await;
        for params in [
            json!({"session":"other","harness":"opencode"}),
            json!({"session":"s","harness":"pi"}),
        ] {
            assert!(
                matches!(super::super::claude_code_tests::call(&h,"compaction.delete",params).await, HandlerOutcome::ErrorWithDetail { code, .. } if code == "invalid_params")
            );
        }
        assert!(h
            .store
            .get()
            .unwrap()
            .load_provider_conversation(&key.store_key())
            .unwrap()
            .is_some());
    }
}
