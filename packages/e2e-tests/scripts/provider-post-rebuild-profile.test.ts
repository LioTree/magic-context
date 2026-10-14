import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { diagnosticSources } from "./provider-post-rebuild-profile";

const root = resolve(import.meta.dir, "../../..");
const paths = [
	"crates/mc-store/src/provider_meters.rs",
	"crates/mc-store/src/provider_log.rs",
	"crates/mc-store/src/provider_log/policy_index.rs",
	"crates/mc-module/src/providers/step_transform.rs",
	"crates/mc-module/src/providers/policy_summary.rs",
	"crates/mc-module/src/providers/compaction.rs",
];
const sources = () =>
	Object.fromEntries(
		paths.map((path) => [path, readFileSync(resolve(root, path), "utf8")]),
	);

test("diagnostic overlay instruments six copies without changing the input or product files", () => {
	const original = sources();
	const preserved = { ...original };
	const generated = diagnosticSources(original);
	expect(original).toEqual(preserved);
	expect(sources()).toEqual(preserved);
	expect(Object.keys(generated).sort()).toEqual([...paths].sort());
	for (const path of paths) expect(generated[path]).not.toBe(original[path]);
	for (const stage of [
		"effective_parts_read_decode",
		"channel1_compute_baseline",
		"summary_build",
		"summary_serialize",
	]) {
		expect(
			generated["crates/mc-module/src/providers/policy_summary.rs"],
		).toContain(`"${stage}"`);
	}
	for (const stage of ["baseline_restate", "baseline_extract_clone"]) {
		expect(generated["crates/mc-store/src/provider_log.rs"]).toContain(
			`"${stage}"`,
		);
	}
	for (const stage of [
		"summary_validate",
		"summary_write",
		"change_log_clear",
	]) {
		expect(
			generated["crates/mc-store/src/provider_log/policy_index.rs"],
		).toContain(`"${stage}"`);
	}
	for (const stage of [
		"request_prepare_codec",
		"rebuild_preparation_total",
		"view_sql_load",
		"view_json_decode",
		"view_applied_engine_clone",
		"view_produced_engine_clone",
	]) {
		expect(generated["crates/mc-module/src/providers/compaction.rs"]).toContain(
			`"${stage}"`,
		);
	}
});

test("diagnostic overlay refuses source drift instead of silently omitting an executed stage", () => {
	const original = sources();
	const policy = "crates/mc-module/src/providers/policy_summary.rs";
	original[policy] = original[policy]!.replace(
		"let parts = index.all_parts()?;",
		"let parts = index.missing_profile_seam()?;",
	);
	expect(() => diagnosticSources(original)).toThrow("unique diagnostic seam");
});
