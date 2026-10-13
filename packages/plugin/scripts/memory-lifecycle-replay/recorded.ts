import { z } from "zod";
import { KEPT_CHECK_INPUT_MAX } from "../../src/features/magic-context/memory/lifecycle-constants";
import {
    type GateContext,
    planMemoryRevision,
    type RevisionDecision,
} from "../../src/features/magic-context/memory/lifecycle-gates";
import {
    lifecycleTextHash,
    splitMemoryClauses,
} from "../../src/features/magic-context/memory/lifecycle-text";
import { parseCompartmentOutput } from "../../src/hooks/magic-context/compartment-parser";
import {
    CONTROL_IDS,
    type CorpusManifest,
    type FileRecord,
    frozenSchema,
    GEMINI_MODEL,
    keptInputBound,
    printedBlocks,
    recordedFirstReply,
} from "./core";

const claimSchema = z.object({
    clause: z.number().int().positive(),
    quote: z.string(),
    status: z.string(),
});
const editSchema = z.object({
    op: z.string(),
    clause: z.number().int().positive().optional(),
    text: z.string().optional(),
    evidence: z.string().optional(),
});
export const legacyDecisionSchema = z.object({
    fact: z.number().int().positive(),
    action: z.string(),
    target: z.number().int().positive().optional(),
    claims: z.array(claimSchema).default([]),
    edits: z.array(editSchema).default([]),
});
export const secondRecordSchema = z.object({
    requestHash: z.string(),
    request: z.object({
        model: z.string(),
        system: z.string(),
        temperature: z.number().optional(),
    }),
    response: z.object({ model: z.string().optional() }).optional(),
    text: z.string(),
});
export type FrozenCase = z.infer<typeof frozenSchema>;

export function snapshotCase(
    id: number,
    frozenFile: FileRecord,
    firstFile: FileRecord,
    records: FileRecord[],
    read: (file: FileRecord) => string,
): CorpusManifest["cases"][number] {
    const frozen = frozenSchema.parse(JSON.parse(read(frozenFile)));
    const reply = recordedFirstReply(read(firstFile));
    const blocks = printedBlocks(frozen.input.prompt);
    return {
        id,
        input: frozenFile,
        firstReply: firstFile,
        frozen: frozenFile,
        candidates: frozenFile,
        records,
        blocks: blocks.map((block) => ({
            start: block.startOrdinal,
            end: block.endOrdinal,
            sha256: lifecycleTextHash(block.joinedText),
        })),
        facts: frozen.facts.map((fact, index) => ({
            id: index + 1,
            contentHash: lifecycleTextHash(fact.content),
            origin: frozen.origins[index]?.startsWith("reconstructed")
                ? "reconstructed-control"
                : "reply",
            // Case 35's third fact (transport sizing) has an edit whose evidence string uniquely matches
            // a printed source block. Only that match supplies an ordinal-range anchor.
            // Facts without a source-block mapping must not inherit the complete transcript.
            anchor:
                id === 35 && index === 2 ? transportControlAnchor(read(firstFile), frozen) : null,
        })),
        replyFactHashes: parseCompartmentOutput(reply).facts.map((fact) =>
            lifecycleTextHash(fact.content),
        ),
        keptCheckInputUnits: keptInputBound(frozen),
    };
}

export function transportControlAnchor(recordText: string, frozen: FrozenCase) {
    const record = secondRecordSchema.parse(JSON.parse(recordText));
    const envelope = z
        .object({ decisions: z.array(legacyDecisionSchema) })
        .parse(JSON.parse(record.text));
    const excerpt = envelope.decisions.find((decision) => decision.fact === 3)?.edits[0]?.evidence;
    if (!excerpt) return null;
    const blocks = printedBlocks(frozen.input.prompt).filter((block) =>
        block.joinedText.includes(excerpt),
    );
    return blocks.length === 1
        ? { start: blocks[0]!.startOrdinal, end: blocks[0]!.endOrdinal }
        : null;
}

/** Captured "merge" decisions contain one target memory ID and edit operations, not a source list.
 * Represent them as single-memory edits; calling them multi-source merges would invent a source. */
