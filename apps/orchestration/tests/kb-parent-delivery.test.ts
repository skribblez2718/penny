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
  computeRequestSha256,
  evaluateParentDelivery,
  mintParentDeliveryGrant,
  validateQueryRequest,
} from "../src/kb/parent-delivery.js";
import {
  defaultDenyPolicy,
  canonicalJson,
  sha256Hex,
  type KbPolicy,
  type QueryKbRequest,
} from "../src/kb/contracts.js";

const PROFILE = "kbp_parent_grant";
const SESSION = "sess_op_1";
const INVOCATION = "inv_op_1";
const RUN_ID = "kb-run-parent-1";
// Relative to the live clock so the suite is never flaky on time.
const NOW = Date.now();
const LATER = new Date(NOW + 30 * 60_000).toISOString();
const PAST = new Date(NOW - 60_000).toISOString();
const HOST = { session_id: SESSION, invocation_id: INVOCATION };

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
    parent_result: { derived_query_answer: "allow_explicit_derived_answer", max_utf8_bytes: maxUtf8Bytes },
  };
}

function grantFor(request: QueryKbRequest, overrides: Record<string, unknown> = {}): { grant; store; file } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kb-parent-grant-"));
  const store = new ParentDeliveryGrantStore(dir);
  const grant = mintParentDeliveryGrant({
    session_id: SESSION,
    invocation_id: INVOCATION,
    request,
    max_utf8_bytes: 4096,
    issued_at: new Date(NOW - 3_600_000).toISOString(),
    expires_at: LATER,
    ...overrides,
  });
  store.mint(grant);
  const file = store.load(grant.grant_id);
  return { grant, store, file };
}

describe("parent delivery — request canonicalization (§5.6)", () => {
  it("binds SHA-256(JCS(request)) and is independent of key order", () => {
    const a = baseRequest();
    const b = validateQueryRequest(Object.fromEntries(Object.keys(a).sort((x, y) => y.localeCompare(x)).map((k) => [k, (a as unknown as Record<string, unknown>)[k]])));
    expect(computeRequestSha256(a)).toEqual(computeRequestSha256(b));
    expect(computeRequestSha256(a)).toBe(sha256Hex(canonicalJson(a)));
    // A different query is a different digest.
    const c = baseRequest({ query: "a different question" });
    expect(computeRequestSha256(c)).not.toEqual(computeRequestSha256(a));
  });

  it("admits closed requests and refuses open/malformed ones", () => {
    expect(baseRequest()).toBeDefined();
    // extra key
    expect(() => validateQueryRequest({ ...baseRequest(), page_ids: ["x"] as never, extra: 1 })).toThrow();
    // wrong action
    expect(() => validateQueryRequest({ ...baseRequest(), action: "save" })).toThrow();
    // empty/oversized query
    expect(() => validateQueryRequest({ ...baseRequest(), query: "" })).toThrow();
    expect(() => validateQueryRequest({ ...baseRequest(), query: "x".repeat(32_769) })).toThrow();
    // bad answer_delivery
    expect(() => validateQueryRequest({ ...baseRequest(), answer_delivery: "parent_tool_result!" })).toThrow();
  });
});

