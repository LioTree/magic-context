import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { loadPiConfig } from "./config/index";
import { resolveHistorianFromConfig } from "./index";

/**
 * A standalone Pi extension still resolves its own subagent historian when the
 * shared config selects `historian.runner: "host"`. It must not queue jobs in a
 * Rust module with no external worker to execute them. Rust transforms belong
 * to the separately constructed createPiBridgeAdapter, never to the standalone
 * extension's imports.
 */

const tempRoots: string[] = [];
const originalHome = process.env.HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

function makeTempRoot(prefix: string): string {
	const path = createTestTempDirFromPath(join(tmpdir(), prefix));
	tempRoots.push(path);
	return path;
}

function withHome(home: string): void {
	process.env.HOME = home;
	process.env.XDG_CONFIG_HOME = join(home, ".config");
}

function writeUserConfig(home: string, text: string): void {
	const path = join(home, ".config", "cortexkit", "magic-context.jsonc");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text, "utf-8");
}

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
	for (const path of tempRoots.splice(0)) {
		rmSync(path, { recursive: true, force: true });
	}
});

/** Every non-test TypeScript source file under `packages/pi-plugin/src`. */
function piSourceFiles(): string[] {
	const root = join(import.meta.dir);
	const found: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "__fixtures__" || entry.name === "fixtures")
					continue;
				walk(path);
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			if (entry.name.endsWith(".test.ts")) continue;
			found.push(path);
		}
	};
	walk(root);
	return found;
}

describe("standalone Pi and the historian host lane", () => {
	it("runs its own historian and never queues a run for a claimant", () => {
		// A claim lane needs two halves: something that queues a run and something
		// that claims it. Pi has neither, so a Pi session cannot leave a run queued
		// with nobody to answer it, whatever the runner setting says.
		const offenders = piSourceFiles().filter((path) => {
			const source = readFileSync(path, "utf-8");
			return (
				source.includes("historian.pending") ||
				source.includes("historian.claim") ||
				source.includes("historian.heartbeat") ||
				source.includes("historian.complete")
			);
		});
		expect(offenders).toEqual([]);

		// Only createPiBridgeAdapter may use the shared module-session kernel. The
		// standalone index.ts import graph must not reach that adapter.
		const kernelCallers = piSourceFiles().filter((path) => {
			const source = readFileSync(path, "utf-8");
			return (
				source.includes("ModuleSessionClient") ||
				source.includes("createModuleSessionKernel")
			);
		});
		const bridge = join(import.meta.dir, "bridge-adapter-pi.ts");
		expect(kernelCallers).toEqual([bridge]);
		const sources = new Set(piSourceFiles());
		const reached = new Set<string>();
		const scanner = new Bun.Transpiler({ loader: "ts" });
		const visit = (path: string): void => {
			if (reached.has(path)) return;
			reached.add(path);
			for (const dependency of scanner.scan(readFileSync(path, "utf8"))
				.imports) {
				if (!dependency.path.startsWith(".")) continue;
				const base = resolve(dirname(path), dependency.path);
				const target = [base, `${base}.ts`, join(base, "index.ts")].find(
					(candidate) => sources.has(candidate),
				);
				if (target) visit(target);
			}
		};
		visit(join(import.meta.dir, "index.ts"));
		expect(reached.has(bridge)).toBe(false);
	});

	it("accepts historian.runner=host in shared config and resolves the Pi subagent historian anyway", () => {
		const cwd = makeTempRoot("mc-pi-host-lane-cwd-");
		const home = makeTempRoot("mc-pi-host-lane-home-");
		withHome(home);
		writeUserConfig(
			home,
			JSON.stringify({
				transform_mode: "rust",
				historian: { runner: "host", pi: { model: "prov/historian-model" } },
			}),
		);

		const result = loadPiConfig({ cwd });
		// The schema is shared between harnesses, so the key parses here. Recorded
		// rather than approved of: it is accepted on a harness that cannot act on it,
		// and nothing tells the user that.
		expect(result.config.historian?.runner).toBe("host");
		expect(result.warnings).toEqual([]);

		const historian = resolveHistorianFromConfig(result.config);
		expect(historian).toBeDefined();
		// `PiHistorianOptions.runner` is the subagent runner Pi drives its own
		// historian through — the same object whatever `historian.runner` says. The
		// name collision is unfortunate and is worth knowing about; what matters here
		// is that the completion still happens inside the Pi session.
		expect(historian?.runner?.constructor?.name).toBe("PiSubagentRunner");
		expect(historian?.model).toBe("prov/historian-model");
	});
});
