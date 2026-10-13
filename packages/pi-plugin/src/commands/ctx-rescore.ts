import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseRescoreCommand } from "@magic-context/core/features/magic-context/rescore-service";
import type { createRescoreCommandController } from "@magic-context/core/hooks/magic-context/rescore-command";
import { rescoreCommandErrorText } from "@magic-context/core/hooks/magic-context/rescore-command";
import { createCtxStatusSender, resolveSessionId } from "./pi-command-utils";

export function registerCtxRescoreCommand(
	pi: ExtensionAPI,
	resolveController: (ctx: {
		cwd: string;
	}) => ReturnType<typeof createRescoreCommandController>,
): void {
	pi.registerCommand("ctx-rescore", {
		description:
			"Preview or control stored history rescoring; applies at the next natural rebuild",
		handler: async (args, ctx) => {
			const send = createCtxStatusSender(pi, ctx);
			try {
				parseRescoreCommand(args);
				const sessionId = resolveSessionId(ctx);
				if (!sessionId) throw new Error("No active Pi session is available.");
				const text = await resolveController(ctx)(sessionId, args);
				send({
					title: "/ctx-rescore",
					text,
					level: "info",
					rpcDisplay: "dialog",
				});
			} catch (error) {
				send({
					title: "/ctx-rescore",
					text: rescoreCommandErrorText(error),
					level: "error",
				});
			}
		},
	});
}
