import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Checkpointer } from "../src/checkpointer.js";
import { RunContext } from "../src/context.js";
import { OrchestrationRequestSchema, validateContract } from "../src/contracts.js";
import { createPrivateSessionResourceLoader } from "../src/model-client.js";
import { parsePromotionReceipt } from "../src/kb/approval-receipts.js";
import {
  KbActionSchema,
  canonicalJson,
  defaultDenyPolicy,
  sha256Hex,
  validateKbContract,
  type KbPolicy,
  type QueryKbRequest,
} from "../src/kb/contracts.js";
import {
  approveIngest,
  createTestOnlyIngestBodyRunner,
  ingestKb,
  type IngestSource,
  type PendingIngest,
} from "../src/kb/ingest.js";
import {
  ParentDeliveryGrantStore,
  decideParentDelivery,
  mintParentDeliveryGrant,
  validateQueryRequest,
} from "../src/kb/parent-delivery.js";
import { materializeRunInput, privateInputRoot, readRunInput } from "../src/private-inputs.js";
import { RunArtifactStore } from "../src/kb/run-artifacts.js";
import { initKb } from "../src/kb/workflows.js";
import { kbArtifactControl } from "./fixtures/kb-artifact-control.js";

const PROFILE = "kbp_privacy_matrix";
const SESSION = "sess_privacy_matrix";
const PARENT = { provider: "ollama", model: "qwen3.8:latest" };
const RAW_KINDS = ["SOURCE", "CLAIM", "PAGE", "QUERY", "REPORT", "PATCH"] as const;
type RawKind = (typeof RAW_KINDS)[number];
type RawSentinels = Record<Lowercase<RawKind>, string>;
const RAW_KIND_KEYS = {
  SOURCE: "source",
  CLAIM: "claim",
  PAGE: "page",
  QUERY: "query",
  REPORT: "report",
  PATCH: "patch",
} as const satisfies Record<RawKind, Lowercase<RawKind>>;

const roots: string[] = [];

function temporary(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `${label}-`));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rawSentinels(): RawSentinels {
  const nonce = randomBytes(12).toString("hex");
  const sentinel = (kind: RawKind, index: number): string =>
    ["RAW", kind, "SENTINEL", nonce, String(index)].join("_");
  return {
    source: sentinel("SOURCE", 0),
    claim: sentinel("CLAIM", 1),
    page: sentinel("PAGE", 2),
    query: sentinel("QUERY", 3),
    report: sentinel("REPORT", 4),
    patch: sentinel("PATCH", 5),
  } satisfies RawSentinels;
}

function derivedAnswerSentinel(): string {
  return ["DERIVED", "ANSWER", "SENTINEL", "GRANTED", randomBytes(12).toString("hex")].join("_");
}

function surfaceText(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("latin1");
  return typeof value === "string" ? value : JSON.stringify(value);
}

function assertRawAbsent(label: string, value: unknown, sentinels: RawSentinels): void {
  const text = surfaceText(value);
  for (const kind of RAW_KINDS) {
    if (text.includes(sentinels[RAW_KIND_KEYS[kind]])) {
      throw new Error(`raw ${RAW_KIND_KEYS[kind]} sentinel escaped into ${label}`);
    }
  }
}

function assertMarkerAbsent(label: string, value: unknown, marker: string): void {
  if (surfaceText(value).includes(marker)) {
    throw new Error(`derived-answer sentinel escaped into ${label}`);
  }
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const absolute = path.join(directory, entry);
      const info = lstatSync(absolute);
      if (info.isDirectory() && !info.isSymbolicLink()) walk(absolute);
      else files.push(absolute);
    }
  };
  walk(root);
  return files;
}

function readExistingFiles(paths: readonly string[]): Array<{ path: string; bytes: Buffer }> {
  return paths
    .filter((candidate) => existsSync(candidate) && lstatSync(candidate).isFile())
    .map((candidate) => ({ path: candidate, bytes: readFileSync(candidate) }));
}

function captureFailure(label: string, operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    return String(error);
  }
  throw new Error(`${label} fault did not fail`);
}

async function captureAsyncFailure(
  label: string,
  operation: () => Promise<unknown>
): Promise<string> {
  try {
    await operation();
  } catch (error) {
    return String(error);
  }
  throw new Error(`${label} fault did not fail`);
}

