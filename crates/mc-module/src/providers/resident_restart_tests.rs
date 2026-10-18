use super::*;

mod hook_isolation {
    include!("hook_isolation_tests.rs");
}

fn compartments() -> Vec<mc_store::StoredCompartment> {
    [(1,6),(7,12),(13,20)].into_iter().enumerate().map(|(index,(start,end))|mc_store::StoredCompartment {
        sequence:index as i64+1,start_message:start,end_message:end,end_message_id:format!("m{end}#0"),
        title:format!("history {index}"),content:"original history".into(),p1:Some("original history".into()),importance:50,
        ..Default::default()
    }).collect()
}

async fn seed(h:&McHandler,binding:&SessionBinding,store:&McStore) -> Value {
    answer(h.provider_setup(7, binding.clone(), &setup()).await);
    let first=answer(h.provider_step(7, binding.clone(), &step("initial",(1..=30).map(message).collect(),30)).await);
    store.replace_compartments("s",&compartments()).unwrap();
    store.arm_soft_refresh("s").unwrap();
    let mut request=step("first-fold",vec![],30);
    request["last_applied"]=json!({"compaction_id":first["compaction"]["compaction_id"],"version":first["compaction"]["version"]});
    answer(h.provider_step(7, binding.clone(), &request).await)
}

#[tokio::test]
async fn unchanged_reopen_primes_an_intact_cut_without_full_replay() {
    let dir=tempfile::tempdir().unwrap();
    let (h,binding,store,key)=handler(dir.path(),Arc::new(NoReads::default()));
    let h=h.with_startup_provider_resident_enabled(true);
    let view=seed(&h,&binding,&store).await;
    drop(h);drop(store);
    let (h,binding,store,_)=handler(dir.path(),Arc::new(NoReads::default()));
    let h=h.with_startup_provider_resident_enabled(true);
    store.arm_soft_refresh("s").unwrap();
    let mut request=step("reopened",vec![],30);
    request["last_applied"]=json!({"compaction_id":view["compaction"]["compaction_id"],"version":view["compaction"]["version"]});
    answer(h.provider_step(7, binding, &request).await);
    let lease=h.provider_resident.begin(store.tag_cache_namespace(),&key).unwrap().unwrap();
    assert_eq!(lease.state.fold_tail_passes,1,"an ordinary reopen must not replay native history");
    lease.publish();
}

#[tokio::test]
async fn hot_interior_structure_change_cannot_reuse_an_intact_cut_digest() {
    let dir=tempfile::tempdir().unwrap();
    let (h,binding,store,key)=handler(dir.path(),Arc::new(NoReads::default()));
    let h=h.with_startup_provider_resident_enabled(true);
    let view=seed(&h,&binding,&store).await;
    let mut rows=store.load_compartments("s").unwrap();rows[0].end_message=5;rows[0].end_message_id="m5#0".into();rows[1].start_message=6;
    store.replace_compartments("s",&rows).unwrap();store.arm_soft_refresh("s").unwrap();
    let mut request=step("hot-edit",vec![],30);
    request["last_applied"]=json!({"compaction_id":view["compaction"]["compaction_id"],"version":view["compaction"]["version"]});
    answer(h.provider_step(7, binding, &request).await);
    let lease=h.provider_resident.begin(store.tag_cache_namespace(),&key).unwrap().unwrap();
    assert_eq!(lease.state.fold_tail_passes,0,"a cached terminal boundary is not a proof of the unchanged interior");
    lease.publish();
}

#[tokio::test]
async fn compartment_writer_after_capture_forces_full_replay_on_the_next_fold() {
    let dir=tempfile::tempdir().unwrap();
    let (h,mut binding,store,_)=handler(dir.path(),Arc::new(NoReads::default()));
    let h=h.with_startup_provider_resident_enabled(true);
    let session="resident-race-capture";
    binding.session=session.into();
    let mut start=setup();start["session"]=json!(session);
    answer(h.provider_setup(7, binding.clone(), &start).await);
    let mut request=step("initial",(1..=30).map(message).collect(),30);request["session"]=json!(session);
    let first=answer(h.provider_step(7, binding.clone(), &request).await);
    store.replace_compartments(session,&compartments()).unwrap();store.arm_soft_refresh(session).unwrap();
    request=step("first",vec![],30);request["session"]=json!(session);
    request["last_applied"]=json!({"compaction_id":first["compaction"]["compaction_id"],"version":first["compaction"]["version"]});
    let view=answer(h.provider_step(7, binding.clone(), &request).await);
    let writer=store.clone();
    crate::transform::install_transform_attempt_hook(session,move|| {
        let mut rows=writer.load_compartments(session).unwrap();rows[0].p1=Some("writer changed content after source capture".into());
        writer.replace_compartments(session,&rows).unwrap();
    });
    store.arm_soft_refresh(session).unwrap();request["request_id"]=json!("race");
    request["last_applied"]=json!({"compaction_id":view["compaction"]["compaction_id"],"version":view["compaction"]["version"]});
    let raced=answer(h.provider_step(7, binding.clone(), &request).await);
    let key=Key::new(&binding,session,"opencode").unwrap();
    let lease=h.provider_resident.begin(store.tag_cache_namespace(),&key).unwrap().unwrap();
    assert!(lease.state.fold_source_raced,"the current source version must differ from the pre-read binding");lease.publish();
    store.arm_soft_refresh(session).unwrap();request["request_id"]=json!("after-race");
    if raced["answer"]=="compaction_message" {request["last_applied"]=json!({"compaction_id":raced["compaction"]["compaction_id"],"version":raced["compaction"]["version"]});}
    answer(h.provider_step(7, binding, &request).await);
    let lease=h.provider_resident.begin(store.tag_cache_namespace(),&key).unwrap().unwrap();
    assert_eq!(lease.state.fold_tail_passes,0,"the following fold must perform full validation");lease.publish();
}

