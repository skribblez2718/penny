import { describe, expect, it } from "vitest";

import {
  CapabilityEnvelopeSchema,
  CapabilityLeaseSchema,
  ClaimsArtifactSchema,
  ContentReviewGatePacketSchema,
  HostCapabilityEnvelopeV1Schema,
  HostCapabilityLeaseV1Schema,
  IdempotencyRecordSchema,
  IngestVerificationReportSchema,
  InitReservationSchema,
  KbArtifactHandleSchema,
  KbComposeAuthoritySchema,
  KbHostInvocationContextV1Schema,
  KbPolicySchema,
  KbProfileRegistrySchema,
  KbPublicationTransactionSchema,
  KnowledgeBaseRequestSchema,
  KnowledgeBaseResultSchema,
  LintReportArtifactSchema,
  OpaqueIdSchema,
  ParentDeliveryGrantSchema,
  ParentDeliveryGrantStoreRecordV1Schema,
  PrivateRunInputRecordSchema,
  PromotionApplyJournalSchema,
  PromotionGatePacketSchema,
  PromotionVerificationSchema,
  PublicationFileRecordSchema,
  QueryVerificationReportSchema,
  ReadCanonicalTargetInputSchema,
  ReadCanonicalTargetResultSchema,
  ReadPhaseBriefInputSchema,
  ReadPhaseBriefResultSchema,
  ReadRunArtifactInputSchema,
  ReadRunArtifactResultSchema,
  ReadSelectedPageInputSchema,
  ReadSelectedPageResultSchema,
  ReadSourceSnapshotInputSchema,
  ReadSourceSnapshotResultSchema,
  ReplayableKnowledgeBaseResultSchema,
  Rfc3339UtcSchema,
  SafeRecordKeySchema,
  SaveQueryClaimSchema,
  SearchSelectedKbInputSchema,
  SearchSelectedKbResultSchema,
  SourceAdmissionRecordV1Schema,
  VerificationReportArtifactSchema,
  canonicalJson,
  defaultDenyPolicy,
  sha256Hex,
  validateKbContract,
  type KnowledgeBaseRequest,
} from "../src/kb/contracts.js";

const ZERO = "0".repeat(64);
const ONE = "1".repeat(64);
const NOW = "2026-08-21T12:34:56.123456789Z";

function handle(kind: string, id = `artifact_${kind}`) {
  return {
    schema_version: 1,
    artifact_id: id,
    artifact_kind: kind,
    sha256: ZERO,
    media_type: "application/json",
    byte_length: 2,
  };
}

function evidence(id = "evidence_1") {
  return { evidence_id: id, kind: "digest", ref: `digest_${id}`, sha256: ZERO };
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    action: "init",
    run_id: "run_1",
    kb_id: "kb_1",
    status: "complete",
    met: true,
    ids: [],
    counts: {},
    artifacts: [],
    evidence: [],
    warnings: [],
    unresolved: [],
    next: "none",
    ...overrides,
  };
}

function promotionPacket() {
  return {
    schema_version: 1,
    run_id: "run_promote",
    session_id: "session_1",
    challenge_id: "challenge_1",
    kb_profile_id: "profile_1",
    kb_id: "kb_1",
    page_revisions: [{ page_id: "page_1", revision_id: "revision_1" }],
    target_capability_ids: ["target_1"],
    target_presentations: [
      {
        target_capability_id: "target_1",
        canonical_target: "/synthetic/target.md",
        preimage_sha256: ZERO,
      },
    ],
    preimage_digests: { target_1: ZERO },
    plan_artifact: handle("promotion_plan", "artifact_plan"),
    patch_artifact: handle("promotion_patch", "artifact_patch"),
    verification_artifact: handle("verification_report", "artifact_verification"),
    patch_digest: ZERO,
    verification_evidence: [evidence()],
    verification_evidence_digest: sha256Hex(canonicalJson([evidence()])),
    issued_at: NOW,
    expires_at: "2026-08-21T13:34:56Z",
  };
}

