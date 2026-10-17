import { Database } from "../../../packages/plugin/src/shared/sqlite";
import {
    acquireLeaseWithAcquisition,
    leaseOwnershipMatches,
    releaseLease,
} from "../../../packages/plugin/src/features/magic-context/dreamer/lease";

const [path, action, key, holder] = process.argv.slice(2);
if (!path || !action || !key || !holder) {
    throw new Error("Expected database path, action, domain key and holder");
}
const db = new Database(path);
try {
    if (action === "acquire") {
        const lease = acquireLeaseWithAcquisition(db, holder, key);
        console.log(JSON.stringify({ lease, owns: lease !== null && leaseOwnershipMatches(db, holder, lease.generation, key) }));
    } else if (action === "release") {
        releaseLease(db, holder, key);
        console.log(JSON.stringify({ released: true }));
    } else {
        throw new Error(`Unknown lease fixture action: ${action}`);
    }
} finally {
    db.close();
}
