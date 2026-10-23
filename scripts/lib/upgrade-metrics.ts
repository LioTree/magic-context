import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

export function databaseSizes(path: string): number[] {
    return [path, `${path}-wal`].map((p) => existsSync(p) ? statSync(p).size : 0);
}

export function resetPeak(): void {
    writeFileSync("/proc/self/clear_refs", "5");
}

export function peakKiB(): number {
    return Number(readFileSync("/proc/self/status", "utf8").match(/VmHWM:\s+(\d+)/)?.[1]);
}
