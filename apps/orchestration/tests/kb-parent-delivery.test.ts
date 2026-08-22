/**
 * Parent-answer delivery grants (§5.1 / §5.6) — the exact request/grant/policy
 * binding, atomic single-use consumption, bounded refusal codes, and store
 * integrity. The parent result carries ONE public code (`refused_parent_delivery`)
 * on any miss; the reason codes here are host-side assertions.
 *
 * These tests are host-side: no KB content plane, no private bodies, no engine
 * run. The adapter wiring (host-context pairing) is covered where it lives.
 */

import { chmodSync, lstatSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ParentDeliveryGrantStore,
  REFUSED_PARENT_DELIVERY,
  buildKbHostInvocationContext,
  computeRequestSha256,
  evaluateParentDelivery,
  mintParentDeliveryGrant,
  validateQueryRequest,
} from "../src/kb/parent-delivery.js";
import {
  defaultDenyPolicy,
  canonicalJson,
  sha256Hex,
  validateKbHostInvocationContext,
  type KbPolicy,
  type QueryKbRequest,
} from "../src/kb/contracts.js";
import { KbSessionProfileGrantStore } from "../src/kb/profile-grants.js";
import { crashAuthorityTransaction, runAuthorityRace } from "./fixtures/authority-race-harness.js";

const PROFILE = "kbp_parent_grant";
const SESSION = "sess_op_1";
const INVOCATION = "inv_op_1";
const RUN_ID = "kb-run-parent-1";
// Relative to the live clock so the suite is never flaky on time.
const NOW = Date.now();
const LATER = new Date(NOW + 30 * 60_000).toISOString();
const PAST = new Date(NOW - 60_000).toISOString();
const HOST = { session_id: SESSION, invocation_id: INVOCATION };
// §5.3: the exact provider/model the runtime reports for the active parent.
// This suite pins the GRANT binding matrix, so it holds the parent identity and
// grounding verification fixed; those two gates are pinned in kb-answer-quality.
const PARENT = { provider: "ollama", model: "qwen327b:latest" };

function database(pathname: string): import("node:sqlite").DatabaseSync {
  const module = process.getBuiltinModule("node:" + "sqlite") as
    | typeof import("node:sqlite")
    | undefined;
  if (module === undefined) throw new Error("node:sqlite is unavailable");
  return new module.DatabaseSync(pathname);
}

function baseRequest(overrides: Record<string, unknown> = {}): QueryKbRequest {
  return validateQueryRequest({
    schema_version: 1,
    action: "query",
    kb_profile_id: PROFILE,
    query: "What did we decide about the gate ladder?",
    answer_delivery: "parent_tool_result",
    ...overrides,
  });
}

function allowingPolicy(maxUtf8Bytes = 8192): KbPolicy {
  return {
    ...defaultDenyPolicy("kbp-parent-grant-test"),
    allowed_parent_models: [{ ...PARENT, locality: "local" }],
    parent_result: {
      derived_query_answer: "allow_explicit_derived_answer",
      max_utf8_bytes: maxUtf8Bytes,
    },
  };
}

function grantFor(
  request: QueryKbRequest,
  overrides: Record<string, unknown> = {},
  policy: KbPolicy = allowingPolicy()
): { grant; store; file } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kb-parent-grant-"));
  const store = new ParentDeliveryGrantStore(dir);
  const grant = mintParentDeliveryGrant({
    session_id: SESSION,
    invocation_id: INVOCATION,
    request,
    policy_sha256: sha256Hex(canonicalJson(policy)),
    parent_provider: PARENT.provider,
    parent_model: PARENT.model,
    max_utf8_bytes: 4096,
    issued_at: new Date(NOW - 3_600_000).toISOString(),
    expires_at: LATER,
    ...overrides,
  });
  store.mint(grant);
  const file = store.load(grant.grant_id);
  return { grant, store, file };
}

