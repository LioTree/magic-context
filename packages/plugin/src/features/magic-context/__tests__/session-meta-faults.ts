import { spyOn } from "bun:test";
import type { Database } from "../../../shared/sqlite";
import * as cache from "../storage-session-cache";
import * as collections from "../storage-session-collections";

type Column = collections.SessionMetaCollection | cache.SessionRenderCacheColumn;
type Rule = {
    column: Column;
    name: string;
    sessionId?: string;
    error?: string;
    code?: string;
    ignore?: boolean;
    when?: (value: unknown, previous: unknown) => boolean;
    before?: (sessionId: string, value: unknown) => void;
    after?: (sessionId: string, value: unknown, previous: unknown) => void;
    active?: boolean;
};
const rules = new Map<Database, Rule[]>();
const wrapped = new WeakSet<Database>();
let restoreSpies: (() => void) | undefined;

function matching(
    db: Database,
    id: string,
    column: collections.SessionMetaCollection,
    value: unknown,
): Rule | undefined {
    return rules
        .get(db)
        ?.find(
            (rule) =>
                !rule.active &&
                rule.column === column &&
                (!rule.sessionId || rule.sessionId === id) &&
                (!rule.when ||
                    rule.when(value, collections.readSessionMetaCollection(db, id, column))),
        );
}
function fail(rule: Rule): void {
    if (rule.error)
        throw Object.assign(new Error(rule.error), {
            code: rule.code ?? "SQLITE_CONSTRAINT_TRIGGER",
        });
}

/** Faults target the logical storage boundary, not SQL for a retired table layout. */
function install(db: Database, rule: Rule): void {
    if (!restoreSpies) {
        const update = collections.updateSessionMetaCollection;
        const write = collections.writeSessionMetaCollection;
        const writeCache = cache.writeSessionRenderCache;
        const clearCache = cache.clearSessionRenderCache;
        let updateDepth = 0;
        const updateSpy = spyOn(collections, "updateSessionMetaCollection").mockImplementation(
            (connection, id, column, value, expected) => {
                const rule = matching(connection, id, column, value);
                if (rule?.ignore) return { changes: 0 };
                if (rule) fail(rule);
                if (rule?.before) {
                    rule.active = true;
                    try {
                        rule.before(id, value);
                    } finally {
                        rule.active = false;
                    }
                }
                const previous = rule?.after
                    ? collections.readSessionMetaCollection(connection, id, column)
                    : undefined;
                updateDepth++;
                try {
                    const result = update(connection, id, column, value, expected);
                    if (rule?.after && result.changes > 0) {
                        rule.active = true;
                        try {
                            rule.after(id, value, previous);
                        } finally {
                            rule.active = false;
                        }
                    }
                    return result;
                } finally {
                    updateDepth--;
                }
            },
        );
        const writeSpy = spyOn(collections, "writeSessionMetaCollection").mockImplementation(
            (connection, id, column, value) => {
                const rule =
                    updateDepth === 0 ? matching(connection, id, column, value) : undefined;
                if (rule?.ignore) return;
                if (rule) fail(rule);
                if (rule?.before) {
                    rule.active = true;
                    try {
                        rule.before(id, value);
                    } finally {
                        rule.active = false;
                    }
                }
                const previous = rule?.after
                    ? collections.readSessionMetaCollection(connection, id, column)
                    : undefined;
                write(connection, id, column, value);
                if (rule?.after) {
                    rule.active = true;
                    try {
                        rule.after(id, value, previous);
                    } finally {
                        rule.active = false;
                    }
                }
            },
        );
        const cacheSpy = spyOn(cache, "writeSessionRenderCache").mockImplementation(
            (connection, id, column, value) => {
                const rule = rules
                    .get(connection as Database)
                    ?.find(
                        (rule) =>
                            rule.column === column &&
                            !rule.active &&
                            (!rule.when ||
                                rule.when(
                                    value,
                                    cache.readSessionRenderCache(connection, id, column),
                                )),
                    );
                if (rule?.ignore) return;
                if (rule) fail(rule);
                writeCache(connection, id, column, value);
            },
        );
        const clearSpy = spyOn(cache, "clearSessionRenderCache").mockImplementation(
            (connection, id) => {
                for (const rule of rules.get(connection as Database) ?? []) {
                    if (
                        cache.isSessionRenderCacheColumn(rule.column) &&
                        (!rule.when ||
                            rule.when(
                                null,
                                cache.readSessionRenderCache(connection, id, rule.column),
                            ))
                    )
                        fail(rule);
                }
                clearCache(connection, id);
            },
        );
        restoreSpies = () => {
            updateSpy.mockRestore();
            writeSpy.mockRestore();
            cacheSpy.mockRestore();
            clearSpy.mockRestore();
            restoreSpies = undefined;
        };
    }
    rules.set(db, [...(rules.get(db) ?? []).filter((old) => old.name !== rule.name), rule]);
    if (!wrapped.has(db)) {
        db.prepare("SELECT 1").get();
        const close = db.close.bind(db) as (...args: unknown[]) => unknown;
        Object.defineProperty(db, "close", {
            configurable: true,
            writable: true,
            value: (...args: unknown[]) => {
                rules.delete(db);
                if (rules.size === 0) restoreSpies?.();
                return close(...args);
            },
        });
        wrapped.add(db);
    }
}

export function rejectSessionMetaCollectionWrites(
    db: Database,
    column: collections.SessionMetaCollection,
    name: string,
    options: {
        error?: string;
        code?: string;
        ignore?: boolean;
        sessionId?: string;
        when?: (value: unknown, previous: unknown) => boolean;
    },
): void {
    install(db, { column, name, ...options });
}
export function rejectSessionRenderCacheWrites(
    db: Database,
    column: cache.SessionRenderCacheColumn,
    name: string,
    options: {
        error: string;
        code?: string;
        when?: (value: unknown, previous: unknown) => boolean;
    },
): void {
    install(db, { column, name, ...options });
}
export function observeSessionMetaCollectionWrites(
    db: Database,
    column: collections.SessionMetaCollection,
    name: string,
    after: (sessionId: string, value: unknown, previous: unknown) => void,
): void {
    install(db, { column, name, after });
}
export function clearSessionMetaFixtureFault(db: Database, name: string): void {
    const next = (rules.get(db) ?? []).filter((rule) => rule.name !== name);
    if (next.length) rules.set(db, next);
    else rules.delete(db);
    if (rules.size === 0) restoreSpies?.();
}

export function interleaveSessionMetaCollectionWrite(
    db: Database,
    column: collections.SessionMetaCollection,
    name: string,
    before: (sessionId: string, value: unknown) => void,
): void {
    install(db, { column, name, before });
}
