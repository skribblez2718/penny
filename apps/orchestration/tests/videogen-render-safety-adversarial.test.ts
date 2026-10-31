import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import { HostOperationSimulatedCrashError } from "../dist/host-operations/owner.js";
import { FileHostOperationResultCache } from "../dist/host-operations/result-cache.js";
import { ComfyVideogenOperationAdapter } from "../dist/videogen/operation-owner.js";
import {
  decodeVideogenFetchedCache,
  encodeVideogenFetchedCache,
  isConcreteVideogenPromptCancellationAuthorityV1,
  VideogenPromptCancellationAuthorityV1,
} from "../dist/videogen/render-safety.js";
import { requireValue } from "./helpers/narrowing.js";
import { syntheticVideogenInventory } from "./helpers/videogen-fixtures.js";
import {
  RenderSafetyFixture,
  syntheticCancellationEvidence,
} from "./videogen-render-safety-fixtures.js";

const video = readFileSync(new URL("./fixtures/videogen/tiny-h264.mp4", import.meta.url));
const original = { filename: "clip.mp4", subfolder: "", type: "output" } as const;
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
  if (address === null || typeof address === "string") throw new Error("missing test port");
  return address.port;
}
function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" }).end(canonicalJson(value));
}
function terminal(
  response: ServerResponse,
  descriptor: unknown = original,
  prompt = "owned-render",
  node = "7"
): void {
  json(response, {
    [prompt]: {
      status: { completed: true, status_str: "success" },
      outputs: { [node]: { images: [descriptor] } },
    },
  });
}
function frame(header: unknown, bytes: Uint8Array, canonical = true): Uint8Array {
  const text = Buffer.from(canonicalJson(header) + (canonical ? "" : "\n"));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(text.byteLength);
  return Buffer.concat([prefix, text, bytes]);
}
function replaceCache(f: RenderSafetyFixture, bytes: Uint8Array): void {
  writeFileSync(
    path.join(f.root, "cache", `${f.directive.request_sha256}.json`),
    canonicalJson({
      schema_version: 1,
      request_sha256: f.directive.request_sha256,
      content_sha256: sha256(bytes),
      byte_length: bytes.byteLength,
      content_base64: Buffer.from(bytes).toString("base64"),
    }),
    { mode: 0o600 }
  );
}

