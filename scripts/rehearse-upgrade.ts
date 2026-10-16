import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	readdirSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	firstDifference,
	integrity,
	inventory,
	snapshotRoot,
	version,
} from "./lib/upgrade-audit";

const repo = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	if (!args[index + 1] || args[index + 1].startsWith("--"))
		throw new Error(`${name} needs a value`);
	return args[index + 1];
};
if (args.includes("--help")) {
	console.log(
		"bun scripts/rehearse-upgrade.ts [--snapshot <offline-pair-directory>] [--release-archive <v0.49.7.tar>] [--report <markdown-path>]\nRequires Linux, Bun, Cargo offline dependencies and GNU /usr/bin/time. All execution and stores live under $TMPDIR/magic-context/rehearsal-early/run-*/.",
	);
	process.exit(0);
}
for (let i = 0; i < args.length; i += 2)
	if (!["--snapshot", "--release-archive", "--report"].includes(args[i]))
		throw new Error(`Unknown option ${args[i]}`);
// Resolve and reject live locations before changing HOME for child processes.
const snapshot = option("--snapshot")
	? snapshotRoot(option("--snapshot")!)
	: undefined;
const parent = join(tmpdir(), "magic-context", "rehearsal-early");
mkdirSync(parent, { recursive: true });
const root = realpathSync(mkdtempSync(join(parent, "run-")));
const oldTree = join(root, "release");
const baseline = join(root, "baseline");
const host = join(repo, "scripts/lib/upgrade-host.ts");
const reportPath = resolve(
	option("--report") ??
		join(
			repo,
			".cortexkit/internal-docs/reports",
			`upgrade-rehearsal-${new Date().toISOString().slice(0, 10)}.md`,
		),
);
const steps: {
	name: string;
	seconds: number;
	peakKiB: number;
	exit: number;
	output: string;
}[] = [];
const findings: string[] = [];
const evidence: Record<string, unknown> = {
	root,
	snapshot: snapshot ?? "synthetic v0.49.7",
	candidate: "",
	checks: {},
	versions: {},
	toolchain: {},
	tables: {},
	integrity: {},
	fingerprints: {},
	crashes: [],
	prompts: [],
	refusals: [],
};
const env: NodeJS.ProcessEnv = {
	...process.env,
	HOME: join(root, "home"),
	XDG_DATA_HOME: join(root, "data"),
	XDG_CONFIG_HOME: join(root, "config"),
	XDG_STATE_HOME: join(root, "state"),
	XDG_CACHE_HOME: join(root, "cache"),
	XDG_RUNTIME_DIR: join(root, "runtime"),
	MAGIC_CONTEXT_STORAGE_DIR: baseline,
	OPENCODE_DB: join(root, "unused-opencode.db"),
	MAGIC_CONTEXT_LOG_PATH: join(root, "rehearsal.log"),
	NODE_ENV: "test",
	RUSTC_WRAPPER: "",
	CARGO_BUILD_RUSTC_WRAPPER: "",
};
// Cargo's dependency cache is an input, not the isolated runtime HOME.
env.CARGO_HOME = process.env.CARGO_HOME ?? join(process.env.HOME!, ".cargo");
env.RUSTUP_HOME = process.env.RUSTUP_HOME ?? join(process.env.HOME!, ".rustup");
delete env.SUBC_MODULE_ID;
delete env.SUBC_LAUNCH_NONCE;
delete env.SUBC_LAUNCH_NONCE_FD;
for (const dir of [oldTree, baseline, env.HOME, env.XDG_RUNTIME_DIR])
	mkdirSync(dir!, { recursive: true, mode: 0o700 });

