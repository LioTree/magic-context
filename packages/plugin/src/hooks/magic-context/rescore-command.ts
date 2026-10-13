import {
    parseRescoreCommand,
    RESCORE_USAGE,
    type RescoreAuthority,
    type RescoreModelProfile,
    RescoreService,
    type RescoreServiceOptions,
} from "../../features/magic-context/rescore-service";
import { cancelRescore, driveRescore, type RescoreCarrier, resumeRescore } from "./rescore-driver";

export const RESCORE_ADOPTION_NOTICE =
    "New scores take effect at the next natural history rebuild; compaction and memory settings are unchanged.";
const READ_ONLY_PROFILE: RescoreModelProfile = {
    model: null,
    temperature: 0,
    maxOutputTokens: 4096,
};

const COMMAND_REFUSALS = new Set([
    RESCORE_USAGE,
    "Unknown rescore job in this project",
    "Unknown, superseded or confirmed snapshot; preview again",
    "Model profile or rubric changed; preview again",
    "Eligible items outside snapshot; preview again",
    "Resume requires the originating harness and frozen model profile",
    "Pause requires the originating harness and frozen model profile",
    "Recover the admitted attempt before resuming",
    "Unknown compartment in this project",
    "Unknown or foreign score revision",
    "No canonical project for rescore",
    "No active Pi session is available.",
    "Rescore owner lease is still live; wait for two missed heartbeats before resume",
]);
export function rescoreCommandErrorText(error: unknown): string {
    return error instanceof Error && COMMAND_REFUSALS.has(error.message)
        ? error.message
        : "Rescore command unavailable. Run /ctx-rescore status to inspect the persisted job error.";
}

export function formatRescoreStatus(service: RescoreService, jobId: string): string {
    const { job, counts, attempts, waitingForLease } = service.status(jobId);
    return [
        `Job ${job.id}: ${job.state} (${job.originating_harness})`,
        `Model: ${JSON.parse(job.model_profile).model ?? "not configured"}`,
        Object.entries(counts)
            .map(([state, count]) => `${state}: ${count}`)
            .join(", "),
        `Attempts/spend records: ${attempts.length}; abandoned: ${attempts.filter((a) => a.state === "abandoned").length}`,
        `Consecutive failed batches: ${job.consecutive_failed_batches}`,
        ...(job.pause_reason ? [`Pause/wait: ${job.pause_reason}`] : []),
        ...(waitingForLease ? ["Waiting for recomp lease before publication"] : []),
        ...(job.blocking_job_id ? [`Blocking job: ${job.blocking_job_id}`] : []),
        ...(job.last_error ? [`last_error: ${job.last_error}`] : []),
        RESCORE_ADOPTION_NOTICE,
    ].join("\n");
}

/** Share the running-job promises and lease generations across command surfaces, so a pause
 * or resume controls the existing local driver instead of creating a competing one. */
