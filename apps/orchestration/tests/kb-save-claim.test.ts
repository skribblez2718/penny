import { errorCode } from "./helpers/narrowing.js";
/**
 * §5.6 save-query claim transactional ratchet, including synchronized
 * cross-process races, crash rollback, exact retries, and tamper refusal.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it } from "vitest";

import { SaveClaimError, SaveQueryClaimStore, saveClaimStoreDir } from "../src/kb/save-claim.js";
import { installTestProjectState } from "./fixtures/penny-state-fixture.js";
import { crashAuthorityTransaction, runAuthorityRace } from "./fixtures/authority-race-harness.js";

const dirs: string[] = [];
const stores: SaveQueryClaimStore[] = [];

function store(): SaveQueryClaimStore {
  const directory = mkdtempSync(path.join(tmpdir(), "penny-kb-claims-"));
  dirs.push(directory);
  const result = new SaveQueryClaimStore(directory);
  stores.push(result);
  return result;
}

afterEach(() => {
  for (const openStore of stores.splice(0)) openStore.close();
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const ANSWER = "a".repeat(64);
const OTHER = "b".repeat(64);
const BASE = {
  query_run_id: "run_query_1",
  kb_profile_id: "kbp_test",
  kb_id: "kb_test",
  answer_artifact_id: "art_answer_1",
  answer_sha256: ANSWER,
};
const SAVE = { save_run_id: "run_save_1", save_transaction_id: "tx_1" };

function database(pathname: string): import("node:sqlite").DatabaseSync {
  const module = process.getBuiltinModule("node:sqlite");
  if (module === undefined) throw new Error("node:sqlite is unavailable");
  return new module.DatabaseSync(pathname);
}

const CONSTRUCTOR_LOCK_HOLD_MS = 400;
const CHILD_WAIT_TIMEOUT_MS = 5_000;
const DELETE_READ_LOCK_CHILD = String.raw`
const databasePath = process.env.PENNY_CONSTRUCTOR_LOCK_DATABASE;
const holdText = process.env.PENNY_CONSTRUCTOR_LOCK_HOLD_MS;
if (databasePath === undefined || holdText === undefined || process.send === undefined) {
  throw new Error("constructor lock child is missing its closed inputs");
}
const holdMs = Number(holdText);
if (!Number.isSafeInteger(holdMs) || holdMs <= 0) {
  throw new Error("constructor lock child received an invalid hold duration");
}
const sqlite = process.getBuiltinModule("node:" + "sqlite");
if (sqlite === undefined) throw new Error("node:sqlite is unavailable");
const db = new sqlite.DatabaseSync(databasePath);
const journal = db.prepare("PRAGMA journal_mode").get();
if (journal?.journal_mode !== "delete") {
  throw new Error("constructor lock fixture is not in DELETE journal mode");
}
db.exec("BEGIN");
db.prepare("SELECT marker FROM constructor_lock").get();
process.send("locked");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
  process.exit(0);
}, holdMs);
`;

function spawnDeleteReadLock(databasePath: string): ChildProcess {
  return spawn(process.execPath, ["--input-type=module", "--eval", DELETE_READ_LOCK_CHILD], {
    env: {
      ...process.env,
      PENNY_CONSTRUCTOR_LOCK_DATABASE: databasePath,
      PENNY_CONSTRUCTOR_LOCK_HOLD_MS: String(CONSTRUCTOR_LOCK_HOLD_MS),
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

function waitForDeleteReadLock(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for the constructor lock child"));
    }, CHILD_WAIT_TIMEOUT_MS);
    const onMessage = (message: unknown): void => {
      cleanup();
      if (message === "locked") {
        resolve();
      } else {
        reject(new Error("constructor lock child sent an unexpected readiness message"));
      }
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("constructor lock child failed before acquiring its read lock"));
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error("constructor lock child exited before acquiring its read lock"));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.once("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForCleanChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return child.exitCode === 0
      ? Promise.resolve()
      : Promise.reject(new Error("constructor lock child exited unsuccessfully"));
  }
  if (child.signalCode !== null) {
    return Promise.reject(new Error("constructor lock child was terminated"));
  }
  return new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("constructor lock child failed during release")));
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) {
        resolve();
      } else {
        reject(new Error("constructor lock child did not release cleanly"));
      }
    });
  });
}

function claimed(claimStore: SaveQueryClaimStore) {
  claimStore.create(BASE);
  return claimStore.claimForSave({
    query_run_id: BASE.query_run_id,
    kb_profile_id: BASE.kb_profile_id,
    answer_sha256: ANSWER,
    ...SAVE,
  });
}

function workerBase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    queryRunId: BASE.query_run_id,
    profileId: BASE.kb_profile_id,
    kbId: BASE.kb_id,
    artifactId: BASE.answer_artifact_id,
    answerSha256: ANSWER,
    saveRunId: SAVE.save_run_id,
    transactionId: SAVE.save_transaction_id,
    ...overrides,
  };
}

describe("claim creation and custody", () => {
  it("creates one available indexed claim in an owner-only WAL/FULL database", () => {
    const claimStore = store();
    const claim = claimStore.create(BASE);
    expect(claim.state).toBe("available");
    expect(claim.answer_sha256).toBe(ANSWER);
    expect(statSync(claimStore.dir).mode & 0o777).toBe(0o700);
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = path.join(claimStore.dir, `claims.sqlite${suffix}`);
      try {
        expect(statSync(file).mode & 0o777).toBe(0o600);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
  });

  it("makes an exact create retry idempotent and rejects different immutable bytes", () => {
    const claimStore = store();
    const created = claimStore.create(BASE);
    expect(claimStore.create(BASE)).toEqual(created);
    expect(() =>
      claimStore.create({ ...BASE, answer_artifact_id: "art_different", answer_sha256: OTHER })
    ).toThrow(/different save claim/);
    expect(claimStore.load(BASE.query_run_id)).toEqual(created);
  });

  it("waits for a transient constructor read lock before enabling WAL", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "penny-kb-claims-constructor-lock-"));
    dirs.push(directory);
    chmodSync(directory, 0o700);
    const databasePath = path.join(directory, "claims.sqlite");
    const seed = database(databasePath);
    seed.exec(`
      PRAGMA journal_mode=DELETE;
      CREATE TABLE constructor_lock (marker TEXT NOT NULL);
      INSERT INTO constructor_lock (marker) VALUES ('held');
    `);
    seed.close();
    chmodSync(databasePath, 0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);

    const child = spawnDeleteReadLock(databasePath);
    await waitForDeleteReadLock(child);
    const startedAt = performance.now();
    let claimStore: SaveQueryClaimStore | undefined;
    let constructorError: unknown;
    try {
      claimStore = new SaveQueryClaimStore(directory);
    } catch (error) {
      constructorError = error;
    }
    const elapsedMs = performance.now() - startedAt;
    await waitForCleanChildExit(child);

    if (constructorError !== undefined) {
      const inspection = database(databasePath);
      const journal = inspection.prepare("PRAGMA journal_mode").get();
      const claimTable = inspection
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'save_query_claims'"
        )
        .get();
      inspection.close();
      expect(journal?.journal_mode).toBe("delete");
      expect(claimTable).toBeUndefined();
      expect(elapsedMs).toBeLessThan(CONSTRUCTOR_LOCK_HOLD_MS / 2);
      const message =
        constructorError instanceof Error ? constructorError.message : "non-Error failure";
      expect(message).toMatch(/database is locked/);
      throw new Error(
        `constructor reached WAL before busy handling after ${Math.round(elapsedMs)}ms`
      );
    }
    if (claimStore === undefined) throw new Error("constructor returned without a claim store");
    stores.push(claimStore);

    expect(elapsedMs).toBeGreaterThanOrEqual(CONSTRUCTOR_LOCK_HOLD_MS / 2);
    expect(elapsedMs).toBeLessThan(CHILD_WAIT_TIMEOUT_MS);
    const inspection = database(databasePath);
    const journal = inspection.prepare("PRAGMA journal_mode").get();
    const synchronous = inspection.prepare("PRAGMA synchronous").get();
    const claimTable = inspection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'save_query_claims'")
      .get();
    const claimCount = inspection.prepare("SELECT COUNT(*) AS count FROM save_query_claims").get();
    inspection.exec("BEGIN IMMEDIATE; ROLLBACK;");
    inspection.close();
    expect(journal?.journal_mode).toBe("wal");
    expect(synchronous?.synchronous).toBe(2);
    expect(claimTable?.name).toBe("save_query_claims");
    expect(claimCount?.count).toBe(0);
    expect(claimStore.create(BASE).state).toBe("available");
    expect(claimStore.load(BASE.query_run_id).answer_sha256).toBe(ANSWER);
  });

  it("synchronizes multiprocess exact and competing creates", async () => {
    const exactStore = store();
    const exactDir = exactStore.dir;
    exactStore.close();
    const exact = await runAuthorityRace([
      { operation: "save-create", storeDir: exactDir, input: workerBase() },
      { operation: "save-create", storeDir: exactDir, input: workerBase() },
    ]);
    expect(exact.every((result) => result.ok === true)).toBe(true);
    const exactReopened = new SaveQueryClaimStore(exactDir);
    expect(exactReopened.load(BASE.query_run_id).state).toBe("available");
    exactReopened.close();

    const competingStore = store();
    const competingDir = competingStore.dir;
    competingStore.close();
    const competing = await runAuthorityRace([
      { operation: "save-create", storeDir: competingDir, input: workerBase() },
      {
        operation: "save-create",
        storeDir: competingDir,
        input: workerBase({ artifactId: "art_competing", answerSha256: OTHER }),
      },
    ]);
    expect(competing.filter((result) => result.ok === true)).toHaveLength(1);
    expect(competing.filter((result) => result.ok === false)).toHaveLength(1);
  });

  it("fails closed for missing, logically tampered, broad-mode, and legacy rows", () => {
    const claimStore = store();
    expect(() => claimStore.load("run_absent")).toThrow(SaveClaimError);
    expect(claimStore.find("run_absent")).toBeUndefined();

    claimStore.create(BASE);
    const db = database(path.join(claimStore.dir, "claims.sqlite"));
    db.prepare("UPDATE save_query_claims SET answer_sha256 = ? WHERE query_run_id = ?").run(
      OTHER,
      BASE.query_run_id
    );
    db.close();
    expect(() => claimStore.load(BASE.query_run_id)).toThrow(/digest mismatch/);
    expect(claimStore.find(BASE.query_run_id)).toBeUndefined();

    const broad = store();
    chmodSync(path.join(broad.dir, "claims.sqlite"), 0o666);
    expect(() => broad.load("anything")).toThrow(/exactly 0600/);

    const legacy = store();
    writeFileSync(path.join(legacy.dir, `${BASE.query_run_id}.json`), "{}", { mode: 0o600 });
    expect(() => legacy.load(BASE.query_run_id)).toThrow(/scan\/adoption is forbidden/);
  });
});

describe("claiming for save", () => {
  it("CASes available → claimed and makes only the exact run/transaction retry idempotent", () => {
    const claimStore = store();
    const claim = claimed(claimStore);
    expect(claim).toMatchObject({
      state: "claimed",
      save_run_id: "run_save_1",
      save_transaction_id: "tx_1",
    });
    expect(
      claimStore.claimForSave({
        query_run_id: BASE.query_run_id,
        kb_profile_id: BASE.kb_profile_id,
        answer_sha256: ANSWER,
        ...SAVE,
      })
    ).toEqual(claim);
    expect(() =>
      claimStore.claimForSave({
        query_run_id: BASE.query_run_id,
        kb_profile_id: BASE.kb_profile_id,
        answer_sha256: ANSWER,
        save_run_id: "run_save_2",
        save_transaction_id: "tx_2",
      })
    ).toThrow(/another save run or transaction/);
  });

  it("synchronizes competing multiprocess claims so exactly one owner wins", async () => {
    const claimStore = store();
    claimStore.create(BASE);
    const directory = claimStore.dir;
    claimStore.close();
    const results = await runAuthorityRace([
      { operation: "save-claim", storeDir: directory, input: workerBase() },
      {
        operation: "save-claim",
        storeDir: directory,
        input: workerBase({ saveRunId: "run_save_2", transactionId: "tx_2" }),
      },
    ]);
    expect(results.filter((result) => result.ok === true)).toHaveLength(1);
    expect(results.filter((result) => result.ok === false)).toHaveLength(1);
    const reopened = new SaveQueryClaimStore(directory);
    expect(["run_save_1", "run_save_2"]).toContain(reopened.load(BASE.query_run_id).save_run_id);
    reopened.close();
  });

  it("refuses cross-profile use and invalidates exact answer drift", () => {
    const crossProfile = store();
    crossProfile.create(BASE);
    expect(() =>
      crossProfile.claimForSave({
        query_run_id: BASE.query_run_id,
        kb_profile_id: "kbp_other",
        answer_sha256: ANSWER,
        ...SAVE,
      })
    ).toThrow(/different KB profile/);

    const drifted = store();
    drifted.create(BASE);
    expect(() =>
      drifted.claimForSave({
        query_run_id: BASE.query_run_id,
        kb_profile_id: BASE.kb_profile_id,
        answer_sha256: OTHER,
        ...SAVE,
      })
    ).toThrow(/changed since its claim/);
    expect(drifted.load(BASE.query_run_id).state).toBe("invalidated");
  });

  it("rolls an uncommitted claim back after process death", async () => {
    const claimStore = store();
    claimStore.create(BASE);
    const directory = claimStore.dir;
    claimStore.close();
    await crashAuthorityTransaction({
      operation: "save-crash-uncommitted",
      storeDir: directory,
      input: workerBase(),
    });
    const reopened = new SaveQueryClaimStore(directory);
    expect(reopened.load(BASE.query_run_id).state).toBe("available");
    expect(
      reopened.claimForSave({
        query_run_id: BASE.query_run_id,
        kb_profile_id: BASE.kb_profile_id,
        answer_sha256: ANSWER,
        ...SAVE,
      }).state
    ).toBe("claimed");
    reopened.close();
  });
});

describe("reserve and consume ratchet", () => {
  it("synchronizes exact reserve retries while a competing run loses", async () => {
    const claimStore = store();
    claimed(claimStore);
    const directory = claimStore.dir;
    claimStore.close();
    const results = await runAuthorityRace([
      { operation: "save-reserve", storeDir: directory, input: workerBase() },
      {
        operation: "save-reserve",
        storeDir: directory,
        input: workerBase({ saveRunId: "run_save_2" }),
      },
    ]);
    expect(results.filter((result) => result.ok === true)).toHaveLength(1);
    expect(results.filter((result) => result.ok === false)).toHaveLength(1);
    const reopened = new SaveQueryClaimStore(directory);
    expect(reopened.load(BASE.query_run_id).state).toBe("commit_reserved");
    expect(
      reopened.reserveCommit({ query_run_id: BASE.query_run_id, save_run_id: SAVE.save_run_id })
        .state
    ).toBe("commit_reserved");
    reopened.close();
  });

  it("synchronizes exact consume retries and rejects a competing run", async () => {
    const claimStore = store();
    claimed(claimStore);
    claimStore.reserveCommit({ query_run_id: BASE.query_run_id, save_run_id: SAVE.save_run_id });
    const directory = claimStore.dir;
    claimStore.close();
    const exact = await runAuthorityRace([
      { operation: "save-consume", storeDir: directory, input: workerBase() },
      { operation: "save-consume", storeDir: directory, input: workerBase() },
    ]);
    expect(exact.every((result) => result.ok === true)).toBe(true);
    const reopened = new SaveQueryClaimStore(directory);
    expect(reopened.load(BASE.query_run_id).state).toBe("consumed");
    expect(() =>
      reopened.consume({ query_run_id: BASE.query_run_id, save_run_id: "run_save_2" })
    ).toThrow(/different save run/);
    expect(reopened.invalidate(BASE.query_run_id).state).toBe("consumed");
    reopened.close();
  });

  it("refuses consumption without reserve and never releases commit_reserved", () => {
    const unreserved = store();
    claimed(unreserved);
    expect(() =>
      unreserved.consume({ query_run_id: BASE.query_run_id, save_run_id: SAVE.save_run_id })
    ).toThrow(/commit_reserved/);

    const reserved = store();
    claimed(reserved);
    reserved.reserveCommit({ query_run_id: BASE.query_run_id, save_run_id: SAVE.save_run_id });
    expect(() =>
      reserved.release({
        query_run_id: BASE.query_run_id,
        save_run_id: SAVE.save_run_id,
        answer_sha256: ANSWER,
      })
    ).toThrow(/cannot be released/);
    expect(reserved.invalidate(BASE.query_run_id, SAVE.save_run_id).state).toBe("invalidated");
  });
});

describe("release after deny, error, or cancellation", () => {
  it("synchronizes exact release retries and then permits a later owner", async () => {
    const claimStore = store();
    claimed(claimStore);
    const directory = claimStore.dir;
    claimStore.close();
    const released = await runAuthorityRace([
      { operation: "save-release", storeDir: directory, input: workerBase() },
      { operation: "save-release", storeDir: directory, input: workerBase() },
    ]);
    expect(released.every((result) => result.ok === true)).toBe(true);

    const reopened = new SaveQueryClaimStore(directory);
    const available = reopened.load(BASE.query_run_id);
    expect(available.state).toBe("available");
    expect(available.save_run_id).toBeUndefined();
    expect(available.save_transaction_id).toBeUndefined();
    expect(
      reopened.claimForSave({
        query_run_id: BASE.query_run_id,
        kb_profile_id: BASE.kb_profile_id,
        answer_sha256: ANSWER,
        save_run_id: "run_save_2",
        save_transaction_id: "tx_2",
      }).save_run_id
    ).toBe("run_save_2");
    reopened.close();
  });

  it("lets the exact release beat a competing wrong run and invalidates on answer drift", async () => {
    const claimStore = store();
    claimed(claimStore);
    const directory = claimStore.dir;
    claimStore.close();
    const results = await runAuthorityRace([
      { operation: "save-release", storeDir: directory, input: workerBase() },
      {
        operation: "save-release",
        storeDir: directory,
        input: workerBase({ saveRunId: "run_save_2" }),
      },
    ]);
    expect(results.filter((result) => result.ok === true)).toHaveLength(1);
    expect(results.filter((result) => result.ok === false)).toHaveLength(1);

    const drifted = store();
    claimed(drifted);
    expect(
      drifted.release({
        query_run_id: BASE.query_run_id,
        save_run_id: SAVE.save_run_id,
        answer_sha256: OTHER,
      }).state
    ).toBe("invalidated");
    expect(
      drifted.release({
        query_run_id: BASE.query_run_id,
        save_run_id: SAVE.save_run_id,
        answer_sha256: OTHER,
      }).state
    ).toBe("invalidated");
  });
});

describe("store location", () => {
  it("uses the catalog-bound host-control partition outside the KB publication root", () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "penny-kb-claims-project-"));
    dirs.push(projectRoot);
    const state = installTestProjectState(projectRoot);
    const directory = saveClaimStoreDir(projectRoot, "kbp_demo");
    expect(directory).toBe(path.join(state.paths.knowledgeBase.saveClaims, "kbp_demo"));
    expect(directory.startsWith(projectRoot)).toBe(false);
  });
});
