import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
const baseline =
	process.env.MC_HOLD_AUDIT_BASE ?? "2d19947cb6bd3724dad74f05073e1db08323f621";
const files = [
	"packages/plugin/src/hooks/magic-context/signed-thinking-prefix-audit.test.ts",
	"packages/pi-plugin/src/signed-thinking-prefix-audit.test.ts",
];

test("hold on retains the train's default audit and exact strict failure set", () => {
	const parent = join(tmpdir(), "magic-context", "signed-thinking-hold-audits");
	mkdirSync(parent, { recursive: true });
	const root = mkdtempSync(join(parent, "run-"));
	const oracle = join(root, "oracle");
	mkdirSync(oracle);
	const archive = Bun.spawnSync(
		[
			"bash",
			"-c",
			'set -o pipefail; git archive "$1" | tar -x -C "$2"',
			"--",
			baseline,
			oracle,
		],
		{ cwd: repository },
	);
	expect(archive.exitCode, archive.stderr.toString()).toBe(0);
	for (const name of ["plugin", "pi-plugin", "retina-local-fs"])
		symlinkSync(
			join(repository, "packages", name, "node_modules"),
			join(oracle, "packages", name, "node_modules"),
		);
	const audit = (cwd: string, strict: boolean, label: string) => {
		const home = join(root, label);
		mkdirSync(home);
		const result = Bun.spawnSync(["bun", "test", ...files], {
			cwd,
			env: {
				...process.env,
				HOME: home,
				XDG_CONFIG_HOME: join(home, "config"),
				XDG_DATA_HOME: join(home, "data"),
				MC_AUDIT_STRICT: strict ? "1" : "0",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = result.stderr.toString();
		const ran = stderr.match(/Ran (\d+) tests across (\d+) files/);
		expect(ran).not.toBeNull();
		expect(Number(ran?.[1])).toBeGreaterThanOrEqual(171);
		expect(Number(ran?.[2])).toBe(2);
		const failures = [
			...new Set(
				stderr
					.split("\n")
					.filter((line) => line.startsWith("(fail) "))
					.map((line) =>
						line.replace(/^\(fail\) /, "").replace(/ \[[\d.]+ms\]$/, ""),
					),
			),
		].sort();
		console.log(
			`${label}: exit=${result.exitCode}; ${stderr.match(/\d+ pass\n\s+\d+ fail/)?.[0].replace(/\s+/g, " ")}; failures=${JSON.stringify(failures)}`,
		);
		return { exit: result.exitCode, failures };
	};
	const beforeDefault = audit(oracle, false, "before-default");
	const afterDefault = audit(repository, false, "after-default");
	expect(beforeDefault).toEqual({ exit: 0, failures: [] });
	expect(afterDefault).toEqual(beforeDefault);
	const beforeStrict = audit(oracle, true, "before-strict");
	const afterStrict = audit(repository, true, "after-strict");
	expect(afterStrict).toEqual(beforeStrict);
	if (process.env.MC_HOLD_AUDIT_EVIDENCE)
		writeFileSync(
			process.env.MC_HOLD_AUDIT_EVIDENCE,
			JSON.stringify(
				{ baseline, beforeDefault, afterDefault, beforeStrict, afterStrict },
				null,
				2,
			),
		);
}, 180000);
