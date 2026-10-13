import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { updateSessionMeta } from "../../plugin/src/features/magic-context/storage-meta";
import { providerSubjects } from "../../plugin/src/hooks/magic-context/host-runner/opencode-adapter";
import {
	Driver,
	fixture,
	message,
	tools,
} from "./provider-pipeline-differential";

const ROOT = resolve(import.meta.dir, "../../..");
const STORE = "crates/mc-store/src/";
const MODULE = "crates/mc-module/src/providers/";
const instrumentedPaths = [
	`${STORE}provider_meters.rs`,
	`${STORE}provider_log.rs`,
	`${STORE}provider_log/policy_index.rs`,
	`${MODULE}step_transform.rs`,
	`${MODULE}policy_summary.rs`,
	`${MODULE}compaction.rs`,
];
const hash = (value: string | Uint8Array) =>
	createHash("sha256").update(value).digest("hex");

/** Each instrumentation patch must match exactly one expected statement; changed source must fail loudly rather than leave a stage unmeasured. */
export function diagnosticSources(
	original: Record<string, string>,
): Record<string, string> {
	const changed = { ...original };
	const patch = (path: string, before: string, after: string) => {
		const escapeRegex = (value: string) =>
			value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const expression = new RegExp(
			before
				.split("\n")
				.map((line) => `[ \\t]*${escapeRegex(line.trimStart())}`)
				.join("\n"),
			"g",
		);
		assert.equal(
			[...changed[path]!.matchAll(expression)].length,
			1,
			`unique diagnostic seam: ${path}: ${before.slice(0, 80)}`,
		);
		changed[path] = changed[path]!.replace(expression, after);
	};
	const store = `${STORE}provider_meters.rs`;
	changed[store] += String.raw`

// Diagnostic-only overlay; this module is never installed in the product source tree.
#[derive(serde::Serialize)]
struct DiagnosticProfile {
    kind: String, session: String, harness: String, request_id: String,
    stages_ms: std::collections::BTreeMap<String, f64>,
    calls: std::collections::BTreeMap<String, usize>,
    fields: std::collections::BTreeMap<String, usize>,
    total_ms: f64,
}
thread_local! {
    static DIAGNOSTIC_PROFILE: std::cell::RefCell<Option<DiagnosticProfile>> = const { std::cell::RefCell::new(None) };
}
pub struct DiagnosticProfileGuard {
    previous: Option<DiagnosticProfile>, started: std::time::Instant,
    _thread: std::marker::PhantomData<std::rc::Rc<()>>,
}
pub fn diagnostic_begin(kind: &str, session: &str, harness: &str, request: &str, started: std::time::Instant) -> DiagnosticProfileGuard {
    let current = DiagnosticProfile { kind: kind.into(), session: session.into(), harness: harness.into(), request_id: request.into(), stages_ms: Default::default(), calls: Default::default(), fields: Default::default(), total_ms: 0.0 };
    let previous = DIAGNOSTIC_PROFILE.with(|profile| profile.replace(Some(current)));
    DiagnosticProfileGuard { previous, started, _thread: std::marker::PhantomData }
}
pub fn diagnostic_record(name: &str, ms: f64) {
    DIAGNOSTIC_PROFILE.with(|profile| {
        if let Some(profile) = profile.borrow_mut().as_mut() {
            *profile.stages_ms.entry(name.into()).or_default() += ms;
            *profile.calls.entry(name.into()).or_default() += 1;
        }
    });
}
pub fn diagnostic_field(name: &str, value: usize) {
    DIAGNOSTIC_PROFILE.with(|profile| {
        if let Some(profile) = profile.borrow_mut().as_mut() { *profile.fields.entry(name.into()).or_default() += value; }
    });
}
pub fn diagnostic_measure<T>(name: &str, action: impl FnOnce() -> T) -> T {
    let start = std::time::Instant::now();
    let value = action();
    diagnostic_record(name, start.elapsed().as_secs_f64() * 1000.0);
    value
}
impl Drop for DiagnosticProfileGuard {
    fn drop(&mut self) {
        let profile = DIAGNOSTIC_PROFILE.with(|profile| profile.replace(self.previous.take()));
        if let Some(mut profile) = profile {
            profile.total_ms = self.started.elapsed().as_secs_f64() * 1000.0;
            use std::io::Write;
            let path = std::env::var("MC_DIAGNOSTIC_PROFILE_OUT").expect("diagnostic output path");
            let mut output = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
            writeln!(output, "{}", serde_json::to_string(&profile).unwrap()).unwrap();
        }
    }
}
`;
	const policy = `${MODULE}policy_summary.rs`;
	patch(
		policy,
		"    let parts = index.all_parts()?;\n    let inputs = transform::channel1_inputs_from_parts(",
		'    let parts = mc_store::provider_meters::diagnostic_measure("effective_parts_read_decode", || index.all_parts())?;\n    mc_store::provider_meters::diagnostic_field("effective_parts", parts.len());\n    let inputs = mc_store::provider_meters::diagnostic_measure("channel1_compute_baseline", || transform::channel1_inputs_from_parts(',
	);
	patch(
		policy,
		"        model_key,\n    );\n    // A cache-busting pass",
		"        model_key,\n    ));\n    // A cache-busting pass",
	);
	patch(
		policy,
		"    let mut next = settings.clone();\n    if froze {",
		'    mc_store::provider_meters::diagnostic_field("baseline_refrozen", usize::from(froze));\n    let next = mc_store::provider_meters::diagnostic_measure("baseline_convert_summary", || {\n    let mut next = settings.clone();\n    if froze {',
	);
	patch(
		policy,
		"    let summary = build(\n        &parts,",
		'    next });\n    let summary = mc_store::provider_meters::diagnostic_measure("summary_build", || build(\n        &parts,',
	);
	patch(
		policy,
		'        froze.then_some(inputs.baseline.baseline_parts.as_slice()),\n    )\n    .map(|summary| serde_json::to_string(&summary).expect("summary JSON"));',
		'        froze.then_some(inputs.baseline.baseline_parts.as_slice()),\n    ))\n    .map(|summary| mc_store::provider_meters::diagnostic_measure("summary_serialize", || serde_json::to_string(&summary).expect("summary JSON")));',
	);
	const hook = `${MODULE}step_transform.rs`;
	patch(
		hook,
		"    async fn provider_host_hook(\n        &self,\n        binding: SessionBinding,\n        key: Key,\n        call: &hooks::hook::HookCall,\n        params: &Value,\n    ) -> Result<Vec<u8>, HandlerOutcome> {",
		"    async fn provider_host_hook(\n        &self,\n        binding: SessionBinding,\n        key: Key,\n        call: &hooks::hook::HookCall,\n        params: &Value,\n    ) -> Result<Vec<u8>, HandlerOutcome> {\n        let diagnostic_started = Instant::now();",
	);
	patch(
		hook,
		"        let _serial = self.provider_serial.lock_for(&key).await;\n        let _meters = mc_store::provider_meters::ProviderStoreMeter::start(",
		'        let diagnostic_lock = Instant::now();\n        let _serial = self.provider_serial.lock_for(&key).await;\n        let _profile = mc_store::provider_meters::diagnostic_begin("hook", &key.session, &key.harness, params.get("request_id").and_then(Value::as_str).unwrap_or(""), diagnostic_started);\n        mc_store::provider_meters::diagnostic_record("lock_wait", diagnostic_lock.elapsed().as_secs_f64()*1000.0);\n        let _meters = mc_store::provider_meters::ProviderStoreMeter::start(',
	);
	patch(
		hook,
		'                    if ctx.counters.pointer("/engine_policy/baseline/baseline_generation")',
		'                    let diagnostic_baseline = Instant::now();\n                    if ctx.counters.pointer("/engine_policy/baseline/baseline_generation")',
	);
	patch(
		hook,
		"                    let (cadence_ops, mut policy) = host_channel1(&inputs,state);",
		'                    mc_store::provider_meters::diagnostic_record("baseline_convert_write", diagnostic_baseline.elapsed().as_secs_f64()*1000.0);\n                    let (cadence_ops, mut policy) = host_channel1(&inputs,state);',
	);
	const log = `${STORE}provider_log.rs`;
	patch(
		log,
		'                 if let Some(updates)=write.counters.as_object_mut().and_then(|c|c.remove("policy_baseline_updates")).and_then(|v|v.as_array().cloned()) {\n                     restate_baseline_measurements_tx(conn,&conv,&updates)?;\n                 }',
		'                 let updates = crate::provider_meters::diagnostic_measure("baseline_extract_clone", || write.counters.as_object_mut().and_then(|c|c.remove("policy_baseline_updates")).and_then(|v|v.as_array().cloned()));\n                 if let Some(updates) = updates {\n                     crate::provider_meters::diagnostic_field("baseline_updates", updates.len());\n                     crate::provider_meters::diagnostic_measure("baseline_restate", || restate_baseline_measurements_tx(conn,&conv,&updates))?;\n                 }',
	);
	const index = `${STORE}provider_log/policy_index.rs`;
	patch(
		index,
		"    parse(summary)?;\n    conn.execute(",
		'    crate::provider_meters::diagnostic_measure("summary_validate", || parse(summary))?;\n    crate::provider_meters::diagnostic_field("summary_bytes", summary.len());\n    crate::provider_meters::diagnostic_measure("summary_write", || conn.execute(',
	);
	patch(
		index,
		'        params![conv, summary],\n    )?;\n    conn.execute(\n        "DELETE FROM mc_provider_policy_changes_v1 WHERE conv_key=?1",\n        [conv],\n    )?;',
		'        params![conv, summary],\n    ))?;\n    let cleared = crate::provider_meters::diagnostic_measure("change_log_clear", || conn.execute(\n        "DELETE FROM mc_provider_policy_changes_v1 WHERE conv_key=?1",\n        [conv],\n    ))?;\n    crate::provider_meters::diagnostic_field("changes_cleared", cleared);',
	);
	const compact = `${MODULE}compaction.rs`;
	patch(
		compact,
		"    let replay_ms = started.elapsed().as_secs_f64() * 1000.0;",
		'    let replay_ms = started.elapsed().as_secs_f64() * 1000.0;\n    mc_store::provider_meters::diagnostic_record("replay", replay_ms);\n    let diagnostic_prepare = Instant::now();',
	);
	patch(
		compact,
		"    Codec::OpencodeAiSdk.prepare_request(&mut template, &messages)?;",
		'    mc_store::provider_meters::diagnostic_measure("request_prepare_codec", || Codec::OpencodeAiSdk.prepare_request(&mut template, &messages))?;',
	);
	patch(
		compact,
		"    let previous = setup\n        .produced",
		'    mc_store::provider_meters::diagnostic_record("rebuild_prepare_before_views", diagnostic_prepare.elapsed().as_secs_f64()*1000.0);\n    let diagnostic_views = Instant::now();\n    let previous = setup\n        .produced',
	);
	patch(
		compact,
		'        let _span =\n            tracing::info_span!("provider_step", request_id = %request.request_id).entered();',
		'        let _profile = mc_store::provider_meters::diagnostic_begin("rebuild", &work.key.session, &work.key.harness, &request.request_id, Instant::now());\n        let _span = tracing::info_span!("provider_step", request_id = %request.request_id).entered();',
	);
	patch(
		compact,
		"    let row = store\n        .load_provider_view(&key.store_key(), summary.version)",
		'    let row = mc_store::provider_meters::diagnostic_measure("view_sql_load", || store\n        .load_provider_view(&key.store_key(), summary.version))',
	);
	patch(
		compact,
		"    let mut view: HostView = serde_json::from_str(&row.replacement_json).map_err(transient)?;",
		'    mc_store::provider_meters::diagnostic_field("view_json_bytes", row.replacement_json.len());\n    let mut view: HostView = mc_store::provider_meters::diagnostic_measure("view_json_decode", || serde_json::from_str(&row.replacement_json)).map_err(transient)?;',
	);
	patch(
		compact,
		"    view.engine.range.lineage_id = summary.range.lineage_id.clone();",
		'    mc_store::provider_meters::diagnostic_measure("view_lineage_rebase", || { view.engine.range.lineage_id = summary.range.lineage_id.clone(); });',
	);
	patch(
		compact,
		"                let mut engine = view.engine.clone();",
		'                let mut engine = mc_store::provider_meters::diagnostic_measure("view_applied_engine_clone", || view.engine.clone());',
	);
	patch(
		compact,
		"    state.last_produced = previous.as_ref().map(|v| v.engine.clone());",
		'    state.last_produced = previous.as_ref().map(|v| mc_store::provider_meters::diagnostic_measure("view_produced_engine_clone", || v.engine.clone()));',
	);
	patch(
		compact,
		"    let pending = store\n        .load_provider_pending_drops(&work.key.store_key())",
		'    mc_store::provider_meters::diagnostic_record("view_materialization_total", diagnostic_views.elapsed().as_secs_f64()*1000.0);\n    let diagnostic_drops = Instant::now();\n    let pending = store\n        .load_provider_pending_drops(&work.key.store_key())',
	);
	patch(
		compact,
		"    let prepare_ms = started.elapsed().as_secs_f64() * 1000.0 - replay_ms;",
		'    mc_store::provider_meters::diagnostic_record("rebuild_prepare_drops", diagnostic_drops.elapsed().as_secs_f64()*1000.0);\n    mc_store::provider_meters::diagnostic_record("rebuild_preparation_total", diagnostic_prepare.elapsed().as_secs_f64()*1000.0);\n    let prepare_ms = started.elapsed().as_secs_f64() * 1000.0 - replay_ms;',
	);
	patch(compact, "    let engine_ms = engine_started.elapsed().as_secs_f64() * 1000.0;",
		'    let engine_ms = engine_started.elapsed().as_secs_f64() * 1000.0;\n    mc_store::provider_meters::diagnostic_record("engine", engine_ms);');
	patch(compact, "        let wire = Codec::OpencodeAiSdk.encode_view(\n            &engine,\n            &template,\n            &super::codec_opencode::NativeRenderContext::from(&output.engine),\n        )?;",
		'        let wire = mc_store::provider_meters::diagnostic_measure("view_build", || Codec::OpencodeAiSdk.encode_view(\n            &engine,\n            &template,\n            &super::codec_opencode::NativeRenderContext::from(&output.engine),\n        ))?;');
	patch(compact, '                    save_host_view(store, &work.key, &view, "produced")?;',
		'                    mc_store::provider_meters::diagnostic_measure("view_store", || save_host_view(store, &work.key, &view, "produced"))?;');
	patch(compact, "replacement_json: serde_json::to_string(view).map_err(transient)?,",
		'replacement_json: mc_store::provider_meters::diagnostic_measure("view_store_encode", || serde_json::to_string(view)).map_err(transient)?,');
	patch(compact, '                    let mut answer = json!({"answer":"compaction_message","request_id":request.request_id,"compaction":view.wire});',
		'                    let mut answer = mc_store::provider_meters::diagnostic_measure("response_value", || json!({"answer":"compaction_message","request_id":request.request_id,"compaction":view.wire}));');
	patch(compact, '                prepared, preparation_ms = started.elapsed().as_secs_f64()*1000.0,\n                "provider policy preparation complete");',
		'                prepared, preparation_ms = started.elapsed().as_secs_f64()*1000.0,\n                "provider policy preparation complete");\n            mc_store::provider_meters::diagnostic_record("preparation", started.elapsed().as_secs_f64()*1000.0);');
	patch(compact, "        bytes(&answer)\n    }\n\n    fn provider_work(",
		'        mc_store::provider_meters::diagnostic_measure("response_encode", || bytes(&answer))\n    }\n\n    fn provider_work(');
	return changed;
}

