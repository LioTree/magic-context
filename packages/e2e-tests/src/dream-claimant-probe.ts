/**
 * Runs one claimed dream attempt with the production claimant against a
 * scripted `dream-claim-v1` peer, on whichever host carrier it is given. Used by
 * the host probe plugins, inside the real host process.
 */
import {
    type DreamChildHost,
    DreamChildClaimant,
} from "../../plugin/src/hooks/magic-context/dream-child-claimant";
import { DreamClaimPeer } from "../../plugin/src/hooks/magic-context/host-runner/fixtures/dream-claim-peer.fixture";

export interface DreamProbeScenario {
    session: string;
    agent?: string;
    allowedTools?: string[];
    maxSteps?: number;
    tokenBudget?: number | null;
    model: { model: string; qualifier: string | null } | null;
    system: string;
    prompt: string;
    timeoutMs: number;
    heartbeatIntervalMs?: number;
    /** Drop the open while the child is being created (the runner gave up). */
    cancelOpen?: boolean;
    /** Revoke the task lease once this many task-tool effects have applied. */
    revokeLeaseAfterEffects?: number;
}

export interface DreamProbeResult {
    entry: {
        start: boolean;
        stop: boolean;
        cleaned: boolean;
        steps: number;
        completion: { text: string; length_capped: boolean } | null;
        hostChild: string | null;
    };
    requests: Array<Record<string, unknown>>;
    effects: Array<{ child: string; tool: string; args: unknown }>;
    logs: string[];
    epoch: string;
}

export async function runDreamProbe(
    host: DreamChildHost,
    directory: string,
    scenario: DreamProbeScenario,
): Promise<DreamProbeResult> {
    let entryId = "";
    const peer: DreamClaimPeer = new DreamClaimPeer({
        router: (_child, tool) => {
            if (
                scenario.revokeLeaseAfterEffects !== undefined &&
                peer.effects.length >= scenario.revokeLeaseAfterEffects
            ) {
                peer.revokeLease(entryId);
            }
            return {
                output: { effect: "applied", tool },
                receipt: { tool, affected_ids: ["memory-1"], details: { committed: true } },
            };
        },
    });
    if (scenario.heartbeatIntervalMs !== undefined)
        peer.heartbeatIntervalMs = scenario.heartbeatIntervalMs;
    const probeHost: DreamChildHost = scenario.cancelOpen
        ? {
              capabilities: host.capabilities,
              refusal: (descriptor) => host.refusal(descriptor),
              create: (descriptor, signal) => {
                  peer.cancelOpen(entryId);
                  return host.create(descriptor, signal);
              },
          }
        : host;
    const logs: string[] = [];
    const claimant = new DreamChildClaimant({
        call: async ({ method, sessionId, body }) => peer.route(sessionId, method, body),
        host: probeHost,
        fastPollMs: 20,
        log: (message) => logs.push(message),
    });
    entryId = peer.enqueue({
        session: scenario.session,
        project: directory,
        directory,
        agent: scenario.agent ?? "dreamer",
        allowedTools: scenario.allowedTools ?? ["ctx_memory"],
        maxSteps: scenario.maxSteps ?? 5,
        model: scenario.model,
        system: scenario.system,
        prompt: scenario.prompt,
        deadlineMs: Date.now() + scenario.timeoutMs,
        tokenBudget: scenario.tokenBudget === undefined ? 10_000 : scenario.tokenBudget,
    });
    await claimant.pump(scenario.session);
    await claimant.settled();
    const entry = peer.entry(entryId);
    return {
        entry: {
            start: entry.start,
            stop: entry.stop,
            cleaned: entry.cleaned,
            steps: entry.steps,
            completion: entry.completion,
            hostChild: entry.hostChild,
        },
        requests: peer.requests,
        effects: peer.effects,
        logs,
        epoch: claimant.claimantEpoch,
    };
}

