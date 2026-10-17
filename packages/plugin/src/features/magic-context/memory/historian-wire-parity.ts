import { readFileSync } from "node:fs";
import { parseTurnTwoEnvelope } from "./turn-two-envelope";

export interface HistorianWireCase {
    name: string;
    text: string;
    lengthCapped?: boolean;
    toolActivity?: boolean;
    expected: unknown;
}

export function parseHistorianWireCase(entry: HistorianWireCase) {
    const parsed = parseTurnTwoEnvelope(
        entry.text,
        entry.lengthCapped ?? false,
        entry.toolActivity,
    );
    return parsed.ok
        ? { ...parsed, decisions: [...parsed.decisions].sort(([a], [b]) => a - b) }
        : parsed;
}

export const historianWireCorpus: HistorianWireCase[] = JSON.parse(
    readFileSync(
        new URL(
            "../../../../../../crates/mc-module/testdata/historian-wire-corpus.json",
            import.meta.url,
        ),
        "utf8",
    ),
);

if (import.meta.main) console.log(JSON.stringify(historianWireCorpus.map(parseHistorianWireCase)));
