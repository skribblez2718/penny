import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, it } from "vitest";

import { ParentDeliveryGrantStore } from "../../src/kb/parent-delivery.js";
import { KbSessionProfileGrantStore } from "../../src/kb/profile-grants.js";
import { SaveQueryClaimStore } from "../../src/kb/save-claim.js";
import type { ParentDeliveryGrant, Sha256Hex } from "../../src/kb/contracts.js";

interface WorkerJob {
  readonly operation: string;
  readonly storeDir: string;
  readonly readyPath: string;
  readonly resultPath: string;
  readonly goPath: string;
  readonly input: Record<string, unknown>;
}

const rawJob = process.env.PENNY_AUTHORITY_WORKER_JOB;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForGo(pathname: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!existsSync(pathname)) {
    if (Date.now() >= deadline) throw new Error("authority race worker timed out at barrier");
    await delay(5);
  }
}

function database(pathname: string): import("node:sqlite").DatabaseSync {
  const module = process.getBuiltinModule("node:" + "sqlite") as
    | typeof import("node:sqlite")
    | undefined;
  if (module === undefined) throw new Error("node:sqlite is unavailable");
  return new module.DatabaseSync(pathname);
}

function required(job: WorkerJob, field: string): string {
  const value = job.input[field];
  if (typeof value !== "string") throw new Error(`worker input '${field}' is required`);
  return value;
}

