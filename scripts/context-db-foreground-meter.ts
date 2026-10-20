type Cpu = { user: number; system: number };
type Timing = { calls: number; cpuMs: number; wallMs: number };
type Transaction = {
    id: number;
    begin: string;
    acquireMs: number;
    holdMs: number;
    cpuMs: number;
    end: string;
    phase: string;
    payloads: string[];
    writes: number;
    statements: Record<string, number>;
};
export const MOVED_COLLECTIONS = [
    "trailing_blank_decisions",
    "merged_reasoning_stripped_ids",
    "note_nudge_anchors",
    "auto_search_hint_decisions",
    "stale_reduce_stripped_ids",
    "stripped_placeholder_ids",
    "processed_image_stripped_ids",
    "memory_block_ids",
];
export const MOVED_CACHES = [
    "cached_m0_bytes",
    "cached_m1_bytes",
    "cached_m0_mural_data_url",
    "memory_block_cache",
    "cached_m0_upgrade_state",
];
const moved = [...MOVED_COLLECTIONS, ...MOVED_CACHES];
const cpu = (): number => {
    const value = (process as unknown as { threadCpuUsage(): Cpu }).threadCpuUsage();
    return (value.user + value.system) / 1000;
};
const empty = (): Timing => ({ calls: 0, cpuMs: 0, wallMs: 0 });
const quantile = (values: number[], q: number): number | null => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
};
export const distribution = (values: number[]) => ({
    n: values.length,
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
});

// Classify the outer verb so a read-only WITH ... SELECT is not counted as an implicit write.
function outerVerb(sql: string): string {
    let depth = 0;
    const tokens =
        /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\/|[()]|\b(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|PRAGMA|EXPLAIN)\b/gi;
    for (const match of sql.matchAll(tokens)) {
        const token = match[0];
        if (token === "(") depth++;
        else if (token === ")") depth--;
        else if (depth === 0 && /^[A-Za-z]+$/.test(token)) return token.toUpperCase();
    }
    return "";
}

