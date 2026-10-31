import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalJson } from "../../orchestration/dist/canonical-json.js";
import { runScaJobStoreCliV1 } from "../src/job-store-cli.js";
import { ScaJobStore } from "../src/job-store.js";
import { ScaJobOwner } from "../src/jobs.js";
import {
  adapterRegistry,
  adapterWithRun,
  artifactRef,
  executeRequest,
  terminalSuccess,
} from "./fixtures/job-store.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

const roots: string[] = [];
const stores: ScaJobStore[] = [];
const owners: ScaJobOwner[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "penny-sca-job-store-cli-"));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

function capture(): { lines: string[]; emit: (value: string) => void } {
  const lines: string[] = [];
  return { lines, emit: (value: string) => lines.push(value) };
}

function runCli(argv: readonly string[]): { lines: string[]; result: unknown } {
  const { lines, emit } = capture();
  runScaJobStoreCliV1(argv, { emit });
  const line = lines[0];
  return { lines, result: line === undefined ? undefined : JSON.parse(line) };
}

function pending(): Promise<never> {
  return new Promise(() => {});
}

function turn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Body-free row fingerprint: identities and byte lengths only, never document bodies. */
function rowSnapshot(database: string): unknown {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT request_sha256, length(request_bytes) AS request_len, length(receipt_bytes) AS receipt_len, length(progress_bytes) AS progress_len FROM jobs ORDER BY request_sha256"
      )
      .all();
  } finally {
    db.close();
  }
}

