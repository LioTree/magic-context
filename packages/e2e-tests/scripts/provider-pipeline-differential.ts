/**
 * Offline comparison of the OpenCode provider and whole-history Rust paths.
 * No daemon, live OpenCode host or model credentials are needed.
 *
 * The adapter runs in this Bun process. A JSON-lines test executable invokes the
 * real McHandler in-process, with isolated stores. A fake transcript reader
 * counts every attempted session.read call, which must remain zero. Generated
 * test source uses the existing Rust test helpers in a build-directory copy;
 * production sources are never patched to expose or ship a test endpoint.
 *
 * Run: bun packages/e2e-tests/scripts/provider-pipeline-differential.ts
 * Select controls: --case OpenCode1/A9.tag-prepend --case OpenCode1/A7.single-bust
 */
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createScheduler } from "../../plugin/src/features/magic-context/scheduler";
import { runMigrations } from "../../plugin/src/features/magic-context/migrations";
import { initializeDatabase } from "../../plugin/src/features/magic-context/storage-db";
import { loadHostRunnerRecord } from "../../plugin/src/features/magic-context/storage-host-runner";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../plugin/src/features/magic-context/storage-meta";
import { createTagger } from "../../plugin/src/features/magic-context/tagger";
import { Database } from "../../plugin/src/shared/sqlite";
import { setLogLineForwarder } from "../../plugin/src/shared/logger";
import { StoreAheadOfBinaryError } from "../../plugin/src/hooks/magic-context/store-ahead-refusal";
import {
    createOpenCodeProviderTransform,
    OPENCODE_PROVIDER_BOOTSTRAP_BUDGET_MS,
    type OpenCodeProviderOptions,
} from "../../plugin/src/hooks/magic-context/host-runner/opencode-adapter";
import type { createRustModeTransform } from "../../plugin/src/hooks/magic-context/rust-mode-transform";
import {
    createTransform,
    type TransformDeps,
} from "../../plugin/src/hooks/magic-context/transform";
import { MagicContextConfigSchema } from "../../plugin/src/config/schema/magic-context";
import { resolveTransformMode } from "../../plugin/src/config/transform-mode";
import type { MessageLike } from "../../plugin/src/hooks/magic-context/transform-operations";
import { encodeOpenCodeMessagesToCk } from "../../plugin/src/hooks/magic-context/module-wire";
import { decodeProviderAnswer } from "../../plugin/src/hooks/magic-context/host-runner/provider-client";
import { adaptPayload } from "../../plugin/src/v2/hooks/payload";
import type { SessionContext } from "../../plugin/src/v2/hooks/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PREFIX = "PROVIDER_DRIVER=";
const logLines: string[] = [];
export const declaredDifferences = [
    "A3.race-tail: late user appends at the served tail, not the sorted position",
    "A3.unavailable-raw: unavailable hooks freeze raw bytes instead of LKG replay",
    "A3.switch-soft: switch equality is required only from a SOFT+ session",
] as const;

