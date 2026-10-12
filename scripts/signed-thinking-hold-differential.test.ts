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
const base = "9d26c87081a9925217fa09698ce08e7a092e1f4d";

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

test("signed-thinking hold off matches pre-hold served bytes and stored decisions (seed 630665)", () => {
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
		const home = join(root, harness);
		mkdirSync(home, { recursive: true });
		const output = join(root, `${label}.json`);
		console.log(
			run(["bun", "scripts/signed-thinking-hold-corpus.ts"], source, {
				HOME: home,
				XDG_CONFIG_HOME: join(home, "config"),
				XDG_DATA_HOME: join(home, "data"),
				MC_HOLD_CORPUS_ROOT: home,
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
