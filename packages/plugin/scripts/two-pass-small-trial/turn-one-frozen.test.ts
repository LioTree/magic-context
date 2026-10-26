import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("production turn-one prompt and parsing remain byte-identical to the run-2 baseline", () => {
    // Git blob identities pin complete bytes, not two outputs of the same builder.
    const baseline = {
        "src/hooks/magic-context/historian-prompt.generated.ts":
            "cb88bd485e6697bb0b83e4659986784e566f8c20",
        "src/hooks/magic-context/historian-prompt.source.md":
            "4631bcc78a05fb6c0336c0e25c711e0c8b6e1056",
        "src/hooks/magic-context/compartment-prompt.ts": "55ff7ef459f528ded2d9d6b13b987c502fd73d18",
        "src/hooks/magic-context/compartment-parser.ts": "b400e0afed0673b0aa6e2bf1a2e08573bba4ab87",
        "src/hooks/magic-context/compartment-runner-validation.ts":
            "a31c78c7121778e5471462c286efbbf4adc72410",
        "src/features/magic-context/memory/turn-one-publication.ts":
            "ff1b85c6d73f00712412d4de5d6b3a5e062b9d49",
        "scripts/two-pass-small-trial/prompts.ts": "eff0b46a07a9964688fddce4a8dae8e6c6d92131",
    };
    for (const [path, expected] of Object.entries(baseline)) {
        const bytes = readFileSync(resolve(import.meta.dir, "../..", path));
        const actual = createHash("sha1")
            .update(`blob ${bytes.length}\0`)
            .update(bytes)
            .digest("hex");
        expect(actual, path).toBe(expected);
    }
});
test("production turn two remains off for every user", () => {
    const allowlist = JSON.parse(
        readFileSync(
            resolve(
                import.meta.dir,
                "../../src/features/magic-context/memory/turn-two-allowlist.json",
            ),
            "utf8",
        ),
    );
    expect(allowlist.entries).toEqual([]);
});