export interface StageProfile {
	kind: "hook" | "rebuild";
	session: string;
	harness: string;
	request_id: string;
	stages_ms: Record<string, number>;
	calls: Record<string, number>;
	fields: Record<string, number>;
	total_ms: number;
}
export function systemSample() {
	const run = (command: string, args: string[]) => {
		const value = spawnSync(command, args, { encoding: "utf8" });
		assert.equal(value.status, 0, `${command}: ${value.stderr}`);
		return value.stdout.trim();
	};
	const optional = (path: string) =>
		existsSync(path) ? readFileSync(path, "utf8").trim() : null;
	const stat = optional("/sys/fs/cgroup/cpu.stat");
	return {
		at: new Date().toISOString(),
		uptime: run("uptime", []),
		nproc: Number(run("nproc", [])),
		cpu_stat: stat
			? Object.fromEntries(
					stat.split("\n").map((line) => {
						const [name, value] = line.split(/\s+/);
						return [name, Number(value)];
					}),
				)
			: null,
		cpu_max: optional("/sys/fs/cgroup/cpu.max"),
		cpuset: optional("/sys/fs/cgroup/cpuset.cpus.effective"),
		host_cpu_pressure: optional("/proc/pressure/cpu"),
		cgroup_cpu_pressure: optional("/sys/fs/cgroup/cpu.pressure"),
		loadavg: optional("/proc/loadavg"),
	};
}
export function profileById(path: string, id: string): StageProfile {
	const rows = readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as StageProfile);
	const matches = rows.filter((row) => row.request_id === id);
	assert.equal(matches.length, 1, `one completed diagnostic profile for ${id}`);
	return matches[0]!;
}
function psiTotal(value: string | null): number | null {
	const match = value?.match(/^some\s.*\btotal=(\d+)/m);
	return match ? Number(match[1]) : null;
}
export function psiDelta(
	before: ReturnType<typeof systemSample>,
	after: ReturnType<typeof systemSample>,
) {
	const difference = (a: string | null, b: string | null) => {
		const start = psiTotal(a),
			end = psiTotal(b);
		return start === null || end === null ? null : end - start;
	};
	return {
		host_some_total_usec: difference(
			before.host_cpu_pressure,
			after.host_cpu_pressure,
		),
		cgroup_some_total_usec: difference(
			before.cgroup_cpu_pressure,
			after.cgroup_cpu_pressure,
		),
		wall_ms: Date.parse(after.at) - Date.parse(before.at),
	};
}

