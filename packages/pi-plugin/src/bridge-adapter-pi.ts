import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { loadPluginConfigDetailed } from "@magic-context/core/config";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { recordSessionProjectIdentity } from "@magic-context/core/features/magic-context/session-project-storage";
import { openBridgeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage-meta";
import { createBridgeDeps } from "@magic-context/core/hooks/magic-context/host-runner/bridge-deps";
import { createBridgeHostFacts } from "@magic-context/core/hooks/magic-context/host-runner/bridge-host-facts";
import type {
	BridgeReceipt,
	BridgeRequestCompletion,
} from "@magic-context/core/hooks/magic-context/host-runner/bridge-receipt";
import { BridgeStep } from "@magic-context/core/hooks/magic-context/host-runner/bridge-step";
import {
	type BridgeHostFact,
	type BridgeOutcomeListener,
	BridgeRefusalError,
} from "@magic-context/core/hooks/magic-context/host-runner/bridge-types";
import { InjectedBridgeTransport } from "@magic-context/core/hooks/magic-context/host-runner/injected-transport";
import { createProviderTransform } from "@magic-context/core/hooks/magic-context/host-runner/opencode-adapter";
import { SubcModuleTransport } from "@magic-context/core/hooks/magic-context/module-transport";
import { setRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { createRustModeTransform } from "@magic-context/core/hooks/magic-context/rust-mode-transform";
import {
	nativePiEntry,
	piProviderCodec,
	projectPiEntry,
} from "./bridge-codec-pi";
import { createPiBridgeMarkerOwner } from "./bridge-marker-pi";
import type {
	PiBridgeAdapterOptions,
	PiBridgeFallbackInputs,
	PiBridgeRunInput,
	PiBridgeView,
} from "./bridge-types-pi";
import {
	convertEntriesToRawMessages,
	locatePiRawOrdinals,
} from "./read-session-pi";

export function createPiBridgeAdapter(options: PiBridgeAdapterOptions) {
	for (const key of ["projectRoot", "connectionFile", "storageDir"] as const)
		if (!isAbsolute(options[key]))
			throw new Error(`${key} must be an absolute path`);
	if (typeof options.reloadSession !== "function")
		throw new Error("reloadSession is required");
	const config = loadPluginConfigDetailed(
		options.projectRoot,
		false,
		options.configPath,
	).config;
	const db = openBridgeDatabase(
		join(options.storageDir, "context.db"),
		options.allowMigration === true,
	);
	const transport = options.transport
		? new InjectedBridgeTransport(options.transport)
		: new SubcModuleTransport(
				options.connectionFile,
				undefined,
				undefined,
				"",
				"pi",
			);
	const deps = createBridgeDeps(
		config,
		{ db, directory: options.projectRoot, rustModeModuleClient: transport },
		"pi",
	);
	const manifests = new Map<string, string>();
	const currentWindows = new Map<string, Map<string, number>>();
	const listeners = new Set<BridgeOutcomeListener>();
	const active = new Set<string>();
	const work = new Set<Promise<unknown>>();
	const rawReaders = new Map<string, () => void>();
	let disposed = false,
		disposal: Promise<void> | undefined;
	const assertOpen = () => {
		if (disposed) throw new Error("Bridge adapter is disposed");
	};
	const idle = (id: string) => {
		assertOpen();
		if (active.has(id)) throw new Error("Bridge pass already in flight");
	};
	const owner = (id: string) =>
		createPiBridgeMarkerOwner(
			{ db, reloadSession: () => options.reloadSession(id) },
			id,
		);
	const legacy = createRustModeTransform(deps, {
		moduleClient: transport,
		projectRoot: options.projectRoot,
	});
	const provider = createProviderTransform(
		deps,
		legacy,
		{
			deferServed: true,
			servedThrough: (id, lineage) => {
				const r = owner(id).current();
				return r?.lineage_id === lineage ? r.served_through_ordinal : 0;
			},
			persisted: (id, mid) => currentWindows.get(id)?.has(mid) === true,
			onOutcome: async (...args) => {
				const pending = Promise.allSettled(
					[...listeners].map((listener) =>
						Promise.resolve().then(() => listener(...args)),
					),
				);
				work.add(pending);
				try {
					await pending;
				} finally {
					work.delete(pending);
				}
			},
			fullRequest: async (
				_id,
				_messages,
				_output,
				_meta,
				_namespace,
				reason,
			) => {
				throw new BridgeRefusalError(reason ?? "bootstrap_declined");
			},
		},
		piProviderCodec(
			(id) => manifests.get(id) ?? "",
			(id, messages) =>
				messages.map((m) => currentWindows.get(id)?.get(m.info.id ?? "") ?? 0),
		),
	);
	const facts = createBridgeHostFacts(deps, config);
	const normalized = (inputs: PiBridgeFallbackInputs) => ({
		...inputs,
		messages: inputs.messages
			.filter((m) => m.type !== "compaction")
			.map((m) => projectPiEntry(m)),
	});
	return {
		async run(input: PiBridgeRunInput): Promise<PiBridgeView> {
			const started = performance.now(),
				id = input.sessionId;
			idle(id);
			if (input.kind !== "model")
				throw new Error(
					"Bridge run kind must be model; rebuild classification is adapter-owned",
				);
			const ids = input.messages.map((m) => m.id);
			if (
				ids.some((id) => typeof id !== "string" || id.length === 0) ||
				new Set(ids).size !== ids.length
			)
				throw new Error("Pi bridge requires unique stable journal entry IDs");
			const host = input.host;
			if (
				!host.model.provider ||
				!host.model.id ||
				!Number.isSafeInteger(host.contextWindow) ||
				host.contextWindow <= 0 ||
				typeof host.system !== "string" ||
				!Array.isArray(host.tools)
			)
				throw new Error("Incomplete Pi model/window/system/tool facts");
			currentWindows.set(
				id,
				new Map(ids.map((mid, i) => [String(mid), i + 1])),
			);
			manifests.set(
				id,
				createHash("sha256")
					.update(JSON.stringify([host.model, host.system, host.tools]))
					.digest("hex"),
			);
			deps.liveModelBySession?.set(id, {
				providerID: host.model.provider,
				modelID: host.model.id,
			});
			getOrCreateSessionMeta(db, id, "pi");
			updateSessionMeta(db, id, {
				systemPromptHash: createHash("md5").update(host.system).digest("hex"),
				systemPromptTokens: estimateTokens(host.system),
				lastUsageContextLimit: host.contextWindow,
			});
			const meta = getOrCreateSessionMeta(db, id, "pi");
			deps.projectPath = resolveProjectIdentityForSession(
				options.projectRoot,
				config.allow_home_project,
			);
			recordSessionProjectIdentity(db, id, deps.projectPath, "pi");
			const messages = input.messages.map((m) => projectPiEntry(m));
			let branch: unknown[] | undefined;
			const readBranch = () =>
				(branch ??= options.reloadSession(id).readBranchEntries());
			rawReaders.get(id)?.();
			rawReaders.set(
				id,
				setRawMessageProvider(id, {
					readMessages: () => convertEntriesToRawMessages(readBranch()),
					readMessageOrdinalById: (mid) =>
						locatePiRawOrdinals(readBranch(), new Set([mid])).get(mid) ?? null,
					hasMessageById: (mid) =>
						locatePiRawOrdinals(readBranch(), new Set([mid])).has(mid),
				}),
			);
			const kind = provider.classifyStep(id, messages, meta),
				pass = new BridgeStep(kind, started);
			const output = { messages: [] as unknown[] };
			active.add(id);
			const running = provider.runBudgeted(id, messages, output, meta, pass);
			work.add(running);
			try {
				await running;
				const projected = output.messages as Parameters<
					typeof nativePiEntry
				>[0][];
				let receipt = provider.receipt(id);
				try {
					receipt = owner(id).publish(
						receipt,
						projected,
						provider.throughOrdinal(id),
					);
				} catch {
					/* Keep serving the transformed messages, but never trim native history without a saved delivery receipt. */
				}
				return { kind, messages: projected.map(nativePiEntry), receipt };
			} finally {
				active.delete(id);
				work.delete(running);
				pass.dispose();
			}
		},
		receipt(id: string) {
			assertOpen();
			return owner(id).current();
		},
		completeRequest(
			id: string,
			requestId: string,
			response: BridgeRequestCompletion,
		) {
			idle(id);
			const receipt = owner(id).complete(requestId, response);
			if (receipt) provider.acknowledgeDelivery(id, receipt);
			return receipt;
		},
		async recordHostFact(fact: BridgeHostFact) {
			idle(fact.sessionId);
			const receipt = owner(fact.sessionId).current();
			if (
				!receipt ||
				receipt.lineage_id !== fact.lineageId ||
				(fact.kind === "provider_response" &&
					receipt.request_id !== fact.requestId)
			)
				return { accepted: false };
			active.add(fact.sessionId);
			const pending = facts(fact);
			work.add(pending);
			try {
				return await pending;
			} finally {
				work.delete(pending);
				active.delete(fact.sessionId);
			}
		},
		advanceNativeMarker(
			id: string,
			receipt: BridgeReceipt,
			inputs: PiBridgeFallbackInputs,
		) {
			idle(id);
			const record = provider.record(id);
			return record
				? owner(id).advance(receipt, record, normalized(inputs))
				: { kind: "deferred" as const, reason: "no-published-record" };
		},
		isFallbackAdmissible(id: string, inputs: PiBridgeFallbackInputs) {
			idle(id);
			const record = provider.record(id);
			if (!record)
				return {
					admissible: false as const,
					reason: "covered_range_changed" as const,
					detail: "No published Pi record",
				};
			if (
				inputs.messages.some(
					(m) => m.type !== "compaction" && (typeof m.id !== "string" || !m.id),
				)
			)
				return {
					admissible: false as const,
					reason: "covered_range_changed" as const,
					detail:
						"Pi fallback requires stable journal IDs for every raw message",
				};
			const result = owner(id).isFallbackAdmissible(record, normalized(inputs));
			return result.admissible
				? { admissible: true as const, view: result.view.map(nativePiEntry) }
				: result;
		},
		recordProviderUsage(
			id: string,
			usage: {
				messages: PiBridgeFallbackInputs["messages"];
				inputTokens: number;
				model: string;
				envelope: string;
			},
		) {
			idle(id);
			const record = provider.record(id);
			const saved = new Map(
				[
					...(record?.view.replacement ?? []),
					...(record?.entries.map((e) => e.served) ?? []),
				].map((m) => [JSON.stringify(nativePiEntry(m)), m]),
			);
			provider.recordProviderUsage(id, {
				...usage,
				messages: usage.messages.map(
					(m) => saved.get(JSON.stringify(m)) ?? projectPiEntry(m),
				),
			});
		},
		onOutcome(listener: BridgeOutcomeListener) {
			assertOpen();
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		/** Drop only the module's provider state; normal session deletion owns host data. */
		async onSessionDeleted(id: string): Promise<void> {
			assertOpen();
			const pending = transport.call({
				sessionId: id,
				projectRoot: options.projectRoot,
				method: "compaction.delete",
				body: {
					method: "compaction.delete",
					params: { session: id, harness: "pi" },
				},
			});
			work.add(pending);
			try {
				await pending;
				manifests.delete(id);
				currentWindows.delete(id);
				rawReaders.get(id)?.();
				rawReaders.delete(id);
			} finally {
				work.delete(pending);
			}
		},
		dispose(): Promise<void> {
			if (disposal) return disposal;
			disposed = true;
			disposal = (async () => {
				await Promise.allSettled([...work]);
				try {
					await provider.dispose();
					legacy.dispose();
				} finally {
					listeners.clear();
					for (const unregister of rawReaders.values()) unregister();
					rawReaders.clear();
					transport.close();
					db.close();
				}
			})();
			return disposal;
		},
	};
}
