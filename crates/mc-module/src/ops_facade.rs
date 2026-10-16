// These vectors specify MC's UI contract before its implementation. The hashes
// identify the reviewed thalamus-harness-mc-ui-surfaces.md and bridge-specs-for-
// thalamus.md design documents. The THALAMUS document's refreshed NDJSON contract
// supersedes its 86c854f8 digest. That streaming transport belongs to the host
// bridge; ck-mc supplies bounded event pages through authenticated method calls.
#[cfg(test)]
const OPS_VECTORS: &str = r#"
{
  "provenance": {
    "thalamus_sha256": "15c49d01a67ade1736d18c1c1ceb80d7ac0ab963be153018ff6fcefc408022c2",
    "bridge_sha256": "28bbe2780131017452feb4002ff3886374c1d763448181772b6ad31b572b2fc2",
    "sources": ["THALAMUS section 2 operation table", "THALAMUS section 4", "bridge items 3 and 4"],
    "oracle": "MC schemas specified before Rust implementation; not generated from Rust",
    "flush_correction":"Owner-authorized deferred-drop semantics: next transform performs protected/live-input checked reductions; the bridge must act on refresh obligations."
  },
  "partial": {"v":1,"ok":false,"state":"partial","reason":"store_unavailable","authority":"unknown","data":null},
  "authorization": [
    {"case":"missing_version","code":"bad_request"},
    {"case":"missing_session","code":"bad_request"},
    {"case":"empty_session","code":"bad_request"},
    {"case":"unbound","code":"route_unbound"},
    {"case":"foreign_session","code":"session_mismatch"}
  ],
  "reads": [
    {"method":"mc.read_sidebar","fields":["usage_percentage","input_tokens","context_limit","native_context_usage_percentage","compaction_enabled","system_prompt_tokens","compartment_count","archived_compartment_count","memory_count","memory_block_count","pending_ops_count","historian_running","compartment_in_progress","session_note_count","ready_smart_note_count","cache_ttl","last_transform_error","historian_failure_count","last_dreamer_run_at","project_identity","compartment_tokens","fact_tokens","memory_tokens","docs_tokens","profile_tokens","conversation_tokens","tool_call_tokens","tool_definition_tokens","host_limitations","tail_hygiene","execute_threshold","execute_threshold_clamped","boundary_present","coverage_ordinal","new_work_tokens","total_input_tokens","dreamer_backlog","dreamer_progress","dreamer_failures","dreamer_skipped","jobs"]},
    {"method":"mc.read_status","fields":["sidebar","compartment_scores","memory_importance","storage_schema_version","plugin_version","config_generation","config_warnings","tag_counts","tag_counts_authoritative","last_response_time","last_nudge_time","is_subagent","window_geometry","protected_tokens","history_budget","compression_budget","cache_ttl_ms","cache_remaining_ms","cache_expired","cache_ttl_source","cache_ttl_model","marker_retry_health","host_health","mc_health","embedding_summary","mural_age","rust_runner","memory_authority","mirror_frontier","unsupported_tasks","tick_failure","last_compartment","historian","reasoning_budget"]},
    {"method":"mc.read_embed","fields":["enabled","model","provider","synapse_descriptor","session","memories","commits","drain","status_text"]},
    {"method":"mc.read_compartment_count","fields":["count"]},
    {"method":"mc.read_todos","fields":["items","source"]}
  ],
  "read_envelope": {"v":1,"ok":true,"state":"ready","authority":"mc","session_id":"ops-a","project_identity":"project-a"},
  "unknown": {"value":null,"authority":"unknown","source":"not_ingested"},
  "known_empty_todos": {"items":[],"source":"todo_state.set"},
  "unported": ["mc.dream","mc.wrapup","mc.recomp_preview","mc.recomp_start","mc.rescore","mc.embed"],
  "refusal_code":"route_not_ported",
  "refusal_route_field":"message",
  "capabilities": {
    "schema_version":1,
    "emits_push":false,
    "manual_tasks":[],
    "full_recomp":false,
    "partial_recomp":false,
    "unified_wrapup":false,
    "manual_dream":false,
    "event_retention":256,
    "event_page_limit":64,
    "currentness_policy":"current_until_withdrawn",
    "command_retention":"session_lifetime",
    "job_scope_end":"retained_until_session_retirement"
  },
  "flush": {
    "command_id":"flush-1",
    "effect_count":1,
    "job_state":"armed",
    "result":{"queued_drops":{"state":"pending","count":2,"target_tag_ids":["tag-a","tag-b"]},"soft_refresh_pending":true,"bridge_refresh_obligations":["materialization","history","system"],"history_rebuilt":false},
    "duplicate":"same_job_same_result",
    "parameter_mismatch":"command_parameter_mismatch",
    "completion_hook":"deferred; no drained claim without transform acknowledgement",
    "superseding_flush":"superseded",
    "compaction_off":{"queued_drops":{"state":"pending","count":2,"target_tag_ids":["tag-a","tag-b"]},"soft_refresh_pending":false,"bridge_refresh_obligations":[],"history_rebuilt":false,"reason":"compaction_off"}
  },
  "jobs": {"lookup":"job_id_or_command_id","cancel_terminal":"too_late","cancel_armed":"cancel_unsupported","missing":"job_not_found","foreign_session":"job_not_found"},
  "events": {
    "acked_position":1,
    "through_sequence":3,
    "expected_sequences":[2,3],
    "currentness":{"policy":"current_until_withdrawn","current":true},
    "gap":"resync_required",
    "future_ack":"invalid_ack",
    "zero_limit":"bad_request",
    "unknown_currentness":{"policy":"current_until_withdrawn","current":false},
    "emits_push":false
  },
  "served_unchanged":["health","status","diagnostics","session.status","session.flush","session.recomp","session.wrapup","/ctx-status"]
}
"#;