// These are real owner/engine/store/lease crash-recovery tests; only local HTTP is synthetic.
describe("canonical render owner: durable original descriptor custody", () => {
  it.each([
    "filename",
    "subfolder",
    "type",
    "original-removed",
    "foreign-prompt",
    "changed-node",
  ] as const)(
    "rejects %s history drift BEFORE fetching, even when every new locator serves identical bytes",
    async (state) => {
      const selected: { fixture?: RenderSafetyFixture } = {};
      let recovering = false;
      const paths: string[] = [];
      const port = await listen((request, response) => {
        const f = requireValue(selected.fixture, "canonical fixture");
        const url = request.url ?? "";
        paths.push(url);
        if (url === "/system_stats") json(response, { ready: true });
        else if (url === "/object_info") json(response, syntheticVideogenInventory());
        else if (url === "/prompt") {
          request.resume();
          json(response, { prompt_id: "owned-render", number: 1, node_errors: {} });
        } else if (url === "/history/owned-render") {
          const descriptor = !recovering
            ? original
            : {
                ...original,
                ...(state === "filename" || state === "original-removed"
                  ? { filename: "identical-new.mp4" }
                  : {}),
                ...(state === "subfolder" ? { subfolder: "new/subfolder" } : {}),
                ...(state === "type" ? { type: "temp" } : {}),
              };
          terminal(
            response,
            descriptor,
            recovering && state === "foreign-prompt" ? "foreign-prompt" : "owned-render",
            recovering && state === "changed-node" ? "8" : "7"
          );
        } else if (url.startsWith("/view?")) {
          const query = new URL(url, "http://127.0.0.1").searchParams;
          if (query.get("type") === "input")
            response.writeHead(200, { "Content-Type": "image/png" }).end(f.png);
          else if (
            recovering &&
            state === "original-removed" &&
            query.get("filename") === original.filename
          )
            response.writeHead(404).end();
          else response.writeHead(200, { "Content-Type": "video/mp4" }).end(video);
        } else response.writeHead(404).end();
      });
      using f = new RenderSafetyFixture(port);
      selected.fixture = f;
      const runtime = await f.runtime((point) => {
        if (point === "after_fetch") throw new HostOperationSimulatedCrashError(point);
      });
      await expect(runtime.dispatch(f.engine, f.directive)).rejects.toBeInstanceOf(
        HostOperationSimulatedCrashError
      );
      const cache = requireValue(
        await (
          await FileHostOperationResultCache.openExisting(path.join(f.root, "cache"))
        ).read(f.directive.request_sha256),
        "cached envelope"
      );
      const decoded = decodeVideogenFetchedCache(cache.bytes, f.declaration.max_output_bytes);
      expect(decoded.header.remote_descriptor).toEqual(original);
      expect(decoded.header.operation_record_id).toBe(f.record().operation_record_id);
      expect(decoded.header.directive_sha256).toBe(sha256(canonicalJson(f.directive)));
      expect(decoded.header.request_sha256).toBe(f.directive.request_sha256);
      expect(decoded.header.prompt_id_sha256).toBe(sha256("owned-render"));
      expect(Buffer.from(decoded.video).equals(video)).toBe(true);
      expect(f.record().fetched).toMatchObject({
        content_sha256: sha256(cache.bytes),
        byte_length: cache.bytes.byteLength,
      });
      expect(cache.bytes.byteLength).toBeGreaterThan(video.byteLength);
      recovering = true;
      paths.length = 0;
      await (await f.runtime()).dispatch(f.engine, f.directive);
      expect(paths).toEqual(["/history/owned-render"]);
      expect(f.record().disposition?.outcome).not.toBe("completed");
      expect(f.record().output_artifacts).toHaveLength(0);
      expect(f.leases.inspect(f.backendKey).state).toBe("quarantined");
      const settled = f.record();
      await (await f.runtime()).dispatch(f.engine, f.directive);
      expect(f.record()).toEqual(settled);
      expect(paths).toEqual(["/history/owned-render"]);
    }
  );

  it.each([
    "legacy-bytes-only",
    "descriptor-absent",
    "noncanonical-header",
    "corrupt-inner-bytes",
    "changed-request",
    "changed-prompt",
    "changed-operation",
    "changed-directive",
  ] as const)(
    "quarantines %s cache without history, fetch, reupload or resubmit",
    async (state) => {
      const selected: { fixture?: RenderSafetyFixture } = {};
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
        } else if (url === "/history/owned-render") terminal(response);
        else if (url.startsWith("/view?")) {
          const input = new URL(url, "http://127.0.0.1").searchParams.get("type") === "input";
          response
            .writeHead(200, { "Content-Type": input ? "image/png" : "video/mp4" })
            .end(input ? f.png : video);
        } else response.writeHead(404).end();
      });
      using f = new RenderSafetyFixture(port);
      selected.fixture = f;
      await expect(
        (
          await f.runtime(
            (point) => {
              if (point === "after_fetch") throw new HostOperationSimulatedCrashError(point);
            },
            {},
            state === "legacy-bytes-only"
          )
        ).dispatch(f.engine, f.directive)
      ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
      const cache = requireValue(
        await (
          await FileHostOperationResultCache.openExisting(path.join(f.root, "cache"))
        ).read(f.directive.request_sha256),
        "cache"
      );
      if (state === "legacy-bytes-only") {
        expect(Buffer.from(cache.bytes).equals(video)).toBe(true);
        expect(f.record().fetched).toMatchObject({
          content_sha256: sha256(video),
          byte_length: video.byteLength,
        });
      } else {
        const decoded = decodeVideogenFetchedCache(cache.bytes, f.declaration.max_output_bytes);
        const header = {
          ...decoded.header,
          ...(state === "changed-request" ? { request_sha256: sha256("another request") } : {}),
          ...(state === "changed-prompt" ? { prompt_id_sha256: sha256("another prompt") } : {}),
          ...(state === "changed-operation" ? { operation_record_id: "foreign-operation" } : {}),
          ...(state === "changed-directive"
            ? { directive_sha256: sha256("another directive") }
            : {}),
        };
        replaceCache(
          f,
          frame(
            state === "descriptor-absent"
              ? Object.fromEntries(
                  Object.entries(header).filter(([key]) => key !== "remote_descriptor")
                )
              : header,
            state === "corrupt-inner-bytes" ? Buffer.alloc(video.byteLength, 7) : video,
            state !== "noncanonical-header"
          )
        );
      }
      paths.length = 0;
      await (await f.runtime()).dispatch(f.engine, f.directive);
      expect(paths).toEqual([]);
      expect(f.record().disposition).toMatchObject({
        outcome: "remote_unknown",
        remote_disposition: "may_continue",
        lease_disposition: "quarantined",
        retryable: false,
      });
      expect(f.record().output_artifacts).toHaveLength(0);
      expect(f.leases.inspect(f.backendKey).state).toBe("quarantined");
      const settled = f.record();
      await (await f.runtime()).dispatch(f.engine, f.directive);
      expect(f.record()).toEqual(settled);
      expect(paths).toEqual([]);
    }
  );

  it("conflicts on a changed request ref after acceptance rather than adopting or resubmitting", async () => {
    const paths: string[] = [];
    const port = await listen((request, response) => {
      const url = request.url ?? "";
      paths.push(url);
      if (url === "/system_stats") json(response, {});
      else if (url === "/object_info") json(response, syntheticVideogenInventory());
      else if (url === "/prompt") {
        request.resume();
        json(response, { prompt_id: "owned-render", number: 1, node_errors: {} });
      } else response.writeHead(404).end();
    });
    using f = new RenderSafetyFixture(port, "t2v");
    await expect(
      (
        await f.runtime((point) => {
          if (point === "after_remote_checkpoint")
            throw new HostOperationSimulatedCrashError(point);
        })
      ).dispatch(f.engine, f.directive)
    ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    const before = f.record();
    paths.length = 0;
    await expect(
      (await f.runtime()).dispatch(f.engine, {
        ...f.directive,
        request_ref: {
          ...f.directive.request_ref,
          artifact_id: `art_${sha256("foreign request")}`,
        },
      })
    ).rejects.toThrow();
    expect(f.record()).toEqual(before);
    expect(paths).toEqual([]);
  });
});