describe("Section 5 Revision 7 ratified foundation fields", () => {
  it("exports one exact closed host/capability schema family", () => {
    expect(CapabilityEnvelopeSchema).toBe(HostCapabilityEnvelopeV1Schema);
    expect(CapabilityLeaseSchema).toBe(HostCapabilityLeaseV1Schema);
    const envelope = {
      schema_version: 1,
      capability_id: "cap_contract",
      kind: "source_read",
      session_id: "session_1",
      kb_profile_id: "profile_1",
      resolved_path: "/synthetic/source.md",
      expected_sha256: ZERO,
      media_type: "text/markdown",
      source_metadata: {
        source_type: "file",
        captured_at: NOW,
        title: "Source",
        authors: [],
      },
      allowed_operation: "ingest",
      issued_at: NOW,
      expires_at: "2026-08-21T13:34:56Z",
    };
    expect(() =>
      validateKbContract(HostCapabilityEnvelopeV1Schema, envelope, "envelope")
    ).not.toThrow();
    expect(() =>
      validateKbContract(
        HostCapabilityEnvelopeV1Schema,
        { ...envelope, unknown_authority: true },
        "envelope"
      )
    ).toThrow();

    const lease = {
      schema_version: 1,
      capability_id: "cap_contract",
      envelope_sha256: ZERO,
      state: "available",
    };
    expect(() => validateKbContract(HostCapabilityLeaseV1Schema, lease, "lease")).not.toThrow();
    expect(() =>
      validateKbContract(
        HostCapabilityLeaseV1Schema,
        { ...lease, state: "claimed", run_id: "run_1" },
        "lease"
      )
    ).toThrow();

    const admission = {
      schema_version: 1,
      source_id: "source_1",
      capability_id: "cap_contract",
      envelope_sha256: ZERO,
      run_id: "run_1",
      transaction_id: "transaction_1",
      sha256: ZERO,
      media_type: "text/markdown",
      byte_length: 0,
      storage_key: "work/run_1/transaction/sources/source_1",
      temporary_storage_key: "work/run_1/transaction/sources/.source_1.transaction_1.tmp",
      state: "preparing",
      created_at: NOW,
      updated_at: NOW,
    };
    expect(() =>
      validateKbContract(SourceAdmissionRecordV1Schema, admission, "admission")
    ).not.toThrow();

    const host = {
      schema_version: 1,
      session_id: "session_1",
      invocation_id: "invocation_1",
      parent_provider: "provider",
      parent_model: "model",
      parent_locality: "local",
      allowed_kb_profile_ids: ["profile_1"],
    };
    expect(() =>
      validateKbContract(KbHostInvocationContextV1Schema, host, "host context")
    ).not.toThrow();
    expect(() =>
      validateKbContract(
        KbHostInvocationContextV1Schema,
        { ...host, root: "/private" },
        "host context"
      )
    ).toThrow();
  });

  it("enforces parent grant chronology and store lifecycle cross-fields", () => {
    const grant = {
      schema_version: 1,
      grant_id: "grant_cross",
      session_id: "session_1",
      invocation_id: "invocation_1",
      action: "query",
      kb_profile_id: "profile_1",
      request_sha256: ZERO,
      policy_sha256: ONE,
      parent_provider: "provider",
      parent_model: "model",
      max_utf8_bytes: 1024,
      issued_at: "2026-08-21T13:34:56Z",
      expires_at: NOW,
    };
    expect(() => validateKbContract(ParentDeliveryGrantSchema, grant, "grant")).toThrow();
    expect(() =>
      validateKbContract(
        ParentDeliveryGrantStoreRecordV1Schema,
        {
          schema_version: 1,
          grant_id: "grant_cross",
          grant_sha256: ZERO,
          state: "consumed",
          updated_at: NOW,
        },
        "grant record"
      )
    ).toThrow();
  });
  it("requires schema_version on artifact handles and nested profiles", () => {
    expect(() =>
      validateKbContract(KbArtifactHandleSchema, handle("claims"), "handle")
    ).not.toThrow();
    const { schema_version: _removed, ...unversioned } = handle("claims");
    expect(() => validateKbContract(KbArtifactHandleSchema, unversioned, "handle")).toThrow();

    const registry = {
      schema_version: 1,
      profiles: [
        {
          schema_version: 1,
          kb_profile_id: "profile_1",
          kb_root: "/synthetic/kb",
          allow_create: false,
          repository_admission: { mode: "outside_worktree" },
        },
      ],
    };
    expect(() => validateKbContract(KbProfileRegistrySchema, registry, "registry")).not.toThrow();
    const profile = registry.profiles[0];
    if (profile === undefined) throw new Error("registry fixture is missing its profile");
    const { schema_version: _profileSchemaVersion, ...unversionedProfile } = profile;
    const bad = { ...registry, profiles: [unversionedProfile] };
    expect(() => validateKbContract(KbProfileRegistrySchema, bad, "registry")).toThrow();
  });

  it("requires init generation_id and publication-file transaction_id", () => {
    const reservation = {
      schema_version: 1,
      kb_profile_id: "profile_1",
      run_id: "run_1",
      transaction_id: "transaction_1",
      request_sha256: ZERO,
      profile_commitment_sha256: ZERO,
      kb_id: "kb_1",
      generation_id: "generation_1",
      state: "reserved",
      updated_at: NOW,
    };
    expect(() =>
      validateKbContract(InitReservationSchema, reservation, "reservation")
    ).not.toThrow();
    const { generation_id: _generation, ...withoutGeneration } = reservation;
    expect(() =>
      validateKbContract(InitReservationSchema, withoutGeneration, "reservation")
    ).toThrow();

    const file = {
      schema_version: 1,
      publication_file_id: "publication_file_1",
      transaction_id: "transaction_1",
      role: "catalog",
      staging_key: "work/run_1/transaction/catalog.json",
      final_key: ".kb/generations/generation_1/catalog.json",
      state: "planned",
    };
    expect(() =>
      validateKbContract(PublicationFileRecordSchema, file, "publication file")
    ).not.toThrow();
    const { transaction_id: _transaction, ...withoutTransaction } = file;
    expect(() =>
      validateKbContract(PublicationFileRecordSchema, withoutTransaction, "publication file")
    ).toThrow();

    const publication = {
      schema_version: 1,
      run_id: "run_1",
      transaction_id: "transaction_1",
      kb_profile_id: "profile_1",
      kb_id: "kb_1",
      action: "save",
      base_generation_id: "generation_0",
      base_selector_sha256: ZERO,
      candidate_generation_id: "generation_1",
      staging_root: "work/run_1/transaction/publication/transaction_1",
      generation_staging_key: "work/run_1/transaction/publication/transaction_1/generation",
      generation_final_key: ".kb/generations/generation_1",
      lifecycle: "planned",
      created_at: NOW,
      updated_at: NOW,
      files: [
        file,
        {
          ...file,
          publication_file_id: "publication_file_2",
          role: "index",
          staging_key: "work/run_1/transaction/index.sqlite",
          final_key: ".kb/generations/generation_1/index.sqlite",
        },
        {
          ...file,
          publication_file_id: "publication_file_3",
          role: "selector",
          staging_key: ".kb/.current.transaction_1.tmp",
          final_key: ".kb/current.json",
        },
      ],
    };
    expect(() =>
      validateKbContract(KbPublicationTransactionSchema, publication, "publication")
    ).not.toThrow();
    expect(() =>
      validateKbContract(
        KbPublicationTransactionSchema,
        { ...publication, action: "query" },
        "publication"
      )
    ).toThrow();
    expect(() =>
      validateKbContract(
        KbPublicationTransactionSchema,
        {
          ...publication,
          files: [{ ...file, transaction_id: "transaction_other" }, ...publication.files.slice(1)],
        },
        "publication"
      )
    ).toThrow();
  });

  it("requires parent policy/tuple, save answer digest/time, and journal preimage mode", () => {
    const grant = {
      schema_version: 1,
      grant_id: "grant_1",
      session_id: "session_1",
      invocation_id: "invocation_1",
      action: "query",
      kb_profile_id: "profile_1",
      request_sha256: ZERO,
      policy_sha256: ONE,
      parent_provider: "synthetic-provider",
      parent_model: "synthetic-model",
      max_utf8_bytes: 1024,
      issued_at: NOW,
      expires_at: "2026-08-21T13:34:56Z",
    };
    expect(() => validateKbContract(ParentDeliveryGrantSchema, grant, "grant")).not.toThrow();
    for (const key of ["policy_sha256", "parent_provider", "parent_model"] as const) {
      const bad = { ...grant };
      delete (bad as Partial<typeof grant>)[key];
      expect(() => validateKbContract(ParentDeliveryGrantSchema, bad, "grant")).toThrow();
    }

    const claim = {
      schema_version: 1,
      query_run_id: "query_run_1",
      kb_profile_id: "profile_1",
      kb_id: "kb_1",
      answer_artifact_id: "answer_1",
      answer_sha256: ZERO,
      state: "available",
      created_at: NOW,
      updated_at: NOW,
    };
    expect(() => validateKbContract(SaveQueryClaimSchema, claim, "claim")).not.toThrow();
    for (const key of ["answer_sha256", "created_at"] as const) {
      const bad = { ...claim };
      delete (bad as Partial<typeof claim>)[key];
      expect(() => validateKbContract(SaveQueryClaimSchema, bad, "claim")).toThrow();
    }

    const journal = {
      schema_version: 1,
      transaction_id: "transaction_1",
      run_id: "run_1",
      receipt_id: "receipt_1",
      receipt_sha256: ZERO,
      patch_artifact_id: "artifact_patch",
      state: "capturing",
      targets: [
        {
          ordinal: 0,
          target_capability_id: "target_1",
          preimage_sha256: ZERO,
          postimage_sha256: ONE,
          preimage_mode: 0o644,
          preimage_storage_key: "work/run_1/promotion/transaction_1/preimages/0",
          state: "ready",
        },
      ],
      post_apply_verified: false,
      created_at: NOW,
      updated_at: NOW,
    };
    expect(() => validateKbContract(PromotionApplyJournalSchema, journal, "journal")).not.toThrow();
    const target = journal.targets[0];
    if (target === undefined) throw new Error("journal fixture is missing its target");
    const { preimage_mode: _preimageMode, ...targetWithoutMode } = target;
    const badJournal = { ...journal, targets: [targetWithoutMode] };
    expect(() => validateKbContract(PromotionApplyJournalSchema, badJournal, "journal")).toThrow();
  });

  it("requires nonempty promotion effect evidence", () => {
    expect(() =>
      validateKbContract(PromotionGatePacketSchema, promotionPacket(), "packet")
    ).not.toThrow();
    expect(() =>
      validateKbContract(
        PromotionGatePacketSchema,
        { ...promotionPacket(), verification_evidence: [] },
        "packet"
      )
    ).toThrow();
  });
});

