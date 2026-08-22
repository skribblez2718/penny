/**
 * Frozen §5.13 G8 answer-quality oracle.
 *
 * The private receipt chooses the tracked fixture, case count, digest, and
 * maximum rate. The oracle never tunes or rewrites those frozen inputs. Every
 * case runs through deterministic retrieval and, when candidates are eligible,
 * the current Synthia → Vera artifact/finalization seam with test-only synthetic
 * agents. No provider or model is called.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scoreAnswerQuality, type AnswerQualityCaseObservation } from "../../src/kb/answer-quality.js";
import {
  canonicalJson,
  sha256Hex,
  type KbRetrievalFixtureV1,
  type RetrievalBaselineDecisionV1,
  type RetrievalFixtureCaseV1,
} from "../../src/kb/contracts.js";
import {
  assertRetrievalDecisionFixture,
  parseGateDecisionReceiptJcs,
} from "../../src/kb/gate-decisions.js";
import {
  pageClaimsPath,
  pageMarkdownPath,
  readManifest,
  readPolicy,
  writePageRevision,
} from "../../src/kb/filesystem.js";
import { buildCatalog, buildGenerationIndex, publishGeneration } from "../../src/kb/generations.js";
import { defaultKbIngestPlane, type KbQueryOutcome } from "../../src/kb/ingest-plane.js";
import { KbWorkerClient } from "../../src/kb/kb-worker-client.js";
import { validateQueryRequest } from "../../src/kb/parent-delivery.js";
import { KbQueryReader } from "../../src/kb/query-reader.js";
import { assessQueryVerification } from "../../src/kb/query-verification.js";
import { RunArtifactStore } from "../../src/kb/run-artifacts.js";
import { createTestOnlyArtifactBodyRunner } from "../../src/kb/session-tools.js";
import { initKb } from "../../src/kb/workflows.js";
import type { AgentInvocation } from "../../src/model-client.js";
import { kbArtifactControl } from "./kb-artifact-control.js";

type FrozenReceipt = RetrievalBaselineDecisionV1;
type FrozenCase = RetrievalFixtureCaseV1;
type FrozenFixture = KbRetrievalFixtureV1;

interface ExecutedCase {
  readonly observation: AnswerQualityCaseObservation;
  readonly agentPhases: readonly string[];
  readonly candidateCount: number;
  readonly error?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const receiptPath = path.join(
  repoRoot,
  ".penny/plan-gates/hybrid-kb-ts-plan-2026-08-13/retrieval_baseline.json"
);
const receiptExists = existsSync(receiptPath);
const receiptBytes = receiptExists ? readFileSync(receiptPath, "utf8") : undefined;
const parsedReceipt =
  receiptBytes === undefined ? undefined : parseGateDecisionReceiptJcs(receiptBytes);
const receipt: FrozenReceipt | undefined =
  parsedReceipt?.decision_kind === "retrieval_baseline" ? parsedReceipt : undefined;
const fixturePath =
  receipt === undefined ? undefined : path.resolve(repoRoot, receipt.fixture_path);
const fixtureBytes =
  fixturePath === undefined || !existsSync(fixturePath)
    ? undefined
    : readFileSync(fixturePath, "utf8");
const fixture: FrozenFixture | undefined =
  fixtureBytes === undefined || receipt === undefined
    ? undefined
    : assertRetrievalDecisionFixture({ decision: receipt, fixtureBytes });

const PROFILE = "kbp_answer_quality_oracle";
const NOW = "2026-01-01T00:00:00Z";
const FROZEN_FIXTURE_PATH = "apps/orchestration/tests/fixtures/kb-retrieval.json";
const FROZEN_CASE_IDS = ["sqlite-query", "typebox-query", "cross-query"] as const;
const dirs: string[] = [];

function tmpRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-kb-answer-oracle-"));
  dirs.push(root);
  return root;
}

afterEach(() => {
  for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true });
});

function validateFrozenInputs(): void {
  if (
    receipt === undefined ||
    fixturePath === undefined ||
    fixtureBytes === undefined ||
    fixture === undefined
  ) {
    throw new Error("the exact owner retrieval receipt and tracked fixture are required");
  }
  expect(parseGateDecisionReceiptJcs(receiptBytes)).toEqual(receipt);
  expect(receipt.schema_version).toBe(1);
  expect(receipt.decision_kind).toBe("retrieval_baseline");
  expect(receipt.approved_by_subject_id).not.toBe(receipt.reviewed_by_subject_id);
  expect(receipt.fixture_path).toBe(FROZEN_FIXTURE_PATH);
  expect(path.resolve(repoRoot, FROZEN_FIXTURE_PATH)).toBe(fixturePath);
  expect(receipt.case_count).toBe(FROZEN_CASE_IDS.length);
  expect(receipt.k).toBe(10);
  expect(receipt.minimum_hit_at_k).toBe(1);
  expect(receipt.minimum_mrr).toBe(1);
  expect(receipt.minimum_contradiction_recall).toBe(1);
  expect(receipt.maximum_unsupported_answer_rate).toBe(0);
  expect(assertRetrievalDecisionFixture({ decision: receipt, fixtureBytes })).toEqual(fixture);
  expect(fixture.cases).toHaveLength(receipt.case_count);
  expect(fixture.cases.map((testCase) => testCase.case_id)).toEqual(FROZEN_CASE_IDS);
  expect(new Set(fixture.cases.map((testCase) => testCase.case_id)).size).toBe(
    receipt.case_count
  );
  expect(receipt.evidence_refs).toContainEqual({
    evidence_id: "retrieval-fixture",
    kind: "digest",
    ref: fixture.fixture_id,
  });
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
}

function seedFrozenFixture(kbRoot: string, frozen: FrozenFixture): string {
  const initialized = initKb(
    { kbRoot, profileId: PROFILE, runId: "run_answer_quality_init" },
    "Frozen answer-quality fixture",
    {
      kb_id: "kb_answer_quality_fixture",
      generation_id: "gen_answer_quality_empty",
      created_at: NOW,
    }
  );
  if (initialized.status !== "complete" || initialized.kb_id === undefined) {
    throw new Error("could not initialize the answer-quality fixture KB");
  }

  for (const page of frozen.corpus) {
    writePageRevision(kbRoot, page.frontmatter, page.markdown, page.claims);
  }

  const generationId = "gen_answer_quality_frozen";
  const { index_sha256 } = buildGenerationIndex(
    kbRoot,
    generationId,
    initialized.kb_id,
    frozen.corpus.map((page) => ({
      page_id: page.frontmatter.page_id,
      revision_id: page.frontmatter.revision_id,
      title: page.frontmatter.title,
      summary: page.frontmatter.summary,
      body_sha256: sha256Hex(page.markdown),
      body: page.markdown,
    }))
  );
  const catalog = buildCatalog({
    generation_id: generationId,
    kb_id: initialized.kb_id,
    manifest: readManifest(kbRoot),
    policy: readPolicy(kbRoot),
    pages: frozen.corpus.map((page) => ({
      page_id: page.frontmatter.page_id,
      revision_id: page.frontmatter.revision_id,
      page_sha256: sha256Hex(
        readFileSync(
          pageMarkdownPath(kbRoot, page.frontmatter.page_id, page.frontmatter.revision_id),
          "utf8"
        )
      ),
      claims_sha256: sha256Hex(
        readFileSync(
          pageClaimsPath(kbRoot, page.frontmatter.page_id, page.frontmatter.revision_id),
          "utf8"
        )
      ),
    })),
    source_records: [],
    source_objects: [],
    conflicts: [],
    index_sha256,
  });
  publishGeneration(kbRoot, catalog);
  return generationId;
}

function invocation(input: {
  readonly projectRoot: string;
  readonly agent: "synthia" | "vera";
  readonly stateId: "query" | "verify";
}): AgentInvocation {
  return {
    agent: input.agent,
    stateId: input.stateId,
    task: "Execute one deterministic frozen answer-quality fixture case.",
    projectRoot: input.projectRoot,
    trustProfile: "hardened-untrusted",
    inputArtifacts: [],
    artifactConsumer: "kb-answer-quality-oracle",
  };
}

function citationPage(citation: unknown): { page_id: string; revision_id: string } | undefined {
  const value = asObject(citation);
  return typeof value["page_id"] === "string" && typeof value["revision_id"] === "string"
    ? { page_id: value["page_id"], revision_id: value["revision_id"] }
    : undefined;
}

/**
 * Test-only deterministic agents exercise the production query-reader posture.
 * They receive no fixture case, relevance labels, supported-citation oracle, or
 * contradiction ground truth. Synthia chooses from the admitted-query search;
 * Vera independently reopens each cited published page through its allowlist.
 */