describe("concrete evidence identity is not live cancellation permission", () => {
  it("rejects prototype forgeries, proxy identity, subclasses, and own/prototype overrides", async () => {
    using f = new RenderSafetyFixture(1, "t2v"); // No dispatch or backend connection.
    const resolved = f.registry.resolve("synthetic-t2v");
    const input = syntheticCancellationEvidence(resolved);
    const evidence = new VideogenPromptCancellationAuthorityV1(input);
    expect(isConcreteVideogenPromptCancellationAuthorityV1(evidence)).toBe(true);
    let virtualCalls = 0;
    const grants = {
      permits: () => {
        virtualCalls += 1;
        return true;
      },
    };
    const forged: unknown = Object.create(VideogenPromptCancellationAuthorityV1.prototype, {
      permits: { value: grants.permits },
    });
    const proxy = new Proxy(evidence, { get: () => grants.permits });
    for (const candidate of [forged, proxy, grants, true]) {
      expect(isConcreteVideogenPromptCancellationAuthorityV1(candidate)).toBe(false);
      expect(() => {
        Reflect.construct(ComfyVideogenOperationAdapter, [
          { legacy_http: true, profiles: f.registry, cancellation_authority: candidate },
        ]);
      }).toThrow("concrete host-pinned authority");
    }
    await expect(f.runtime(undefined, { cancellation_authority: proxy })).rejects.toThrow();
    class Subclass extends VideogenPromptCancellationAuthorityV1 {
      permits(): boolean {
        return true;
      }
    }
    expect(() => new Subclass(input)).toThrow("cannot be subclassed");
    const ProxiedAuthority = new Proxy(VideogenPromptCancellationAuthorityV1, {});
    expect(() => new ProxiedAuthority(input)).toThrow("cannot be subclassed");
    expect(Reflect.defineProperty(evidence, "permits", { value: grants.permits })).toBe(false);
    expect(
      Reflect.defineProperty(VideogenPromptCancellationAuthorityV1.prototype, "permits", {
        value: grants.permits,
      })
    ).toBe(false);
    expect(virtualCalls).toBe(0);
  });

  it.each(["unchanged", "replaced", "revoked"] as const)(
    "keeps interrupt disabled for %s same-profile backend while the adapter is alive",
    async (state) => {
      const controller = new AbortController();
      const backend = {
        current_version: sha256("synthetic local HTTP server version"),
        approved: true,
      };
      let interrupts = 0;
      let histories = 0;
      const paths: string[] = [];
      const port = await listen((request, response) => {
        const url = request.url ?? "";
        paths.push(url);
        if (url === "/system_stats") json(response, {});
        else if (url === "/object_info") json(response, syntheticVideogenInventory());
        else if (url === "/prompt") {
          request.resume();
          if (state === "replaced")
            backend.current_version = sha256("new deployed local server version");
          if (state === "revoked") backend.approved = false;
          json(response, { prompt_id: "owned-render", number: 1, node_errors: {} });
        } else if (url === "/history/owned-render") {
          histories += 1;
          if (histories === 1)
            controller.abort(new Error("owner cancellation after deployment change"));
          json(response, {});
        } else if (url === "/interrupt") {
          interrupts += 1;
          request.resume();
          json(response, {});
        } else response.writeHead(404).end();
      });
      using f = new RenderSafetyFixture(port, "t2v");
      const resolved = f.registry.resolve("synthetic-t2v");
      const input = syntheticCancellationEvidence(resolved);
      const pin = requireValue(
        input.current_bindings[0],
        "constructor pin"
      ).deployed_version_sha256;
      const runtime = await f.runtime(undefined, {
        cancellation_authority: new VideogenPromptCancellationAuthorityV1(input),
      });
      // The backend state is independent of constructor evidence. There is intentionally no
      // runtime source that attests it; all three cases must deny, including the unchanged one.
      await runtime.dispatch(f.engine, f.directive, controller.signal);
      expect(f.registry.resolve(resolved.profile.profile_id)).toEqual(resolved);
      expect(backend.current_version === pin).toBe(state !== "replaced");
      expect(backend.approved).toBe(state !== "revoked");
      expect(interrupts).toBe(0);
      expect(histories).toBeGreaterThanOrEqual(2);
      expect(f.record().disposition).toMatchObject({
        outcome: "cancelled",
        remote_disposition: "may_continue",
        lease_disposition: "quarantined",
      });
      expect(f.leases.inspect(f.backendKey).state).toBe("quarantined");
      expect(paths.filter((entry) => entry.startsWith("/history/"))).not.toContain(
        "/history/foreign-prompt"
      );
      expect(paths.filter((entry) => entry === "/prompt")).toHaveLength(1);
    }
  );
});