#[tokio::test]
async fn interior_edit_with_equal_terminal_coverage_after_reopen_requires_full_replay() {
    let a=tempfile::tempdir().unwrap();let b=tempfile::tempdir().unwrap();
    let mut views=Vec::new();
    for (dir,resident) in [(a.path(),true),(b.path(),false)] {
        let (h,binding,store,_)=handler(dir,Arc::new(NoReads::default()));
        let h=h.with_startup_provider_resident_enabled(resident);
        views.push(seed(&h,&binding,&store).await);
    }
    let mut answers=Vec::new();
    for (index,(dir,resident)) in [(a.path(),true),(b.path(),false)].into_iter().enumerate() {
        let (h,binding,store,key)=handler(dir,Arc::new(NoReads::default()));
        let h=h.with_startup_provider_resident_enabled(resident);
        let mut rows=store.load_compartments("s").unwrap();
        rows[0].end_message=5;rows[0].end_message_id="m5#0".into();rows[1].start_message=6;
        store.replace_compartments("s",&rows).unwrap();
        assert_eq!(rows.last().unwrap().end_message,20,"the terminal endpoint is deliberately unchanged");
        store.arm_soft_refresh("s").unwrap();
        let mut request=step("interior-edit",vec![],30);
        request["last_applied"]=json!({"compaction_id":views[index]["compaction"]["compaction_id"],"version":views[index]["compaction"]["version"]});
        answers.push(answer(h.provider_step(7, binding, &request).await));
        if resident {
            let lease=h.provider_resident.begin(store.tag_cache_namespace(),&key).unwrap().unwrap();
            assert_eq!(lease.state.fold_tail_passes,0,"an equal terminal endpoint does not authorize an edited interior");
            lease.publish();
        }
    }
    assert_eq!(answers[0]["compaction"]["replacement"],answers[1]["compaction"]["replacement"]);
}

#[tokio::test]
async fn delete_merge_and_recomp_while_down_match_the_full_replay_provider() {
    for mutation in ["delete","merge","recomp"] {
        let a=tempfile::tempdir().unwrap();let b=tempfile::tempdir().unwrap();
        let mut views=Vec::new();
        for (dir,resident) in [(a.path(),true),(b.path(),false)] {
            let (h,binding,store,_)=handler(dir,Arc::new(NoReads::default()));
            let h=h.with_startup_provider_resident_enabled(resident);views.push(seed(&h,&binding,&store).await);
        }
        let mut answers=Vec::new();
        for (index,(dir,resident)) in [(a.path(),true),(b.path(),false)].into_iter().enumerate() {
            let (h,binding,store,key)=handler(dir,Arc::new(NoReads::default()));let h=h.with_startup_provider_resident_enabled(resident);
            let mut rows=store.load_compartments("s").unwrap();
            match mutation {
                "delete"=>rows.clear(),
                "merge"=>{rows[0].end_message=12;rows[0].end_message_id="m12#0".into();rows.remove(1);},
                _=>rows[0].p1=Some("recompiled history body".into()),
            }
            store.replace_compartments("s",&rows).unwrap();store.arm_soft_refresh("s").unwrap();
            let mut request=step(mutation,vec![],30);request["last_applied"]=json!({"compaction_id":views[index]["compaction"]["compaction_id"],"version":views[index]["compaction"]["version"]});
            answers.push(answer(h.provider_step(7, binding, &request).await));
            if resident {let lease=h.provider_resident.begin(store.tag_cache_namespace(),&key).unwrap().unwrap();assert_eq!(lease.state.fold_tail_passes,0,"{mutation} cannot be trusted after reopen");lease.publish();}
        }
        assert_eq!(answers[0]["answer"],answers[1]["answer"]);
        assert_eq!(answers[0]["compaction"]["replacement"],answers[1]["compaction"]["replacement"],"{mutation} must serve the full-replay bytes");
    }
}