function syntheticAgents(phases: string[]) {
  return createTestOnlyArtifactBodyRunner((phase) => {
    phases.push(phase.stateId);
    if (phase.stateId === "query") {
      const search = asObject(JSON.parse(phase.searchSelectedKb?.() ?? "{}"));
      const candidates = Array.isArray(search["candidates"])
        ? search["candidates"].map((candidate) => {
            const value = asObject(candidate);
            if (typeof value["page_id"] !== "string" || typeof value["revision_id"] !== "string") {
              throw new Error("retrieval returned a malformed candidate");
            }
            return { page_id: value["page_id"], revision_id: value["revision_id"] };
          })
        : [];
      const selectedCandidate = candidates[0];
      if (selectedCandidate === undefined) {
        throw new Error("synthetic Synthia received no retrieval candidate");
      }
      const selected = asObject(
        JSON.parse(
          phase.readSelectedPage?.(
            selectedCandidate.page_id,
            selectedCandidate.revision_id
          ) ?? "{}"
        )
      );
      const markdown = String(selected["markdown"] ?? "");
      const synthesis = markdown.match(/## Synthesis\n([^\n]+)/u)?.[1];
      if (synthesis === undefined) throw new Error("selected page has no synthesis statement");
      return canonicalJson({
        schema_version: 1,
        artifact_kind: "query_answer",
        answer: {
          authority: "advisory",
          text: synthesis,
          citations: [
            {
              kind: "page",
              page_id: selectedCandidate.page_id,
              revision_id: selectedCandidate.revision_id,
            },
          ],
          contradictions: [],
          unknowns: [],
          canonical_verification_required: true,
        },
      });
    }

    const prior = phase.allowedPriorArtifacts?.[0];
    if (prior === undefined) throw new Error("synthetic Vera received no Synthia artifact");
    const priorRead = asObject(JSON.parse(phase.readRunArtifact?.(prior.artifact_id) ?? "{}"));
    const answerHandle = asObject(priorRead["artifact"]);
    const payload = asObject(priorRead["payload"]);
    const answer = asObject(payload["answer"]);
    const answerText = String(answer["text"] ?? "");
    const citations = Array.isArray(answer["citations"]) ? answer["citations"] : [];
    const findings = citations.map((citation) => {
      const page = citationPage(citation);
      let isSupported = false;
      if (page !== undefined) {
        const selected = asObject(
          JSON.parse(phase.readSelectedPage?.(page.page_id, page.revision_id) ?? "{}")
        );
        isSupported = String(selected["markdown"] ?? "").includes(answerText);
      }
      return {
        citation,
        verdict: isSupported ? "supported" : "unsupported",
        notes: isSupported
          ? "The cited selected-generation page contains the answer statement."
          : "The cited selected-generation page does not support the answer statement.",
      };
    });
    const passed =
      answerText.length > 0 &&
      findings.length > 0 &&
      findings.every((finding) => finding.verdict === "supported");
    return canonicalJson({
      schema_version: 1,
      artifact_kind: "verification_report",
      passed,
      answer_artifact_id: String(answerHandle["artifact_id"] ?? ""),
      answer_sha256: String(answerHandle["sha256"] ?? ""),
      answer_verdict: passed ? "supported" : "unsupported",
      citation_findings: findings,
    });
  });
}

function artifactId(completion: Awaited<ReturnType<KbWorkerClient["runAgent"]>>): string {
  const id = completion.details?.["kb_artifact_id"];
  if (typeof id !== "string") throw new Error("agent completion has no artifact id");
  return id;
}

function readObservation(input: {
  readonly kbRoot: string;
  readonly runId: string;
  readonly testCase: FrozenCase;
  readonly outcome: KbQueryOutcome;
  readonly checkpointer: ReturnType<typeof kbArtifactControl>;
  readonly answerArtifactId?: string;
  readonly verificationArtifactId?: string;
}): AnswerQualityCaseObservation {
  let citations: readonly unknown[] = [];
  let verificationSupported = false;
  if (input.answerArtifactId !== undefined) {
    using store = new RunArtifactStore(input.kbRoot, input.runId, input.checkpointer);
    const answerRead = store.read(input.answerArtifactId);
    const answerDocument = JSON.parse(answerRead.content) as unknown;
    const answer = asObject(asObject(answerDocument)["answer"]);
    citations = Array.isArray(answer["citations"]) ? answer["citations"] : [];
    if (input.verificationArtifactId !== undefined) {
      const report = JSON.parse(store.read(input.verificationArtifactId).content) as unknown;
      verificationSupported = assessQueryVerification(
        answerDocument,
        report,
        answerRead.handle
      ).passed;
    }
  }
  return {
    caseId: input.testCase.case_id,
    supportedCitations: input.testCase.supported_citations,
    finalResult: {
      status: input.outcome.status,
      met: input.outcome.met,
      citations,
      verificationSupported,
    },
  };
}

async function executeFrozenCase(input: {
  readonly projectRoot: string;
  readonly kbRoot: string;
  readonly generationId: string;
  readonly testCase: FrozenCase;
  readonly k: number;
}): Promise<ExecutedCase> {
  const phases: string[] = [];
  const runId = `run_answer_quality_${input.testCase.case_id.replace(/-/gu, "_")}`;
  const request = validateQueryRequest({
    schema_version: 1,
    action: "query",
    kb_profile_id: PROFILE,
    query: input.testCase.query,
    max_candidates: input.k,
  });
  const checkpointer = kbArtifactControl({
    root: input.projectRoot,
    runId,
    profileId: PROFILE,
    action: "query",
    sessionId: "sess_answer_quality_oracle",
  });
  const durable = checkpointer.loadRunById(runId);
  if (durable === undefined) throw new Error("answer-quality fixture lost its durable run");
  durable.playbookData.kb_id = readManifest(input.kbRoot).kb_id;
  durable.playbookData.admitted_policy_sha256 = sha256Hex(canonicalJson(readPolicy(input.kbRoot)));
  checkpointer.saveRun(durable, "answer_quality_fixture_bound", { run_id: runId });
  const plane = defaultKbIngestPlane(checkpointer);

  try {
    const prepared = plane.runQuery?.({
      projectRoot: input.projectRoot,
      kbRoot: input.kbRoot,
      profileId: PROFILE,
      runId,
      request,
    });
    if (prepared === undefined) throw new Error("query plane returned no result");
    if (!prepared.groundingRequired) {
      return {
        observation: readObservation({
          kbRoot: input.kbRoot,
          runId,
          testCase: input.testCase,
          outcome: prepared,
          checkpointer,
          ...(prepared.answerHandle === undefined
            ? {}
            : { answerArtifactId: prepared.answerHandle.artifact_id }),
        }),
        agentPhases: phases,
        candidateCount: prepared.candidateCount,
      };
    }

    const queryReader = new KbQueryReader({
      kbRoot: input.kbRoot,
      profileId: PROFILE,
      readRequest: () => request,
      selectedGenerationId: () => input.generationId,
    });
    const worker = new KbWorkerClient({
      projectRoot: input.projectRoot,
      checkpointer,
      kbRoot: input.kbRoot,
      runId,
      sessionId: "sess_answer_quality_oracle",
      profileId: PROFILE,
      operation: "query",
      sourceCapabilityIds: [],
      queryReader,
      testOnlyAgentRunner: syntheticAgents(phases),
    });
    try {
      const synthia = await worker.runAgent(
        invocation({ projectRoot: input.projectRoot, agent: "synthia", stateId: "query" })
      );
      const vera = await worker.runAgent(
        invocation({ projectRoot: input.projectRoot, agent: "vera", stateId: "verify" })
      );
      const answerArtifactId = artifactId(synthia);
      const verificationArtifactId = artifactId(vera);
      const final = plane.finalizeVerifiedQuery?.({
        projectRoot: input.projectRoot,
        kbRoot: input.kbRoot,
        profileId: PROFILE,
        runId,
        request,
        selectedGenerationId: input.generationId,
        answerArtifactId,
        verificationArtifactId,
      });
      if (final === undefined) throw new Error("query plane returned no final result");
      return {
        observation: readObservation({
          kbRoot: input.kbRoot,
          runId,
          testCase: input.testCase,
          outcome: final,
          checkpointer,
          answerArtifactId,
          verificationArtifactId,
        }),
        agentPhases: phases,
        candidateCount: final.candidateCount,
      };
    } finally {
      worker.close();
    }
  } catch (error) {
    return {
      observation: {
        caseId: input.testCase.case_id,
        supportedCitations: input.testCase.supported_citations,
        finalResult: {
          status: "error",
          met: false,
          citations: [],
          verificationSupported: false,
        },
      },
      agentPhases: phases,
      candidateCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

describe("answer-quality metric", () => {
  it("computes bad_answers/N without dropping missing, abstained, or error cases", () => {
    const supported = [{ kind: "page", page_id: "page_a", revision_id: "rev_1" }];
    const score = scoreAnswerQuality([
      {
        caseId: "good",
        supportedCitations: supported,
        finalResult: {
          status: "complete",
          met: true,
          citations: supported,
          verificationSupported: true,
        },
      },
      { caseId: "missing", supportedCitations: supported },
      {
        caseId: "abstained",
        supportedCitations: supported,
        finalResult: {
          status: "refused",
          met: false,
          citations: [],
          verificationSupported: false,
        },
      },
      {
        caseId: "error",
        supportedCitations: supported,
        finalResult: {
          status: "error",
          met: false,
          citations: [],
          verificationSupported: false,
        },
      },
      {
        caseId: "outside-citation",
        supportedCitations: supported,
        finalResult: {
          status: "complete",
          met: true,
          citations: [{ kind: "page", page_id: "page_b", revision_id: "rev_1" }],
          verificationSupported: true,
        },
      },
      {
        caseId: "unsupported-verification",
        supportedCitations: supported,
        finalResult: {
          status: "complete",
          met: true,
          citations: supported,
          verificationSupported: false,
        },
      },
    ]);

    expect(score.badAnswers).toBe(5);
    expect(score.caseCount).toBe(6);
    expect(score.badAnswerRate).toBe(5 / 6);
    expect(score.cases.find((entry) => entry.caseId === "missing")?.reasons).toEqual([
      "missing_result",
    ]);
    expect(score.cases.find((entry) => entry.caseId === "outside-citation")?.reasons).toEqual([
      "unsupported_citation",
    ]);
  });
});

describe.skipIf(!receiptExists)("frozen §5.13 G8 answer-quality receipt", () => {
  if (
    receipt === undefined ||
    fixturePath === undefined ||
    fixtureBytes === undefined ||
    fixture === undefined
  ) {
    it.skip("requires the private operator receipt and its tracked fixture", () => {});
    return;
  }

  it("validates the independently reviewed receipt and exact fixture bytes/case count", () => {
    validateFrozenInputs();
  });

  it("executes every frozen case and enforces the unmodified maximum", async () => {
    validateFrozenInputs();
    const projectRoot = tmpRoot();
    const kbRoot = path.join(projectRoot, "private-kb");
    const generationId = seedFrozenFixture(kbRoot, fixture);
    const executed = await Promise.all(
      fixture.cases.map((testCase) =>
        executeFrozenCase({
          projectRoot,
          kbRoot,
          generationId,
          testCase,
          k: receipt.k,
        })
      )
    );
    const score = scoreAnswerQuality(executed.map((entry) => entry.observation));

    const evidenceGaps = fixture.corpus.flatMap((page) =>
      page.claims.claims.flatMap((claim) =>
        claim.state === "supported" && claim.evidence.length === 0
          ? [`${page.frontmatter.page_id}/${claim.claim_id}`]
          : []
      )
    );
    const diagnostic = canonicalJson({
      frozen_fixture_sha256: receipt.fixture_sha256,
      maximum_unsupported_answer_rate: receipt.maximum_unsupported_answer_rate,
      evidence_gaps: evidenceGaps,
      executions: executed.map((entry) => ({
        case_id: entry.observation.caseId,
        candidate_count: entry.candidateCount,
        agent_phases: entry.agentPhases,
        ...(entry.error === undefined ? {} : { error: entry.error }),
      })),
      score,
    });

    expect(score.caseCount).toBe(receipt.case_count);
    expect(score.badAnswerRate, diagnostic).toBeLessThanOrEqual(
      receipt.maximum_unsupported_answer_rate
    );
  });
});
