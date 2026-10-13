#!/usr/bin/env bun
/**
 * Capture the shipped OpenCode builders, not Rust's catalog or a copy of its
 * renderer. Run from the repository root:
 * bun crates/mc-module/testdata/tool_surfaces/generate.ts [--refresh-assets]
 * Strings are interned losslessly so the exhaustive language/config product
 * does not duplicate megabytes of identical guidance. No stores are opened.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildMagicContextSection } from "../../../../packages/plugin/src/agents/magic-context-prompt";
import {
	buildPrimaryLanguageDirective,
	resolveLanguageName,
} from "../../../../packages/plugin/src/agents/language-directive";
import { normalizeToolArgSchemas } from "../../../../packages/plugin/src/plugin/normalize-tool-arg-schemas";
import { createCtxReduceTools } from "../../../../packages/plugin/src/tools/ctx-reduce/tools";
import { createCtxExpandTools } from "../../../../packages/plugin/src/tools/ctx-expand/tools";
import { createCtxNoteTools } from "../../../../packages/plugin/src/tools/ctx-note/tools";
import { createCtxMemoryTools } from "../../../../packages/plugin/src/tools/ctx-memory/tools";
import { createCtxSearchTools } from "../../../../packages/plugin/src/tools/ctx-search/tools";
import { withoutSmartNoteText } from "../../../../packages/plugin/src/tools/ctx-note/constants";
import * as light from "../../../../packages/plugin/src/tools/light-descriptions";
import { parameterDescriptionsFor } from "../../../../packages/plugin/src/tools/parameter-descriptions";

const root = resolve(import.meta.dir, "../../../..");
const { tool } = await import(
	Bun.resolveSync("@opencode-ai/plugin", resolve(root, "packages/plugin"))
);
type ToolDefinition = ReturnType<typeof createCtxExpandTools>["ctx_expand"];
const surfaces = ["full", "light"] as const;
const toolNames = [
	"ctx_reduce",
	"ctx_expand",
	"ctx_note",
	"ctx_memory",
	"ctx_search",
] as const;
const lightDescriptions = {
	ctx_reduce: light.CTX_REDUCE_LIGHT_DESCRIPTION,
	ctx_expand: light.CTX_EXPAND_LIGHT_DESCRIPTION,
	ctx_note: light.CTX_NOTE_LIGHT_DESCRIPTION,
	ctx_memory: light.CTX_MEMORY_LIGHT_DESCRIPTION,
	ctx_search: light.CTX_SEARCH_LIGHT_DESCRIPTION,
};
// A dep unexpectedly called during construction must fail, not touch a store.
const stubDeps = new Proxy(
	{},
	{
		get(_target, key) {
			if (key === "then") return undefined;
			if (key === "smartNotesEnabled") return true;
			if (key === "allowedActions")
				return ["write", "update", "archive", "merge", "get"];
			return () => {
				throw new Error(`Builder called dependency ${String(key)}`);
			};
		},
	},
);
function builders(smart: boolean): Record<string, ToolDefinition> {
	return {
		...createCtxReduceTools(
			stubDeps as Parameters<typeof createCtxReduceTools>[0],
		),
		...createCtxExpandTools(
			stubDeps as Parameters<typeof createCtxExpandTools>[0],
		),
		...createCtxNoteTools({
			...stubDeps,
			smartNotesEnabled: smart,
		} as Parameters<typeof createCtxNoteTools>[0]),
		...createCtxMemoryTools(
			stubDeps as Parameters<typeof createCtxMemoryTools>[0],
		),
		...createCtxSearchTools(
			stubDeps as Parameters<typeof createCtxSearchTools>[0],
		),
	};
}
const tools = surfaces.flatMap((preset) =>
	[false, true].map((smart) => {
		const definitions = builders(smart);
		return {
			preset,
			smart,
			tools: toolNames.map((name) => {
				const definition = definitions[name];
				const descriptions = parameterDescriptionsFor(name, preset, smart)!;
				const args = Object.fromEntries(
					Object.entries(definition.args).map(([key, schema]) => [
						key,
						descriptions[key]
							? (
									schema as typeof schema & {
										describe(description: string): typeof schema;
									}
								).describe(descriptions[key])
							: schema,
					]),
				);
				normalizeToolArgSchemas({ args });
				const { $schema: _dialect, ...input_schema } = tool.schema.toJSONSchema(
					tool.schema.object(args),
				);
				const description =
					preset === "light" ? lightDescriptions[name] : definition.description;
				return {
					name,
					description:
						name === "ctx_note" && !smart
							? withoutSmartNoteText(description)
							: description,
					input_schema,
				};
			}),
		};
	}),
);

// TS accepts every two-letter code that ICU resolves, not a hand-picked locale
// list. Record the accepted set and the rejected set independently of Rust.
const languages: Array<{ code: string; name: string; directive: string }> = [
	{ code: "", name: "", directive: "" },
];
const rejected: string[] = [];
for (let a = 97; a <= 122; a++) {
	for (let b = 97; b <= 122; b++) {
		const code = String.fromCharCode(a, b);
		const name = resolveLanguageName(code);
		if (name)
			languages.push({
				code,
				name,
				directive: buildPrimaryLanguageDirective(code),
			});
		else rejected.push(code);
	}
}
const strings: string[] = [];
const indexes = new Map<string, number>();
function intern(text: string): number {
	const existing = indexes.get(text);
	if (existing !== undefined) return existing;
	const index = strings.length;
	indexes.set(text, index);
	strings.push(text);
	return index;
}
// Bits of mask, starting at bit 0: memory, dreamer, temporal, caveman, smart,
// subagent, compaction. denied models a host permission that makes ctx_reduce
// uncallable even though compaction is enabled.
function guidance(
	mask: number,
	preset: "full" | "light",
	code: string,
	denied = false,
	override?: string,
): string {
	const on = (bit: number) => (mask & (1 << bit)) !== 0;
	const reduce = on(6) && !denied;
	// createSystemPromptHashHandler skips guidance for subagents that cannot
	// call ctx_reduce; describing the tag system would name unavailable tools.
	if (on(5) && !reduce) return "";
	return buildMagicContextSection(
		null,
		0,
		reduce,
		on(1),
		on(2),
		on(3),
		on(5),
		code || undefined,
		on(0),
		preset,
		override,
		on(4),
	);
}
function capture(text: string, directive: string): [number, number] {
	const suffix =
		directive && text.endsWith(`\n\n${directive}`) ? `\n\n${directive}` : "";
	const prefix = suffix ? text.slice(0, -suffix.length) : text;
	if (prefix + suffix !== text) throw new Error("Lossy interning");
	return [intern(prefix), intern(suffix)];
}
const guidanceCases: number[][] = [];
for (let mask = 0; mask < 128; mask++) {
	for (let surface = 0; surface < surfaces.length; surface++) {
		for (let language = 0; language < languages.length; language++) {
			const locale = languages[language];
			const text = guidance(mask, surfaces[surface], locale.code);
			guidanceCases.push([
				mask,
				surface,
				language,
				...capture(text, locale.directive),
			]);
		}
	}
}
const override =
	"## Magic Context\n\nUser-owned prose with literal {{$braces}}.\n### Smart notes\nA smart note has a surface_condition.\n### Ordinary work\nKeep the ordinary tray.";
const extras: Array<{
	mask: number;
	preset: string;
	language: string;
	denied: boolean;
	override: string | null;
	text: number[];
}> = [];
for (let mask = 0; mask < 128; mask++) {
	for (const preset of surfaces) {
		for (const custom of [undefined, override]) {
			const text = guidance(mask, preset, "tr", true, custom);
			extras.push({
				mask,
				preset,
				language: "tr",
				denied: true,
				override: custom ?? null,
				text: capture(text, buildPrimaryLanguageDirective("tr")),
			});
		}
		const text = guidance(mask, preset, "es", false, override);
		extras.push({
			mask,
			preset,
			language: "es",
			denied: false,
			override,
			text: capture(text, buildPrimaryLanguageDirective("es")),
		});
	}
}
const golden = {
	format: "magic-context/typescript-tool-surfaces/1",
	generator: "bun crates/mc-module/testdata/tool_surfaces/generate.ts",
	runtime: { bun: Bun.version, icu: process.versions.icu },
	schema_dialect:
		"OpenCode/Zod toJSONSchema(object(args)), root $schema omitted; all other constraints retained",
	tools,
	languages,
	rejected,
	strings,
	guidance_cases: guidanceCases,
	extras,
};
const goldenPath = resolve(import.meta.dir, "golden.json");
const serialized = `${JSON.stringify(golden)}\n`;
const checkMode =
	process.argv.includes("--check") ||
	process.argv.includes("--report-icu-drift");
if (checkMode) {
	const saved = JSON.parse(readFileSync(goldenPath, "utf8")) as typeof golden;
	const expectedNames = Object.fromEntries(
		saved.languages
			.filter((row) => row.code)
			.map((row) => [row.code, row.name]),
	);
	const asset = JSON.parse(
		readFileSync(
			resolve(root, "crates/mc-module/assets/tool_catalog_v1.json"),
			"utf8",
		),
	);
	// golden.json pins the macOS ICU 78.1 names already shipped by Rust.
	// Host ICU changes names across platforms and updates, which would silently
	// reword prompts. Check the compiled table against that committed snapshot
	// instead, so name changes require an explicit reviewed contract update.
	if (JSON.stringify(asset.language_names) !== JSON.stringify(expectedNames)) {
		throw new Error(
			"The generated language table differs from the committed canonical golden.",
		);
	}
	if (JSON.stringify(saved.tools) !== JSON.stringify(tools)) {
		throw new Error(
			"TypeScript tool builders differ from the committed schemas/descriptions.",
		);
	}
	let checked = 0;
	for (const row of saved.guidance_cases.filter((row) => row[2] === 0)) {
		const expected = saved.strings[row[3]] + saved.strings[row[4]];
		if (guidance(row[0], surfaces[row[1]], "") !== expected) {
			throw new Error(
				`TypeScript no-language guidance differs for mask ${row[0]}, surface ${row[1]}.`,
			);
		}
		checked++;
	}
	for (const row of saved.extras) {
		// Check user-owned prose and runtime clauses without depending on ICU:
		// the captured prefix excludes only the separately interned directive.
		const expected = saved.strings[row.text[0]];
		const text = guidance(
			row.mask,
			row.preset as "full" | "light",
			"",
			row.denied,
			row.override ?? undefined,
		);
		if (text !== expected)
			throw new Error(
				`TypeScript override guidance differs for mask ${row.mask}.`,
			);
		checked++;
	}
	console.log(
		`Canonical table matches ${saved.languages.length - 1} committed names; 20 tool schemas and ${checked} no-language/override builder outputs are fresh. Live ICU is not the language contract.`,
	);
	if (process.argv.includes("--report-icu-drift")) {
		const currentNames = Object.fromEntries(
			languages.filter((row) => row.code).map((row) => [row.code, row.name]),
		);
		const drift = Object.keys({ ...expectedNames, ...currentNames }).filter(
			(code) => expectedNames[code] !== currentNames[code],
		);
		for (const code of drift)
			console.log(
				`${code}: canonical=${JSON.stringify(expectedNames[code] ?? null)} live=${JSON.stringify(currentNames[code] ?? null)}`,
			);
		console.log(
			`ICU drift: ${drift.length} names; canonical ${JSON.stringify(saved.runtime)}, live ${JSON.stringify(golden.runtime)}.`,
		);
	}
} else {
	if (
		process.platform !== "darwin" ||
		Bun.version !== "1.4.2" ||
		process.versions.icu !== "78.1"
	) {
		throw new Error(
			"Regenerate the canonical golden only with macOS Bun 1.4.2 / ICU 78.1; use --check on other platforms.",
		);
	}
	writeFileSync(goldenPath, serialized);
}
console.log(
	`Captured ${tools.length * toolNames.length} tool schemas, ${languages.length - 1} languages, ${guidanceCases.length} guidance cases, ${extras.length} override/permission cases (${strings.length} exact string fragments). Bun ${Bun.version}, ICU ${process.versions.icu}`,
);

if (process.argv.includes("--refresh-assets")) {
	if (checkMode)
		throw new Error("Do not refresh assets in read-only check mode.");
	const path = resolve(root, "crates/mc-module/assets/tool_catalog_v1.json");
	let source = readFileSync(path, "utf8");
	const full = tools.find((row) => row.preset === "full" && row.smart)!;
	let index = 0;
	source = source.replace(
		/("structure": )\{[\s\S]*?\n      \}/g,
		(_matched, prefix: string) => {
			const schema = structuredClone(full.tools[index++].input_schema) as {
				properties: Record<string, Record<string, unknown>>;
			};
			for (const property of Object.values(schema.properties))
				delete property.description;
			const lines = JSON.stringify(schema, null, 2).split("\n");
			return (
				prefix +
				lines.map((line, i) => (i === 0 ? line : `      ${line}`)).join("\n")
			);
		},
	);
	if (index !== toolNames.length)
		throw new Error(`Updated ${index} schemas instead of five`);
	const names = Object.fromEntries(
		languages.filter((row) => row.code).map((row) => [row.code, row.name]),
	);
	const nameEntry = `  "language_names": ${JSON.stringify(names)},\n`;
	source = source.includes('  "language_names": ')
		? source.replace(/  "language_names": .*\n/, nameEntry)
		: source.replace('  "texts": {', `${nameEntry}  "texts": {`);
	writeFileSync(path, source);
	console.log(
		"Refreshed five builder-derived schema structures and ICU language names in tool_catalog_v1.json.",
	);
}

const reviewBaseline = process.argv
	.find((arg) => arg.startsWith("--review-baseline="))
	?.split("=")[1];
if (reviewBaseline) {
	const snapshot = Bun.spawnSync(
		[
			"git",
			"show",
			`${reviewBaseline}:crates/mc-module/assets/tool_catalog_v1.json`,
		],
		{ cwd: root },
	);
	if (snapshot.exitCode !== 0)
		throw new Error(
			"Cannot read baseline catalog from this worktree's Git history",
		);
	const baseline = JSON.parse(new TextDecoder().decode(snapshot.stdout));
	const legacySource = readFileSync(
		resolve(root, "crates/mc-module/src/lib.rs"),
		"utf8",
	);
	const oldNamesSource = readFileSync(
		resolve(root, "crates/mc-module/src/content_language.rs"),
		"utf8",
	);
	const oldNames = Object.fromEntries(
		[...oldNamesSource.matchAll(/"([a-z]{2})" => Some\(("[^"\n]*")\)/g)].map(
			(match) => [match[1], JSON.parse(match[2])],
		),
	);
	function ordered(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(ordered);
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([key, child]) => [key, ordered(child)]),
			);
		return value;
	}
	function same(a: unknown, b: unknown): boolean {
		return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
	}
	const deltas: Array<{
		scope: string;
		preset: string;
		tool: string;
		field: string;
		before: unknown;
		after: unknown;
	}> = [];
	for (const preset of surfaces) {
		const after = tools.find((row) => row.preset === preset && row.smart)!;
		for (const expected of after.tools) {
			const catalog = baseline.tools.find(
				(tool: { name: string }) => tool.name === expected.name,
			);
			for (const scope of ["catalog", "legacy"]) {
				let schema: {
					properties: Record<string, Record<string, unknown>>;
					[key: string]: unknown;
				} = structuredClone(catalog.structure);
				let description = baseline.descriptions[preset][expected.name];
				if (scope === "legacy" && expected.name !== "ctx_reduce") {
					const raw = legacySource.match(
						new RegExp(
							`fn ${expected.name}_schema\\(\\) -> Value \\{\\s*json!\\(([\\s\\S]*?)\\)\\n\\}`,
						),
					)?.[1];
					if (!raw)
						throw new Error(`Cannot extract legacy ${expected.name} schema`);
					schema = JSON.parse(
						raw.replace(/_i64/g, "").replace(/,\s*([}\]])/g, "$1"),
					);
					if (preset === "full") {
						description = legacySource.match(
							new RegExp(
								`fn ${expected.name}_description\\(\\) -> String \\{\\s*r#"([\\s\\S]*?)"#`,
							),
						)?.[1];
					}
				}
				for (const [key, property] of Object.entries(schema.properties)) {
					const text =
						baseline.parameter_descriptions[preset][expected.name][key];
					if (text) property.description = text;
				}
				if (!same(description, expected.description))
					deltas.push({
						scope,
						preset,
						tool: expected.name,
						field: "description",
						before: description,
						after: expected.description,
					});
				const next = expected.input_schema as typeof schema;
				for (const key of new Set([
					...Object.keys(schema),
					...Object.keys(next),
				])) {
					if (key === "properties") continue;
					if (!same(schema[key], next[key]))
						deltas.push({
							scope,
							preset,
							tool: expected.name,
							field: `input_schema.${key}`,
							before: schema[key] ?? null,
							after: next[key] ?? null,
						});
				}
				for (const key of new Set([
					...Object.keys(schema.properties),
					...Object.keys(next.properties),
				])) {
					if (!same(schema.properties[key], next.properties[key]))
						deltas.push({
							scope,
							preset,
							tool: expected.name,
							field: `input_schema.properties.${key}`,
							before: schema.properties[key] ?? null,
							after: next.properties[key] ?? null,
						});
				}
			}
		}
	}
	const languageDeltas = languages
		.filter((row) => row.code && oldNames[row.code] !== row.name)
		.map((row) => ({
			code: row.code,
			before: oldNames[row.code] ?? null,
			after: row.name,
			directive: row.directive,
		}));
	const guidanceDeltas = surfaces.map((preset, surface) => {
		const row = guidanceCases.find(
			(row) => row[0] === 23 && row[1] === surface && row[2] === 0,
		)!;
		return {
			scope: "catalog",
			selector: `head/noncompacting/${preset}`,
			before: readFileSync(
				resolve(
					root,
					`crates/mc-module/assets/catalog_tools_only${preset === "light" ? "_light" : ""}.txt`,
				),
				"utf8",
			),
			after: strings[row[3]] + strings[row[4]],
			override_before: "ignored for noncompacting head",
			override_after:
				"same primary override plus temporal/caveman/language clauses as TS builder",
		};
	});
	writeFileSync(
		resolve(import.meta.dir, "advertised-deltas.json"),
		`${JSON.stringify({ baseline: reviewBaseline, deltas, language_deltas: languageDeltas, guidance_deltas: guidanceDeltas, note: "Full/light catalog authored descriptions and parameter descriptions are otherwise unchanged. Legacy guidance.get is not redirected until integration-owner.patch is applied; golden.json contains every exact config output of the new composer." }, null, 2)}\n`,
	);
	console.log(
		`Recorded ${deltas.length} exact schema/description deltas, ${languageDeltas.length} language deltas, and two noncompacting-head guidance deltas for THALAMUS review.`,
	);
}
