import { commitHostRunnerBatch } from "../../../features/magic-context/storage-host-runner";
import type { Database } from "../../../shared/sqlite";
import { type BridgeStepKind, StepBudgetExceededError } from "./bridge-types";

/** One pass owns its deadline, cancellation signal and unpublished host writes. */
export class BridgeStep {
    readonly budgetMs: number;
    readonly signal: AbortSignal;
    private readonly controller = new AbortController();
    private readonly deadline: number;
    private readonly cancelled: Promise<never>;
    private readonly timer: ReturnType<typeof setTimeout>;
    private readonly writes: (() => void)[] = [];
    private readonly notifications: (() => void)[] = [];

    constructor(
        readonly kind: BridgeStepKind,
        startedAt = performance.now(),
    ) {
        this.budgetMs = kind === "ordinary" ? 5_000 : 30_000;
        this.deadline = startedAt + this.budgetMs;
        this.signal = this.controller.signal;
        this.cancelled = new Promise((_resolve, reject) => {
            this.signal.addEventListener("abort", () => reject(this.signal.reason), { once: true });
        });
        // A deadline can expire during synchronous work, before any stage awaits it.
        void this.cancelled.catch(() => {});
        this.timer = setTimeout(
            () => this.cancel(),
            Math.max(0, this.deadline - performance.now()),
        );
    }

    private cancel(): void {
        if (!this.signal.aborted)
            this.controller.abort(new StepBudgetExceededError(this.budgetMs, this.kind));
    }

    check(): void {
        if (performance.now() >= this.deadline) this.cancel();
        this.signal.throwIfAborted();
    }

    async wait<T>(work: Promise<T>): Promise<T> {
        this.check();
        const value = await Promise.race([work, this.cancelled]);
        this.check();
        return value;
    }

    write(work: () => void): void {
        this.check();
        this.writes.push(work);
    }

    afterCommit(work: () => void): void {
        this.check();
        this.notifications.push(work);
    }

    reset(): void {
        this.check();
        this.writes.length = 0;
        this.notifications.length = 0;
    }

    commit(db: Database): void {
        commitHostRunnerBatch(db, this.writes, () => this.check());
        clearTimeout(this.timer);
    }

    publish(): void {
        for (const notify of this.notifications) notify();
    }

    dispose(): void {
        clearTimeout(this.timer);
        this.writes.length = 0;
        this.notifications.length = 0;
    }
}
