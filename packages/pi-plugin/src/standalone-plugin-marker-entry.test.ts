import { expect, test } from "bun:test";

test("loading the Pi and Oh My Pi entry registers Magic Context", async () => {
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
            import assert from "node:assert/strict";
            import packageMetadata from "../package.json";
            const markerSymbol = Symbol.for("cortexkit.standalone-plugins");
            const registry = new Map([["aft", { version: "1.2.3" }]]);
            globalThis[markerSymbol] = registry;
            await import("./index");
            assert.equal(globalThis[markerSymbol], registry);
            assert.deepEqual(registry.get("aft"), { version: "1.2.3" });
            assert.deepEqual(registry.get("magic-context"), { version: packageMetadata.version });
        `,
		],
		{ cwd: import.meta.dir, stdout: "pipe", stderr: "pipe", windowsHide: true },
	);
	const stderr = await new Response(child.stderr).text();
	expect(await child.exited, stderr).toBe(0);
});