describe("authority race subprocess", () => {
  it.skipIf(rawJob === undefined)("executes one synchronized store operation", async () => {
    const job = JSON.parse(rawJob!) as WorkerJob;

    if (job.operation === "parent-crash-uncommitted") {
      const db = database(path.join(job.storeDir, "grants.sqlite"));
      db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;");
      db.prepare(
        "UPDATE parent_delivery_grants SET state = 'consumed', run_id = ? WHERE grant_id = ?"
      ).run(required(job, "runId"), required(job, "grantId"));
      writeFileSync(job.readyPath, "ready", { mode: 0o600 });
      await new Promise(() => undefined);
      return;
    }
    if (job.operation === "profile-crash-uncommitted") {
      const db = database(path.join(job.storeDir, "grants.sqlite"));
      db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;");
      const grant = db
        .prepare("SELECT grant_id, grant_sha256 FROM profile_session_grants WHERE grant_id = ?")
        .get(required(job, "grantId")) as { grant_id: string; grant_sha256: string } | undefined;
      if (grant === undefined) throw new Error("profile crash grant is absent");
      db.prepare(
        `INSERT INTO profile_session_grant_uses (
           session_id, invocation_id, grant_id, grant_sha256, kb_profile_id,
           action, request_sha256, policy_sha256, consumed_at, use_sha256
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        required(job, "session_id"),
        required(job, "invocation_id"),
        grant.grant_id,
        grant.grant_sha256,
        required(job, "kb_profile_id"),
        required(job, "action"),
        required(job, "request_sha256"),
        job.input.policy_sha256 ?? null,
        new Date().toISOString(),
        "0".repeat(64)
      );
      writeFileSync(job.readyPath, "ready", { mode: 0o600 });
      await new Promise(() => undefined);
      return;
    }
    if (job.operation === "save-crash-uncommitted") {
      const db = database(path.join(job.storeDir, "claims.sqlite"));
      db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;");
      db.prepare(
        `UPDATE save_query_claims
         SET state = 'claimed', save_run_id = ?, save_transaction_id = ?
         WHERE query_run_id = ?`
      ).run(
        required(job, "saveRunId"),
        required(job, "transactionId"),
        required(job, "queryRunId")
      );
      writeFileSync(job.readyPath, "ready", { mode: 0o600 });
      await new Promise(() => undefined);
      return;
    }

    let close: (() => void) | undefined;
    let operation: () => unknown;
    if (job.operation.startsWith("profile-")) {
      const store = new KbSessionProfileGrantStore(job.storeDir);
      close = () => store.close();
      operation = () => {
        if (job.operation === "profile-mint") {
          return store.mint({
            session_id: required(job, "session_id"),
            kb_profile_id: required(job, "kb_profile_id"),
            issued_at: required(job, "issued_at"),
            expires_at: required(job, "expires_at"),
            grant_id: required(job, "grant_id"),
          });
        }
        if (job.operation === "profile-read") {
          const sessionId = required(job, "sessionId");
          const profileId = required(job, "profileId");
          return { allowed: store.allowedProfiles(sessionId).has(profileId) };
        }
        if (job.operation === "profile-consume") {
          return store.consume({
            session_id: required(job, "session_id"),
            invocation_id: required(job, "invocation_id"),
            kb_profile_id: required(job, "kb_profile_id"),
            action: required(job, "action") as
              | "init"
              | "ingest"
              | "query"
              | "save"
              | "lint"
              | "promote"
              | "status"
              | "resume",
            request_sha256: required(job, "request_sha256") as Sha256Hex,
            policy_sha256:
              job.input.policy_sha256 === null
                ? null
                : (required(job, "policy_sha256") as Sha256Hex),
          });
        }
        if (job.operation === "profile-expire") {
          return store.expire(required(job, "grantId"), new Date(required(job, "now")));
        }
        throw new Error(`unknown profile worker operation '${job.operation}'`);
      };
    } else if (job.operation.startsWith("parent-")) {
      const store = new ParentDeliveryGrantStore(job.storeDir);
      close = () => store.close();
      operation = () => {
        if (job.operation === "parent-mint") {
          store.mint(job.input.grant as unknown as ParentDeliveryGrant);
          return store.load(required(job, "grantId"));
        }
        if (job.operation === "parent-consume") {
          return store.consume(required(job, "grantId"), required(job, "runId"));
        }
        if (job.operation === "parent-expire") {
          return store.expire(required(job, "grantId"), new Date(required(job, "now")));
        }
        throw new Error(`unknown parent worker operation '${job.operation}'`);
      };
    } else {
      const store = new SaveQueryClaimStore(job.storeDir);
      close = () => store.close();
      operation = () => {
        if (job.operation === "save-create") {
          return store.create({
            query_run_id: required(job, "queryRunId"),
            kb_profile_id: required(job, "profileId"),
            kb_id: required(job, "kbId"),
            answer_artifact_id: required(job, "artifactId"),
            answer_sha256: required(job, "answerSha256") as Sha256Hex,
          });
        }
        if (job.operation === "save-claim") {
          return store.claimForSave({
            query_run_id: required(job, "queryRunId"),
            kb_profile_id: required(job, "profileId"),
            save_run_id: required(job, "saveRunId"),
            save_transaction_id: required(job, "transactionId"),
            answer_sha256: required(job, "answerSha256") as Sha256Hex,
          });
        }
        if (job.operation === "save-reserve") {
          return store.reserveCommit({
            query_run_id: required(job, "queryRunId"),
            save_run_id: required(job, "saveRunId"),
          });
        }
        if (job.operation === "save-consume") {
          return store.consume({
            query_run_id: required(job, "queryRunId"),
            save_run_id: required(job, "saveRunId"),
          });
        }
        if (job.operation === "save-release") {
          return store.release({
            query_run_id: required(job, "queryRunId"),
            save_run_id: required(job, "saveRunId"),
            answer_sha256: job.input.answerSha256 as Sha256Hex | undefined,
          });
        }
        throw new Error(`unknown save worker operation '${job.operation}'`);
      };
    }

    writeFileSync(job.readyPath, "ready", { mode: 0o600 });
    await waitForGo(job.goPath);
    let result: Record<string, unknown>;
    try {
      result = { ok: true, value: operation() };
    } catch (error) {
      result = {
        ok: false,
        name: (error as Error).name,
        message: (error as Error).message,
        ...("code" in (error as object)
          ? { errorCode: (error as Error & { code?: string }).code }
          : {}),
      };
    } finally {
      close?.();
    }
    writeFileSync(job.resultPath, JSON.stringify(result), { mode: 0o600 });
  });
});
