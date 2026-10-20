import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runnerReminderFixture } from "../../../../crates/mc-module/gen/gen-runner-reminder-fixture";

test("runner reminder fixture has no drift from TypeScript reminder bytes", () => {
    const committed = JSON.parse(
        readFileSync(
            new URL(
                "../../../../crates/mc-module/testdata/runner-reminder-fixture.json",
                import.meta.url,
            ),
            "utf8",
        ),
    );
    expect(committed).toEqual(runnerReminderFixture());
});
