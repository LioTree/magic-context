/**
 * OpenCode 2 probe plugin for the dream-child claimant, loaded after the real
 * Magic Context plugin (built from `packages/plugin`). It takes the dream child
 * carrier the real instance publishes for its directory (its own native hidden
 * executor) and runs the production claimant on it against a scripted
 * `dream-claim-v1` peer. The steps, tools and `ctx_memory` calls of the child
 * therefore go through the real instance's context and `execute.before` hooks.
 *
 * Commands arrive as `dream-probe-command-<seq>.json` in the host's directory;
 * each result is written to `dream-probe-result-<seq>.json`. The file
 * `dream-probe-ready` appears once the real instance's carrier is published.
 */
import {
    existsSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { publishedDreamChildHost } from "../../../plugin/src/hooks/magic-context/dream-child-claimant";
import { type DreamProbeScenario, runDreamProbe } from "../../src/dream-claimant-probe";

export default {
    id: "mc-dream-claimant-probe",
    async setup(context: { location: { directory: string } }) {
        const directory = realpathSync(context.location.directory);
        const ready = join(directory, "dream-probe-ready");
        const running = new Set<string>();
        const tick = () => {
            const host = publishedDreamChildHost(directory);
            if (!host) return;
            if (!existsSync(ready)) writeFileSync(ready, String(process.pid));
            for (const name of readdirSync(directory)) {
                const match = /^dream-probe-command-(\d+)\.json$/.exec(name);
                if (!match || running.has(name)) continue;
                running.add(name);
                const path = join(directory, name);
                const scenario = JSON.parse(readFileSync(path, "utf8")) as DreamProbeScenario;
                unlinkSync(path);
                void runDreamProbe(host, directory, scenario)
                    .then((result) => result as unknown)
                    .catch((error: unknown) => ({ error: String(error) }))
                    .then((result) => {
                        // Written whole, then renamed, so the test never reads half a file.
                        const target = join(directory, `dream-probe-result-${match[1]}.json`);
                        writeFileSync(`${target}.tmp`, JSON.stringify(result));
                        renameSync(`${target}.tmp`, target);
                    });
            }
        };
        const timer = setInterval(tick, 50);
        return {
            dispose() {
                clearInterval(timer);
            },
        };
    },
};