// Insert this source into a generated copy of the existing Rust tests module,
// where the isolated store and fake producer helpers are available. Provider
// files are linked to the originals, so deliberately corrupted production code
// is what the compiler sees during non-vacuity checks.
const DRIVER = String.raw`
#[test]
fn provider_pipeline_driver() {
    use std::io::{BufRead, Read, Write};
    use rusqlite::OptionalExtension;
    let _ = tracing_subscriber::fmt().with_writer(std::io::stderr).with_ansi(false).try_init();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    // Reading the command pipe must not park the SDK's control-plane runtime
    // between samples, when the caller may be inspecting fixture databases.
    let (commands, mut incoming) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            if commands.send(line).is_err() { break; }
        }
    });
    rt.block_on(async {
        #[derive(Default)]
        struct ReadTrap(std::sync::atomic::AtomicUsize);
        #[async_trait]
        impl session_resolver::ProviderRunner for ReadTrap {
            async fn call(&self, _: &Path, _: &str, _: &str, _: Value, _: Duration) -> Result<Value, SessionResolveError> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Err(SessionResolveError::Transport("unexpected session.read".into()))
            }
        }
        struct Rig {
            handler: Arc<McHandler>,
            store: Arc<McStore>,
            sql: rusqlite::Connection,
            _dir: Option<tempfile::TempDir>,
            binding: SessionBinding,
            reads: Arc<ReadTrap>,
            namespaces: HashMap<String,u16>,
            resident_enabled: bool,
            resident_process_cap: usize,
            commit_probe: Option<mc_store::commit_probe::Guard>,
        }
        let mut rigs: HashMap<String, Rig> = HashMap::new();
        let mut resident_pools:HashMap<String,Arc<crate::providers::resident_hooks::ResidentHooks>>=HashMap::new();
         let mut historian_budgets = HashMap::new();
        let transports = [Arc::new(crate::provider_transport_tests::Transport::start(false).await),
            Arc::new(crate::provider_transport_tests::Transport::start(true).await)];
        while let Some(line) = incoming.recv().await {
            let cmd: Value = serde_json::from_str(&line.unwrap()).unwrap();
            let name = cmd["rig"].as_str().unwrap_or("default");
            let op = cmd["op"].as_str().unwrap();
            if op == "quit" { break; }
            let value = if op == "drop" {
                rigs.remove(name);
                json!({"dropped":true})
            } else if op == "fault" {
                std::env::set_var("MC_PROVIDER_FAULT_POINT", cmd["point"].as_str().unwrap());
                json!({"armed":true})
            } else if op == "create" {
                let config = McModuleConfig {
                    inject_docs: false, memory_enabled: cmd["memory_enabled"] == true, temporal_awareness: false,
                    protected_tokens_user: Some(0), protected_tools: if cmd["protect_bash"] == true {BTreeMap::from([("bash".into(),2)])} else {BTreeMap::new()},
                    execute_threshold_percentage: 90.0, cache_ttl: "never".into(),
                    ..default_test_config()
                };
                let dir = if cmd["directory"].is_string() {None} else {Some(tempfile::tempdir().unwrap())};
                let root = cmd["directory"].as_str().map(PathBuf::from).unwrap_or_else(||dir.as_ref().unwrap().path().into());
                std::fs::create_dir_all(&root).unwrap();
                 let project = cmd["project_root"].as_str().map(PathBuf::from).unwrap_or_else(||root.join("project"));
                std::fs::create_dir_all(&project).unwrap();
                let store = Arc::new(McStore::open_for_test(&crate::test_support::descriptor(&root)).unwrap());
                let resident_enabled = cmd["resident_enabled"].as_bool().unwrap_or_else(|| std::env::var("MC_RESIDENT_HOOKS").as_deref() == Ok("1"));
                let startup_probe = (cmd["commit_probe"] == true).then(|| mc_store::commit_probe::Guard::install(store.clone()));
                mc_store::commit_probe::take();
                if let Some(ms) = cmd["wal_sync_delay_ms"].as_u64().filter(|ms| *ms > 0) {
                    mc_store::commit_probe::delay_next_wal_sync(Duration::from_millis(ms));
                }
                let startup_started = std::time::Instant::now();
                if resident_enabled && cmd["skip_wal_prime"] != true {
                    store.prime_wal_for_serving().unwrap();
                }
                let startup_ms = startup_started.elapsed().as_secs_f64() * 1000.0;
                let startup_io = mc_store::commit_probe::take();
                drop(startup_probe);
                let resident_process_cap=cmd["resident_process_cap_mb"].as_u64().map(|mb|mb.min(1024) as usize*1024*1024).unwrap_or(1024*1024*1024);
                let mut handler = McHandler::with_producer_factory_config_resolver(
                    Arc::new(TestProducerFactory {state:Arc::new(ProducerState::default())}),
                    config.clone(), Arc::new(MissingSessionResolver))
                     .with_startup_provider_resident_enabled(resident_enabled)
                     .with_startup_provider_resident_process_cap(resident_process_cap);
                if let Some(pool)=cmd["resident_pool"].as_str() {
                    handler.provider_resident=resident_pools.entry(pool.into()).or_insert_with(||
                        Arc::new(crate::providers::resident_hooks::ResidentHooks::enabled(resident_enabled).with_process_cap(resident_process_cap))).clone();
                }
                if let Some(concurrency) = cmd["historian_concurrency"].as_u64() {
                    handler.provider_historian_budget = historian_budgets.entry(concurrency).or_insert_with(||
                        crate::providers::historian_budget::Budget::new(concurrency as usize, 512)).clone();
                }
                handler.store.set(store.clone()).ok().unwrap();
                let binding = SessionBinding {
                    connection_incarnation: 0, native_generation: None, principal: None,
                    project_root: project, harness: cmd["harness"].as_str().unwrap().into(),
                    session: "session".into(), model_key: None, config,
                    history_budget_tokens: 100000.0,
                };
                handler.bind_route(7, binding.clone());
                handler.set_guidance_now_ms_for_test(1);
                let reads = Arc::new(ReadTrap::default());
                handler.provider_runner = reads.clone();
                let sql = rusqlite::Connection::open(root.join("store.db")).unwrap();
                let handler = Arc::new(handler);
                transports[usize::from(resident_enabled)].register(&format!("{name}-7"), handler.clone(), binding.clone());
                rigs.insert(name.into(), Rig {handler, store, sql, _dir: dir, binding, reads, namespaces:HashMap::new(), resident_enabled,resident_process_cap,commit_probe:None});
                json!({"created": true, "startup_ms": startup_ms, "startup_io": startup_io})
            } else if op == "concurrent_calls" {
                let calls = cmd["calls"].as_array().unwrap();
                let barrier = Arc::new(tokio::sync::Barrier::new(calls.len()));
                let submitted = std::time::Instant::now();
                let mut tasks = Vec::new();
                for call in calls {
                    let transport = Arc::clone(&transports[usize::from(rigs[call["rig"].as_str().unwrap()].resident_enabled)]);
                    let name = format!("{}-7", call["rig"].as_str().unwrap());
                    let body = call["body"].clone();
                    let kind = body["method"].clone();
                    let barrier = Arc::clone(&barrier);
                    tasks.push(tokio::spawn(async move {
                        barrier.wait().await;
                        let mut result = transport.call(&name, body).await;
                        result["kind"] = kind;
                        result["submitted_to_response_ms"] = json!(submitted.elapsed().as_secs_f64()*1000.0);
                        result
                    }));
                }
                let mut rows = Vec::new();
                for task in tasks { rows.push(tokio::time::timeout(Duration::from_secs(30), task).await.expect("concurrent call deadline").unwrap()); }
                json!({"rows":rows})
            } else {
                let rig = rigs.get_mut(name).expect("created rig");
                if op == "event" {
                    let namespace = cmd["namespace"].as_str().unwrap_or("session");
                    match cmd["event"].as_str().unwrap() {
                        "publish" => {
                            let mut rows = rig.store.load_compartments(namespace).unwrap();
                            let start = cmd["start"].as_i64().unwrap();
                            let end = cmd["end"].as_i64().unwrap();
                            rows.push(StoredCompartment {sequence: rows.len() as i64 + 1,
                                start_message: start, end_message: end,
                                end_message_id: format!("{}#0",cmd["mid"].as_str().unwrap()),
                                title: "offline publication".into(), content: "published history".into(),
                                p1: Some("published history".into()), importance:50, ..Default::default()});
                            rig.store.replace_compartments(namespace, &rows).unwrap();
                        },
                        "delete" => { rig.store.replace_compartments(namespace, &[]).unwrap(); },
                        "flush" => { rig.store.arm_soft_refresh(namespace).unwrap(); },
                        "resident_memory_delta" => {
                            let sample=cmd["sample"].as_i64().unwrap();
                            rig.store.seed_memory(100000+sample,rig.binding.project_root.to_str().unwrap(),"project",
                                &format!("Memory delta {sample}: preserve changed memory bytes"),50).unwrap();
                        },
                        "resident_retier" => {
                            let mut rows=rig.store.load_compartments(namespace).unwrap();
                            let sample=cmd["sample"].as_u64().unwrap() as usize;
                            let at=sample%rows.len();rows[at].importance=if sample%2==0 {1} else {100};
                            rig.store.replace_compartments(namespace,&rows).unwrap();
                        },
                        "realistic_seed" => {
                            let covered = cmd["covered"].as_i64().unwrap();
                            let count = cmd["compartments"].as_i64().unwrap();
                            let rows = (0..count).map(|i| {
                                let start = i * covered / count + 1;
                                let end = (i + 1) * covered / count;
                                StoredCompartment { sequence: i + 1, start_message: start, end_message: end,
                                    end_message_id: format!("synthetic-{}#0", end - 1),
                                    title: format!("Fixture compartment {i}"),
                                    content: format!("Completed investigation {i}: preserve the exact compartment ordering."),
                                    p1: Some(format!("Investigation {i} complete.")), importance: 50,
                                    ..Default::default() }
                            }).collect::<Vec<_>>();
                            rig.store.replace_compartments(namespace, &rows).unwrap();
                            for i in 1..=cmd["memories"].as_i64().unwrap() {
                                rig.store.seed_memory(i, rig.binding.project_root.to_str().unwrap(), "project",
                                    &format!("Fixture memory {i}: independently preserve memory ordering."), 50).unwrap();
                            }
                        },
                        "realistic_delta" | "realistic_visible_delta" => {
                            let mut rows = rig.store.load_compartments(namespace).unwrap();
                            let sample = cmd["sample"].as_u64().unwrap();
                            let at = if cmd["event"]=="realistic_visible_delta" {rows.len()-1-(sample as usize % 20)} else {sample as usize % rows.len()};
                            rows[at].content.push_str(&format!(" Delta {sample}."));
                            if let Some(p1) = &mut rows[at].p1 { p1.push_str(&format!(" Delta {sample}.")); }
                            rig.store.replace_compartments(namespace, &rows).unwrap();
                        },
                        "historian_start" | "historian_idle" => {
                            let mut loaded = rig.store.load(namespace).unwrap();
                            loaded.meta.historian.state = if cmd["event"] == "historian_start" {
                                HistorianPhase::AwaitingProducer
                            } else { HistorianPhase::Idle };
                            rig.store.commit(namespace, loaded.row_version, &loaded.core, &loaded.meta).unwrap();
                            if cmd["event"] == "historian_start" {
                                rig.handler.live_historian_sessions.lock().unwrap().insert(namespace.into(), LiveHistorianSession {token:Arc::new(()), completion:Arc::new(Notify::new())});
                            } else {
                                rig.handler.live_historian_sessions.lock().unwrap().remove(namespace);
                            }
                        },
                        other => panic!("unknown event {other}"),
                    }
                    json!({"changed":true})
                 } else if op == "settle" {
                     tokio::task::yield_now().await;
                      json!({"settled":true})
                 } else if op == "historian_mode" {
                     if cmd["held"] == true { std::env::set_var("MC_TEST_HISTORIAN_HOLD", "1"); }
                     else { std::env::remove_var("MC_TEST_HISTORIAN_HOLD"); }
                     json!({"held":cmd["held"]})
                 } else if op == "historian_requeue" {
                     for (name, rig) in &rigs {
                         if cmd["prefix"].as_str().is_some_and(|prefix| !name.starts_with(prefix)) { continue; }
                         let key = crate::providers::Key::new(&rig.binding, "session", &rig.binding.harness).unwrap();
                         if let Some(mut conversation) = rig.store.load_provider_conversation(&key.store_key()).unwrap() {
                             let mut counters: Value = serde_json::from_str(&conversation.hook_counters_json).unwrap();
                             counters["historian_evaluation_due"] = json!(true);
                             conversation.hook_counters_json = counters.to_string();
                             rig.store.save_provider_conversation(&key.store_key(), &conversation).unwrap();
                             rig.handler.schedule_provider_historian(rig.binding.clone(), key);
                         }
                     }
                     tokio::task::yield_now().await;
                     json!({"queued":true})
                } else if op == "reads" {
                    json!(rig.reads.0.load(Ordering::SeqCst))
                } else if op == "historian_stats" || op == "historian_drain" {
                    if op == "historian_drain" {
                        tokio::time::timeout(Duration::from_secs(120), async {
                            loop {
                                tokio::task::yield_now().await;
                                let stats = rig.handler.provider_historian_budget.stats();
                                if stats["active"] == 0 && stats["queued"] == 0
                                    && rig.handler.provider_historian_evaluations.lock().unwrap().is_empty() { break; }
                                tokio::time::sleep(Duration::from_millis(10)).await;
                            }
                        }).await.expect("historians drain within deadline");
                    }
                    rig.handler.provider_historian_budget.stats()
                } else if op == "resident_session_stats" {
                    let key = crate::providers::Key::new(&rig.binding, &rig.binding.session, &rig.binding.harness).unwrap();
                    rig.handler.provider_resident.session_stats(rig.store.tag_cache_namespace(), &key)
                } else if op == "resident_stats" {
                    rig.handler.provider_resident.stats()
                } else if op == "resident_slow_once" {
                    std::env::set_var("MC_RESIDENT_SLOW_REBUILD", "1");
                    json!({"armed":true})
                } else if op == "resident_clear_slow" {
                    std::env::remove_var("MC_RESIDENT_SLOW_REBUILD");
                    json!({"cleared":true})
                } else if op == "resident_lean_load" {
                    let original = mc_store::ProviderSessionKey { project_root:rig.binding.project_root.to_string_lossy().into(), session:"session".into(), harness:rig.binding.harness.clone(), generation:None };
                    let conversation = rig.store.load_provider_conversation(&original).unwrap().unwrap();
                    let from = rig.handler.provider_resident.stats()["sessions"].as_u64().unwrap();
                    for n in from..cmd["sessions"].as_u64().unwrap() {
                        let mut key = original.clone(); key.session = format!("lean-{n}");
                        rig.store.save_provider_conversation(&key, &conversation).unwrap();
                        let conv = key.conversation_key();
                        let tx = rig.sql.transaction().unwrap();
                        tx.execute("INSERT INTO mc_provider_lineages_v1 SELECT ?1,lineage_id,first_ordinal,descends_from,through_ordinal,?2 FROM mc_provider_lineages_v1 WHERE conv_key=?3", rusqlite::params![conv,key.session,original.conversation_key()]).unwrap();
                        tx.execute("INSERT INTO mc_provider_policy_parts_v1 SELECT ?1,lineage_id,ordinal,block_id,policy_json,?2 FROM mc_provider_policy_parts_v1 WHERE conv_key=?3", rusqlite::params![conv,key.session,original.conversation_key()]).unwrap();
                        tx.execute("INSERT INTO mc_provider_policy_summaries_v1 SELECT ?1,summary_json,?2 FROM mc_provider_policy_summaries_v1 WHERE conv_key=?3", rusqlite::params![conv,key.session,original.conversation_key()]).unwrap();
                        // Policy-only clones retain facts and their source identities;
                        // no native history body or materialized view is copied.
                        tx.execute("INSERT INTO mc_provider_messages_v1(conv_key,lineage_id,ordinal,mid,message_bytes,session,frozen_policy_format,frozen_policy_raw_bytes,frozen_policy_parts,frozen_policy_bytes) SELECT ?1,lineage_id,ordinal,mid,x'7b7d',?2,frozen_policy_format,frozen_policy_raw_bytes,frozen_policy_parts,frozen_policy_bytes FROM mc_provider_messages_v1 WHERE conv_key=?3 AND frozen_policy_format=1",rusqlite::params![conv,key.session,original.conversation_key()]).unwrap();
                        tx.execute("INSERT INTO mc_provider_policy_cuts_v1 SELECT ?1,cut_id,lineage_id,frozen_through_ordinal,frozen_part_count,baseline_json,defaults_json,prefix_totals_json,policy_key,?2 FROM mc_provider_policy_cuts_v1 WHERE conv_key=?3",rusqlite::params![conv,key.session,original.conversation_key()]).unwrap();
                        tx.execute("INSERT INTO mc_provider_policy_overrides_v1 SELECT ?1,source_lineage_id,block_id,ordinal,cut_id,override_json,?2 FROM mc_provider_policy_overrides_v1 WHERE conv_key=?3",rusqlite::params![conv,key.session,original.conversation_key()]).unwrap();
                        tx.commit().unwrap();
                        mc_tokenizer::estimate_tokens("resident tokenizer warmup");
                        rig.handler.provider_resident.load_for_test(&rig.store, &key);
                    }
                    rig.handler.provider_resident.stats()
                } else if op == "resident" {
                    let key = mc_store::ProviderSessionKey { project_root: rig.binding.project_root.to_string_lossy().into(), session: "session".into(), harness: rig.binding.harness.clone(), generation: None };
                    let authority = rig.store.read_provider_resident_authority(&key, 100000, 500, 128*1024*1024).unwrap();
                    let namespace = &authority.conversation.engine_namespace;
                    let loaded = rig.store.load(namespace).unwrap();
                    let membership = rig.store.resolve_workspace_membership(key.project_root.as_str()).unwrap();
                    let memory = rig.store.load_memory_render_snapshot(key.project_root.as_str(), membership.as_ref(), loaded.meta.expiry_cutoff_ms).unwrap();
                    let scores = rig.store.load_compartment_score_snapshot(namespace, mc_store::ScoreSelector::Latest).unwrap();
                    let tags = rig.store.load_tags_for_session(namespace).unwrap();
                    let answers = rig.store.load_provider_hook_answers(&key).unwrap();
                    let domains = json!({"engine":{"row_version":loaded.row_version,"core":loaded.core,"meta":loaded.meta},
                        "tags":tags.iter().map(|tag|json!({"number":tag.tag_number,"block_id":tag.block_id,"kind":tag.kind,"tokens":tag.token_count,"created_at_ms":tag.created_at_ms,"source_bytes":tag.source_bytes.as_ref()})).collect::<Vec<_>>(),
                        "memory":{"memories":memory.memories,"revisions":memory.revisions,"fragment_watermark":memory.fragment_watermark,
                            "project_paths":memory.revision.project_paths,"reader_project_path":memory.revision.reader_project_path,"expiry_cutoff_ms":memory.revision.expiry_cutoff_ms,"max_memory_id":memory.revision.max_memory_id,"mutation_cursor":memory.revision.mutation_cursor},
                        "compartments":scores.compartments,"scores":scores.importance_by_sequence,"score_watermark":scores.watermark,
                        "workspace":membership.as_ref().map(|m|json!({"union_identities":m.union_identities,"own_identity":m.own_identity,"share_categories":m.share_categories,"display_name_by_path":m.display_name_by_path})),
                        "answers":answers.iter().map(|a|json!({"lineage_id":a.lineage_id,"state":a.state,"ordinal":a.answer.ordinal,"ops_json":a.answer.ops_json,"tags":a.answer.tags,
                            "subject_mid":a.answer.subject.subject_mid,"hook":a.answer.subject.hook,"subject_part":a.answer.subject.subject_part})).collect::<Vec<_>>(),
                        "pending_drops":rig.store.load_provider_pending_drops(&key).unwrap()});
                    let importance = scores.importance_by_sequence.iter().map(|(k,v)|(*k,*v)).collect();
                    let started = std::time::Instant::now();
                    let resident = crate::providers::resident::ResidentState::build(&authority, &domains, &scores.compartments, &importance,
                        "offline-renderer-v1", "offline-tokenizer-v1", 128*1024*1024).unwrap();
                    let build_ms = started.elapsed().as_secs_f64()*1000.0;
                    let snapshot = resident.snapshot();
                    assert_eq!(snapshot["domains"], domains);
                    let conv = key.conversation_key();
                    // The oracle decodes physical facts without calling the new
                    // policy resolver, then applies the cut, overrides, ancestry
                    // and consumption independently before comparing every field.
                    let consumed = rig.sql.prepare("SELECT tag_number FROM mc_provider_consumed_tags_v1 WHERE engine_namespace=?1").unwrap()
                        .query_map([namespace], |r|r.get::<_,i64>(0)).unwrap().map(Result::unwrap).collect::<BTreeSet<_>>();
                    let mut expected = BTreeMap::<String,(usize,Value)>::new();
                    let mut q = rig.sql.prepare("SELECT lineage_id,ordinal,policy_json FROM mc_provider_policy_parts_v1 WHERE conv_key=?1").unwrap();
                    for row in q.query_map([&conv], |r|Ok((r.get::<_,String>(0)?,r.get::<_,u64>(1)?,r.get::<_,String>(2)?))).unwrap() {
                        let (lineage, ordinal, raw) = row.unwrap();
                        if let Some(depth) = authority.ancestry.iter().position(|(id,cut)|*id==lineage && ordinal<=*cut) {
                            let mut part: Value = serde_json::from_str(&raw).unwrap();
                            if part["tag_number"].as_i64().is_some_and(|n|consumed.contains(&n)) {part["active"]=json!(false);}
                            let id=part["block_id"].as_str().unwrap().to_string();
                            if expected.get(&id).is_none_or(|(held,_)|depth<*held) {expected.insert(id,(depth,part));}
                        }
                    }
                    let defaults: Option<String> = rig.sql.query_row("SELECT defaults_json FROM mc_provider_policy_cuts_v1 WHERE conv_key=?1 AND cut_id=(SELECT json_extract(hook_counters_json,'$.engine_policy.baseline_cut_id') FROM mc_provider_conversations_v2 WHERE conv_key=?1)",[&conv],|r|r.get(0)).optional().unwrap();
                    if let Some(defaults) = defaults {
                        let defaults: Value = serde_json::from_str(&defaults).unwrap();
                        let mut overrides = BTreeMap::<(String,String),Value>::new();
                        let mut q = rig.sql.prepare("SELECT source_lineage_id,block_id,override_json FROM mc_provider_policy_overrides_v1 WHERE conv_key=?1").unwrap();
                        for row in q.query_map([&conv], |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).unwrap() {
                            let (lineage,block,raw) = row.unwrap();
                            overrides.insert((lineage,block),serde_json::from_str(&raw).unwrap());
                        }
                        let mut q = rig.sql.prepare("SELECT lineage_id,ordinal,frozen_policy_bytes FROM mc_provider_messages_v1 WHERE conv_key=?1 AND frozen_policy_format=1").unwrap();
                        for row in q.query_map([&conv], |r|Ok((r.get::<_,String>(0)?,r.get::<_,u64>(1)?,r.get::<_,Vec<u8>>(2)?))).unwrap() {
                            let (lineage,ordinal,blob) = row.unwrap();
                            let Some(depth) = authority.ancestry.iter().position(|(id,cut)|*id==lineage && ordinal<=*cut) else {continue};
                            let mut raw=Vec::new();
                            flate2::read::ZlibDecoder::new(blob.as_slice()).read_to_end(&mut raw).unwrap();
                            for mut part in serde_json::from_slice::<Vec<Value>>(&raw).unwrap() {
                                assert_eq!(part["ordinal"],json!(ordinal));
                                if defaults["covered_measurements"]==json!(true) && part["kind"]!=json!("header") {
                                    part["measurement"]["kind"]=json!("excluded");
                                    part["measurement"]["tokens"]=json!(0);
                                    part["measurement"]["u_tokens"]=json!(0);
                                }
                                let id=part["block_id"].as_str().unwrap().to_string();
                                if let Some(patch)=overrides.get(&(lineage.clone(),id.clone())) {
                                    for (key,value) in patch.as_object().unwrap() {
                                        if key=="measurement" {for (field,value) in value.as_object().unwrap() {part[key][field]=value.clone();}}
                                        else {part[key]=value.clone();}
                                    }
                                }
                                if part["tag_number"].as_i64().is_some_and(|n|consumed.contains(&n)) {part["active"]=json!(false);}
                                if expected.get(&id).is_none_or(|(held,_)|depth<*held) {expected.insert(id,(depth,part));}
                            }
                        }
                    }
                    let mut expected = expected.into_values().map(|(_,part)|part).collect::<Vec<_>>();
                    expected.sort_by_key(|part|(part["ordinal"].as_u64().unwrap(),part["block_index"].as_i64().unwrap()));
                    assert_eq!(snapshot["parts"].as_array().unwrap().iter().map(|p|p["part"].clone()).collect::<Vec<_>>(),expected);
                    let full = rig.store.load_provider_messages(&key, &authority.conversation.lineage_id).unwrap();
                    let tail = full.iter().filter(|m|authority.coverage.is_none_or(|cut|m.ordinal>cut)).collect::<Vec<_>>();
                    assert_eq!(tail.len(),authority.tail.len());
                    for (at, message) in tail.iter().enumerate() {assert_eq!(snapshot["tail"][at]["native_bytes"],json!(message.message_bytes));}
                    assert_eq!(authority.policy_revision,rig.store.provider_policy_revision(namespace).unwrap());
                    json!({"parts":authority.parts.len(),"tail_blob_rows":authority.tail_blob_rows,"tail_bytes":authority.tail_blob_bytes,"fragments":snapshot["fragments"].as_array().unwrap().len(),
                        "memories":memory.memories.len(),"compartments":scores.compartments.len(),"retained_bytes":resident.retained_bytes(),"build_ms":build_ms,
                        "snapshot_sha256":mc_store::move_snapshot::digest(&serde_json::to_vec(&snapshot).unwrap()),"independent_parts_equal":true,"independent_tail_equal":true,"domains_equal":true,"policy_revision":authority.policy_revision})
                } else if op == "inspect" {
                    let state = rig.store.load("session").unwrap();
                    let tags = rig.store.load_tags_for_session("session").unwrap();
                    let queued = rig.store.load_pending_agent_drops("session").unwrap().into_iter().map(|d|json!({"tag_number":tags.iter().find(|t|t.block_id==d.target_id).unwrap().tag_number,"target_id":d.target_id,"status":"queued","first_applied":d.command_first_applied_at_ms.is_some()})).collect::<Vec<_>>();
                    json!({"pending":rig.store.load_pending_agent_drops("session").unwrap().into_iter().map(|d|d.target_id).collect::<Vec<_>>(),"queue":queued,"version":state.core.version,
                        "model":state.meta.last_model_key,"floor":state.meta.protected_tokens_effective,
                        "coverage":state.meta.coverage_ordinal,"protected_tools":state.meta.protected_tool_block_ids,
                        "units":state.core.frozen_units,"boundary_id":state.core.boundary_id,
                        "compartment_count":rig.store.load_compartments("session").unwrap().len()})
                } else if op == "restart" {
                    let mut h = McHandler::with_producer_factory_config_resolver(
                        Arc::new(TestProducerFactory {state: Arc::new(ProducerState::default())}),
                        rig.binding.config.clone(), Arc::new(MissingSessionResolver))
                        .with_startup_provider_resident_enabled(rig.resident_enabled)
                        .with_startup_provider_resident_process_cap(rig.resident_process_cap);
                    h.store.set(rig.store.clone()).ok().unwrap();
                    h.bind_route(7, rig.binding.clone());
                    h.set_guidance_now_ms_for_test(1);
                    h.provider_runner = rig.reads.clone();
                    for (namespace, channel) in &rig.namespaces {
                        h.bind_route(*channel, SessionBinding {session: namespace.clone(), ..rig.binding.clone()});
                    }
                     rig.handler = Arc::new(h);
                    transports[usize::from(rig.resident_enabled)].register(&format!("{name}-7"), rig.handler.clone(), rig.binding.clone());
                    json!({"restarted": true})
                 } else if op == "probe_on" {
                     assert!(rig.commit_probe.is_none());
                     rig.commit_probe = Some(mc_store::commit_probe::Guard::install(rig.store.clone()));
                     mc_store::commit_probe::take();
                     json!({"probe":true})
                 } else if op == "wal_prime_mode" {
                     rig.store.prepare_provider_wal();
                     rig.store.set_provider_wal_prime_for_test(cmd["enabled"] == true);
                     json!({"enabled":cmd["enabled"]})
                 } else if op == "wal_restart" {
                     rig.store.prepare_provider_wal();
                     rig.store.stall_provider_wal_for_test(true);
                     for _ in 0..1100 { rig.store.prime_wal_for_serving().unwrap(); }
                     rig.store.stall_provider_wal_for_test(false);
                     rig.store.finish_provider_wal();
                     rig.store.flush_provider_wal_for_test();
                     json!({"checkpoint":rig.store.provider_wal_checkpoint_for_test()})
                 } else if op == "wal_flush" {
                     rig.store.flush_provider_wal_for_test();
                     json!({"checkpoint":rig.store.provider_wal_checkpoint_for_test()})
                 } else if op == "autocheckpoint" {
                    let frames = cmd["frames"].as_u64().unwrap();
                    let sql = format!("PRAGMA wal_autocheckpoint={frames}");
                    rig.store.execute_tag_sql_for_test(&sql).unwrap();
                    rig.sql.execute_batch(&sql).unwrap();
                    json!({"serving_and_fixture_connections":frames})
                } else if op == "sql" {
                    (|| -> Result<Value, rusqlite::Error> {
                        let conn = &rig.sql;
                        if cmd["write"].as_bool() == Some(true) {
                            conn.execute_batch(cmd["sql"].as_str().unwrap()).unwrap();
                            return Ok(json!({"written":true}));
                        }
                        let mut q = conn.prepare(cmd["sql"].as_str().unwrap()).unwrap();
                        let cols = q.column_count();
                        let rows = q.query_map([], |row| {
                            Ok((0..cols).map(|i| {
                                use rusqlite::types::ValueRef;
                                match row.get_ref(i).unwrap() {
                                    ValueRef::Null => Value::Null,
                                    ValueRef::Integer(n) => json!(n),
                                    ValueRef::Real(n) => json!(n),
                                    ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                                    ValueRef::Blob(s) => json!(String::from_utf8_lossy(s)),
                                }
                            }).collect::<Vec<_>>())
                        }).unwrap().map(Result::unwrap).collect::<Vec<_>>();
                        Ok(json!(rows))
                    })().unwrap()
                } else {
                    let mut request = cmd["body"].clone();
                    let mut channel = 7;
                    if op == "full" {
                        let raw = cmd["messages"].as_array().unwrap();
                        request = json!({"kind":"transform","v":2,
                            "serializer_profile":"opencode-aisdk","serve_native":true,
                            "session_id":cmd["namespace"].as_str().unwrap_or("session"),
                            "render_config":format!("provider:openai|model:{}",cmd["model"].as_str().unwrap()), "messages":cmd["ingress"],
                            "native_messages":raw,"tool_present":true,
                            "protected_tokens_effective":0,
                            "auto_search_enabled":false,"now_ms":cmd["now"],
                            "model_key":cmd["model"],
                            "geometry":{"usable_soft":cmd["window"].as_u64().unwrap()*9/10,"usable_hard":cmd["window"].as_u64().unwrap()*95/100,
                                "absolute_wall":cmd["window"],"derivation":"provider-differential"},
                            "historian_model_chain":[]});
                        request["usage"] = json!({"current_total_input_tokens":0,"context_limit_tokens":cmd["window"]});
                        if let Some(extra) = cmd["extra"].as_object() {
                            request.as_object_mut().unwrap().extend(extra.clone());
                        }
                        let namespace = request["session_id"].as_str().unwrap();
                        if namespace != "session" {
                            channel = if let Some(ch) = rig.namespaces.get(namespace) { *ch } else {
                                let ch = rig.namespaces.len() as u16 + 8;
                                let binding = SessionBinding {session:namespace.into(), ..rig.binding.clone()};
                                rig.handler.bind_route(ch, binding.clone());
                                transports[usize::from(rig.resident_enabled)].register(&format!("{name}-{ch}"), rig.handler.clone(), binding);
                                rig.namespaces.insert(namespace.into(),ch);
                                ch
                            };
                        }
                    }
                    // Timing lanes enter through the SDK and the shipping adapter.
                    // Direct calls below remain a lexical-byte correctness oracle.
                    if cmd["timing"] == true {
                        let started = std::time::Instant::now();
                        let mut result = transports[usize::from(rig.resident_enabled)].call(&format!("{name}-{channel}"), request).await;
                        result["submitted_to_response_ms"] = json!(started.elapsed().as_secs_f64()*1000.0);
                        println!("PROVIDER_DRIVER={}", result);
                        std::io::stdout().flush().unwrap();
                        continue;
                    }
                    // Commit probes below check direct-dispatch correctness only;
                    // end-to-end timings always use the shipping transport above.
                    let _commit_probe = (cmd["commit_probe"] == true).then(|| mc_store::commit_probe::Guard::install(rig.store.clone()));
                    let correctness_probe = _commit_probe.is_some() || rig.commit_probe.is_some();
                    let historian_before = rig.handler.provider_historian_budget.stats();
                    if correctness_probe {
                        mc_store::commit_probe::take();
                        crate::providers::hook_probe::take();
                    }
                    let module_started = std::time::Instant::now();
                    let cpu_started = cpu_time::ProcessTime::now();
                    match rig.handler.dispatch_value(channel, request).await {
                        HandlerOutcome::Response(bytes) => {
                            if cmd["settle_tasks"] == true { tokio::task::yield_now().await; }
                            if correctness_probe {
                                let direct_dispatch_ms = module_started.elapsed().as_secs_f64()*1000.0;
                                let historian_after = rig.handler.provider_historian_budget.stats();
                                let historian_during = historian_before["active"] != 0 || historian_before["queued"] != 0
                                    || historian_after["active"] != 0 || historian_after["queued"] != 0
                                    || historian_after["completed"] != historian_before["completed"];
                                let raw = String::from_utf8(bytes).unwrap();
                                // The legacy WAL assertions read module_ms; both duration
                                // fields cover direct dispatch, never the shipping adapter.
                                let result = json!({"ok":serde_json::from_str::<Value>(&raw).unwrap(),"raw":raw,
                                    "correctness_probe":true,"measurement_kind":"direct_dispatch_wal_correctness",
                                    "direct_dispatch_ms":direct_dispatch_ms,"module_ms":direct_dispatch_ms,
                                    "historian_before":historian_before,"historian_after":historian_after,"historian_during":historian_during,
                                    "hook_stages":crate::providers::hook_probe::take(),"commit_probe":mc_store::commit_probe::take()});
                                println!("PROVIDER_DRIVER={}",result);
                                std::io::stdout().flush().unwrap();
                                continue;
                            }
                            if cmd["raw_response"] == true {
                                let raw = String::from_utf8(bytes).unwrap();
                                println!("PROVIDER_DRIVER={{\"ok\":{},\"raw\":{}}}",raw,serde_json::to_string(&raw).unwrap());
                                std::io::stdout().flush().unwrap();
                                continue;
                            }
                            // Forward the handler's exact response, without a
                            // second parse/serialize of large bootstrap views.
                            println!("PROVIDER_DRIVER={{\"ok\":{}}}",String::from_utf8(bytes).unwrap());
                            std::io::stdout().flush().unwrap();
                            continue;
                        },
                        HandlerOutcome::Error {code,message} => json!({"error":{"code":code,"message":message},"module_ms":module_started.elapsed().as_secs_f64()*1000.0,"cpu_ms":cpu_started.elapsed().as_secs_f64()*1000.0}),
                        HandlerOutcome::ErrorWithDetail {code,message,detail} => json!({"error":{"code":code,"message":message,"detail":detail}}),
                        other => panic!("unexpected outcome: {other:?}"),
                    }
                }
            };
            println!("PROVIDER_DRIVER={}", value);
            std::io::stdout().flush().unwrap();
        }
    });
}
`;