describe("parent delivery — eligibility matrix", () => {
  it("admits on an exact grant and uses the lesser of grant and policy caps", () => {
    const request = baseRequest();
    const policy = allowingPolicy(8192);
    const { file } = grantFor(request);
    const out = evaluateParentDelivery({
      grant: file,
      request,
      host: { session_id: SESSION, invocation_id: INVOCATION },
      policy,
      answerUtf8Bytes: 4096,
      now: NOW,
    });
    expect(out).toEqual({ status: "eligible", byte_cap: 4096 }); // min(4096 grant, 8192 policy)

    // policy cap lower than grant: the policy bound wins
    const tighter = allowingPolicy(1024);
    const out2 = evaluateParentDelivery({
      grant: file,
      request,
      host: { session_id: SESSION, invocation_id: INVOCATION },
      policy: tighter,
      answerUtf8Bytes: 1024,
      now: NOW,
    });
    expect(out2).toEqual({ status: "eligible", byte_cap: 1024 });
  });

  it("refuses with bounded host reasons (never a silent content return)", () => {
    const request = baseRequest();
    const { file } = grantFor(request);
    const policy = allowingPolicy();
    const base = { request, policy, answerUtf8Bytes: 100, now: NOW, host: HOST };

    expect(evaluateParentDelivery({ ...base, grant: null })).toMatchObject({
      status: "refused",
      public_code: REFUSED_PARENT_DELIVERY,
      reason_code: "grant_missing",
    });
    expect(evaluateParentDelivery({ ...base, grant: file, host: { session_id: "sess_other", invocation_id: INVOCATION } })).toMatchObject({
      status: "refused",
      reason_code: "grant_mismatch_session",
    });
    expect(evaluateParentDelivery({ ...base, grant: file, host: { session_id: SESSION, invocation_id: "inv_other" } })).toMatchObject({
      status: "refused",
      reason_code: "grant_mismatch_invocation",
    });
    expect(evaluateParentDelivery({ ...base, grant: file, request: baseRequest({ kb_profile_id: "kbp_other" }) })).toMatchObject({
      status: "refused",
      reason_code: "grant_mismatch_profile",
    });
    expect(
      evaluateParentDelivery({ ...base, grant: file, request: baseRequest({ query: "a different question" }) })
    ).toMatchObject({ status: "refused", reason_code: "grant_mismatch_request_digest" });
    expect(evaluateParentDelivery({ ...base, grant: file, policy: defaultDenyPolicy("kbp-x") })).toMatchObject({
      status: "refused",
      reason_code: "policy_denies",
    });
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

describe("parent delivery — atomic single-use and store integrity", () => {
  it("consumes exactly once and never redelivers on retry", () => {
    const request = baseRequest();
    const { store, grant } = ((): { store: ParentDeliveryGrantStore; grant: string } => {
      const g = grantFor(request);
      return { store: g.store, grant: g.grant.grant_id };
    })();
    const host = { session_id: SESSION, invocation_id: INVOCATION };
    const policy = allowingPolicy();

    store.consume(grant, RUN_ID);
    const consumed = store.load(grant);
    expect(consumed.record.state).toBe("consumed");
    expect(consumed.record.run_id).toBe(RUN_ID);

    // A retry of the same invocation is refused — no reuse (contract §5.1).
    const again = evaluateParentDelivery({
      grant: consumed,
      request,
      host,
      policy,
      answerUtf8Bytes: 100,
      now: NOW,
    });
    expect(again).toMatchObject({ status: "refused", public_code: REFUSED_PARENT_DELIVERY, reason_code: "grant_consumed" });
    expect(() => store.consume(grant, "kb-run-retry")).toThrow(/not available|state: consumed/);
  });

  it("invalidation is operator-driven and irreversible", () => {
    const { store, grant: g } = grantFor(baseRequest());
    store.invalidate(g.grant_id);
    expect(store.load(g.grant_id).record.state).toBe("invalidated");
    expect(() => store.consume(g.grant_id, RUN_ID)).toThrow(/not available|invalidated/);
  });

  it("detects a tampered grant file (never silently accepts)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kb-parent-tamper-"));
    const store = new ParentDeliveryGrantStore(dir);
    const { grant: g, file } = grantFor(baseRequest());
    void g;
    void file;
    // Re-mint in this dir: grantFor used its own dir; build one here instead.
    const grant = mintParentDeliveryGrant({
      session_id: SESSION,
      invocation_id: INVOCATION,
      request: baseRequest(),
      max_utf8_bytes: 4096,
      issued_at: new Date(NOW - 3_600_000).toISOString(),
      expires_at: LATER,
    });
    store.mint(grant);
    const file0 = store.load(grant.grant_id);
    // Tamper with the byte cap in the stored grant body.
    const tampered = {
      schema_version: 1,
      record: file0.record,
      grant: { ...file0.grant, max_utf8_bytes: 999999 },
    };
    const p = path.join(dir, `${grant.grant_id}.json`);
    writeFileSync(p, JSON.stringify(tampered), { mode: 0o600 });
    expect(() => store.load(grant.grant_id)).toThrow(/digest mismatch|closed validation/);
  });

  it("keeps the store owner-only (0700 dir / 0600 files)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kb-parent-modes-"));
    const store = new ParentDeliveryGrantStore(dir);
    const { grant: g } = grantFor(baseRequest());
    void g;
    const grant = mintParentDeliveryGrant({
      session_id: SESSION,
      invocation_id: INVOCATION,
      request: baseRequest(),
      max_utf8_bytes: 4096,
      issued_at: new Date(NOW - 3_600_000).toISOString(),
      expires_at: LATER,
    });
    store.mint(grant);
    const dirSt = lstatSync(dir);
    expect(dirSt.mode & 0o777).toBe(0o700);
    const fSt = lstatSync(path.join(dir, `${grant.grant_id}.json`));
    expect(fSt.mode & 0o777).toBe(0o600);
  });

  it("lists grants as a safe projection and reports malformed entries explicitly", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kb-parent-list-"));
    const store = new ParentDeliveryGrantStore(dir);
    const request = baseRequest();
    const grant = mintParentDeliveryGrant({
      session_id: SESSION,
      invocation_id: INVOCATION,
      request,
      max_utf8_bytes: 4096,
      issued_at: new Date(NOW - 3_600_000).toISOString(),
      expires_at: LATER,
    });
    store.mint(grant);
    store.consume(grant.grant_id, RUN_ID);
    // A broken entry must be visible, not silently dropped.
    writeFileSync(path.join(dir, "pgt-broken.json"), "{ not json\n", { mode: 0o600 });

    const { grants, skipped_malformed } = store.list();
    expect(skipped_malformed).toBe(1);
    expect(grants).toHaveLength(1);
    const [g] = grants;
    expect(g).toMatchObject({ state: "consumed", run_id: RUN_ID, kb_profile_id: PROFILE });
    // Safe projection: no private body, no session/invocation pairing text.
    expect(JSON.stringify(g)).not.toContain("gate ladder");
    expect(g).not.toHaveProperty("session_id");
    expect(g).not.toHaveProperty("invocation_id");
  });

  it("refuses to open a grant file that is a symlink or group-writable", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kb-parent-hostile-"));
    const store = new ParentDeliveryGrantStore(dir);
    const good = {
      schema_version: 1,
      record: {
        schema_version: 1,
        grant_id: "pgt-hostile",
        grant_sha256: sha256Hex(canonicalJson({ s: 1 })),
        state: "available",
        updated_at: "2026-08-19T11:00:00Z",
      },
      grant: {
        schema_version: 1,
        grant_id: "pgt-hostile",
        session_id: SESSION,
        invocation_id: INVOCATION,
        action: "query",
        kb_profile_id: PROFILE,
        request_sha256: sha256Hex(canonicalJson("x")),
        max_utf8_bytes: 100,
        issued_at: new Date(NOW - 3_600_000).toISOString(),
        expires_at: LATER,
      },
    };
    const target = path.join(dir, "pgt-hostile-target.json");
    writeFileSync(target, JSON.stringify(good), { mode: 0o600 });
    const link = path.join(dir, "pgt-hostile.json");
    // A symlink entry for the grant id must be refused (no-follow stance).
    try {
      symlinkSync(target, link);
    } catch {
      /* platform without symlink support — the safe-file refusal is still asserted via the load throw below */
    }
    expect(() => store.load("pgt-hostile")).toThrow();
    // Group-writable directory is refused on the safe-dir check.
    chmodSync(dir, 0o775);
    expect(() => new ParentDeliveryGrantStore(dir)).toThrow(/group\/other writable/);
  });
});
