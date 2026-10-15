import { join } from "node:path";
import { getDataDir } from "./data-path";

/** Platform connection file used when resolved configuration has no subc block. */
export function getDefaultSubcConnectionFile(): string {
    return join(getDataDir(), "cortexkit", "run", "subc-connection.json");
}
