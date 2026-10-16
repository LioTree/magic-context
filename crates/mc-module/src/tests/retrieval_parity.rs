//! Search and recovery through mc.retrieval, which is not a model-visible tool.
//! Expected hit arrays and recovery text come from the pinned TypeScript implementation.

use super::*;
use crate::parity_contract::CapabilityResult;
use crate::retrieval::hybrid::{RerankCallOptions, RerankClient};

fn vectors() -> Value {
    serde_json::from_str(FROZEN_SEARCH).unwrap()
}
fn expand_vectors() -> Value {
    serde_json::from_str(FROZEN_EXPAND).unwrap()
}
fn recorded_pages_json() -> &'static str {
    FROZEN_EXPAND
        .split_once("\"pages\":")
        .unwrap()
        .1
        .split_once(",\"full\":")
        .unwrap()
        .0
}

fn fixture_handler(seed: bool) -> (McHandler, Arc<McStore>, tempfile::TempDir, PathBuf) {
    let (handler, store, dir, project) =
        handler_with_store(Arc::new(ProducerState::default()), default_test_config());
    let path = dir.path().join("ts-retrieval.db");
    std::fs::write(
        &path,
        include_bytes!("../../testdata/parity_retrieval/context.db"),
    )
    .unwrap();
    if seed {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(vectors()["seed"].as_str().unwrap())
            .unwrap();
    }
    store.install_context_domain(Arc::new(
        mc_store::SqliteContextDomain::open(&path).unwrap(),
    ));
    store.set_route_identity_for_test(project.to_str().unwrap(), "git:parity-own");
    handler.bind_route(7, binding(project.to_str().unwrap(), "retrieval-session"));
    (handler, store, dir, project)
}

fn search_request(case: &Value) -> Value {
    json!({"method":"mc.retrieval","v":1,"session_id":"retrieval-session", "sources":case["sources"],
      "request":{"query":case["query"],"intent":"explicit","limit":case["limit"],"start_at_ms":null,"end_at_ms_inclusive":null,
        "ordinal_cutoff":{"value":25,"base":"one"},"visible_memory_ids":[],
        "embedding":{"provider":"fixture","model":"fixture:model","dimensions":3,"query_recipe":"fixture-query","passage_recipe":"fixture-passage","fingerprint":"fixture-identity","epoch":1}},
      "query_vector":[1,0,0]})
}

fn identity_order(body: &Value) -> Value {
    Value::Array(body["hits"].as_array().expect("retrieval hits").iter().map(|h| json!({
        "source":h["source"],"source_id":h["source_id"],"ordinal":h["ordinal"].get("value").cloned().unwrap_or(Value::Null),"text":h["text"]
    })).collect())
}

async fn run_case(handler: &McHandler, case: &Value) -> Value {
    let mut request = search_request(case);
    if case["sources"] == json!(["raw_message"]) {
        request["query_vector"] = Value::Null;
    }
    let body = call_dispatch_request(handler, request).await;
    assert_eq!(
        identity_order(&body),
        case["hits"],
        "{}: exact order, identity and text",
        case["name"]
    );
    body
}

#[tokio::test]
async fn produced_sources_and_message_pair_match_frozen_ts_without_sorting() {
    let (handler, _, _dir, _) = fixture_handler(true);
    for case in vectors()["cases"].as_array().unwrap().iter().take(5) {
        let body = run_case(&handler, case).await;
        assert!(!body["hits"].as_array().unwrap().is_empty());
        for source in case["sources"].as_array().unwrap() {
            assert_eq!(
                body["source_availability"][source.as_str().unwrap()],
                json!({"status":"available"})
            );
        }
    }
}

#[derive(Default)]
struct SynapseFixture {
    calls: Mutex<Vec<Value>>,
    fail: bool,
}
#[async_trait]
impl RerankClient for SynapseFixture {
    async fn call(
        &self,
        module: &str,
        method: &str,
        params: Value,
        options: RerankCallOptions,
    ) -> Result<Value, String> {
        self.calls
            .lock()
            .unwrap()
            .push(json!([module, method, params, options]));
        if self.fail && method == "rerank.score" {
            return Err("Synapse unavailable".into());
        }
        Ok(if method == "models.list" {
            json!({"table_epoch":6,"models":[{"model_id":"gte-reranker-modernbert-base-f32","certified":true,"fingerprints":["a".repeat(64)]}]})
        } else {
            json!({"fingerprint":"a".repeat(64),"table_epoch":6,"scores":vec![0.5; params["candidates"].as_array().unwrap().len()]})
        })
    }
}

#[tokio::test]
async fn rerank_ties_preserve_frozen_ts_pool_order_and_arguments() {
    let (mut handler, _, _dir, project) = fixture_handler(true);
    let client = Arc::new(SynapseFixture::default());
    handler.retrieval_reranker = Some(client.clone());
    let case = &vectors()["cases"][5];
    run_case(&handler, case).await;
    let mut expected = case["calls"].clone();
    for call in expected.as_array_mut().unwrap() {
        call[3]["identity"]["project_root"] = json!(project);
    }
    let actual = json!(*client.calls.lock().unwrap());
    assert_eq!(actual, expected);
}

#[tokio::test]
async fn absent_or_failing_synapse_retains_ts_standalone_baseline() {
    let (mut handler, _, _dir, _) = fixture_handler(true);
    let case = &vectors()["cases"][6];
    run_case(&handler, case).await;
    handler.retrieval_reranker = Some(Arc::new(SynapseFixture {
        fail: true,
        ..Default::default()
    }));
    run_case(&handler, case).await;
}

