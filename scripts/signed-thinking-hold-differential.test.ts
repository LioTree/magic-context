import { expect, test } from "bun:test";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
// Master e75dcf1a includes the always-on signed-prefix safety fix, including
// first-render rewrites. Compare the disabled experimental admission against those
// shipped bytes and decisions, not the earlier pre-fix implementation.
const base =
	process.env.MC_HOLD_ORACLE_BASE ?? "e75dcf1a1daf47e49c01364db6f1866bf792e0d3";

function run(command: string[], cwd: string, env?: Record<string, string>) {
	const result = Bun.spawnSync(command, {
		cwd,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(
			`${command.join(" ")}\n${result.stdout.toString()}\n${result.stderr.toString()}`,
		);
	return result.stdout.toString();
}

test("signed-thinking hold off matches released master served bytes and stored decisions (seed 630665)", () => {
	const parent = join(
		tmpdir(),
		"magic-context",
		"signed-thinking-hold-differential",
	);
	mkdirSync(parent, { recursive: true });
	const root = mkdtempSync(join(parent, "run-"));
	const oracle = join(root, "oracle");
	mkdirSync(oracle);
	run(
		[
			"bash",
			"-c",
			'set -o pipefail; git archive "$1" | tar -x -C "$2"',
			"--",
			base,
			oracle,
		],
		repository,
	);
	for (const packageName of ["plugin", "pi-plugin", "retina-local-fs"]) {
		symlinkSync(
			join(repository, "packages", packageName, "node_modules"),
			join(oracle, "packages", packageName, "node_modules"),
		);
	}
	copyFileSync(
		join(repository, "scripts/signed-thinking-hold-corpus.ts"),
		join(oracle, "scripts/signed-thinking-hold-corpus.ts"),
	);
	const capture = (source: string, label: string, harness: string) => {
		const home = join(root, label);
		mkdirSync(home, { recursive: true });
		// Both sources use the same project path, but independent HOME/XDG roots.
		// Sharing session ledgers would let the candidate inherit the oracle's state.
		const projectRoot = join(root, "projects", harness);
		const output = join(root, `${label}.json`);
		console.log(
			run(["bun", "scripts/signed-thinking-hold-corpus.ts"], source, {
				HOME: home,
				XDG_CONFIG_HOME: join(home, "config"),
				XDG_DATA_HOME: join(home, "data"),
				MC_HOLD_CORPUS_ROOT: projectRoot,
				MC_HOLD_CORPUS_OUTPUT: output,
				MC_HOLD_SETTING: "off",
				MC_HOLD_HARNESS: harness,
			}).trim(),
		);
		return JSON.parse(readFileSync(output, "utf8"));
	};
	for (const harness of ["opencode", "pi"]) {
		const expected = capture(oracle, `pre-hold-${harness}`, harness);
		const actual = capture(repository, `hold-off-${harness}`, harness);
		expect(actual.length).toBe(504);
		for (let index = 0; index < actual.length; index++) {
			expect(actual[index], `${harness} pass ${index}`).toEqual(
				expected[index],
			);
		}
	}
}, 180000);

const rustTest =
	process.env.MC_HOLD_RUST_DIFFERENTIAL === "1" ? test : test.skip;
rustTest(
	"Rust signed-thinking hold off matches pre-hold served bytes and stored decisions (seed 630665)",
	() => {
		const parent = join(
			tmpdir(),
			"magic-context",
			"signed-thinking-hold-rust-differential",
		);
		mkdirSync(parent, { recursive: true });
		const root = mkdtempSync(join(parent, "run-"));
		const oracle = join(root, "oracle");
		mkdirSync(oracle);
		run(
			[
				"bash",
				"-c",
				'set -o pipefail; git archive "$1" | tar -x -C "$2"',
				"--",
				base,
				oracle,
			],
			repository,
		);
		const testPath =
			"crates/mc-module/tests/signed_thinking_hold_off_corpus.rs";
		const fixture = readFileSync(join(repository, testPath), "utf8").replace(
			/\s*signed_thinking_hold: mc_module::config::SignedThinkingHold::Off,/,
			"",
		);
		require("node:fs").writeFileSync(join(oracle, testPath), fixture);
		// git archive keeps the source files' old timestamps, which can make Cargo
		// treat another revision's cached build as fresh. Key artifacts by revision
		// so the oracle never reuses another baseline's tokenizer or module metadata.
		const oracleRevision = run(["git", "rev-parse", base], repository).trim();
		const capture = (source: string, label: string) => {
			const output = join(root, `${label}.json`);
			console.log(
				run(
					[
						"cargo",
						"test",
						"-p",
						"mc-module",
						"--test",
						"signed_thinking_hold_off_corpus",
						"--",
						"--nocapture",
					],
					source,
					{
						MC_HOLD_RUST_CORPUS_OUTPUT: output,
						TMPDIR: root,
						CARGO_NET_OFFLINE: "true",
						CARGO_TARGET_DIR:
							label === "pre-hold"
								? join(
										process.env.CARGO_TARGET_DIR ?? join(repository, "target"),
										"hold-oracle",
										oracleRevision,
									)
								: (process.env.CARGO_TARGET_DIR ?? join(repository, "target")),
					},
				).trim(),
			);
			return JSON.parse(readFileSync(output, "utf8"));
		};
		const expected = capture(oracle, "pre-hold");
		const actual = capture(repository, "hold-off");
		expect(actual.length).toBe(1008);
		for (let index = 0; index < actual.length; index++)
			expect(actual[index], `Rust pass ${index}`).toEqual(expected[index]);
	},
	1800000,
);

for (const harness of ["opencode", "pi"] as const) {
	test(`${harness === "opencode" ? "OpenCode" : "Pi"} first-render gate switches between released rewrite and experimental parking`, () => {
		const root = mkdtempSync(join(tmpdir(), "first-render-gate-"));
		const capture = (setting: "off" | "on") => {
			const home = join(root, setting);
			mkdirSync(home);
			const output = join(root, `${setting}.json`);
			run(["bun", "scripts/signed-thinking-hold-cold-corpus.ts"], repository, {
				HOME: home,
				XDG_CONFIG_HOME: join(home, "config"),
				XDG_DATA_HOME: join(home, "data"),
				MC_HOLD_CORPUS_ROOT: join(root, "projects"),
				MC_HOLD_CORPUS_OUTPUT: output,
				MC_HOLD_HARNESS: harness,
				MC_HOLD_SETTING: setting,
			});
			return JSON.parse(readFileSync(output, "utf8"));
		};
		const off = capture("off");
		const on = capture("on");
		const signature = harness === "opencode"
			? '"signature":"cold-signed"'
			: '"thinkingSignature":"cold-signed"';
		expect(off.served).not.toContain(signature);
		expect(on.served).toContain(signature);
		expect(off.compressedDepth).toBeGreaterThan(0);
		expect(on.compressedDepth ?? 0).toBe(0);
	}, 60000);
	const label = harness === "opencode" ? "OpenCode" : "Pi";
	test(`${label} cold signed-thinking bootstrap matches master bytes and decisions`, () => {
		const parent = join(
			tmpdir(),
			"magic-context",
			"signed-thinking-hold-cold-differential",
		);
		mkdirSync(parent, { recursive: true });
		const root = mkdtempSync(join(parent, "run-"));
		const oracle = join(root, "oracle");
		mkdirSync(oracle);
		run(
			[
				"bash",
				"-c",
				'set -o pipefail; git archive "$1" | tar -x -C "$2"',
				"--",
				base,
				oracle,
			],
			repository,
		);
		for (const name of ["plugin", "pi-plugin", "retina-local-fs"]) {
			symlinkSync(
				join(repository, "packages", name, "node_modules"),
				join(oracle, "packages", name, "node_modules"),
			);
		}
		const driver = "scripts/signed-thinking-hold-cold-corpus.ts";
		copyFileSync(join(repository, driver), join(oracle, driver));
		const capture = (source: string, name: string) => {
			const home = join(root, name);
			mkdirSync(home);
			const output = join(root, `${name}.json`);
			console.log(
				run(["bun", driver], source, {
					HOME: home,
					XDG_CONFIG_HOME: join(home, "config"),
					XDG_DATA_HOME: join(home, "data"),
					MC_HOLD_CORPUS_ROOT: join(root, "projects"),
					MC_HOLD_CORPUS_OUTPUT: output,
					MC_HOLD_HARNESS: harness,
				}).trim(),
			);
			return JSON.parse(readFileSync(output, "utf8"));
		};
		const expected = capture(oracle, "master");
		const actual = capture(repository, "hold-off");
		expect(expected.rowBefore).toEqual({
			cached_m0_bytes: null,
			cached_m1_bytes: null,
		});
		expect(expected.pending).toEqual([]);
		expect(expected.compressedDepth).toBeGreaterThan(0);
		expect(actual).toEqual(expected);
	}, 60000);
}

const rustColdTest =
	process.env.MC_HOLD_RUST_COLD_DIFFERENTIAL === "1" ? test : test.skip;
rustColdTest(
	"Rust cold signed-thinking bootstrap matches master bytes and decisions",
	() => {
		const parent = join(
			tmpdir(),
			"magic-context",
			"signed-thinking-hold-cold-rust-differential",
		);
		mkdirSync(parent, { recursive: true });
		const root = mkdtempSync(join(parent, "run-"));
		const oracle = join(root, "oracle");
		mkdirSync(oracle);
		run(
			[
				"bash",
				"-c",
				'set -o pipefail; git archive "$1" | tar -x -C "$2"',
				"--",
				base,
				oracle,
			],
			repository,
		);
		const path = "crates/mc-module/tests/signed_thinking_hold_off_corpus.rs";
		const fixture = readFileSync(join(repository, path), "utf8").replace(
			/\s*signed_thinking_hold: mc_module::config::SignedThinkingHold::Off,/,
			"",
		);
		require("node:fs").writeFileSync(join(oracle, path), fixture);
		const revision = run(["git", "rev-parse", base], repository).trim();
		const capture = (source: string, label: string) => {
			const output = join(root, `${label}.json`);
			console.log(
				run(
					[
						"cargo",
						"test",
						"-p",
						"mc-module",
						"--test",
						"signed_thinking_hold_off_corpus",
						"signed_thinking_hold_off_cold_bootstrap",
						"--",
						"--exact",
						"--nocapture",
					],
					source,
					{
						MC_HOLD_RUST_COLD_OUTPUT: output,
						TMPDIR: root,
						CARGO_NET_OFFLINE: "true",
						CARGO_TARGET_DIR:
							label === "master"
								? join(
										process.env.CARGO_TARGET_DIR ?? join(repository, "target"),
										"hold-oracle",
										revision,
									)
								: (process.env.CARGO_TARGET_DIR ?? join(repository, "target")),
					},
				).trim(),
			);
			return JSON.parse(readFileSync(output, "utf8"));
		};
		const expected = capture(oracle, "master");
		const actual = capture(repository, "hold-off");
		expect(expected.length).toBe(3);
		for (const record of expected) {
			expect(record.meta.initialized).toBe(true);
			for (const key of ["m0", "m1"]) {
				expect(
					record.core.frozen_units.some(
						(unit: { key: string }) => unit.key === key,
					),
				).toBe(true);
			}
		}
		expect(actual).toEqual(expected);
	},
	1800000,
);
