import { spyOn } from "bun:test";
import { setHarness } from "@magic-context/core/shared/harness";
import * as contextHandler from "../context-handler";

// Match the Pi entrypoint so the final fit checks run in this child process.
setHarness("pi");

const register = contextHandler.registerPiContextHandler;
const retainedReads = 16;

// Retaining recent read results is already supported user configuration. Use
// that existing protection to exercise held-head replay without changing age.
spyOn(contextHandler, "registerPiContextHandler").mockImplementation(
	(pi, options) =>
		register(pi, {
			...options,
			protectedTools: { ...options.protectedTools, read: retainedReads },
		}),
);