describe("shared scalar and identity probes", () => {
  it("rejects traversal-like opaque IDs and unsafe record keys", () => {
    for (const id of ["a..b", "..", "a/b", "a b"])
      expect(() => validateKbContract(OpaqueIdSchema, id, "opaque id")).toThrow();
    expect(() => validateKbContract(OpaqueIdSchema, "a.b-c:d_1", "opaque id")).not.toThrow();
    for (const key of ["__proto__", "prototype", "constructor", "a..b"])
      expect(() => validateKbContract(SafeRecordKeySchema, key, "record key")).toThrow();
  });

  it("counts human text in UTF-8 bytes and rejects non-NFC/control text", () => {
    const base = {
      schema_version: 1,
      action: "save",
      kb_profile_id: "profile_1",
      query_run_id: "query_1",
      page_kind: "synthesis",
    };
    expect(() =>
      validateKbContract(KnowledgeBaseRequestSchema, { ...base, title: "é".repeat(128) }, "request")
    ).not.toThrow();
    expect(() =>
      validateKbContract(KnowledgeBaseRequestSchema, { ...base, title: "é".repeat(129) }, "request")
    ).toThrow();
    expect(() =>
      validateKbContract(KnowledgeBaseRequestSchema, { ...base, title: "e\u0301" }, "request")
    ).toThrow();
    expect(() =>
      validateKbContract(
        KnowledgeBaseRequestSchema,
        { ...base, title: "bad\u0000title" },
        "request"
      )
    ).toThrow();
  });

  it("validates real RFC3339-Z dates rather than regex shape alone", () => {
    for (const timestamp of [NOW, "2024-02-29T23:59:59Z", "2026-12-31T23:59:60Z"])
      expect(() => validateKbContract(Rfc3339UtcSchema, timestamp, "timestamp")).not.toThrow();
    for (const timestamp of [
      "2026-02-29T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T00:00:00+00:00",
    ])
      expect(() => validateKbContract(Rfc3339UtcSchema, timestamp, "timestamp")).toThrow();
  });

  it("rejects duplicate profile/model identities and reader cross-limit inversion", () => {
    const registry = {
      schema_version: 1,
      profiles: [
        {
          schema_version: 1,
          kb_profile_id: "profile_1",
          kb_root: "/one",
          allow_create: false,
          repository_admission: { mode: "outside_worktree" },
        },
        {
          schema_version: 1,
          kb_profile_id: "profile_1",
          kb_root: "/two",
          allow_create: true,
          repository_admission: { mode: "outside_worktree" },
        },
      ],
    };
    expect(() => validateKbContract(KbProfileRegistrySchema, registry, "registry")).toThrow();

    const duplicatePolicy = defaultDenyPolicy("kb_1");
    duplicatePolicy.allowed_parent_models = [
      { provider: "provider", model: "model", locality: "local" },
      { provider: "provider", model: "model", locality: "remote" },
    ];
    expect(() => validateKbContract(KbPolicySchema, duplicatePolicy, "policy")).toThrow();

    const inverted = defaultDenyPolicy("kb_1");
    inverted.reader_limits.max_call_utf8_bytes = 1024;
    inverted.reader_limits.max_phase_utf8_bytes = 512;
    expect(() => validateKbContract(KbPolicySchema, inverted, "policy")).toThrow();
  });
});

