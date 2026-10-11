/** Import-safe host-runner surface. Storage-backed adapter initialization is explicit and lazy. */

export {
    type FallbackAdmissibility,
    type FallbackInputs,
    isFallbackAdmissible,
    recordProviderUsage,
} from "./hooks/magic-context/host-runner/fallback-admissibility";
export type { OpenCodeProviderOptions } from "./hooks/magic-context/host-runner/opencode-adapter";
export * as record from "./hooks/magic-context/host-runner/record";
export * from "./hooks/magic-context/host-runner/record";
export type { MessageLike } from "./hooks/magic-context/transform-operations";

/** Loading the adapter opts into its storage/runtime dependencies; importing this entry does not. */
export async function loadOpenCodeProviderAdapter() {
    return import("./hooks/magic-context/host-runner/opencode-adapter");
}