afterEach(async () => {
  for (const item of owners.splice(0)) await item.shutdown(1);
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("penny-sca-job-store operator CLI", () => {
  it("provisions fresh owner-only state and emits one canonical result line", () => {
    const root = makeRoot();
    const database = path.join(root, "jobs.db");
    const { lines, result } = runCli([
      "provision",
      `--database=${database}`,
      "--project-id=project-a",
      "--max-retained-jobs=7",
    ]);
    const expected = {
      schema_id: "penny.sca-job-store-cli-result.v1",
      schema_version: 1,
      operation: "provision",
      project_id: "project-a",
      retained_jobs: 0,
      terminal_jobs: 0,
      max_retained_jobs: 7,
    };
    expect(result).toEqual(expected);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(canonicalJson(expected));
    expect(lines[0]).not.toContain("\n");
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(database).mode & 0o777).toBe(0o600);
    const store = ScaJobStore.openExisting(database, { projectId: "project-a" });
    stores.push(store);
    expect(store.maxRetainedJobs).toBe(7);
    expect(store.summary()).toEqual({
      projectId: "project-a",
      retainedJobs: 0,
      terminalJobs: 0,
      maxRetainedJobs: 7,
    });
  });

  it("defaults the configured quota and reports it from status", () => {
    const root = makeRoot();
    const database = path.join(root, "jobs.db");
    runCli(["provision", `--database=${database}`, "--project-id=project-a"]);
    const { result } = runCli(["status", `--database=${database}`, "--project-id=project-a"]);
    expect(result).toMatchObject({
      operation: "status",
      project_id: "project-a",
      retained_jobs: 0,
      max_retained_jobs: 256,
    });
  });

  it("refuses to provision over an existing store without touching it", () => {
    const root = makeRoot();
    const database = path.join(root, "jobs.db");
    runCli(["provision", `--database=${database}`, "--project-id=project-a"]);
    const before = readFileSync(database);
    const { lines, emit } = capture();
    expect(() =>
      runScaJobStoreCliV1(["provision", `--database=${database}`, "--project-id=project-a"], {
        emit,
      })
    ).toThrow(/already exists/u);
    expect(lines).toHaveLength(0);
    expect(readFileSync(database)).toEqual(before);
  });

  it("keeps status create-never for a missing store", () => {
    const root = makeRoot();
    const database = path.join(root, "absent.db");
    const { lines, emit } = capture();
    expect(() =>
      runScaJobStoreCliV1(["status", `--database=${database}`, "--project-id=project-a"], {
        emit,
      })
    ).toThrow();
    expect(lines).toHaveLength(0);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      expect(existsSync(`${database}${suffix}`)).toBe(false);
    }
  });

  it("fails closed on custody, path, project and quota mismatches", () => {
    const root = makeRoot();
    const database = path.join(root, "jobs.db");
    runCli([
      "provision",
      `--database=${database}`,
      "--project-id=project-a",
      "--max-retained-jobs=7",
    ]);

    expect(
      runCli([
        "status",
        `--database=${database}`,
        "--project-id=project-a",
        "--max-retained-jobs=7",
      ]).result
    ).toMatchObject({ max_retained_jobs: 7 });
    expect(() =>
      runCli([
        "status",
        `--database=${database}`,
        "--project-id=project-a",
        "--max-retained-jobs=5",
      ])
    ).toThrow(/limit/u);
    expect(() => runCli(["status", `--database=${database}`, "--project-id=project-b"])).toThrow(
      /project binding/u
    );
    expect(() => runCli(["status", "--database=jobs.db", "--project-id=project-a"])).toThrow(
      /absolute/u
    );
    expect(() =>
      runCli([
        "status",
        `--database=${root}/../${path.basename(root)}/jobs.db`,
        "--project-id=project-a",
      ])
    ).toThrow(/canonical/u);

    const aliasParent = makeRoot();
    const alias = path.join(aliasParent, "alias");
    symlinkSync(root, alias);
    expect(() =>
      runCli(["status", `--database=${path.join(alias, "jobs.db")}`, "--project-id=project-a"])
    ).toThrow(/0700|symlink/u);

    chmodSync(root, 0o755);
    expect(() => runCli(["status", `--database=${database}`, "--project-id=project-a"])).toThrow(
      /0700/u
    );
    chmodSync(root, 0o700);

    chmodSync(database, 0o644);
    expect(() => runCli(["status", `--database=${database}`, "--project-id=project-a"])).toThrow(
      /0600/u
    );
    chmodSync(database, 0o600);
  });

  it("rejects unknown or malformed commands and flags", () => {
    const root = makeRoot();
    const database = path.join(root, "jobs.db");
    runCli(["provision", `--database=${database}`, "--project-id=project-a"]);
    for (const argv of [
      [],
      ["status"],
      ["status", `--database=${database}`],
      ["status", "--project-id=project-a"],
      ["status", `--database=${database}`, "--project-id=project-a", "--unknown=1"],
      ["status", `--database=${database}`, "--project-id=project-a", `--database=${database}`],
      ["status", `--database=${database}`, "--project-id=project-a", "--max-retained-jobs=abc"],
      ["status", `--database=${database}`, "--project-id=project-a", "--max-retained-jobs=0"],
      ["status", `--database=${database}`, "--project-id=project-a", "positional"],
      ["status", "--database", "--project-id=project-a"],
      ["bogus", `--database=${database}`, "--project-id=project-a"],
    ]) {
      const { lines, emit } = capture();
      expect(() => runScaJobStoreCliV1(argv, { emit })).toThrow(/usage/u);
      expect(lines).toHaveLength(0);
    }
  });

  it("reports a body-free status without mutating retained state", () => {
    const root = makeRoot();
    const database = path.join(root, "jobs.db");
    runCli(["provision", `--database=${database}`, "--project-id=project-a"]);
    const store = ScaJobStore.openExisting(database, { projectId: "project-a" });
    stores.push(store);
    const owner = new ScaJobOwner({
      jobStore: store,
      adapters: adapterRegistry(adapterWithRun(vi.fn(pending))),
    });
    owners.push(owner);
    owner.execute(executeRequest(1000));

    const before = rowSnapshot(database);
    const { lines, result } = runCli([
      "status",
      `--database=${database}`,
      "--project-id=project-a",
    ]);
    expect(lines).toHaveLength(1);
    expect(result).toEqual({
      schema_id: "penny.sca-job-store-cli-result.v1",
      schema_version: 1,
      operation: "status",
      project_id: "project-a",
      retained_jobs: 1,
      terminal_jobs: 0,
      max_retained_jobs: 256,
    });
    expect(lines[0]).not.toContain("request_bytes");
    expect(lines[0]).not.toContain("receipt_bytes");
    expect(rowSnapshot(database)).toEqual(before);
  });

  it("counts terminal receipts without exposing their bodies", async () => {
    const root = makeRoot();
    const database = path.join(root, "jobs.db");
    runCli(["provision", `--database=${database}`, "--project-id=project-a"]);
    const store = ScaJobStore.openExisting(database, { projectId: "project-a" });
    stores.push(store);
    const owner = new ScaJobOwner({
      jobStore: store,
      adapters: adapterRegistry(
        adapterWithRun(vi.fn(async () => terminalSuccess(artifactRef("sca-source-results", "cli"))))
      ),
    });
    owners.push(owner);
    owner.execute(executeRequest(1000));
    await turn();

    const { lines, result } = runCli([
      "status",
      `--database=${database}`,
      "--project-id=project-a",
    ]);
    expect(result).toMatchObject({ retained_jobs: 1, terminal_jobs: 1 });
    expect(lines[0]).not.toContain("receipt_bytes");
    expect(lines[0]).not.toContain("terminal_status");
  });
});