describe("KB host invocation context boundary (§5.1)", () => {
  it("constructs one closed context and derives locality only from the exact policy rule", () => {
    const request = baseRequest();
    const policy = allowingPolicy();
    const { grant } = grantFor(request, {}, policy);
    const context = buildKbHostInvocationContext({
      sessionId: SESSION,
      invocationId: INVOCATION,
      parentIdentity: PARENT,
      currentPolicy: policy,
      allowedProfileIds: [PROFILE],
      request,
      parentDeliveryGrant: grant,
      now: NOW,
    });
    expect(context).toEqual({
      schema_version: 1,
      session_id: SESSION,
      invocation_id: INVOCATION,
      parent_provider: PARENT.provider,
      parent_model: PARENT.model,
      parent_locality: "local",
      allowed_kb_profile_ids: [PROFILE],
      parent_delivery_grant: grant,
    });
    expect(() =>
      validateKbHostInvocationContext({ ...context, model_visible_authority: true })
    ).toThrow();

    const remotePolicy = {
      ...policy,
      processing_mode: "provider_permitted" as const,
      allowed_parent_models: [{ ...PARENT, locality: "remote" as const }],
    };
    const remote = buildKbHostInvocationContext({
      sessionId: SESSION,
      invocationId: INVOCATION,
      parentIdentity: PARENT,
      currentPolicy: remotePolicy,
      allowedProfileIds: [PROFILE],
      request: { ...request, answer_delivery: "artifact_ref" },
      now: NOW,
    });
    expect(remote.parent_locality).toBe("remote");
    expect(() =>
      buildKbHostInvocationContext({
        sessionId: SESSION,
        invocationId: INVOCATION,
        parentIdentity: { ...PARENT, model: ` ${PARENT.model}` },
        currentPolicy: policy,
        allowedProfileIds: [PROFILE],
        request,
        now: NOW,
      })
    ).toThrow(/allowlist/i);
  });

  it("rejects profile, request, policy, and parent tuple drift in the bundled grant", () => {
    const request = baseRequest();
    const policy = allowingPolicy();
    const { grant } = grantFor(request, {}, policy);
    const base = {
      sessionId: SESSION,
      invocationId: INVOCATION,
      parentIdentity: PARENT,
      currentPolicy: policy,
      allowedProfileIds: [PROFILE],
      request,
      parentDeliveryGrant: grant,
      now: NOW,
    };
    expect(() =>
      buildKbHostInvocationContext({ ...base, allowedProfileIds: ["another_profile"] })
    ).toThrow(/requested profile/i);
    expect(() =>
      buildKbHostInvocationContext({
        ...base,
        currentPolicy: { ...policy, parent_result: { ...policy.parent_result, max_utf8_bytes: 7 } },
      })
    ).toThrow(/grant/i);
    expect(() =>
      buildKbHostInvocationContext({
        ...base,
        parentDeliveryGrant: { ...grant, parent_model: "another-model" },
      })
    ).toThrow(/host invocation|provider\/model/i);
  });
});

describe("parent delivery — request canonicalization (§5.6)", () => {
  it("binds SHA-256(JCS(request)) and is independent of key order", () => {
    const a = baseRequest();
    const b = validateQueryRequest(
      Object.fromEntries(
        Object.keys(a)
          .sort((x, y) => y.localeCompare(x))
          .map((k) => [k, (a as unknown as Record<string, unknown>)[k]])
      )
    );
    expect(computeRequestSha256(a)).toEqual(computeRequestSha256(b));
    expect(computeRequestSha256(a)).toBe(sha256Hex(canonicalJson(a)));
    // A different query is a different digest.
    const c = baseRequest({ query: "a different question" });
    expect(computeRequestSha256(c)).not.toEqual(computeRequestSha256(a));
  });

  it("admits closed requests and refuses open/malformed ones", () => {
    expect(baseRequest()).toBeDefined();
    // extra key
    expect(() =>
      validateQueryRequest({ ...baseRequest(), page_ids: ["x"] as never, extra: 1 })
    ).toThrow();
    // wrong action
    expect(() => validateQueryRequest({ ...baseRequest(), action: "save" })).toThrow();
    // empty/oversized query
    expect(() => validateQueryRequest({ ...baseRequest(), query: "" })).toThrow();
    expect(() => validateQueryRequest({ ...baseRequest(), query: "x".repeat(32_769) })).toThrow();
    // bad answer_delivery
    expect(() =>
      validateQueryRequest({ ...baseRequest(), answer_delivery: "parent_tool_result!" })
    ).toThrow();
  });
});