#[tokio::test]
async fn explicit_literal_probes_match_scoped_frozen_ts_hits() {
    let (handler, _, _dir, _) = fixture_handler(true);
    let all = vectors();
    let case = all["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "literal_probe")
        .unwrap();
    let body = run_case(&handler, case).await;
    assert_eq!(body["literal_probes"], case["probes"]);
    assert!(!body["hits"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn auto_hint_runs_no_rerank_or_literal_probe() {
    let (mut handler, _, _dir, _) = fixture_handler(true);
    let client = Arc::new(SynapseFixture::default());
    handler.retrieval_reranker = Some(client.clone());
    for case in vectors()["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["name"] == "auto_hint")
    {
        let mut request = search_request(case);
        request["op"] = json!("auto_hint");
        request["query_vector"] = Value::Null;
        let body = call_dispatch_request(&handler, request).await;
        assert_eq!(identity_order(&body), case["hits"]);
        assert_eq!(body["literal_probes"], json!([]));
    }
    assert!(client.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn unproduced_sources_are_named_unavailable_not_empty_success() {
    let (handler, _, _dir, _) = fixture_handler(true);
    for (source, reason) in [
        ("primer", "retrieval_lane"),
        ("note", "retrieval_lane"),
        ("git_commit", "git_archive"),
        ("compartment", "retrieval_lane"),
    ] {
        let mut request = search_request(&vectors()["cases"][0]);
        request["sources"] = json!([source]);
        request["semantic_provider"] = json!("local");
        let body = call_dispatch_request(&handler, request).await;
        assert_eq!(
            body["source_availability"][source],
            serde_json::to_value(CapabilityResult::<()>::unavailable(reason).availability())
                .unwrap()
        );
        assert_eq!(body["hits"], json!([]));
    }
}

#[tokio::test]
async fn unsupported_expand_refuses_each_source_by_name() {
    let (handler, store, _dir, _) = fixture_handler(true);
    let before = store
        .with_context_conn_for_test(|conn| {
            conn.query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))
        })
        .unwrap();
    for source in ["memory", "note", "git_commit"] {
        let result = handler.dispatch_value(7, json!({"method":"mc.retrieval","v":1,"session_id":"retrieval-session","op":"expand","source":source})).await;
        assert!(
            matches!(result, HandlerOutcome::Error { code, message } if code == "expand_unsupported_source" && message == source)
        );
    }
    let after = store
        .with_context_conn_for_test(|conn| {
            conn.query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))
        })
        .unwrap();
    assert_eq!(before, after);
}

// Search arrays were generated by executing TypeScript unifiedSearch at the recorded commit.
// Recovery text reuses the independently generated recorded-page vectors in retrieval/expand.rs.
const FROZEN_SEARCH: &str = r####"{
  "provenance": {
    "commit": "282d9c08bce490346583a3b8c145c402499f980f",
    "sources": {
      "search.ts": "89a9913e7645f991e196ca3a5cfd2a1a4a1dd92770b74c200dfeb32e05eafda3",
      "search-rerank.ts": "314a0a80a54136a154f8ae605bb20ee31cca81046170d389fadee0a1aebab855",
      "literal-probes.ts": "cb38519de49197dea3609fa26d6ac936c27c6bdbfdf0239f723e21647e1d93e6",
      "message-index.ts": "ee9988a4c1da657723118c8da379e9a74baf1c884e4526fc5cf528ca5d5a16df",
      "compartment-chunk-embedding.ts": "7d2794cd9c729d19b08954cddf5e71c2d5d1c50b2eda1d1260df92a81fb0df46",
      "memory/storage-memory-fts.ts": "41f54b8e2408571a05e9922932c0375c06cea1cc9b52d6a6b57ca17d385db192"
    },
    "fixture_db_sha256": "edd4e9a3104b299e6b5dda4b7f4f508054f5d4f7b59258c3176b72bc233931eb"
  },
  "seed": "\nINSERT INTO message_history_fts(rowid,session_id,message_ordinal,message_id,role,content) VALUES\n(1002,'retrieval-session',2,'raw-two','user','queue queue bounded drains'),\n(1004,'retrieval-session',4,'raw-four','assistant','queue and saturation with more unrelated words'),\n(1008,'retrieval-session',8,'raw-eight','user','queue dispatch uses a slow worker and a long buffer'),\n(1015,'retrieval-session',15,'raw-fifteen','assistant','queue'),\n(1021,'retrieval-session',21,'raw-uncovered','user','queue queue queue uncovered'),\n(1024,'retrieval-session',24,'raw-literal','user','/ctx-status queue calls'),\n(1100,'foreign-session',2,'foreign-raw','user','queue queue queue');\nINSERT OR REPLACE INTO message_fts_rowid_map(session_id,fts_rowid,message_ordinal,message_time_ms) VALUES\n('retrieval-session',1002,2,1768003200000),('retrieval-session',1004,4,1768003200000),\n('retrieval-session',1008,8,1768003200000),('retrieval-session',1015,15,1768003200000),\n('retrieval-session',1021,21,1768003200000),\n('retrieval-session',1024,24,1768003200000),\n('foreign-session',1100,2,1768003200000);\nINSERT OR REPLACE INTO message_history_index(session_id,last_indexed_ordinal,updated_at) VALUES('retrieval-session',25,1768003200000);\nUPDATE compartment_chunk_embeddings SET vector=X'cdcccc3d6666663f00000000' WHERE compartment_id=2;\n",
  "cases": [
    {
      "name": "raw_message",
      "sources": [
        "raw_message"
      ],
      "query": "queue",
      "limit": 10,
      "effective_scores": [
        1.275,
        1.0625,
        0.8500000000000001,
        0.6375,
        0.42500000000000004,
        0.21249999999999994
      ],
      "hits": [
        {
          "source": "raw_message",
          "source_id": "raw-uncovered",
          "ordinal": 21,
          "text": "queue queue queue uncovered"
        },
        {
          "source": "raw_message",
          "source_id": "raw-two",
          "ordinal": 2,
          "text": "queue queue bounded drains"
        },
        {
          "source": "raw_message",
          "source_id": "raw-fifteen",
          "ordinal": 15,
          "text": "queue"
        },
        {
          "source": "raw_message",
          "source_id": "raw-literal",
          "ordinal": 24,
          "text": "/ctx-status queue calls"
        },
        {
          "source": "raw_message",
          "source_id": "raw-four",
          "ordinal": 4,
          "text": "queue and saturation with more unrelated words"
        },
        {
          "source": "raw_message",
          "source_id": "raw-eight",
          "ordinal": 8,
          "text": "queue dispatch uses a slow worker and a long buffer"
        }
      ]
    },
    {
      "name": "compartment",
      "sources": [
        "compartment"
      ],
      "query": "queue",
      "limit": 10,
      "effective_scores": [
        1.02,
        1.014835932748951,
        0.11264016120189914
      ],
      "hits": [
        {
          "source": "compartment",
          "source_id": "1",
          "ordinal": 1,
          "text": "Saturation and bounded drains"
        },
        {
          "source": "compartment",
          "source_id": "3",
          "ordinal": 11,
          "text": "Unrelated title semantic recall"
        },
        {
          "source": "compartment",
          "source_id": "2",
          "ordinal": 6,
          "text": "Same score later ordinal"
        }
      ]
    },
    {
      "name": "memory",
      "sources": [
        "memory"
      ],
      "query": "queue",
      "limit": 10,
      "effective_scores": [
        1.3,
        1.0347346765283423,
        1.0336390835388014,
        0.9880000000000001,
        0.9750000000000001,
        0.9657142857142856,
        0.7713333268245062,
        0.676000008678436,
        0.3995860168832111,
        0.26
      ],
      "hits": [
        {
          "source": "memory",
          "source_id": "13",
          "ordinal": null,
          "text": "queue dated inclusive upper"
        },
        {
          "source": "memory",
          "source_id": "5",
          "ordinal": null,
          "text": "bounded drains absorb saturation"
        },
        {
          "source": "memory",
          "source_id": "15",
          "ordinal": null,
          "text": "pkg::worker.retry() handles transient saturation"
        },
        {
          "source": "memory",
          "source_id": "87",
          "ordinal": null,
          "text": "queue shared workspace constraint"
        },
        {
          "source": "memory",
          "source_id": "12",
          "ordinal": null,
          "text": "queue dated inclusive lower"
        },
        {
          "source": "memory",
          "source_id": "14",
          "ordinal": null,
          "text": "queue dated outside interval"
        },
        {
          "source": "memory",
          "source_id": "2",
          "ordinal": null,
          "text": "queue corrected text remains searchable"
        },
        {
          "source": "memory",
          "source_id": "4",
          "ordinal": null,
          "text": "queue pressure exact identifier"
        },
        {
          "source": "memory",
          "source_id": "16",
          "ordinal": null,
          "text": "queue 🙂 spaced 🙂 spaced 🙂 spaced 🙂 spaced 🙂 spaced 🙂 spaced 🙂 spaced 🙂 spaced 🙂 spaced 🙂 spaced 🙂 spaced 🙂 spaced 🙂 spaced 🙂 spaced 🙂 spaced 🙂 spaced 🙂 spaced 🙂 spaced 🙂 spaced 🙂 spaced 🙂 spaced 🙂…"
        },
        {
          "source": "memory",
          "source_id": "6",
          "ordinal": null,
          "text": "queue fts only fallback"
        }
      ]
    },
    {
      "name": "message_pair",
      "sources": [
        "raw_message",
        "compartment"
      ],
      "query": "queue",
      "limit": 10,
      "effective_scores": [
        1.275,
        1.02,
        0.7649999999999999,
        0.51,
        0.25499999999999995
      ],
      "hits": [
        {
          "source": "compartment",
          "source_id": "1",
          "ordinal": 1,
          "text": "Saturation and bounded drains"
        },
        {
          "source": "compartment",
          "source_id": "3",
          "ordinal": 11,
          "text": "Unrelated title semantic recall"
        },
        {
          "source": "compartment",
          "source_id": "2",
          "ordinal": 6,
          "text": "Same score later ordinal"
        },
        {
          "source": "raw_message",
          "source_id": "raw-uncovered",
          "ordinal": 21,
          "text": "queue queue queue uncovered"
        },
        {
          "source": "raw_message",
          "source_id": "raw-literal",
          "ordinal": 24,
          "text": "/ctx-status queue calls"
        }
      ]
    },
    {
      "name": "fused_limited",
      "sources": [
        "memory",
        "raw_message",
        "compartment"
      ],
      "query": "queue",
      "limit": 4,
      "effective_scores": [
        1.3,
        1.275,
        1.0347346765283423,
        1.0336390835388014
      ],
      "hits": [
        {
          "source": "memory",
          "source_id": "13",
          "ordinal": null,
          "text": "queue dated inclusive upper"
        },
        {
          "source": "compartment",
          "source_id": "1",
          "ordinal": 1,
          "text": "Saturation and bounded drains"
        },
        {
          "source": "memory",
          "source_id": "5",
          "ordinal": null,
          "text": "bounded drains absorb saturation"
        },
        {
          "source": "memory",
          "source_id": "15",
          "ordinal": null,
          "text": "pkg::worker.retry() handles transient saturation"
        }
      ]
    },
    {
      "name": "rerank_tie",
      "sources": [
        "raw_message"
      ],
      "query": "how does queue dispatch work",
      "limit": 10,
      "hits": [
        {
          "source": "raw_message",
          "source_id": "raw-eight",
          "ordinal": 8,
          "text": "queue dispatch uses a slow worker and a long buffer"
        },
        {
          "source": "raw_message",
          "source_id": "raw-uncovered",
          "ordinal": 21,
          "text": "queue queue queue uncovered"
        },
        {
          "source": "raw_message",
          "source_id": "raw-two",
          "ordinal": 2,
          "text": "queue queue bounded drains"
        },
        {
          "source": "raw_message",
          "source_id": "raw-fifteen",
          "ordinal": 15,
          "text": "queue"
        },
        {
          "source": "raw_message",
          "source_id": "raw-literal",
          "ordinal": 24,
          "text": "/ctx-status queue calls"
        },
        {
          "source": "raw_message",
          "source_id": "raw-four",
          "ordinal": 4,
          "text": "queue and saturation with more unrelated words"
        }
      ],
      "calls": [
        [
          "synapse",
          "models.list",
          {},
          {
            "timeoutMs": 1500,
            "targetKind": "management_surface",
            "identity": {
              "project_root": "git:parity-own",
              "harness": "magic-context",
              "session": "retrieval-session"
            }
          }
        ],
        [
          "synapse",
          "rerank.score",
          {
            "model": "gte-reranker-modernbert-base-f32",
            "query": "how does queue dispatch work",
            "candidates": [
              "message raw-eight retrieval-session @8\nuser: queue dispatch uses a slow worker and a long buffer\nqueue dispatch uses a slow worker and a long buffer",
              "message raw-uncovered retrieval-session @21\nuser: queue queue queue uncovered\nqueue queue queue uncovered",
              "message raw-two retrieval-session @2\nuser: queue queue bounded drains\nqueue queue bounded drains",
              "message raw-fifteen retrieval-session @15\nassistant: queue\nqueue",
              "message raw-literal retrieval-session @24\nuser: /ctx-status queue calls\n/ctx-status queue calls",
              "message raw-four retrieval-session @4\nassistant: queue and saturation with more unrelated words\nqueue and saturation with more unrelated words"
            ],
            "required_fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "allow_equivalent": false,
            "accept_declared": false,
            "max_queue_ms": 100,
            "deadline_ms": 1500
          },
          {
            "timeoutMs": 1500,
            "targetKind": "management_surface",
            "identity": {
              "project_root": "git:parity-own",
              "harness": "magic-context",
              "session": "retrieval-session"
            }
          }
        ]
      ]
    },
    {
      "name": "no_synapse",
      "sources": [
        "memory",
        "raw_message",
        "compartment"
      ],
      "query": "how does queue dispatch work",
      "limit": 10,
      "hits": [
        {
          "source": "memory",
          "source_id": "13",
          "ordinal": null,
          "text": "queue dated inclusive upper"
        },
        {
          "source": "compartment",
          "source_id": "1",
          "ordinal": 1,
          "text": "Saturation and bounded drains"
        },
        {
          "source": "memory",
          "source_id": "5",
          "ordinal": null,
          "text": "bounded drains absorb saturation"
        },
        {
          "source": "memory",
          "source_id": "15",
          "ordinal": null,
          "text": "pkg::worker.retry() handles transient saturation"
        },
        {
          "source": "compartment",
          "source_id": "2",
          "ordinal": 6,
          "text": "Same score later ordinal"
        },
        {
          "source": "memory",
          "source_id": "87",
          "ordinal": null,
          "text": "queue shared workspace constraint"
        },
        {
          "source": "memory",
          "source_id": "12",
          "ordinal": null,
          "text": "queue dated inclusive lower"
        },
        {
          "source": "memory",
          "source_id": "14",
          "ordinal": null,
          "text": "queue dated outside interval"
        },
        {
          "source": "memory",
          "source_id": "2",
          "ordinal": null,
          "text": "queue corrected text remains searchable"
        },
        {
          "source": "compartment",
          "source_id": "3",
          "ordinal": 11,
          "text": "Unrelated title semantic recall"
        }
      ]
    },
    {
      "name": "literal_probe",
      "sources": [
        "raw_message"
      ],
      "query": "why did /ctx-status calls inflate",
      "probes": [
        "/ctx-status",
        "ctx-status"
      ],
      "limit": 10,
      "hits": [
        {
          "source": "raw_message",
          "source_id": "raw-literal",
          "ordinal": 24,
          "text": "/ctx-status queue calls"
        }
      ]
    },
    {
      "name": "auto_hint",
      "sources": [
        "raw_message"
      ],
      "query": "how does queue dispatch work",
      "limit": 10,
      "hits": [],
      "calls": []
    },
    {
      "name": "auto_hint",
      "sources": [
        "raw_message"
      ],
      "query": "why did /ctx-status calls inflate",
      "limit": 10,
      "hits": [],
      "calls": []
    }
  ]
}
"####;
const FROZEN_EXPAND: &str = r####"{"provenance":{"commit":"282d9c08bce490346583a3b8c145c402499f980f","sha256":{"packages/plugin/src/hooks/magic-context/token-count-exact.ts":"7e48906e5dbe57ccec12de2181b967a7fa132ba23d780e9ae5251c36ad8733e9","packages/plugin/src/hooks/magic-context/read-session-formatting.ts":"5e5cdcb8027b4be256ad7eba45c254688583dd613cba21c6587a64044984c304","packages/plugin/src/shared/historian-tool-template.ts":"74800c8fc681c84f9ccfa703c7d3b68cf02c289ece4f3a0c7b1f642e05b70d81","packages/plugin/src/shared/historian-tool-preview-defaults.json":"b9246fdaad6ab38650f94c4c1d7e360d9e85d7d031c01760d0850d9a068cc13d","packages/plugin/src/shared/historian-tool-defaults.json":"eb3891f2fe1f4b030dacc6b711b22037647a40ed7ae91e9979ac920f14e555cc","packages/plugin/src/shared/historian-tool-expansions.ts":"bbbc7ac16ad1908e991497aab8835f40f3207cade6f0749eb694768ef9668071","packages/plugin/src/tools/ctx-expand/render.ts":"2551e4025fd3b8abfd999fdca05ca804c2938d3facf4d62a30c4027ed6681d7a","packages/plugin/src/features/magic-context/literal-probes.ts":"cb38519de49197dea3609fa26d6ac936c27c6bdbfdf0239f723e21647e1d93e6","packages/plugin/src/features/magic-context/search-rerank.ts":"314a0a80a54136a154f8ae605bb20ee31cca81046170d389fadee0a1aebab855","packages/plugin/src/tools/ctx-expand/tools.ts":"2e2fe2d9fb62b742d1a0fd93a9099146dcf7f46801ce5483dde5915e0c2959e0","packages/plugin/src/tools/ctx-expand/constants.ts":"dcad832dcb04e12b8265de97e38e0a55a08563ef87d4d560b108e175d5d79292","packages/plugin/src/features/magic-context/search.ts":"89a9913e7645f991e196ca3a5cfd2a1a4a1dd92770b74c200dfeb32e05eafda3"},"tokenEstimator":"tokenizer:43","generator":"generate.ts: frozen source executed with recorded SQL rows, raw-message visitor and fake Synapse; no live store"},"expand":{"pages":[[{"ordinal":1,"role":"user","parts":[{"type":"text","text":"  original text\nwith spacing  "},{"type":"file","filename":"fixture.txt"},null,{"type":"step-start"}]},{"ordinal":2,"role":"assistant","parts":[{"type":"tool","tool":"read","callID":"read-1","state":{"title":"  Read fixture ","input":{"z":1,"path":"src/file.ts","a":[true,null]},"output":{"z":2,"a":"value"}}},{"type":"reasoning","text":"internal reasoning"},{"type":"mystery"}]}],[{"ordinal":4,"role":"assistant","parts":[{"type":"tool_use","name":"shell","id":"split","input":{"command":"echo hello"}},{"type":"thinking","text":"private"},{"type":"step-finish"}]},{"ordinal":5,"role":"user","parts":[{"type":"tool_result","tool_use_id":"split","content":[{"type":"text","text":"hello"}]}]},{"ordinal":6,"role":"assistant","parts":[{"type":"reasoning","text":"hidden"},{"type":"step-finish"}]},{"ordinal":8,"role":"system","parts":[{"type":"text","text":"  long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long   "},{"type":"tool","tool":"knowhow","state":{"input":{"query":"testing\nretrieval"},"output":"ok"}}]}],[{"ordinal":9,"role":"user","parts":[{"type":"tool","tool":"other","state":{"input":{"description":"a fallback"},"output":""}}]},{"ordinal":10,"role":"assistant","parts":[{"type":"tool","tool":"todowrite","state":{"input":{"todos":[{"status":"done","content":"one"},{"status":"pending","content":"two"}]},"output":"ok"}},{"type":"tool","tool":"question","state":{"input":{"questions":[{"question":"why?"},{"question":"what?"}]},"output":"answer"}}]},{"ordinal":11,"role":"assistant","parts":[{"type":"tool","tool":"custom","state":{"input":{"z":1,"a":2,"items":[{"name":"a"},{"name":"b"}]},"output":"{\"z\":1,\"a\":2}"}}]}],[{"ordinal":12,"role":"assistant","parts":[{"type":"tool","tool":"ctx_note","state":{"input":{"action":"add","content":"recorded note","note_ids":[3,2]},"output":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}]},{"ordinal":13,"role":"assistant","parts":[{"type":"tool","tool":"custom","state":{"input":{"items":[{"name":"n0"},{"name":null},{"name":"n2"},{"name":"n3"},{"name":"n4"},{"name":"n5"},{"name":"n6"},{"name":"n7"},{"name":"n8"},{"name":"n9"},{"name":"n10"},{"name":"n11"}]},"output":{"z":1e+30,"a":0}}}]},{"ordinal":14,"role":"assistant","parts":[{"type":"tool","tool":"board","state":{"input":{"verb":"set","ops":[{"op":"add","item":"i","lane":{"title":"t","status":"open","items":[{"text":"one"},{"text":"two"}]},"props":{"text":"notes"}}]}}}]}]],"full":[{"ordinal":1,"expected":"[1] U (user) — full recovery:\n\n  [text]\n  original text\nwith spacing  \n  [file] fixture.txt"},{"ordinal":2,"expected":"[2] A (assistant) — full recovery:\n\n  [tool: read #read-1]\n  description: Read fixture\n  input: {\"z\":1,\"path\":\"src/file.ts\",\"a\":[true,null]}\n  output:\n{\"z\":2,\"a\":\"value\"}"},{"ordinal":3,"expected":"No message at ordinal 3 in this session's stored history — it was deleted (session prune/revert) or the ordinal is wrong, so it can't be recovered. Re-run the tool if you still need the data."},{"ordinal":4,"expected":"[4] A (assistant) — full recovery:\n\n  [tool: shell #split]\n  input: {\"command\":\"echo hello\"}"},{"ordinal":5,"expected":"[5] U (user) — full recovery:\n\n  [tool: tool_result #split]\n  output:\n[{\"type\":\"text\",\"text\":\"hello\"}]"},{"ordinal":6,"expected":"[6] A (assistant) — full recovery:\n\n  (no recoverable content — message had only structural/reasoning parts)"},{"ordinal":8,"expected":"[8] system — full recovery:\n\n  [text]\n  long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long   \n  [tool: knowhow]\n  input: {\"query\":\"testing\\nretrieval\"}\n  output:\nok"},{"ordinal":9,"expected":"[9] U (user) — full recovery:\n\n  [tool: other]\n  input: {\"description\":\"a fallback\"}\n  output:\n"},{"ordinal":10,"expected":"[10] A (assistant) — full recovery:\n\n  [tool: todowrite]\n  input: {\"todos\":[{\"status\":\"done\",\"content\":\"one\"},{\"status\":\"pending\",\"content\":\"two\"}]}\n  output:\nok\n  [tool: question]\n  input: {\"questions\":[{\"question\":\"why?\"},{\"question\":\"what?\"}]}\n  output:\nanswer"},{"ordinal":11,"expected":"[11] A (assistant) — full recovery:\n\n  [tool: custom]\n  input: {\"z\":1,\"a\":2,\"items\":[{\"name\":\"a\"},{\"name\":\"b\"}]}\n  output:\n{\"z\":1,\"a\":2}"},{"ordinal":12,"expected":"[12] A (assistant) — full recovery:\n\n  [tool: ctx_note]\n  input: {\"action\":\"add\",\"content\":\"recorded note\",\"note_ids\":[3,2]}\n  output:\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"},{"ordinal":13,"expected":"[13] A (assistant) — full recovery:\n\n  [tool: custom]\n  input: {\"items\":[{\"name\":\"n0\"},{\"name\":null},{\"name\":\"n2\"},{\"name\":\"n3\"},{\"name\":\"n4\"},{\"name\":\"n5\"},{\"name\":\"n6\"},{\"name\":\"n7\"},{\"name\":\"n8\"},{\"name\":\"n9\"},{\"name\":\"n10\"},{\"name\":\"n11\"}]}\n  output:\n{\"z\":1e+30,\"a\":0}"},{"ordinal":14,"expected":"[14] A (assistant) — full recovery:\n\n  [tool: board]\n  input: {\"verb\":\"set\",\"ops\":[{\"op\":\"add\",\"item\":\"i\",\"lane\":{\"title\":\"t\",\"status\":\"open\",\"items\":[{\"text\":\"one\"},{\"text\":\"two\"}]},\"props\":{\"text\":\"notes\"}}]}"}],"ranges":[{"start":1,"end":11,"budget":10000,"expected":{"text":"[1] U (user)\n    • original text\nwith spacing\n    • [file]\n\n[2] A (assistant)\n    • tool read(src/file.ts) → output ~9 tok\n    • [reasoning] internal reasoning\n    • [mystery]\n\n[4] A (assistant)\n    • tool shell\n    • [reasoning] private\n\n[5] tool results\n    • tool tool_result → output ~10 tok\n\n[6] A (assistant)\n    • [reasoning] hidden\n\n[8] system\n    • long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long long …\n    • tool knowhow: Looked up how-to: testing retrieval\n\n[9] tool results\n    • tool other(a fallback) → output ~0 tok\n\n[10] A (assistant)\n    • tool todowrite: Todos (2): done: one; pending: two\n    • tool question: Asked user: why? / what? → answer\n\n[11] A (assistant)\n    • tool custom → output ~9 tok","lastOrdinal":11,"truncated":false}},{"start":1,"end":11,"budget":35,"expected":{"text":"[1] U (user)\n    • original text\nwith spacing\n    • [file]","lastOrdinal":1,"truncated":true}},{"start":2,"end":11,"budget":0,"expected":{"text":"[2] A (assistant)\n    • tool read(src/file.ts) → output ~9 tok\n    • [reasoning] internal reasoning\n    • [mystery]","lastOrdinal":2,"truncated":true}},{"start":3,"end":3,"budget":100,"expected":{"text":"","lastOrdinal":2,"truncated":false}},{"start":4,"end":5,"budget":10000,"expected":{"text":"[4] A (assistant)\n    • tool shell\n    • [reasoning] private\n\n[5] tool results\n    • tool tool_result → output ~10 tok","lastOrdinal":5,"truncated":false}},{"start":10,"end":11,"budget":10000,"expected":{"text":"[10] A (assistant)\n    • tool todowrite: Todos (2): done: one; pending: two\n    • tool question: Asked user: why? / what? → answer\n\n[11] A (assistant)\n    • tool custom → output ~9 tok","lastOrdinal":11,"truncated":false}},{"start":11,"end":11,"budget":10000,"overrides":{"custom":"${input.items[*].name.join(\" / \")} ${output} ${output.a} ${input.z}"},"expected":{"text":"[11] A (assistant)\n    • tool custom: a / b {\"z\":1,\"a\":2} 2 1","lastOrdinal":11,"truncated":false}},{"start":12,"end":14,"budget":10000,"overrides":{"custom":"${input.items[*].name.join(\" | \")} ${output}"},"expected":{"text":"[12] A (assistant)\n    • tool ctx_note: Note add [3,2]: recorded note → xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…\n\n[13] A (assistant)\n    • tool custom: n0 | null | n2 | n3 | n4 | n5 | n6 | n7 | n8 | n9 | … +2 more {\"a\":0,\"z\":1e+30}\n\n[14] A (assistant)\n    • tool board: Board set: add it opennotes one, two","lastOrdinal":14,"truncated":false}},{"start":10,"end":10,"budget":10000,"overrides":{"todowrite":false,"question":"bad ${broken}"},"expected":{"text":"[10] A (assistant)\n    • tool todowrite → output ~1 tok\n    • tool question → output ~1 tok","lastOrdinal":10,"truncated":false}}]}}"####;

#[tokio::test]
async fn recorded_raw_and_compartment_expansion_match_ts_text_and_budget() {
    let (handler, _, _dir, _) = fixture_handler(true);
    let f = expand_vectors();
    for case in f["expand"]["full"].as_array().unwrap() {
        let body = call_dispatch_request(&handler, json!({"method":"mc.retrieval","v":1,"session_id":"retrieval-session","op":"expand","source":"raw_message","pages_json":recorded_pages_json(),"ordinal":case["ordinal"]})).await;
        assert_eq!(body["text"], case["expected"]);
    }
    for case in f["expand"]["ranges"].as_array().unwrap() {
        let mut request = json!({"method":"mc.retrieval","v":1,"session_id":"retrieval-session","op":"expand","source":"compartment","pages_json":recorded_pages_json(),"start":case["start"],"end":case["end"],"token_budget":case["budget"]});
        if case.get("overrides").is_some() {
            request["overrides"] = case["overrides"].clone();
        }
        let body = call_dispatch_request(&handler, request).await;
        for key in ["text", "lastOrdinal", "truncated"] {
            assert_eq!(body[key], case["expected"][key], "{case} {key}");
        }
    }
}

#[tokio::test]
async fn retrieval_admission_and_bound_scope_cannot_be_widened_or_write() {
    let (handler, store, _dir, _) = fixture_handler(true);
    let base = search_request(&vectors()["cases"][4]);
    let before = store.load("retrieval-session").unwrap();
    let changes = || {
        store
            .with_context_conn_for_test(|tx| {
                tx.query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))
            })
            .unwrap()
    };
    let count = changes();
    for op in ["search", "auto_hint", "expand"] {
        for (channel, field, value, code) in [
            (7, "v", Value::Null, "bad_request"),
            (7, "session_id", Value::Null, "bad_request"),
            (7, "session_id", json!(""), "bad_request"),
            (8, "v", json!(1), "route_unbound"),
            (
                7,
                "session_id",
                json!("foreign-session"),
                "session_mismatch",
            ),
        ] {
            let mut request = base.clone();
            request["op"] = json!(op);
            request[field] = value;
            assert_eq!(
                error_code(handler.dispatch_value(channel, request).await),
                code
            );
        }
    }
    assert_eq!(changes(), count);
    assert_eq!(
        store.load("retrieval-session").unwrap().row_version,
        before.row_version
    );
    let expected = call_dispatch_request(&handler, base.clone()).await;
    let mut forged = base;
    forged["project"] = json!("git:unrelated");
    forged["project_path"] = json!("git:unrelated");
    forged["directory"] = json!("/foreign");
    forged["scope"] = json!({"session":"foreign-session","project":"git:unrelated"});
    assert_eq!(call_dispatch_request(&handler, forged).await, expected);
    assert!(!expected["hits"].to_string().contains("foreign-raw"));
}

