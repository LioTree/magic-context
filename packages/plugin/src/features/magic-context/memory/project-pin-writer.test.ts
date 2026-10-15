import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { createTestTempDir } from "../../../shared/test-temp-dir";
import type { PinWriteRequest } from "./project-pin-worker";
import { __setProjectPinWriterForTests, ProjectPinWriter } from "./project-pin-writer";

const temp = createTestTempDir("mc-project-pin-writer-");
const writers: ProjectPinWriter[] = [];
afterEach(async () => {
    for (const writer of writers.splice(0)) await writer.shutdown(100);
    await __setProjectPinWriterForTests();
});

function controlled(capacity = 256) {
    const calls: PinWriteRequest[] = [];
    const completions: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    const messages: string[] = [];
    const writer = new ProjectPinWriter(
        (request) => {
            calls.push(request);
            return new Promise<void>((resolve, reject) => completions.push({ resolve, reject }));
        },
        capacity,
        (message) => messages.push(message),
    );
    writers.push(writer);
    return { writer, calls, completions, messages };
}

async function turn() {
    // The pump and completion handlers each use microtasks, not wall-clock sleeps.
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

function publish(writer: ProjectPinWriter, name: string, identity = "pj-FIRST") {
    const destination = join(temp.dir, name, "pin.json");
    writer.publish(destination, { directory: `/${name}`, identity, gitCommonDir: "/repo.git" });
    return destination;
}

test("publishes before writing and coalesces a folder without replacing its first pin", async () => {
    const { writer, calls, completions } = controlled();
    const destination = publish(writer, "coalesced");
    for (let i = 0; i < 20; i++) publish(writer, "coalesced", "pj-LATER");
    expect(writer.lookup(destination)?.identity).toBe("pj-FIRST");
    expect(writer.records(join(temp.dir, "coalesced"))).toHaveLength(1);
    expect(calls).toHaveLength(0);
    await turn();
    expect(calls).toHaveLength(1);
    expect(calls[0].record.identity).toBe("pj-FIRST");
    completions[0].resolve();
    expect(await writer.flush(100)).toBe(true);
    writer.lookup(destination);
    await turn();
    expect(calls).toHaveLength(1);
});

test("overflow remains visible and retries on the next folder lookup", async () => {
    const { writer, calls, completions, messages } = controlled(2);
    publish(writer, "active");
    await turn();
    publish(writer, "queued-a");
    publish(writer, "queued-b");
    const overflow = publish(writer, "overflow");
    publish(writer, "overflow-other");
    expect(writer.lookup(overflow)?.identity).toBe("pj-FIRST");
    expect(messages).toHaveLength(1);
    expect(calls).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
        completions[i].resolve();
        await turn();
    }
    expect(calls).toHaveLength(3);
    expect(await writer.flush(100)).toBe(true);
    writer.lookup(overflow);
    await turn();
    expect(calls).toHaveLength(4);
    expect(calls[3].destination).toBe(overflow);
    completions[3].resolve();
    expect(await writer.flush(100)).toBe(true);
});

test("failed writes retain the pin and retry only on another decision", async () => {
    const { writer, calls, completions } = controlled();
    const destination = publish(writer, "failed");
    await turn();
    completions[0].reject(new Error("injected write failure"));
    expect(await writer.flush(100)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(writer.lookup(destination)?.identity).toBe("pj-FIRST");
    await turn();
    expect(calls).toHaveLength(2);
    completions[1].resolve();
    expect(await writer.flush(100)).toBe(true);
});

test("shutdown is bounded when a writer is stuck and stops admitting new work", async () => {
    const { writer, calls, completions } = controlled();
    publish(writer, "stuck");
    await turn();
    publish(writer, "abandoned");
    expect(await writer.shutdown(20)).toBe(false);
    const visible = publish(writer, "after-close");
    expect(writer.lookup(visible)?.identity).toBe("pj-FIRST");
    completions[0].resolve();
    await turn();
    expect(calls).toHaveLength(1);
});