#[tokio::test]
async fn appended_tail_invalidates_the_resident_source_and_hygiene_descriptors() {
    let a=tempfile::tempdir().unwrap();let b=tempfile::tempdir().unwrap();
    let (ha,ba,sa,key)=handler(a.path(),Arc::new(NoReads::default()));
    let ha=ha.with_startup_provider_resident_enabled(true);
    let (hb,bb,sb,_)=handler(b.path(),Arc::new(NoReads::default()));
    let hb=hb.with_startup_provider_resident_enabled(false);
    let mut views=[seed(&ha,&ba,&sa).await,seed(&hb,&bb,&sb).await];
    for (index,(h,binding,store)) in [(&ha,&ba,&sa),(&hb,&bb,&sb)].into_iter().enumerate() {
        store.arm_soft_refresh("s").unwrap();
        let mut request=step("prime",vec![],30);
        request["last_applied"]=json!({"compaction_id":views[index]["compaction"]["compaction_id"],"version":views[index]["compaction"]["version"]});
        let primed=answer(h.provider_step(7, binding.clone(), &request).await);
        if primed["answer"]=="compaction_message" {views[index]=primed;}
    }
    let mut answers=Vec::new();
    for (index,(h,binding,store)) in [(&ha,&ba,&sa),(&hb,&bb,&sb)].into_iter().enumerate() {
        let mut rows=store.load_compartments("s").unwrap();rows[0].p1=Some("changed history after appending".into());
        store.replace_compartments("s",&rows).unwrap();store.arm_soft_refresh("s").unwrap();
        let mut request=step("append",vec![message(31)],31);
        request["last_applied"]=json!({"compaction_id":views[index]["compaction"]["compaction_id"],"version":views[index]["compaction"]["version"]});
        answers.push(answer(h.provider_step(7, binding.clone(), &request).await));
    }
    assert_eq!(answers[0]["compaction"]["replacement"],answers[1]["compaction"]["replacement"]);
    let mut actual=serde_json::to_value(sa.load("s").unwrap().meta.tail_hygiene_baseline).unwrap();
    let mut expected=serde_json::to_value(sb.load("s").unwrap().meta.tail_hygiene_baseline).unwrap();
    actual.as_object_mut().unwrap().remove("computed_at_ms");expected.as_object_mut().unwrap().remove("computed_at_ms");
    assert_eq!(actual,expected,"appended source must be measured, not served from the old descriptor");
    let lease=ha.provider_resident.begin(sa.tag_cache_namespace(),&key).unwrap().unwrap();
    assert!(lease.state.fold_tail_passes>=2,"both the acknowledged prime and appended fold must use resident execution");
    lease.publish();
}

#[tokio::test]
async fn changed_tail_recipe_reconstruction_matches_the_served_treatment_bytes() {
    let dir=tempfile::tempdir().unwrap();
    let (h,binding,store,key)=handler(dir.path(),Arc::new(NoReads::default()));
    let h=h.with_startup_provider_resident_enabled(true);
    answer(h.provider_setup(7, binding.clone(), &setup()).await);
    let mut messages=(1..=30).map(message).collect::<Vec<_>>();
    messages[24]=json!({"ordinal":25,"mid":"m25","message":{"info":{"id":"m25","role":"assistant"},"parts":[
        {"id":"tool-part","type":"tool","tool":"bash","callID":"call-25","state":{"status":"completed","input":{"command":"inspect"},"output":"large spent tool output ".repeat(100)}}]}});
    let first=answer(h.provider_step(7, binding.clone(), &step("initial",messages,30)).await);
    store.replace_compartments("s",&compartments()).unwrap();store.arm_soft_refresh("s").unwrap();
    let mut request=step("first-fold",vec![],30);
    request["last_applied"]=json!({"compaction_id":first["compaction"]["compaction_id"],"version":first["compaction"]["version"]});
    let answer=answer(h.provider_step(7, binding, &request).await);
    let version=answer["compaction"]["version"].as_u64().unwrap();
    let mut view=crate::providers::view_recipe::load(&store,&key,version).unwrap().unwrap();
    let mut arena=crate::providers::resident_bytes::ByteArena::default();
    let previous=crate::providers::resident_view::ResidentView::store(&mut arena,&view,None,None).unwrap();
    let position=view.engine.replacement.iter().position(|message|message.meta.harness_id.as_deref()==Some("m25")).unwrap();
    for block in &mut view.engine.replacement[position].content {
        if let ck_wire::CkKind::ToolResult {output,..}=&mut block.kind {
            if let ck_wire::CkOutputKind::Text{text}=&mut output.kind {*text="changed rendered tool treatment".into();}
        }
    }
    view.engine.replacement[position].mark_modified();
    view.wire.replacement[position]["parts"][0]["state"]["output"]=json!("changed rendered tool treatment");
    view.engine.version+=1;view.wire.version=view.engine.version;
    let base=crate::providers::resident_view::AppliedView{view:&previous,arena:&arena};
    crate::providers::view_recipe::save_with_base(&store,&key,&view,"produced",Some(&base),None).unwrap();
    let rebuilt=crate::providers::view_recipe::load(&store,&key,view.engine.version).unwrap().unwrap();
    assert_eq!(rebuilt.wire.replacement,view.wire.replacement,"inherited treatments must not resurrect old output after reconstruction");
}


mod independent_review {
    include!("resident_independent_review_tests.rs");
}

mod independent_default_review {
    include!("resident_default_review_tests.rs");
}
