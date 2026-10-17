import { afterEach, expect, mock, test } from "bun:test";
import { installHostRunnerSchema } from "../../../features/magic-context/storage-host-runner";
import { Database } from "../../../shared/sqlite";
import type { MessageLike } from "../transform-operations";
import { createBridgeReceiptStore } from "./bridge-marker";
import { type BridgeReceipt, bridgeReceipt } from "./bridge-receipt";
import { createRecord } from "./record";

const dbs: Database[] = [];
afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
});
const message = (id: string, parts = [{ id: `${id}-text`, type: "text", text: id }]): MessageLike =>
    ({ info: { id, role: "user" }, parts }) as MessageLike;
const raw = [message("raw-end"), message("tail")];
const delivered = [message("summary"), raw[1]];
const target = { ordinal: 12, end_mid: "raw-end" };

function fixture(edit?: (r: BridgeReceipt) => void, complete = true) {
    const db = new Database(":memory:");
    dbs.push(db);
    installHostRunnerSchema(db);
    const record = createRecord({
        lineage_id: "lineage",
        plan: {},
        initial: {
            compaction_id: "applied",
            version: 4,
            range: { from: 0, to: 1 },
            replacement: delivered,
        },
    });
    record.view.coverage = { end_mid: "raw-end", ordinal: 12 };
    record.served_through_ordinal = 3;
    const store = createBridgeReceiptStore(db, "session", "opencode");
    const candidate = bridgeReceipt(record);
    edit?.(candidate);
    const pending = store.publish(candidate, delivered, 3);
    const receipt = complete
        ? store.complete(pending.request_id, { status: 200, cleanEnd: true })!
        : pending;
    const advance = (r = receipt, fit = true, view = delivered, source = raw) => {
        const apply = mock(() => "applied" as const);
        const outcome = store.advance(
            { receipt: r, target, raw: source, proveFit: () => ({ admissible: fit, view }) },
            apply,
        );
        return { outcome, apply };
    };
    return { db, store, pending, receipt, advance };
}

test("bridge receipt round-trips identity range raw coverage burns and rejection reason", () => {
    const f = fixture((r) => {
        r.unserved_subjects = [{ subject_mid: "tail", hook: "post_tool", subject_part: "result" }];
        r.last_not_applied = { compaction_id: "rejected", version: 5, reason: "late" };
    });
    expect(createBridgeReceiptStore(f.db, "session", "opencode").current()).toEqual(f.receipt);
    expect(f.receipt).toMatchObject({
        last_applied: { compaction_id: "applied", version: 4, range: { from: 0, to: 1 } },
        coverage: target,
    });
});

test("marker moves only on covering applied receipt in distinct raw coordinates", () => {
    const f = fixture();
    const { outcome, apply } = f.advance();
    expect(f.receipt.served_through_ordinal).toBe(3);
    expect(outcome).toEqual({ kind: "applied" });
    expect(apply).toHaveBeenCalledTimes(1);
});

test("durable covering applied receipt advances while delivery is pending", () => {
    const f = fixture(undefined, false);
    expect(f.receipt.delivery).toBe("pending");
    expect(f.advance().outcome).toEqual({ kind: "applied" });
    expect(f.store.current()?.served_through_ordinal).toBe(0);
    expect(f.store.current()?.delivery).toBe("pending");
});

test("pending-apply receipt cannot advance without durable applied identity", () => {
    const f = fixture((r) => {
        delete r.last_applied;
    }, false);
    const { outcome, apply } = f.advance();
    expect(outcome).toEqual({ kind: "deferred", reason: "no-current-applied-receipt" });
    expect(apply).not.toHaveBeenCalled();
});

test("unpersisted applied receipt cannot authorize a native write", () => {
    const f = fixture(undefined, false);
    f.db.prepare("DELETE FROM host_runner_state").run();
    const { outcome, apply } = f.advance();
    expect(outcome).toEqual({ kind: "deferred", reason: "no-current-applied-receipt" });
    expect(apply).not.toHaveBeenCalled();
});

test("scalar watermark without applied receipt defers without refusing", () => {
    const f = fixture((r) => {
        delete r.last_applied;
    });
    const { outcome, apply } = f.advance();
    expect(outcome.kind).toBe("deferred");
    expect(apply).not.toHaveBeenCalled();
    expect(delivered[1]).toEqual(raw[1]);
});

test("fit failure defers native marker without refusing delivered representation", () => {
    const f = fixture();
    const { outcome, apply } = f.advance(f.receipt, false);
    expect(outcome).toEqual({ kind: "deferred", reason: "fit-unproven" });
    expect(apply).not.toHaveBeenCalled();
});

