import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryMcpClient } from "../../index.js";
import { TEST_TOKEN, testConfig } from "../fixtures.js";

interface SeenRequest {
  authorization?: string;
  path?: string;
  body?: Record<string, any>;
}

let closeServer: (() => Promise<void>) | undefined;
let endpoint = "";
let seen: SeenRequest[] = [];

beforeEach(async () => {
  seen = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      seen.push({
        authorization: request.headers.authorization,
        path: request.url,
        body,
      });
      const payload = {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                query: body.params.arguments.query,
                filters: {},
                total_before_filter: 1,
                results: [
                  {
                    drawer_id: "fixture-drawer",
                    text: "fixture content",
                    wing: "fixture",
                    room: "isolated",
                    similarity: 1,
                  },
                ],
              }),
            },
          ],
        },
      };
      const encoded = Buffer.from(JSON.stringify(payload));
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": encoded.length,
      });
      response.end(encoded);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind");
  endpoint = `http://127.0.0.1:${address.port}/mcp`;
  closeServer = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
});

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

describe("hermetic HTTP-only MemPalace adapter integration", () => {
  it("posts one authenticated tools/call to /mcp without any palace or Python process", async () => {
    const client = new MemoryMcpClient(testConfig({ endpoint }));
    const result = await client.call("search", { query: "fixture", limit: 1 });

    expect(result.payload.results).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/mcp");
    expect(seen[0]!.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(seen[0]!.body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: "mempalace_search",
        arguments: { query: "fixture", limit: 1 },
      },
    });
    expect(String(seen[0]!.body!.id)).toMatch(/^platform-memory-/);
  });
});
