import { createInterface } from "node:readline";

/** Let the driver alternate real passes without rebuilding either session. */
export async function measuredPassSchedule(args: {
    warm: () => Promise<unknown>;
    defer: () => Promise<unknown>;
    busting: () => Promise<unknown>;
    passes: number;
}): Promise<void> {
    await args.warm();
    if (process.env.HOLD_DRIVER === "1") {
        console.log("HOLD_READY");
        const commands = createInterface({ input: process.stdin, terminal: false });
        for await (const line of commands) {
            if (line === "stop") break;
            if (line !== "defer" && line !== "busting")
                throw new Error(`Invalid hold command: ${line}`);
            const row = await args[line]();
            console.log(`HOLD_RESULT ${JSON.stringify(row)}`);
        }
        commands.close();
    } else {
        for (let i = 0; i < args.passes; i++) await args.defer();
        for (let i = 0; i < args.passes; i++) await args.busting();
    }
}
