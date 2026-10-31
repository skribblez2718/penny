import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../dist/canonical-json.js";
import { ComfyHttpClient, type ComfyClientLimitsV1 } from "../dist/comfy/client.js";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const LIMITS: ComfyClientLimitsV1 = {
  max_request_bytes: 65_536,
  max_readiness_bytes: 65_536,
  max_inventory_bytes: 65_536,
  max_history_bytes: 65_536,
  max_image_bytes: 1_048_576,
  max_upload_bytes: 1_048_576,
  max_video_bytes: 1_048_576,
  connect_timeout_ms: 1_000,
  read_timeout_ms: 1_000,
};

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  return address.port;
}

function json(response: ServerResponse, value: unknown): void {
  const body = canonicalJson(value);
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value: unknown = chunk;
    if (typeof value === "string" || value instanceof Uint8Array) {
      chunks.push(Buffer.from(value));
    } else {
      throw new Error("HTTP test body emitted a non-byte chunk");
    }
  }
  return Buffer.concat(chunks);
}

describe("generic bounded Comfy media client", () => {
  it("uploads one deterministic PNG locator through multipart and retrieves it by exact descriptor", async () => {
    const png = Buffer.from([137, 80, 78, 71, 1, 2, 3, 4]);
    const port = await listen((request, response) => {
      if (request.url === "/upload/image") {
        void body(request).then((received) => {
          expect(request.headers["content-type"]).toContain("multipart/form-data; boundary=penny-");
          expect(received.includes(png)).toBe(true);
          expect(received.toString("latin1")).toContain('name="overwrite"\r\n\r\nfalse');
          json(response, {
            name: "digest.png",
            subfolder: "penny/videogen",
            type: "input",
          });
        });
      } else if (request.url?.startsWith("/view?")) {
        expect(request.url).toContain("filename=digest.png");
        expect(request.url).toContain("subfolder=penny%2Fvideogen");
        expect(request.url).toContain("type=input");
        response.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.byteLength });
        response.end(png);
      } else response.writeHead(404).end();
    });
    const client = new ComfyHttpClient({ scheme: "http", host: "127.0.0.1", port }, LIMITS);
    const descriptor = await client.uploadImage({
      bytes: png,
      filename: "digest.png",
      subfolder: "penny/videogen",
      signal: new AbortController().signal,
    });
    expect(descriptor).toEqual({
      filename: "digest.png",
      subfolder: "penny/videogen",
      type: "input",
    });
    const fetched = await client.fetchMedia({
      media: descriptor,
      max_bytes: 1_048_576,
      accept: "image/png",
      signal: new AbortController().signal,
    });
    expect(fetched).toMatchObject({ status: 200, media_type: "image/png", bytes: png });
  });

  it("quarantines renamed or malformed successful upload responses", async () => {
    for (const responseValue of [
      { name: "renamed.png", subfolder: "penny/videogen", type: "input" },
      { name: "digest.png", subfolder: "../escape", type: "input" },
      { name: "digest.png", subfolder: "penny/videogen", type: "input", extra: true },
    ]) {
      const port = await listen((request, response) => {
        request.resume();
        json(response, responseValue);
      });
      const client = new ComfyHttpClient({ scheme: "http", host: "127.0.0.1", port }, LIMITS);
      await expect(
        client.uploadImage({
          bytes: Buffer.from([1]),
          filename: "digest.png",
          subfolder: "penny/videogen",
          signal: new AbortController().signal,
        })
      ).rejects.toMatchObject({ submission_disposition: "unknown" });
    }
  });

  it("rejects a history body keyed to a different prompt ID", async () => {
    const port = await listen((_request, response) => {
      json(response, {
        "prompt-wrong": {
          status: { completed: true, status_str: "success" },
          outputs: {},
        },
      });
    });
    const client = new ComfyHttpClient({ scheme: "http", host: "127.0.0.1", port }, LIMITS);
    await expect(
      client.historyMedia({
        prompt_id: "prompt-exact",
        output_node_id: "7",
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: "BACKEND_RESPONSE_INVALID" });
  });

  it("uses the exact prompt ID for targeted interrupt", async () => {
    let received: unknown;
    const port = await listen((request, response) => {
      void body(request).then((bytes) => {
        received = JSON.parse(bytes.toString("utf8"));
        json(response, {});
      });
    });
    const client = new ComfyHttpClient({ scheme: "http", host: "127.0.0.1", port }, LIMITS);
    await client.interrupt({
      prompt_id: "prompt-exact-1",
      signal: new AbortController().signal,
    });
    expect(received).toEqual({ prompt_id: "prompt-exact-1" });
  });
});
