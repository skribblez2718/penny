import {
  chmodSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { createConnection } from "node:net";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson } from "../../orchestration/dist/canonical-json.js";
import type { ScaAdapterTerminalResult } from "../src/adapters.js";
import { scaBrokerExecuteRequestSha256 } from "../src/contracts.js";
import { ScaJobStore } from "../src/job-store.js";
import { startScaService } from "../src/server.js";
import { ScaJobOwner } from "../src/jobs.js";
import { createScaRouter, SCA_SERVICE_IPC_PROTOCOL } from "../src/router.js";
import {
  adapterRegistry,
  adapterWithRun,
  artifactRef,
  cancelRequest,
  executeRequest,
  pollRequest,
  terminalSuccess,
} from "./fixtures/job-store.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

const roots: string[] = [];
const stores: ScaJobStore[] = [];
const owners: ScaJobOwner[] = [];
const TOKEN = "durable-test-token-00000000000000000000";

function setup(limit = 256) {
  const root = mkdtempSync(path.join(os.tmpdir(), "penny-sca-job-store-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const databasePath = path.join(root, "jobs.db");
  const store = ScaJobStore.provision(databasePath, {
    projectId: "project-a",
    maxRetainedJobs: limit,
  });
  stores.push(store);
  return { root, databasePath, store };
}

function reopen(databasePath: string): ScaJobStore {
  const store = ScaJobStore.openExisting(databasePath, { projectId: "project-a" });
  stores.push(store);
  return store;
}

function owner(store: ScaJobStore, run: Parameters<typeof adapterWithRun>[0]): ScaJobOwner {
  const result = new ScaJobOwner({
    jobStore: store,
    adapters: adapterRegistry(adapterWithRun(run)),
  });
  owners.push(result);
  return result;
}

function pending(): Promise<ScaAdapterTerminalResult> {
  return new Promise(() => {});
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(async () => {
  for (const item of owners.splice(0)) await item.shutdown(1);
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable SCA job custody", () => {
  it("provisions complete owner-only state, binds its project and opens create-never", () => {
    const { root, databasePath, store } = setup();
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(store.projectId).toBe("project-a");
    expect(() => ScaJobStore.provision(databasePath, { projectId: "project-a" })).toThrow(
      /already exists/u
    );
    store.close();
    const bytes = readFileSync(databasePath);
    expect(() => ScaJobStore.openExisting(databasePath, { projectId: "project-b" })).toThrow(
      /project binding/u
    );
    expect(readFileSync(databasePath)).toEqual(bytes);
    expect(() =>
      ScaJobStore.openExisting(databasePath, { projectId: "project-a", maxRetainedJobs: 1 })
    ).toThrow(/limit/u);
    const missing = path.join(root, "absent.db");
    expect(() => ScaJobStore.openExisting(missing, { projectId: "project-a" })).toThrow();
    expect(() => statSync(missing)).toThrow();
    expect(reopen(databasePath).get("a".repeat(64))).toBeNull();
  });

  it("refuses exposed parents, files, symlinks, hard links and sidecars without repairs", () => {
    const { root, databasePath, store } = setup();
    store.close();
    const open = (): ScaJobStore =>
      ScaJobStore.openExisting(databasePath, { projectId: "project-a" });
    chmodSync(root, 0o755);
    expect(open).toThrow(/0700/u);
    chmodSync(root, 0o700);
    chmodSync(databasePath, 0o644);
    expect(open).toThrow(/0600/u);
    expect(statSync(databasePath).mode & 0o777).toBe(0o644);
    chmodSync(databasePath, 0o600);
    const linked = path.join(root, "linked.db");
    linkSync(databasePath, linked);
    expect(open).toThrow(/single-link/u);
    rmSync(linked);
    symlinkSync(databasePath, linked);
    expect(() => ScaJobStore.openExisting(linked, { projectId: "project-a" })).toThrow(/0600/u);
    const alias = path.join(root, "alias");
    symlinkSync(root, alias);
    expect(() =>
      ScaJobStore.openExisting(path.join(alias, "jobs.db"), { projectId: "project-a" })
    ).toThrow(/symlink|0700/u);
    const journal = `${databasePath}-journal`;
    writeFileSync(journal, "untrusted", { mode: 0o644 });
    chmodSync(journal, 0o644); // Creation mode is filtered by the runner's umask.
    expect(statSync(journal).mode & 0o777).toBe(0o644);
    const journalBytes = readFileSync(journal);
    expect(open).toThrow(/0600/u);
    expect(statSync(journal).mode & 0o777).toBe(0o644);
    expect(readFileSync(journal)).toEqual(journalBytes);
    rmSync(journal);
    expect(() => ScaJobStore.openExisting("jobs.db", { projectId: "project-a" })).toThrow(
      /absolute/u
    );
  });

  it("rejects an empty database and refuses a replaced path on an open handle", () => {
    const { root, databasePath, store } = setup();
    const empty = path.join(root, "empty.db");
    writeFileSync(empty, "", { mode: 0o600 });
    expect(() => ScaJobStore.openExisting(empty, { projectId: "project-a" })).toThrow(/schema/u);
    rmSync(databasePath);
    writeFileSync(databasePath, "replacement", { mode: 0o600 });
    expect(() => store.get("a".repeat(64))).toThrow(/unavailable/u);
  });

  it("requires a caller-owned existing parent and validates finite retention", () => {
    const { root } = setup();
    const absent = path.join(root, "absent", "jobs.db");
    expect(() => ScaJobStore.provision(absent, { projectId: "project-a" })).toThrow();
    mkdirSync(path.dirname(absent), { mode: 0o700 });
    for (const limit of [0, -1, 1.5, Infinity, 10001]) {
      expect(() =>
        ScaJobStore.provision(absent, { projectId: "project-a", maxRetainedJobs: limit })
      ).toThrow(/limit/u);
    }
    expect(() => statSync(absent)).toThrow();
  });
});

describe("durable SCA job admission and recovery", () => {
  it("adopts exact canonical retries before/after restart and refuses both identity conflicts", async () => {
    const { store, databasePath } = setup(1);
    const run = vi.fn(pending);
    const first = owner(store, run);
    const request = executeRequest(1000);
    const accepted = first.execute(request);
    // Key insertion order is not part of canonical identity.
    expect(
      first.execute({
        ...request,
        limits: { max_result_items: 50, max_output_bytes: 16384, timeout_ms: 1000 },
      })
    ).toEqual(accepted);
    await turn();
    expect(first.execute(request)).toEqual(accepted);
    expect(run).toHaveBeenCalledTimes(1);
    expect(() => first.execute({ ...request, job_id: "job-other" })).toThrow(/conflicts/u);
    expect(() => first.execute({ ...request, idempotency_key: "key-other" })).toThrow(/conflicts/u);
    expect(() =>
      first.execute({ ...request, limits: { ...request.limits, max_result_items: 49 } })
    ).toThrow(/conflicts/u);
    expect(() => first.execute({ ...request, project_id: "project-b" })).toThrow(
      /project binding/u
    );
    expect(() =>
      first.execute({ ...request, job_id: "job-new", idempotency_key: "key-new" })
    ).toThrow(/limit/u);
    await first.shutdown(1);
    store.close();
    const recovered = owner(reopen(databasePath), run);
    expect(recovered.execute(request)).toEqual(accepted);
    expect(() => recovered.execute({ ...request, job_id: "job-other" })).toThrow(/conflicts/u);
    await turn();
    expect(run).toHaveBeenCalledTimes(1);
    expect(() => recovered.poll(pollRequest(request))).toThrow(/unverified/u);
    expect(() => recovered.cancel(cancelRequest(request, 100))).toThrow(/unverified/u);
    expect(() => recovered.poll({ ...pollRequest(request), job_id: "wrong" })).toThrow(/binding/u);
  });

  it("serializes admission across independent handles without a second dispatch", async () => {
    const { store, databasePath } = setup(1);
    const firstRun = vi.fn(pending);
    const secondRun = vi.fn(pending);
    const first = owner(store, firstRun);
    const second = owner(reopen(databasePath), secondRun);
    const request = executeRequest(1000);
    const accepted = first.execute(request);
    expect(second.execute(request)).toEqual(accepted);
    expect(() =>
      second.execute({ ...request, job_id: "job-new", idempotency_key: "key-new" })
    ).toThrow(/limit/u);
    expect(() => second.execute({ ...request, idempotency_key: "key-conflict" })).toThrow(
      /conflicts/u
    );
    await turn();
    expect(firstRun).toHaveBeenCalledTimes(1);
    expect(secondRun).not.toHaveBeenCalled();
    expect(() => second.poll(pollRequest(request))).toThrow(/unverified/u);
  });

  it("persists canonical request/receipt bytes before exposure and polls terminal progress after restart", async () => {
    const { store, databasePath } = setup();
    const request = executeRequest(1000);
    const output = artifactRef("sca-source-results", "durable-output");
    const run = vi.fn((async (_request, context) => {
      context.reportWorkMilestone();
      context.reportPersistedOutput(output.byte_length, 1);
      return terminalSuccess(output);
    }) satisfies Parameters<typeof adapterWithRun>[0]);
    const first = owner(store, run);
    const persistTerminal = store.persistTerminal.bind(store);
    vi.spyOn(store, "persistTerminal").mockImplementation((...args) => {
      expect(first.poll(pollRequest(request)).receipt).toBeNull();
      persistTerminal(...args);
    });
    const accepted = first.execute(request);
    await turn();
    vi.mocked(store.persistTerminal).mockRestore();
    const terminal = first.poll(pollRequest(request));
    expect(terminal.status).toBe("succeeded");
    expect(terminal.progress.sequence).toBe(3);
    expect(store.get(accepted.request_sha256)?.receipt).toEqual(terminal.receipt);
    if (terminal.receipt === null) throw new Error("missing terminal receipt");
    const receipt = terminal.receipt;
    store.persistTerminal(accepted.request_sha256, receipt, terminal.progress);
    expect(() =>
      store.persistTerminal(
        accepted.request_sha256,
        { ...receipt, receipt_id: "conflicting-receipt" },
        terminal.progress
      )
    ).toThrow(/conflicts/u);
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = db.prepare("SELECT request_bytes, receipt_bytes FROM jobs").get();
      if (
        row === undefined ||
        !(row.request_bytes instanceof Uint8Array) ||
        !(row.receipt_bytes instanceof Uint8Array)
      )
        throw new Error("missing stored bytes");
      expect(Buffer.from(row.request_bytes)).toEqual(Buffer.from(canonicalJson(request)));
      expect(Buffer.from(row.receipt_bytes)).toEqual(Buffer.from(canonicalJson(terminal.receipt)));
    } finally {
      db.close();
    }
    store.close();
    const recovered = owner(reopen(databasePath), run);
    expect(recovered.execute(request)).toEqual(accepted);
    const polled = recovered.poll(pollRequest(request));
    expect(polled.receipt).toEqual(terminal.receipt);
    expect(polled.progress).toEqual(terminal.progress);
    expect(recovered.cancel(cancelRequest(request, 100))).toMatchObject({
      outcome: "terminal",
      receipt: terminal.receipt,
    });
    await turn();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch or expose acceptance if reservation persistence fails", async () => {
    const { store } = setup();
    const run = vi.fn(pending);
    const first = owner(store, run);
    store.close();
    expect(() => first.execute(executeRequest(1000))).toThrow(/unavailable/u);
    await turn();
    expect(run).not.toHaveBeenCalled();
  });

  it("withholds terminal truth when its commit fails and recovers the reservation without rerunning", async () => {
    const { store, databasePath } = setup();
    const run = vi.fn(async () =>
      terminalSuccess(artifactRef("sca-source-results", "commit-output"))
    );
    const request = executeRequest(1000);
    const first = owner(store, run);
    const accepted = first.execute(request);
    store.close();
    await turn();
    expect(() => first.poll(pollRequest(request))).toThrow(/unverified/u);
    const reopened = reopen(databasePath);
    expect(reopened.get(accepted.request_sha256)?.receipt).toBeNull();
    const recovered = owner(reopened, run);
    recovered.execute(request);
    await turn();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("never persists a terminal for uncertain containment or an unhandled adapter error", async () => {
    for (const uncertainty of ["reported", "thrown"]) {
      const { store } = setup();
      const request = executeRequest(1000);
      const first = owner(store, async (_request, context) => {
        if (uncertainty === "thrown") throw new Error("runner state unknown");
        context.reportContainmentUnverified?.();
        return {
          terminal_status: "failed",
          failure: { code: "failed", message: "unverified" },
          output_refs: [],
          result_item_count: 0,
          partial: false,
          truncated: false,
        };
      });
      first.execute(request);
      await turn();
      expect(() => first.poll(pollRequest(request))).toThrow(/unverified/u);
      expect(store.get(scaBrokerExecuteRequestSha256(request))?.receipt).toBeNull();
    }
  });

  it("quarantines inactivity and bounded cancel/shutdown without manufacturing terminal receipts", async () => {
    vi.useFakeTimers();
    try {
      for (const operation of ["inactivity", "cancel", "shutdown"]) {
        const { store } = setup();
        const first = owner(store, pending);
        const request = executeRequest(1000);
        const accepted = first.execute(request);
        await Promise.resolve();
        if (operation === "cancel") first.cancel(cancelRequest(request, 100));
        if (operation === "shutdown") {
          const shutdown = first.shutdown(1);
          await vi.advanceTimersByTimeAsync(1);
          await shutdown;
        } else await vi.advanceTimersByTimeAsync(operation === "cancel" ? 100 : 1000);
        expect(() => first.poll(pollRequest(request))).toThrow(/unverified/u);
        expect(() => first.cancel(cancelRequest(request, 100))).toThrow(/unverified/u);
        expect(store.get(accepted.request_sha256)?.receipt).toBeNull();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns typed service_unavailable for restart poll/cancel through the router, even without adapters", async () => {
    const { store, databasePath } = setup();
    const first = owner(store, pending);
    const request = executeRequest(1000);
    const accepted = first.execute(request);
    await first.shutdown(1);
    store.close();
    const recovered = reopen(databasePath);
    const router = createScaRouter({ authenticationToken: TOKEN, jobStore: recovered });
    const frame = (action: string, value: unknown) => ({
      protocol: SCA_SERVICE_IPC_PROTOCOL,
      token: TOKEN,
      action,
      request: value,
    });
    expect(await router.route(frame("execute", request))).toMatchObject({
      ok: true,
      action: "execute",
      result: accepted,
    });
    for (const [action, value] of [
      ["poll", pollRequest(request)],
      ["cancel", cancelRequest(request, 100)],
    ]) {
      expect(await router.route(frame(String(action), value))).toMatchObject({
        ok: false,
        action,
        error: { code: "service_unavailable" },
      });
    }
    expect(await router.route(frame("execute", { ...request, job_id: "conflict" }))).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    await router.shutdown(1);
    expect(recovered.get(accepted.request_sha256)?.receipt).toBeNull();
  });

  it("injects the store through the real socket server and polls a retained terminal without adapters", async () => {
    const { root, store, databasePath } = setup();
    const request = executeRequest(1000);
    const first = owner(store, async () =>
      terminalSuccess(artifactRef("sca-source-results", "socket-output"))
    );
    first.execute(request);
    await turn();
    const expected = first.poll(pollRequest(request));
    expect(expected.receipt).not.toBeNull();
    store.close();
    const recovered = reopen(databasePath);
    const service = await startScaService(
      { socketPath: path.join(root, "service.sock"), authenticationToken: TOKEN },
      { jobStore: recovered }
    );
    try {
      const result: unknown = await new Promise((resolve, reject) => {
        const socket = createConnection(service.socketPath);
        let body = "";
        socket.setEncoding("utf8");
        socket.setTimeout(1000, () => {
          socket.destroy();
          reject(new Error("socket response timed out"));
        });
        socket.on("connect", () =>
          socket.end(
            `${JSON.stringify({ protocol: SCA_SERVICE_IPC_PROTOCOL, action: "poll", token: TOKEN, request: pollRequest(request) })}\n`
          )
        );
        socket.on("data", (chunk: string) => {
          body += chunk;
        });
        socket.on("error", reject);
        socket.on("end", () => {
          try {
            const parsed: unknown = JSON.parse(body);
            resolve(parsed);
          } catch (error) {
            reject(error);
          }
        });
      });
      expect(result).toMatchObject({
        ok: true,
        action: "poll",
        result: { receipt: expected.receipt, progress: expected.progress },
      });
    } finally {
      await service.shutdown();
    }
    // The caller, not the service, owns the lifetime of an injected store.
    expect(recovered.get(scaBrokerExecuteRequestSha256(request))?.receipt).toEqual(
      expected.receipt
    );
  });

  it("rejects noncanonical retained document bytes on startup instead of repairing them", async () => {
    const { store, databasePath } = setup();
    const request = executeRequest(1000);
    const first = owner(store, pending);
    first.execute(request);
    await first.shutdown(1);
    store.close();
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare("UPDATE jobs SET request_bytes = ?").run(
        Buffer.from(JSON.stringify(request, null, 2))
      );
    } finally {
      db.close();
    }
    expect(() => ScaJobStore.openExisting(databasePath, { projectId: "project-a" })).toThrow(
      /canonical/u
    );
  });
});