export function buildDriver(directory: string): string {
    directory = resolve(process.env.MC_PROVIDER_DRIVER_BUILD_DIR ?? directory);
    const link = (source: string, destination: string, type?: "dir") => {
        if (!existsSync(destination)) symlinkSync(source, destination, type);
    };
    const writeCurrent = (path: string, text: string) => {
        if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeFileSync(path, text);
    };
    const overlay = join(directory, "workspace");
    mkdirSync(join(overlay, "crates/mc-module/src"), { recursive: true });
    for (const file of ["Cargo.toml", "Cargo.lock"])
        writeCurrent(join(overlay, file), readFileSync(join(ROOT, file), "utf8"));
    for (const name of ["packages", "tests", "docs", "assets", "scripts", "testdata"])
        link(join(ROOT, name), join(overlay, name), "dir");
    for (const name of ["mc-core", "mc-tokenizer"])
        link(join(ROOT, "crates", name), join(overlay, "crates", name), "dir");
    // The generated test-driver workspace alone includes raw SQLite callbacks
    // for timing fsync and checkpoint I/O. Only its copied lib.rs relaxes the
    // unsafe-code prohibition; product sources remain unchanged.
    const storeOriginal = join(ROOT, "crates/mc-store");
    const storeGenerated = join(overlay, "crates/mc-store");
    if (existsSync(storeGenerated) && lstatSync(storeGenerated).isSymbolicLink()) rmSync(storeGenerated);
    mkdirSync(join(storeGenerated, "src"), { recursive: true });
    for (const name of readdirSync(storeOriginal)) {
        if (name !== "src") link(join(storeOriginal, name), join(storeGenerated, name));
    }
    for (const name of readdirSync(join(storeOriginal, "src"))) {
        if (name !== "lib.rs" && name !== "provider_wal.rs") link(join(storeOriginal, "src", name), join(storeGenerated, "src", name));
    }
    const storeLib = readFileSync(join(storeOriginal, "src/lib.rs"), "utf8");
    assert.equal(storeLib.split("#![forbid(unsafe_code)]").length, 2);
    const walGenerated = join(storeGenerated, "src/provider_wal.rs");
    if (existsSync(walGenerated) && lstatSync(walGenerated).isSymbolicLink()) rmSync(walGenerated);
    const walSource = readFileSync(join(storeOriginal, "src/provider_wal.rs"), "utf8");
    assert.equal(walSource.split("use cortexkit_store::SqliteStore;").length, 2);
    writeCurrent(walGenerated, walSource.replace("use cortexkit_store::SqliteStore;", "use crate::commit_probe::ObservedStore as SqliteStore;"));
    assert.equal(storeLib.split("open_sqlite, Migration, SqliteStore, StoreError").length, 2);
    assert.equal(storeLib.split("inner: Arc::new(inner)").length, 2);
    writeCurrent(join(storeGenerated, "src/lib.rs"), storeLib.replace("#![forbid(unsafe_code)]", "")
        .replace("open_sqlite, Migration, SqliteStore, StoreError", "open_sqlite, Migration, StoreError")
        .replace("inner: Arc::new(inner)", "inner: Arc::new(commit_probe::ObservedStore::new(inner))") +
        '\nuse commit_probe::ObservedStore as SqliteStore;\n' +
        `\n#[path = ${JSON.stringify(join(ROOT, "packages/e2e-tests/scripts/provider-commit-probe.rs"))}]\npub mod commit_probe;\n`);
    const original = join(ROOT, "crates/mc-module");
    const generated = join(overlay, "crates/mc-module");
    for (const name of readdirSync(original)) {
        if (name !== "src") link(join(original, name), join(generated, name));
    }
    // Reinstall a live link even when reusing an overlay: a Rust mutation must
    // compile the mutated source, not a cached source surrogate.
    const transformPath = join(generated, "src/transform.rs");
    if (existsSync(transformPath)) rmSync(transformPath);
    for (const name of readdirSync(join(original, "src"))) {
        if (name !== "lib.rs") link(join(original, "src", name), join(generated, "src", name));
    }
    const lib = readFileSync(join(original, "src/lib.rs"), "utf8");
    assert.equal(lib.split("mod tests {").length, 2, "unique Rust test-module insertion seam");
    const driverPath = join(generated, "src/provider_pipeline_driver.rs");
    writeCurrent(driverPath, DRIVER);
    writeCurrent(
        join(generated, "src/lib.rs"),
        lib.replace("mod tests {", `mod tests {\ninclude!(${JSON.stringify(driverPath)});`),
    );
    const target = resolve(process.env.CARGO_TARGET_DIR ?? join(ROOT, "target"));
    const built = spawnSync(
        "cargo",
        [
            "test",
            "--locked",
            "-p",
            "mc-module",
            "--lib",
            "--no-run",
            "--features",
            "drive-fault",
            "--message-format=json",
        ],
        {
            // Keep real wire deadlines enabled even for the 7.5k fixture. An
            // optimized test executable avoids measuring debug-code overhead as a
            // provider outage; this oracle does not claim production timings.
            cwd: overlay,
            env: { ...process.env, CARGO_TARGET_DIR: target, CARGO_PROFILE_TEST_OPT_LEVEL: "3" },
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
        },
    );
    const artifacts = built.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    if (built.status !== 0)
        throw new Error(
            `Rust test driver build failed\n${built.stderr}\n${artifacts
                .filter((a) => a.reason === "compiler-message")
                .map((a) => a.message.rendered)
                .join("\n")}`,
        );
    const binary = artifacts.find(
        (a) => a.reason === "compiler-artifact" && a.target.name === "mc_module" && a.executable,
    )?.executable;
    assert.ok(binary, "Cargo must report the real mc-module test executable");
    return binary;
}

