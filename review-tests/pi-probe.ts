import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const source = Bun.argv[2]!;
const context = await import(pathToFileURL(join(source, "packages/pi-plugin/src/context-handler.ts")).href);
const utils = await import(pathToFileURL(join(source, "packages/pi-plugin/src/test-utils.test.ts")).href);
const db = utils.createTestDb();
const fake = utils.createFakePi();
context.registerPiContextHandler(fake.pi, { db });
const messages = [utils.userMessage("stable Pi source: café 🦀", 1), utils.userMessage("appended tail", 2)];
const handler = fake.handlers.get("context");
assert.ok(handler);
try {
    const output = [];
    for (const cut of [1, 2]) {
        const input = messages.slice(0, cut);
        const result = await handler({ messages: input }, utils.fakeContext("review-pi", "/tmp/resident-review-no-config", input.map((_: unknown, i: number) => `entry-${i}`), input));
        const served = result?.messages ?? input;
        assert.ok(served.length > 0);
        output.push(served.map((message: unknown) => JSON.stringify(message)));
    }
    console.log(`PI_REVIEW=${JSON.stringify(output)}`);
} finally { context.clearContextHandlerSession("review-pi"); db.close(); }