#[allow(dead_code)]
mod ts_store_reference {
    // Reference adapter from crates/mc-module/tests/parity_retrieval.rs, reading
    // the committed TypeScript-built database independently of production reads.

    use crate::memory_tool::SupportedSearchOptions;
    use crate::parity_contract::*;
    use crate::retrieval::{compartments::CompartmentChunk, hybrid::*};
    use rusqlite::{params, Connection, OpenFlags};
    use serde::Deserialize;
    use serde_json::Value;
    use std::collections::BTreeSet;

    #[derive(Deserialize)]
    struct Fixture {
        now: i64,
        project: String,
        session: String,
        model: String,
        visible: Vec<i64>,
        baseline: i64,
        delta: i64,
        stale: i64,
        m0: String,
        m1: String,
        cases: Vec<Case>,
    }
    #[derive(Deserialize)]
    struct Case {
        name: String,
        query: String,
        options: SupportedSearchOptions,
        model: String,
        vector: Option<Vec<f32>>,
        visibility: bool,
        results: Vec<Value>,
        reported_scores: Vec<String>,
        suppressed_visible_memory_ids: Vec<i64>,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(include_str!("../../testdata/parity_retrieval/golden.json")).unwrap()
    }
    fn identity(model: &str) -> EmbeddingIdentity {
        EmbeddingIdentity {
            provider: "fixture".into(),
            model: model.into(),
            dimensions: 3,
            query_recipe: "fixture-query".into(),
            passage_recipe: "fixture-passage".into(),
            fingerprint: "fixture-identity".into(),
            epoch: 1,
        }
    }
    fn scope(f: &Fixture) -> StoreScope {
        StoreScope {
            project: ProjectId(f.project.clone()),
            session: SessionId(f.session.clone()),
            generation: Generation(1),
        }
    }

