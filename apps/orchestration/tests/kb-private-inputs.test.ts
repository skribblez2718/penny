import { requireRecord, requireValue } from "./helpers/narrowing.js";
/**
 * §5.6 durable private-input custody — focused crash/custody/status tests.
 *
 * The contract under test:
 *
 * - the control DB indexes the private input BEFORE any byte is written
 *   (`preparing` row with host-allocated exact final/temporary keys, in the
 *   same transaction as the durable run row and the idempotency record);
 * - bytes live only as an owner-only (0600/0700, non-symlink, single-link)
 *   temp → rename → parent-fsync lifecycle under the trusted input root, and
 *   CAS `preparing → active` earns that state;
 * - recovery uses ONLY the indexed row: matching temps are adopted through
 *   the exact rename; a mismatched temp discards the exact indexed keys and
 *   leaves the run incomplete; a foreign, symlinked, or broadly-modeled file
 *   refuses;
 * - the idempotency identity is (session_id, invocation_id): same pair + same
 *   digest replays the original run with no second side effect; same pair +
 *   different digest is `idempotency_mismatch`;
 * - at terminal the row settles `active → terminal → discarding → discarded`,
 *   the exact files are removed and fsynced, and the metadata survives;
 * - the request BODY never lives in the control database, in any control
 *   snapshot, or in any event payload.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  Checkpointer,
  StartAdmissionMismatchError,
  canonicalJson,
  sha256,
} from "../src/checkpointer.js";
import { RunContext } from "../src/context.js";
import {
  PrivateInputError,
  materializeRunInput,
  privateInputRoot,
  readRunInput,
  settleRunInput,
  verifyAndSettleTerminalStart,
} from "../src/private-inputs.js";
import { computeRequestSha256, validateQueryRequest } from "../src/kb/parent-delivery.js";
import {
  canonicalJson as kbCanonicalJson,
  sha256Hex,
  type QueryKbRequest,
} from "../src/kb/contracts.js";
import { installTestProjectState } from "./fixtures/penny-state-fixture.js";

const PROFILE = "kbp_custody";
const SESSION = "sess_custody";
/** A distinctive body: its absence from control state is the assertion. */
const QUERY_BODY = "quorum-zeta PRIVATE-QUERY-BODY 8f3a1c does not publish";

const dirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(path.join(tmpdir(), "penny-kb-custody-"));
  dirs.push(d);
  installTestProjectState(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function queryRequest(): QueryKbRequest {
  return validateQueryRequest({
    schema_version: 1,
    action: "query",
    kb_profile_id: PROFILE,
    query: QUERY_BODY,
    verify_grounding: false,
  });
}

function requestSha(request: unknown): string {
  return sha256(canonicalJson(request));
}

function database(file: string) {
  const sqlite = process.getBuiltinModule("node:sqlite") as
    | typeof import("node:sqlite")
    | undefined;
  if (sqlite === undefined) throw new Error("node:sqlite unavailable");
  return new sqlite.DatabaseSync(file);
}

function admit(
  projectRoot: string,
  checkpointer: Checkpointer,
  runId: string,
  request: unknown,
  invocationId = "call-1",
  keyOverrides: { storage_key?: string; temporary_storage_key?: string } = {}
) {
  const context = RunContext.create({
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: SESSION,
      playbook: "knowledge-base",
      engine_owner: "typescript",
    },
    goal: "the stored private request is the work; advisory only",
    constraints: {
      action: "query",
      kb_profile_id: PROFILE,
      // The body is NOT a constraint: that is the whole point.
      parent_identity: null,
    },
    projectRoot,
    trustProfile: "hardened-untrusted",
    maxSteps: 8,
  });
  const output = checkpointer.admitStartRun(context, {
    session_id: SESSION,
    invocation_id: invocationId,
    request_sha256: requestSha(request),
    action: "query",
    profile_id: PROFILE,
    transaction_id: `tx_${runId}`,
    private_input_id: `pri_${runId}`,
    storage_key: keyOverrides.storage_key ?? `${runId}/request.json`,
    temporary_storage_key: keyOverrides.temporary_storage_key ?? `${runId}/.tx_${runId}.tmp`,
  });
  return output;
}

