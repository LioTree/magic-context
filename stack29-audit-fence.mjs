import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "./packages/plugin/node_modules/typescript/lib/typescript.js";

console.log(`TypeScript ${ts.version}`);
const paths = [
    "packages/plugin/src/hooks/magic-context/signed-thinking-prefix-audit.test.ts",
    "packages/pi-plugin/src/signed-thinking-prefix-audit.test.ts",
];
function contract(source, name) {
    const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    const assertions = [];
    const tests = [];
    const visit = (node) => {
        if (ts.isCallExpression(node)) {
            const expression = node.expression.getText(file);
            if (/^expect\b/.test(expression)) assertions.push(node.getText(file));
            if (/^(it|test|describe)(\.|$)/.test(expression))
                tests.push([expression, node.arguments[0]?.getText(file), node.arguments[2]?.getText(file)]);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    if (!assertions.length || !tests.length) throw new Error(`empty contract inventory: ${name}`);
    return { assertions, tests };
}
for (const path of paths) {
    const before = contract(execFileSync("git", ["show", `f6da71695e206ece5d3847bbebd879d5dbb8eb10:${path}`], { encoding: "utf8" }), path);
    const after = contract(readFileSync(path, "utf8"), path);
    for (const key of ["assertions", "tests"])
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
            throw new Error(`strict audit ${key} changed: ${path}`);
    console.log(`AUDIT CONTRACT PASS ${path}: ${after.assertions.length} assertion calls; ${after.tests.length} test declarations/names/timeouts`);
}