export function adaptLegacyDecision(
    key: string,
    raw: unknown,
    frozen: FrozenCase,
): RevisionDecision | { reason: string } {
    const parsed = legacyDecisionSchema.safeParse(raw);
    if (!parsed.success) return { reason: "legacy_decision_malformed" };
    const decision = parsed.data;
    if (["retire", "promote_rule", "promote"].includes(decision.action))
        return { reason: "historian_action_forbidden" };
    if (!["merge", "update", "replaces"].includes(decision.action))
        return { reason: "non_revision" };
    const source = frozen.matches[decision.fact - 1]?.find(
        (candidate) => candidate.id === decision.target,
    );
    if (!source) return { reason: "control_target_missing" };
    const clauses = splitMemoryClauses(source.content);
    const changes: RevisionDecision["changes"] = [];
    const added: RevisionDecision["added"] = [];
    const final = clauses.map((clause) => clause.text);
    for (const edit of decision.edits) {
        if (edit.op === "append") {
            added.push({
                text: edit.text ?? "",
                evidence: { blockStartOrdinal: -1, excerpt: edit.evidence ?? "" },
            });
            final.push(edit.text ?? "");
            continue;
        }
        if (!["edit", "remove"].includes(edit.op) || !edit.clause)
            return { reason: "legacy_edit_shape" };
        const claim = decision.claims.find((entry) => entry.clause === edit.clause);
        if (!claim || clauses[edit.clause - 1]?.text !== claim.quote)
            return { reason: "legacy_clause_split_mismatch" };
        const matches = printedBlocks(frozen.input.prompt).filter(
            (block) => edit.evidence && block.joinedText.includes(edit.evidence),
        );
        const evidence = {
            blockStartOrdinal: matches.length === 1 ? matches[0]!.startOrdinal : -1,
            excerpt: edit.evidence ?? "",
        };
        changes.push({
            memoryId: source.id,
            ordinal: edit.clause,
            replacement: edit.op === "edit",
            evidence,
        });
        final[edit.clause - 1] = "";
        if (edit.op === "edit") {
            added.push({ text: edit.text ?? "", evidence });
            final[edit.clause - 1] = edit.text ?? "";
        }
    }
    return {
        key,
        action: decision.action === "replaces" ? "replaces" : "edit",
        projectPath: "/offline-snapshot",
        expectedSources: [{ id: source.id, revision: 1 }],
        survivorId: source.id,
        finalText: final.filter(Boolean).join(" "),
        changes,
        added,
    };
}

export function auditRecordedControl(
    control: string,
    raw: unknown,
    frozen: FrozenCase,
    recordText: string,
    anchor: { start: number; end: number } | null = null,
) {
    const record = secondRecordSchema.parse(JSON.parse(recordText));
    const decision = adaptLegacyDecision(control, raw, frozen);
    const profile = {
        provider: "anthropic",
        modelId: record.response?.model ?? "UNREPORTED",
        variant: null,
        temperature: record.request.temperature ?? null,
        systemHash: lifecycleTextHash(record.request.system),
    };
    const hashes = {
        capturedRequestHash: record.requestHash,
        inputRecordHash: lifecycleTextHash(recordText),
        recordedOutputHash: lifecycleTextHash(record.text),
        historianSystemHash: profile.systemHash,
    };
    if ("reason" in decision)
        return {
            control,
            gate: decision.reason,
            plannedChecks: 0,
            reportedProfile: profile,
            ...hashes,
        };
    const source = frozen.matches.flat().find((candidate) => candidate.id === decision.survivorId)!;
    const context: GateContext = {
        enabled: true,
        enforcedJson: true,
        memoryEnabled: true,
        autoPromote: true,
        anchorKnown: anchor !== null,
        blocks: printedBlocks(frozen.input.prompt).filter(
            (block) =>
                anchor && block.startOrdinal === anchor.start && block.endOrdinal === anchor.end,
        ),
        sources: [
            {
                id: source.id,
                revision: 1,
                projectPath: "/offline-snapshot",
                content: source.content,
                status: "active",
            },
        ],
        historianProfile: profile,
        validatedProfiles: [],
    };
    const plan = planMemoryRevision(decision, context);
    return {
        control,
        gate: plan.ok ? "recorded_checks_required" : plan.reason,
        plannedChecks: plan.ok ? plan.checks.length : 0,
        reportedProfile: profile,
        ...hashes,
    };
}

