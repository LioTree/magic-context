import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { MessageLike } from "../../transform-operations";
import type { Action, PiEntry, VectorFile } from "./format";
import { ORACLE_COMMAND, startOracle } from "./oracle";
import { generateCase } from "./runner";

export const VECTOR_PATH = new URL("./vectors/relay-v1.json", import.meta.url);
const message = (id: string, role: "user" | "assistant", text: string): MessageLike =>
    ({
        info: { id, role, time: { created: 100 } },
        parts: [{ id: `${id}-text`, type: "text", text }],
    }) as MessageLike;
const user = message("m1", "user", "Preserve Unicode: café § and CRLF\r\nexactly.");
const assistant = {
    ...message("m2", "assistant", "Read both files."),
    parts: [
        {
            id: "reasoning",
            type: "reasoning",
            text: "signed reasoning",
            signature: "opaque-signature",
        },
        { id: "m2-text", type: "text", text: "Read both files." },
        ...["a", "b"].map((suffix) => ({
            id: `tool-${suffix}`,
            type: "tool",
            callID: `call-${suffix}`,
            tool: "read",
            state: {
                status: "completed",
                input: { z: 1, a: 2 },
                output: `file ${suffix}\ncontents`,
            },
        })),
    ],
} as MessageLike;
const pi = (id: string): PiEntry => ({
    id,
    parentId: "branch-parent",
    message: {
        role: "assistant",
        content: [{ type: "text", text: "Pi entry: stable owner." }],
        timestamp: 100,
    },
});

/** Inputs only: Magic Context's real provider and adapter generate every expected value. */
export function scenarios(): { id: string; actions: Action[] }[] {
    const bootstrap: Action = { kind: "bootstrap" };
    const serve: Action = { kind: "serve", messages: [user, assistant] };
    return [
        {
            id: "session-delete-idempotent-and-terminal-step",
            actions: [
                bootstrap,
                serve,
                { kind: "delete" },
                { kind: "delete" },
                { kind: "step_deleted" },
            ],
        },
        {
            id: "receipt-clean-stream-not-headers-or-failure",
            actions: [
                bootstrap,
                { ...serve, defer_delivery: true },
                { kind: "delivery", status: 200, cleanEnd: false },
                { kind: "delivery", status: 502, cleanEnd: true },
                { kind: "restart", target: "relay" },
                { kind: "delivery", status: 200, cleanEnd: true, stop_reason: "refusal" },
            ],
        },
        {
            id: "receipt-covering-applied-view-after-clean-delivery",
            actions: [
                bootstrap,
                { kind: "serve", messages: [user, message("m2", "user", "retained tail")] },
                {
                    kind: "publish",
                    end_mid: "m1",
                    ordinal: 1,
                    content: "Published covered first user.",
                },
                { kind: "status", admission: "accept", rebuild: true },
                { kind: "delivery", status: 200, cleanEnd: true },
                { kind: "restart", target: "relay" },
            ],
        },
        {
            id: "applied-once-retry-restart",
            actions: [
                bootstrap,
                serve,
                {
                    kind: "serve",
                    messages: [user, message("m2", "assistant", "host edited already served text")],
                },
                { kind: "retry", mid: "m2" },
                { kind: "restart", target: "relay" },
                { kind: "restart", target: "module" },
                { kind: "retry", mid: "m2" },
                serve,
            ],
        },
        ...(["transport", "timeout"] as const).map((mode) => ({
            id: `whole-message-raw-${mode}`,
            actions: [
                bootstrap,
                { ...serve, fault: { hook: "post_tool", mode } },
                { kind: "restart", target: "relay" },
                { kind: "status", admission: "accept" },
                serve,
                { kind: "restart", target: "module" },
                {
                    kind: "serve",
                    messages: [
                        user,
                        message("m2", "assistant", "late visible tags must not catch up"),
                    ],
                },
            ] as Action[],
        })),
        ...(["structural", "late", "superseded", "accept"] as const).map((admission) => ({
            id: `view-${admission}-coverage`,
            actions: [
                bootstrap,
                {
                    kind: "serve",
                    messages: [
                        user,
                        message("m2", "assistant", "middle"),
                        message("m3", "user", "retained tail"),
                    ],
                },
                {
                    kind: "publish",
                    end_mid: "m1",
                    ordinal: 1,
                    content: "Frozen summary of first user.",
                },
                { kind: "status", admission, rebuild: true },
                { kind: "restart", target: "relay" },
                { kind: "status", admission: "accept" },
            ] as Action[],
        })),
        {
            id: "pi-entry-alias-never-renumbers",
            actions: [
                bootstrap,
                { kind: "pi", entries: [pi("pi-msg-fallback")] },
                { kind: "alias", from: "pi-msg-fallback", to: "entry-real-007" },
                { kind: "pi", entries: [pi("entry-real-007")] },
                { kind: "restart", target: "relay" },
                { kind: "pi", entries: [pi("entry-real-007")] },
            ],
        },
    ];
}

export function encodeVectors(vectors: VectorFile): string {
    return `${JSON.stringify(vectors, null, 4)}\n`;
}

export async function generateVectors(): Promise<VectorFile> {
    const oracle = startOracle();
    try {
        const cases = [];
        for (const scenario of scenarios())
            cases.push(await generateCase(scenario.id, scenario.actions, oracle.call));
        return {
            schema: "mc-relay/v1",
            generator: {
                version: 1,
                source_base: "282d9c08bce490346583a3b8c145c402499f980f",
                oracle: ORACLE_COMMAND.join(" "),
            },
            cases,
        };
    } finally {
        await oracle.close();
    }
}

if (import.meta.main && process.argv.includes("--pi")) {
    const pi = await import(
        new URL(
            "../../../../../../pi-plugin/src/host-runner/conformance/generate.ts",
            import.meta.url,
        ).href
    );
    const bytes = `${JSON.stringify(await pi.generatePiVectors(), null, 4)}\n`;
    if (process.argv.includes("--write")) {
        await mkdir(new URL(".", pi.PI_VECTOR_PATH), { recursive: true });
        await writeFile(pi.PI_VECTOR_PATH, bytes);
    } else if (process.argv.includes("--print")) console.log(bytes);
    else if ((await readFile(pi.PI_VECTOR_PATH, "utf8")) !== bytes)
        throw new Error("relay-pi-v1.json drift; regenerate with --write --pi");
    console.log(`relay-pi-v1: ${JSON.parse(bytes).cases.length} cases generated from real MC`);
} else if (import.meta.main) {
    const bytes = encodeVectors(await generateVectors());
    if (process.argv.includes("--write")) {
        await mkdir(new URL("./vectors/", import.meta.url), { recursive: true });
        await writeFile(VECTOR_PATH, bytes);
    } else if ((await readFile(VECTOR_PATH, "utf8")) !== bytes)
        throw new Error("relay-v1.json drift; regenerate with --write");
    console.log(`relay-v1: ${JSON.parse(bytes).cases.length} cases generated from real MC`);
}
