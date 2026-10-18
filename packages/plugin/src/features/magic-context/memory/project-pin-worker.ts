import { parentPort } from "node:worker_threads";
import {
    setStoragePrivatePermissionEnforcement,
    writeStorageFileAtomicSync,
} from "../../../shared/storage-permissions";
import type { ProjectIdentityRecord } from "./project-identity-cache";

export interface PinWriteRequest {
    destination: string;
    record: ProjectIdentityRecord;
    privateStorage: boolean;
}

parentPort?.on("message", (request: PinWriteRequest) => {
    try {
        setStoragePrivatePermissionEnforcement(request.privateStorage);
        writeStorageFileAtomicSync(request.destination, JSON.stringify(request.record));
        parentPort?.postMessage({ ok: true });
    } catch (error) {
        parentPort?.postMessage({ ok: false, error: String(error) });
    }
});