function source(sentinels: RawSentinels): IngestSource {
  return {
    sourceId: "src_privacy_matrix",
    capabilityDigest: "1".repeat(64),
    title: "Synthetic privacy matrix source",
    authors: ["Synthetic Fixture"],
    content: `Synthetic source body. ${sentinels.source}`,
    mediaType: "text/markdown",
    sourceType: "manual",
    capturedAt: "2026-08-21T00:00:00Z",
  };
}

function claimsPayload(sentinels: RawSentinels): string {
  return canonicalJson({
    schema_version: 1,
    artifact_kind: "claims",
    source_ids: ["src_privacy_matrix"],
    claims: [
      {
        provisional_id: "provisional_privacy_matrix",
        text: `Synthetic advisory claim. ${sentinels.claim}`,
        kind: "fact",
        confidence: "CERTAIN",
        evidence: [{ source_id: "src_privacy_matrix" }],
      },
    ],
  });
}

function pagePayload(sentinels: RawSentinels): string {
  return canonicalJson({
    schema_version: 1,
    artifact_kind: "page_draft",
    pages: [
      {
        frontmatter: {
          schema_version: 1,
          page_id: "page_privacy_matrix",
          revision_id: "rev_privacy_matrix_1",
          kind: "synthesis",
          title: "Synthetic privacy matrix",
          summary: "Synthetic non-personal copy-surface fixture.",
          authority: "advisory",
          lifecycle: "validated",
          created_at: "2026-08-21T00:00:00Z",
          derived_from: ["src_privacy_matrix"],
          related_page_ids: [],
        },
        markdown: [
          "## Synthesis",
          `Synthetic private page body. ${sentinels.page}`,
          "## Evidence",
          "- One synthetic source supports one synthetic claim.",
          "## Tensions and unknowns",
          "- None; this is a non-personal fixture.",
          "## Related",
          "- None.",
        ].join("\n"),
        claims: {
          schema_version: 1,
          page_id: "page_privacy_matrix",
          revision_id: "rev_privacy_matrix_1",
          claims: [
            {
              claim_id: "clm_privacy_matrix",
              text: `Synthetic advisory claim. ${sentinels.claim}`,
              kind: "fact",
              state: "supported",
              confidence: "CERTAIN",
              evidence: [{ source_id: "src_privacy_matrix" }],
              contradicts_claim_ids: [],
              canonical_verification_refs: [],
            },
          ],
        },
      },
    ],
  });
}

function reportPayload(sentinels: RawSentinels): string {
  return canonicalJson({
    schema_version: 1,
    artifact_kind: "lint_report",
    findings: [
      {
        finding_id: "fnd_privacy_matrix",
        severity: "warning",
        summary: `Synthetic private report finding. ${sentinels.report}`,
        evidence: [
          {
            evidence_id: "evidence_privacy_matrix",
            kind: "artifact",
            ref: "clm_privacy_matrix",
          },
        ],
      },
    ],
    candidate_conflicts: [],
  });
}

function verificationPayload(): string {
  return canonicalJson({
    schema_version: 1,
    artifact_kind: "verification_report",
    verified_artifact_ids: [],
    claim_findings: [
      {
        page_id: "page_privacy_matrix",
        revision_id: "rev_privacy_matrix_1",
        claim_id: "clm_privacy_matrix",
        verdict: "supported",
        evidence: [
          {
            evidence_id: "evidence_verification_privacy",
            kind: "source",
            ref: "src_privacy_matrix",
          },
        ],
      },
    ],
  });
}

function requiredArtifactId(ids: Readonly<Record<string, string>>, kind: string): string {
  const artifactId = ids[kind];
  if (artifactId === undefined) throw new Error(`privacy ingest result is missing '${kind}'`);
  return artifactId;
}

function pendingFrom(result: Awaited<ReturnType<typeof ingestKb>>): PendingIngest {
  const ids = Object.fromEntries(
    result.artifacts.map((artifact) => [artifact.artifact_kind, artifact.artifact_id])
  );
  return {
    runId: result.run_id,
    sourceIds: ["src_privacy_matrix"],
    claimsArtifactId: requiredArtifactId(ids, "claims"),
    pageDraftArtifactId: requiredArtifactId(ids, "page_draft"),
    lintReportArtifactId: requiredArtifactId(ids, "lint_report"),
    verificationArtifactId: requiredArtifactId(ids, "verification_report"),
  };
}