    struct TsStore {
        conn: std::sync::Mutex<Connection>,
        now: i64,
        visibility: bool,
        _root: tempfile::TempDir,
    }
    impl TsStore {
        fn open(f: &Fixture, visibility: bool) -> Self {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("context.db");
            std::fs::write(
                &path,
                include_bytes!("../../testdata/parity_retrieval/context.db"),
            )
            .unwrap();
            let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            Self {
                conn: std::sync::Mutex::new(conn),
                now: f.now,
                visibility,
                _root: root,
            }
        }
        fn memory_filter(&self, scope: &StoreScope) -> (String, Vec<rusqlite::types::Value>) {
            let conn = self.conn.lock().unwrap();
            let workspace: Option<i64> = conn
                .query_row(
                    "SELECT workspace_id FROM workspace_members WHERE project_path=?",
                    [&scope.project.0],
                    |r| r.get(0),
                )
                .ok();
            let mut identities = vec![scope.project.0.clone()];
            let mut categories = Vec::<String>::new();
            if let Some(workspace) = workspace {
                identities = conn.prepare("SELECT project_path FROM workspace_members WHERE workspace_id=? ORDER BY project_path")
                .unwrap().query_map([workspace], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
                let json: String = conn
                    .query_row(
                        "SELECT share_categories FROM workspaces WHERE id=?",
                        [workspace],
                        |r| r.get(0),
                    )
                    .unwrap();
                categories = serde_json::from_str(&json).unwrap();
            }
            let placeholders = |n: usize| vec!["?"; n].join(",");
            let mut binds: Vec<_> = identities
                .iter()
                .cloned()
                .map(rusqlite::types::Value::Text)
                .collect();
            let sharing = if workspace.is_some() {
                binds.push(scope.project.0.clone().into());
                binds.extend(categories.iter().cloned().map(rusqlite::types::Value::Text));
                format!("AND (memories.project_path=? OR (memories.category IN ({}) AND memories.shareable=1 AND memories.scope IN ('project','ecosystem','universe')))", placeholders(categories.len()))
            } else {
                String::new()
            };
            (format!("memories.project_path IN ({}) {sharing} AND memories.status IN ('active','permanent') AND (memories.expires_at IS NULL OR memories.expires_at > ?)", placeholders(identities.len())), { binds.push(self.now.into()); binds })
        }
        fn filtered_sql(
            &self,
            scope: &StoreScope,
            dates: DateBounds,
        ) -> (String, Vec<rusqlite::types::Value>) {
            let (filter, mut binds) = self.memory_filter(scope);
            binds.push(dates.from_ms.unwrap_or(-9_007_199_254_740_991).into());
            binds.push(dates.to_ms.unwrap_or(9_007_199_254_740_991).into());
            (
                format!("{filter} AND memories.created_at BETWEEN ? AND ?"),
                binds,
            )
        }
    }
    fn available<T>(value: T) -> CapabilityResult<T> {
        CapabilityResult::Available { value }
    }
    fn decode_vector(blob: Vec<u8>) -> Vec<f32> {
        assert_eq!(blob.len() % 4, 0);
        blob.as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_le_bytes(*b))
            .collect()
    }

