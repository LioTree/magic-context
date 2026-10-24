import { expect, test } from "bun:test";
import { resolveSignedThinkingHoldPolicy } from "./signed-thinking-hold";

test("default and explicit off preserve the bounded verdict and fit release", () => {
    for (const setting of [undefined, "off"] as const) {
        const policy = resolveSignedThinkingHoldPolicy(setting);
        expect(policy.strict).toBe(false);
        expect(policy.mayRebuildForFit).toBe(true);
        expect(policy.holdsPrefix(true, false, true)).toBe(true);
        expect(policy.holdsPrefix(true, false, false)).toBe(false);
        expect(policy.holdsPrefix(true, true, false)).toBe(true);
        expect(policy.holdsPrefix(false, true, true)).toBe(false);
    }
});

test("explicit on keeps the signed prefix even after the bounded cap releases", () => {
    const policy = resolveSignedThinkingHoldPolicy("on");
    expect(policy.strict).toBe(true);
    expect(policy.mayRebuildForFit).toBe(false);
    expect(policy.holdsPrefix(true, false, false)).toBe(true);
    expect(policy.holdsPrefix(true, false, true)).toBe(true);
    expect(policy.holdsPrefix(false, false, true)).toBe(false);
});