describe("closed eight-action request union", () => {
  const requests: KnowledgeBaseRequest[] = [
    { schema_version: 1, action: "init", kb_profile_id: "profile_1", create: true, title: "KB" },
    {
      schema_version: 1,
      action: "ingest",
      kb_profile_id: "profile_1",
      source_capability_ids: ["source_capability_1"],
    },
    {
      schema_version: 1,
      action: "query",
      kb_profile_id: "profile_1",
      query: "question",
      page_ids: [],
      source_ids: [],
    },
    {
      schema_version: 1,
      action: "save",
      kb_profile_id: "profile_1",
      query_run_id: "query_1",
      page_kind: "synthesis",
      title: "Saved",
    },
    {
      schema_version: 1,
      action: "lint",
      kb_profile_id: "profile_1",
      mode: "deterministic",
      page_ids: [],
    },
    {
      schema_version: 1,
      action: "promote",
      kb_profile_id: "profile_1",
      page_revisions: [{ page_id: "page_1", revision_id: "revision_1" }],
      canonical_target_capability_ids: ["target_1"],
    },
    { schema_version: 1, action: "status", kb_profile_id: "profile_1", run_id: "run_1" },
    { schema_version: 1, action: "resume", kb_profile_id: "profile_1", run_id: "run_1" },
  ];

  it("accepts all and only the eight exact variants, including empty optional filters", () => {
    for (const request of requests)
      expect(() =>
        validateKbContract(KnowledgeBaseRequestSchema, request, "request")
      ).not.toThrow();
    expect(() =>
      validateKbContract(
        KnowledgeBaseRequestSchema,
        { schema_version: 1, action: "apply", kb_profile_id: "profile_1" },
        "request"
      )
    ).toThrow();
    expect(() =>
      validateKbContract(
        KnowledgeBaseRequestSchema,
        { ...requests[2], root: "/private" },
        "request"
      )
    ).toThrow();
  });

  it("enforces init title iff create and identity uniqueness", () => {
    expect(() =>
      validateKbContract(
        KnowledgeBaseRequestSchema,
        { schema_version: 1, action: "init", kb_profile_id: "profile_1", create: true },
        "request"
      )
    ).toThrow();
    expect(() =>
      validateKbContract(
        KnowledgeBaseRequestSchema,
        {
          schema_version: 1,
          action: "init",
          kb_profile_id: "profile_1",
          create: false,
          title: "forbidden",
        },
        "request"
      )
    ).toThrow();
    expect(() =>
      validateKbContract(
        KnowledgeBaseRequestSchema,
        {
          schema_version: 1,
          action: "promote",
          kb_profile_id: "profile_1",
          page_revisions: [
            { page_id: "page_1", revision_id: "revision_1" },
            { page_id: "page_1", revision_id: "revision_1" },
          ],
          canonical_target_capability_ids: ["target_1"],
        },
        "request"
      )
    ).toThrow();
  });
});

