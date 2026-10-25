import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposableEnvironment } from "../two-pass-live-replay/host-drivers";
import { processActivationTransport, type ActivationHost } from "./activation-driver";

test("process transport preserves lazy observations and stops the launched process", async () => {
    const parent = join(realpathSync(tmpdir()), "magic-context");
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, "process-contract-"));
    const installRoot = join(root, "install");
    mkdirSync(installRoot);
    let carrier: ActivationHost["carrier"] = "unobservable";
    let store: string | null = null;
    const transport = processActivationTransport({
        stage: (cwd) => ({ argv: ["true"], cwd }),
        build: (cwd) => ({ argv: ["true"], cwd }),
        entrypoint: () => join(installRoot, "fixture.js"),
        launch: () => ({ argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"], cwd: root }),
        async connect() {
            return { lane: "opencode-2", get carrier() { return carrier; }, get storePath() { return store; },
                async runSession() { carrier = "hidden-completion"; store = join(root, "fixture.db"); return { fixture: true }; } };
        },
    });
    let host: ActivationHost | undefined;
    try {
        host = await transport.start({ installRoot, pluginEntrypoint: join(installRoot, "fixture.js"), env: disposableEnvironment(root),
            meter: { beforeSend() { throw new Error("no_provider_dispatch_expected"); }, settle() { throw new Error("no_provider_dispatch_expected"); } } });
        expect(host.carrier).toBe("unobservable");
        expect(host.storePath).toBeNull();
        await host.runSession("fixture");
        expect(host.carrier).toBe("hidden-completion");
        expect(host.storePath).toBe(join(root, "fixture.db"));
        await host.stop();
        expect(() => process.kill(host!.pid, 0)).toThrow();
    } finally { await host?.stop(); rmSync(root, { recursive: true, force: true }); }
});