/** Instrument only a temporary source copy. Await real handlers directly to observe their full work, without altering the host's 1,500 ms timeout. */
export async function postRebuildProfile(measurement?: (driver: Driver, output: string, stores: string) => Promise<unknown>) {
	assert.equal(process.platform, "linux", "run this diagnostic on Linux");
	process.env.MC_POLICY_SUMMARY_SKIP_FULL_CHECK = "1";
	const parent = join(
		tmpdir(),
		"magic-context",
		"provider-post-rebuild-profile",
	);
	mkdirSync(parent, { recursive: true });
	const work = mkdtempSync(join(parent, "run-"));
	const source = join(work, "source");
	mkdirSync(source);
	const revision = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: ROOT,
		encoding: "utf8",
	});
	assert.equal(revision.status, 0);
	const archive = spawnSync(
		"git",
		["archive", "--format=tar", revision.stdout.trim()],
		{ cwd: ROOT, maxBuffer: 512 * 1024 * 1024 },
	);
	assert.equal(archive.status, 0, archive.stderr.toString());
	const extracted = spawnSync("tar", ["-x", "-C", source], {
		input: archive.stdout,
	});
	assert.equal(extracted.status, 0, extracted.stderr.toString());
	for (const packagePath of [
		"",
		"packages/plugin",
		"packages/pi-plugin",
		"packages/retina-local-fs",
		"packages/e2e-tests",
	]) {
		const dependency = join(ROOT, packagePath, "node_modules");
		if (existsSync(dependency))
			symlinkSync(dependency, join(source, packagePath, "node_modules"), "dir");
	}
	const originals = Object.fromEntries(
		instrumentedPaths.map((path) => [
			path,
			readFileSync(join(source, path), "utf8"),
		]),
	);
	for (const path of instrumentedPaths)
		assert.equal(
			hash(originals[path]!),
			hash(readFileSync(join(ROOT, path))),
			`production source matches archived HEAD: ${path}`,
		);
	const changed = diagnosticSources(originals);
	for (const [path, content] of Object.entries(changed))
		writeFileSync(join(source, path), content);
	const output = join(work, "profiles.jsonl");
	process.env.MC_DIAGNOSTIC_PROFILE_OUT = output;
	// Keep normal and instrumented builds in separate Cargo targets so their cached libraries cannot be reused for each other.
	process.env.CARGO_TARGET_DIR = join(
		process.env.CARGO_TARGET_DIR ?? join(ROOT, "target"),
		"provider-post-rebuild-diagnostic",
	);
	const copied = await import(
		pathToFileURL(
			join(
				source,
				"packages/e2e-tests/scripts/provider-pipeline-differential.ts",
			),
		).href
	);
	const build = join(work, "build");
	const stores = join(work, "stores");
	mkdirSync(stores);
	const driver = new Driver(copied.buildDriver(build), stores);
	if (measurement) {
		try { return await measurement(driver, output, stores); }
		finally {
			await driver.close();
			for (const path of instrumentedPaths)
				assert.equal(hash(readFileSync(join(ROOT, path))), hash(originals[path]!), `production source unchanged after profiling: ${path}`);
		}
	}
	const samples = [];
	try {
		for (const host of ["OpenCode1", "OpenCode2"] as const) {
			for (let sample = 0; sample < 5; sample++) {
				const before = systemSample();
				const directory = join(stores, `${host}-${sample}`);
				const f = await fixture(driver, host, directory);
				try {
					updateSessionMeta(f.db, "session", {
						lastUsageContextLimit: 4_000_000,
					});
					const history = Array.from({ length: 17_000 }, (_, i) =>
						i % 5 === 0
							? message(
									`synthetic-${i}`,
									"user",
									`Inspect fixture ${i}: café 🦀`,
								)
							: i % 5 === 4
								? message(
										`synthetic-${i}`,
										"assistant",
										`Fixture ${i} complete`,
									)
								: tools(`synthetic-${i}`),
					);
					for (let warm = 0; warm < 3; warm++) await f.full(history);
					await f.pass(history);
					assert.equal(f.fallbacks.length, 0);
					assert.ok(f.adapter.isProviderSession("session"));
					const state = f.stored()!;
					const plan = JSON.parse(state.state.plan_json!);
					const baseStep = f.wires
						.filter((wire) => wire.method === "compaction.step")
						.at(-1)!.params;
					const harness = host === "OpenCode1" ? "opencode" : "opencode2";
					const callHook = (id: string, ordinal: number, model: string) => {
						const entry = message(
							id,
							"assistant",
							`post-rebuild ${sample}: café 🦀`,
						);
						(entry.info as { model: { modelID: string } }).model.modelID =
							model.slice("openai/".length);
						const subjects = providerSubjects(entry);
						assert.equal(subjects.length, 1);
						return f.call({
							method: "transform.hook",
							params: {
								...subjects[0],
								session: "session",
								harness,
								lineage_id: state.state.lineage_id,
								preset: plan.preset,
								params: plan.params,
								request_id: id,
								message: entry,
								subject_mid: entry.info.id,
								subject_ordinal: ordinal,
								served_through_ordinal: ordinal - 1,
								pass_complete: true,
							},
						});
					};
					// Warm the initial bootstrap's policy before forcing the measured publication/model rebuild.
					const warmId = `warm-${host}-${sample}-${randomUUID()}`;
					const newest = state.state.next_ordinal;
					await callHook(warmId, newest, "openai/gpt-5.6");
					await f.event("publish", { start: 1, end: 5, mid: "synthetic-4" });
					await f.event("flush");
					const model = `openai/gpt-5.6-profile-${sample}`;
					const rebuildId = `rebuild-${host}-${sample}-${randomUUID()}`;
					const step: Record<string, unknown> = {
						...baseStep,
						request_id: rebuildId,
						step_id: rebuildId,
						messages: [],
						newest: { ordinal: newest, mid: warmId },
						model,
						now: 2000,
						prefix_rebuilding: { reason: "model_switch" },
						last_applied: {
							compaction_id: state.views.at(-1)!.compaction_id,
							version: state.views.at(-1)!.version,
						},
						served_through_ordinal: newest,
					};
					delete step.more;
					delete step.last_not_applied;
					const measurementBefore = systemSample();
					const rebuilt = await f.call({
						method: "compaction.step",
						params: step,
					});
					assert.equal(
						rebuilt.answer,
						"compaction_message",
						"measured rebuild must produce a view",
					);
					const rebuildAfter = systemSample();
					const hookId = `probe-${host}-${sample}-${randomUUID()}`;
					const answered = await callHook(hookId, newest + 1, model);
					assert.equal(
						answered.answer,
						"ops",
						"first hook must finish its real tagged answer",
					);
					const hook = profileById(output, hookId);
					const rebuild = profileById(output, rebuildId);
					for (const stage of [
						"effective_parts_read_decode",
						"channel1_compute_baseline",
						"baseline_convert_write",
						"baseline_restate",
						"summary_serialize",
						"summary_write",
						"change_log_clear",
						"lock_wait",
					]) {
						assert.equal(hook.calls[stage], 1, `exactly one measured ${stage}`);
					}
					assert.equal(hook.fields.baseline_refrozen, 1);
					assert.ok(
						hook.fields.effective_parts! >= 74_000,
						"large effective lineage after the five-message publication",
					);
					assert.equal(
						rebuild.calls.view_sql_load,
						1,
						"the matching applied/produced view is loaded once",
					);
					const after = systemSample();
					const delta =
						before.cpu_stat && after.cpu_stat
							? Object.fromEntries(
									Object.keys(after.cpu_stat).map((key) => [
										key,
										after.cpu_stat![key]! - (before.cpu_stat![key] ?? 0),
									]),
								)
							: null;
					const measuredDelta =
						measurementBefore.cpu_stat && after.cpu_stat
							? Object.fromEntries(
									Object.keys(after.cpu_stat).map((key) => [
										key,
										after.cpu_stat![key]! -
											(measurementBefore.cpu_stat![key] ?? 0),
									]),
								)
							: null;
					const row = {
						host,
						sample,
						base_messages: 17_000,
						fixture_messages_at_probe: 17_002,
						before,
						measurement_before: measurementBefore,
						rebuild_after: rebuildAfter,
						after,
						cpu_stat_delta: delta,
						measured_cpu_stat_delta: measuredDelta,
						psi_delta: psiDelta(before, after),
						measured_psi_delta: psiDelta(measurementBefore, after),
						rebuild_psi_delta: psiDelta(measurementBefore, rebuildAfter),
						hook_psi_delta: psiDelta(rebuildAfter, after),
						hook,
						rebuild,
					};
					samples.push(row);
					console.log(`POST_REBUILD_SAMPLE=${JSON.stringify(row)}`);
					await f.noReads();
				} finally {
					await f.close();
				}
			}
		}
	} finally {
		await driver.close();
	}
	const provenance = instrumentedPaths.map((path) => ({
		path,
		original_sha256: hash(originals[path]!),
		diagnostic_sha256: hash(changed[path]!),
	}));
	for (const path of instrumentedPaths)
		assert.equal(
			hash(readFileSync(join(ROOT, path))),
			hash(originals[path]!),
			`production source unchanged after profiling: ${path}`,
		);
	const result = {
		schema: 1,
		revision: revision.stdout.trim(),
		bun: Bun.version,
		cpu_request: "linux,4c",
		work,
		measurement_kind: "diagnostic_only",
		product_changes: false,
		product_deadlines_changed: false,
		timing_scope:
			"real McHandler direct calls; rebuild followed by first hook; timers exist only in a scratch source archive",
		population:
			"five independent fresh 17k fixtures per binding; three full warmups, bootstrap, initial hook warmup, publication/model rebuild, measured first hook",
		contention_scope:
			"host and cgroup CPU PSI some-total deltas and cgroup cpu.stat; holder fields deliberately omitted",
		samples,
		provenance,
	};
	console.log(`POST_REBUILD_RESULT=${JSON.stringify(result)}`);
	if (Bun.argv[2])
		writeFileSync(Bun.argv[2], JSON.stringify(result, null, 2) + "\n");
	return result;
}

if (import.meta.main) await postRebuildProfile();