function run(
	name: string,
	command: string[],
	cwd = repo,
	extra: Record<string, string> = {},
	allowedFailure = false,
): string {
	const usage = join(root, `${steps.length}-usage.txt`);
	const result = spawnSync(
		"/usr/bin/time",
		["-f", "%e %M", "-o", usage, ...command],
		{
			cwd,
			env: { ...env, ...extra },
			encoding: "utf8",
			timeout: 1_200_000,
			maxBuffer: 32 * 1024 * 1024,
		},
	);
	const text = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error}` : ""}`;
	const metrics = existsSync(usage)
		? readFileSync(usage, "utf8")
				.trim()
				.split("\n")
				.at(-1)!
				.split(" ")
				.map(Number)
		: [NaN, NaN];
	const step = {
		name,
		seconds: metrics[0],
		peakKiB: metrics[1],
		exit: result.status ?? -1,
		output: text,
	};
	steps.push(step);
	writeFileSync(
		join(root, `${steps.length}-${name.replaceAll(/[^a-z0-9-]/gi, "_")}.log`),
		text,
	);
	console.log(
		`${name}: ${step.seconds}s, peak ${step.peakKiB} KiB, exit ${step.exit}`,
	);
	if (step.exit !== 0 && !allowedFailure)
		throw new Error(`${name}: exit ${step.exit}\n${text.slice(-5000)}`);
	return result.stdout ?? "";
}

function pairCopy(source: string, name: string): string {
	const dest = join(root, name);
	mkdirSync(dest, { recursive: true, mode: 0o700 });
	for (const db of ["context.db", "store.db"])
		copyFileSync(join(source, db), join(dest, db));
	return dest;
}

function check(label: string, body: () => void): void {
	try {
		body();
		(evidence.checks as Record<string, string>)[label] = "passed";
		console.log(`${label}: passed`);
	} catch (error) {
		(evidence.checks as Record<string, string>)[label] = "finding";
		findings.push(`${label}: ${String(error)}`);
		console.log(`${label}: finding`);
	}
}

function hash(path: string): string {
	return new Bun.CryptoHasher("sha256")
		.update(readFileSync(path))
		.digest("hex");
}
function fileHashes(dir: string): Record<string, string> {
	return Object.fromEntries(
		["context.db", "store.db", "context.db-wal", "store.db-wal"]
			.filter((f) => existsSync(join(dir, f)))
			.map((f) => [f, hash(join(dir, f))]),
	);
}
function assertPreserved(before: string, after: string): void {
	for (const name of ["context.db", "store.db"]) {
		const difference = firstDifference(join(before, name), join(after, name));
		if (difference)
			throw new Error(
				`${name} migrations ${name === "context.db" ? "96+" : "64+"}: ${difference}`,
			);
	}
}

type Fingerprints = {
	context: string;
	store: string;
	context_version: number;
	store_version: number;
	context_schema: unknown;
	store_schema: unknown;
};
let helper = "";
function fingerprints(dir: string): Fingerprints {
	return JSON.parse(
		run(`fingerprint-${dir.split("/").at(-1)}`, [helper, "fingerprint", dir]),
	);
}
function assertFingerprint(expected: Fingerprints, actual: Fingerprints): void {
	const differences: string[] = [];
	for (const db of ["context", "store"] as const) {
		if (expected[db] === actual[db]) continue;
		const left = expected[`${db}_schema`] as {
			master: unknown[][];
			tables: { name: string; columns: unknown[][] }[];
		};
		const right = actual[`${db}_schema`] as typeof left;
		const object = left.master.find(
			(row) =>
				JSON.stringify(row) !==
				JSON.stringify(
					right.master.find((next) => next[0] === row[0] && next[1] === row[1]),
				),
		);
		const table = left.tables.find(
			(row) =>
				JSON.stringify(row.columns) !==
				JSON.stringify(
					right.tables.find((next) => next.name === row.name)?.columns,
				),
		);
		const next = right.tables.find((row) => row.name === table?.name);
		const namePosition = db === "context" ? 0 : 1;
		const names = new Set([
			...(table?.columns ?? []).map((row) => row[namePosition]),
			...(next?.columns ?? []).map((row) => row[namePosition]),
		]);
		const name = [...names].find(
			(name) =>
				JSON.stringify(table?.columns.find((row) => row[namePosition] === name)) !==
				JSON.stringify(next?.columns.find((row) => row[namePosition] === name)),
		);
		const column = table?.columns.find((row) => row[namePosition] === name);
		const nextColumn = next?.columns.find((row) => row[namePosition] === name);
		differences.push(
			`${db}.db fingerprint ${actual[db]} != reference ${expected[db]}; first differing schema object ${object?.[0]}/${object?.[1]}, table ${table?.name}, column ${String(name)}: reference=${JSON.stringify(column)} upgraded=${JSON.stringify(nextColumn)}. Cause requires migration review.`,
		);
	}
	if (differences.length) throw new Error(differences.join("; "));
}