    impl RetrievalInputStore for TsStore {
        fn read_search_memories(
            &self,
            scope: &StoreScope,
            dates: DateBounds,
        ) -> CapabilityResult<Vec<SearchMemory>> {
            let (filter, binds) = self.filtered_sql(scope, dates);
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(&format!("SELECT memories.id, memories.category, memories.content, memories.created_at, CASE WHEN memories.project_path=? THEN NULL ELSE workspace_members.display_name END FROM memories LEFT JOIN workspace_members ON workspace_members.project_path=memories.project_path WHERE {filter} ORDER BY memories.id")).unwrap();
            let binds = std::iter::once(scope.project.0.clone().into())
                .chain(binds)
                .collect::<Vec<rusqlite::types::Value>>();
            available(
                stmt.query_map(rusqlite::params_from_iter(binds), |r| {
                    Ok(SearchMemory {
                        id: r.get(0)?,
                        category: r.get(1)?,
                        content: r.get(2)?,
                        created_at_ms: r.get(3)?,
                        source_name: r.get(4)?,
                    })
                })
                .unwrap()
                .map(Result::unwrap)
                .collect(),
            )
        }
        fn search_memory_fts(
            &self,
            scope: &StoreScope,
            query: &str,
            dates: DateBounds,
            limit: usize,
        ) -> CapabilityResult<Vec<MemoryFtsHit>> {
            let run = |query: &str| {
                let (filter, mut binds) = self.filtered_sql(scope, dates);
                let conn = self.conn.lock().unwrap();
                binds.push(query.to_string().into());
                binds.push((limit as i64).into());
                let mut stmt = conn.prepare(&format!("SELECT memories.id, bm25(memories_fts) FROM memories_fts INNER JOIN memories ON memories.id=memories_fts.rowid WHERE {filter} AND memories_fts MATCH ? ORDER BY bm25(memories_fts), memories.updated_at DESC, memories.id ASC LIMIT ?")).unwrap();
                stmt.query_map(rusqlite::params_from_iter(binds), |r| {
                    Ok(MemoryFtsHit {
                        memory_id: r.get(0)?,
                        bm25: r.get(1)?,
                    })
                })
                .unwrap()
                .map(Result::unwrap)
                .collect::<Vec<_>>()
            };
            let quote = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
            let sanitized = query
                .replace('\0', " ")
                .split_whitespace()
                .map(quote)
                .collect::<Vec<_>>()
                .join(" ");
            if sanitized.is_empty() {
                return available(Vec::new());
            }
            let mut hits = run(&sanitized);
            if hits.is_empty() {
                let mut seen = BTreeSet::new();
                let token = regex::Regex::new(r"[\p{L}\p{N}_]+").unwrap();
                let relaxed = token
                    .find_iter(query)
                    .map(|m| m.as_str())
                    .filter(|s| seen.insert(s.to_string()))
                    .filter(|s| {
                        s.encode_utf16().count() > 2 || s.chars().any(|c| c.is_ascii_digit())
                    })
                    .take(16)
                    .map(quote)
                    .collect::<Vec<_>>()
                    .join(" OR ");
                if !relaxed.is_empty() && relaxed != sanitized {
                    hits = run(&relaxed);
                }
            }
            available(hits)
        }
        fn read_memory_vectors(
            &self,
            _: &StoreScope,
            memory_ids: &[i64],
            identity: &EmbeddingIdentity,
        ) -> CapabilityResult<Vec<MemoryVector>> {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT memory_id, embedding FROM memory_embeddings WHERE model_id=? ORDER BY memory_id").unwrap();
            available(
                stmt.query_map([&identity.model], |r| {
                    Ok(MemoryVector {
                        memory_id: r.get(0)?,
                        identity: identity.clone(),
                        values: decode_vector(r.get(1)?),
                    })
                })
                .unwrap()
                .map(Result::unwrap)
                .filter(|v| memory_ids.contains(&v.memory_id))
                .collect(),
            )
        }
        fn read_compartment_chunks(
            &self,
            scope: &StoreScope,
            _: DateBounds,
            identity: &EmbeddingIdentity,
        ) -> CapabilityResult<Vec<CompartmentChunk>> {
            // Date bounds overlap the times of a compartment's first and last
            // messages. These persisted message times, not the date a summary was
            // written, determine which conversation interval is searched.
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT e.compartment_id, e.session_id, e.project_path, c.title, c.start_message, c.end_message, start_map.message_time_ms, end_map.message_time_ms, e.vector FROM compartment_chunk_embeddings e JOIN compartments c ON c.id=e.compartment_id LEFT JOIN message_fts_rowid_map start_map ON start_map.session_id=c.session_id AND start_map.message_ordinal=c.start_message LEFT JOIN message_fts_rowid_map end_map ON end_map.session_id=c.session_id AND end_map.message_ordinal=c.end_message WHERE e.session_id=? AND e.project_path=? AND e.model_id=? ORDER BY e.compartment_id ASC, e.window_index ASC").unwrap();
            available(
                stmt.query_map(
                    params![scope.session.0, scope.project.0, identity.model],
                    |r| {
                        Ok(CompartmentChunk {
                            compartment_id: r.get(0)?,
                            session_id: r.get(1)?,
                            project_path: r.get(2)?,
                            title: r.get(3)?,
                            start_ordinal: r.get(4)?,
                            end_ordinal: r.get(5)?,
                            start_time_ms: r.get(6)?,
                            end_time_ms: r.get(7)?,
                            identity: identity.clone(),
                            values: decode_vector(r.get(8)?),
                        })
                    },
                )
                .unwrap()
                .map(Result::unwrap)
                .collect(),
            )
        }
        fn read_visible_memory_ids(&self, scope: &StoreScope) -> CapabilityResult<BTreeSet<i64>> {
            if !self.visibility {
                return available(BTreeSet::new());
            }
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT a.memory_id, a.projected_metadata_json FROM memory_applied_rows a JOIN memories m ON m.id=a.memory_id AND m.content=a.projected_text WHERE a.session_id=? AND a.harness='opencode' AND m.status!='archived'").unwrap();
            let ids = stmt
                .query_map([&scope.session.0], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
                })
                .unwrap()
                .map(Result::unwrap)
                .filter_map(|(id, metadata)| {
                    let metadata: Value = serde_json::from_str(&metadata).unwrap();
                    metadata["representations"]
                        .as_array()
                        .is_some_and(|values| values.iter().any(|v| v == "text" || v == "delta"))
                        .then_some(id)
                })
                .collect();
            available(ids)
        }
    }

    #[test]
    fn production_adapter_inputs_equal_the_2d_ts_store_adapter() {
        let f = fixture();
        let (_handler, store, _dir, _) = super::fixture_handler(false);
        let production = crate::retrieval_store::RetrievalStore {
            store: &store,
            now_ms: f.now,
        };
        let reference = TsStore::open(&f, true);
        for case in &f.cases {
            let scope = scope(&f);
            let dates = case.options.dates;
            let id = identity(&case.model);
            let memories = production.read_search_memories(&scope, dates);
            assert_eq!(
                format!("{memories:?}"),
                format!("{:?}", reference.read_search_memories(&scope, dates)),
                "{} memories",
                case.name
            );
            let ids = match memories {
                CapabilityResult::Available { value } => {
                    value.into_iter().map(|m| m.id).collect::<Vec<_>>()
                }
                other => panic!("{other:?}"),
            };
            assert_eq!(
                format!(
                    "{:?}",
                    production.search_memory_fts(&scope, &case.query, dates, 50)
                ),
                format!(
                    "{:?}",
                    reference.search_memory_fts(&scope, &case.query, dates, 50)
                ),
                "{} FTS",
                case.name
            );
            assert_eq!(
                format!("{:?}", production.read_memory_vectors(&scope, &ids, &id)),
                format!("{:?}", reference.read_memory_vectors(&scope, &ids, &id)),
                "{} vectors",
                case.name
            );
            assert_eq!(
                format!(
                    "{:?}",
                    production.read_compartment_chunks(&scope, dates, &id)
                ),
                format!(
                    "{:?}",
                    reference.read_compartment_chunks(&scope, dates, &id)
                ),
                "{} chunks",
                case.name
            );
            assert_eq!(
                production.read_visible_memory_ids(&scope),
                reference.read_visible_memory_ids(&scope),
                "{} visibility",
                case.name
            );
        }
        println!(
            "Compared five production input reads with the 2D adapter across 20 TS fixture cases"
        );
    }
}