export function recordedAudit(manifest: CorpusManifest, read: (file: FileRecord) => string) {
    const controls = CONTROL_IDS.map((control) => {
        const [id, factId] = control.split(":").map(Number);
        const item = manifest.cases.find((entry) => entry.id === id);
        if (!item?.facts.find((fact) => fact.id === factId) || !item.frozen)
            return { control, gate: "control_candidate_missing", plannedChecks: 0 };
        const frozen = frozenSchema.parse(JSON.parse(read(item.frozen)));
        const text = read(item.firstReply);
        const record = secondRecordSchema.parse(JSON.parse(text));
        const envelope = z
            .object({ decisions: z.array(legacyDecisionSchema) })
            .parse(JSON.parse(record.text));
        const decision = envelope.decisions.find((entry) => entry.fact === factId);
        if (!decision) return { control, gate: "control_decision_missing", plannedChecks: 0 };
        const judgmentFile = item.records.find((file) => file.path.endsWith("-judgments.json"));
        const judgments = judgmentFile
            ? z
                  .object({
                      decisions: z.array(
                          z.object({
                              fact: z.number(),
                              grade: z.string(),
                              proposedGrade: z.string(),
                          }),
                      ),
                  })
                  .parse(JSON.parse(read(judgmentFile))).decisions
            : [];
        const judgment = judgments.find((grade) => grade.fact === factId);
        return {
            ...auditRecordedControl(
                control,
                decision,
                frozen,
                text,
                item.facts.find((fact) => fact.id === factId)?.anchor ?? null,
            ),
            historicalEffectiveGrade: judgment?.grade ?? "missing",
            historicalProposedGrade: judgment?.proposedGrade ?? "missing",
            historicalGradeFileHash: judgmentFile?.sha256 ?? null,
        };
    });
    return {
        mode: "offline-recorded-audit",
        validatedProfiles: [],
        requiredModels: { gemini: GEMINI_MODEL, deepseek: manifest.models.deepseek },
        controls,
        recordedProfileInventory: manifest.evidence
            .filter((file) => /(?:gemini|deepseek)-case-\d+-run-\d+-second\.json$/.test(file.path))
            .map((file) => {
                const capture = z
                    .object({
                        requestHash: z.string(),
                        request: z.record(z.string(), z.unknown()),
                        response: z.record(z.string(), z.unknown()).optional(),
                        text: z.string(),
                    })
                    .parse(JSON.parse(read(file)));
                const instruction = z
                    .object({ parts: z.array(z.object({ text: z.string() })) })
                    .safeParse(capture.request.systemInstruction);
                const messages = z
                    .array(z.object({ role: z.string(), content: z.string() }))
                    .safeParse(capture.request.messages);
                const system = instruction.success
                    ? instruction.data.parts.map((part) => part.text).join("")
                    : messages.success
                      ? messages.data.find((message) => message.role === "system")?.content
                      : undefined;
                const generation = z
                    .object({ temperature: z.number().optional() })
                    .safeParse(capture.request.generationConfig);
                return {
                    path: file.path,
                    inputRecordHash: file.sha256,
                    capturedRequestHash: capture.requestHash,
                    outputHash: lifecycleTextHash(capture.text),
                    systemHash: system ? lifecycleTextHash(system) : null,
                    reportedModelId:
                        capture.response?.model ?? capture.response?.modelVersion ?? null,
                    requestModelId: capture.request.model ?? null,
                    requestVariant: capture.request.reasoning_effort ?? null,
                    requestTemperature:
                        capture.request.temperature ??
                        (generation.success ? (generation.data.temperature ?? null) : null),
                    status: "recorded-only-not-validated",
                };
            }),
        cases: manifest.cases.length,
        facts: manifest.cases.reduce((sum, item) => sum + item.facts.length, 0),
        missingAnchors: manifest.cases.reduce(
            (sum, item) => sum + item.facts.filter((fact) => !fact.anchor).length,
            0,
        ),
        bounds: manifest.cases.map((item) => ({
            caseId: item.id,
            units: item.keptCheckInputUnits,
            withinLimit:
                item.keptCheckInputUnits !== null &&
                item.keptCheckInputUnits <= KEPT_CHECK_INPUT_MAX,
        })),
    };
}
