/**
 * Answer quality and parent delivery — §5.6 (query delivery) + §5.1 (grant).
 *
 * This is the suite behind the plan-named `test:kb-answer-quality` script. It
 * covers the delivery decision path end to end at the app boundary:
 *   - the closed `DerivedQueryAnswerV1` shape (advisory-only, cited, verified);
 *   - sealed-answer extraction (`readSealedAnswer`) failing closed;
 *   - `decideParentDelivery`: the EXACTLY-ONE unconsumed exact-grant rule,
 *     session-scoped invocation pairing, policy + lesser byte bound, atomic
 *     single-use consumption, and bounded refusal with the grant RETAINED.
 * No agent is invoked in this suite; the agent-facing behavior is covered by
 * the engine E2E suites, and the adapter glue is a thin call into this path.
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DerivedQueryAnswerSchema,
  defaultDenyPolicy,
  validateKbContract,
  type KbPolicy,
  type QueryKbRequest,
} from "../src/kb/contracts.js";
import {
  ParentDeliveryGrantStore,
  REFUSED_PARENT_DELIVERY,
  computeRequestSha256,
  decideParentDelivery,
  mintParentDeliveryGrant,
  validateQueryRequest,
} from "../src/kb/parent-delivery.js";
import { readSealedAnswer } from "../src/kb/workflows.js";
import { RunArtifactStore } from "../src/kb/run-artifacts.js";

const PROFILE = "kbp_answer_quality";
const SESSION = "sess_oq_1";
// Session-scoped invocation pairing (operator decision 2026-08-19): the host
// context carries the Pi session id in both fields; the operator mints both.
const HOST = { session_id: SESSION, invocation_id: SESSION };
const RUN_ID = "kb-run-answer-1";
// §5.3: the exact provider/model the runtime reports for the active parent.
const PARENT = { provider: "ollama", model: "qwen327b:latest" };

function nowIso() {
  return new Date().toISOString();
}
function laterIso() {
  return new Date(Date.now() + 30 * 60_000).toISOString();
}

function request(overrides: Record<string, unknown> = {}): QueryKbRequest {
  return validateQueryRequest({
    schema_version: 1,
    action: "query",
    kb_profile_id: PROFILE,
    query: "What did we decide about the gate ladder?",
    answer_delivery: "parent_tool_result",
    // §5.6 defaults verify_grounding true; this flow cannot verify grounding, so
    // a deliverable request must explicitly record that the operator accepted an
    // unverified answer. See the grounding test below for the default case.
    verify_grounding: false,
    ...overrides,
  });
}

function allowingPolicy(maxUtf8Bytes = 16_384): KbPolicy {
  return {
    ...defaultDenyPolicy("kbp-answer-quality"),
    allowed_parent_models: [{ ...PARENT, locality: "local" }],
    parent_result: {
      derived_query_answer: "allow_explicit_derived_answer",
      max_utf8_bytes: maxUtf8Bytes,
    },
  };
}

function validAnswer(text = "The gate ladder requires review before publication (advisory).") {
  return {
    authority: "advisory",
    text,
    citations: [{ kind: "page", page_id: "page_oq_1", revision_id: "rev_oq_1" }],
    contradictions: [],
    unknowns: [],
    canonical_verification_required: true,
  };
}

function freshStore() {
  return new ParentDeliveryGrantStore(mkdtempSync(path.join(os.tmpdir(), "kb-answer-quality-")));
}

function mintFor(store: ParentDeliveryGrantStore, req: QueryKbRequest, grantId: string) {
  const grant = mintParentDeliveryGrant({
    session_id: SESSION,
    invocation_id: SESSION,
    request: req,
    max_utf8_bytes: 4096,
    issued_at: nowIso(),
    expires_at: laterIso(),
    grant_id: grantId,
  });
  store.mint(grant);
  return grant;
}

describe("answer quality — closed derived answer (§5.6)", () => {
  it("admits advisory, cited, canonical-verified answers", () => {
    expect(
      validateKbContract(DerivedQueryAnswerSchema, validAnswer(), "derived answer")
    ).toMatchObject({
      authority: "advisory",
      canonical_verification_required: true,
    });
  });

  it("refuses anything that is not advisory, cited, and bound to verification", () => {
    expect(() =>
      validateKbContract(
        DerivedQueryAnswerSchema,
        { ...validAnswer(), authority: "canonical" },
        "derived answer"
      )
    ).toThrow();
    expect(() =>
      validateKbContract(
        DerivedQueryAnswerSchema,
        { ...validAnswer(), canonical_verification_required: false },
        "derived answer"
      )
    ).toThrow();
    expect(() =>
      validateKbContract(
        DerivedQueryAnswerSchema,
        { ...validAnswer(), citations: [] },
        "derived answer"
      )
    ).toThrow();
    expect(() =>
      validateKbContract(
        DerivedQueryAnswerSchema,
        { ...validAnswer(), open_key: 1 },
        "derived answer"
      )
    ).toThrow();
    // Citations are opaque IDs — never a path/locator.
    expect(() =>
      validateKbContract(
        DerivedQueryAnswerSchema,
        {
          ...validAnswer(),
          citations: [{ kind: "page", page_id: "../../etc/passwd", revision_id: "rev_oq_1" }],
        },
        "derived answer"
      )
    ).toThrow();
    expect(() =>
      validateKbContract(DerivedQueryAnswerSchema, { ...validAnswer(), text: "" }, "derived answer")
    ).toThrow();
  });
});

describe("answer quality — sealed answer extraction fails closed", () => {
  it("returns the sealed answer sub-object for a query_answer artifact", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "kb-answer-read-"));
    const runId = RUN_ID;
    const doc = { schema_version: 1, artifact_kind: "query_answer", answer: validAnswer() };
    let handle;
    using store = new RunArtifactStore(root, runId);
    handle = store.stage({
      state_id: "synthia_query",
      kb_profile_id: PROFILE,
      artifact_kind: "query_answer",
      content: JSON.stringify(doc),
    });
    expect(readSealedAnswer(root, runId, handle)).toEqual(validAnswer());
  });

  it("returns null for a missing artifact or the wrong kind (never throws into the result path)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "kb-answer-read2-"));
    const runId = RUN_ID;
    expect(readSealedAnswer(root, runId, { artifact_id: "art_missing" })).toBeNull();

    using store = new RunArtifactStore(root, runId);
    const other = store.stage({
      state_id: "carren_lint",
      kb_profile_id: PROFILE,
      artifact_kind: "lint_report",
      content: JSON.stringify({
        schema_version: 1,
        artifact_kind: "lint_report",
        answer: validAnswer(),
      }),
    });
    expect(readSealedAnswer(root, runId, other)).toBeNull();
  });
});

describe("answer quality — parent delivery decision (§5.1 + §5.6)", () => {
  it("delivers on exactly one exact grant and consumes it atomically by the run", () => {
    const store = freshStore();
    const req = request();
    mintFor(store, req, "pgt-oq-deliver");
    const dir = store.dir;

    const decision = decideParentDelivery({
      storeDir: dir,
      host: HOST,
      request: req,
      policy: allowingPolicy(),
      parentIdentity: PARENT,
      runId: RUN_ID,
      answer: validAnswer(),
    });
    expect(decision.outcome).toBe("delivered");
    if (decision.outcome === "delivered") {
      expect(decision.derived_answer.authority).toBe("advisory");
      expect(decision.derived_answer.canonical_verification_required).toBe(true);
    }

    const consumed = store.load("pgt-oq-deliver");
    expect(consumed.record.state).toBe("consumed");
    expect(consumed.record.run_id).toBe(RUN_ID);

    // A retry of the same invocation is refused — the grant is single-use.
    const again = decideParentDelivery({
      storeDir: dir,
      host: HOST,
      request: req,
      policy: allowingPolicy(),
      parentIdentity: PARENT,
      runId: "kb-run-retry",
      answer: validAnswer(),
    });
    expect(again).toEqual({ outcome: "refused", reason_code: "grant_consumed" });
  });

  it("refuses with bounded host reasons and RETAINS the grant on every miss", () => {
    const req = request();
    const policy = allowingPolicy();
    const answer = validAnswer();

    // No grant at all.
    {
      const store = freshStore();
      const dir = store.dir;
      expect(
        decideParentDelivery({
          storeDir: dir,
          host: HOST,
          request: req,
          policy,
          parentIdentity: PARENT,
          runId: RUN_ID,
          answer,
        })
      ).toEqual({ outcome: "refused", reason_code: "grant_missing" });
    }

    // Wrong session (a grant minted for another Pi session).
    {
      const store = freshStore();
      const grant = mintParentDeliveryGrant({
        session_id: "sess_other",
        invocation_id: "sess_other",
        request: req,
        max_utf8_bytes: 4096,
        issued_at: nowIso(),
        expires_at: laterIso(),
        grant_id: "pgt-oq-sess",
      });
      store.mint(grant);
      const dir = store.dir;
      const out = decideParentDelivery({
        storeDir: dir,
        host: HOST,
        request: req,
        policy,
        parentIdentity: PARENT,
        runId: RUN_ID,
        answer,
      });
      expect(out).toEqual({ outcome: "refused", reason_code: "grant_mismatch_session" });
      expect(store.load("pgt-oq-sess").record.state).toBe("available"); // retained
    }

    // Policy denies: the grant survives for a future, policy-permitted run.
    {
      const store = freshStore();
      mintFor(store, req, "pgt-oq-policy");
      const dir = store.dir;
      const out = decideParentDelivery({
        storeDir: dir,
        host: HOST,
        request: req,
        policy: defaultDenyPolicy("kbp-x"),
        parentIdentity: PARENT,
        runId: RUN_ID,
        answer,
      });
      expect(out).toEqual({ outcome: "refused", reason_code: "policy_denies" });
      expect(store.load("pgt-oq-policy").record.state).toBe("available");
    }

    // Byte cap exceeded (lesser of grant 4096 / policy 4096 vs a 5000-byte text):
    // the answer is not truncated — it is refused, and the grant is retained.
    {
      const store = freshStore();
      mintFor(store, req, "pgt-oq-cap");
      const dir = store.dir;
      const out = decideParentDelivery({
        storeDir: dir,
        host: HOST,
        request: req,
        policy: allowingPolicy(4096),
        parentIdentity: PARENT,
        runId: RUN_ID,
        answer: validAnswer("x".repeat(5000)),
      });
      expect(out).toEqual({ outcome: "refused", reason_code: "answer_exceeds_byte_cap" });
      expect(store.load("pgt-oq-cap").record.state).toBe("available");
    }

    // An expired grant is refused, not delivered.
    {
      const store = freshStore();
      const grant = mintParentDeliveryGrant({
        session_id: SESSION,
        invocation_id: SESSION,
        request: req,
        max_utf8_bytes: 4096,
        issued_at: new Date(Date.now() - 120_000).toISOString(),
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        grant_id: "pgt-oq-expired",
      });
      store.mint(grant);
      const dir = store.dir;
      expect(
        decideParentDelivery({
          storeDir: dir,
          host: HOST,
          request: req,
          policy,
          parentIdentity: PARENT,
          runId: RUN_ID,
          answer,
        })
      ).toEqual({ outcome: "refused", reason_code: "grant_expired" });
    }

    // Malformed answer: never delivered, never consumed a grant.
    {
      const store = freshStore();
      mintFor(store, req, "pgt-oq-malformed");
      const dir = store.dir;
      const out = decideParentDelivery({
        storeDir: dir,
        host: HOST,
        request: req,
        policy,
        parentIdentity: PARENT,
        runId: RUN_ID,
        answer: { ...validAnswer(), raw_body: "a raw page body must never be delivered" },
      });
      expect(out).toEqual({ outcome: "refused", reason_code: "answer_malformed" });
      expect(store.load("pgt-oq-malformed").record.state).toBe("available");
    }
  });

  it("never coin-flips: two exact candidates are an ambiguity refusal, both retained", () => {
    const store = freshStore();
    const req = request();
    mintFor(store, req, "pgt-oq-amb-1");
    mintFor(store, req, "pgt-oq-amb-2");
    const dir = store.dir;
    const out = decideParentDelivery({
      storeDir: dir,
      host: HOST,
      request: req,
      policy: allowingPolicy(),
      parentIdentity: PARENT,
      runId: RUN_ID,
      answer: validAnswer(),
    });
    expect(out).toEqual({ outcome: "refused", reason_code: "grant_ambiguous" });
    expect(store.load("pgt-oq-amb-1").record.state).toBe("available");
    expect(store.load("pgt-oq-amb-2").record.state).toBe("available");
  });

  it("refuses unless the ACTIVE parent identity is an exact allowlist match (§5.3)", () => {
    const req = request();
    const answer = validAnswer();

    // Host cannot establish who the parent is → refusal, never a pass.
    {
      const store = freshStore();
      mintFor(store, req, "pgt-oq-noident");
      const out = decideParentDelivery({
        storeDir: store.dir,
        host: HOST,
        request: req,
        policy: allowingPolicy(),
        parentIdentity: undefined,
        runId: RUN_ID,
        answer,
      });
      expect(out).toEqual({ outcome: "refused", reason_code: "parent_identity_unknown" });
      expect(store.load("pgt-oq-noident").record.state).toBe("available");
    }

    // A different parent model than the operator allowlisted.
    {
      const store = freshStore();
      mintFor(store, req, "pgt-oq-otherparent");
      const out = decideParentDelivery({
        storeDir: store.dir,
        host: HOST,
        request: req,
        policy: allowingPolicy(),
        parentIdentity: { provider: "anthropic", model: "claude-x" },
        runId: RUN_ID,
        answer,
      });
      expect(out).toEqual({ outcome: "refused", reason_code: "parent_model_not_allowed" });
    }

    // Empty allowlist denies even when the delivery key says allow (§5.3).
    {
      const store = freshStore();
      mintFor(store, req, "pgt-oq-emptylist");
      const policy = { ...allowingPolicy(), allowed_parent_models: [] };
      const out = decideParentDelivery({
        storeDir: store.dir,
        host: HOST,
        request: req,
        policy,
        parentIdentity: PARENT,
        runId: RUN_ID,
        answer,
      });
      expect(out).toEqual({ outcome: "refused", reason_code: "parent_model_not_allowed" });
    }

    // local_only + the operator's own rule declares the parent remote.
    {
      const store = freshStore();
      mintFor(store, req, "pgt-oq-remote");
      const policy = {
        ...allowingPolicy(),
        processing_mode: "local_only" as const,
        allowed_parent_models: [{ ...PARENT, locality: "remote" as const }],
      };
      const out = decideParentDelivery({
        storeDir: store.dir,
        host: HOST,
        request: req,
        policy,
        parentIdentity: PARENT,
        runId: RUN_ID,
        answer,
      });
      expect(out).toEqual({ outcome: "refused", reason_code: "parent_model_not_allowed" });
    }
  });

  it("refuses to deliver an answer whose grounding was never verified (§5.6)", () => {
    // verify_grounding defaults TRUE and this flow has no grounding phase, so
    // the default request is NOT deliverable — the operator must mint over a
    // request that explicitly records `verify_grounding: false`.
    const store = freshStore();
    const defaulted = validateQueryRequest({
      schema_version: 1,
      action: "query",
      kb_profile_id: PROFILE,
      query: "What did we decide about the gate ladder?",
      answer_delivery: "parent_tool_result",
    });
    mintFor(store, defaulted, "pgt-oq-grounding");
    const out = decideParentDelivery({
      storeDir: store.dir,
      host: HOST,
      request: defaulted,
      policy: allowingPolicy(),
      parentIdentity: PARENT,
      runId: RUN_ID,
      answer: validAnswer(),
    });
    expect(out).toEqual({ outcome: "refused", reason_code: "grounding_unverified" });
    expect(store.load("pgt-oq-grounding").record.state).toBe("available");
  });

  it("the public refusal surface is exactly one bounded code", () => {
    // The parent result may only ever carry this single code on refusal.
    expect(REFUSED_PARENT_DELIVERY).toBe("refused_parent_delivery");
    // And the binding digest is stable, so the operator can verify the grant
    // against the same request bytes the adapter sends.
    expect(computeRequestSha256(request())).toBe(computeRequestSha256(request()));
    expect(computeRequestSha256(request({ query: "x" }))).not.toBe(computeRequestSha256(request()));
  });
});
