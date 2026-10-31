import { createServer, type ServerResponse } from "node:http";
import { canonicalJson } from "../../dist/canonical-json.js";
import { encodeCanonicalPng } from "../../dist/png-media.js";
import { syntheticInventory } from "./imagegen-fixtures.js";

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(canonicalJson(value));
}

/** Disposable transport fixture only; no installed backend or revision qualification. */
export async function imagegenRevisionHttpFixture() {
  const requests: string[] = [];
  const submissions: string[] = [];
  const png = encodeCanonicalPng({ width: 2, height: 2, rgba: new Uint8Array(16).fill(255) });
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === "/system_stats") json(response, { ready: true });
    else if (request.url === "/object_info") json(response, syntheticInventory());
    else if (request.url === "/prompt" && request.method === "POST") {
      const chunks: Buffer[] = [];
      let bytes = 0;
      request.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 65_536) request.destroy(new Error("fixture request exceeds limit"));
        else chunks.push(chunk);
      });
      request.on("end", () => {
        submissions.push(Buffer.concat(chunks).toString("utf8"));
        json(response, { prompt_id: "fixture-prompt", number: 1, node_errors: {} });
      });
    } else if (request.url === "/history/fixture-prompt") {
      json(response, {
        "fixture-prompt": {
          status: { completed: true, status_str: "success" },
          outputs: { "4": { images: [{ filename: "image.png", subfolder: "", type: "output" }] } },
        },
      });
    } else if (request.url?.startsWith("/view?")) {
      response.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.byteLength });
      response.end(png);
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture has no TCP port");
  return {
    port: address.port,
    requests,
    submissions,
    png,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}
