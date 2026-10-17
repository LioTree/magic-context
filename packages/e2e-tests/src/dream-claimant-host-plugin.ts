/**
 * OpenCode 1 plugin entry for the dream-child claimant host probes.
 *
 * It loads the real Magic Context plugin unchanged and returns its hooks, so the
 * guards under test are the production `chat.params`, `tool.execute.before` and
 * `ctx_memory` hooks. Beside it, it runs the production claimant and OpenCode 1
 * carrier against a scripted `dream-claim-v1` peer (the module's side of the
 * protocol, replayed in TypeScript), driven over a loopback control socket whose
 * port is written to `MC_E2E_DREAM_CONTROL_FILE`. Without that variable this
 * entry is the real plugin and nothing else.
 *
 * Only the default export, in the real entry's `{ id, server }` shape.
 */
import { realpathSync, renameSync, writeFileSync } from "node:fs";
import type { Plugin } from "@opencode-ai/plugin";
import { openDatabase } from "../../plugin/src/features/magic-context/storage-db";
import type { DreamChildHost } from "../../plugin/src/hooks/magic-context/dream-child-claimant";
import { createOpenCode1DreamChildHost } from "../../plugin/src/hooks/magic-context/dream-child-hidden-host";
import realPlugin from "../../plugin/src/index";
import { type DreamProbeScenario, runDreamProbe } from "./dream-claimant-probe";

const server: Plugin = async (ctx, options) => {
    const hooks = await realPlugin.server(ctx, options);
    const controlFile = process.env.MC_E2E_DREAM_CONTROL_FILE;
    if (!controlFile) return hooks;
    const directory = realpathSync(ctx.directory);
    let host: DreamChildHost | undefined;
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(request) {
            try {
                if (!host) {
                    const db = openDatabase();
                    if (!db) throw new Error("context database unavailable");
                    host = createOpenCode1DreamChildHost({ client: ctx.client, db, directory });
                }
                const scenario = (await request.json()) as DreamProbeScenario;
                return Response.json(await runDreamProbe(host, directory, scenario));
            } catch (error) {
                return Response.json({ error: String(error) }, { status: 500 });
            }
        },
    });
    // Written whole, then renamed, so the test never reads half a file.
    writeFileSync(`${controlFile}.tmp`, JSON.stringify({ port: server.port, pid: process.pid }));
    renameSync(`${controlFile}.tmp`, controlFile);
    return hooks;
};

// The same object shape as the real entry, so the host loads it the same way.
export default { id: realPlugin.id, server };