export class Driver {
    concurrentTimingFleetCalls = 0;
    private child;
    private lines;
    private stderr;
    private killPoint?: string;
    private killed = false;
    readonly faults: string[] = [];
    readonly preparationOutcomes: { request_id: string; consumed: boolean }[] = [];
    readonly preparationCompletions: { request_id: string; prepared: boolean; preparation_ms: number }[] = [];
    readonly moduleCompletions: { request_id: string; method: string; module_ms: number }[] = [];
    get wasKilled() {
        return this.killed;
    }
    get pid() {
        return this.child.pid;
    }
    proveIsolation(): void {
        const opened = spawnSync("lsof", ["-p", `${process.pid},${this.pid}`, "-Fn"], { encoding: "utf8" });
        assert.equal(opened.status, 0, `lsof must prove fixture isolation: ${opened.stderr}`);
        const stores = opened.stdout.split("\n").filter(line => line.startsWith("n") && /\.db(?:-wal|-shm)?(?: \(deleted\))?$/.test(line));
        assert.ok(stores.length > 0, "lsof must observe the fixture stores");
        assert.ok(stores.every(line => line.slice(1).startsWith(`${this.directory}/`)), `store outside scratch root: ${stores.join("\n")}`);
        console.error(`PROVIDER_ISOLATION ${JSON.stringify({ root: this.directory, stores })}`);
    }
    constructor(
        readonly binary: string,
        readonly directory: string,
    ) {
        this.child = Bun.spawn(
            [
                ...(process.env.MC_COMMIT_STRACE_OUT ? ["strace", "-f", "-ttt", "-T", "-yy", "-e",
                    "trace=fsync,fdatasync,ftruncate", "-o", `${process.env.MC_COMMIT_STRACE_OUT}.${Date.now()}`] : []),
                binary,
                "--exact",
                "tests::provider_pipeline_driver",
                "--nocapture",
                "--test-threads=1",
            ],
            {
                cwd: ROOT,
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
                env: {
                    ...process.env,
                    TMPDIR: directory,
                    MC_PROVIDER_FAULT_POINT: "",
                    MC_DRIVE_FAULT: "",
                },
            },
        );
        this.lines = this.readLines();
        this.stderr = this.readErrors();
    }
    private async readErrors() {
        const reader = this.child.stderr.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = pending.indexOf("\n")) >= 0) {
                const line = pending.slice(0, end);
                pending = pending.slice(end + 1);
                const point = /MC_PROVIDER_FAULT_REACHED (\w+)/.exec(line)?.[1];
                if (point) {
                    this.faults.push(point);
                    if (point === this.killPoint) {
                        this.killed = true;
                        this.child.kill("SIGKILL");
                    }
                } else {
                    if (line.includes("provider hook preparation outcome")) {
                        const request = /request_id="([^"]+)"/.exec(line)?.[1];
                        const consumed = /preparation_consumed=(true|false)/.exec(line)?.[1];
                        if (request && consumed) this.preparationOutcomes.push({ request_id: request, consumed: consumed === "true" });
                    }
                    if (line.includes("provider module complete")) {
                        const request = /request_id="([^"]+)"/.exec(line)?.[1];
                        const method = /method="([^"]+)"/.exec(line)?.[1];
                        const ms = /module_ms=([0-9.eE+-]+)/.exec(line)?.[1];
                        if (request && method && ms) this.moduleCompletions.push({ request_id: request, method, module_ms: Number(ms) });
                    }
                    if (line.includes("provider policy preparation complete")) {
                        const request = /request_id=([^ }]+)/.exec(line)?.[1];
                        const prepared = /prepared=(true|false)/.exec(line)?.[1];
                        const ms = /preparation_ms=([0-9.eE+-]+)/.exec(line)?.[1];
                        if (request && prepared && ms) this.preparationCompletions.push({ request_id: request, prepared: prepared === "true", preparation_ms: Number(ms) });
                    }
                    if (process.env.MC_PROVIDER_DRIVER_QUIET !== "1" || line.includes("panicked at")) process.stderr.write(`${line}\n`);
                }
            }
        }
    }
    async arm(point: string) {
        this.killPoint = point;
        await this.send({ op: "fault", point });
    }
    private async *readLines() {
        const reader = this.child.stdout.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = pending.indexOf("\n")) >= 0) {
                const line = pending.slice(0, end);
                pending = pending.slice(end + 1);
                // libtest may put its test-name prefix on the first reply line.
                const start = line.indexOf(PREFIX);
                if (start >= 0) yield JSON.parse(line.slice(start + PREFIX.length));
            }
        }
    }
    async send(command: Record<string, unknown>): Promise<any> {
        if (this.killed) throw new Error(`Rust driver killed at ${this.killPoint}`);
        if (command.op === "concurrent_calls") this.concurrentTimingFleetCalls++;
        this.child.stdin.write(`${JSON.stringify(command)}\n`);
        await this.child.stdin.flush();
        const reply = await this.lines.next();
        assert.equal(reply.done, false, `Rust driver stopped (command ${command.op})`);
        return reply.value;
    }
    async close() {
        if (!this.killed) {
            this.child.stdin.write('{"op":"quit"}\n');
            this.child.stdin.end();
        }
        const code = await this.child.exited;
        await this.stderr;
        if (!this.killed) assert.equal(code, 0, "Rust driver exit");
    }
}

type Host = "OpenCode1" | "OpenCode2";
type Wire = { method: string; params: Record<string, any> };
function canonical<T>(value: T): T {
    if (Array.isArray(value)) return value.map(canonical) as T;
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, canonical(v)]),
        ) as T;
    return value;
}
export function message(id: string, role = "user", text = `café 🦀 \"${id}\"\n`) {
    return canonical({
        info: {
            id,
            role,
            sessionID: "session",
            model: { providerID: "openai", modelID: "gpt-5.6" },
            time: { created: 1, completed: 2 },
        },
        parts: [{ id: `${id}-text`, type: "text", text }],
    }) as MessageLike;
}
export function tools(id: string, repeated = false): MessageLike {
    const m = message(id, "assistant", "assistant response");
    for (const n of [1, 2])
        m.parts.push(
            canonical({
                id: `${id}-tool-${n}`,
                type: "tool",
                tool: "bash",
                callID: repeated ? "shared-call" : `${id}-call-${n}`,
                state: { status: "completed", input: {}, output: "tool output" },
            }) as any,
        );
    return canonical(m);
}
const bytes = (messages: MessageLike[]) => messages.map((m) => JSON.stringify(m));
function prefix(before: string[], after: string[]) {
    assert.deepEqual(after.slice(0, before.length), before, "served byte prefix");
}

