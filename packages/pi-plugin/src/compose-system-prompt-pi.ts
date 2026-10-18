import type { MagicContextPluginConfig } from "@magic-context/core/config";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { piModelRefToCanonical } from "@magic-context/core/shared/harness-provider-map";
import {
	createPromptSurfaceGuidanceEpochCache,
	type PromptSurfaceRuntime,
} from "@magic-context/core/shared/prompt-surface-runtime";
import {
	buildMagicContextBlock,
	composeMagicContextSystemPrompt,
	processSystemPromptForCache,
} from "./system-prompt";

export interface PiPromptOptions {
	cwd?: string;
	sections?: Record<string, string>;
}

export interface PiPromptCompositionInput {
	db: ContextDatabase;
	cwd: string;
	sessionId?: string;
	systemPrompt: string;
	systemPromptOptions?: PiPromptOptions;
	/** Read the host's live prompt getter after mutating structured sections. */
	renderSystemPrompt?: () => string;
	model?: { provider?: string; id?: string };
	config: MagicContextPluginConfig;
	/** A disabled standalone extension never registers its prompt hook. */
	registrationEnabled?: boolean;
	runtime: PromptSurfaceRuntime;
	ctxReduceCallable: boolean;
	dreamerEnabled: boolean;
	smartNotesEnabled: boolean;
	hasSystemPromptRefresh(sessionId: string): boolean;
	clearSystemPromptRefresh(sessionId: string): void;
	signalHashChange(sessionId: string, hash: string): void;
	stickyDates?: Map<string, string>;
}

/** The standalone hook and bridge share all guidance, skip and cache decisions. */
export function composePiSystemPrompt(input: PiPromptCompositionInput): {
	systemPrompt: string;
	force: boolean;
	skipped: boolean;
} {
	const { sessionId, config: effectiveConfig, systemPrompt } = input;
	if (
		input.registrationEnabled === false ||
		effectiveConfig.system_prompt_injection?.enabled === false
	) {
		return { systemPrompt, force: false, skipped: true };
	}
	const skipSigs =
		effectiveConfig.system_prompt_injection?.skip_signatures ?? [];
	if (skipSigs.some((sig) => sig.length > 0 && systemPrompt.includes(sig))) {
		return { systemPrompt, force: false, skipped: true };
	}

	// Peek first and drain only after successful composition; failures must retry.
	const isCacheBusting = sessionId
		? input.hasSystemPromptRefresh(sessionId)
		: true;
	const model = input.model;
	const modelKey =
		model?.provider && model.id
			? piModelRefToCanonical(`${model.provider}/${model.id}`)
			: undefined;
	const promptSurface = sessionId
		? createPromptSurfaceGuidanceEpochCache(input.runtime).resolve(
				sessionId,
				effectiveConfig.prompt_surface,
				modelKey,
			)
		: input.runtime.resolveGuidance(effectiveConfig.prompt_surface, modelKey);
	const block = buildMagicContextBlock({
		db: input.db,
		cwd: input.cwd,
		sessionId,
		memoryEnabled: effectiveConfig.memory.enabled,
		includeGuidance: true,
		protectedTags: effectiveConfig.protected_tags,
		ctxReduceCallable: input.ctxReduceCallable,
		dreamerEnabled: input.dreamerEnabled,
		smartNotesEnabled: input.smartNotesEnabled,
		temporalAwarenessEnabled: effectiveConfig.temporal_awareness ?? false,
		cavemanTextCompressionEnabled:
			effectiveConfig.caveman_text_compression?.enabled === true,
		language: effectiveConfig.language,
		promptSurfacePreset: promptSurface.preset,
		primaryGuidanceOverride: promptSurface.primaryOverride,
		isCacheBusting,
		existingSystemPrompt: systemPrompt,
	});
	const composedPrompt = composeMagicContextSystemPrompt(systemPrompt, block);
	const hostSections = input.systemPromptOptions?.sections;
	if (block && hostSections) hostSections.magic_context = block;

	if (!sessionId) {
		return {
			systemPrompt: composedPrompt,
			force: !!block && !hostSections,
			skipped: false,
		};
	}
	const result = processSystemPromptForCache({
		db: input.db,
		sessionId,
		systemPrompt: composedPrompt,
		isCacheBusting,
		promptSurfacePreset: promptSurface.preset,
		stickyDates: input.stickyDates,
	});
	if (result.hashChanged) input.signalHashChange(sessionId, result.currentHash);
	// Use the captured peek, not a new read that could consume a fresh signal.
	if (isCacheBusting) input.clearSystemPromptRefresh(sessionId);

	// Forcing a prompt on Pi hides sections registered by later extensions.
	// Oh My Pi and older Pi releases have no sections and need the forced return.
	return {
		systemPrompt:
			hostSections && input.renderSystemPrompt
				? input.renderSystemPrompt()
				: result.systemPrompt,
		force: !hostSections,
		skipped: false,
	};
}