test("orphaned tool pair defers native marker without refusing delivered representation", () => {
    const orphan = message("tail", [
        { id: "call", type: "toolCall", text: "", callID: "pair" } as any,
    ]);
    const f = fixture();
    const pending = f.store.publish({ ...f.receipt }, [delivered[0], orphan], 4);
    const receipt = f.store.complete(pending.request_id, { status: 200, cleanEnd: true })!;
    const { outcome, apply } = f.advance(receipt, true, [delivered[0], orphan], [raw[0], orphan]);
    expect(outcome).toEqual({ kind: "deferred", reason: "uncovered-parts-or-tool-pair" });
    expect(apply).not.toHaveBeenCalled();
});

test("uncovered message parts defer even if the enclosing ID remains", () => {
    const f = fixture();
    const { outcome, apply } = f.advance(f.receipt, true, delivered, [
        raw[0],
        message("tail", [
            ...raw[1].parts,
            { id: "uncovered", type: "text", text: "must remain" },
        ] as any),
    ]);
    expect(outcome.kind).toBe("deferred");
    expect(apply).not.toHaveBeenCalled();
});

for (const reason of ["stale", "not-applied", "coverage", "pending"] as const)
    test(`${reason} receipt defers without refusing`, () => {
        const f = fixture((r) => {
            if (reason === "not-applied")
                r.last_not_applied = { compaction_id: "later", version: 5, reason: "structural" };
            if (reason === "coverage") r.coverage = { end_mid: "elsewhere", ordinal: 11 };
        });
        const receipt =
            reason === "stale"
                ? { ...f.receipt, request_id: "old" }
                : reason === "pending"
                  ? f.pending
                  : f.receipt;
        const { outcome, apply } = f.advance(receipt);
        expect(outcome.kind).toBe("deferred");
        expect(apply).not.toHaveBeenCalled();
    });

test("only terminal 200 clean stream advances served watermark including refusal stops", () => {
    const f = fixture();
    const pending = f.store.publish(f.receipt, delivered, 9);
    expect(pending.served_through_ordinal).toBe(3);
    for (const response of [
        { status: 200, cleanEnd: false },
        { status: 500, cleanEnd: true },
    ])
        expect(f.store.complete(pending.request_id, response)?.served_through_ordinal).toBe(3);
    expect(f.store.complete("older", { status: 200, cleanEnd: true })).toBeUndefined();
    // stop_reason is intentionally not an admission gate: a clean refusal was delivered.
    expect(
        f.store.complete(pending.request_id, { status: 200, cleanEnd: true })
            ?.served_through_ordinal,
    ).toBe(9);
});

test("unknown cut remains distinct across restart and missing fit", () => {
    const f = fixture();
    const outcome = f.store.advance(
        {
            receipt: f.receipt,
            target,
            raw,
            proveFit: () => ({ admissible: true, view: delivered }),
        },
        () => {
            throw new Error("lost host commit result");
        },
    );
    expect(outcome.kind).toBe("unknown");
    const store = createBridgeReceiptStore(f.db, "session", "opencode");
    expect(
        store.advance(
            {
                receipt: f.receipt,
                target,
                raw,
                proveFit: () => ({ admissible: true, view: delivered }),
            },
            () => "deferred",
        ).kind,
    ).toBe("unknown");
    expect(
        store.advance(
            { receipt: f.receipt, target, raw, proveFit: () => ({ admissible: false }) },
            () => "applied",
        ).kind,
    ).toBe("unknown");
    expect(
        store.advance(
            {
                receipt: f.receipt,
                target,
                raw,
                proveFit: () => ({ admissible: true, view: delivered }),
            },
            () => "applied",
        ).kind,
    ).toBe("applied");
});

test("equal coverage ordinal with a different raw end identity defers", () => {
    const f = fixture((r) => {
        r.coverage = { ordinal: target.ordinal, end_mid: "different" };
    });
    const { outcome, apply } = f.advance();
    expect(outcome).toEqual({ kind: "deferred", reason: "coverage-does-not-cover-target" });
    expect(apply).not.toHaveBeenCalled();
});

test("new lineage publication does not borrow the previous clean frontier", () => {
    const f = fixture();
    const next = f.store.publish({ ...f.receipt, lineage_id: "fork" }, delivered, 9);
    expect(next.served_through_ordinal).toBe(0);
    expect(next.delivery).toBe("pending");
    expect(next.request_id).not.toBe(f.receipt.request_id);
});

test("admissible fit for different delivered bytes cannot authorize a native cut", () => {
    const f = fixture();
    const changed = [
        message("summary", [{ id: "summary-text", type: "text", text: "not the published bytes" }]),
        raw[1],
    ];
    const { outcome, apply } = f.advance(f.receipt, true, changed);
    expect(outcome).toEqual({ kind: "deferred", reason: "fit-unproven" });
    expect(apply).not.toHaveBeenCalled();
});

test("an empty applied range cannot authorize a native cut", () => {
    const f = fixture((r) => {
        if (r.last_applied) r.last_applied.range = { from: 3, to: 3 };
    });
    const { outcome, apply } = f.advance();
    expect(outcome).toEqual({ kind: "deferred", reason: "coverage-does-not-cover-target" });
    expect(apply).not.toHaveBeenCalled();
});