async function crash(
	name: string,
	command: string[],
	dir: string,
	migration: number,
	dbName = "context.db",
): Promise<void> {
	const started = performance.now();
	const child = Bun.spawn(command, {
		env: {
			...env,
			MAGIC_CONTEXT_STORAGE_DIR: dir,
			REHEARSAL_ROOT: dir,
			REHEARSAL_CRASH_VERSION: String(migration),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	const marker = join(dir, "crash-ready");
	const deadline = performance.now() + 30_000;
	// Wait for a transaction-internal barrier, not an estimated startup delay.
	while (
		!existsSync(marker) &&
		child.exitCode === null &&
		performance.now() < deadline
	)
		await Bun.sleep(10);
	const reached = existsSync(marker);
	const status = existsSync(`/proc/${child.pid}/status`)
		? readFileSync(`/proc/${child.pid}/status`, "utf8")
		: "";
	const peakKiB = Number(status.match(/VmHWM:\s+(\d+)/)?.[1] ?? 0);
	child.kill("SIGKILL");
	await child.exited;
	const text = `${await stdout}${await stderr}`;
	writeFileSync(join(dir, "crash.log"), text);
	steps.push({
		name: `kill-${name}-${migration}`,
		seconds: (performance.now() - started) / 1000,
		peakKiB,
		exit: -9,
		output: text,
	});
	if (!reached)
		throw new Error(
			`${name} migration ${migration}: transaction barrier not reached; ${text.slice(-2000)}`,
		);
	const barrier = readFileSync(marker, "utf8");
	const recorded = version(join(dir, dbName));
	if (recorded >= migration)
		throw new Error(
			`${name}: barrier transaction unexpectedly committed v${recorded}`,
		);
	(evidence.crashes as unknown[]).push({
		name,
		migration,
		barrier,
		signal: "SIGKILL",
		recordedAfterKill: recorded,
	});
}

function writeReport(): void {
	evidence.steps = steps;
	evidence.findings = findings;
	writeFileSync(join(root, "evidence.json"), JSON.stringify(evidence, null, 2));
	const summaryFingerprints = Object.fromEntries(
		Object.entries(evidence.fingerprints as Record<string, Fingerprints>).map(
			([name, fp]) => [
				name,
				{
					context: fp.context,
					store: fp.store,
					context_version: fp.context_version,
					store_version: fp.store_version,
				},
			],
		),
	);
	const lines = [
		"# Upgrade rehearsal",
		"",
		`Date: ${new Date().toISOString()}`,
		`Candidate: ${evidence.candidate}`,
		"Release source: v0.49.7 (context 95 / store 63)",
		`Input: ${snapshot ?? "synthetic"}`,
		`Temporary execution root (removed after recording this report): ${root}`,
		`Safety findings: ${findings.length}`,
		"",
		"## Measurements",
		"",
		"| Step | Wall seconds | Peak RSS KiB | Exit |",
		"| --- | ---: | ---: | ---: |",
		...steps.map(
			(s) => `| ${s.name} | ${s.seconds} | ${s.peakKiB} | ${s.exit} |`,
		),
		"",
		"Peak RSS is GNU time's maximum resident set for each child process (builds include descendants), not incremental memory. Migration timings include process startup/open/checkpoint; fixture, compilation, rendering and audit timings are separate.",
		"",
		"## Intended migration effects",
		"",
		"- context 96: additive lkg_slots columns and lkg_served_markers; no old content rewrite.",
		"- context 97: new host_runner_* tables; no old content rewrite.",
		"- context 98: new rescore/score tables, session_meta watermark default 0 and activation clock; compartments/history remain unchanged.",
		"- context 99: memory lifecycle tables and additive memory revision/verification columns; original memory content remains unchanged.",
		"- context 100: nullable session_meta served_prefix / held_release; old keys remain unchanged.",
		"- store 64: new move inventory tables; no release-domain content reset.",
		"- store 65: new provider sessions/catalogs; no old cache reset.",
		"- store 66: copies provider records into conversation/message/answer/view/tag ledgers. Release 63 has no deployed provider rows.",
		"- store 67: fence-only step; no data rewrite.",
		"- store 68: new provider policy summaries and triggers; no old cache reset.",
		"- store 69: new memory projection tables; no old memory content reset.",
		"- store 70: rebuilds mc_provider_conversations_v2 with native generation columns, preserving existing columns/identities; recreated dependent triggers.",
		"- store 71: adds policy revision/preparation caches and revision triggers; invalidates derived preparations on input changes. No release-63 table rewrite.",
		"- store 72: discards undeployed OpenCode provider projections (introduced at 65+), adds frozen-policy facts, cut/override/view tables and a frontier invalidation trigger. These tables do not exist in released store 63; every released row remains subject to exact preservation checks.",
		"",
		"## Coverage",
		"",
		"TypeScript owns context.db migration on first host open; Rust McStore owns store.db on both paired routes. The other route uses Rust context_schema::migrations_legacy::upgrade. Fresh context bootstraps are independently produced by TypeScript and Rust. Context fingerprints use parity-1A's exact Rust snapshot/digest. Store fingerprints use the same digest and equivalent structural metadata with the mc_cache namespace ledger.",
		"",
		"Every pre-existing non-shadow table is compared column-for-column on all old columns (including session_meta). Ordinary tables include rowid to preserve identity and duplicates. FTS shadow counts are reported but their physical bytes are not content contracts. All original context ledger rows must be unchanged; mc_cache version advancement and SQLite bookkeeping are excluded from content equality. New columns are checked structurally by fingerprint, not treated as original content.",
		"",
		"Five ordered sessions use the real old/candidate materializeM0 renderer, both m[0] and m[1], defaults, frozen clock and an empty project-docs directory. This is the prefix renderer, not a live provider request. Rendering runs on separate copies so cache/render side effects cannot conceal migration loss.",
		"",
		"Crash barriers cover three uncommitted context migration transactions per implementation and five store migration transactions. Store crashes use an ignored unit-test helper to install a ledger hook on the real cortexkit-store migrator and McStore SQL chain; reopen uses McStore::open. SIGKILL step peak RSS is the paused child process VmHWM from /proc; all other peaks come from GNU time.",
		"",
		"Old plugin refusal and the placed release ck-mc offline command are checked on both paired and individually advanced stores, with DB/WAL hashes before/after. The release McStore opener is checked separately; the offline command is not a live subc handshake.",
		"",
		"## Results and findings",
		"",
		...(findings.length
			? findings.map((f) => `- ${f}`)
			: ["No findings recorded."]),
		"",
		"## Detailed evidence",
		"",
		"```json",
		JSON.stringify(
			{
				...evidence,
				fingerprints: summaryFingerprints,
				steps: steps.map(({ output, ...step }) => ({ ...step, ...(step.exit !== 0 ? { output } : {}) })),
			},
			null,
			2,
		),
		"```",
		"",
	];
	mkdirSync(dirname(reportPath), { recursive: true });
	writeFileSync(reportPath, lines.join("\n"));
	console.log(
		`Report: ${reportPath}\nTemporary evidence: ${root}/evidence.json (removed after report)\n${findings.length} findings`,
	);
}

try {
	if (process.platform !== "linux")
		throw new Error("Rehearsal requires Linux and GNU /usr/bin/time");
	evidence.candidate = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: repo,
		encoding: "utf8",
	}).stdout.trim();
	evidence.toolchain = Object.fromEntries(
		["bun", "cargo", "rustc"].map((tool) => [
			tool,
			run(`${tool}-version`, [tool, "--version"]).trim(),
		]),
	);
	const archive = option("--release-archive") ?? join(root, "release.tar");
	if (!option("--release-archive"))
		run("archive-release", ["git", "archive", "origin/master", "-o", archive]);
	run("extract-release", ["tar", "-xf", resolve(archive), "-C", oldTree]);
	evidence.releaseArchiveSha256 = hash(resolve(archive));
	const pkg = JSON.parse(
		readFileSync(join(oldTree, "packages/plugin/package.json"), "utf8"),
	);
	if (pkg.version !== "0.49.7")
		throw new Error("Release archive does not identify v0.49.7");
	for (const path of [
		"node_modules",
		"packages/plugin/node_modules",
		"packages/retina-local-fs/node_modules",
	]) {
		if (existsSync(join(repo, path))) {
			mkdirSync(dirname(join(oldTree, path)), { recursive: true });
			symlinkSync(join(repo, path), join(oldTree, path), "dir");
		}
	}
	const examples = join(oldTree, "crates/mc-store/examples");
	mkdirSync(examples, { recursive: true });
	copyFileSync(
		join(repo, "scripts/lib/upgrade-release-store.rs"),
		join(examples, "upgrade_release_store.rs"),
	);
	// Compile the release helper in the tagged tree so its schema ceiling cannot come from the candidate.
	run(
		"build-release",
		[
			"cargo",
			"build",
			"--offline",
			"--locked",
			"-j",
			"4",
			"-p",
			"mc-store",
			"--example",
			"upgrade_release_store",
			"--target-dir",
			join(repo, "target/rehearsal-release"),
		],
		oldTree,
	);
	run(
		"build-release-ck-mc",
		[
			"cargo",
			"build",
			"--offline",
			"--locked",
			"-j",
			"4",
			"-p",
			"mc-module",
			"--bin",
			"ck-mc",
			"--target-dir",
			join(repo, "target/rehearsal-release"),
		],
		oldTree,
	);
	run("build-candidate-helper", [
		"cargo",
		"build",
		"--offline",
		"--locked",
		"-j",
		"4",
		"-p",
		"mc-store",
		"--example",
		"rehearse_upgrade",
		"--target-dir",
		join(repo, "target"),
	]);
	const testBuild = run("build-store-crash-helper", [
		"cargo",
		"test",
		"--offline",
		"--locked",
		"-j",
		"4",
		"-p",
		"mc-store",
		"--lib",
		"--no-run",
		"--message-format=json",
		"--target-dir",
		join(repo, "target"),
	]);
	const testArtifact = testBuild
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line))
		.find(
			(row) =>
				row.reason === "compiler-artifact" &&
				row.target.name === "mc_store" &&
				row.profile.test &&
				row.executable,
		);
	if (!testArtifact)
		throw new Error("Store crash helper test binary not produced");
	const storeCrashHelper: string = testArtifact.executable;
	helper = join(repo, "target/debug/examples/rehearse_upgrade");
	const oldHelper = join(
		repo,
		"target/rehearsal-release/debug/examples/upgrade_release_store",
	);
	const bin = join(root, "bin");
	mkdirSync(bin);
	const oldBinary = join(bin, "ckdev-rehearsal-049");
	copyFileSync(join(repo, "target/rehearsal-release/debug/ck-mc"), oldBinary);
	evidence.placedReleaseVersion = run("placed-release-version", [
		oldBinary,
		"--version",
	]).trim();
	if (snapshot) {
		for (const name of ["context.db", "store.db"]) {
			const db = new Database(join(snapshot, name), { readonly: true });
			try {
				writeFileSync(join(baseline, name), db.serialize());
			} finally {
				db.close();
			}
		}
	} else {
		run("seed-release-context", [
			process.execPath,
			host,
			"seed",
			oldTree,
			baseline,
		]);
		run("seed-release-store", [oldHelper, "seed", baseline]);
	}
	if (
		version(join(baseline, "context.db")) !== 95 ||
		version(join(baseline, "store.db")) !== 63
	)
		throw new Error("Input must be exactly context.db 95 / store.db 63");
	for (const name of ["context.db", "store.db"]) {
		(evidence.tables as Record<string, unknown>)[`before/${name}`] = inventory(
			join(baseline, name),
		);
		(evidence.integrity as Record<string, unknown>)[`before/${name}`] =
			integrity(join(baseline, name));
	}
	const oldState = snapshot ? undefined : run("release-lkg-recovery-state", [process.execPath, host, "state", oldTree, baseline]);
	const oldRender = pairCopy(baseline, "old-render");
	run("render-release", [
		process.execPath,
		host,
		"render",
		oldTree,
		oldRender,
		join(root, "prompts-old"),
	]);
	const fresh = join(root, "fresh-rust");
	mkdirSync(fresh);
	run("fresh-rust-context", [helper, "fresh-context", fresh]);
	run("fresh-rust-store", [helper, "store", fresh]);
	const freshFp = fingerprints(fresh);
	(evidence.fingerprints as Record<string, unknown>).freshRust = freshFp;
	const freshHost = pairCopy(fresh, "fresh-host");
	// A genuinely empty context.db exercises the host's full bootstrap, not a current-schema reopen.
	const empty = new Database(join(root, "empty.db"));
	empty.close();
	copyFileSync(join(root, "empty.db"), join(freshHost, "context.db"));
	run("fresh-typescript-context", [
		process.execPath,
		host,
		"migrate",
		repo,
		freshHost,
	]);
	const hostFp = fingerprints(freshHost);
	check("fresh TypeScript/Rust parity", () =>
		assertFingerprint(freshFp, hostFp),
	);
	if (freshFp.store_version > 72 || freshFp.context_version > 100)
		findings.push(
			`Migration effects manifest needs review for candidate context ${freshFp.context_version} / store ${freshFp.store_version}; identify every new reset/rewrite before approving it`,
		);
	for (const route of ["typescript", "rust"]) {
		const dir = pairCopy(baseline, route);
		run(
			`${route}-context-migrate`,
			route === "typescript"
				? [process.execPath, host, "migrate", repo, dir]
				: [helper, "context", dir],
		);
		run(`${route}-store-migrate`, [helper, "store", dir]);
		for (const name of ["context.db", "store.db"]) {
			(evidence.tables as Record<string, unknown>)[`${route}/${name}`] =
				inventory(join(dir, name));
			(evidence.integrity as Record<string, unknown>)[`${route}/${name}`] =
				integrity(join(dir, name));
		}
		(evidence.versions as Record<string, unknown>)[route] = {
			context: version(join(dir, "context.db")),
			store: version(join(dir, "store.db")),
		};
		check(`${route} target versions`, () => {
			if (
				version(join(dir, "context.db")) !== freshFp.context_version ||
				version(join(dir, "store.db")) !== freshFp.store_version
			)
				throw new Error("Migration did not reach candidate schema ceilings");
		});
		check(`${route} data preservation`, () => assertPreserved(baseline, dir));
		if (oldState) check(`${route} LKG and recovery state`, () => {
			const state = run(`${route}-lkg-recovery-state`, [process.execPath, host, "state", repo, dir]);
			if (state !== oldState) throw new Error("Loaded LKG bytes, identities, digests/signatures or recovery state changed");
		});
		const fp = fingerprints(dir);
		(evidence.fingerprints as Record<string, unknown>)[route] = fp;
		check(`${route} fresh schema fingerprint`, () =>
			assertFingerprint(freshFp, fp),
		);
		const renderDir = pairCopy(dir, `${route}-render`);
		const output = join(root, `prompts-${route}`);
		run(`render-${route}`, [
			process.execPath,
			host,
			"render",
			repo,
			renderDir,
			output,
		]);
		for (const file of readdirSync(join(root, "prompts-old"))) {
			const old = JSON.parse(
				readFileSync(join(root, "prompts-old", file), "utf8"),
			);
			const next = JSON.parse(readFileSync(join(output, file), "utf8"));
			for (const part of ["m0", "m1"]) {
				const equal = old[part] === next[part];
				const beforeBytes = Buffer.from(old[part]);
				const afterBytes = Buffer.from(next[part]);
				let offset = 0;
				while (
					offset < beforeBytes.length &&
					beforeBytes[offset] === afterBytes[offset]
				)
					offset++;
				(evidence.prompts as unknown[]).push({
					route,
					session: old.session,
					part,
					equal,
					bytesBefore: Buffer.byteLength(old[part]),
					bytesAfter: Buffer.byteLength(next[part]),
					firstDifference: equal ? null : offset,
					beforeExcerpt: equal
						? null
						: beforeBytes
								.subarray(Math.max(0, offset - 80), offset + 240)
								.toString(),
					afterExcerpt: equal
						? null
						: afterBytes
								.subarray(Math.max(0, offset - 80), offset + 240)
								.toString(),
				});
				if (!equal)
					findings.push(
						`${route} prompt ${old.session} ${part}: differs at byte ${offset}; cause unapproved renderer change, compare ${join(root, "prompts-old", file)} and ${join(output, file)}`,
					);
			}
		}
		const refused = pairCopy(dir, `${route}-old-plugin`);
		const before = fileHashes(refused);
		const refusal = run(
			`${route}-old-plugin-refusal`,
			[process.execPath, host, "refuse", oldTree, refused],
			repo,
			{},
			true,
		);
		check(`${route} old plugin refusal without writes`, () => {
			if (steps.at(-1)!.exit !== 0 || !refusal.includes("context.db"))
				throw new Error(
					`No named context.db schema refusal: ${steps.at(-1)!.output}`,
				);
			if (JSON.stringify(fileHashes(refused)) !== JSON.stringify(before))
				throw new Error("Old plugin modified DB/WAL bytes");
		});
		(evidence.refusals as unknown[]).push({ route, plugin: refusal });
		const oldStore = pairCopy(dir, `${route}-old-store`);
		const storeBefore = fileHashes(oldStore);
		run(
			`${route}-old-store-refusal`,
			[oldHelper, "open", oldStore],
			repo,
			{},
			true,
		);
		(evidence.refusals as unknown[]).push({
			route,
			storeOpener: steps.at(-1)!.output,
		});
		check(`${route} old McStore refusal without writes`, () => {
			const last = steps.at(-1)!;
			if (last.exit === 0 || !last.output.includes("StoreAheadOfBinary"))
				throw new Error(last.output);
			if (JSON.stringify(fileHashes(oldStore)) !== JSON.stringify(storeBefore))
				throw new Error("Old McStore modified DB/WAL bytes");
		});
	}
	check("TypeScript/Rust upgraded schema parity", () =>
		assertFingerprint(
			(evidence.fingerprints as Record<string, Fingerprints>).typescript,
			(evidence.fingerprints as Record<string, Fingerprints>).rust,
		),
	);
	for (const shape of ["pair", "context-only", "store-only"]) {
		const dir = pairCopy(
			shape === "pair" ? join(root, "rust") : baseline,
			`old-binary-${shape}`,
		);
		if (shape !== "pair")
			copyFileSync(
				join(
					root,
					"rust",
					shape === "context-only" ? "context.db" : "store.db",
				),
				join(dir, shape === "context-only" ? "context.db" : "store.db"),
			);
		const before = fileHashes(dir);
		const output = run(
			`old-ck-mc-${shape}-refusal`,
			[
				oldBinary,
				"single-store-migrate",
				"--context-db",
				join(dir, "context.db"),
				"--store-db",
				join(dir, "store.db"),
				"--backup-dir",
				join(dir, "backup"),
			],
			repo,
			{ MAGIC_CONTEXT_STORAGE_DIR: dir },
			true,
		);
		check(`placed release ck-mc ${shape} refusal without writes`, () => {
			const step = steps.at(-1)!;
			const result = JSON.parse(output) as {
				status: string;
				refusal?: { code: string; message: string };
			};
			if (
				step.exit !== 2 ||
				result.status !== "refused" ||
				!result.refusal ||
				![
					"single_store_version_mismatch",
					"single_store_fingerprint_mismatch",
				].includes(result.refusal.code) ||
				!/context\.db|store\.db/.test(result.refusal.message)
			)
				throw new Error(
					`Expected named schema refusal, exit ${step.exit}: ${output}`,
				);
			if (JSON.stringify(fileHashes(dir)) !== JSON.stringify(before))
				throw new Error("Release ck-mc modified DB/WAL bytes");
		});
		(evidence.refusals as unknown[]).push({ binary: shape, output });
	}
	for (const route of ["typescript", "rust"])
		for (const migration of [96, 98, 100]) {
			const dir = pairCopy(baseline, `crash-${route}-${migration}`);
			const command =
				route === "typescript"
					? [process.execPath, host, "migrate", repo, dir]
					: [helper, "context", dir];
			try {
				await crash(route, command, dir, migration);
				run(`reopen-${route}-${migration}`, command);
				run(`reopen-store-${route}-${migration}`, [helper, "store", dir]);
				check(`crash ${route} v${migration} preservation`, () =>
					assertPreserved(join(root, route), dir),
				);
				check(`crash ${route} v${migration} schema`, () =>
					assertFingerprint(
						(evidence.fingerprints as Record<string, Fingerprints>)[route],
						fingerprints(dir),
					),
				);
				for (const name of ["context.db", "store.db"])
					integrity(join(dir, name));
			} catch (error) {
				findings.push(
					`Crash ${route} context migration ${migration}: ${String(error)}`,
				);
			}
		}
	for (const migration of [64, 66, 70, 71, 72]) {
		const dir = pairCopy(baseline, `crash-store-${migration}`);
		try {
			await crash(
				"store",
				[
					storeCrashHelper,
					"--exact",
					"upgrade_rehearsal::store_process",
					"--ignored",
					"--nocapture",
				],
				dir,
				migration,
				"store.db",
			);
			run(`reopen-store-${migration}`, [helper, "store", dir]);
			run(`reopen-context-store-${migration}`, [helper, "context", dir]);
			check(`crash store v${migration} preservation`, () =>
				assertPreserved(join(root, "rust"), dir),
			);
			check(`crash store v${migration} schema`, () =>
				assertFingerprint(
					(evidence.fingerprints as Record<string, Fingerprints>).rust,
					fingerprints(dir),
				),
			);
			for (const name of ["context.db", "store.db"]) integrity(join(dir, name));
		} catch (error) {
			findings.push(`Crash store migration ${migration}: ${String(error)}`);
		}
	}
	check("candidate module post-upgrade transforms", () => {
		const dir = pairCopy(join(root, "rust"), "module-drill");
		const output = run("module-post-upgrade-transforms", ["cargo", "test", "--offline", "--locked", "-j", "4", "-p", "mc-module", "--lib", "single_store_drill_post_migration_passes", "--", "--ignored", "--nocapture"], repo, { MC_DRILL_DIR: dir, MC_DRILL_PROJECT: "git:upgrade-rehearsal" });
		evidence.moduleDrillOutput = output;
		if (!output.includes("1 passed") || !output.includes("DRILL pass4")) throw new Error(`Transform drill did not run: ${output}`);
	});
	run("build-candidate-ck-mc", ["cargo", "build", "--offline", "--locked", "-j", "4", "-p", "mc-module", "--bin", "ck-mc"]);
	evidence.candidateBinaryVersion = run("candidate-ck-mc-version", [join(repo, "target/debug/ck-mc"), "--version"]).trim();
} catch (error) {
	findings.push(`Rehearsal execution: ${String(error)}`);
} finally {
	writeReport();
	rmSync(root, { recursive: true, force: true });
}
process.exitCode = findings.length ? 1 : 0;
