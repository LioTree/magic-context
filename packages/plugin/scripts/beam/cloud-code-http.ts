import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { cloudCodeUserAgent } from "./cloud-code";

/** Raw HTTP/1.1 headers preserve the native CLI order; fetch is not used on this route. */
export function cloudCodeFetch(
    url: URL,
    body: string,
    token: string,
    signal: AbortSignal,
): Promise<Response> {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
        const outgoing = request(
            url,
            {
                method: "POST",
                headers: [
                    "Host",
                    url.host,
                    "User-Agent",
                    cloudCodeUserAgent(),
                    "Content-Length",
                    String(Buffer.byteLength(body)),
                    "Authorization",
                    `Bearer ${token}`,
                    "Content-Type",
                    "application/json",
                    "Accept-Encoding",
                    "gzip",
                ],
                setDefaultHeaders: false,
                setHost: false,
                signal,
            },
            (incoming) => {
                const source =
                    incoming.headers["content-encoding"] === "gzip"
                        ? incoming.pipe(createGunzip())
                        : incoming;
                if (source !== incoming) incoming.on("error", (error) => source.destroy(error));
                resolve(
                    new Response(Readable.toWeb(source) as ReadableStream<Uint8Array>, {
                        status: incoming.statusCode ?? 502,
                        headers: {
                            "content-type": incoming.headers["content-type"] ?? "application/json",
                        },
                    }),
                );
            },
        );
        outgoing.on("error", reject);
        outgoing.end(body);
    });
}