// BEGIN SERVED DIFFERENTIAL
mod served_differential {
    use super::super::*;
    use sha2::{Digest, Sha256};

    fn fixture() -> (McHandler, Arc<McStore>, tempfile::TempDir, SessionBinding) {
        let mut config = default_test_config();
        config.inject_docs = false;
        config.temporal_awareness = false;
        config.cache_ttl = "never".into();
        config.memory_budget_tokens = 0.0;
        config.auto_search.min_prompt_chars = 0;
        config.auto_search.score_threshold = 0.0;
        let (handler, store, dir, _) =
            handler_with_store(Arc::new(ProducerState::default()), config.clone());
        let mut bound = binding_with_harness("/recorded/i3-project", "opencode", "ses");
        bound.config = config;
        store.set_route_identity_for_test("/recorded/i3-project", "git:i3-served");
        store
            .seed_memory(
                1,
                "git:i3-served",
                "CONSTRAINTS",
                "queue backpressure needs bounded drains",
                80,
            )
            .unwrap();
        store
            .seed_memory(
                10,
                "git:i3-served",
                "CONSTRAINTS",
                "separate archive subject",
                50,
            )
            .unwrap();
        store
            .seed_memory(
                11,
                "git:i3-served",
                "CONSTRAINTS",
                "unrelated fixture material",
                50,
            )
            .unwrap();
        handler.bind_route(7, bound.clone());
        handler.set_guidance_now_ms_for_test(1768003200000);
        (handler, store, dir, bound)
    }