describe("parent delivery — eligibility matrix", () => {
  it("admits on an exact grant and uses the lesser of grant and policy caps", () => {
    const request = baseRequest();
    const policy = allowingPolicy(8192);
    const { file } = grantFor(request);
    const out = evaluateParentDelivery({
      grant: file,
      parentIdentity: PARENT,
      request,
      host: { session_id: SESSION, invocation_id: INVOCATION },
      policy,
      answerUtf8Bytes: 4096,
      groundingVerified: true,
      now: NOW,
    });
    expect(out).toEqual({ status: "eligible", byte_cap: 4096 }); // min(4096 grant, 8192 policy)

    // policy cap lower than grant: a grant minted over that exact policy uses
    // the lower policy bound.
    const tighter = allowingPolicy(1024);
    const { file: tighterFile } = grantFor(request, { grant_id: "pgt-tighter" }, tighter);
    const out2 = evaluateParentDelivery({
      grant: tighterFile,
      parentIdentity: PARENT,
      request,
      host: { session_id: SESSION, invocation_id: INVOCATION },
      policy: tighter,
      answerUtf8Bytes: 1024,
      groundingVerified: true,
      now: NOW,
    });
    expect(out2).toEqual({ status: "eligible", byte_cap: 1024 });
  });

  it("refuses with bounded host reasons (never a silent content return)", () => {
    const request = baseRequest();
    const { file } = grantFor(request);
    const policy = allowingPolicy();
    const base = {
      request,
      policy,
      answerUtf8Bytes: 100,
      groundingVerified: true,
      now: NOW,
      host: HOST,
      parentIdentity: PARENT,
    };

    expect(evaluateParentDelivery({ ...base, grant: null })).toMatchObject({
      status: "refused",
      public_code: REFUSED_PARENT_DELIVERY,
      reason_code: "grant_missing",
    });
    expect(
      evaluateParentDelivery({
        ...base,
        grant: file,
        host: { session_id: "sess_other", invocation_id: INVOCATION },
      })
    ).toMatchObject({
      status: "refused",
      reason_code: "grant_mismatch_session",
    });
    expect(
      evaluateParentDelivery({
        ...base,
        grant: file,
        host: { session_id: SESSION, invocation_id: "inv_other" },
      })
    ).toMatchObject({
      status: "refused",
      reason_code: "grant_mismatch_invocation",
    });
    expect(
      evaluateParentDelivery({
        ...base,
        grant: file,
        request: baseRequest({ kb_profile_id: "kbp_other" }),
      })
    ).toMatchObject({
      status: "refused",
      reason_code: "grant_mismatch_profile",
    });
    expect(
      evaluateParentDelivery({
        ...base,
        grant: file,
        request: baseRequest({ query: "a different question" }),
      })
    ).toMatchObject({ status: "refused", reason_code: "grant_mismatch_request_digest" });
    expect(
      evaluateParentDelivery({ ...base, grant: file, policy: defaultDenyPolicy("kbp-x") })
    ).toMatchObject({
      status: "refused",
      reason_code: "grant_mismatch_policy",
    });
    const deniedPolicy = defaultDenyPolicy("kbp-x");
    const { file: deniedFile } = grantFor(request, { grant_id: "pgt-policy-denied" }, deniedPolicy);
    expect(
      evaluateParentDelivery({ ...base, grant: deniedFile, policy: deniedPolicy })
    ).toMatchObject({
      status: "refused",
      reason_code: "policy_denies",
    });
    expect(
      evaluateParentDelivery({
        ...base,
        grant: file,
        parentIdentity: { provider: PARENT.provider, model: "another-model" },
      })
    ).toMatchObject({ status: "refused", reason_code: "grant_mismatch_parent_model" });
    expect(evaluateParentDelivery({ ...base, grant: file, answerUtf8Bytes: 4097 })).toMatchObject({
      status: "refused",
      reason_code: "answer_exceeds_byte_cap",
    });
    // expiry: a grant whose window has passed
    const { file: expiredFile } = grantFor(request, { expires_at: PAST });
    expect(evaluateParentDelivery({ ...base, grant: expiredFile })).toMatchObject({
      status: "refused",
      reason_code: "grant_expired",
    });
  });
});