/** Time application SQL calls without database-page snapshots or diagnostic SQL in measured passes. */
export function foregroundMeter(db: any) {
    let current: any = null;
    let phase = "handler";
    let collectionDepth = 0;
    let sequence = 0;
    let transaction: (Transaction & { startWall: number; startCpu: number }) | null = null;
    const records: any[] = [];
    const sqlIds = new Map<string, string>();
    const sqlText: Record<string, string> = {};
    const wrapped = new WeakSet<object>();
    const idFor = (sql: string) => {
        const canonical = sql.replace(/\s+/g, " ").trim();
        let id = sqlIds.get(canonical);
        if (!id) {
            id = `s${sqlIds.size}`;
            sqlIds.set(canonical, id);
            sqlText[id] = canonical;
        }
        return id;
    };
    const record = (kind: string, id: string, cpuMs: number, wallMs: number) => {
        for (const key of [kind, `${phase}:${kind}`]) {
            const total: Timing = (current.timing[key] ??= empty());
            total.calls++;
            total.cpuMs += cpuMs;
            total.wallMs += wallMs;
        }
        const entry = (current.statements[id] ??= { kind, ...empty() });
        entry.calls++;
        entry.cpuMs += cpuMs;
        entry.wallMs += wallMs;
    };
    const originalExec = db.exec.bind(db);
    db.exec = (sql: string) => {
        if (!current) return originalExec(sql);
        const begin = /^\s*BEGIN\s+(IMMEDIATE|EXCLUSIVE)\b/i.test(sql);
        const end = /^\s*(COMMIT|END|ROLLBACK)(?:\s+TRANSACTION)?\s*;?\s*$/i.test(sql);
        const wall = performance.now();
        const value = originalExec(sql);
        const after = performance.now();
        if (begin) {
            if (transaction) throw new Error("writer BEGIN nested without a savepoint");
            transaction = {
                id: ++sequence,
                begin: sql.trim(),
                acquireMs: after - wall,
                startWall: after,
                startCpu: cpu(),
                holdMs: 0,
                cpuMs: 0,
                end: "",
                phase,
                payloads: [],
                writes: 0,
                statements: {},
            };
        } else if (end && transaction) {
            transaction.holdMs = after - transaction.startWall;
            transaction.cpuMs = cpu() - transaction.startCpu;
            transaction.end = sql.trim();
            const { startWall: _wall, startCpu: _cpu, ...completed } = transaction;
            current.transactions.push(completed);
            transaction = null;
        }
        return value;
    };
    const wrap = (sql: string, statement: any) => {
        if (wrapped.has(statement)) return statement;
        wrapped.add(statement);
        const id = idFor(sql);
        const names = moved.filter((name) => sql.includes(name));
        const payloadTable = /\b(?:session_meta_chunks|session_render_cache|session_meta_collection_revisions)\b/.test(sql);
        const hasPayload =
            payloadTable ||
            (/\bsession_meta\b/.test(sql) &&
                (names.length > 0 || /SELECT\s+\*\s+FROM\s+session_meta\b/i.test(sql)));
        const verb = outerVerb(sql);
        const read = ["SELECT", "EXPLAIN", "PRAGMA"].includes(verb);
        const write = ["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(verb);
        const cas = hasPayload && /\bIS\s+\?/.test(sql);
        const chunkRows = /SELECT\s+chunk\s*,\s*body\s+FROM\s+session_meta_chunks/i.test(sql);
        const kind = chunkRows
            ? "chunkRows"
            : cas && read
              ? "casRead"
              : read && hasPayload
                ? "payloadRead"
                : write && hasPayload
                  ? "payloadWrite"
                  : read
                    ? "otherRead"
                    : "otherWrite";
        for (const method of ["run", "get", "all", "values"]) {
            if (typeof statement[method] !== "function") continue;
            const original = statement[method].bind(statement);
            Object.defineProperty(statement, method, {
                configurable: true,
                value: (...args: unknown[]) => {
                    if (!current) return original(...args);
                    const active = transaction;
                    const wall = performance.now(),
                        thread = cpu();
                    let result: any;
                    try {
                        result = original(...args);
                        return result;
                    } finally {
                        const usedCpu = cpu() - thread,
                            elapsed = performance.now() - wall;
                        record(collectionDepth > 0 && read ? "collectionSql" : kind, id, usedCpu, elapsed);
                        if (active) {
                            active.statements[id] = (active.statements[id] ?? 0) + 1;
                            if (write) active.writes++;
                            if (write && hasPayload)
                                for (const name of names.length
                                    ? names
                                    : [payloadTable ? "payload-table" : "session_meta"]) {
                                    if (!active.payloads.includes(name)) active.payloads.push(name);
                                }
                        } else if (write) {
                            current.autocommit.push({
                                id,
                                kind,
                                cpuMs: usedCpu,
                                wallMs: elapsed,
                                changes: result?.changes ?? null,
                            });
                        }
                    }
                },
            });
        }
        return statement;
    };
    for (const method of ["prepare", "query"]) {
        const original = db[method].bind(db);
        db[method] = (sql: string, ...args: unknown[]) => {
            const watched =
                current && (sql.includes("session_meta") || sql.includes("session_render_cache"));
            const wall = watched ? performance.now() : 0,
                thread = watched ? cpu() : 0;
            const statement = original(sql, ...args);
            if (watched)
                record("payloadPrepare", idFor(sql), cpu() - thread, performance.now() - wall);
            return wrap(sql, statement);
        };
    }
    return {
        records,
        sqlText,
        start(pass: number) {
            if (current || transaction) throw new Error("unfinished measured pass");
            current = {
                pass,
                ordinary: pass % 10 !== 0,
                timing: {},
                transactions: [],
                autocommit: [],
                statements: {},
                totalWallMs: 0,
                totalCpuMs: 0,
            };
            phase = "prelude";
        },
        handlerStart() {
            phase = "handler";
            return { wall: performance.now(), cpu: cpu() };
        },
        handlerEnd(start: { wall: number; cpu: number }) {
            current.totalWallMs = performance.now() - start.wall;
            current.totalCpuMs = cpu() - start.cpu;
            phase = "drain";
        },
        collectionAccess<T>(operation: () => T): T {
            if (!current || collectionDepth > 0) return operation();
            const wall=performance.now(),thread=cpu();
            collectionDepth++;
            try {return operation();}
            finally {
                collectionDepth--;
                record("collectionAccess","readSessionMetaCollection",cpu()-thread,performance.now()-wall);
            }
        },
        layout<T>(operation: () => T): T {
            if (!current) return operation();
            const wall = performance.now(),
                thread = cpu();
            try {
                return operation();
            } finally {
                record(
                    "layout",
                    "layoutSessionMetaBytes",
                    cpu() - thread,
                    performance.now() - wall,
                );
            }
        },
        stop() {
            if (transaction) throw new Error("writer transaction escaped measured pass");
            records.push(current);
            current = null;
        },
    };
}

export function summarizeForeground(meter: ReturnType<typeof foregroundMeter>) {
    const passes = meter.records.filter((record) => record.ordinary);
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    const timings: Record<string, unknown> = {};
    for (const key of new Set<string>(passes.flatMap((pass) => Object.keys(pass.timing)))) {
        timings[key] = Object.fromEntries(
            ["calls", "cpuMs", "wallMs"].map((field) => [
                field,
                distribution(passes.map((pass) => pass.timing[key]?.[field] ?? 0)),
            ]),
        );
    }
    const held = (pass: any) =>
        pass.transactions.filter((tx: Transaction) => tx.payloads.length > 0);
    return {
        ordinaryPasses: passes.length,
        timings,
        movedReadCpuMs: distribution(
            passes.map((pass) =>
                sum(
                    ["handler:payloadRead", "handler:casRead", "handler:chunkRows", "handler:collectionAccess"].map(
                        (key) => pass.timing[key]?.cpuMs ?? 0,
                    ),
                ),
            ),
        ),
        movedReadWallMs: distribution(
            passes.map((pass) =>
                sum(
                    ["handler:payloadRead", "handler:casRead", "handler:chunkRows", "handler:collectionAccess"].map(
                        (key) => pass.timing[key]?.wallMs ?? 0,
                    ),
                ),
            ),
        ),
        totalWallMs: distribution(passes.map((pass) => pass.totalWallMs)),
        totalCpuMs: distribution(passes.map((pass) => pass.totalCpuMs)),
        writeTransactions: distribution(passes.map((pass) => pass.transactions.length)),
        payloadWriteTransactions: distribution(passes.map((pass) => held(pass).length)),
        payloadHoldEachMs: distribution(
            passes.flatMap((pass) => held(pass).map((tx: Transaction) => tx.holdMs)),
        ),
        payloadHoldSumPerPassMs: distribution(
            passes.map((pass) => sum(held(pass).map((tx: Transaction) => tx.holdMs))),
        ),
        allHoldEachMs: distribution(
            passes.flatMap((pass) => pass.transactions.map((tx: Transaction) => tx.holdMs)),
        ),
        allHoldSumPerPassMs: distribution(
            passes.map((pass) => sum(pass.transactions.map((tx: Transaction) => tx.holdMs))),
        ),
        allHoldMaxPerPassMs: distribution(
            passes.map((pass) =>
                Math.max(0, ...pass.transactions.map((tx: Transaction) => tx.holdMs)),
            ),
        ),
        autocommitWrites: distribution(passes.map((pass) => pass.autocommit.length)),
        statementCount: distribution(
            passes.map((pass) =>
                sum(
                    Object.entries(pass.timing)
                        .filter(
                            ([key]) =>
                                !key.includes(":") && key !== "payloadPrepare" && key !== "layout" && key !== "collectionAccess",
                        )
                        .map(([, entry]: [string, any]) => entry.calls),
                ),
            ),
        ),
        payloadPrepareCount: distribution(
            passes.map((pass) => pass.timing.payloadPrepare?.calls ?? 0),
        ),
    };
}
