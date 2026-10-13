import { z } from "zod";
import { lifecycleTextHash } from "../../src/features/magic-context/memory/lifecycle-text";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const gradeSchema = z
    .object({
        decisionKey: z.string().min(1),
        inputHash: hash,
        outputHash: hash,
        grade: z.enum(["correct", "wrong", "debatable"]),
        wrongKinds: z.array(
            z.enum([
                "lost-valid-claim",
                "unsupported-change",
                "blend",
                "known-fact-duplicate",
                "invented-date",
            ]),
        ),
        reason: z.string().min(1),
    })
    .strict();
export const gradingLedgerSchema = z
    .object({
        reviewer: z.string().min(1),
        producer: z.string().min(1),
        rubric: z.literal("v6"),
        grades: z.array(gradeSchema),
    })
    .strict();

export interface ObservedDecision {
    key: string;
    control: string;
    action: string;
    accepted: boolean;
    input: string;
    output: string;
    targetBefore: string;
    targetAfter: string;
}

/** Receipts supply the observed bytes; grades cannot nominate a different or missing output. */
export function replayBarFailures(observed: ObservedDecision[], rawLedger: unknown): string[] {
    const parsed = gradingLedgerSchema.safeParse(rawLedger);
    if (!parsed.success) return ["independent_v6_grades_missing_or_malformed"];
    const ledger = parsed.data;
    const failures: string[] = [];
    if (ledger.reviewer === ledger.producer) failures.push("v6_grader_not_independent");
    if (
        new Set(observed.map((entry) => entry.key)).size !== observed.length ||
        new Set(ledger.grades.map((entry) => entry.decisionKey)).size !== ledger.grades.length
    )
        failures.push("duplicate_decision_or_grade");
    for (const entry of observed) {
        const grade = ledger.grades.find((row) => row.decisionKey === entry.key);
        if (
            !grade ||
            grade.inputHash !== lifecycleTextHash(entry.input) ||
            grade.outputHash !== lifecycleTextHash(entry.output)
        ) {
            failures.push(`${entry.key}: grade_missing_or_wrong_bytes`);
            continue;
        }
        if (entry.accepted && (grade.grade !== "correct" || grade.wrongKinds.length))
            failures.push(`${entry.key}: wrong_or_ambiguous_accepted_decision`);
        if (entry.accepted && ["retire", "promote_rule", "promote"].includes(entry.action))
            failures.push(`${entry.key}: historian_action_forbidden`);
        if (entry.accepted && grade.wrongKinds.includes("invented-date"))
            failures.push(`${entry.key}: invented_date`);
        const dates = entry.targetAfter.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
        if (
            entry.accepted &&
            dates.some((date) => !entry.targetBefore.includes(date) && !entry.input.includes(date))
        )
            failures.push(`${entry.key}: unsupported_literal_date`);
        if (entry.control === "12:10" && entry.accepted && grade.wrongKinds.includes("blend"))
            failures.push("12:10: blended_disagreement");
        if (
            entry.control === "35:3" &&
            (!entry.targetAfter.includes("64 KiB") || !entry.targetAfter.includes(">512 KiB"))
        )
            failures.push("35:3: transport_bounds_lost");
    }
    for (const control of ["12:10", "27:13", "35:3", "2:4"]) {
        if (!observed.some((entry) => entry.control === control))
            failures.push(`${control}: control_not_replayed`);
    }
    const repair = observed.find((entry) => entry.control === "2:4");
    if (
        !repair?.accepted ||
        repair.targetAfter === repair.targetBefore ||
        repair.targetAfter.includes("that is the gap to close with a host-runner default.")
    )
        failures.push("2:4: outdated_c4_not_repaired");
    const expectedKeys = new Set(observed.map((entry) => entry.key));
    if (ledger.grades.some((grade) => !expectedKeys.has(grade.decisionKey)))
        failures.push("unmatched_v6_grade");
    return failures;
}
