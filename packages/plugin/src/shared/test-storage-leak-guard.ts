import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const retrievalCapture = resolve(
    import.meta.dir,
    "../../../../crates/mc-module/testdata/parity_retrieval/context.db",
);

export function findTestStorageLeaks(directory: string): string[] {
    const violations: string[] = [];
    const scan = (root: string): void => {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
            const path = join(root, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === "node_modules" || entry.name === ".git") continue;
                if (entry.name === "undefined") violations.push(path);
                scan(path);
            } else if (entry.isFile() && entry.name === "context.db") {
                // The checked-in retrieval capture is input data, not a leaked test store.
                // Exempt only that exact path; generated databases beside it still fail.
                if (resolve(path) !== retrievalCapture) violations.push(path);
            }
        }
    };
    scan(directory);
    return violations;
}