describe("parent delivery — transactional single-use and store integrity", () => {
  it("co-locates profile-session and parent-delivery tables in one WAL/FULL authority", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kb-shared-host-grants-"));
    const profileStore = new KbSessionProfileGrantStore(dir);
    const profileGrant = profileStore.mint({
      session_id: SESSION,
      kb_profile_id: PROFILE,
      issued_at: new Date(NOW - 1_000).toISOString(),
      expires_at: LATER,
      grant_id: "kpg-shared-authority",
    });
    profileStore.close();

    const parentStore = new ParentDeliveryGrantStore(dir);
    const parentGrant = mintParentDeliveryGrant({
      session_id: SESSION,
      invocation_id: INVOCATION,
      request: baseRequest(),
      policy_sha256: sha256Hex(canonicalJson(allowingPolicy())),
      parent_provider: PARENT.provider,
      parent_model: PARENT.model,
      max_utf8_bytes: 4096,
      issued_at: new Date(NOW - 1_000).toISOString(),
      expires_at: LATER,
      grant_id: "pgt-shared-authority",
    });
    parentStore.mint(parentGrant);
    parentStore.close();

    const db = database(path.join(dir, "grants.sqlite"));
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('profile_session_grants','parent_delivery_grants')
         ORDER BY name`
      )
      .all()
      .map((row) => String(row.name));
    expect(tables).toEqual(["parent_delivery_grants", "profile_session_grants"]);
    expect(Number(db.prepare("PRAGMA synchronous").get()?.synchronous)).toBe(2);
    db.close();

    const reopenedProfile = new KbSessionProfileGrantStore(dir);
    expect(reopenedProfile.load(profileGrant.grant_id).grant).toEqual(profileGrant);
    reopenedProfile.close();
    const reopenedParent = new ParentDeliveryGrantStore(dir);
    expect(reopenedParent.load(parentGrant.grant_id).grant).toEqual(parentGrant);
    reopenedParent.close();
  });

  it("synchronizes issuance so only an exact idempotent retry can share an invocation", async () => {
    const exactRoot = mkdtempSync(path.join(os.tmpdir(), "kb-parent-issue-exact-"));
    new ParentDeliveryGrantStore(exactRoot).close();
    const exactGrant = mintParentDeliveryGrant({
      session_id: SESSION,
      invocation_id: "inv-issue-exact",
      request: baseRequest(),
      policy_sha256: sha256Hex(canonicalJson(allowingPolicy())),
      parent_provider: PARENT.provider,
      parent_model: PARENT.model,
      max_utf8_bytes: 4096,
      issued_at: new Date(NOW - 1_000).toISOString(),
      expires_at: LATER,
      grant_id: "pgt-issue-exact",
    });
    const exact = await runAuthorityRace([
      {
        operation: "parent-mint",
        storeDir: exactRoot,
        input: { grant: exactGrant, grantId: exactGrant.grant_id },
      },
      {
        operation: "parent-mint",
        storeDir: exactRoot,
        input: { grant: exactGrant, grantId: exactGrant.grant_id },
      },
    ]);
    expect(exact.every((result) => result.ok === true)).toBe(true);

    const competingRoot = mkdtempSync(path.join(os.tmpdir(), "kb-parent-issue-race-"));
    new ParentDeliveryGrantStore(competingRoot).close();
    const competitor = (grantId: string) => ({ ...exactGrant, grant_id: grantId });
    const competing = await runAuthorityRace([
      {
        operation: "parent-mint",
        storeDir: competingRoot,
        input: { grant: competitor("pgt-issue-a"), grantId: "pgt-issue-a" },
      },
      {
        operation: "parent-mint",
        storeDir: competingRoot,
        input: { grant: competitor("pgt-issue-b"), grantId: "pgt-issue-b" },
      },
    ]);
    expect(competing.filter((result) => result.ok === true)).toHaveLength(1);
    expect(competing.filter((result) => result.ok === false)).toHaveLength(1);
  });

  it("consumes exactly once, makes exact retry idempotent, and rejects another run", () => {
    const request = baseRequest();
    const { store, grant } = grantFor(request);
    const host = { session_id: SESSION, invocation_id: INVOCATION };
    const policy = allowingPolicy();

    store.consume(grant.grant_id, RUN_ID);
    const consumed = store.load(grant.grant_id);
    expect(consumed.record.state).toBe("consumed");
    expect(consumed.record.run_id).toBe(RUN_ID);
    expect(store.consume(grant.grant_id, RUN_ID)).toEqual(consumed);

    const again = evaluateParentDelivery({
      grant: consumed,
      request,
      host,
      policy,
      parentIdentity: PARENT,
      groundingVerified: true,
      answerUtf8Bytes: 100,
      now: NOW,
    });
    expect(again).toMatchObject({
      status: "refused",
      public_code: REFUSED_PARENT_DELIVERY,
      reason_code: "grant_consumed",
    });
    expect(() => store.consume(grant.grant_id, "kb-run-retry")).toThrow(/another run/);
    store.close();
  });

  it("synchronizes competing multiprocess consumes so exactly one run wins", async () => {
    const { store, grant } = grantFor(baseRequest());
    const dir = store.dir;
    store.close();
    const results = await runAuthorityRace([
      {
        operation: "parent-consume",
        storeDir: dir,
        input: { grantId: grant.grant_id, runId: "run-race-a" },
      },
      {
        operation: "parent-consume",
        storeDir: dir,
        input: { grantId: grant.grant_id, runId: "run-race-b" },
      },
    ]);
    expect(results.filter((result) => result.ok === true)).toHaveLength(1);
    expect(results.filter((result) => result.ok === false)).toHaveLength(1);

    const reopened = new ParentDeliveryGrantStore(dir);
    const winner = reopened.load(grant.grant_id).record.run_id!;
    expect(["run-race-a", "run-race-b"]).toContain(winner);
    expect(reopened.consume(grant.grant_id, winner).record.run_id).toBe(winner);
    const loser = winner === "run-race-a" ? "run-race-b" : "run-race-a";
    expect(() => reopened.consume(grant.grant_id, loser)).toThrow(/another run/);
    reopened.close();
  });

  it("rolls back an uncommitted consume when a process crashes", async () => {
    const { store, grant } = grantFor(baseRequest());
    const dir = store.dir;
    store.close();
    await crashAuthorityTransaction({
      operation: "parent-crash-uncommitted",
      storeDir: dir,
      input: { grantId: grant.grant_id, runId: "run-crashed" },
    });
    const reopened = new ParentDeliveryGrantStore(dir);
    expect(reopened.load(grant.grant_id).record.state).toBe("available");
    expect(reopened.consume(grant.grant_id, RUN_ID).record.state).toBe("consumed");
    reopened.close();
  });

  it("expires once under a synchronized multiprocess retry", async () => {
    const request = baseRequest();
    const dir = mkdtempSync(path.join(os.tmpdir(), "kb-parent-expiry-race-"));
    const store = new ParentDeliveryGrantStore(dir);
    const grant = mintParentDeliveryGrant({
      session_id: SESSION,
      invocation_id: INVOCATION,
      request,
      policy_sha256: sha256Hex(canonicalJson(allowingPolicy())),
      parent_provider: PARENT.provider,
      parent_model: PARENT.model,
      max_utf8_bytes: 4096,
      issued_at: new Date(NOW - 120_000).toISOString(),
      expires_at: PAST,
      grant_id: "pgt-expiry-race",
    });
    store.mint(grant);
    store.close();
    const expiryNow = new Date(NOW).toISOString();
    const results = await runAuthorityRace([
      {
        operation: "parent-expire",
        storeDir: dir,
        input: { grantId: grant.grant_id, now: expiryNow },
      },
      {
        operation: "parent-expire",
        storeDir: dir,
        input: { grantId: grant.grant_id, now: expiryNow },
      },
    ]);
    expect(results.every((result) => result.ok === true)).toBe(true);
    const reopened = new ParentDeliveryGrantStore(dir);
    expect(reopened.load(grant.grant_id).record.state).toBe("expired");
    expect(() => reopened.consume(grant.grant_id, RUN_ID)).toThrow(/expired/);
    reopened.close();
  });

  it("makes invalidation owner-driven, irreversible, and exactly retryable", () => {
    const { store, grant } = grantFor(baseRequest());
    const invalidated = store.invalidate(grant.grant_id);
    expect(invalidated.record.state).toBe("invalidated");
    expect(store.invalidate(grant.grant_id)).toEqual(invalidated);
    expect(() => store.consume(grant.grant_id, RUN_ID)).toThrow(/not available|invalidated/);
    store.close();
  });

  it("detects a tampered SQLite row digest and never accepts it", () => {
    const { store, grant } = grantFor(baseRequest());
    const db = database(path.join(store.dir, "grants.sqlite"));
    db.prepare("UPDATE parent_delivery_grants SET request_sha256 = ? WHERE grant_id = ?").run(
      "f".repeat(64),
      grant.grant_id
    );
    db.close();
    expect(() => store.load(grant.grant_id)).toThrow(/disagrees|digest mismatch/);
    store.close();
  });

  it("keeps the WAL store owner-only (0700 directory and 0600 DB/sidecars)", () => {
    const { store } = grantFor(baseRequest());
    expect(lstatSync(store.dir).mode & 0o777).toBe(0o700);
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = path.join(store.dir, `grants.sqlite${suffix}`);
      try {
        expect(lstatSync(file).mode & 0o777).toBe(0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    store.close();
  });

  it("lists only validated SQL rows and reports logical tamper explicitly", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kb-parent-list-"));
    const store = new ParentDeliveryGrantStore(dir);
    for (const grantId of ["pgt-list-good", "pgt-list-bad"]) {
      store.mint(
        mintParentDeliveryGrant({
          session_id: SESSION,
          invocation_id: `${INVOCATION}-${grantId}`,
          request: baseRequest(),
          policy_sha256: sha256Hex(canonicalJson(allowingPolicy())),
          parent_provider: PARENT.provider,
          parent_model: PARENT.model,
          max_utf8_bytes: 4096,
          issued_at: new Date(NOW - 3_600_000).toISOString(),
          expires_at: LATER,
          grant_id: grantId,
        })
      );
    }
    store.consume("pgt-list-good", RUN_ID);
    const db = database(path.join(dir, "grants.sqlite"));
    db.prepare(
      "UPDATE parent_delivery_grants SET record_sha256 = ? WHERE grant_id = 'pgt-list-bad'"
    ).run("0".repeat(64));
    db.close();

    const { grants, skipped_malformed } = store.list();
    expect(skipped_malformed).toBe(1);
    expect(grants).toHaveLength(1);
    const [projection] = grants;
    expect(projection).toMatchObject({
      grant_id: "pgt-list-good",
      state: "consumed",
      run_id: RUN_ID,
      kb_profile_id: PROFILE,
    });
    expect(JSON.stringify(projection)).not.toContain("gate ladder");
    expect(projection).not.toHaveProperty("session_id");
    expect(projection).not.toHaveProperty("invocation_id");
    store.close();
  });

  it("fails closed on legacy JSON authority instead of scanning or adopting it", () => {
    const { store, grant } = grantFor(baseRequest());
    writeFileSync(path.join(store.dir, `${grant.grant_id}.json`), "{}", { mode: 0o600 });
    expect(() => store.load(grant.grant_id)).toThrow(/scan\/adoption is forbidden/);
    store.close();
  });

  it("refuses a symlink database and a non-owner-only store directory", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kb-parent-hostile-"));
    const targetRoot = mkdtempSync(path.join(os.tmpdir(), "kb-parent-hostile-target-"));
    const target = path.join(targetRoot, "target.sqlite");
    writeFileSync(target, "not sqlite", { mode: 0o600 });
    symlinkSync(target, path.join(dir, "grants.sqlite"));
    expect(() => new ParentDeliveryGrantStore(dir)).toThrow(/non-symlink|regular/);

    const broad = mkdtempSync(path.join(os.tmpdir(), "kb-parent-broad-"));
    chmodSync(broad, 0o775);
    expect(() => new ParentDeliveryGrantStore(broad)).toThrow(/exactly 0700/);
  });
});
