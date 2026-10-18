import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { cloudCodeUserAgent } from "./cloud-code";
import { cloudCodeFetch } from "./cloud-code-http";

test("Cloud Code uses exact native HTTP/1.1 header order and decodes gzipped errors", async () => {
    let captured:
        | { headers: string[]; version: string; url: string; method: string; body: string }
        | undefined;
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        captured = {
            headers: request.rawHeaders,
            version: request.httpVersion,
            url: request.url ?? "",
            method: request.method ?? "",
            body: Buffer.concat(chunks).toString(),
        };
        response.writeHead(403, { "content-type": "application/json", "content-encoding": "gzip" });
        response.end(gzipSync('{"error":{"message":"model disabled"}}'));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no loopback port");
    const url = new URL(
        `http://127.0.0.1:${address.port}/v1internal:streamGenerateContent?alt=sse`,
    );
    const body = '{"request":"日"}';
    try {
        const response = await cloudCodeFetch(
            url,
            body,
            "fake-cloud-code-token",
            AbortSignal.timeout(5000),
        );
        expect(response.status).toBe(403);
        expect(await response.text()).toBe('{"error":{"message":"model disabled"}}');
        expect(captured).toEqual({
            headers: [
                "Host",
                url.host,
                "User-Agent",
                cloudCodeUserAgent(),
                "Content-Length",
                String(Buffer.byteLength(body)),
                "Authorization",
                "Bearer fake-cloud-code-token",
                "Content-Type",
                "application/json",
                "Accept-Encoding",
                "gzip",
            ],
            version: "1.1",
            url: "/v1internal:streamGenerateContent?alt=sse",
            method: "POST",
            body,
        });
    } finally {
        const closed = new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeAllConnections();
        await closed;
    }
});
