import { afterEach, expect, test } from "bun:test";
import {
  archiveMemory,
  bulkArchiveMemories,
  bulkUpdateMemoryStatus,
  getMemories,
  updateMemoryCategory,
  updateMemoryContent,
  updateMemoryStatus,
} from "./api";

import type { Memory } from "./types";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    value: originalWindow,
    configurable: true,
    writable: true,
  });
  globalThis.fetch = originalFetch;
});

test("review every dashboard memory setter supplies displayed CAS and stable operation identity", async () => {
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true, writable: true });
  const fixtureRows: Memory[] = [7, 8].map((id) => ({
    id,
    revision: id === 7 ? 17 : 23,
    project_path: "git:displayed-api-fixture",
    category: "CONSTRAINTS",
    content: `Displayed rule ${id}.`,
    normalized_hash: `fixture-${id}`,
    source_session_id: null,
    source_type: "agent",
    seen_count: 1,
    retrieval_count: 0,
    first_seen_at: 1,
    created_at: 1,
    updated_at: 1,
    last_seen_at: 1,
    last_retrieved_at: null,
    status: "active",
    expires_at: null,
    verification_status: "unverified",
    verified_at: null,
    superseded_by_memory_id: null,
    merged_from: null,
    metadata_json: null,
    importance: 50,
    scope: "project",
    shareable: false,
    has_embedding: false,
  }));
  const requests: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    if (request.cmd === "get_memories")
      return new Response(JSON.stringify(fixtureRows), { status: 200 });
    requests.push(request);
    return new Response("null", { status: 200 });
  }) as typeof fetch;
  const displayed = await getMemories();
  const single = {
    memoryId: displayed[0]!.id,
    projectPath: displayed[0]!.project_path,
    expectedRevision: displayed[0]!.revision,
    operationId: "displayed-single-write",
  };
  const bulk = {
    projectPath: displayed[0]!.project_path,
    memoryIds: displayed.map((row) => row.id),
    expectedRevisions: displayed.map((row) => ({ memoryId: row.id, revision: row.revision })),
    operationId: "displayed-bulk-write",
  };
  await updateMemoryStatus({ ...single, operationId: "status" }, "permanent");
  await updateMemoryCategory({ ...single, operationId: "category" }, "CONSTRAINTS");
  await updateMemoryContent({ ...single, operationId: "content" }, "New content.");
  await archiveMemory({ ...single, operationId: "archive" });
  await bulkUpdateMemoryStatus({ ...bulk, operationId: "bulk-status" }, "archived");
  await bulkArchiveMemories({ ...bulk, operationId: "bulk-archive" });
  expect(requests).toHaveLength(6);
  // Inspect actual outgoing payloads rather than an imitation of the API wrapper.
  expect(
    requests.map(({ cmd, args }) => ({
      cmd,
      projectPath: typeof args.projectPath,
      operationId: typeof args.operationId,
      displayedCAS: cmd.startsWith("bulk_")
        ? Array.isArray(args.expectedRevisions)
        : Number.isSafeInteger(args.expectedRevision),
    })),
  ).toEqual(
    requests.map(({ cmd }) => ({
      cmd,
      projectPath: "string",
      operationId: "string",
      displayedCAS: true,
    })),
  );
});
