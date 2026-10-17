import { afterEach, describe, expect, test } from "bun:test";
import { BRIDGED_SESSIONS_KEY, hasBridgedSessions, isBridgedSession } from "./bridged-sessions";

const slot = globalThis as unknown as Record<symbol, unknown>;

function clearSlot(): void {
    // A getter installed by one case must not leak into the next.
    Reflect.deleteProperty(slot, BRIDGED_SESSIONS_KEY);
}

afterEach(clearSlot);

describe("isBridgedSession", () => {
    test("reads the slot other products publish through the global symbol registry", () => {
        expect(BRIDGED_SESSIONS_KEY).toBe(Symbol.for("cortexkit.bridged-sessions"));
        slot[Symbol.for("cortexkit.bridged-sessions")] = new Map([
            ["ses-bridged", { product: "thalamus", version: "1.0.0" }],
        ]);
        expect(isBridgedSession("ses-bridged")).toBe(true);
        expect(isBridgedSession("ses-other")).toBe(false);
        expect(hasBridgedSessions()).toBe(true);
    });

    test("a missing slot means no session is bridged", () => {
        expect(isBridgedSession("ses-any")).toBe(false);
        expect(hasBridgedSessions()).toBe(false);
    });

    test("values that are not a Map mean no session is bridged", () => {
        const notMaps: unknown[] = [
            null,
            undefined,
            0,
            "ses-a",
            ["ses-a"],
            new Set(["ses-a"]),
            { "ses-a": true },
            { has: () => true, size: 1 },
            new WeakMap(),
        ];
        for (const value of notMaps) {
            slot[BRIDGED_SESSIONS_KEY] = value;
            expect(isBridgedSession("ses-a")).toBe(false);
            expect(hasBridgedSessions()).toBe(false);
        }
    });

    test("an empty map reports no bridged sessions", () => {
        slot[BRIDGED_SESSIONS_KEY] = new Map();
        expect(isBridgedSession("ses-a")).toBe(false);
        expect(hasBridgedSessions()).toBe(false);
    });

    test("IDs that are not non-empty strings are never bridged", () => {
        slot[BRIDGED_SESSIONS_KEY] = new Map<unknown, unknown>([
            ["", { product: "thalamus" }],
            [undefined, { product: "thalamus" }],
            [42, { product: "thalamus" }],
        ]);
        expect(isBridgedSession("")).toBe(false);
        expect(isBridgedSession(undefined)).toBe(false);
        expect(isBridgedSession(42)).toBe(false);
        expect(isBridgedSession(null)).toBe(false);
    });

    test("a throwing slot or map never throws into the caller", () => {
        Object.defineProperty(slot, BRIDGED_SESSIONS_KEY, {
            configurable: true,
            get() {
                throw new Error("hostile getter");
            },
        });
        expect(isBridgedSession("ses-a")).toBe(false);
        expect(hasBridgedSessions()).toBe(false);
        clearSlot();

        const hostile = new Map([["ses-a", { product: "thalamus" }]]);
        Object.defineProperty(hostile, "has", {
            value: () => {
                throw new Error("hostile has");
            },
        });
        Object.defineProperty(hostile, "size", {
            get() {
                throw new Error("hostile size");
            },
        });
        slot[BRIDGED_SESSIONS_KEY] = hostile;
        expect(isBridgedSession("ses-a")).toBe(false);
        expect(hasBridgedSessions()).toBe(false);
    });

    test("membership changes are seen on the next call, with no caching", () => {
        const sessions = new Map<string, { product: string }>();
        slot[BRIDGED_SESSIONS_KEY] = sessions;
        expect(isBridgedSession("ses-late")).toBe(false);
        sessions.set("ses-late", { product: "thalamus" });
        expect(isBridgedSession("ses-late")).toBe(true);
        sessions.delete("ses-late");
        expect(isBridgedSession("ses-late")).toBe(false);
    });
});

describe("isBridgedSession hot-path cost", () => {
    // The check runs at the top of every per-session hook, including every
    // messages-transform pass, so it must stay far below a microsecond.
    function nanosecondsPerCall(sessionID: string, iterations: number): number {
        let hits = 0;
        const started = Bun.nanoseconds();
        for (let index = 0; index < iterations; index += 1) {
            if (isBridgedSession(sessionID)) hits += 1;
        }
        const elapsed = Bun.nanoseconds() - started;
        // Keep the loop observable so the engine cannot drop it.
        expect(hits === 0 || hits === iterations).toBe(true);
        return elapsed / iterations;
    }

    function bestOf(sessionID: string): number {
        const iterations = 200_000;
        nanosecondsPerCall(sessionID, iterations); // warm-up
        let best = Number.POSITIVE_INFINITY;
        for (let run = 0; run < 5; run += 1) {
            best = Math.min(best, nanosecondsPerCall(sessionID, iterations));
        }
        return best;
    }

    test("costs well under 1 µs per pass with no bridge, a miss and a hit", () => {
        const noBridge = bestOf("ses-unenrolled");

        const sessions = new Map<string, { product: string }>();
        for (let index = 0; index < 1_000; index += 1) {
            sessions.set(`ses-enrolled-${index}`, { product: "thalamus" });
        }
        slot[BRIDGED_SESSIONS_KEY] = sessions;
        const miss = bestOf("ses-unenrolled");
        const hit = bestOf("ses-enrolled-500");

        console.log(
            `[bridged-sessions bench] ns/call: no-bridge=${noBridge.toFixed(1)} miss=${miss.toFixed(1)} hit=${hit.toFixed(1)}`,
        );
        expect(noBridge).toBeLessThan(1_000);
        expect(miss).toBeLessThan(1_000);
        expect(hit).toBeLessThan(1_000);
    });
});
