import type { Database } from "../../shared/sqlite";

/**
 * Remembers cache-busting requests whose work was held because the current
 * turn still keeps signed thinking: an explicit flush, the context-pressure force band and
 * Pi's history refresh. A parked request leaves its queue or pressure flag in place but
 * permits no rebuild until a pass without that thinking.
 */
export class ParkedBustTriggers {
    private obligations: Partial<Record<"materialization" | "force" | "history", string>> = {};
    private saved: string | null = null;

    static load(db: Database, sessionId: string): ParkedBustTriggers {
        const result = new ParkedBustTriggers();
        const row = db
            .prepare("SELECT held_release FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { held_release: string | null } | null;
        result.saved = row?.held_release ?? null;
        if (result.saved !== null) {
            const value = JSON.parse(result.saved) as { obligations?: Record<string, unknown> };
            for (const key of ["materialization", "force", "history"] as const) {
                const reason = value.obligations?.[key];
                if (typeof reason === "string") result.obligations[key] = reason;
            }
        }
        return result;
    }

    /** Refuse to overwrite session_meta.held_release if another writer changed it since load(). */
    persist(db: Database, sessionId: string): void {
        const value = this.pending
            ? JSON.stringify({ version: 1, obligations: this.obligations })
            : null;
        if (value === this.saved) return;
        db.transaction(() => {
            const result = db
                .prepare(
                    "UPDATE session_meta SET held_release = ? WHERE session_id = ? AND held_release IS ?",
                )
                .run(value, sessionId, this.saved);
            if (result.changes !== 1) throw new Error("Held release changed during transform");
        }).immediate();
        this.saved = value;
    }

    reason(trigger: "materialization" | "force" | "history"): string | undefined {
        return this.obligations[trigger];
    }

    get reasons(): string[] {
        return [...new Set(Object.values(this.obligations))];
    }

    /**
     * `historyPending` is the Pi plugin's history-refresh signal; the OpenCode transform
     * does not park that signal and omits it. While `boundary` is true (the current turn
     * still keeps signed thinking) a parked request permits nothing; the first pass
     * without a boundary gets its permission back.
     */
    permissions(
        boundary: boolean,
        materializationPending: boolean,
        forceEligible: boolean,
        historyPending = false,
    ) {
        this.settle(materializationPending, forceEligible, historyPending);
        return {
            materialization:
                materializationPending && !(boundary && this.obligations.materialization),
            force: forceEligible && !(boundary && this.obligations.force),
            history: historyPending && !(boundary && this.obligations.history),
        };
    }

    holdMaterialization(reason = "thinking_hold"): void {
        this.obligations.materialization ??= reason;
    }

    holdForce(): void {
        this.obligations.force ??= "force";
    }

    holdHistory(): void {
        this.obligations.history ??= "history_refresh";
    }

    settle(materializationPending: boolean, forceUnspent: boolean, historyPending = false): void {
        if (!materializationPending) delete this.obligations.materialization;
        if (!forceUnspent) delete this.obligations.force;
        if (!historyPending) delete this.obligations.history;
    }

    get pending(): boolean {
        return Object.keys(this.obligations).length > 0;
    }
}