    fn outcome_bytes(outcome: HandlerOutcome) -> Vec<u8> {
        match outcome {
            HandlerOutcome::Response(bytes) => bytes,
            other => panic!("{other:?}"),
        }
    }
    async fn facades(handler: &McHandler) -> Value {
        let mut replies = Vec::new();
        for (name, arguments) in [
            ("ctx_search", json!({"query":"queue","sources":["memory"]})),
            ("ctx_expand", json!({"message":1})),
        ] {
            replies.push(outcome_bytes(
                handler
                    .dispatch_value(7, json!({"name":name,"arguments":arguments}))
                    .await,
            ));
        }
        json!(replies)
    }

    async fn legacy_lane(delta: bool) -> Value {
        let (handler, _, _dir, _) = fixture();
        let mut passes = Vec::new();
        for pass in 0..3 {
            let messages = if pass == 0 {
                vec![ck("m1", 1, "queue backpressure")]
            } else if delta && pass == 1 {
                vec![ck("m2", 2, "queue needs bounded drains")]
            } else {
                vec![
                    ck("m1", 1, "queue backpressure"),
                    ck("m2", 2, "queue needs bounded drains"),
                ]
            };
            let mut body = request(messages);
            body["native_messages"] = json!([]);
            body["full_array_fingerprint"] = json!(format!("i3-{pass}"));
            body["auto_search_enabled"] = json!(true);
            body["auto_search_min_prompt_chars"] = json!(0);
            body["auto_search_score_threshold"] = json!(0.0);
            if delta && pass == 1 {
                body["tail_delta"] =
                    json!({"after":"i3-0","replace_from":1,"native_replace_from":0});
            }
            if pass == 2 {
                body["model_key"] = json!("next-model");
            }
            let response = call_transform_request(&handler, body).await;
            assert_eq!(response["status"], "ok");
            assert!(response["ck_messages"].is_array());
            assert!(response["decision"].is_string());
            passes.push(json!({"pass_kind":response["decision"],"scheduler_decision":response["scheduler_decision"],
                "served_bytes":serde_json::to_vec(&response["ck_messages"]).unwrap(),"native_bytes":serde_json::to_vec(&response["native_messages"]).unwrap()}));
        }
        json!({"passes":passes,"facades":facades(&handler).await})
    }

