import { expect, test } from "bun:test";
import { ORACLE_COMMAND, ORACLE_TEST, oracleCommand } from "./oracle";

test("conformance oracle uses the prebuilt binary and exact test filter in CI", () => {
    const env = { CI: "true", MC_CONFORMANCE_ORACLE_BINARY: process.execPath };
    expect(oracleCommand(ORACLE_TEST, env)).toEqual([
        process.execPath,
        ORACLE_TEST,
        "--exact",
        "--nocapture",
    ]);
    expect(oracleCommand("providers::relay_conformance::pending_watermark_oracle", env)).toEqual([
        process.execPath,
        "providers::relay_conformance::pending_watermark_oracle",
        "--exact",
        "--nocapture",
    ]);
});

test("conformance oracle fails loudly instead of building when CI has no binary", () => {
    expect(() => oracleCommand(ORACLE_TEST, { CI: "true" })).toThrow(
        "MC_CONFORMANCE_ORACLE_BINARY_REQUIRED",
    );
});

test("conformance oracle rejects an unusable configured binary without a Cargo fallback", () => {
    for (const CI of [undefined, "true"]) {
        expect(() =>
            oracleCommand(ORACLE_TEST, {
                CI,
                MC_CONFORMANCE_ORACLE_BINARY: "/missing/mc-conformance-oracle",
            }),
        ).toThrow("MC_CONFORMANCE_ORACLE_BINARY_UNUSABLE");
    }
});

test("conformance oracle keeps on-demand Cargo builds available outside CI", () => {
    expect(oracleCommand(ORACLE_TEST, {})).toEqual(ORACLE_COMMAND);
    expect(oracleCommand("other_oracle", {})).toContain("other_oracle");
});