let serial = 0;
export async function fixture(driver: Driver, host: Host, directory?: string, protectBash = false, memoryEnabled = false, residentEnabled?: boolean) {
    const rig = `${host}-${++serial}`;
    const harness = host === "OpenCode1" ? "opencode" : "opencode2";
    await driver.send({ op: "create", rig, harness, directory, protect_bash: protectBash, memory_enabled: memoryEnabled, resident_enabled: residentEnabled });
    const oracleRig = `${rig}-full`;
    await driver.send({
        op: "create",
        rig: oracleRig,
        harness,
        protect_bash: protectBash,
        memory_enabled: memoryEnabled,
        directory: directory ? join(directory, "oracle") : undefined,
    });
    driver.proveIsolation();
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    getOrCreateSessionMeta(db, "session");
    const wires: Wire[] = [];
    const answers: any[] = [];
    const callTimes: { method: string; ms: number }[] = [];
    const callErrors: unknown[] = [];
    const recorded: string[][] = [];
    const fullDecisions: { rig: string; action: unknown }[] = [];
    const logStart = logLines.length;
    const fallbacks: (string | undefined)[] = [];
    let now = 1000;
    let unavailable = false;
    let intercept: ((wire: Wire, reply: any, signal?: AbortSignal) => unknown) | undefined;
    const sql = (sql: string, write = false) => driver.send({ op: "sql", rig, sql, write });
    const call = async (body: unknown) => {
        const reply = await driver.send({ op: "call", rig, body });
        if (reply.error) {
            callErrors.push(reply.error);
            console.error(
                `HANDLER_ERROR ${rig} ${JSON.stringify(body).slice(0, 300)} ${JSON.stringify(reply.error)}`,
            );
            throw Object.assign(new Error(reply.error.message), reply.error);
        }
        return reply.ok;
    };
    const deps: TransformDeps = {
        db,
        transformMode: "rust",
        rustPipeline: "provider",
        storeGeneration: host === "OpenCode1" ? "v1" : "v2",
        tagger: createTagger(),
        scheduler: createScheduler({ executeThresholdPercentage: 90 }),
        contextUsageMap: new Map(),
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 50,
        directory: "/provider-differential",
        rustModeModuleClient: {
            async call(args) {
                if (unavailable) throw new Error("Injected module unavailable");
                const w = (
                    args.body instanceof Uint8Array
                        ? JSON.parse(new TextDecoder().decode(args.body))
                        : args.body
                ) as Wire;
                wires.push(w);
                const started = performance.now();
                const reply = await call(w);
                callTimes.push({ method: w.method, ms: Math.round(performance.now() - started) });
                answers.push(reply);
                return intercept ? (intercept(w, reply, args.signal) ?? reply) : reply;
            },
        },
    };
    const fullFrom = async (
        target: string,
        input: MessageLike[],
        namespace?: string,
        extra?: Record<string, unknown>,
    ) => {
        const model = String(extra?.model_key ?? "openai/gpt-5.6");
        const window = getOrCreateSessionMeta(db, "session").lastUsageContextLimit || 200000;
        const reply = await driver.send({
            op: "full",
            rig: target,
            messages: input,
            ingress: encodeOpenCodeMessagesToCk(input),
            namespace,
            now,
            model,
            window,
            extra,
        });
        assert.ok(!reply.error, `full-request handler refused: ${JSON.stringify(reply.error)}`);
        assert.equal(
            reply.ok.status,
            "ok",
            `full-request handler status: ${JSON.stringify(reply.ok)}`,
        );
        assert.ok(Array.isArray(reply.ok.native_messages), "real full-request native output");
        fullDecisions.push({ rig: target, action: reply.ok.action });
        return reply.ok.native_messages as MessageLike[];
    };
    const full = (input: MessageLike[], namespace?: string, extra?: Record<string, unknown>) =>
        fullFrom(rig, input, namespace, extra);
    const state = {
        moduleGeneration: 0,
        lastAckedSeq: 0,
        lastAckedWatermarks: null,
        idOrdinalMemoGeneration: 0,
        idOrdinalMemo: new Map(),
        ordinalMemoCheckpoints: [],
        ordinalContinuationBase: 0,
    };
    const legacy = { getState: () => state } as unknown as ReturnType<
        typeof createRustModeTransform
    >;
    const options: OpenCodeProviderOptions = {
        now: () => now,
        persisted: (_s, id) => !id.startsWith("unpersisted"),
        resolveOrdinals: async (args) => ({
            ok: true,
            annotatedInput: args.messages.map((m, i) => ({
                ...m,
                absolute_ordinal: (m.info as any).absolute_ordinal ?? i + 1,
            })),
            memoGeneration: 0,
            memoAnchor: null,
            memoStoredCount: args.messages.length,
            memoCanonicalCount: args.messages.length,
            normalizations: [],
            stats: { mode: "memo", pages: 0, rowsRead: 0, rewinds: 0 },
        }),
        sync: async (_id, _state, complete) => {
            // Fixture events already write the authoritative store. With no
            // host watermark delta, sync is no_change; only a no-hook pass needs
            // the real handler's content-free pass barrier. Sending an empty
            // authority snapshot here would erase the seeded state, not sync it.
            if (complete)
                await call({
                    kind: "state_sync",
                    session_id: "session",
                    pass_complete: true,
                    historian_model_chain: [],
                });
        },
        historian: { pump: async () => {}, stop: async () => {} },
        marker: async () => {},
        fullRequest: async (_id, input, output, _meta, namespace) => {
            fallbacks.push(namespace);
            output.messages = await full(input, namespace);
        },
    };
    let adapter = createOpenCodeProviderTransform(deps, legacy, options);
    return {
        host,
        binary: driver.binary,
        driverDirectory: driver.directory,
        get moduleDriver() {
            return driver;
        },
        db,
        deps,
        wires,
        answers,
        callTimes,
        callErrors,
        recorded,
        fallbacks,
        fullDecisions,
        rig,
        sql,
        call,
        full,
        fullFrom,
        logs: () => logLines.slice(logStart),
        async event(event: string, details: Record<string, unknown> = {}) {
            await driver.send({ op: "event", rig, event, ...details });
            await driver.send({ op: "event", rig: oracleRig, event, ...details });
        },
        async noReads() {
            assert.equal(await driver.send({ op: "reads", rig }), 0, "zero session.read calls");
        },
        inspect: () => driver.send({ op: "inspect", rig }),
        oldInspect: () => driver.send({ op: "inspect", rig: oracleRig }),
        rustControl(name: string) {
            const run = spawnSync(driver.binary, ["--exact", name, "--nocapture"], {
                cwd: ROOT,
                encoding: "utf8",
                maxBuffer: 8 * 1024 * 1024,
            });
            assert.equal(run.status, 0, `${name}\n${run.stdout}\n${run.stderr}`);
            assert.match(
                run.stdout,
                /1 passed; 0 failed/,
                "one real Rust control, not an empty filter",
            );
        },
        old: (input: MessageLike[], extra?: Record<string, unknown>) =>
            fullFrom(oracleRig, input, undefined, extra),
        async oldCall(body: unknown) {
            const reply = await driver.send({ op: "call", rig: oracleRig, body });
            assert.ok(!reply.error, `old pipeline call refused: ${JSON.stringify(reply.error)}`);
            return reply.ok;
        },
        stored: () => loadHostRunnerRecord(db, { session_id: "session", harness }),
        get adapter() {
            return adapter;
        },
        setUnavailable(value: boolean) {
            unavailable = value;
        },
        setIntercept(value?: typeof intercept) {
            intercept = value;
        },
        advance(ms: number) {
            now += ms;
        },
        async restartHost() {
            adapter.dispose();
            adapter = createOpenCodeProviderTransform(deps, legacy, options);
        },
        restartModule: () => driver.send({ op: "restart", rig }),
        async reopenModule(next: Driver) {
            assert.ok(directory, "persistent root is required for a process restart");
            await driver.close();
            driver = next;
            await driver.send({ op: "create", rig, harness, directory, protect_bash: protectBash });
            await driver.send({
                op: "create",
                rig: oracleRig,
                harness,
                protect_bash: protectBash,
                directory: join(directory, "oracle"),
            });
        },
        async pass(input: MessageLike[]) {
            const output = { messages: [] as unknown[] };
            await adapter.run("session", input, output, getOrCreateSessionMeta(db, "session"));
            const served = output.messages as MessageLike[];
            // This is the recording fake provider's boundary, not a reconstruction
            // from the runner tables. Assertions always consume what was served.
            recorded.push(bytes(served));
            return served;
        },
        async timedPass(input: MessageLike[]) {
            let assignmentMs: number | undefined;
            let served: unknown[] = [];
            const started = performance.now();
            Object.defineProperty(served, "splice", { value: function(this: unknown[], ...args: [number, number, ...unknown[]]) {
                const removed = Array.prototype.splice.apply(this, args);
                assignmentMs = performance.now() - started;
                return removed;
            } });
            const output = {
                get messages() { return served; },
                set messages(value: unknown[]) {
                    served = value;
                    assignmentMs = performance.now() - started;
                },
            };
            await adapter.run("session", input, output, getOrCreateSessionMeta(db, "session"));
            assert.ok(assignmentMs !== undefined, "measured pass must assign output.messages");
            return { pass_ms: assignmentMs, messages: served as MessageLike[] };
        },
        async close() {
            adapter.dispose();
            db.close();
            if (!driver.wasKilled) {
                await driver.send({ op: "drop", rig });
                await driver.send({ op: "drop", rig: oracleRig });
            }
        },
    };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Case = { name: string; run: (f: Fixture) => Promise<void> };
const faultPoints = [
    "SetupRecorded",
    "MessagesIngested",
    "AnswerRecorded",
    "HookStateRecorded",
    "WaitAnswered",
    "WaitWorkDurable",
] as const;
async function moduleCrashCase(parent: Fixture, point: (typeof faultPoints)[number]) {
    const root = join(parent.driverDirectory, `crash-${parent.host}-${point}-${++serial}`);
    const child = new Driver(parent.binary, parent.driverDirectory);
    const f = await fixture(child, parent.host, root);
    const raw = [message("base")];
    let before = bytes(await f.full(raw));
    await f.full(raw);
    try {
        const bootstrap = ["SetupRecorded", "MessagesIngested", "AnswerRecorded"].includes(point);
        if (!bootstrap) {
            await f.pass(raw);
            before = f.recorded.at(-1)!;
        }
        if (point.startsWith("Wait")) {
            f.setUnavailable(true);
            raw.push(message("tail"));
            await f.pass(raw);
            f.setUnavailable(false);
            before = f.recorded.at(-1)!;
        }
        await child.arm(point);
        if (point.startsWith("Wait")) {
            const stored = f.stored()!;
            const view = stored.views[0];
            const plan = JSON.parse(stored.state.plan_json!);
            await assert.rejects(
                f.call({
                    method: "compaction.step",
                    params: {
                        session: "session",
                        harness: parent.host === "OpenCode1" ? "opencode" : "opencode2",
                        request_id: `fault-${point}`,
                        lineage_id: stored.state.lineage_id,
                        preset: plan.preset,
                        params: plan.params,
                        model: "openai/gpt-5.6",
                        step_id: "wait-cut",
                        step_kind: "model",
                        context_window: 200000,
                        estimate: { request_tokens: 0 },
                        newest: { ordinal: 2, mid: "tail" },
                        now: 1000,
                        served_through_ordinal: 2,
                        after_ordinal: 1,
                        last_applied: { compaction_id: view.compaction_id, version: view.version },
                        messages: [{ ordinal: 2, mid: "tail", message: raw[1] }],
                        more: true,
                    },
                }),
                /Rust driver/,
            );
        } else if (point === "HookStateRecorded") {
            raw.push(message("tail"));
            await f.pass(raw);
            prefix(before, f.recorded.at(-1)!);
            before = f.recorded.at(-1)!;
        } else {
            const count = f.recorded.length;
            await assert.rejects(f.pass(raw), /safely serve|Rust driver killed/);
            assert.equal(f.recorded.length, count, "unrecorded bootstrap answer never served");
        }
        assert.deepEqual(child.faults, [point], "real durable cut reached before SIGKILL");
        await f.reopenModule(new Driver(parent.binary, parent.driverDirectory));
        f.advance(5000);
        await f.restartHost();
        if (!bootstrap) raw.push(message("confirm"));
        const restored = await f.pass(raw);
        prefix(before, bytes(restored));
        f.deps.historyRefreshSessions.add("session");
        await f.pass(raw);
        if (point === "HookStateRecorded") {
            assert.equal(
                (await f.sql("SELECT COUNT(*) FROM mc_tags WHERE tag_number=2"))[0][0],
                0,
                "answer lost at the cut was never promoted",
            );
            const refused = await f.call({ name: "ctx_reduce", arguments: { drop: "2" } });
            assert.equal(refused.isError, true, "lost answer's number remains unknown");
        }
        await f.noReads();
    } finally {
        await f.close();
        await f.moduleDriver.close();
        rmSync(root, { recursive: true, force: true });
    }
}
const cases: Case[] = [
    {
        name: "A12.question-answer-policy-survives-native-projection",
        async run(f) {
            let answer: MessageLike;
            if (f.deps.storeGeneration === "v2") {
                const draft: SessionContext = {
                    sessionID: "session", model: { providerID: "openai", id: "gpt-5.6" },
                    agent: "build", system: [], tools: {}, options: {},
                    messages: [
                        { id: "answer", role: "assistant", content: [{ type: "tool-call", id: "question-call", name: "question", input: {} }] },
                        { role: "tool", content: [{ type: "tool-result", id: "question-call", name: "question", result: { type: "text", value: "keep-user-answer ".repeat(20000) } }] },
                    ],
                } as SessionContext;
                answer = adaptPayload(draft).messages[0] as MessageLike;
            } else {
                answer = tools("answer");
                answer.parts.pop();
                (answer.parts[1] as any).tool = "question";
                (answer.parts[1] as any).state.output = "keep-user-answer ".repeat(20000);
                (answer.parts[1] as any).state.metadata = { userAnswer: true, diagnostics: "display-only-diagnostic" };
            }
            const ordinary = tools("ordinary");
            ordinary.parts.pop();
            (ordinary.parts[1] as any).tool = "question";
            (ordinary.parts[1] as any).state.output = "reclaimable-output ".repeat(10000);
            const recent = tools("recent");
            for (const part of recent.parts.slice(1)) (part as any).tool = "question";
            const raw = [message("base"), answer, ordinary, message("turn"), recent, message("latest")];
            await f.full(raw);
            await f.full(raw);
            await f.pass(raw);
            f.deps.contextUsageMap.set("session", { usage: { inputTokens: 195000 } } as any);
            raw.push(message("switch"));
            (raw.at(-1)!.info as any).model = { providerID: "openai", modelID: "new-model" };
            const served = await f.pass(raw);
            const output = (id: string) => served.find((message) => message.info.id === id)?.parts
                .filter((part: any) => part.type === "tool").map((part: any) => part.state.output).join("") ?? "";
            assert.ok(output("answer").includes("keep-user-answer"), "the answer must survive automatic reclaim");
            assert.ok(!output("ordinary").includes("reclaimable-output"), "ordinary output must be reclaimed in the same HARD pass");
            assert.ok(!JSON.stringify(served).includes("display-only-diagnostic"), "diagnostics must never be served or stored");
        },
    },
    {
        name: "T2.timing-boundary",
        async run(f) {
            const input = [message("timed-first")];
            await f.pass(input);
            input.push(message("timed-second"));
            const sample = await f.timedPass(input);
            assert.ok(Number.isFinite(sample.pass_ms) && sample.pass_ms >= 0);
            assert.ok(sample.messages.some(m => m.info.id === "timed-second"));
            assert.equal(f.recorded.length, 1, "timing does not include corpus serialization");
            assert.equal(f.fallbacks.length, 0, "timing sample must reach the provider path");
            const noAppend = await f.timedPass(input);
            assert.deepEqual(bytes(noAppend.messages), bytes(sample.messages));
        },
    },
    ...faultPoints.map((point) => ({
        name: `A6.S3-${point}`,
        run: (f: Fixture) => moduleCrashCase(f, point),
    })),
    {
        name: "A3.full-request-differential",
        async run(f) {
            const raw = [message("base")];
            for (let warm = 0; warm < 2; warm++) {
                assert.deepEqual(
                    bytes(await f.full(raw)),
                    bytes(await f.old(raw)),
                    "same starting full-request stores",
                );
            }
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(await f.old(raw)),
                "SOFT+ pipeline switch",
            );
            for (let pass = 0; pass < 8; pass++) {
                raw.push(message(`u${pass}`), tools(`a${pass}`));
                assert.deepEqual(
                    bytes(await f.pass(raw)),
                    bytes(await f.old(raw)),
                    `append/tool-loop differential pass ${pass}`,
                );
            }
            f.deps.historyRefreshSessions.add("session");
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(await f.old(raw, { flush_requested: true })),
                "flush replacement differential",
            );
        },
    },
    {
        name: "A3.race-tail",
        async run(f) {
            const raw = [message("u1"), message("a1", "assistant"), message("a2", "assistant")];
            await f.full(raw);
            await f.full(raw);
            await f.old(raw);
            await f.old(raw);
            const before = await f.pass(raw);
            const incoming = [raw[0], raw[1], message("X"), raw[2], message("a3", "assistant")];
            const served = await f.pass(incoming);
            prefix(bytes(before), bytes(served));
            assert.deepEqual(
                served.filter((m) => m.info.id).map((m) => m.info.id),
                ["u1", "a1", "a2", "X", "a3"],
            );
            const old = await f.old(incoming);
            assert.deepEqual(
                old.filter((m) => m.info.id).map((m) => m.info.id),
                ["u1", "a1", "X", "a2", "a3"],
                "old pipeline sorted-position control",
            );
            assert.equal(f.stored()!.state.ordinal_divergence, 1);
        },
    },
    {
        name: "A3.unavailable-raw",
        async run(f) {
            const raw = [message("base")];
            const before = await f.pass(raw);
            f.setUnavailable(true);
            for (const id of ["offline1", "offline2"]) {
                const m = message(id);
                raw.push(m);
                const out = await f.pass(raw);
                prefix(bytes(before), bytes(out));
                assert.equal(
                    JSON.stringify(out.at(-1)),
                    JSON.stringify(m),
                    "unavailable pass freezes new raw bytes, not an LKG",
                );
            }
            assert.ok(f.stored()!.entries.every((e) => e.ingested === 0));
            f.setUnavailable(false);
            f.deps.historyRefreshSessions.add("session");
            await f.pass(raw);
            assert.deepEqual(
                f.wires
                    .filter((w) => w.method === "compaction.step")
                    .at(-1)!
                    .params.messages.map((m: any) => m.mid),
                ["offline1", "offline2"],
            );
        },
    },
    {
        name: "A3.switch-soft",
        async run(f) {
            const raw = [message("u"), tools("a")];
            await f.full(raw);
            await f.old(raw);
            const soft = await f.full(raw);
            assert.deepEqual(bytes(soft), bytes(await f.old(raw)), "independent SOFT+ stores");
            const switched = await f.pass(raw);
            assert.deepEqual(bytes(switched), bytes(soft));
            raw.push(tools("post-switch"));
            const appended = await f.pass(raw);
            f.deps.historyRefreshSessions.add("session");
            const rebuilt = await f.pass(raw);
            for (const m of rebuilt.filter(
                (m) => m.info.id === "a" || m.info.id === "post-switch",
            )) {
                assert.equal(
                    JSON.stringify(m),
                    JSON.stringify(appended.find((p) => p.info.id === m.info.id)),
                    "replacement equals hook-served bytes",
                );
                for (const p of m.parts as any[]) {
                    const text = p.type === "tool" ? p.state.output : p.text;
                    assert.equal(
                        [...text.matchAll(/§\d+§/g)].length,
                        1,
                        "one engine/hook tag per block after switch",
                    );
                }
            }
        },
    },
    {
        name: "A3.publication-veto-opportunities",
        async run(f) {
            const raw = [message("base"), message("old1"), message("old2"), message("latest")];
            for (const [i, m] of raw.entries()) (m.info as any).absolute_ordinal = i + 1;
            await f.event("publish", { start: 1, end: 1, mid: "base" });
            await f.full(raw);
            await f.full(raw);
            await f.old(raw);
            await f.old(raw);
            const historical = [...raw];
            // The baseline summary covers ordinal 1 ("base"), which the host has
            // removed from its input window. Remaining rows retain ordinals 2-4.
            raw.shift();
            await f.pass(raw);
            await f.event("publish", { start: 2, end: 3, mid: "old2" });
            const count = f.wires.filter((w) => w.method === "compaction.step").length;
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(await f.old(historical)),
                "historian publish below threshold stays frozen",
            );
            assert.equal(
                f.wires.filter((w) => w.method === "compaction.step").length,
                count,
                "publication is not an opportunity",
            );
            await f.event("historian_start");
            await f.event("flush");
            f.deps.historyRefreshSessions.add("session");
            const active = await f.pass(raw);
            const oldActive = await f.old(historical, { flush_requested: true });
            assert.deepEqual(
                bytes(active),
                bytes(oldActive),
                "step while historian in-flight agrees with full path",
            );
            await f.event("historian_idle");
            await f.event("flush");
            f.deps.historyRefreshSessions.add("session");
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(await f.old(historical, { flush_requested: true })),
                "flush folds published history",
            );
            await f.event("delete");
            await f.event("flush");
            f.db.exec(
                "INSERT INTO m0_mutation_log (session_id,mutation_type,queued_at) VALUES ('session','compartment_delete',1)",
            );
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(await f.old(historical, { flush_requested: true })),
                "dashboard delete folds on next pass",
            );
        },
    },
    {
        name: "A3.drops-threshold-ttl-model",
        async run(f) {
            const raw = [
                message("base"),
                tools("a"),
                message("turn1"),
                tools("recent"),
                message("latest"),
            ];
            (raw[1].parts[1] as any).state.output = "spent output ".repeat(10000);
            (raw[1].parts[2] as any).state.output = "second spent output ".repeat(10000);
            await f.full(raw);
            await f.full(raw);
            await f.old(raw);
            await f.old(raw);
            await f.pass(raw);
            const drop = {
                name: "ctx_reduce",
                arguments: { session_id: "session", command_id: "queue-differential", drop: "3" },
            };
            const queued = await f.call(drop);
            assert.equal(queued.isError, false);
            assert.deepEqual(queued.content, [{ text: "1 tag stamped.", type: "text" }]);
            assert.deepEqual(
                (await f.inspect()).pending,
                ["a#2"],
                "pre-switch tag uses the full-request durable target queue",
            );
            const oldAck = await f.oldCall(drop);
            assert.equal(
                oldAck.isError,
                false,
                `full-request control recognizes the same pre-switch tag: ${JSON.stringify(oldAck)}`,
            );
            await f.oldCall({
                kind: "agent_drops.append",
                session_id: "session",
                command_id: "queue-differential",
                drop: "3",
            });
            const count = f.wires.filter((w) => w.method === "compaction.step").length;
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(await f.old(raw)),
                "queued drops cannot rewrite a warm prefix",
            );
            assert.equal(f.wires.filter((w) => w.method === "compaction.step").length, count);
            f.deps.contextUsageMap.set("session", { usage: { inputTokens: 185000 } } as any);
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(
                    await f.old(raw, {
                        usage: { current_total_input_tokens: 185000, context_limit_tokens: 200000 },
                    }),
                ),
                "threshold crossing differential",
            );
            f.deps.contextUsageMap.delete("session");
            updateSessionMeta(f.db, "session", { cacheTtl: "5m", lastResponseTime: 2000 });
            f.advance(400000);
            const cold = await f.pass(raw);
            assert.deepEqual(
                bytes(cold),
                bytes(
                    await f.old(raw, {
                        cache_ttl: "5m",
                        prev_response_completed_at_ms: 2000,
                        request_observed_at_ms: 401000,
                    }),
                ),
                "TTL-expiry differential",
            );
            raw.push(message("switch"));
            (raw.at(-1)!.info as any).model = { providerID: "openai", modelID: "changed-model" };
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(
                    await f.old(raw, {
                        model_key: "openai/changed-model",
                        prefix_rebuilding: { reason: "model_switch" },
                    }),
                ),
                "model-switch differential",
            );
            assert.equal(
                (await f.inspect()).model,
                "openai/changed-model",
                "current step model is adopted",
            );
            assert.deepEqual(
                (await f.inspect()).pending,
                [],
                "queued drop applied on the independently permitted HARD",
            );
        },
    },
    {
        name: "A3.model-switch-protected-newest-tool-queue",
        async run(f) {
            const old = tools("old");
            old.parts.pop();
            (old.parts[1] as any).state.output = "spent historical output ".repeat(10000);
            const raw = [message("base"), old, message("turn"), tools("recent"), message("latest")];
            for (let i = 0; i < 2; i++) {
                await f.full(raw);
                await f.old(raw);
            }
            await f.pass(raw);
            assert.equal(
                (await f.call({ name: "ctx_reduce", arguments: { drop: "7" } })).isError,
                false,
            );
            await f.oldCall({
                kind: "agent_drops.append",
                session_id: "session",
                command_id: "model-only-drop",
                drop: "7",
            });
            const before = await f.inspect();
            assert.ok(
                before.protected_tools.includes("recent#4"),
                "keep-latest-two bash outputs protects the newest tool result",
            );
            raw.push(message("switch"));
            (raw.at(-1)!.info as any).model = { providerID: "openai", modelID: "new-model" };
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(await f.old(raw, { model_key: "openai/new-model" })),
                "queued pre-switch drop on current-model HARD",
            );
            const actual = await f.inspect();
            const expected = await f.oldInspect();
            assert.deepEqual(
                actual.queue,
                expected.queue,
                "same tag numbers, order, and queued/applied status on the protected newest-tool window",
            );
            assert.deepEqual(actual.pending, ["recent#4"]);
            assert.equal(actual.model, expected.model);
            assert.equal(f.fullDecisions.at(-1)!.action, "HARD");
            assert.ok(
                actual.version > before.version,
                "model eviction executed HARD even though a protected tag stays queued",
            );
        },
    },
    {
        name: "A1.append-first-serve",
        async run(f) {
            const input = [message("base")];
            await f.pass(input);
            let previous = f.recorded.at(-1)!;
            const first = new Map<string, string>();
            for (let pass = 0; pass < 12; pass++) {
                for (let i = 0; i <= pass % 3; i++)
                    input.push(message(`m-${pass}-${i}`, i === 1 ? "assistant" : "user"));
                const served = await f.pass(input);
                const current = f.recorded.at(-1)!;
                prefix(previous, current);
                for (const m of served) {
                    const id = m.info.id;
                    if (!id) continue;
                    if (first.has(id))
                        assert.equal(JSON.stringify(m), first.get(id), `first-serve ${id}`);
                    else first.set(id, JSON.stringify(m));
                }
                previous = current;
            }
            assert.equal(
                f.wires.filter((w) => w.method === "compaction.step").length,
                1,
                "only bootstrap produces a view",
            );
        },
    },
    {
        name: "A1.known-content-unread",
        async run(f) {
            const input = [message("base"), message("known")];
            await f.pass(input);
            const appended = message("tail");
            await f.pass([...input, appended]);
            const previous = f.recorded.at(-1)!;
            const poisonous = {
                info: appended.info,
                get parts(): never {
                    throw new Error("known message was read or re-serialized");
                },
            } as MessageLike;
            await f.pass([...input, poisonous, message("next")]);
            prefix(previous, f.recorded.at(-1)!);
            assert.equal(f.stored()!.entries.length, 2);
        },
    },
    {
        name: "A9.tag-prepend",
        async run(f) {
            await f.pass([message("base")]);
            const served = await f.pass([message("base"), tools("assistant")]);
            const hooks = f.wires.filter(
                (w) => w.method === "transform.hook" && w.params.subject_mid === "assistant",
            );
            assert.equal(hooks.length, 3, "text and two tool subjects");
            assert.equal(
                new Set(hooks.map((w) => JSON.stringify(w.params.message))).size,
                1,
                "byte-identical ingest on every subject",
            );
            const m = served.find((m) => m.info.id === "assistant")!;
            for (const p of m.parts as any[]) {
                const text = p.type === "tool" ? p.state.output : p.text;
                assert.match(text, /^§\d+§ /, `one tag prepend in ${p.id}`);
                assert.equal([...text.matchAll(/§\d+§/g)].length, 1, "not a doubled tag");
            }
            await f.pass([message("base"), tools("assistant"), message("confirm")]);
            const counts = await f.sql(
                "SELECT state,COUNT(*) FROM mc_provider_hook_answers_v1 GROUP BY state",
            );
            assert.ok(
                counts.some(([state, n]: any[]) => state === "live" && n >= 3),
                "all three subjects live after next call",
            );
            const ingests = await f.sql(
                "SELECT COUNT(*) FROM mc_provider_messages_v1 WHERE mid='assistant'",
            );
            assert.equal(ingests[0][0], 1, "one ingest for three subjects");
        },
    },
    {
        name: "A5.raw-tail-revert",
        async run(f) {
            const base = message("base");
            await f.pass([base]);
            const tail = [message("a"), message("b"), message("c")];
            const before = await f.pass([base, ...tail]);
            const oldLineage = f.stored()!.state.lineage_id;
            const after = await f.pass([base, tail[0], message("replacement")]);
            prefix(
                bytes(
                    before.slice(
                        0,
                        before.findIndex((m) => m.info.id === "b"),
                    ),
                ),
                bytes(after),
            );
            assert.ok(!after.some((m) => ["b", "c"].includes(m.info.id!)), "reverted ids absent");
            assert.notEqual(f.stored()!.state.lineage_id, oldLineage);
            const ingests = await f.sql(
                "SELECT mid,COUNT(*) FROM mc_provider_messages_v1 GROUP BY mid",
            );
            assert.ok(
                ingests.every(([, n]: any[]) => n === 1),
                "descent never ingests an ancestor twice",
            );
        },
    },
    {
        name: "A5.covered-revert-fails-closed",
        async run(f) {
            const raw = [message("a"), message("b"), message("c")];
            await f.pass(raw);
            assert.equal(f.stored()!.entries.length, 0, "view pruned every raw entry");
            await f.restartHost();
            f.setUnavailable(true);
            await assert.rejects(f.pass(raw.slice(0, 1)), /cannot safely serve/i);
            assert.equal(f.stored()!.views[0].state, "invalidated");
            assert.equal(f.recorded.length, 1, "invalidated output never reaches fake provider");
            f.setUnavailable(false);
            const after = await f.pass(raw.slice(0, 1));
            assert.ok(!after.some((m) => ["b", "c"].includes(m.info.id!)));
            const reverts = f.wires.filter(
                (w) =>
                    w.method === "compaction.step" &&
                    w.params.prefix_rebuilding?.reason === "revert",
            );
            assert.equal(reverts.length, 1, "exactly one answered revert rebuild");
        },
    },
    {
        name: "A6.host-and-module-restart",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            raw.push(tools("a"));
            await f.pass(raw);
            const before = f.recorded.at(-1)!;
            const calls = f.wires.length;
            await f.restartHost();
            await f.pass(raw);
            assert.deepEqual(f.recorded.at(-1), before, "restart hydrates first-serve bytes");
            assert.equal(f.wires.length, calls, "no provider request on hydrated replay");
            await f.restartModule();
            raw.push(message("next"));
            await f.pass(raw);
            prefix(before, f.recorded.at(-1)!);
        },
    },
    {
        name: "A6.hook-answer-before-durable-append",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            f.db.exec(
                "CREATE TEMP TRIGGER kill_append BEFORE INSERT ON host_runner_entries BEGIN SELECT RAISE(ABORT,'host stopped before durable append'); END",
            );
            raw.push(tools("uncommitted"));
            const answerStart = f.answers.length;
            await assert.rejects(f.pass(raw), /cannot safely serve/);
            assert.equal(f.stored()!.entries.length, 0, "failed append never commits or serves");
            const burned = f.answers
                .slice(answerStart)
                .flatMap((a) =>
                    (a.ops ?? []).flatMap((op: any) => /^§(\d+)§ /.exec(op.text ?? "")?.[1] ?? []),
                );
            assert.equal(burned.length, 3, "three stranded hook answers");
            assert.equal(
                (
                    await f.sql("SELECT COUNT(*) FROM mc_tags WHERE block_id LIKE 'uncommitted#%'")
                )[0][0],
                0,
            );
            f.db.exec("DROP TRIGGER kill_append");
            await f.restartHost();
            const out = await f.pass(raw);
            const text = JSON.stringify(out.find((m) => m.info.id === "uncommitted"));
            for (const number of burned)
                assert.ok(!text.includes(`§${number}§`), "retry burns the earlier answer");
            f.deps.historyRefreshSessions.add("session");
            const rebuilt = JSON.stringify(await f.pass(raw));
            for (const number of burned)
                assert.ok(
                    !rebuilt.includes(`§${number}§`),
                    "rebuild renders only committed answers",
                );
        },
    },
    {
        name: "A6.module-ahead-descent",
        async run(f) {
            const base = message("base");
            await f.pass([base]);
            const lineage = f.stored()!.state.lineage_id;
            f.db.exec(
                "CREATE TEMP TRIGGER kill_append BEFORE INSERT ON host_runner_entries BEGIN SELECT RAISE(ABORT,'host stopped before durable append'); END",
            );
            await assert.rejects(f.pass([base, message("X"), message("Y")]), /cannot safely serve/);
            f.db.exec("DROP TRIGGER kill_append");
            await f.restartHost();
            const out = await f.pass([base, message("Z"), message("X"), message("Y")]);
            assert.notEqual(
                f.stored()!.state.lineage_id,
                lineage,
                "ordinal conflict descends through committed prefix",
            );
            assert.deepEqual(
                out.filter((m) => m.info.id).map((m) => m.info.id),
                ["base", "Z", "X", "Y"],
            );
            const rehook = f.wires.filter(
                (w) => w.method === "transform.hook" && w.params.descends_from,
            );
            assert.ok(rehook.length > 0);
            assert.ok(
                rehook.every((w) => w.params.served_through_ordinal <= 1),
                "no module-ahead answer confirmed",
            );
            f.deps.historyRefreshSessions.add("session");
            await f.pass([base, message("Z"), message("X"), message("Y")]);
            const pendingAncestor = await f.sql(
                `SELECT COUNT(*) FROM mc_provider_hook_answers_v1 WHERE lineage_id='${lineage}' AND state='live'`,
            );
            assert.equal(pendingAncestor[0][0], 0, "stranded ancestor answers never live");
        },
    },
    {
        name: "A6.rebuild-commit-order",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            raw.push(message("tail"));
            await f.pass(raw);
            const held = f.stored()!.views[0].replacement_json;
            await f.event("publish", { start: 1, end: 1, mid: "base" });
            f.db.exec(
                "CREATE TEMP TRIGGER kill_view BEFORE INSERT ON host_runner_views BEGIN SELECT RAISE(ABORT,'host stopped before view commit'); END",
            );
            f.deps.historyRefreshSessions.add("session");
            await assert.rejects(f.pass(raw), /cannot safely serve/);
            assert.equal(
                f.stored()!.views[0].replacement_json,
                held,
                "unrecorded answer never served",
            );
            assert.ok(f.stored()!.state.issued_request_id, "request fence already durable");
            f.db.exec("DROP TRIGGER kill_view");
            await f.restartHost();
            f.setUnavailable(true);
            const replayed = await f.pass(raw);
            assert.ok(
                replayed.some((m) => m.info.id === "tail"),
                "committed entries survive failed view commit",
            );
            f.setUnavailable(false);
            f.deps.historyRefreshSessions.add("session");
            await f.pass(raw);
        },
    },
    {
        name: "A7.single-bust",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            raw.push(message("next"));
            await f.pass(raw);
            const count = f.wires.filter((w) => w.method === "compaction.step").length;
            await f.event("publish", { start: 1, end: 1, mid: "base" });
            f.deps.historyRefreshSessions.add("session");
            await f.pass(raw);
            assert.equal(
                f.wires.filter((w) => w.method === "compaction.step").length,
                count + 1,
                "one opportunity call per pass",
            );
            assert.equal(f.stored()!.views.length, 2, "only one new applied view");
            const a = f.answers.at(-1);
            assert.equal(a.answer, "compaction_message");
            await f.pass(raw);
            assert.equal(
                f.wires.filter((w) => w.method === "compaction.step").length,
                count + 1,
                "no ordinary bust",
            );
        },
    },
    {
        name: "A7.exhaustive-fast-path",
        async run(f) {
            for (const test of [
                "fast_path_exhaustive_six_input_table_never_skips_an_opportunity",
                "fast_path_never_skips_any_engine_hard_or_soft_classifier_trigger",
            ])
                f.rustControl(`providers::compaction::host_tests::${test}`);
        },
    },
    {
        name: "A9.partial-timeout-status",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            f.setIntercept((w) => {
                if (w.method === "transform.hook" && w.params.hook === "post_tool")
                    throw new Error("Injected timeout after module commit");
            });
            const m = tools("partial");
            raw.push(m);
            const served = await f.pass(raw);
            assert.equal(
                JSON.stringify(served.find((m) => m.info.id === "partial")),
                JSON.stringify(m),
                "whole message freezes raw",
            );
            assert.equal(f.stored()!.entries[0].ingested, 0);
            f.setIntercept();
            raw.push(message("next"));
            await f.pass(raw);
            assert.deepEqual(
                JSON.parse(f.stored()!.state.unserved_json),
                [],
                "answered call clears burns",
            );
            const live = await f.sql(
                "SELECT COUNT(*) FROM mc_provider_hook_answers_v1 WHERE subject_mid='partial' AND state='live'",
            );
            assert.equal(live[0][0], 0, "no partially served answer becomes live");
            f.deps.historyRefreshSessions.add("session");
            await f.pass(raw);
            const status = f.wires.filter((w) => w.method === "compaction.step").at(-1)!;
            assert.deepEqual(
                status.params.messages.map((m: any) => m.mid),
                ["partial"],
                "only timed-out message in status",
            );
        },
    },
    {
        name: "A9.repeated-call-id-subjects",
        async run(f) {
            await f.pass([message("base")]);
            f.db.exec(
                "CREATE TEMP TRIGGER kill_append BEFORE INSERT ON host_runner_entries BEGIN SELECT RAISE(ABORT,'host stopped before durable append'); END",
            );
            await assert.rejects(
                f.pass([message("base"), tools("same-call", true)]),
                /cannot safely serve/,
            );
            f.db.exec("DROP TRIGGER kill_append");
            const hooks = f.wires.filter(
                (w) => w.method === "transform.hook" && w.params.hook === "post_tool",
            );
            assert.equal(hooks.length, 2);
            assert.equal(hooks[0].params.tool_call_id, hooks[1].params.tool_call_id);
            assert.notEqual(hooks[0].params.subject_part, hooks[1].params.subject_part);
            const firstTags = JSON.parse(
                (
                    await f.sql(
                        "SELECT tags_json FROM mc_provider_hook_answers_v1 WHERE subject_part='same-call-tool-1'",
                    )
                )[0][0],
            );
            const secondTags = (
                await f.sql(
                    "SELECT tags_json FROM mc_provider_hook_answers_v1 WHERE subject_part='same-call-tool-2'",
                )
            )[0][0];
            await f.call({ ...hooks[0], params: { ...hooks[0].params, request_id: "repeat-one" } });
            const afterSecond = (
                await f.sql(
                    "SELECT tags_json FROM mc_provider_hook_answers_v1 WHERE subject_part='same-call-tool-2' AND state='pending'",
                )
            )[0][0];
            assert.equal(
                afterSecond,
                secondTags,
                "retrying one part does not burn the sibling with the same callID",
            );
            const afterFirst = JSON.parse(
                (
                    await f.sql(
                        "SELECT tags_json FROM mc_provider_hook_answers_v1 WHERE subject_part='same-call-tool-1' AND state='pending'",
                    )
                )[0][0],
            );
            assert.notDeepEqual(
                afterFirst,
                firstTags,
                "retry mints a new answer for only that subject",
            );
            assert.equal(
                (
                    await f.sql(
                        "SELECT COUNT(*) FROM mc_provider_hook_answers_v1 WHERE subject_part='same-call-tool-1' AND state='burned'",
                    )
                )[0][0],
                1,
            );
        },
    },
    {
        name: "A9.identical-users-status-frontier",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            raw.push(message("user1", "user", "continue"), message("user2", "user", "continue"));
            await f.pass(raw);
            const tags = await f.sql(
                "SELECT subject_mid,tags_json FROM mc_provider_hook_answers_v1 WHERE hook='pre_user' ORDER BY subject_mid",
            );
            assert.deepEqual(
                tags.map(([id]: any[]) => id),
                ["user1", "user2"],
            );
            assert.notEqual(
                tags[0][1],
                tags[1][1],
                "identical text retains distinct subject answers",
            );
            f.deps.historyRefreshSessions.add("session");
            await f.pass(raw);
            const status = f.wires.filter((w) => w.method === "compaction.step").at(-1)!.params;
            assert.deepEqual(status.messages, []);
            assert.equal(
                status.after_ordinal,
                status.newest.ordinal,
                "all answered hooks move frontier to newest",
            );
        },
    },
    {
        name: "A10.gap-resend-and-exit",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            raw.push(message("a"), message("b"));
            await f.pass(raw);
            await f.sql("DELETE FROM mc_provider_messages_v1 WHERE ordinal=2", true);
            f.deps.historyRefreshSessions.add("session");
            const first = await f.pass(raw);
            assert.deepEqual(bytes(first), f.recorded.at(-2), "gap keeps last view and raw tail");
            assert.ok(
                f.stored()!.entries.every((e) => e.ingested === 0),
                "even first window ordinal is re-marked for resend",
            );
            f.setIntercept((w) =>
                w.method === "compaction.step"
                    ? {
                          answer: "refuse",
                          request_id: w.params.request_id,
                          code: "history_unreadable",
                          reason: "injected repeated gap",
                          detail: { history_gap_from: 2 },
                      }
                    : undefined,
            );
            await f.pass(raw);
            const step = f.wires.filter((w) => w.method === "compaction.step").at(-1)!;
            assert.deepEqual(
                step.params.messages.map((m: any) => m.mid),
                ["a", "b"],
                "retry carries ingest from gap, not known cursor assertion",
            );
            assert.equal(
                JSON.parse(f.stored()!.state.pipeline_exit_json!).reason,
                "provider_history_lost",
            );
            const calls = f.wires.length;
            await f.pass(raw);
            assert.equal(f.wires.length, calls, "second identical gap terminates resync");
        },
    },
    {
        name: "A10.encoded-hook-budget",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            const large = message("large", "user", '漢"\\\n'.repeat(250000));
            const out = await f.pass([...raw, large]);
            assert.equal(
                f.wires.filter((w) => w.method === "transform.hook").length,
                0,
                "duplicated blocks exceed encoded 3 MiB so hook is never sent",
            );
            assert.equal(
                JSON.stringify(out.at(-1)),
                JSON.stringify(large),
                "hook-budget overflow freezes raw",
            );
            assert.equal(f.stored()!.entries[0].ingested, 0);
            f.deps.historyRefreshSessions.add("session");
            await f.pass([...raw, large]);
            const status = f.wires.filter((w) => w.method === "compaction.step").at(-1)!;
            assert.equal(status.params.messages.length, 1);
            assert.ok(
                Buffer.byteLength(JSON.stringify(status)) <= 3 * 1024 * 1024,
                "encoded status fits, including envelope and non-ASCII text",
            );
        },
    },
    {
        name: "A10.nonretryable-setup",
        async run(f) {
            f.setIntercept((w) =>
                w.method === "compaction.setup"
                    ? {
                          answer: "refuse",
                          request_id: w.params.request_id,
                          code: "misconfigured",
                          reason: "injected nonretryable Setup",
                      }
                    : undefined,
            );
            for (let i = 0; i < 10; i++) await f.pass([message("base")]);
            assert.equal(f.wires.filter((w) => w.method === "compaction.setup").length, 1);
            assert.equal(f.adapter.isProviderSession("session"), false);
            assert.equal(
                f
                    .logs()
                    .filter((line) => line.includes("bootstrap") && line.includes("misconfigured"))
                    .length,
                1,
                "nonretryable refusal logged once",
            );
        },
    },
    {
        name: "A10.bootstrap-declines-and-recovers",
        async run(f) {
            const raw = [message("a"), message("unpersisted-b"), message("c")];
            const first = await f.pass(raw);
            assert.ok(
                first.some((m) => m.info.id === "unpersisted-b"),
                "no unresolved message lost",
            );
            assert.equal(f.wires.length, 0, "no Setup or namespace change");
            assert.equal(f.adapter.bootstrapDeclines(), 1);
            raw[1] = message("b");
            await f.pass(raw);
            assert.equal(f.wires.filter((w) => w.method === "compaction.setup").length, 1);
            assert.equal(f.adapter.isProviderSession("session"), true);
        },
    },
    {
        name: "A10.legacy-tool-identity-switch",
        async run(f) {
            for (const shape of ["single", "parallel", "attachments", "many-parts", "live-newest"] as const) {
                const lane = await fixture(f.moduleDriver, f.host);
                try {
                    const covered = tools("covered");
                    if (shape === "single") covered.parts = covered.parts.slice(1, 2);
                    if (shape === "attachments") (covered.parts[1] as any).state.attachments = [
                        { type: "file", mime: "image/png", url: "data:image/png;base64,aGVsbG8=", filename: "fixture.png" },
                    ];
                    if (shape === "many-parts") for (let i = 3; i <= 32; i++) covered.parts.push(canonical({
                        ...(covered.parts[1] as any), id: `part-${i}`, callID: `call-${i}`,
                    }) as any);
                    const newest = message("newest", "assistant");
                    if (shape === "live-newest") {
                        delete (newest.info as any).time.completed;
                        newest.parts.push(canonical({ id: "running", type: "tool", tool: "bash", callID: "running-call",
                            state: { status: "completed", input: {}, output: "newest tool output" } }) as any);
                    }
                    const raw = [covered, newest];
                    await lane.full(raw);
                    // Only unprotected tail messages may adopt changed source
                    // identities. Summarize the first message so incompatible
                    // decoder identities must refuse instead of being adopted.
                    await lane.event("publish", { start: 1, end: 1, mid: "covered" });
                    const expected = await lane.full(raw);
                    const identities = await lane.sql("SELECT mid,identities FROM mc_block_identities ORDER BY mid");
                    const served = await lane.pass(raw);
                    assert.equal(lane.adapter.isProviderSession("session"), true, `${shape}: ${JSON.stringify(lane.callErrors)}`);
                    assert.equal(lane.fallbacks.length, 0, `${shape}: no full-request fallback`);
                    assert.deepEqual(bytes(served), bytes(expected), shape);
                    assert.deepEqual(await lane.sql("SELECT mid,identities FROM mc_block_identities ORDER BY mid"), identities,
                        `${shape}: identities must match, not be re-adopted`);
                    await lane.noReads();
                } finally { await lane.close(); }
            }
        },
    },
    {
        name: "A10.legacy-tool-genuine-drift-refuses",
        async run(f) {
            const raw = [tools("covered"), message("newest", "assistant")];
            await f.full(raw);
            await f.event("publish", { start: 1, end: 1, mid: "covered" });
            await f.full(raw);
            (raw[0]!.parts[1] as any).state.output = "genuinely changed source output";
            await assert.rejects(f.pass(raw), /CK message block identity drift for mid covered/);
            assert.equal(f.adapter.isProviderSession("session"), false);
            assert.deepEqual(f.callErrors.at(-1), { code: "transient", message: "CK message block identity drift for mid covered" });
        },
    },
    {
        name: "A10.paged-7500-bootstrap-restart",
        async run(f) {
            // Native metadata contributes to encoded page size without inventing a
            // multi-million-token model context. The codec must retain it verbatim.
            const raw = Array.from({ length: 7500 }, (_, i) => {
                const m = message(`bootstrap-${i}`);
                (m.info as any).fixture_opaque_payload = 'escaped " café 🦀 '.repeat(16);
                return canonical(m);
            });
            const usage = { current_total_input_tokens: 0, context_limit_tokens: 4000000 };
            const geometry = {
                usable_soft: 3600000,
                usable_hard: 3800000,
                absolute_wall: 4000000,
                derivation: "bootstrap-fixture",
            };
            updateSessionMeta(f.db, "session", { lastUsageContextLimit: 4000000 });
            for (let i = 0; i < 2; i++) {
                assert.deepEqual(
                    bytes(await f.full(raw, undefined, { usage, geometry })),
                    bytes(await f.old(raw, { usage, geometry })),
                );
            }
            let pages = 0;
            f.setIntercept((w) => {
                if (w.method === "compaction.step" && ++pages === 2)
                    throw new Error("Injected bootstrap page timeout after commit");
            });
            await f.pass(raw);
            assert.ok(f.stored()!.state.bootstrap_cursor! > 0, "answered first page checkpointed");
            assert.equal(
                f.adapter.isProviderSession("session"),
                false,
                "no unrecorded page view served",
            );
            f.setIntercept();
            f.advance(2000);
            await f.restartHost();
            const out = await f.pass(raw);
            decodeProviderAnswer("compaction.step", f.answers.at(-1));
            assert.equal(
                f.adapter.isProviderSession("session"),
                true,
                JSON.stringify({
                    times: f.callTimes,
                    logs: f.logs().slice(-6),
                    replies: f.answers.map((a) => ({
                        answer: a.answer,
                        code: a.code,
                        request_id: a.request_id,
                    })),
                    cursor: f.stored()!.state.bootstrap_cursor,
                    not_applied: f.stored()!.state.last_not_applied_json,
                }),
            );
            assert.deepEqual(
                bytes(out),
                bytes(await f.old(raw, { usage, geometry })),
                "resumed SOFT+ switch keeps engine tag numbers",
            );
            const requests = f.wires.filter((w) => w.method === "compaction.step");
            assert.ok(requests.length >= 3, "several status pages and a retry");
            assert.equal(
                new Set(requests.map((w) => w.params.request_id)).size,
                requests.length,
                "fresh request fence after restart",
            );
            assert.ok(
                requests.every((w) => Buffer.byteLength(JSON.stringify(w)) <= 3 * 1024 * 1024),
            );
            assert.equal(
                (await f.sql("SELECT COUNT(*) FROM mc_provider_messages_v1"))[0][0],
                7500,
                "ingest once across page retry",
            );
            console.log(
                `BOOTSTRAP_MEASUREMENT ${JSON.stringify({ host: f.host, messages: 7500, budget_ms: OPENCODE_PROVIDER_BOOTSTRAP_BUDGET_MS, max_page_ms: Math.max(...f.callTimes.filter((t) => t.method === "compaction.step").map((t) => t.ms)), pages: requests.length })}`,
            );
        },
    },
    {
        name: "A10.bootstrap-17000-measurement",
        async run(f) {
            const raw = Array.from({ length: 17000 }, (_, i) => {
                const m = message(`large-${i}`);
                (m.info as any).fixture_opaque_payload = 'escaped " café 🦀 '.repeat(16);
                return canonical(m);
            });
            updateSessionMeta(f.db, "session", { lastUsageContextLimit: 4000000 });
            for (let i = 0; i < 2; i++) await f.full(raw);
            const expected = await f.full(raw);
            const started = performance.now();
            const out = await f.pass(raw);
            const elapsed = Math.round(performance.now() - started);
            assert.equal(f.adapter.isProviderSession("session"), true);
            assert.deepEqual(bytes(out), bytes(expected));
            assert.equal(
                (await f.sql("SELECT COUNT(*) FROM mc_provider_messages_v1"))[0][0],
                17000,
            );
            console.log(
                `BOOTSTRAP_MEASUREMENT ${JSON.stringify({ host: f.host, messages: 17000, budget_ms: OPENCODE_PROVIDER_BOOTSTRAP_BUDGET_MS, total_ms: elapsed, max_page_ms: Math.max(...f.callTimes.filter((t) => t.method === "compaction.step").map((t) => t.ms)), pages: f.wires.filter((w) => w.method === "compaction.step").length })}`,
            );
        },
    },
    {
        name: "A10.bootstrap-timeout-full-request-late-retry",
        async run(f) {
            const raw = [message("base")];
            await f.full(raw);
            await f.full(raw);
            await f.old(raw);
            await f.old(raw);
            const expected = bytes(await f.old(raw));
            let late: Promise<unknown> | undefined;
            let delayed = false;
            f.setIntercept((w, reply) => {
                if (w.method === "compaction.step" && !delayed) {
                    delayed = true;
                    // Delay a committed real answer past the production bootstrap
                    // deadline. The original reply still arrives; it must be ignored.
                    late = new Promise((resolve) => setTimeout(() => resolve(reply), 30050));
                    return late;
                }
            });
            const out = await f.pass(raw);
            assert.deepEqual(
                bytes(out),
                expected,
                "timed-out bootstrap serves only the full-request result",
            );
            assert.equal(
                f.fallbacks.length,
                1,
                "bootstrap timeout uses the managed full-request path",
            );
            assert.equal(f.adapter.isProviderSession("session"), false);
            assert.equal(f.stored()!.views.length, 0, "no unrecorded late view served");
            await late;
            assert.deepEqual(
                f.recorded.at(-1),
                expected,
                "late receipt cannot replace already-served bytes",
            );
            assert.equal(f.stored()!.views.length, 0);
            f.setIntercept();
            f.advance(2000);
            await f.restartHost();
            assert.deepEqual(bytes(await f.pass(raw)), expected);
            assert.equal(f.adapter.isProviderSession("session"), true);
            const ids = f.wires
                .filter((w) => w.method === "compaction.step")
                .map((w) => w.params.request_id);
            assert.equal(new Set(ids).size, ids.length);
        },
    },
    {
        name: "A11.foreign-history-sticky-exit",
        async run(f) {
            await f.pass([message("base")]);
            const raw = [message("foreign")];
            await f.pass(raw);
            const state = f.stored()!.state;
            assert.equal(JSON.parse(state.pipeline_exit_json!).reason, "provider_foreign_history");
            const calls = f.wires.length;
            await f.restartHost();
            await f.pass(raw);
            assert.equal(f.wires.length, calls, "durable exit cannot rebootstrap silently");
            assert.equal(f.adapter.isProviderSession("session"), false);
            assert.equal(f.fallbacks.length, 2);
            assert.equal(
                f.logs().filter((line) => line.includes("exit provider_foreign_history")).length,
                1,
            );
        },
    },
    {
        name: "A11.process-wide-rollback",
        async run(f) {
            const raw = [message("base")];
            await f.full(raw);
            await f.full(raw);
            await f.pass(raw);
            raw.push(message("tail"));
            const before = await f.pass(raw);
            f.deps.rustPipeline = "full_request";
            assert.deepEqual(
                bytes(await f.pass(raw)),
                bytes(before),
                "zero-divergence rollback has no prefix rebuild",
            );
            assert.equal(f.fallbacks[0], undefined, "canonical namespace stays in place");
            const calls = f.wires.length;
            await f.pass(raw);
            assert.equal(f.wires.length, calls);
        },
    },
    {
        name: "A11.compaction-off-routing",
        async run(f) {
            const config = MagicContextConfigSchema.parse({
                transform_mode: "rust",
                rust_pipeline: "provider",
                compaction: { enabled: false },
            });
            assert.equal(
                resolveTransformMode({
                    configured: config.transform_mode,
                    userTierHasSubc: true,
                    compactionEnabled: false,
                }).mode,
                "ts",
            );
            const transform = createTransform({
                ...f.deps,
                compactionOff: true,
                historianRunnable: false,
            });
            try {
                await transform({}, { messages: [message("off")] });
            } finally {
                transform.disposeRust();
            }
            assert.equal(f.wires.filter((w) => w.method === "compaction.setup").length, 0);
        },
    },
    {
        name: "A11.ambiguous-revert-and-diverged-rollback",
        async run(f) {
            const raw = [message("A"), message("B"), message("C")];
            await f.pass(raw.slice(0, 1));
            await f.pass(raw);
            await f.pass([raw[0], message("X"), raw[1], raw[2]]);
            const exitPass = await f.pass([raw[0], message("X"), raw[1]]);
            assert.ok(
                !exitPass.some((m) => m.info.id === "C"),
                "exit pipeline never serves reverted C",
            );
            const exit = JSON.parse(f.stored()!.state.pipeline_exit_json!);
            assert.equal(exit.reason, "provider_revert_ambiguous");
            assert.equal(exit.reseed_full_request, true);
            assert.ok(
                f.fallbacks[0]?.includes(":full-request:"),
                "race ordinals reseed into a fresh full namespace",
            );
            const before = bytes(exitPass);
            const next = await f.pass([raw[0], message("X"), raw[1]]);
            assert.deepEqual(bytes(next), before, "reseed then stable full-request replay");
            assert.equal(new Set(f.fallbacks).size, 1, "namespace is not reseeded again");
            assert.equal(
                f.logs().filter((line) => line.includes("exit provider_revert_ambiguous")).length,
                1,
            );
        },
    },
    {
        name: "A11.record-lost",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            f.deps.historyRefreshSessions.add("session");
            await f.pass(raw);
            for (const table of [
                "host_runner_entries",
                "host_runner_ids",
                "host_runner_views",
                "host_runner_state",
            ])
                f.db.exec(`DELETE FROM ${table}`);
            await f.restartHost();
            await f.pass(raw);
            assert.equal(
                JSON.parse(f.stored()!.state.pipeline_exit_json!).reason,
                "provider_record_lost",
            );
            const calls = f.wires.length;
            await f.pass(raw);
            assert.equal(f.wires.length, calls, "lost-record exit never loops bootstrap");
        },
    },
    {
        name: "A11.store-ahead-turn-refusal",
        async run(f) {
            const raw = [message("base")];
            await f.pass(raw);
            for (const method of ["transform.hook", "compaction.step"]) {
                f.setIntercept((w) => {
                    if (w.method === method)
                        throw new StoreAheadOfBinaryError({ dbVersion: 999, binaryMax: 66 });
                });
                if (method === "transform.hook") raw.push(message("next"));
                else f.deps.historyRefreshSessions.add("session");
                const served = f.recorded.length;
                await assert.rejects(f.pass(raw), /MC-C13/);
                assert.equal(f.recorded.length, served, "no model request reaches fake provider");
                assert.equal(
                    f.stored()!.state.pipeline_exit_json,
                    null,
                    "store-ahead is neither parked nor exited",
                );
                f.setIntercept();
                await f.restartHost();
                await f.pass(raw);
            }
        },
    },
    {
        name: "A11.oversize-exits-once",
        async run(f) {
            await f.pass([message("base")]);
            const raw = [message("base"), message("oversize", "user", '漢"\\\n'.repeat(550000))];
            // Full-request recovery may itself refuse the absolute wall; the provider
            // exit must already be durable either way, before any attempted serving.
            try {
                await f.pass(raw);
            } catch (error) {
                assert.match(String(error), /full-request|safely serve/);
            }
            assert.equal(
                JSON.parse(f.stored()!.state.pipeline_exit_json!).reason,
                "provider_message_too_large",
            );
            const calls = f.wires.length;
            try {
                await f.pass(raw);
            } catch (error) {
                assert.match(String(error), /full-request|safely serve/);
            }
            assert.equal(f.wires.length, calls);
            assert.equal(
                f.logs().filter((line) => line.includes("exit provider_message_too_large")).length,
                1,
            );
        },
    },
    {
        name: "A1.declared-prefix-events",
        async run(f) {
            await f.pass([message("base")]);
            const raw = [message("base"), message("tail")];
            await f.pass(raw);
            f.db.exec("UPDATE host_runner_entries SET op_version=999");
            await f.restartHost();
            await f.pass(raw);
            assert.equal(
                f
                    .logs()
                    .filter(
                        (line) =>
                            line.includes("host-side prefix event") &&
                            line.includes("unknown_op_version"),
                    ).length,
                1,
            );
            const idless = message("idless");
            delete idless.info.id;
            await f.pass([...raw, idless]);
            assert.ok(f.logs().some((line) => line.includes("host-side prefix event idless")));
            const pending = tools("pending");
            (pending.parts[1] as any).state.status = "running";
            await f.pass([...raw, pending]);
            assert.ok(
                f.logs().some((line) => line.includes("host-side prefix event non_terminal")),
            );
        },
    },
];