function materialize(
  projectRoot: string,
  checkpointer: Checkpointer,
  runId: string,
  request: unknown
) {
  materializeRunInput({
    projectRoot,
    checkpointer,
    runId,
    request,
    requestSha256: requestSha(request),
  });
}

/** Owner-only directory, explicitly 0700 regardless of umask. */
function mkdir0700(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function dbBytes(projectRoot: string, dbName: string): string {
  const base = path.join(projectRoot, ".penny", dbName);
  const chunks: string[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${base}${suffix}`;
    if (existsSync(file)) chunks.push(readFileSync(file, "latin1"));
  }
  return chunks.join("\u0000");
}

describe("§5.6 exact DB projections", () => {
  it("round-trips exact versioned timestamps/action enums and rejects row tamper", () => {
    const projectRoot = tmpRoot();
    mkdirSync(path.join(projectRoot, ".penny"), { mode: 0o700 });
    const dbPath = path.join(projectRoot, "control.db");
    const checkpointer = new Checkpointer(dbPath);
    const request = queryRequest();
    admit(projectRoot, checkpointer, "run_projection", request);

    const privateInput = requireValue(
      checkpointer.getPrivateInput("run_projection"),
      "apps/orchestration/tests/kb-private-inputs.test.ts:180"
    );
    const idempotency = requireValue(
      checkpointer.getStartAdmission("run_projection"),
      "apps/orchestration/tests/kb-private-inputs.test.ts:181"
    );
    expect(Object.keys(privateInput).sort()).toEqual([
      "created_at",
      "private_input_id",
      "request_sha256",
      "run_id",
      "schema_version",
      "state",
      "storage_key",
      "temporary_storage_key",
      "updated_at",
    ]);
    expect(Object.keys(idempotency).sort()).toEqual([
      "action",
      "created_at",
      "invocation_id",
      "kb_profile_id",
      "request_sha256",
      "run_id",
      "schema_version",
      "session_id",
      "state",
      "transaction_id",
      "updated_at",
    ]);
    expect(privateInput).toMatchObject({ schema_version: 1, state: "preparing" });
    expect(idempotency).toMatchObject({
      schema_version: 1,
      action: "query",
      kb_profile_id: PROFILE,
      state: "running",
    });

    using raw = database(dbPath);
    raw.prepare("UPDATE start_admissions SET action='status' WHERE run_id=?").run("run_projection");
    expect(() => checkpointer.getStartAdmission("run_projection")).toThrow(/projection/i);
    raw.prepare("UPDATE start_admissions SET action='query' WHERE run_id=?").run("run_projection");
    raw
      .prepare("UPDATE private_inputs SET created_at='not-a-time' WHERE run_id=?")
      .run("run_projection");
    expect(() => checkpointer.getPrivateInput("run_projection")).toThrow(/projection/i);
    checkpointer.close();
  });
});

describe("§5.6 private-input custody (index before bytes)", () => {
  it("indexes before writing, then the exact temp/fsync/rename lifecycle earns `active`", () => {
    const projectRoot = tmpRoot();
    const dbPath = path.join(projectRoot, ".penny", "orchestration-custody.db");
    const checkpointer = new Checkpointer(dbPath);
    const request = queryRequest();
    const runId = "cust_run_1";

    const admission = admit(projectRoot, checkpointer, runId, request);
    expect(admission.kind).toBe("created");

    // The row exists with the exact host-allocated keys and NO bytes yet.
    const row = checkpointer.getPrivateInput(runId);
    expect(row).toBeDefined();
    expect(requireValue(row, "apps/orchestration/tests/kb-private-inputs.test.ts:240").state).toBe(
      "preparing"
    );
    expect(
      requireValue(row, "apps/orchestration/tests/kb-private-inputs.test.ts:241").storage_key
    ).toBe(`${runId}/request.json`);
    expect(
      requireValue(row, "apps/orchestration/tests/kb-private-inputs.test.ts:242")
        .temporary_storage_key
    ).toBe(`${runId}/.tx_${runId}.tmp`);
    expect(
      requireValue(row, "apps/orchestration/tests/kb-private-inputs.test.ts:243").request_sha256
    ).toBe(requestSha(request));

    const finalPath = path.join(privateInputRoot(projectRoot), runId, "request.json");
    expect(existsSync(finalPath)).toBe(false);

    // Materialize: custody-checked, 0600/0700, hash-verified, row `active`.
    materialize(projectRoot, checkpointer, runId, request);
    const after = checkpointer.getPrivateInput(runId);
    expect(after?.state).toBe("active");
    expect(after?.temporary_storage_key).toBeUndefined();
    const st = lstatSync(finalPath);
    expect(st.isFile()).toBe(true);
    expect(st.nlink).toBe(1);
    expect(st.mode & 0o777).toBe(0o600);
    const runDir = path.join(privateInputRoot(projectRoot), runId);
    expect(lstatSync(runDir).mode & 0o777).toBe(0o700);
    expect(lstatSync(privateInputRoot(projectRoot)).mode & 0o777).toBe(0o700);
    expect(sha256(readFileSync(finalPath))).toBe(requestSha(request));

    // Read-back is custody + digest verified and yields the parsed document.
    const doc = requireRecord(
      readRunInput({ projectRoot, checkpointer, runId }),
      "active private run input"
    );
    expect(doc["query"]).toBe(QUERY_BODY);

    // Materialize is idempotent in `active` (a retry never rewrites).
    materialize(projectRoot, checkpointer, runId, request);
    expect(checkpointer.getPrivateInput(runId)?.state).toBe("active");

    checkpointer.close();
  });

  it("crash before rename resumes from the indexed row and adopts the matching temp", () => {
    const projectRoot = tmpRoot();
    const dbPath = path.join(projectRoot, ".penny", "orchestration-custody.db");
    const checkpointer = new Checkpointer(dbPath);
    const request = queryRequest();
    const runId = "cust_run_2";
    admit(projectRoot, checkpointer, runId, request);
    const row = requireValue(
      checkpointer.getPrivateInput(runId),
      "apps/orchestration/tests/kb-private-inputs.test.ts:280"
    );

    // Simulate the crash: the temp exists with the exact bytes, the final does not.
    const tempPath = path.join(
      privateInputRoot(projectRoot),
      requireValue(
        row.temporary_storage_key,
        "apps/orchestration/tests/kb-private-inputs.test.ts:283"
      )
    );
    const runDir = path.join(privateInputRoot(projectRoot), runId);
    mkdir0700(runDir);
    writeFileSync(tempPath, canonicalJson(request), { mode: 0o600 });

    materialize(projectRoot, checkpointer, runId, request);

    const finalPath = path.join(privateInputRoot(projectRoot), runId, "request.json");
    expect(existsSync(finalPath)).toBe(true);
    expect(existsSync(tempPath)).toBe(false);
    expect(checkpointer.getPrivateInput(runId)?.state).toBe("active");
    expect(sha256(readFileSync(finalPath))).toBe(requestSha(request));
    checkpointer.close();
  });

  it("crash after rename but before active CAS adopts the exact matching final", () => {
    const projectRoot = tmpRoot();
    const dbPath = path.join(projectRoot, ".penny", "orchestration-custody.db");
    const checkpointer = new Checkpointer(dbPath);
    const request = queryRequest();
    const runId = "cust_run_after_rename";
    admit(projectRoot, checkpointer, runId, request);

    const runDir = path.join(privateInputRoot(projectRoot), runId);
    const finalPath = path.join(runDir, "request.json");
    mkdir0700(runDir);
    writeFileSync(finalPath, canonicalJson(request), { mode: 0o600 });

    materialize(projectRoot, checkpointer, runId, request);
    expect(checkpointer.getPrivateInput(runId)?.state).toBe("active");
    expect(sha256(readFileSync(finalPath))).toBe(requestSha(request));
    checkpointer.close();
  });

  it("a mismatched temp refuses, discards the EXACT indexed keys, and leaves the run incomplete", () => {
    const projectRoot = tmpRoot();
    const dbPath = path.join(projectRoot, ".penny", "orchestration-custody.db");
    const checkpointer = new Checkpointer(dbPath);
    const request = queryRequest();
    const runId = "cust_run_3";
    admit(projectRoot, checkpointer, runId, request);
    const row = requireValue(
      checkpointer.getPrivateInput(runId),
      "apps/orchestration/tests/kb-private-inputs.test.ts:324"
    );
    const tempPath = path.join(
      privateInputRoot(projectRoot),
      requireValue(
        row.temporary_storage_key,
        "apps/orchestration/tests/kb-private-inputs.test.ts:325"
      )
    );
    const runDir = path.join(privateInputRoot(projectRoot), runId);
    mkdir0700(runDir);
    // A foreign byte at the indexed temp key.
    writeFileSync(tempPath, "not-the-admitted-bytes", { mode: 0o600 });

    let error: unknown = null;
    try {
      materialize(projectRoot, checkpointer, runId, request);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(PrivateInputError);
    if (!(error instanceof PrivateInputError)) throw new Error("expected PrivateInputError");
    expect(error.code).toBe("hash_mismatch");

    // Exact indexed keys are gone; the metadata row survives as `discarded`;
    // the run row remains (the run is left incomplete, never silently resumed).
    expect(existsSync(tempPath)).toBe(false);
    expect(checkpointer.getPrivateInput(runId)?.state).toBe("discarded");
    expect(checkpointer.runExists(runId)).toBe(true);
    const run = checkpointer.loadRunById(runId);
    expect(run?.status).toBe("running");
    checkpointer.close();
  });

  it("a tampered or symlinked active file refuses custody rather than trusting bytes", () => {
    const projectRoot = tmpRoot();
    const dbPath = path.join(projectRoot, ".penny", "orchestration-custody.db");
    const checkpointer = new Checkpointer(dbPath);
    const request = queryRequest();
    const runId = "cust_run_4";
    admit(projectRoot, checkpointer, runId, request);
    materialize(projectRoot, checkpointer, runId, request);
    const finalPath = path.join(privateInputRoot(projectRoot), runId, "request.json");

    // Broadened mode: group-writable.
    chmodSync(finalPath, 0o640);
    expect(() => readRunInput({ projectRoot, checkpointer, runId })).toThrow(PrivateInputError);
    chmodSync(finalPath, 0o600);

    // Symlink substitution: refuses even if the target content matches.
    const decoy = path.join(projectRoot, "decoy.json");
    writeFileSync(decoy, canonicalJson(request), { mode: 0o600 });
    unlinkSync(finalPath);
    symlinkSync(decoy, finalPath);
    expect(() => readRunInput({ projectRoot, checkpointer, runId })).toThrow(
      /must be a regular non-symlink file/
    );
    const row = requireValue(
      checkpointer.getPrivateInput(runId),
      "apps/orchestration/tests/kb-private-inputs.test.ts:373"
    );
    // The row must not have been re-CASed by a refused read.
    expect(row.state).toBe("active");
    checkpointer.close();
  });

  it("materialize refuses a request that fails to canonicalize to its admitted digest", () => {
    const projectRoot = tmpRoot();
    const dbPath = path.join(projectRoot, ".penny", "orchestration-custody.db");
    const checkpointer = new Checkpointer(dbPath);
    const request = queryRequest();
    const runId = "cust_run_5";
    admit(projectRoot, checkpointer, runId, request);
    // A DIFFERENT request (same shape, different body) must not be written.
    const other = validateQueryRequest({
      schema_version: 1,
      action: "query",
      kb_profile_id: PROFILE,
      query: "a different private body entirely",
      verify_grounding: false,
    });
    let error: unknown = null;
    try {
      materializeRunInput({
        projectRoot,
        checkpointer,
        runId,
        request: other,
        requestSha256: requestSha(request),
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(PrivateInputError);
    expect(existsSync(path.join(privateInputRoot(projectRoot), runId, "request.json"))).toBe(false);
    checkpointer.close();
  });
});

describe("§5.6 idempotency (session + invocation identity)", () => {
  it("rejects traversal, absolute, and non-exact indexed keys before creating a run", () => {
    const projectRoot = tmpRoot();
    const dbPath = path.join(projectRoot, ".penny", "orchestration-custody.db");
    const checkpointer = new Checkpointer(dbPath);
    const request = queryRequest();
    for (const [runId, keyOverrides] of [
      ["cust_bad_traversal", { storage_key: "../escape/request.json" }],
      ["cust_bad_absolute", { storage_key: "/tmp/escape.json" }],
      ["cust_bad_temp", { temporary_storage_key: "cust_bad_temp/not-indexed.tmp" }],
    ] as const) {
      expect(() =>
        admit(projectRoot, checkpointer, runId, request, `call-${runId}`, keyOverrides)
      ).toThrow(/private-input keys are not exact/);
      expect(checkpointer.runExists(runId)).toBe(false);
    }
    checkpointer.close();
  });

  it("same pair + same digest replays the ORIGINAL run with no second side effect", () => {
    const projectRoot = tmpRoot();
    const dbPath = path.join(projectRoot, ".penny", "orchestration-custody.db");
    const checkpointer = new Checkpointer(dbPath);
    const request = queryRequest();
    const runId = "cust_idem_1";
    admit(projectRoot, checkpointer, runId, request, "call-9");

    // A retry of the same invocation (fresh run id the host would mint) is a
    // replay of the original run; nothing new is created.
    const retry = admit(projectRoot, checkpointer, "cust_idem_1_retry", request, "call-9");
    expect(retry).toEqual({ kind: "replay", run_id: runId });
    expect(checkpointer.runExists("cust_idem_1_retry")).toBe(false);
    expect(checkpointer.getStartAdmission(runId)).toBeDefined();
    // Exactly ONE admission row for the pair.
    expect(checkpointer.getPrivateInput(runId)).toBeDefined();
    expect(checkpointer.getPrivateInput("cust_idem_1_retry")).toBeUndefined();
    checkpointer.close();
  });

  it("same pair + different digest is `idempotency_mismatch` and creates nothing", () => {
    const projectRoot = tmpRoot();
    const dbPath = path.join(projectRoot, ".penny", "orchestration-custody.db");
    const checkpointer = new Checkpointer(dbPath);
    const request = queryRequest();
    const runId = "cust_idem_2";
    admit(projectRoot, checkpointer, runId, request, "call-10");
    const other = validateQueryRequest({
      schema_version: 1,
      action: "query",
      kb_profile_id: PROFILE,
      query: "a MUTATED private body for the same invocation",
      verify_grounding: false,
    });
    let error: unknown = null;
    try {
      admit(projectRoot, checkpointer, "cust_idem_2_retry", other, "call-10");
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(StartAdmissionMismatchError);
    if (!(error instanceof StartAdmissionMismatchError)) {
      throw new Error("expected StartAdmissionMismatchError");
    }
    expect(error.code).toBe("idempotency_mismatch");
    expect(checkpointer.runExists("cust_idem_2_retry")).toBe(false);
    // The original survives untouched.
    expect(checkpointer.getStartAdmission(runId)?.state).toBe("running");
    checkpointer.close();
  });

  it("a different invocation for the same session and body is a fresh run", () => {
    const projectRoot = tmpRoot();
    const dbPath = path.join(projectRoot, ".penny", "orchestration-custody.db");
    const checkpointer = new Checkpointer(dbPath);
    const request = queryRequest();
    admit(projectRoot, checkpointer, "cust_idem_3a", request, "call-A");
    const fresh = admit(projectRoot, checkpointer, "cust_idem_3b", request, "call-B");
    expect(fresh.kind).toBe("created");
    expect(checkpointer.getStartAdmission("cust_idem_3b")?.invocation_id).toBe("call-B");
    checkpointer.close();
  });
});

describe("§5.6 terminal settlement and body containment", () => {
  it("settles active → terminal → discarding → discarded, removing only the exact bytes", () => {
    const projectRoot = tmpRoot();
    const dbPath = path.join(projectRoot, ".penny", "orchestration-custody.db");
    const checkpointer = new Checkpointer(dbPath);
    const request = queryRequest();
    const runId = "cust_set_1";
    admit(projectRoot, checkpointer, runId, request);
    materialize(projectRoot, checkpointer, runId, request);
    const finalPath = path.join(privateInputRoot(projectRoot), runId, "request.json");
    expect(existsSync(finalPath)).toBe(true);

    const resultId = "trm_set_1";
    checkpointer.settleStartAdmission(runId, {
      terminal_result_id: resultId,
      terminal_result_sha256: "a".repeat(64),
    });
    settleRunInput({ projectRoot, checkpointer, runId });

    // Metadata survives in both records; the body does not survive.
    const row = checkpointer.getPrivateInput(runId);
    expect(row?.state).toBe("discarded");
    expect(checkpointer.getStartAdmission(runId)?.state).toBe("terminal");
    expect(checkpointer.getStartAdmission(runId)?.terminal_result_id).toBe(resultId);
    expect(existsSync(finalPath)).toBe(false);
    expect(existsSync(path.dirname(finalPath))).toBe(false); // empty run dir removed
    expect(existsSync(privateInputRoot(projectRoot))).toBe(true); // root kept

    // Re-settlement is idempotent in both records.
    checkpointer.settleStartAdmission(runId, {
      terminal_result_id: resultId,
      terminal_result_sha256: "a".repeat(64),
    });
    settleRunInput({ projectRoot, checkpointer, runId });

    // Settling with a DIFFERENT terminal result is refused.
    expect(() =>
      checkpointer.settleStartAdmission(runId, {
        terminal_result_id: "trm_other",
        terminal_result_sha256: "b".repeat(64),
      })
    ).toThrow();
    checkpointer.close();
  });

  it("restart cleanup resumes after admission settlement but before byte deletion", () => {
    const projectRoot = tmpRoot();
    const dbPath = path.join(projectRoot, ".penny", "orchestration-custody.db");
    const checkpointer = new Checkpointer(dbPath);
    const request = queryRequest();
    const runId = "cust_set_crash";
    admit(projectRoot, checkpointer, runId, request);
    materialize(projectRoot, checkpointer, runId, request);
    const run = requireValue(
      checkpointer.loadRunById(runId),
      "apps/orchestration/tests/kb-private-inputs.test.ts:545"
    );
    const result = { action: "query", public_status: "complete", met: true };
    run.status = "complete";
    run.met = true;
    run.terminalDirective = {
      schema_version: 2,
      action: "complete",
      identity: run.identity,
      status: "complete",
      met: true,
      result,
      artifacts: [],
      unresolved: [],
    };
    checkpointer.saveRun(run, "query_terminal", { run_id: runId });
    const digest = sha256(canonicalJson(result));
    checkpointer.settleStartAdmission(runId, {
      terminal_result_id: "trm_crash",
      terminal_result_sha256: digest,
    });
    // Crash here: admission is terminal but the private file is still active.
    expect(checkpointer.getPrivateInput(runId)?.state).toBe("active");
    verifyAndSettleTerminalStart({ projectRoot, checkpointer, run });
    expect(checkpointer.getPrivateInput(runId)?.state).toBe("discarded");
    expect(existsSync(path.join(privateInputRoot(projectRoot), runId, "request.json"))).toBe(false);
    checkpointer.close();
  });

  it("settling a never-materialized input discards the exact indexed keys", () => {
    const projectRoot = tmpRoot();
    const dbPath = path.join(projectRoot, ".penny", "orchestration-custody.db");
    const checkpointer = new Checkpointer(dbPath);
    const request = queryRequest();
    const runId = "cust_set_2";
    admit(projectRoot, checkpointer, runId, request);
    settleRunInput({ projectRoot, checkpointer, runId });
    expect(checkpointer.getPrivateInput(runId)?.state).toBe("discarded");
    // The run directory was never created (nothing was ever written):
    // settlement discards the metadata, and no byte survives for the run.
    expect(existsSync(path.join(privateInputRoot(projectRoot), runId))).toBe(false);
    checkpointer.close();
  });

  it("the request body is in NO control-db file, snapshot, or event payload", () => {
    const projectRoot = tmpRoot();
    const dbPath = path.join(projectRoot, ".penny", "orchestration-custody.db");
    const checkpointer = new Checkpointer(dbPath);
    const request = queryRequest();
    const runId = "cust_leak_1";
    admit(projectRoot, checkpointer, runId, request);
    materialize(projectRoot, checkpointer, runId, request);
    settleRunInput({ projectRoot, checkpointer, runId });
    checkpointer.close();

    // Fresh handle (also proves the WAL state was durably written): the body
    // must not appear in the closed-then-reopened database bytes.
    const reopened = new Checkpointer(dbPath);
    reopened.bindKbRuntimeProjectRoot(projectRoot);
    try {
      const run = reopened.loadRunById(runId);
      expect(run).toBeDefined();
      for (const event of reopened.events(runId)) {
        expect(canonicalJson(event.payload)).not.toContain(QUERY_BODY);
        expect(event.eventType).not.toContain(QUERY_BODY);
      }
      expect(
        canonicalJson(
          requireValue(run, "apps/orchestration/tests/kb-private-inputs.test.ts:610").snapshot()
        )
      ).not.toContain(QUERY_BODY);
    } finally {
      reopened.close();
    }
    expect(dbBytes(projectRoot, "orchestration-custody.db")).not.toContain(QUERY_BODY);
  });

  it("host restart resumes the custody state from the index (WAL durably visible)", () => {
    const projectRoot = tmpRoot();
    const dbPath = path.join(projectRoot, ".penny", "orchestration-custody.db");
    const request = queryRequest();
    const runId = "cust_re_1";
    const first = new Checkpointer(dbPath);
    admit(projectRoot, first, runId, request);
    materialize(projectRoot, first, runId, request);
    first.close();

    // "Process 2": state must be fully visible from the shared file.
    const second = new Checkpointer(dbPath);
    try {
      expect(second.getPrivateInput(runId)?.state).toBe("active");
      const doc = requireRecord(
        readRunInput({ projectRoot, checkpointer: second, runId }),
        "reopened private run input"
      );
      expect(doc["query"]).toBe(QUERY_BODY);
    } finally {
      second.close();
    }
  });

  it("digest consistency: the adapter digest, KB canonicalization, and control DB agree", () => {
    const request = queryRequest();
    const adapterDigest = computeRequestSha256(request);
    const controlDigest = requestSha(request);
    const kbDigest = sha256Hex(kbCanonicalJson(request));
    expect(adapterDigest).toBe(controlDigest);
    expect(adapterDigest).toBe(kbDigest);
  });
});