function allowingPolicy(): KbPolicy {
  return {
    ...defaultDenyPolicy("kb_privacy_matrix"),
    allowed_parent_models: [{ ...PARENT, locality: "local" }],
    parent_result: {
      derived_query_answer: "allow_explicit_derived_answer",
      max_utf8_bytes: 8_192,
    },
  };
}

describe("G9 privacy and copy-surface matrix", () => {
  it("exercises unique raw markers on success and source/artifact/review/promotion faults", async () => {
    const sentinels = rawSentinels();
    expect(new Set(Object.values(sentinels)).size).toBe(RAW_KINDS.length);

    const projectRoot = temporary("penny-kb-privacy-matrix");
    const kbRoot = path.join(projectRoot, "private-kb");
    const artifactCheckpointer = kbArtifactControl({
      root: projectRoot,
      runId: "run_privacy_success",
      profileId: PROFILE,
    });
    const workflowContext = {
      kbRoot,
      profileId: PROFILE,
      runId: "run_privacy_success",
      checkpointer: artifactCheckpointer,
    };
    initKb({ ...workflowContext, runId: "run_privacy_init" }, "Synthetic Privacy Matrix");

    const childSnapshots: unknown[] = [];
    const runner = createTestOnlyIngestBodyRunner(async (invocation) => {
      for (const sourceId of invocation.sourceAllowlist) {
        const body = invocation.readSource(sourceId);
        if (!body.includes(sentinels.source)) throw new Error("source reader lost synthetic body");
      }
      const readPhaseOutput = invocation.readPhaseOutput;
      for (const stateId of invocation.priorPhaseAllowlist) {
        if (readPhaseOutput === undefined) {
          throw new Error("host did not provide the required prior-phase reader");
        }
        readPhaseOutput(stateId);
      }
      childSnapshots.push({
        agent: invocation.agent,
        state_id: invocation.stateId,
        source_ids: [...invocation.sourceAllowlist],
        prior_states: [...invocation.priorPhaseAllowlist],
      });
      const payloads: Record<string, string> = {
        ingest: claimsPayload(sentinels),
        compose: pagePayload(sentinels),
        lint: reportPayload(sentinels),
        verify: verificationPayload(),
      };
      const payload = payloads[invocation.stateId];
      if (payload === undefined) throw new Error("synthetic phase is unsupported");
      return payload;
    });

    const waiting = await ingestKb(workflowContext, [source(sentinels)], runner);
    expect(waiting).toMatchObject({ status: "awaiting_user", next: "review" });
    const pending = pendingFrom(waiting);
    const approved = approveIngest(workflowContext, [source(sentinels)], pending);
    expect(approved).toMatchObject({ status: "complete", met: true });

    const failureText: string[] = [];
    const emptyAuthorControl = kbArtifactControl({
      root: projectRoot,
      runId: "run_privacy_source_invalid",
      profileId: PROFILE,
    });
    const emptyAuthorSource = await ingestKb(
      {
        ...workflowContext,
        runId: "run_privacy_source_invalid",
        checkpointer: emptyAuthorControl,
      },
      [{ ...source(sentinels), authors: [] }],
      runner
    );
    // Section 5 permits an empty author list; this still must not leak source bytes.
    expect(emptyAuthorSource).toMatchObject({ status: "awaiting_user", next: "review" });
    failureText.push(canonicalJson(emptyAuthorSource));
    failureText.push(
      await captureAsyncFailure("source reader", () =>
        ingestKb(
          { ...workflowContext, runId: "run_privacy_source_fault" },
          [source(sentinels)],
          createTestOnlyIngestBodyRunner(async (invocation) => {
            invocation.readSource("src_not_admitted");
            return claimsPayload(sentinels);
          })
        )
      )
    );

    const artifactFaultControl = kbArtifactControl({
      root: projectRoot,
      runId: "run_privacy_artifact_fault",
      profileId: PROFILE,
      action: "lint",
    });
    const artifactFaultStore = new RunArtifactStore(
      kbRoot,
      "run_privacy_artifact_fault",
      artifactFaultControl
    );
    try {
      failureText.push(
        captureFailure("artifact validation", () =>
          artifactFaultStore.stage({
            state_id: "lint",
            kb_profile_id: PROFILE,
            artifact_kind: "lint_report",
            content: canonicalJson({
              schema_version: 1,
              artifact_kind: "lint_report",
              findings: [],
              candidate_conflicts: [],
              private_probe: Object.values(sentinels),
            }),
          })
        )
      );
    } finally {
      artifactFaultStore.close();
    }

    failureText.push(
      captureFailure("content review", () =>
        approveIngest(workflowContext, [source(sentinels)], {
          ...pending,
          pageDraftArtifactId: "art_missing_privacy_review",
        })
      )
    );
    failureText.push(
      captureFailure("promotion receipt", () =>
        parsePromotionReceipt(canonicalJson({ private_probe: Object.values(sentinels) }))
      )
    );

    const pennyRoot = path.join(projectRoot, ".penny");
    mkdirSync(pennyRoot, { recursive: true, mode: 0o700 });
    const controlPath = path.join(pennyRoot, "orchestration-v2.db");
    const checkpointer = new Checkpointer(controlPath);
    const context = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: "run_privacy_control",
        session_id: SESSION,
        playbook: "knowledge-base",
        engine_owner: "typescript",
      },
      goal: "Retain only safe synthetic privacy evidence.",
      constraints: {
        action: "ingest",
        kb_profile_id: PROFILE,
        source_capability_ids: ["cap_safe"],
      },
      projectRoot,
      trustProfile: "hardened-untrusted",
      maxSteps: 20,
    });
    Object.assign(context.knowledgeBaseData, {
      action: "ingest",
      profile_id: PROFILE,
      phases: Object.fromEntries(
        waiting.artifacts.map((artifact) => [
          artifact.artifact_kind,
          {
            artifact_kind: artifact.artifact_kind,
            kb_artifact_id: artifact.artifact_id,
            counts: {},
            sha256: artifact.sha256,
          },
        ])
      ),
    });
    const contextSnapshot = context.snapshot();
    checkpointer.createRun(context, "privacy_matrix_safe_checkpoint", {
      run_id: context.identity.run_id,
      artifact_count: waiting.artifacts.length,
    });

    const privateQueryRequest = validateQueryRequest({
      schema_version: 1,
      action: "query",
      kb_profile_id: PROFILE,
      query: `Synthetic private query. ${sentinels.query}`,
      verify_grounding: false,
    });
    const queryRunId = "run_privacy_query_input";
    const queryContext = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: queryRunId,
        session_id: SESSION,
        playbook: "knowledge-base",
        engine_owner: "typescript",
      },
      goal: "Read the stored private request without copying it to control state.",
      constraints: { action: "query", kb_profile_id: PROFILE, parent_identity: null },
      projectRoot,
      trustProfile: "hardened-untrusted",
      maxSteps: 8,
    });
    const queryRequestSha256 = sha256Hex(canonicalJson(privateQueryRequest));
    const queryAdmission = checkpointer.admitStartRun(queryContext, {
      session_id: SESSION,
      invocation_id: "call_privacy_query_input",
      request_sha256: queryRequestSha256,
      action: "query",
      profile_id: PROFILE,
      transaction_id: "tx_privacy_query_input",
      private_input_id: "pri_privacy_query_input",
      storage_key: `${queryRunId}/request.json`,
      temporary_storage_key: `${queryRunId}/.tx_privacy_query_input.tmp`,
    });
    expect(queryAdmission.kind).toBe("created");
    materializeRunInput({
      projectRoot,
      checkpointer,
      runId: queryRunId,
      request: privateQueryRequest,
      requestSha256: queryRequestSha256,
    });
    expect(readRunInput({ projectRoot, checkpointer, runId: queryRunId })).toEqual(
      privateQueryRequest
    );

    const controlFilesWhileOpen = readExistingFiles(
      ["", "-wal", "-shm"].map((suffix) => `${controlPath}${suffix}`)
    );
    for (const file of controlFilesWhileOpen) {
      assertRawAbsent(
        `orchestration DB surface ${path.basename(file.path)}`,
        file.bytes,
        sentinels
      );
    }
    checkpointer.close();
    for (const file of readExistingFiles(
      ["", "-wal", "-shm"].map((suffix) => `${controlPath}${suffix}`)
    )) {
      assertRawAbsent(
        `closed orchestration DB surface ${path.basename(file.path)}`,
        file.bytes,
        sentinels
      );
    }

    const isolated = await createPrivateSessionResourceLoader({
      projectRoot,
      agentDir: temporary("penny-kb-privacy-agent-dir"),
      systemPrompt: "Synthetic private child; use only host-closed tools.",
    });
    expect(isolated.resourceLoader.getExtensions().extensions).toEqual([]);
    expect(isolated.resourceLoader.getSkills().skills).toEqual([]);
    expect(isolated.resourceLoader.getPrompts().prompts).toEqual([]);

    const surfaces: Array<[string, unknown]> = [
      ["parent waiting result", waiting],
      ["parent approval result", approved],
      ["adapter/app tool details", { waiting, approved }],
      ["adapter/app failure text", failureText],
      [
        "observability details",
        {
          states: [waiting.status, approved.status, emptyAuthorSource.status],
          artifact_ids: waiting.artifacts.map((artifact) => artifact.artifact_id),
          failure_classes: failureText.map(() => "bounded_failure"),
        },
      ],
      ["child session snapshot", childSnapshots],
      ["orchestration context snapshot", contextSnapshot],
      ["memory fixture and transport projection", { extensions: [], transports: [] }],
    ];
    for (const [label, value] of surfaces) assertRawAbsent(label, value, sentinels);

    const projectFiles = filesUnder(projectRoot);
    const queryInputRoot = privateInputRoot(projectRoot);
    for (const candidate of projectFiles) {
      const relative = path.relative(projectRoot, candidate);
      expect(relative).not.toMatch(
        /(?:^|\/)(?:__snapshots__|\.mempalace)(?:\/|$)|\.jsonl$|\.snap$/
      );
      if (!lstatSync(candidate).isFile()) continue;
      const bytes = readFileSync(candidate);
      const containsRaw = Object.values(sentinels).some((sentinel) =>
        bytes.includes(Buffer.from(sentinel, "utf8"))
      );
      const inKbPlane = candidate === kbRoot || candidate.startsWith(`${kbRoot}${path.sep}`);
      const inPrivateInputPlane =
        candidate === queryInputRoot || candidate.startsWith(`${queryInputRoot}${path.sep}`);
      if (containsRaw && !inKbPlane && !inPrivateInputPlane) {
        throw new Error(`raw sentinel reached unintended temporary path ${relative}`);
      }
    }
  });

  it("permits one marked derived answer only with the exact grant and policy", () => {
    const sentinels = rawSentinels();
    const derived = derivedAnswerSentinel();
    const request: QueryKbRequest = validateQueryRequest({
      schema_version: 1,
      action: "query",
      kb_profile_id: PROFILE,
      query: `Synthetic private query. ${sentinels.query}`,
      answer_delivery: "parent_tool_result",
    });
    const answer = {
      authority: "advisory" as const,
      text: `Explicitly granted synthetic answer. ${derived}`,
      citations: [
        {
          kind: "page" as const,
          page_id: "page_privacy_matrix",
          revision_id: "rev_privacy_matrix_1",
        },
      ],
      contradictions: [],
      unknowns: [],
      canonical_verification_required: true as const,
    };
    const answerArtifact = { schema_version: 1, artifact_kind: "query_answer", answer } as const;
    const answerJcs = canonicalJson(answerArtifact);
    const answerHandle = {
      schema_version: 1,
      artifact_id: "artifact_privacy_answer",
      artifact_kind: "query_answer" as const,
      sha256: sha256Hex(answerJcs),
      media_type: "application/json" as const,
      byte_length: Buffer.byteLength(answerJcs, "utf8"),
    };
    const verification = {
      schema_version: 1,
      artifact_kind: "verification_report",
      passed: true,
      answer_artifact_id: answerHandle.artifact_id,
      answer_sha256: answerHandle.sha256,
      answer_verdict: "supported" as const,
      citation_findings: answer.citations.map((citation) => ({
        citation,
        verdict: "supported" as const,
        notes: "Synthetic selected page supports the derived answer.",
      })),
    };
    const grantRoot = temporary("penny-kb-privacy-grants");
    const store = new ParentDeliveryGrantStore(grantRoot);
    const grant = mintParentDeliveryGrant({
      session_id: SESSION,
      invocation_id: SESSION,
      request,
      policy_sha256: sha256Hex(canonicalJson(allowingPolicy())),
      parent_provider: PARENT.provider,
      parent_model: PARENT.model,
      max_utf8_bytes: 4_096,
      issued_at: new Date(Date.now() - 1_000).toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      grant_id: "pgt_privacy_matrix",
    });
    store.mint(grant);

    const base = {
      storeDir: grantRoot,
      host: { session_id: SESSION, invocation_id: SESSION },
      request,
      parentIdentity: PARENT,
      runId: "run_privacy_parent_delivery",
      answer,
      answerHandle,
      verificationReport: verification,
      queryCompleteAndMet: true,
    };
    const policyDenied = decideParentDelivery({
      ...base,
      policy: defaultDenyPolicy("kb_privacy_matrix"),
    });
    expect(policyDenied).toMatchObject({
      outcome: "refused",
      reason_code: "grant_mismatch_policy",
    });
    assertMarkerAbsent("policy-denied parent result", policyDenied, derived);

    const noGrantRoot = temporary("penny-kb-privacy-no-grant");
    new ParentDeliveryGrantStore(noGrantRoot);
    const grantMissing = decideParentDelivery({
      ...base,
      storeDir: noGrantRoot,
      policy: allowingPolicy(),
    });
    expect(grantMissing).toMatchObject({ outcome: "refused", reason_code: "grant_missing" });
    assertMarkerAbsent("grant-missing parent result", grantMissing, derived);

    const delivered = decideParentDelivery({ ...base, policy: allowingPolicy() });
    expect(delivered.outcome).toBe("delivered");
    if (delivered.outcome !== "delivered")
      throw new Error("exact grant and policy did not deliver");
    const parentResult = {
      schema_version: 1,
      action: "query",
      status: "complete",
      met: true,
      derived_answer: delivered.derived_answer,
    };
    assertRawAbsent("explicitly granted parent result", parentResult, sentinels);
    expect(surfaceText(parentResult).split(derived)).toHaveLength(2);

    const replay = decideParentDelivery({ ...base, policy: allowingPolicy() });
    expect(replay).toMatchObject({ outcome: "refused", reason_code: "grant_consumed" });
    assertMarkerAbsent("consumed-grant replay result", replay, derived);

    const nonParentSurfaces: Array<[string, unknown]> = [
      ["policy-denied tool details", policyDenied],
      ["grant-missing tool details", grantMissing],
      ["consumed-grant tool details", replay],
      ["derived-answer observability", { outcome: "delivered", byte_count: answer.text.length }],
      ["derived-answer child snapshot", { state: "complete", persisted: false }],
      ["derived-answer memory transport", { transports: [] }],
      ["derived-answer failure output", [policyDenied.outcome, grantMissing.outcome]],
    ];
    for (const [label, surface] of nonParentSurfaces) assertMarkerAbsent(label, surface, derived);

    for (const root of [grantRoot, noGrantRoot]) {
      for (const candidate of filesUnder(root)) {
        if (lstatSync(candidate).isFile()) {
          assertRawAbsent("grant persistence", readFileSync(candidate), sentinels);
          assertMarkerAbsent("grant persistence", readFileSync(candidate), derived);
        }
      }
    }
  });

  it("keeps approve/apply absent from every public action vocabulary", () => {
    expect(() => validateKbContract(KbActionSchema, "approve", "KB action")).toThrow();
    expect(() => validateKbContract(KbActionSchema, "apply", "KB action")).toThrow();
    for (const action of ["promotion-approve", "promotion-apply"]) {
      expect(() =>
        validateContract(
          OrchestrationRequestSchema,
          { schema_version: 2, action },
          "orchestration request"
        )
      ).toThrow();
    }
  });

  it("keeps canonical mutation code free of logging, memory, subprocess, and Git surfaces", () => {
    const sourceText = [
      readFileSync(path.resolve("src/kb/promotion.ts"), "utf8"),
      readFileSync(path.resolve("src/kb/approval-receipts.ts"), "utf8"),
    ].join("\n");
    expect(sourceText).not.toMatch(
      /console\.|createLogger|mempalace|node:child_process|\bexecSync\b|\bspawnSync\b|git\s+(?:commit|push)/i
    );
  });
});
