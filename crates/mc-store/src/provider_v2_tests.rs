use super::*;
use crate::provider_log::{
    ProviderConversation, ProviderLineage, ProviderMessage, ProviderStatusPage,
};
use cortexkit_store_types::{Isolation, StorageBackend};
use serde_json::json;

fn rig() -> (tempfile::TempDir, McStore, ProviderSessionKey) {
    let dir = tempfile::tempdir().unwrap();
    let store = McStore::open_for_test(&StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: NS.into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: dir.path().join("store.db").to_string_lossy().into(),
        },
    })
    .unwrap();
    let key = ProviderSessionKey {
        project_root: "/recipe-fixture".into(),
        session: "s".into(),
        harness: "opencode".into(),
        generation: None,
    };
    store
        .save_provider_conversation(
            &key,
            &ProviderConversation {
                lineage_id: "L".into(),
                engine_namespace: "engine".into(),
                ..Default::default()
            },
        )
        .unwrap();
    store.commit_provider_status_page(&key,ProviderStatusPage {lineage:&ProviderLineage {lineage_id:"L".into(),first_ordinal:0,descends_from:None,through_ordinal:None},messages:&[ProviderMessage {ordinal:0,mid:"m".into(),message_bytes:br#"{"info":{"id":"m","role":"user"},"parts":[{"type":"text","text":"immutable native text"}]}"#.to_vec()}],served:Some(0),unserved:&[],newest:Some(0),more:false}).unwrap();
    (dir, store, key)
}

fn recipe(version: u64, base: Option<u64>) -> ProviderViewRecipe {
    ProviderViewRecipe {
        version,
        lineage_id: "L".into(),
        range_from: 0,
        range_to: 1,
        base_version: base,
        policy_cut_id: None,
        metadata: json!({"version":version}),
        segments: vec![
            ProviderViewSegment::Synthetic {
                slot: "head".into(),
            },
            ProviderViewSegment::NativeRange {
                source_lineage_id: "L".into(),
                from: 0,
                to: 1,
                first_mid: "m".into(),
                last_mid: "m".into(),
            },
        ],
        synthetic: if version == 1 {
            std::collections::BTreeMap::from([(
                "head".into(),
                json!({"text":"only genuinely new synthetic bytes"}),
            )])
        } else {
            Default::default()
        },
        treatments: vec![],
        serializer_profile: "opencode-aisdk".into(),
        render_key: "fixture-render-v1".into(),
        tokenizer_key: "fixture-tokenizer-v1".into(),
        state: "applied".into(),
    }
}

#[test]
fn v2_inheritance_reroots_at_sixteen_and_keeps_native_source_identity() {
    let (_dir, store, key) = rig();
    for version in 1..=50 {
        store
            .save_provider_view_recipe(&key, &recipe(version, (version > 1).then_some(version - 1)))
            .unwrap();
        let value = store.resolve_provider_view(&key, version).unwrap().unwrap();
        assert!(
            value.depth <= 16,
            "reconstruction must respect the fixed external depth contract"
        );
        assert_eq!(value.messages.len(), 1);
        assert_eq!(
            value.recipe.synthetic["head"]["text"],
            "only genuinely new synthetic bytes"
        );
        store
            .prune_provider_view_recipes(&key, &std::collections::BTreeSet::from([version]))
            .unwrap();
    }
    let rows = store
        .inner
        .with_conn(|conn| {
            conn.query_row(
                "SELECT count(*) FROM mc_provider_views_v2 WHERE conv_key=?1",
                [key.conversation_key()],
                |r| r.get::<_, u64>(0),
            )
        })
        .unwrap();
    assert!(rows <= 17);
}

#[test]
fn v2_pruning_keeps_every_applied_produced_lkg_and_receipt_root() {
    let (_dir, store, key) = rig();
    for version in 1..=5 {
        let mut r = recipe(version, None);
        r.synthetic = recipe(1, None).synthetic;
        store.save_provider_view_recipe(&key, &r).unwrap();
    }
    let roots = std::collections::BTreeSet::from([1, 3, 5]);
    assert_eq!(store.prune_provider_view_recipes(&key, &roots).unwrap(), 2);
    for version in roots {
        assert!(store
            .resolve_provider_view(&key, version)
            .unwrap()
            .is_some());
    }
    assert!(store.resolve_provider_view(&key, 2).unwrap().is_none());
    assert!(store.resolve_provider_view(&key, 4).unwrap().is_none());
}

#[test]
fn v2_missing_native_row_never_serves_detached_facts_or_a_stale_view() {
    let (_dir, store, key) = rig();
    store
        .save_provider_view_recipe(&key, &recipe(1, None))
        .unwrap();
    store
        .inner
        .with_conn_fenced(|conn| {
            conn.execute(
                "DELETE FROM mc_provider_messages_v1 WHERE conv_key=?1",
                [key.conversation_key()],
            )
            .map(|_| ())
        })
        .unwrap();
    assert!(store.resolve_provider_view(&key, 1).is_err());
}

#[test]
fn v2_message_facts_are_lossless_bounded_and_content_free() {
    let part = part();
    let (blob, bytes) = provider_policy_overlay::encode_facts(std::slice::from_ref(&part)).unwrap();
    let decoded = provider_policy_overlay::decode_facts(&blob, bytes, 1).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), json!([part]));
    assert!(provider_policy_overlay::decode_facts(&blob, bytes - 1, 1).is_err());
    assert!(provider_policy_overlay::decode_facts(&blob, bytes, 2).is_err());
}

fn part() -> provider_log::ProviderPolicyPart {
    provider_log::ProviderPolicyPart {
        mid: "m".into(),
        ordinal: 0,
        block_id: "m#0".into(),
        block_index: 0,
        kind: "text".into(),
        role: "user".into(),
        measurement: TailHygienePartMeasurement {
            key: "m#0".into(),
            content_hash: "original-source-hash".into(),
            kind: TailHygienePartKind::Text,
            tokens: 7,
            u_tokens: 0,
            tag_number: Some(4),
            tag_status: Some("active".into()),
            protected: false,
            queued_for_drop: false,
        },
        tag_kind: Some("text".into()),
        tag_number: Some(4),
        tag_tokens: 7,
        tool_name: String::new(),
        arc_id: None,
        subject_part: String::new(),
        active: true,
        served: true,
        reduced: false,
        queued: false,
        real_user: true,
        created_at_ms: Some(42),
        completed_at_ms: None,
    }
}

#[test]
fn v2_effective_policy_resolves_frozen_facts_defaults_and_point_overrides() {
    let (_dir, store, key) = rig();
    let part = part();
    store
        .inner
        .with_conn_fenced(|conn| {
            conn.execute(
                "INSERT INTO mc_provider_policy_parts_v1 VALUES(?1,'L',0,'m#0',?2,'s')",
                params![
                    key.conversation_key(),
                    serde_json::to_string(&part).unwrap()
                ],
            )?;
            let cut = provider_policy_overlay::freeze_cut_tx(
                conn,
                &key.conversation_key(),
                "L",
                Some(0),
                &json!({"baseline":{}}),
                std::slice::from_ref(&part),
            )
            .unwrap();
            conn.execute(
                "UPDATE mc_provider_conversations_v2 SET hook_counters_json=?2 WHERE conv_key=?1",
                params![
                    key.conversation_key(),
                    json!({"engine_policy":{"baseline_cut_id":cut}}).to_string()
                ],
            )?;
            conn.execute(
                "INSERT INTO mc_provider_policy_overrides_v1 VALUES(?1,'L','m#0',0,?2,?3,'s')",
                params![
                    key.conversation_key(),
                    cut,
                    json!({"queued":true,"measurement":{"tokens":13,"queued_for_drop":true}})
                        .to_string()
                ],
            )?;
            Ok(())
        })
        .unwrap();
    let physical: u64 = store
        .inner
        .with_conn(|conn| {
            conn.query_row(
                "SELECT count(*) FROM mc_provider_policy_parts_v1 WHERE conv_key=?1",
                [key.conversation_key()],
                |r| r.get(0),
            )
        })
        .unwrap();
    assert_eq!(
        physical, 0,
        "only live-tail rows remain physical policy rows"
    );
    let effective = store
        .read_provider_resident_policy(&key, |index, _| index.all_parts())
        .unwrap();
    assert_eq!(effective.len(), 1);
    assert_eq!(
        effective[0].measurement.content_hash,
        "original-source-hash"
    );
    assert_eq!(effective[0].measurement.tokens, 13);
    assert!(effective[0].queued && effective[0].measurement.queued_for_drop);
}
