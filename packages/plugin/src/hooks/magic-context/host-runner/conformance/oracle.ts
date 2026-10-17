import { resolve } from "node:path";

export const ORACLE_TEST = "providers::relay_conformance::oracle";
export const ORACLE_COMMAND = [
    "cargo",
    "test",
    "-p",
    "mc-module",
    "--lib",
    ORACLE_TEST,
    "--",
    "--exact",
    "--nocapture",
];

/** Each case owns a disposable Magic Context store, reused only for module restarts. */
export function startOracle(options: { contextRoot?: string } = {}) {
    const child = Bun.spawn(ORACLE_COMMAND, {
        windowsHide: true,
        cwd: resolve(import.meta.dir, "../../../../../../.."),
        env: {
            ...process.env,
            MC_RELAY_ORACLE: "1",
            ...(options.contextRoot ? { MC_PI_BRIDGE_ROOT: options.contextRoot } : {}),
            RUSTC_WRAPPER: "",
            CARGO_BUILD_RUSTC_WRAPPER: "",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
    });
    const lines = (async function* () {
        let pending = "";
        const decoder = new TextDecoder();
        for await (const chunk of child.stdout) {
            pending += decoder.decode(chunk, { stream: true });
            const parts = pending.split("\n");
            pending = parts.pop() ?? "";
            for (const line of parts) {
                if (line.startsWith("RELAY_ORACLE ")) yield JSON.parse(line.slice(13)) as string;
            }
        }
    })();
    return {
        async call(request: unknown): Promise<string> {
            child.stdin.write(`${JSON.stringify(request)}\n`);
            await child.stdin.flush();
            const result = await lines.next();
            if (result.done) throw new Error(`MC oracle exited ${await child.exited}`);
            return result.value;
        },
        async close() {
            await child.stdin.end();
            for await (const _ of lines) {
                // Consume cargo's test-result footer so a full stdout pipe cannot block process exit.
            }
            if ((await child.exited) !== 0) throw new Error("MC oracle failed");
        },
    };
}