    fn native(ordinal: u64, text: &str) -> Value {
        json!({"ordinal":ordinal,"mid":format!("m{ordinal}"),"message":{"info":{"id":format!("m{ordinal}"),"role":"user","time":{"created":1}},"parts":[{"id":format!("p{ordinal}"),"type":"text","text":text}]}})
    }
    async fn provider_lane() -> Value {
        let (handler, store, _dir, _bound) = fixture();
        let setup = json!({"session":"ses","harness":"opencode","request_id":"setup","preset":"head","params":{"serializer_profile":"opencode-aisdk","observation":"answer","auto_search_enabled":true,"auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0},"composition":{},"model":"fixture","context_window":100000,"now":1,"lineage_id":"L"});
        outcome_bytes(
            handler
                .dispatch_value(
                    7,
                    json!({"method":"transform.declare","params":{"params":setup["params"]}}),
                )
                .await,
        );
        outcome_bytes(
            handler
                .dispatch_value(7, json!({"method":"compaction.setup","params":setup}))
                .await,
        );
        let entries = vec![
            native(1, "queue backpressure"),
            native(2, "queue needs bounded drains"),
        ];
        let mut applied = Value::Null;
        let mut served = Value::Null;
        let mut passes = Vec::new();
        for pass in 0..3 {
            let mut step = json!({"session":"ses","harness":"opencode","request_id":format!("step-{pass}"),"lineage_id":"L","step_id":format!("st-{pass}"),"step_kind":"user_turn","model":"fixture","context_window":100000,"estimate":{"request_tokens":1000},"messages":if pass==0 {entries.clone()} else {vec![]},"newest":{"ordinal":2,"mid":"m2"},"now":2+pass});
            if pass == 0 {
                step["prefix_rebuilding"] = json!({"reason":"pipeline_switch"});
            } else {
                step["last_applied"] = applied.clone();
            }
            if pass == 2 {
                step["model"] = json!("next-model");
                step["prefix_rebuilding"] = json!({"reason":"model_switch"});
            }
            let bytes = outcome_bytes(
                handler
                    .dispatch_value(7, json!({"method":"compaction.step","params":step}))
                    .await,
            );
            let response: Value = serde_json::from_slice(&bytes).unwrap();
            assert!(
                response["answer"] == "noop" || response["answer"] == "compaction_message",
                "{response}"
            );
            if response["answer"] == "compaction_message" {
                applied = response["compaction"].clone();
                served = applied["replacement"].clone();
            }
            assert!(served.is_array());
            passes.push(json!({"pass_kind":response["answer"],"served_bytes":serde_json::to_vec(&served).unwrap()}));
        }
        store
            .seed_memory(
                2,
                "git:i3-served",
                "CONSTRAINTS",
                "queue needs bounded drains dispatch",
                80,
            )
            .unwrap();
        let plan = json!({"serializer_profile":"opencode-aisdk","observation":"answer","auto_search_enabled":true,"auto_search_min_prompt_chars":0,"auto_search_score_threshold":0.0});

        let message = native(3, "queue needs bounded drains dispatch")["message"].clone();
        outcome_bytes(handler.dispatch_value(7,json!({"method":"state_sync","session_id":"ses","provider_pass":{"lineage_id":"L","appended":[{"mid":"m3","ordinal":3,"message":message}],"physical_tail":{"mid":"m3","ordinal":3},"exact_pass_plan":"hard"}})).await);
        let hint = outcome_bytes(handler.dispatch_value(7,json!({"method":"transform.hook","params":{"session":"ses","harness":"opencode","params":plan,"lineage_id":"L","subject_mid":"m3","subject_ordinal":3,"message":message,"hook":"pre_user","blocks":["queue needs bounded drains dispatch"],"step_id":"hint"}})).await);
        assert!(
            String::from_utf8_lossy(&hint).contains("ctx-search-hint"),
            "provider auto-hint fixture must produce an augmentation: {}",
            String::from_utf8_lossy(&hint)
        );
        json!({"passes":passes,"auto_hint_reply_bytes":hint,"facades":facades(&handler).await})
    }

    #[tokio::test]
    async fn served_dispatch_matches_pre_integration_bytes_on_three_lanes() {
        for (lane, value, expected) in [
            (
                "current_rust",
                legacy_lane(true).await,
                "ee13bf2c5994c82fc20bfc901fdaccab634363b6da02cd70c762a9a3b5084e07",
            ),
            (
                "full_array",
                legacy_lane(false).await,
                "ee13bf2c5994c82fc20bfc901fdaccab634363b6da02cd70c762a9a3b5084e07",
            ),
            (
                "fast_rust_provider",
                provider_lane().await,
                "71a1bae8a33dc88f03504046f31edf0326105ed6b21b4fdfe1a1896f75638a9c",
            ),
        ] {
            let bytes = serde_json::to_vec(&value).unwrap();
            let digest = format!("{:x}", Sha256::digest(&bytes));
            println!(
                "I3_SERVED {lane} passes=3 bytes={} sha256={digest}",
                bytes.len()
            );
            assert_eq!(digest, expected, "{lane}");
        }
    }
}
