/**
 * Answer quality and parent delivery — §5.6 (query delivery) + §5.1 (grant).
 *
 * This is the suite behind the plan-named `test:kb-answer-quality` script. It
 * covers the delivery decision path end to end at the app boundary:
 *   - the closed `DerivedQueryAnswerV1` shape (advisory-only, cited, verified);
 *   - sealed-answer extraction (`readSealedAnswer`) failing closed;
 *   - `decideParentDelivery`: the EXACTLY-ONE unconsumed exact-grant rule,
 *     exact host-invocation/model/policy binding, lesser byte bound, atomic
 *     single-use consumption, and bounded refusal with the grant RETAINED.
 * The focused delivery tests below invoke no agent. The imported frozen G8
 * oracle uses only explicit test-only synthetic Synthia/Vera agents; no model
 * or provider is called.
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import "./fixtures/kb-answer-quality-oracle.js";

import {
  DerivedQueryAnswerSchema,
  KbArtifactHandleSchema,
  canonicalJson,
  defaultDenyPolicy,
  sha256Hex,
  validateKbContract,
  type DerivedQueryAnswer,
  type KbArtifactHandle,
  type KbPolicy,
  type QueryKbRequest,
  type QueryVerificationReport,
} from "../src/kb/contracts.js";
import {
  ParentDeliveryGrantStore,
  REFUSED_PARENT_DELIVERY,
  computeRequestSha256,
  decideParentDelivery,
  mintParentDeliveryGrant,
  validateQueryRequest,
} from "../src/kb/parent-delivery.js";
import { assessQueryVerification } from "../src/kb/query-verification.js";
import { readSealedAnswer } from "../src/kb/workflows.js";
import { RunArtifactStore } from "../src/kb/run-artifacts.js";
import { kbArtifactControl } from "./fixtures/kb-artifact-control.js";

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

function validAnswer(
  text = "The gate ladder requires review before publication (advisory)."
): DerivedQueryAnswer {
  return {
    authority: "advisory",
    text,
    citations: [{ kind: "page", page_id: "page_oq_1", revision_id: "rev_oq_1" }],
    contradictions: [],
    unknowns: [],
    canonical_verification_required: true,
  } satisfies DerivedQueryAnswer;
}

function validAnswerHandle(answer = validAnswer()): KbArtifactHandle {
  const artifact = { schema_version: 1, artifact_kind: "query_answer", answer } as const;
  const jcs = canonicalJson(artifact);
  return {
    schema_version: 1,
    artifact_id: "artifact_answer_quality",
    artifact_kind: "query_answer" as const,
    sha256: sha256Hex(jcs),
    media_type: "application/json" as const,
    byte_length: Buffer.byteLength(jcs, "utf8"),
  } satisfies KbArtifactHandle;
}

function validVerification(
  answer = validAnswer(),
  handle = validAnswerHandle(answer)
): QueryVerificationReport {
  return {
    schema_version: 1,
    artifact_kind: "verification_report",
    passed: true,
    answer_artifact_id: handle.artifact_id,
    answer_sha256: handle.sha256,
    answer_verdict: "supported" as const,
    citation_findings: answer.citations.map((citation) => ({
      citation,
      verdict: "supported" as const,
      notes: "The selected page directly supports this cited statement.",
    })),
  } satisfies QueryVerificationReport;
}

function decideVerifiedParentDelivery(
  input: Parameters<typeof decideParentDelivery>[0]
): ReturnType<typeof decideParentDelivery> {
  let answer: DerivedQueryAnswer | undefined;
  try {
    answer = validateKbContract(DerivedQueryAnswerSchema, input.answer, "derived answer");
  } catch {
    answer = undefined;
  }
  const answerHandle =
    input.answerHandle ?? (answer === undefined ? undefined : validAnswerHandle(answer));
  let verifiedHandle: KbArtifactHandle | undefined;
  if (answerHandle !== undefined) {
    try {
      verifiedHandle = validateKbContract(KbArtifactHandleSchema, answerHandle, "answer handle");
    } catch {
      verifiedHandle = undefined;
    }
  }
  const verificationReport =
    input.verificationReport ??
    (answer === undefined || verifiedHandle === undefined
      ? undefined
      : validVerification(answer, verifiedHandle));
  return decideParentDelivery({
    ...input,
    ...(answerHandle === undefined ? {} : { answerHandle }),
    ...(verificationReport === undefined ? {} : { verificationReport }),
    queryCompleteAndMet: input.queryCompleteAndMet ?? true,
  });
}

function freshStore() {
  return new ParentDeliveryGrantStore(mkdtempSync(path.join(os.tmpdir(), "kb-answer-quality-")));
}

function mintFor(
  store: ParentDeliveryGrantStore,
  req: QueryKbRequest,
  grantId: string,
  policy: KbPolicy = allowingPolicy()
) {
  const grant = mintParentDeliveryGrant({
    session_id: SESSION,
    invocation_id: SESSION,
    request: req,
    policy_sha256: sha256Hex(canonicalJson(policy)),
    parent_provider: PARENT.provider,
    parent_model: PARENT.model,
    max_utf8_bytes: 4096,
    issued_at: nowIso(),
    expires_at: laterIso(),
    grant_id: grantId,
  });
  store.mint(grant);
  return grant;
}

describe("answer quality — closed query verification binding", () => {
  it("binds the exact sealed answer id and complete artifact JCS digest, never text alone", () => {
    const answer = validAnswer();
    const artifact = { schema_version: 1, artifact_kind: "query_answer", answer };
    const answerHandle = validAnswerHandle(answer);
    const report = validVerification(answer, answerHandle);
    expect(assessQueryVerification(artifact, report, answerHandle)).toMatchObject({ passed: true });
    expect(
      assessQueryVerification(
        artifact,
        { ...report, answer_artifact_id: "artifact_other" },
        answerHandle
      )
    ).toMatchObject({ passed: false, reason: "answer_artifact_id_mismatch" });
    expect(
      assessQueryVerification(
        artifact,
        { ...report, answer_sha256: sha256Hex(answer.text) },
        answerHandle
      )
    ).toMatchObject({ passed: false, reason: "answer_digest_mismatch" });
    expect(
      assessQueryVerification(
        { ...artifact, answer: { ...answer, unknowns: ["changed complete JCS"] } },
        report,
        answerHandle
      )
    ).toMatchObject({ passed: false, reason: "answer_handle_malformed" });
  });
});

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
    // Empty citations are valid only for a private unmet answer artifact;
    // parent delivery separately refuses them as not complete/met.
    expect(() =>
      validateKbContract(
        DerivedQueryAnswerSchema,
        { ...validAnswer(), citations: [] },
        "derived answer"
      )
    ).not.toThrow();
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
    // Empty answer text remains valid for an honest unmet private artifact;
    // met parent delivery is rejected by result/delivery cross-field checks.
    expect(() =>
      validateKbContract(DerivedQueryAnswerSchema, { ...validAnswer(), text: "" }, "derived answer")
    ).not.toThrow();
  });
});

describe("answer quality — sealed answer extraction fails closed", () => {
  it("returns the sealed answer sub-object for a query_answer artifact", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "kb-answer-read-"));
    const runId = RUN_ID;
    const doc = { schema_version: 1, artifact_kind: "query_answer", answer: validAnswer() };
    const checkpointer = kbArtifactControl({ root, runId, profileId: PROFILE, action: "query" });
    using store = new RunArtifactStore(root, runId, checkpointer);
    const handle = store.stage({
      state_id: "query",
      kb_profile_id: PROFILE,
      artifact_kind: "query_answer",
      content: JSON.stringify(doc),
    });
    expect(readSealedAnswer(root, runId, handle, checkpointer)).toEqual(validAnswer());
  });

  it("returns null for a missing artifact or the wrong kind (never throws into the result path)", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "kb-answer-read2-"));
    const runId = RUN_ID;
    const checkpointer = kbArtifactControl({ root, runId, profileId: PROFILE, action: "query" });
    expect(readSealedAnswer(root, runId, { artifact_id: "art_missing" }, checkpointer)).toBeNull();

    using store = new RunArtifactStore(root, runId, checkpointer);
    const other = store.stage({
      state_id: "carren_lint",
      kb_profile_id: PROFILE,
      artifact_kind: "lint_report",
      content: JSON.stringify({
        schema_version: 1,
        artifact_kind: "lint_report",
        findings: [],
        candidate_conflicts: [],
      }),
    });
    expect(readSealedAnswer(root, runId, other, checkpointer)).toBeNull();
  });
});

describe("answer quality — parent delivery decision (§5.1 + §5.6)", () => {
  it("delivers on exactly one exact grant and consumes it atomically by the run", () => {
    const store = freshStore();
    const req = request();
    mintFor(store, req, "pgt-oq-deliver");
    const dir = store.dir;

    const decision = decideVerifiedParentDelivery({
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
    const again = decideVerifiedParentDelivery({
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
        decideVerifiedParentDelivery({
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
        policy_sha256: sha256Hex(canonicalJson(policy)),
        parent_provider: PARENT.provider,
        parent_model: PARENT.model,
        max_utf8_bytes: 4096,
        issued_at: nowIso(),
        expires_at: laterIso(),
        grant_id: "pgt-oq-sess",
      });
      store.mint(grant);
      const dir = store.dir;
      const out = decideVerifiedParentDelivery({
        storeDir: dir,
        host: HOST,
        request: req,
        policy,
        parentIdentity: PARENT,
        runId: RUN_ID,
        answer,
      });
      expect(out).toEqual({ outcome: "refused", reason_code: "grant_missing" });
      expect(store.load("pgt-oq-sess").record.state).toBe("available"); // retained
    }

    // Policy denies: the grant survives for a future, policy-permitted run.
    {
      const store = freshStore();
      const deniedPolicy = defaultDenyPolicy("kbp-x");
      mintFor(store, req, "pgt-oq-policy", deniedPolicy);
      const dir = store.dir;
      const out = decideVerifiedParentDelivery({
        storeDir: dir,
        host: HOST,
        request: req,
        policy: deniedPolicy,
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
      mintFor(store, req, "pgt-oq-cap", allowingPolicy(4096));
      const dir = store.dir;
      const out = decideVerifiedParentDelivery({
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

    // The cap covers the complete canonical derived-answer payload, not only
    // answer.text: large bounded uncertainty arrays also refuse.
    {
      const store = freshStore();
      mintFor(store, req, "pgt-oq-payload-cap", allowingPolicy(4096));
      const oversizedPayload = {
        ...validAnswer("short answer"),
        unknowns: Array.from({ length: 8 }, (_, index) => `${index}:${"u".repeat(1000)}`),
      };
      const out = decideVerifiedParentDelivery({
        storeDir: store.dir,
        host: HOST,
        request: req,
        policy: allowingPolicy(4096),
        parentIdentity: PARENT,
        runId: RUN_ID,
        answer: oversizedPayload,
      });
      expect(out).toEqual({ outcome: "refused", reason_code: "answer_exceeds_byte_cap" });
      expect(store.load("pgt-oq-payload-cap").record.state).toBe("available");
    }

    // An expired grant is refused, not delivered.
    {
      const store = freshStore();
      const grant = mintParentDeliveryGrant({
        session_id: SESSION,
        invocation_id: SESSION,
        request: req,
        policy_sha256: sha256Hex(canonicalJson(policy)),
        parent_provider: PARENT.provider,
        parent_model: PARENT.model,
        max_utf8_bytes: 4096,
        issued_at: new Date(Date.now() - 120_000).toISOString(),
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        grant_id: "pgt-oq-expired",
      });
      store.mint(grant);
      const dir = store.dir;
      expect(
        decideVerifiedParentDelivery({
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
      const out = decideVerifiedParentDelivery({
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

  it("never creates a coin flip: competing issuance for one invocation loses", () => {
    const store = freshStore();
    const req = request();
    mintFor(store, req, "pgt-oq-unique-1");
    expect(() => mintFor(store, req, "pgt-oq-unique-2")).toThrow();
    expect(store.load("pgt-oq-unique-1").record.state).toBe("available");
  });

  it("refuses unless the ACTIVE parent identity is an exact allowlist match (§5.3)", () => {
    const req = request();
    const answer = validAnswer();

    // Host cannot establish who the parent is → refusal, never a pass.
    {
      const store = freshStore();
      mintFor(store, req, "pgt-oq-noident");
      const out = decideVerifiedParentDelivery({
        storeDir: store.dir,
        host: HOST,
        request: req,
        policy: allowingPolicy(),
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
      const out = decideVerifiedParentDelivery({
        storeDir: store.dir,
        host: HOST,
        request: req,
        policy: allowingPolicy(),
        parentIdentity: { provider: "anthropic", model: "claude-x" },
        runId: RUN_ID,
        answer,
      });
      expect(out).toEqual({ outcome: "refused", reason_code: "grant_mismatch_parent_model" });
    }

    // Empty allowlist denies even when the delivery key says allow (§5.3).
    {
      const store = freshStore();
      const policy = { ...allowingPolicy(), allowed_parent_models: [] };
      mintFor(store, req, "pgt-oq-emptylist", policy);
      const out = decideVerifiedParentDelivery({
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
      const policy = {
        ...allowingPolicy(),
        processing_mode: "local_only" as const,
        allowed_parent_models: [{ ...PARENT, locality: "remote" as const }],
      };
      mintFor(store, req, "pgt-oq-remote", policy);
      const out = decideVerifiedParentDelivery({
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

  it("refuses to deliver the deterministic answer whose grounding was never verified (§5.6)", () => {
    // `verify_grounding:false` preserves deterministic retrieval, but the
    // absence of a passing same-run Vera report makes it ineligible for parent delivery.
    const store = freshStore();
    const defaulted = validateQueryRequest({
      schema_version: 1,
      action: "query",
      kb_profile_id: PROFILE,
      query: "What did we decide about the gate ladder?",
      answer_delivery: "parent_tool_result",
      verify_grounding: false,
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

  it("refuses a passing report when the host terminal is not complete/met:true", () => {
    const store = freshStore();
    const req = request();
    mintFor(store, req, "pgt-oq-unmet");
    const answer = validAnswer();
    const out = decideParentDelivery({
      storeDir: store.dir,
      host: HOST,
      request: req,
      policy: allowingPolicy(),
      parentIdentity: PARENT,
      runId: RUN_ID,
      answer,
      verificationReport: validVerification(answer),
      queryCompleteAndMet: false,
    });
    expect(out).toEqual({ outcome: "refused", reason_code: "grounding_unverified" });
    expect(store.load("pgt-oq-unmet").record.state).toBe("available");
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