export async function runProviderPipelineDifferential(selected: string[] = []) {
    const scratch = join(tmpdir(), "magic-context", "provider-suite");
    mkdirSync(scratch, { recursive: true });
    const work = mkdtempSync(join(scratch, "run-"));
    mkdirSync(join(work, "stores"), { recursive: true });
    let driver: Driver | undefined;
    let checks = 0;
    const failures: { name: string; error: string }[] = [];
    try {
        console.log(
            `Bun ${Bun.version}; ${spawnSync("cargo", ["--version"], { encoding: "utf8" }).stdout.trim()}`,
        );
        setLogLineForwarder((line) => logLines.push(line));
        driver = new Driver(buildDriver(work), join(work, "stores"));
        const names = ["OpenCode1", "OpenCode2"].flatMap((host) =>
            cases.map((c) => `${host}/${c.name}`),
        );
        for (const name of selected) assert.ok(names.includes(name), `unknown case ${name}`);
        for (const host of ["OpenCode1", "OpenCode2"] as const) {
            for (const c of cases) {
                const name = `${host}/${c.name}`;
                if (selected.length && !selected.includes(name)) continue;
                const f = await fixture(
                    driver,
                    host,
                    undefined,
                    c.name === "A3.model-switch-protected-newest-tool-queue",
                );
                try {
                    await c.run(f);
                    await f.noReads();
                    checks++;
                    console.log(`PASS ${name}`);
                } catch (error) {
                    const text = (
                        error instanceof Error ? (error.stack ?? error.message) : String(error)
                    ).slice(0, 8000);
                    failures.push({ name, error: text });
                    console.error(`FAIL ${name}\n${text}`);
                } finally {
                    await f.close();
                }
            }
        }
        assert.ok(checks + failures.length > 0, "non-empty corpus");
        console.log(
            `PROVIDER_PIPELINE_RESULT=${JSON.stringify({ checks, failures, declaredDifferences })}`,
        );
        if (failures.length)
            throw new Error(
                `${failures.length} provider pipeline checks failed: ${failures.map((f) => f.name).join(", ")}`,
            );
        return { checks, declaredDifferences };
    } finally {
        if (driver) await driver.close();
        setLogLineForwarder(null);
    }
}

if (import.meta.main) {
    const selected = Bun.argv.flatMap((arg, i) => (arg === "--case" ? [Bun.argv[i + 1]!] : []));
    await runProviderPipelineDifferential(selected);
}
