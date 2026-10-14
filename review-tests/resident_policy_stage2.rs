// rust-stage2.ts copies the existing resident_policy_tests module and includes this file in that
// temporary copy, giving these tests access to its private fixtures without changing product files.
#[test]
fn review_resident_external_policy_update_matches_nonresident() {
    let (_dir, store, key, sql, settings) = rig();
    let mut resident = store
        .read_provider_resident_policy(&key, |index, counters| {
            ResidentPolicy::rebuild(index, counters, 0, &BTreeMap::new())
        })
        .unwrap();
    let mut changed = part(0);
    changed.measurement.tokens = 9000;
    changed.measurement.u_tokens = 4500;
    sql.execute("UPDATE mc_provider_policy_parts_v1 SET policy_json=?1 WHERE conv_key=?2 AND block_id='m-0#0'",rusqlite::params![serde_json::to_string(&changed).unwrap(),key.conversation_key()]).unwrap();
    let mut actual = store
        .read_provider_resident_policy(&key, |index, _| {
            resident_channel1_inputs(
                &mut resident,
                index,
                &settings,
                0,
                &BTreeMap::new(),
                false,
                false,
                None,
            )
        })
        .unwrap()
        .0;
    let source_parts = [changed, part(1), part(2)]
        .into_iter()
        .flat_map(|p| {
            let mut header = p.clone();
            header.kind = "header".into();
            header.block_id = format!("{}#header", p.mid);
            header.block_index = -1;
            header.measurement.key = header.block_id.clone();
            header.measurement.kind = TailHygienePartKind::Excluded;
            header.measurement.tokens = 0;
            header.measurement.u_tokens = 0;
            [header, p]
        })
        .collect::<Vec<_>>();
    let mut expected = transform::channel1_inputs_from_parts(
        &source_parts,
        &settings,
        0,
        &BTreeMap::new(),
        false,
        false,
        None,
    );
    expected.baseline.baseline_parts.clear();
    actual.baseline.baseline_parts.clear();
    assert_eq!(
        serde_json::json!(actual.baseline),
        serde_json::json!(expected.baseline),
        "out-of-band policy update must affect the next resident hook"
    );
    assert_eq!(actual.hint, expected.hint);
    assert_eq!(actual.users, expected.users);
}

#[test]
fn review_resident_fifty_sessions_caps_and_eviction_rebuild_from_store() {
    use crate::providers::records::Key;
    use crate::providers::resident_hooks::{ResidentHooks, PROCESS_CAP, SESSION_CAP};
    let (_dir, store, key, sql, _settings) = rig();
    let cache = ResidentHooks::enabled(true);
    cache.load_for_test(&store, &key);
    let resident_key = Key {
        project: key.project_root.clone().into(),
        session: key.session.clone(),
        harness: key.harness.clone(),
        generation: None,
    };
    let instance = store.tag_cache_namespace();
    let make = |n: usize| Key {
        session: format!("concurrent-{n}"),
        ..resident_key.clone()
    };
    for n in 0..49 {
        cache.begin(instance, &make(n)).unwrap().unwrap().publish();
    }
    assert_eq!(cache.stats()["sessions"], 50);
    assert!(cache.stats()["charged_bytes"].as_u64().unwrap() <= PROCESS_CAP as u64);
    let mut concurrent = Vec::new();
    for n in 0..32 {
        concurrent.push(cache.begin(instance, &make(n)).unwrap().unwrap());
    }
    assert_eq!(cache.stats()["charged_bytes"], PROCESS_CAP);
    assert_eq!(concurrent.len() * SESSION_CAP, PROCESS_CAP);
    for n in 32..50 {
        assert!(cache.begin(instance, &make(n)).is_err());
    }
    drop(concurrent);
    let lease = cache.begin(instance, &resident_key).unwrap().unwrap();
    assert!(
        lease.cold,
        "charged reservations must evict idle policy state"
    );
    drop(lease);
    insert(&sql, &key, &part(3));
    cache.load_for_test(&store, &key);
    let rebuilt = cache.begin(instance, &resident_key).unwrap().unwrap();
    assert!(!rebuilt.cold);
    assert_eq!(
        rebuilt.state.rebuilt_parts, 8,
        "eviction must rebuild appended authoritative policy rows"
    );
}
