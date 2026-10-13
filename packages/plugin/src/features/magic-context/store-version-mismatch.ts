/** Advancing context.db affects every host; an independent bridge must opt into upgrades. */
export class StoreVersionMismatchError extends Error {
    readonly code = "store_version_mismatch";

    constructor(
        readonly found: number,
        readonly expected: number,
    ) {
        super(
            `Bridge context.db schema version ${found} differs from this build's supported version ${expected}. ` +
                (found > expected
                    ? "Update this build; newer stores cannot be downgraded."
                    : "Migration affects every host sharing this store; pass allowMigration: true explicitly to migrate."),
        );
        this.name = "StoreVersionMismatchError";
    }
}