it("counts every envelope byte against the cache ceiling and refuses malformed canonical headers", () => {
  const header = {
    schema_id: "penny.videogen-fetched-cache.v1",
    schema_version: 1,
    operation_record_id: "fixture-operation",
    directive_sha256: sha256("directive"),
    request_sha256: sha256("request"),
    prompt_id_sha256: sha256("prompt"),
    remote_descriptor: original,
    media_type: "video/mp4",
    video_sha256: sha256(video),
    video_byte_length: video.byteLength,
  } as const;
  const bytes = encodeVideogenFetchedCache(header, video, 2_000_000);
  expect(encodeVideogenFetchedCache(header, video, bytes.byteLength)).toEqual(bytes);
  expect(() => encodeVideogenFetchedCache(header, video, bytes.byteLength - 1)).toThrow();
  expect(() => decodeVideogenFetchedCache(bytes, bytes.byteLength - 1)).toThrow();
  expect(decodeVideogenFetchedCache(bytes, bytes.byteLength).header).toEqual(header);
  const invalidUtf8 = Buffer.from([0, 0, 0, 1, 255]);
  const oversizedHeader = Buffer.from([0, 0, 16, 1]);
  for (const malformed of [
    video,
    bytes.subarray(0, 3),
    invalidUtf8,
    oversizedHeader,
    frame(header, video, false),
    frame({ ...header, extra: true }, video),
    frame({ ...header, video_sha256: sha256("other bytes") }, video),
  ]) {
    expect(() => decodeVideogenFetchedCache(malformed, 2_000_000)).toThrow();
  }
});

it.each(["missing", "changed-bytes"] as const)(
  "never replaces the original locator when its output is %s on fetched recovery",
  async (state) => {
    let recovering = false;
    const paths: string[] = [];
    const port = await listen((request, response) => {
      const url = request.url ?? "";
      paths.push(url);
      if (url === "/system_stats") json(response, {});
      else if (url === "/object_info") json(response, syntheticVideogenInventory());
      else if (url === "/prompt") {
        request.resume();
        json(response, { prompt_id: "owned-render", number: 1, node_errors: {} });
      } else if (url === "/history/owned-render") terminal(response);
      else if (url === "/view?filename=clip.mp4&subfolder=&type=output") {
        if (recovering && state === "missing") response.writeHead(404).end();
        else
          response
            .writeHead(200, { "Content-Type": "video/mp4" })
            .end(recovering ? Buffer.alloc(video.byteLength, 8) : video);
      } else response.writeHead(404).end();
    });
    using f = new RenderSafetyFixture(port, "t2v");
    await expect(
      (
        await f.runtime((point) => {
          if (point === "after_fetch") throw new HostOperationSimulatedCrashError(point);
        })
      ).dispatch(f.engine, f.directive)
    ).rejects.toBeInstanceOf(HostOperationSimulatedCrashError);
    recovering = true;
    paths.length = 0;
    await (await f.runtime()).dispatch(f.engine, f.directive);
    expect(paths).toEqual([
      "/history/owned-render",
      "/view?filename=clip.mp4&subfolder=&type=output",
    ]);
    expect(f.record().disposition).toMatchObject({
      outcome: "remote_unknown",
      remote_disposition: "may_continue",
      lease_disposition: "quarantined",
    });
    expect(f.record().output_artifacts).toHaveLength(0);
    expect(f.leases.inspect(f.backendKey).state).toBe("quarantined");
  }
);
