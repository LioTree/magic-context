import type { MessageLike } from "../../transform-operations";
import type { ProviderMethod } from "../provider-client";
import type { HookName, Subject } from "../record";

export type PiEntry = {
    id: string;
    parentId: string | null;
    message: {
        role: "user" | "assistant";
        content: { type: "text"; text: string }[];
        timestamp: number;
    };
};

export type Action =
    | { kind: "bootstrap" }
    | {
          kind: "serve";
          messages: MessageLike[];
          fault?: { hook: HookName; mode: "transport" | "timeout" };
      }
    | { kind: "retry"; mid: string }
    | { kind: "restart"; target: "relay" | "module" }
    | { kind: "status"; admission: "accept" | "structural" | "late" | "superseded"; rebuild?: true }
    | { kind: "pi"; entries: PiEntry[] }
    | { kind: "alias"; from: string; to: string }
    | { kind: "publish"; end_mid: string; ordinal: number; content: string };

export interface Exchange {
    method: ProviderMethod;
    /** Exact UTF-8 JSON, not a JSON object to be reserialized by the consumer. */
    request_bytes: string;
    answer_bytes: string;
    delivery: "answer" | "transport" | "timeout";
}

export interface Snapshot {
    served_bytes: string;
    lineage_id: string;
    served_through_ordinal: number;
    after_ordinal: number;
    unserved_subjects: Subject[];
    last_applied: { compaction_id: string; version: number };
    last_not_applied: { compaction_id: string; version: number; reason: string } | null;
    coverage: { end_mid: string; ordinal: number } | null;
    entries: {
        mid: string;
        ordinal: number;
        ingest_bytes: string;
        served_bytes: string;
        op_version: number;
        answers_bytes: string;
    }[];
    aliases: [string, string][];
}

export interface VectorStep {
    action: Action;
    exchanges: Exchange[];
    expected: Snapshot;
}
export interface VectorCase {
    id: string;
    steps: VectorStep[];
}
export interface VectorFile {
    schema: "mc-relay/v1";
    generator: {
        version: 1;
        source_base: string;
        oracle: string;
    };
    cases: VectorCase[];
}
