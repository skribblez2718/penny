import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  HostOperationSimulatedCrashError,
  isCanonicalHostOperationExecutionContextV1,
} from "../dist/host-operations/owner.js";
import { requireValue } from "./helpers/narrowing.js";
import { syntheticVideogenInventory } from "./helpers/videogen-fixtures.js";
import { RenderSafetyFixture } from "./videogen-render-safety-fixtures.js";

const video = readFileSync(new URL("./fixtures/videogen/tiny-h264.mp4", import.meta.url));
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    );
  }
});
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
  if (address === null || typeof address === "string")
    throw new Error("local test server port absent");
  return address.port;
}
function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" }).end(canonicalJson(value));
}
function history(response: ServerResponse, filename = "clip.mp4"): void {
  json(response, {
    "owned-render": {
      status: { completed: true, status_str: "success" },
      outputs: {
        "7": { images: [{ filename, subfolder: "", type: "output" }] },
      },
    },
  });
}

describe("render safety through the canonical owner and actual shared-worker lease", () => {
  it.each(["matching", "swapped", "deleted"] as const)(
    "orders the %s readback at the submission cliff under the actual fence",
    async (state) => {
      const selected: { fixture?: RenderSafetyFixture } = {};
      const paths: string[] = [];
      const phases: string[] = [];
      const port = await listen((request, response) => {
        const f = requireValue(selected.fixture, "native fixture");
        const url = request.url ?? "";
        paths.push(url);
        if (url === "/system_stats") json(response, { ready: true });
        else if (url === "/object_info") json(response, syntheticVideogenInventory());
        else if (
          url.startsWith("/view?") &&
          new URL(url, "http://127.0.0.1").searchParams.get("type") === "input"
        ) {
          expect(
            isCanonicalHostOperationExecutionContextV1(
              requireValue(f.observedContext, "canonical context")
            )
          ).toBe(true);
          const worker = f.leases.inspect(f.backendKey);
          if (worker.state !== "active")
            throw new Error("readback lacks actual shared-worker lease");
          phases.push(worker.active.phase);
          expect(f.record().lifecycle).toBe("submitting");
          expect(worker.active.lease).toEqual(f.record().lease);
          expect(url).toBe(
            `/view?filename=${sha256(f.png)}.png&subfolder=penny%2Fvideogen&type=input`
          );
          if (state === "deleted") response.writeHead(404).end();
          else
            response
              .writeHead(200, { "Content-Type": "image/png" })
              .end(state === "swapped" ? Buffer.alloc(f.png.byteLength, 2) : f.png);
        } else if (url === "/prompt") {
          request.resume();
          json(response, { prompt_id: "owned-render", number: 1, node_errors: {} });
        } else if (url === "/history/owned-render") history(response);
        else if (url.startsWith("/view?"))
          response.writeHead(200, { "Content-Type": "video/mp4" }).end(video);
        else response.writeHead(404).end();
      });
      using f = new RenderSafetyFixture(port);
      selected.fixture = f;
      const runtime = await f.runtime();
      await runtime.dispatch(f.engine, f.directive);
      const record = f.record();
      expect(phases).toEqual(["submission_guarded"]);
      expect(paths.filter((entry) => entry === "/upload/image")).toHaveLength(0);
      if (state === "matching") {
        expect(paths.slice(0, 4)).toEqual([
          "/system_stats",
          "/object_info",
          `/view?filename=${sha256(f.png)}.png&subfolder=penny%2Fvideogen&type=input`,
          "/prompt",
        ]);
        expect(record.disposition).toMatchObject({
          outcome: "completed",
          remote_disposition: "proven_terminal",
        });
        expect(record.lifecycle).toBe("consumed");
      } else {
        expect(paths.includes("/prompt")).toBe(false);
        expect(record.disposition).toMatchObject({
          outcome: "failed",
          remote_disposition: "proven_not_accepted",
          retryable: false,
        });
      }
      expect(f.leases.inspect(f.backendKey)).toEqual({ state: "free" });
    }
  );

  it.each(["after_remote_checkpoint", "after_fetch"] as const)(
    "adopts accepted I2V at %s without any new upload/readback/prompt",
    async (point) => {
      const selected: { fixture?: RenderSafetyFixture } = {};
      let recovering = false;
      const paths: string[] = [];
      const port = await listen((request, response) => {
        const f = requireValue(selected.fixture, "fixture");
        const url = request.url ?? "";
        paths.push(url);
        if (url === "/system_stats") json(response, { ready: true });
        else if (url === "/object_info") json(response, syntheticVideogenInventory());
        else if (url === "/prompt") {
          request.resume();
          json(response, { prompt_id: "owned-render", number: 1, node_errors: {} });
        } else if (url === "/history/owned-render") history(response);
        else if (url.startsWith("/view?")) {
          const isInput = new URL(url, "http://127.0.0.1").searchParams.get("type") === "input";
          if (isInput && recovering)
            response.writeHead(404).end(); // Input removal after acceptance must not cause a reupload/resubmit.
          else
            response
              .writeHead(200, { "Content-Type": isInput ? "image/png" : "video/mp4" })
              .end(isInput ? f.png : video);
        } else response.writeHead(404).end();
      });
      using f = new RenderSafetyFixture(port);
      selected.fixture = f;
      const first = await f.runtime((candidate) => {
        if (candidate === point) throw new HostOperationSimulatedCrashError(candidate);
      });
      await expect(first.dispatch(f.engine, f.directive)).rejects.toBeInstanceOf(
        HostOperationSimulatedCrashError
      );
      expect(f.record().lifecycle).toBe(point === "after_fetch" ? "fetched" : "submitted");
      recovering = true;
      paths.length = 0;
      await (await f.runtime()).dispatch(f.engine, f.directive);
      expect(f.record().disposition?.outcome).toBe("completed");
      const settled = f.record();
      await (await f.runtime()).dispatch(f.engine, f.directive);
      expect(f.record()).toEqual(settled);
      expect(paths).toEqual([
        "/history/owned-render",
        "/view?filename=clip.mp4&subfolder=&type=output",
      ]);
      expect(f.leases.inspect(f.backendKey)).toEqual({ state: "free" });
    }
  );

  it.each(["corrupt-cache", "changed-descriptor", "missing-history"] as const)(
    "refuses fetched recovery with %s without repeating accepted work",
    async (state) => {
      const selected: { fixture?: RenderSafetyFixture } = {};
      let recovering = false;
      let prompts = 0;
      let inputReads = 0;
      const port = await listen((request, response) => {
        const f = requireValue(selected.fixture, "fixture");
        const url = request.url ?? "";
        if (url === "/system_stats") json(response, { ready: true });
        else if (url === "/object_info") json(response, syntheticVideogenInventory());
        else if (url === "/prompt") {
          prompts += 1;
          request.resume();
          json(response, { prompt_id: "owned-render", number: 1, node_errors: {} });
        } else if (url === "/history/owned-render") {
          if (recovering && state === "missing-history") json(response, {});
          else
            history(
              response,
              recovering && state === "changed-descriptor" ? "different.mp4" : "clip.mp4"
            );
        } else if (url.startsWith("/view?")) {
          const query = new URL(url, "http://127.0.0.1").searchParams;
          if (query.get("type") === "input") {
            inputReads += 1;
            response.writeHead(200, { "Content-Type": "image/png" }).end(f.png);
          } else
            response
              .writeHead(200, { "Content-Type": "video/mp4" })
              .end(
                query.get("filename") === "different.mp4"
                  ? Buffer.from("different remote bytes")
                  : video
              );
        } else response.writeHead(404).end();
      });
      using f = new RenderSafetyFixture(port);
      selected.fixture = f;
      const first = await f.runtime((point) => {
        if (point === "after_fetch") throw new HostOperationSimulatedCrashError(point);
      });
      await expect(first.dispatch(f.engine, f.directive)).rejects.toBeInstanceOf(
        HostOperationSimulatedCrashError
      );
      if (state === "corrupt-cache")
        writeFileSync(path.join(f.root, "cache", `${f.directive.request_sha256}.json`), "{}", {
          mode: 0o600,
        });
      recovering = true;
      await (await f.runtime()).dispatch(f.engine, f.directive);
      expect(f.record().disposition?.outcome).not.toBe("completed");
      expect(f.record().output_artifacts).toHaveLength(0);
      expect(prompts).toBe(1);
      expect(inputReads).toBe(1);
    }
  );

  it.each(["terminal", "missing"] as const)(
    "owner cancellation without qualification observes %s history and never interrupts",
    async (state) => {
      const controller = new AbortController();
      let histories = 0;
      let interrupts = 0;
      const port = await listen((request, response) => {
        if (request.url === "/system_stats") json(response, { ready: true });
        else if (request.url === "/object_info") json(response, syntheticVideogenInventory());
        else if (request.url === "/prompt") {
          request.resume();
          json(response, { prompt_id: "owned-render", number: 1, node_errors: {} });
        } else if (request.url === "/history/owned-render") {
          histories += 1;
          if (histories === 1) {
            controller.abort(new Error("fixture cancel"));
            response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
          } else
            json(
              response,
              state === "terminal"
                ? {
                    "owned-render": {
                      status: { completed: true, status_str: "error" },
                      outputs: {},
                    },
                  }
                : {}
            );
        } else if (request.url === "/interrupt") {
          interrupts += 1;
          request.resume();
          json(response, {});
        } else response.writeHead(404).end();
      });
      using f = new RenderSafetyFixture(port, "t2v");
      await (await f.runtime()).dispatch(f.engine, f.directive, controller.signal);
      expect(interrupts).toBe(0);
      expect(histories).toBeGreaterThanOrEqual(2);
      expect(f.record().disposition).toMatchObject(
        state === "terminal"
          ? {
              outcome: "cancelled",
              remote_disposition: "proven_terminal",
              lease_disposition: "released",
            }
          : {
              outcome: "cancelled",
              remote_disposition: "may_continue",
              lease_disposition: "quarantined",
            }
      );
      expect(f.leases.inspect(f.backendKey).state).toBe(
        state === "terminal" ? "free" : "quarantined"
      );
    }
  );

  it("quarantines a 2xx ambiguous prompt response, with no guessed target, interrupt or resubmit", async () => {
    const selected: { fixture?: RenderSafetyFixture } = {};
    const paths: string[] = [];
    const port = await listen((request, response) => {
      const f = requireValue(selected.fixture, "fixture");
      const url = request.url ?? "";
      paths.push(url);
      if (url === "/system_stats") json(response, { ready: true });
      else if (url === "/object_info") json(response, syntheticVideogenInventory());
      else if (url.startsWith("/view?"))
        response.writeHead(200, { "Content-Type": "image/png" }).end(f.png);
      else if (url === "/prompt") {
        request.resume();
        json(response, { accepted: true });
      } else response.writeHead(404).end();
    });
    using f = new RenderSafetyFixture(port);
    selected.fixture = f;
    await (await f.runtime()).dispatch(f.engine, f.directive);
    const record = f.record();
    expect(record.disposition).toMatchObject({
      outcome: "remote_unknown",
      remote_disposition: "unknown_acceptance",
      lease_disposition: "quarantined",
    });
    await (await f.runtime()).dispatch(f.engine, f.directive);
    expect(f.record()).toEqual(record);
    expect(paths.filter((url) => url === "/prompt")).toHaveLength(1);
    expect(
      paths.some(
        (url) => url === "/interrupt" || url.startsWith("/history/") || url === "/upload/image"
      )
    ).toBe(false);
    expect(f.leases.inspect(f.backendKey).state).toBe("quarantined");
  });
});