describe("exact public and replay result schemas", () => {
  it("enforces the status/met/next matrix and derived-answer constraints", () => {
    expect(() =>
      validateKbContract(
        KnowledgeBaseResultSchema,
        result({ status: "running", met: false, next: "resume" }),
        "result"
      )
    ).not.toThrow();
    expect(() =>
      validateKbContract(
        KnowledgeBaseResultSchema,
        result({ status: "running", met: true, next: "none" }),
        "result"
      )
    ).toThrow();

    const query = result({
      action: "query",
      artifacts: [handle("query_answer")],
      derived_answer: {
        authority: "advisory",
        text: "answer",
        citations: [{ kind: "page", page_id: "page_1", revision_id: "revision_1" }],
        contradictions: [],
        unknowns: [],
        canonical_verification_required: true,
      },
    });
    expect(() => validateKbContract(KnowledgeBaseResultSchema, query, "result")).not.toThrow();
    expect(() =>
      validateKbContract(KnowledgeBaseResultSchema, { ...query, action: "status" }, "result")
    ).toThrow();
  });

  it("enforces query/lint/review artifact cardinalities and identity uniqueness", () => {
    expect(() =>
      validateKbContract(
        KnowledgeBaseResultSchema,
        result({ action: "query", artifacts: [] }),
        "result"
      )
    ).toThrow();
    expect(() =>
      validateKbContract(
        KnowledgeBaseResultSchema,
        result({ action: "lint", artifacts: [handle("lint_report")] }),
        "result"
      )
    ).not.toThrow();
    expect(() =>
      validateKbContract(
        KnowledgeBaseResultSchema,
        result({
          action: "ingest",
          status: "awaiting_user",
          met: false,
          next: "review",
          artifacts: [handle("page_draft"), handle("lint_report"), handle("verification_report")],
        }),
        "result"
      )
    ).not.toThrow();
    expect(() =>
      validateKbContract(
        KnowledgeBaseResultSchema,
        result({
          action: "ingest",
          status: "awaiting_user",
          met: false,
          next: "review",
          artifacts: [handle("lint_report"), handle("page_draft"), handle("verification_report")],
        }),
        "result"
      )
    ).toThrow();
    expect(() =>
      validateKbContract(KnowledgeBaseResultSchema, result({ ids: ["same", "same"] }), "result")
    ).toThrow();
  });

  it("permits status in replay while still forbidding derived_answer", () => {
    expect(() =>
      validateKbContract(
        ReplayableKnowledgeBaseResultSchema,
        result({ action: "status" }),
        "replay"
      )
    ).not.toThrow();
    expect(() =>
      validateKbContract(
        ReplayableKnowledgeBaseResultSchema,
        { ...result({ action: "status" }), derived_answer: {} },
        "replay"
      )
    ).toThrow();
  });
});

