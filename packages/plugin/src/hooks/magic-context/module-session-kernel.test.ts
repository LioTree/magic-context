import { expect, mock, test } from "bun:test";
import { createModuleSessionKernel, rustWrapupHistorianFields } from "./module-session-kernel";

test("session state starts cold and exposes an isolated ordinal map", () => {
    const kernel = createModuleSessionKernel({ moduleClient: { call: async () => ({}) } });
    const state = kernel.getState("one");
    expect(state).toMatchObject({
        moduleGeneration: 0,
        seedPassPending: true,
        ordinalMemoAnchor: null,
        ordinalMemoResetCause: "cold",
    });
    state.idOrdinalMemo.set("m1", 1);
    expect(kernel.getState("one").idOrdinalMemo.size).toBe(0);
    kernel.invalidateWireState("one");
    expect(kernel.getState("one").ordinalMemoVerifyPending).toBe(true);
    expect(kernel.getState("two").ordinalMemoVerifyPending).toBe(false);
    kernel.dispose();
    expect(kernel.getState("one").ordinalMemoVerifyPending).toBe(false);
    expect("run" in kernel).toBe(false);
});

test("deleting a session clears local state and closes its transport route", async () => {
    const deleteSession = mock(async () => {});
    const closeSession = mock(() => {});
    const kernel = createModuleSessionKernel({
        moduleClient: { call: async () => ({}), deleteSession, closeSession },
        projectRoot: "/isolated/project",
    });
    kernel.getState("one");
    kernel.invalidateWireState("one");
    await kernel.clearSession("one");
    expect(deleteSession).toHaveBeenCalledWith("one", "/isolated/project");
    expect(closeSession).toHaveBeenCalledWith("one");
    expect(kernel.getState("one").ordinalMemoVerifyPending).toBe(false);
});

test("a pending deletion clears state recreated while its module call waits", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
        release = resolve;
    });
    const closeSession = mock(() => {});
    const kernel = createModuleSessionKernel({
        moduleClient: { call: async () => ({}), deleteSession: () => pending, closeSession },
        projectRoot: "/isolated/project",
    });
    const clearing = kernel.clearSession("one");
    kernel.getState("one");
    kernel.invalidateWireState("one");
    release();
    await clearing;
    expect(kernel.getState("one").ordinalMemoVerifyPending).toBe(false);
    expect(closeSession).toHaveBeenCalledWith("one");
});

test("module deletion errors propagate but still clear state and close the route", async () => {
    const closeSession = mock(() => {});
    const kernel = createModuleSessionKernel({
        moduleClient: {
            call: async () => ({}),
            deleteSession: async () => {
                throw new Error("module unavailable");
            },
            closeSession,
        },
        projectRoot: "/isolated/project",
    });
    kernel.getState("one");
    kernel.invalidateWireState("one");
    await expect(kernel.clearSession("one")).rejects.toThrow("module unavailable");
    expect(closeSession).toHaveBeenCalledWith("one");
    expect(kernel.getState("one").ordinalMemoVerifyPending).toBe(false);
});

test("wrapup uses current historian chain, first variant and optional output cap", () => {
    const result = rustWrapupHistorianFields({
        historianModel: { model: "test/primary", qualifier: "high" },
        fallbackModels: [{ model: "test/primary", qualifier: "low" }, "test/fallback"],
        timeoutMs: 123,
        maxOutputTokens: 456,
    });
    expect(result.historian_model_chain).toEqual(["test/primary", "test/fallback"]);
    expect(result.historian_model_variants).toEqual({ "test/primary": "high" });
    expect(result.historian_timeout_ms).toBe(123);
    expect(result.historian_max_output_tokens).toBe(456);
    expect(rustWrapupHistorianFields({ timeoutMs: 789 })).not.toHaveProperty(
        "historian_max_output_tokens",
    );
});
