import type { Database as BunDatabase } from "bun:sqlite";
import {
    isSessionRenderCacheColumn,
    type SessionRenderCacheColumn,
    sessionRenderCacheValueSql,
    writeSessionRenderCache,
} from "../../plugin/src/features/magic-context/storage-session-cache";
import {
    type SessionMetaCollection,
    sessionMetaCollectionValueSql,
    writeSessionMetaCollection,
} from "../../plugin/src/features/magic-context/storage-session-collections";
import type { Database as PluginDatabase } from "../../plugin/src/shared/sqlite";

/**
 * Context-db migration 103 moved large, growing session values out of `session_meta`
 * columns into `session_render_cache` rows and `session_meta_chunks` rows. Tests and
 * diagnostic scripts read and write those values through the plugin's own accessors
 * here, so they never carry a second copy of the storage layout.
 */
export type MovedSessionMetaField = SessionRenderCacheColumn | SessionMetaCollection;

type AnyDatabase = BunDatabase | PluginDatabase;

// bun:sqlite exposes every method the plugin accessors call; only the declared types differ.
const asPluginDatabase = (db: AnyDatabase): PluginDatabase => db as unknown as PluginDatabase;

/**
 * An SQL expression for a moved field of the surrounding `FROM session_meta` row.
 *
 * Without `db` the expression reads the current layout, which is what a live plugin
 * always creates. Pass `db` when the database may predate migration 103 (old backups,
 * dumps): the accessors then inspect that database and read whichever layout it has.
 * The collection accessor remembers the layout per handle, so only pass `db` for a
 * handle opened after the schema exists.
 */
export function sessionMetaFieldValueSql(column: MovedSessionMetaField, db?: AnyDatabase): string {
    const plugin = db ? asPluginDatabase(db) : undefined;
    return isSessionRenderCacheColumn(column)
        ? sessionRenderCacheValueSql(column, plugin)
        : sessionMetaCollectionValueSql(column, plugin);
}

/** A select-list item `<value> AS <alias>`; see sessionMetaFieldValueSql for `db`. */
export function sessionMetaFieldSelect(
    column: MovedSessionMetaField,
    alias: string = column,
    db?: AnyDatabase,
): string {
    return `${sessionMetaFieldValueSql(column, db)} AS ${alias}`;
}

/** Read one moved field for a session; undefined when the session has no metadata row. */
export function readSessionMetaField(
    db: AnyDatabase,
    sessionId: string,
    column: MovedSessionMetaField,
    options: { detectLayout?: boolean } = {},
): unknown {
    const row = asPluginDatabase(db)
        .prepare(
            `SELECT ${sessionMetaFieldSelect(column, "value", options.detectLayout ? db : undefined)} FROM session_meta WHERE session_id = ?`,
        )
        .get(sessionId) as { value: unknown } | undefined;
    return row ? row.value : undefined;
}

/** Overwrite one moved field for a session, the way the plugin itself writes it. */
export function writeSessionMetaField(
    db: AnyDatabase,
    sessionId: string,
    column: MovedSessionMetaField,
    value: string | Uint8Array | null,
): void {
    const plugin = asPluginDatabase(db);
    if (isSessionRenderCacheColumn(column)) {
        writeSessionRenderCache(plugin, sessionId, column, value);
        return;
    }
    if (value instanceof Uint8Array) {
        throw new Error(`${column} holds text; refusing to write bytes`);
    }
    writeSessionMetaCollection(plugin, sessionId, column, value);
}