export function createRescoreCommandController(options: {
    serviceOptions: (sessionId: string) => Omit<RescoreServiceOptions, "profile">;
    resolveProfile: (sessionId: string) => RescoreModelProfile;
    createCarrier: (sessionId: string) => RescoreCarrier;
    notify?: (sessionId: string, text: string) => Promise<void>;
}) {
    const drivers = new Map<string, { authority: RescoreAuthority; done: Promise<void> }>();
    const authorities = new Map<string, RescoreAuthority>();
    function launch(
        service: RescoreService,
        authority: RescoreAuthority,
        sessionId: string,
        resume = false,
    ) {
        authorities.set(authority.jobId, authority);
        const carrier = options.createCarrier(sessionId);
        const done = (
            resume
                ? resumeRescore(service, authority, carrier).then(() => {})
                : driveRescore(service, authority, carrier)
        )
            .then(async () => {
                await options.notify?.(sessionId, formatRescoreStatus(service, authority.jobId));
            })
            .catch(async () => {
                // The score completion may contain private reasons. Show persisted job status,
                // not an unexpected exception that could contain that completion's text.
                await options.notify?.(
                    sessionId,
                    `Rescore driver stopped. Run /ctx-rescore status.\n${RESCORE_ADOPTION_NOTICE}`,
                );
            })
            .catch(() => {})
            .finally(() => drivers.delete(authority.jobId));
        drivers.set(authority.jobId, { authority, done });
    }
    return async (sessionId: string, raw: string): Promise<string> => {
        // Parse before resolving a model, opening a carrier, or touching the store.
        const command = parseRescoreCommand(raw);
        const service = new RescoreService({
            ...options.serviceOptions(sessionId),
            profile: ["preview", "confirm", "resume", "pause"].includes(command.kind)
                ? options.resolveProfile(sessionId)
                : READ_ONLY_PROFILE,
        });
        if (command.kind === "preview") {
            const preview = service.preview(command.project);
            return [
                `Rescore preview (${command.project ? "project" : "session"})`,
                `Snapshot: ${preview.snapshotId}`,
                `Sessions: ${preview.sessions.join(", ") || "none"}`,
                `Eligible: ${preview.eligible}; oversize (never sent): ${preview.oversize}; estimated calls: ${preview.estimatedCalls}`,
                `Eligible after fix shipped: ${preview.postFix}`,
                `Post-activation rows per harness: ${JSON.stringify(preview.postActivationByHarness)}`,
                preview.disclosure,
                `Start paid work with /ctx-rescore confirm ${preview.snapshotId}`,
            ].join("\n");
        }
        if (command.kind === "confirm") {
            const authority = service.confirm(command.snapshotId);
            launch(service, authority, sessionId);
            return `Started rescore job ${authority.jobId}.\n${RESCORE_ADOPTION_NOTICE}`;
        }
        if (command.kind === "undo-compartment") {
            service.undoCompartment(command.compartmentId, command.revisionId);
            return `Selected ${command.revisionId ?? "base"} for compartment ${command.compartmentId}.\n${RESCORE_ADOPTION_NOTICE}`;
        }
        if (command.kind === "undo-job") {
            const result = service.undoJob(command.jobId, command.base);
            return `Undone: ${result.undone}; unchanged/superseded: ${result.unchanged}.\n${RESCORE_ADOPTION_NOTICE}`;
        }
        const jobs = service.listJobs();
        if (command.kind === "status")
            return jobs.length
                ? jobs.map((job) => formatRescoreStatus(service, job.id)).join("\n\n")
                : `No rescore jobs in this project.\n${RESCORE_ADOPTION_NOTICE}`;
        const job = jobs.find((job) => job.state !== "complete" && job.state !== "cancelled");
        if (!job) return "No active rescore job in this project.";
        if (command.kind === "cancel") {
            await cancelRescore(service, job.id, options.createCarrier(sessionId));
            return formatRescoreStatus(service, job.id);
        }
        const current = drivers.get(job.id);
        if (command.kind === "pause") {
            if (
                !service.pause(
                    current?.authority ?? { jobId: job.id, generation: job.owner_generation },
                )
            )
                throw new Error("Pause requires the originating harness and frozen model profile");
            return formatRescoreStatus(service, job.id);
        }
        if (current) {
            if (service.status(job.id).job.state === "running")
                return formatRescoreStatus(service, job.id);
            await current.done;
        }
        const local = authorities.get(job.id);
        const authority =
            local && service.hasAuthority(local)
                ? local
                : service.takeover(job.id, job.owner_generation);
        if (!authority)
            throw new Error(
                "Rescore owner lease is still live; wait for two missed heartbeats before resume",
            );
        if (!service.hasAuthority(authority))
            throw new Error("Resume requires the originating harness and frozen model profile");
        launch(service, authority, sessionId, true);
        return `Resuming job ${job.id}.\n${RESCORE_ADOPTION_NOTICE}`;
    };
}