describe("lint severity, composition identity, and verification union", () => {
  it("accepts blocking and rejects the unratified error lint severity", () => {
    const report = {
      schema_version: 1,
      artifact_kind: "lint_report",
      findings: [
        {
          finding_id: "finding_1",
          severity: "blocking",
          summary: "unsupported claim",
          evidence: [evidence()],
        },
      ],
      candidate_conflicts: [],
    };
    expect(() => validateKbContract(LintReportArtifactSchema, report, "lint")).not.toThrow();
    expect(() =>
      validateKbContract(
        LintReportArtifactSchema,
        { ...report, findings: [{ ...report.findings[0], severity: "error" }] },
        "lint"
      )
    ).toThrow();
  });

  it("rejects duplicated composition allocation identities", () => {
    const authority = {
      schema_version: 1,
      kb_id: "kb_1",
      base_generation_id: "generation_1",
      base_catalog_sha256: ZERO,
      private_input_sha256: ONE,
      selected_pages: [],
      allocations: [
        {
          page_id: "page_1",
          revision_id: "revision_1",
          lifecycle: "draft",
          source_ids: ["source_1"],
          claim_allocations: [
            { candidate_ref: "candidate_1", claim_id: "claim_1" },
            { candidate_ref: "candidate_1", claim_id: "claim_2" },
          ],
          supersedes: null,
        },
      ],
    };
    expect(() => validateKbContract(KbComposeAuthoritySchema, authority, "authority")).toThrow();
  });

  it("accepts exactly the ingest, query, and host-promotion verification variants", () => {
    const ingest = {
      schema_version: 1,
      artifact_kind: "verification_report",
      verified_artifact_ids: ["artifact_page"],
      claim_findings: [
        {
          page_id: "page_1",
          revision_id: "revision_1",
          claim_id: "claim_1",
          verdict: "supported",
          evidence: [evidence("claim_evidence")],
        },
      ],
    };
    const query = {
      schema_version: 1,
      artifact_kind: "verification_report",
      passed: true,
      answer_artifact_id: "artifact_answer",
      answer_sha256: ZERO,
      answer_verdict: "supported",
      citation_findings: [
        {
          citation: { kind: "page", page_id: "page_1", revision_id: "revision_1" },
          verdict: "supported",
          notes: "grounded",
        },
      ],
    };
    const promotion = {
      schema_version: 1,
      artifact_kind: "verification_report",
      verified: true,
      page_revisions: [{ page_id: "page_1", revision_id: "revision_1" }],
      targets: [
        {
          capability_id: "target_1",
          preimage_sha256: ZERO,
        },
      ],
      findings: [],
    };
    expect(() =>
      validateKbContract(IngestVerificationReportSchema, ingest, "ingest report")
    ).not.toThrow();
    expect(() =>
      validateKbContract(QueryVerificationReportSchema, query, "query report")
    ).not.toThrow();
    expect(() =>
      validateKbContract(PromotionVerificationSchema, promotion, "promotion report")
    ).not.toThrow();
    for (const report of [ingest, query, promotion])
      expect(() =>
        validateKbContract(VerificationReportArtifactSchema, report, "verification report")
      ).not.toThrow();
    expect(() =>
      validateKbContract(
        VerificationReportArtifactSchema,
        { schema_version: 1, artifact_kind: "verification_report", passed: true },
        "verification report"
      )
    ).toThrow();
  });

  it("rejects the removed stable-claim and bare-string evidence variants", () => {
    const extracted = {
      schema_version: 1,
      artifact_kind: "claims",
      source_ids: ["source_1"],
      claims: [
        {
          provisional_id: "candidate_1",
          text: "Synthetic extracted claim.",
          kind: "fact",
          confidence: "CERTAIN",
          evidence: [{ source_id: "source_1" }],
        },
      ],
    };
    expect(() => validateKbContract(ClaimsArtifactSchema, extracted, "claims")).not.toThrow();
    expect(() =>
      validateKbContract(
        ClaimsArtifactSchema,
        {
          ...extracted,
          claims: [
            {
              claim_id: "claim_legacy",
              text: "Legacy stable child claim.",
              kind: "fact",
              state: "supported",
              confidence: "CERTAIN",
              evidence: [{ source_id: "source_1" }],
              contradicts_claim_ids: [],
              canonical_verification_refs: [],
            },
          ],
        },
        "claims"
      )
    ).toThrow();
    const lint = {
      schema_version: 1,
      artifact_kind: "lint_report",
      findings: [
        {
          finding_id: "finding_1",
          severity: "warning",
          summary: "Synthetic finding.",
          evidence: [evidence("lint_evidence")],
        },
      ],
      candidate_conflicts: [],
    };
    expect(() => validateKbContract(LintReportArtifactSchema, lint, "lint")).not.toThrow();
    expect(() =>
      validateKbContract(
        LintReportArtifactSchema,
        { ...lint, findings: [{ ...lint.findings[0], evidence: ["legacy_ref"] }] },
        "lint"
      )
    ).toThrow();
  });

  it("requires the revised verification bindings and rejects legacy/path-bearing shapes", () => {
    const ingest = {
      schema_version: 1,
      artifact_kind: "verification_report",
      verified_artifact_ids: ["artifact_page"],
      claim_findings: [
        {
          page_id: "page_1",
          revision_id: "revision_1",
          claim_id: "claim_1",
          verdict: "supported",
          evidence: [evidence("claim_finding")],
        },
      ],
    };
    expect(() =>
      validateKbContract(IngestVerificationReportSchema, ingest, "ingest")
    ).not.toThrow();
    expect(() =>
      validateKbContract(
        IngestVerificationReportSchema,
        {
          ...ingest,
          claim_findings: [
            {
              claim_ref: { page_id: "page_1", revision_id: "revision_1", claim_id: "claim_1" },
              verdict: "supported",
              notes: "legacy nested finding",
            },
          ],
        },
        "ingest"
      )
    ).toThrow();

    const query = {
      schema_version: 1,
      artifact_kind: "verification_report",
      passed: true,
      answer_artifact_id: "artifact_answer",
      answer_sha256: ZERO,
      answer_verdict: "supported",
      citation_findings: [
        {
          citation: { kind: "page", page_id: "page_1", revision_id: "revision_1" },
          verdict: "supported",
          notes: "Grounded.",
        },
      ],
    };
    expect(() => validateKbContract(QueryVerificationReportSchema, query, "query")).not.toThrow();
    const textOnly = { ...query };
    delete (textOnly as Partial<typeof query>).answer_artifact_id;
    expect(() => validateKbContract(QueryVerificationReportSchema, textOnly, "query")).toThrow();

    const promotion = {
      schema_version: 1,
      artifact_kind: "verification_report",
      verified: true,
      page_revisions: [{ page_id: "page_1", revision_id: "revision_1" }],
      targets: [{ capability_id: "target_1", preimage_sha256: ZERO }],
      findings: [],
    };
    expect(() =>
      validateKbContract(PromotionVerificationSchema, promotion, "promotion")
    ).not.toThrow();
    expect(() =>
      validateKbContract(
        PromotionVerificationSchema,
        {
          ...promotion,
          targets: [
            { capability_id: "target_1", preimage_sha256: ZERO, authority_root: "/private" },
          ],
        },
        "promotion"
      )
    ).toThrow();
  });

  it("validates exact versioned private-input and idempotency projections", () => {
    const privateInput = {
      schema_version: 1,
      private_input_id: "private_1",
      run_id: "run_1",
      request_sha256: ZERO,
      storage_key: "run_1/request.json",
      temporary_storage_key: "run_1/.transaction_1.tmp",
      state: "preparing",
      created_at: NOW,
      updated_at: NOW,
    };
    const idempotency = {
      schema_version: 1,
      session_id: "session_1",
      invocation_id: "invocation_1",
      request_sha256: ZERO,
      kb_profile_id: "profile_1",
      action: "query",
      run_id: "run_1",
      transaction_id: "transaction_1",
      state: "running",
      created_at: NOW,
      updated_at: NOW,
    };
    expect(() =>
      validateKbContract(PrivateRunInputRecordSchema, privateInput, "private input")
    ).not.toThrow();
    expect(() =>
      validateKbContract(IdempotencyRecordSchema, idempotency, "idempotency")
    ).not.toThrow();
    for (const bad of [
      { ...privateInput, schema_version: 2 },
      { ...privateInput, created_at: "not-a-time" },
      { ...idempotency, action: "status" },
      { ...idempotency, updated_at: "2026-08-21" },
    ]) {
      const schema = Object.hasOwn(bad, "private_input_id")
        ? PrivateRunInputRecordSchema
        : IdempotencyRecordSchema;
      expect(() => validateKbContract(schema, bad, "projection")).toThrow();
    }
  });

  it("requires schema_version:1 on every private reader input and exact result members", () => {
    const inputs = [
      [ReadPhaseBriefInputSchema, { schema_version: 1 }],
      [ReadSourceSnapshotInputSchema, { schema_version: 1, source_id: "source_1" }],
      [ReadRunArtifactInputSchema, { schema_version: 1, artifact_id: "artifact_1" }],
      [SearchSelectedKbInputSchema, { schema_version: 1 }],
      [ReadSelectedPageInputSchema, { schema_version: 1, page_id: "page_1", revision_id: "rev_1" }],
      [ReadCanonicalTargetInputSchema, { schema_version: 1, capability_id: "target_1" }],
    ] as const;
    for (const [schema, valid] of inputs) {
      expect(() => validateKbContract(schema, valid, "reader input")).not.toThrow();
      const missing = { ...valid } as Record<string, unknown>;
      delete missing.schema_version;
      expect(() => validateKbContract(schema, missing, "reader input")).toThrow();
      expect(() => validateKbContract(schema, { ...valid, extra: true }, "reader input")).toThrow();
    }

    const phaseBrief = {
      schema_version: 1,
      run_id: "run_1",
      state_id: "ingest",
      brief: { action: "ingest", source_ids: ["source_1"] },
      allowed_prior_artifacts: [],
      allowed_selected_pages: [],
    };
    const source = {
      schema_version: 1,
      source_id: "source_1",
      sha256: ZERO,
      media_type: "text/plain",
      content_utf8: "source body",
    };
    const claims = {
      schema_version: 1,
      artifact_kind: "claims",
      source_ids: ["source_1"],
      claims: [],
    };
    const artifactResult = {
      schema_version: 1,
      artifact: handle("claims", "artifact_claims"),
      payload: claims,
    };
    const search = { schema_version: 1, generation_id: "generation_1", candidates: [] };
    const page = {
      schema_version: 1,
      generation_id: "generation_1",
      frontmatter: {
        schema_version: 1,
        page_id: "page_1",
        revision_id: "rev_1",
        kind: "synthesis",
        title: "Synthetic page",
        summary: "Synthetic summary.",
        authority: "advisory",
        lifecycle: "validated",
        created_at: NOW,
        derived_from: [],
        related_page_ids: [],
      },
      markdown:
        "## Synthesis\nOne.\n## Evidence\nTwo.\n## Tensions and unknowns\nThree.\n## Related\nFour.",
      claims: { schema_version: 1, page_id: "page_1", revision_id: "rev_1", claims: [] },
    };
    const target = {
      schema_version: 1,
      capability_id: "target_1",
      preimage_sha256: ZERO,
      media_type: "text/markdown",
      content_utf8: "target body",
    };
    const results = [
      [ReadPhaseBriefResultSchema, phaseBrief],
      [ReadSourceSnapshotResultSchema, source],
      [ReadRunArtifactResultSchema, artifactResult],
      [SearchSelectedKbResultSchema, search],
      [ReadSelectedPageResultSchema, page],
      [ReadCanonicalTargetResultSchema, target],
    ] as const;
    for (const [schema, valid] of results) {
      expect(() => validateKbContract(schema, valid, "reader result")).not.toThrow();
      expect(() =>
        validateKbContract(schema, { ...valid, path: "/private" }, "reader result")
      ).toThrow();
    }
  });

  it("enforces all-and-only review artifact digest projection", () => {
    const packet = {
      schema_version: 1,
      run_id: "run_ingest",
      session_id: "session_1",
      challenge_id: "challenge_1",
      kb_profile_id: "profile_1",
      kb_id: "kb_1",
      action: "ingest",
      base_generation_id: "generation_1",
      base_selector_sha256: ZERO,
      candidate_artifacts: [
        handle("page_draft"),
        handle("lint_report"),
        handle("verification_report"),
      ],
      candidate_artifact_digests: {
        artifact_page_draft: ZERO,
        artifact_lint_report: ZERO,
        artifact_verification_report: ZERO,
      },
      candidate_source_record_digests: { source_1: ZERO },
      candidate_conflict_allocations: [],
      policy_sha256: ZERO,
      issued_at: NOW,
      expires_at: "2026-08-21T13:34:56Z",
    };
    expect(() => validateKbContract(ContentReviewGatePacketSchema, packet, "packet")).not.toThrow();
    expect(() =>
      validateKbContract(
        ContentReviewGatePacketSchema,
        {
          ...packet,
          candidate_artifact_digests: {
            ...packet.candidate_artifact_digests,
            artifact_extra: ZERO,
          },
        },
        "packet"
      )
    ).toThrow();
  });
});
