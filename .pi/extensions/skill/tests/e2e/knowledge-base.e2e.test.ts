import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn((_path: string, operation: () => unknown) => operation()),
  parseFrontmatter: vi.fn(() => ({ frontmatter: {}, body: "" })),
}));
vi.mock("@earendil-works/pi-tui", () => ({
  Container: class {},
  Spacer: class {},
  Text: class {},
}));

import {
  CapabilityStore,
  ContentReviewService,
  KbSessionProfileGrantStore,
  OrchestrationService,
  initializePennyState,
  resolvePennyProjectState,
  ParentDeliveryGrantStore,
  PromotionApprovalStore,
  SaveQueryClaimStore,
  authenticateLocalContentReviewer,
  canonicalJson,
  mintEnvelope,
  mintParentDeliveryGrant,
  mintSourceCapability,
  promotionApplyOperationSourceIdentity,
  readCurrent,
  readPolicy,
  readSelectedGeneration,
  saveClaimStoreDir,
  validateQueryRequest,
  type KbAgentRunner,
  type KbPhaseInvocation,
} from "@penny/orchestration/source";
import { sha256Hex } from "../../../../../apps/orchestration/src/kb/contracts.js";
import { writePolicy } from "../../../../../apps/orchestration/src/kb/filesystem.js";
import {
  KB_PHASE_TOOL_MATRIX,
  createTestOnlyArtifactBodyRunner,
} from "../../../../../apps/orchestration/src/kb/session-tools.js";
import { setGlobalLogTransport } from "../../../../lib/logger/logger.js";
import {
  createTestExtensionApi,
  isRecord,
  parseJson,
  requireArray,
  requireFunction,
  requireString,
} from "../../../../lib/tests/test-narrowers.js";
import type { SkillExtensionTestDependencies } from "../../index.js";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../.."
);
const PROFILE = "kbp_registered_e2e";
const SESSION = "sess_registered_e2e";
const PARENT = { provider: "ollama", model: "qwen3.8:latest" } as const;
const PROVISIONAL_CLAIM_ID = "candidate_registered_e2e";
const NOW = "2026-08-21T12:00:00.000Z";
const SCAFFOLD_TRACKED_FILES = [
  "docs/kb/.gitignore",
  "docs/kb/README.md",
  "docs/kb/manifest.example.json",
  "docs/kb/templates/page.md",
  "docs/kb/templates/source.json",
] as const;
const SCAFFOLD_PUBLIC_ENTRIES = new Set([
  ".gitignore",
  "README.md",
  "manifest.example.json",
  "templates",
  "templates/page.md",
  "templates/source.json",
]);

interface PageRef {
  page_id: string;
  revision_id: string;
}

interface ComposedFixture {
  page: PageRef;
  claimId: string;
  lifecycle: "draft";
  sourceIds: string[];
  previousRevisionId?: string;
  claimCandidateRef: string;
}
const RAW_KINDS = ["SOURCE", "CLAIM", "PAGE", "QUERY", "REPORT", "PATCH"] as const;
type RawKind = (typeof RAW_KINDS)[number];
type Sentinels = Record<Lowercase<RawKind>, string> & { derived: string };

interface RegisteredToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

interface RegisteredTool {
  name: string;
  parameters: Parameters<typeof Value.Check>[0];
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: { cwd: string }
  ) => Promise<RegisteredToolResult>;
}

const roots: string[] = [];
const capturedLogs: string[] = [];
let priorEnvironment: Record<string, string | undefined> | undefined;
const originalPennyStateRoot = process.env.PENNY_STATE_ROOT;
const originalArtifactRoot = process.env.PENNY_ARTIFACT_ROOT;

function temporary(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `${label}-`));
  roots.push(root);
  return root;
}

function rawSentinel(kind: RawKind, index: number, nonce: string): string {
  return ["RAW", kind, "SENTINEL", "REGISTERED", nonce, String(index)].join("_");
}

function rawKindKey(kind: RawKind): Lowercase<RawKind> {
  switch (kind) {
    case "SOURCE":
      return "source";
    case "CLAIM":
      return "claim";
    case "PAGE":
      return "page";
    case "QUERY":
      return "query";
    case "REPORT":
      return "report";
    case "PATCH":
      return "patch";
  }
}

function sentinels(): Sentinels {
  const nonce = randomBytes(12).toString("hex");
  return {
    source: rawSentinel("SOURCE", 0, nonce),
    claim: rawSentinel("CLAIM", 1, nonce),
    page: rawSentinel("PAGE", 2, nonce),
    query: rawSentinel("QUERY", 3, nonce),
    report: rawSentinel("REPORT", 4, nonce),
    patch: rawSentinel("PATCH", 5, nonce),
    derived: ["DERIVED", "ANSWER", "SENTINEL", "GRANTED", nonce].join("_"),
  };
}

function text(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("latin1");
  return typeof value === "string" ? value : JSON.stringify(value);
}

function assertRawAbsent(label: string, value: unknown, markers: Sentinels): void {
  const surface = text(value);
  for (const kind of RAW_KINDS) {
    const marker = markers[rawKindKey(kind)];
    if (surface.includes(marker))
      throw new Error(`raw ${kind.toLowerCase()} escaped into ${label}`);
  }
}

function assertDerivedAbsent(label: string, value: unknown, markers: Sentinels): void {
  if (text(value).includes(markers.derived)) {
    throw new Error(`derived answer escaped into ${label}`);
  }
}

function allFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (entry: string): void => {
    const stat = lstatSync(entry);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const child of readdirSync(entry).sort()) visit(path.join(entry, child));
      return;
    }
    files.push(entry);
  };
  visit(root);
  return files;
}

function installProjectState(projectRoot: string) {
  const stateRoot = temporary("penny-kb-state-e2e");
  delete process.env.PENNY_ARTIFACT_ROOT;
  process.env.PENNY_STATE_ROOT = stateRoot;
  return initializePennyState(projectRoot, { env: process.env });
}

function installProfile(projectRoot: string, kbRoot: string): void {
  const state = installProjectState(projectRoot);
  mkdirSync(kbRoot, { recursive: true, mode: 0o700 });
  chmodSync(kbRoot, 0o700);
  const registry = state.paths.knowledgeBase.profiles;
  writeFileSync(
    registry,
    JSON.stringify({
      schema_version: 1,
      profiles: [
        {
          schema_version: 1,
          kb_profile_id: PROFILE,
          kb_root: kbRoot,
          allow_create: true,
          repository_admission: { mode: "outside_worktree" },
        },
      ],
    }),
    { encoding: "utf8", mode: 0o600 }
  );
  chmodSync(registry, 0o600);
  const grantStore = new KbSessionProfileGrantStore(state.paths.knowledgeBase.hostGrants);
  grantStore.mint({
    session_id: SESSION,
    kb_profile_id: PROFILE,
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  grantStore.close();
}

function installScaffoldProfile(projectRoot: string): string {
  execFileSync("git", ["init", "-q", projectRoot]);
  const kbRoot = path.join(projectRoot, "docs", "kb");
  mkdirSync(path.join(kbRoot, "templates"), { recursive: true, mode: 0o755 });
  chmodSync(kbRoot, 0o755);
  chmodSync(path.join(kbRoot, "templates"), 0o755);
  writeFileSync(
    path.join(kbRoot, ".gitignore"),
    [
      "*",
      "!.gitignore",
      "!README.md",
      "!manifest.example.json",
      "!templates/",
      "!templates/**",
      "",
    ].join("\n")
  );
  writeFileSync(path.join(kbRoot, "README.md"), "# Synthetic KB scaffold\n");
  writeFileSync(path.join(kbRoot, "manifest.example.json"), "{}\n");
  writeFileSync(path.join(kbRoot, "templates", "page.md"), "# Page template\n");
  writeFileSync(path.join(kbRoot, "templates", "source.json"), "{}\n");
  execFileSync("git", ["-C", projectRoot, "add", ...SCAFFOLD_TRACKED_FILES]);

  const state = installProjectState(projectRoot);
  const registry = state.paths.knowledgeBase.profiles;
  writeFileSync(
    registry,
    JSON.stringify({
      schema_version: 1,
      profiles: [
        {
          schema_version: 1,
          kb_profile_id: PROFILE,
          kb_root: kbRoot,
          allow_create: true,
          repository_admission: {
            mode: "inside_allowlisted_scaffold",
            worktree_root: projectRoot,
            scaffold_root: kbRoot,
          },
        },
      ],
    }),
    { encoding: "utf8", mode: 0o600 }
  );
  chmodSync(registry, 0o600);
  const grantStore = new KbSessionProfileGrantStore(state.paths.knowledgeBase.hostGrants);
  grantStore.mint({
    session_id: SESSION,
    kb_profile_id: PROFILE,
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  grantStore.close();
  return kbRoot;
}

function assertScaffoldLiveCustody(kbRoot: string): void {
  expect(lstatSync(kbRoot).mode & 0o7777).toBe(0o755);
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const candidate = path.join(directory, name);
      const relative = path.relative(kbRoot, candidate).split(path.sep).join("/");
      const stat = lstatSync(candidate);
      expect(stat.isSymbolicLink(), relative).toBe(false);
      if (SCAFFOLD_PUBLIC_ENTRIES.has(relative)) {
        if (stat.isDirectory()) visit(candidate);
        continue;
      }
      if (stat.isDirectory()) {
        expect(stat.mode & 0o7777, relative).toBe(0o700);
        visit(candidate);
      } else {
        expect(stat.isFile(), relative).toBe(true);
        expect(stat.mode & 0o7777, relative).toBe(0o600);
        expect(stat.nlink, relative).toBe(1);
      }
    }
  };
  visit(kbRoot);
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected an object");
  return value;
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function phaseAction(invocation: KbPhaseInvocation): string {
  const envelope = object(parseJson(invocation.readPhaseBrief?.() ?? "{}"));
  return String(object(envelope["brief"])["action"] ?? "");
}

function composedFixture(invocation: KbPhaseInvocation): ComposedFixture {
  const envelope = object(parseJson(invocation.readPhaseBrief?.() ?? "{}"));
  const authority = object(envelope.compose_authority);
  const allocations = requireArray(authority.allocations, "compose authority omitted allocations");
  const allocation = object(allocations[0]);
  const sourceIds = requireArray(
    allocation.source_ids,
    "compose allocation omitted source IDs"
  ).map((sourceId) => requireString(sourceId, "compose source ID was not text"));
  const claimAllocations = requireArray(
    allocation.claim_allocations,
    "compose allocation omitted claim allocations"
  );
  const claimAllocation = object(claimAllocations[0]);
  if (allocations.length !== 1 || sourceIds.length === 0 || claimAllocations.length !== 1) {
    throw new Error("registered E2E compose allocation is incomplete");
  }
  const pageId = requireString(allocation.page_id, "compose allocation omitted page ID");
  const revisionId = requireString(
    allocation.revision_id,
    "compose allocation omitted revision ID"
  );
  if (allocation.lifecycle !== "draft") throw new Error("compose allocation was not a draft");
  const supersedes = allocation.supersedes;
  const previousRevision =
    supersedes === null
      ? undefined
      : requireString(object(supersedes).revision_id, "superseded revision ID was absent");
  return {
    page: { page_id: pageId, revision_id: revisionId },
    claimId: requireString(claimAllocation.claim_id, "claim allocation omitted claim ID"),
    lifecycle: allocation.lifecycle,
    sourceIds,
    ...(previousRevision === undefined ? {} : { previousRevisionId: previousRevision }),
    claimCandidateRef: requireString(
      claimAllocation.candidate_ref,
      "claim allocation omitted candidate ref"
    ),
  };
}

function claim(markers: Sentinels, sourceId: string, claimId: string) {
  return {
    claim_id: claimId,
    text: `Synthetic orbital quorum claim. ${markers.claim}`,
    kind: "fact",
    state: "supported",
    confidence: "CERTAIN",
    evidence: [{ source_id: sourceId, locator: "line 1" }],
    contradicts_claim_ids: [],
    canonical_verification_refs: [],
  };
}

function pageBody(input: {
  markers: Sentinels;
  sourceId: string;
  composition: ComposedFixture;
  title: string;
}): string {
  const pageClaim = claim(input.markers, input.sourceId, input.composition.claimId);
  return canonicalJson({
    schema_version: 1,
    artifact_kind: "page_draft",
    pages: [
      {
        frontmatter: {
          schema_version: 1,
          ...input.composition.page,
          ...(input.composition.previousRevisionId === undefined
            ? {}
            : { previous_revision_id: input.composition.previousRevisionId }),
          kind: "synthesis",
          title: input.title,
          summary: "Synthetic orbital quorum guidance.",
          authority: "advisory",
          lifecycle: input.composition.lifecycle,
          created_at: NOW,
          derived_from: [input.sourceId],
          related_page_ids: [],
        },
        markdown: [
          "## Synthesis",
          `Synthetic orbital quorum guidance. ${input.markers.page}`,
          "",
          "## Evidence",
          "- The admitted source supports the quorum claim.",
          "",
          "## Tensions and unknowns",
          "- None in this synthetic fixture.",
          "",
          "## Related",
          "- None.",
          "",
        ].join("\n"),
        claims: {
          schema_version: 1,
          ...input.composition.page,
          claims: [pageClaim],
        },
      },
    ],
  });
}

function lintBody(markers: Sentinels, claimId: string): string {
  return canonicalJson({
    schema_version: 1,
    artifact_kind: "lint_report",
    findings: [
      {
        finding_id: "finding_registered_e2e",
        severity: "warning",
        summary: `Synthetic non-blocking report. ${markers.report}`,
        evidence: [{ evidence_id: "evidence_registered_lint", kind: "artifact", ref: claimId }],
      },
    ],
    candidate_conflicts: [],
  });
}

function ingestVerificationBody(markers: Sentinels, composition: ComposedFixture): string {
  return canonicalJson({
    schema_version: 1,
    artifact_kind: "verification_report",
    verified_artifact_ids: [],
    claim_findings: [
      {
        ...composition.page,
        claim_id: composition.claimId,
        verdict: "supported",
        evidence: [
          {
            evidence_id: "evidence_registered_grounding",
            kind: "artifact",
            ref: composition.claimId,
          },
        ],
      },
    ],
  });
}

function phaseTools(state: string): string[] {
  const value: unknown = Reflect.get(KB_PHASE_TOOL_MATRIX, state);
  if (!Array.isArray(value) || !value.every((tool) => typeof tool === "string")) {
    throw new Error(`unknown KB phase '${state}'`);
  }
  return value;
}

function deterministicAgent(input: {
  markers: Sentinels;
  target: () => { capabilityId: string; original: Buffer; replacement: string } | undefined;
  compositions: Partial<Record<"ingest" | "save", ComposedFixture>>;
  phasePostures: Array<Record<string, unknown>>;
  agentErrors: string[];
}): KbAgentRunner {
  let admittedSourceId = "";
  const bodyRunner = createTestOnlyArtifactBodyRunner(async (invocation) => {
    invocation.admitModel?.(PARENT);
    const action = phaseAction(invocation);
    const state = invocation.stateId;
    const tools = phaseTools(state);
    input.phasePostures.push({
      action,
      state,
      agent: invocation.agent,
      run_id: invocation.runId,
      profile_id: invocation.profileId,
      artifact_kind: invocation.expectedArtifactKind,
      tools: [...tools],
      source_ids: [...invocation.sourceAllowlist],
      prior_states: [...invocation.priorPhaseAllowlist],
      prior_artifact_count: invocation.allowedPriorArtifacts?.length ?? 0,
    });
    expect(tools.some((name) => name.startsWith("memory_"))).toBe(false);
    expect(invocation.runId).toMatch(/^kb-/);
    expect(invocation.profileId).toBe(PROFILE);
    expect(invocation.stageArtifact).toBeTypeOf("function");
    expect(invocation.submitPhaseResult).toBeTypeOf("function");

    if (action === "ingest") {
      if (state === "ingest") {
        admittedSourceId = invocation.sourceAllowlist[0] ?? "";
        expect(admittedSourceId).toMatch(/^src_[a-f0-9]{32}$/);
        expect(invocation.readSource(admittedSourceId)).toContain(input.markers.source);
        return canonicalJson({
          schema_version: 1,
          artifact_kind: "claims",
          source_ids: [admittedSourceId],
          claims: [
            {
              provisional_id: PROVISIONAL_CLAIM_ID,
              text: `Synthetic orbital quorum claim. ${input.markers.claim}`,
              kind: "fact",
              confidence: "CERTAIN",
              evidence: [{ source_id: admittedSourceId, locator: "line 1" }],
            },
          ],
        });
      }
      for (const artifact of invocation.allowedPriorArtifacts ?? []) {
        expect(invocation.readRunArtifact?.(artifact.artifact_id)).toContain("artifact_kind");
      }
      if (state === "compose") {
        const composition = composedFixture(invocation);
        expect(composition.sourceIds).toEqual([admittedSourceId]);
        expect(composition.claimCandidateRef).toBe(PROVISIONAL_CLAIM_ID);
        input.compositions.ingest = composition;
        return pageBody({
          markers: input.markers,
          sourceId: admittedSourceId,
          composition,
          title: "Synthetic orbital quorum",
        });
      }
      const composition = input.compositions.ingest;
      if (composition === undefined) throw new Error("ingest composition fixture is absent");
      if (state === "lint") return lintBody(input.markers, composition.claimId);
      return ingestVerificationBody(input.markers, composition);
    }

    if (action === "query") {
      const privateBrief = invocation.readPhaseBrief?.() ?? "";
      expect(invocation.phaseBrief).not.toContain(input.markers.query);
      expect(privateBrief).toContain(input.markers.query);
      const selection = object(parseJson(invocation.searchSelectedKb?.() ?? "{}"));
      const candidates = requireArray(
        selection["candidates"],
        "selected KB search omitted candidates"
      );
      const candidate = object(candidates[0]);
      const pageId = String(candidate["page_id"]);
      const revisionId = String(candidate["revision_id"]);
      expect(invocation.readSelectedPage?.(pageId, revisionId)).toContain(input.markers.page);
      expect(invocation.readSelectedSource?.(admittedSourceId)).toContain(input.markers.source);
      const composition = input.compositions.ingest;
      if (composition === undefined) throw new Error("query composition fixture is absent");
      const citation = {
        kind: "claim",
        page_id: pageId,
        revision_id: revisionId,
        claim_id: composition.claimId,
      };
      if (state === "query") {
        return canonicalJson({
          schema_version: 1,
          artifact_kind: "query_answer",
          answer: {
            authority: "advisory",
            text: `Explicitly granted synthetic answer. ${input.markers.derived}`,
            citations: [citation],
            contradictions: [],
            unknowns: [],
            canonical_verification_required: true,
          },
        });
      }
      const answerHandle = invocation.allowedPriorArtifacts?.[0];
      if (answerHandle === undefined) throw new Error("query answer handle is absent");
      expect(invocation.readRunArtifact?.(answerHandle.artifact_id)).toContain(
        input.markers.derived
      );
      return canonicalJson({
        schema_version: 1,
        artifact_kind: "verification_report",
        passed: true,
        answer_artifact_id: answerHandle.artifact_id,
        answer_sha256: answerHandle.sha256,
        answer_verdict: "supported",
        citation_findings: [
          {
            citation,
            verdict: "supported",
            notes: `The selected source supports this synthetic answer. ${input.markers.report}`,
          },
        ],
      });
    }

    if (action === "save") {
      expect(invocation.readPhaseBrief?.()).toContain("Saved synthetic orbital quorum");
      for (const artifact of invocation.allowedPriorArtifacts ?? []) {
        const prior = invocation.readRunArtifact?.(artifact.artifact_id) ?? "";
        expect(prior).toContain(state === "compose" ? input.markers.derived : input.markers.page);
      }
      if (state === "compose") {
        expect(invocation.readSelectedSource?.(admittedSourceId)).toContain(input.markers.source);
        const composition = composedFixture(invocation);
        expect(composition.sourceIds).toEqual([admittedSourceId]);
        input.compositions.save = composition;
        return pageBody({
          markers: input.markers,
          sourceId: admittedSourceId,
          composition,
          title: "Saved synthetic orbital quorum",
        });
      }
      const composition = input.compositions.save;
      if (composition === undefined) throw new Error("save composition fixture is absent");
      if (state === "lint") return lintBody(input.markers, composition.claimId);
      return ingestVerificationBody(input.markers, composition);
    }

    if (action === "promote") {
      const target = input.target();
      if (target === undefined) throw new Error("promotion target fixture is absent");
      const composition = input.compositions.save;
      if (composition === undefined) throw new Error("promotion composition fixture is absent");
      expect(
        invocation.readSelectedPage?.(composition.page.page_id, composition.page.revision_id)
      ).toContain(input.markers.page);
      const targetRead = object(
        JSON.parse(invocation.readCanonicalTarget?.(target.capabilityId) ?? "{}")
      );
      expect(targetRead["content_utf8"]).toBe(target.original.toString("utf8"));
      if (state === "plan") {
        return canonicalJson({
          schema_version: 1,
          artifact_kind: "promotion_plan",
          page_revisions: [composition.page],
          target_capability_ids: [target.capabilityId],
          verification_report_artifact_ids: [],
          changes: [
            {
              target_capability_id: target.capabilityId,
              summary: "Apply the reviewed synthetic orbital quorum guidance.",
            },
          ],
        });
      }
      for (const artifact of invocation.allowedPriorArtifacts ?? []) {
        expect(invocation.readRunArtifact?.(artifact.artifact_id)).toContain("promotion_plan");
      }
      return canonicalJson({
        schema_version: 1,
        artifact_kind: "promotion_patch",
        targets: [
          {
            target_capability_id: target.capabilityId,
            preimage_sha256: sha256Hex(target.original.toString("utf8")),
            postimage_sha256: sha256Hex(target.replacement),
            replacement_utf8: target.replacement,
          },
        ],
      });
    }

    throw new Error(`unsupported deterministic action/state '${action}/${state}'`);
  });
  return async (invocation) => {
    try {
      return await bodyRunner(invocation);
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      input.agentErrors.push(`${invocation.stateId}:${errorName}`);
      throw error;
    }
  };
}

function isRegisteredTool(value: unknown): value is RegisteredTool {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    value.parameters !== undefined &&
    typeof value.execute === "function"
  );
}

async function registerKnowledgeBaseTool(input: {
  projectRoot: string;
  dependencies: SkillExtensionTestDependencies;
}): Promise<RegisteredTool> {
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const skillExtension = (await import("../../index.js")).default;
  skillExtension(
    createTestExtensionApi({
      onRegisterTool(tool) {
        if (!isRegisteredTool(tool)) throw new Error("skill registered an invalid tool");
        tools.push(tool);
      },
      onEvent(event, handler) {
        handlers.set(
          event,
          requireFunction(handler, `skill registered an invalid ${event} handler`)
        );
      },
    }),
    input.dependencies
  );
  await handlers.get("session_start")?.(
    {},
    {
      sessionManager: { getSessionId: () => SESSION },
      model: { provider: PARENT.provider, id: PARENT.model },
    }
  );
  const matches = tools.filter((tool) => tool.name === "knowledge_base");
  expect(matches).toHaveLength(1);
  return required(matches[0], "one registered knowledge_base tool");
}

async function callTool(
  tool: RegisteredTool,
  projectRoot: string,
  callId: string,
  params: Record<string, unknown>,
  parentSurfaces: RegisteredToolResult[]
): Promise<RegisteredToolResult> {
  expect(Value.Check(tool.parameters, params)).toBe(true);
  const result = await tool.execute(callId, params, undefined, undefined, { cwd: projectRoot });
  expect(result.content).toHaveLength(1);
  const content = required(result.content[0], "one knowledge_base result content item");
  expect(JSON.parse(content.text)).toEqual(result.details);
  parentSurfaces.push(result);
  return result;
}

function approveContentReview(input: {
  projectRoot: string;
  host: OrchestrationService;
  runId: string;
  exercisePublicFailure?: boolean;
}) {
  const run = input.host.checkpointer.loadRunById(input.runId);
  const pending = run?.pendingDirective;
  if (run === undefined || pending?.action !== "await_user") {
    throw new Error(`run '${input.runId}' is not awaiting content review`);
  }
  if (input.exercisePublicFailure) {
    expect(() =>
      input.host.engine.handle({
        schema_version: 2,
        action: "respond",
        identity: run.identity,
        gate_id: pending.gate_id,
        challenge: pending.challenge,
        response: "approve",
      })
    ).toThrow(/host-only/);
    expect(input.host.checkpointer.contentReviewForRun(input.runId)?.state).toBe("awaiting");
  }
  const reviewer = new ContentReviewService({
    projectRoot: input.projectRoot,
    checkpointer: input.host.checkpointer,
    engine: input.host.engine,
    reviewer: authenticateLocalContentReviewer(),
  });
  const terminal = reviewer.decide({ runId: input.runId, decision: "approve" });
  expect(terminal.action).toBe("complete");
  expect(reviewer.operation(input.runId)?.group.state).toBe("committed");
  return terminal;
}

function assertDatabaseSurfaces(
  paths: readonly string[],
  markers: Sentinels
): Array<{ path: string; bytes: Buffer }> {
  const surfaces: Array<{ path: string; bytes: Buffer }> = [];
  for (const database of paths) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const candidate = `${database}${suffix}`;
      expect(existsSync(candidate), candidate).toBe(true);
      const bytes = readFileSync(candidate);
      assertRawAbsent(`database ${path.basename(candidate)}`, bytes, markers);
      assertDerivedAbsent(`database ${path.basename(candidate)}`, bytes, markers);
      surfaces.push({ path: candidate, bytes });
    }
  }
  return surfaces;
}

function inspectPackageAndArchiveOutputs(markers: Sentinels): void {
  const archive = spawnSync("git", ["archive", "--format=tar", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(archive.status, archive.stderr.toString()).toBe(0);
  assertRawAbsent("Git archive output", archive.stdout, markers);
  assertDerivedAbsent("Git archive output", archive.stdout, markers);

  for (const packageRoot of ["apps/orchestration", ".pi/extensions/skill"]) {
    const packed = spawnSync("bun", ["pm", "pack", "--cwd", packageRoot, "--dry-run"], {
      cwd: REPOSITORY_ROOT,
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(packed.status, packed.stderr.toString()).toBe(0);
    const output = Buffer.concat([packed.stdout, packed.stderr]);
    assertRawAbsent(`package dry-run ${packageRoot}`, output, markers);
    assertDerivedAbsent(`package dry-run ${packageRoot}`, output, markers);
    expect(packed.stdout.toString("utf8")).toContain("packed");
  }
}

afterEach(() => {
  setGlobalLogTransport(undefined);
  if (priorEnvironment !== undefined) {
    for (const [name, value] of Object.entries(priorEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    priorEnvironment = undefined;
  }
  capturedLogs.length = 0;
  if (originalPennyStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
  else process.env.PENNY_STATE_ROOT = originalPennyStateRoot;
  if (originalArtifactRoot === undefined) delete process.env.PENNY_ARTIFACT_ROOT;
  else process.env.PENNY_ARTIFACT_ROOT = originalArtifactRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("registered knowledge_base production path", () => {
  it("keeps an exact public Git scaffold root at 0755 while refusing weakened live custody", async () => {
    setGlobalLogTransport((entry) => capturedLogs.push(entry));
    const projectRoot = temporary("penny-kb-public-scaffold-e2e");
    const kbRoot = installScaffoldProfile(projectRoot);
    const tracked = execFileSync("git", ["-C", projectRoot, "ls-files", "--", "docs/kb"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(tracked).toEqual([...SCAFFOLD_TRACKED_FILES]);
    for (const relative of [
      "manifest.json",
      "index.md",
      ".kb/policy.json",
      ".kb/lock",
      ".kb/current.json",
      ".kb/generations/g/catalog.json",
      ".kb/generations/g/index.sqlite",
      "sources/objects/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "sources/records/source_demo.json",
      "pages/page_demo/revisions/rev_demo/page.md",
      "pages/page_demo/revisions/rev_demo/claims.json",
      "conflicts/conflict_demo.json",
      "work/run_demo/artifacts/state_demo/artifact_demo",
    ]) {
      expect(() =>
        execFileSync("git", [
          "-C",
          projectRoot,
          "check-ignore",
          "-q",
          "--no-index",
          "--",
          `docs/kb/${relative}`,
        ])
      ).not.toThrow();
    }

    priorEnvironment = Object.fromEntries(
      ["PROJECT_ROOT", "PI_OBSERVABILITY_ENABLED", "PI_OBSERVABILITY_AUTO_START"].map((name) => [
        name,
        process.env[name],
      ])
    );
    process.env.PROJECT_ROOT = projectRoot;
    process.env.PI_OBSERVABILITY_ENABLED = "false";
    process.env.PI_OBSERVABILITY_AUTO_START = "false";

    const tool = await registerKnowledgeBaseTool({ projectRoot, dependencies: {} });
    const parentSurfaces: RegisteredToolResult[] = [];
    const initialized = await callTool(
      tool,
      projectRoot,
      "call_scaffold_init",
      {
        schema_version: 1,
        action: "init",
        kb_profile_id: PROFILE,
        create: true,
        title: "Public scaffold custody E2E",
      },
      parentSurfaces
    );
    expect(initialized.details).toMatchObject({ action: "init", status: "complete", met: true });
    expect(lstatSync(kbRoot).mode & 0o7777).toBe(0o755);

    const policy = readPolicy(kbRoot);
    writePolicy(kbRoot, {
      ...policy,
      processing_mode: "local_only",
      allowed_parent_models: [{ ...PARENT, locality: "local" }],
    });
    const query = await callTool(
      tool,
      projectRoot,
      "call_scaffold_query",
      {
        schema_version: 1,
        action: "query",
        kb_profile_id: PROFILE,
        query: "What is present in this empty synthetic scaffold?",
      },
      parentSurfaces
    );
    expect(query.details, capturedLogs.join("\n")).toMatchObject({
      action: "query",
      status: "complete",
      met: false,
    });
    const queryRunId = String(query.details["run_id"]);
    expect(queryRunId).toMatch(/^kb-/);

    const status = await callTool(
      tool,
      projectRoot,
      "call_scaffold_status",
      { schema_version: 1, action: "status", kb_profile_id: PROFILE, run_id: queryRunId },
      parentSurfaces
    );
    expect(status.details).toMatchObject({ action: "status", status: "complete", met: false });
    const resumed = await callTool(
      tool,
      projectRoot,
      "call_scaffold_resume",
      { schema_version: 1, action: "resume", kb_profile_id: PROFILE, run_id: queryRunId },
      parentSurfaces
    );
    expect(resumed.details).toMatchObject({ action: "resume", status: "complete", met: false });
    assertScaffoldLiveCustody(kbRoot);

    chmodSync(kbRoot, 0o775);
    const broadRoot = await callTool(
      tool,
      projectRoot,
      "call_scaffold_broad_root",
      { schema_version: 1, action: "status", kb_profile_id: PROFILE, run_id: queryRunId },
      parentSurfaces
    );
    expect(broadRoot.details).toMatchObject({
      status: "refused",
      warnings: ["profile_not_authorized"],
    });
    chmodSync(kbRoot, 0o755);

    const liveChild = path.join(kbRoot, ".kb");
    chmodSync(liveChild, 0o755);
    const broadChild = await callTool(
      tool,
      projectRoot,
      "call_scaffold_broad_child",
      { schema_version: 1, action: "status", kb_profile_id: PROFILE, run_id: queryRunId },
      parentSurfaces
    );
    expect(broadChild.details).toMatchObject({
      status: "refused",
      warnings: ["profile_not_authorized"],
    });
    chmodSync(liveChild, 0o700);

    const current = path.join(liveChild, "current.json");
    const heldCurrent = path.join(liveChild, "current.held");
    renameSync(current, heldCurrent);
    symlinkSync("current.held", current);
    const symlinked = await callTool(
      tool,
      projectRoot,
      "call_scaffold_symlink",
      { schema_version: 1, action: "status", kb_profile_id: PROFILE, run_id: queryRunId },
      parentSurfaces
    );
    expect(symlinked.details).toMatchObject({
      status: "refused",
      warnings: ["profile_not_authorized"],
    });
    rmSync(current);
    renameSync(heldCurrent, current);
    assertScaffoldLiveCustody(kbRoot);
  });

  it("executes the synthetic lifecycle through the registered adapter, engine, host callbacks, and signed apply", async () => {
    const markers = sentinels();
    expect(new Set(Object.values(markers)).size).toBe(RAW_KINDS.length + 1);
    const projectRoot = temporary("penny-kb-registered-e2e");
    delete process.env.PENNY_ARTIFACT_ROOT;
    const kbRoot = path.join(projectRoot, "private-kb");
    priorEnvironment = Object.fromEntries(
      ["PROJECT_ROOT", "PI_OBSERVABILITY_ENABLED", "PI_OBSERVABILITY_AUTO_START"].map((name) => [
        name,
        process.env[name],
      ])
    );
    process.env.PROJECT_ROOT = projectRoot;
    process.env.PI_OBSERVABILITY_ENABLED = "false";
    process.env.PI_OBSERVABILITY_AUTO_START = "false";
    setGlobalLogTransport((entry) => capturedLogs.push(entry));

    const targetFixture: {
      current?: { capabilityId: string; targetPath: string; original: Buffer; replacement: string };
    } = {};
    const compositions: Partial<Record<"ingest" | "save", ComposedFixture>> = {};
    const phasePostures: Array<Record<string, unknown>> = [];
    const agentErrors: string[] = [];
    const runner = deterministicAgent({
      markers,
      target: () => targetFixture.current,
      compositions,
      phasePostures,
      agentErrors,
    });
    const tool = await registerKnowledgeBaseTool({
      projectRoot,
      dependencies: { kbAgentRunner: runner },
    });
    const parentSurfaces: RegisteredToolResult[] = [];
    const hostSurfaces: unknown[] = [];

    // Profile authority fails closed before init; the failure is both logged and
    // content-free. The valid profile/grant is then installed out of band.
    const profileRefusal = await callTool(
      tool,
      projectRoot,
      "call_profile_refusal",
      { schema_version: 1, action: "init", kb_profile_id: PROFILE, create: true, title: "X" },
      parentSurfaces
    );
    expect(profileRefusal.details).toMatchObject({
      status: "refused",
      warnings: ["profile_not_authorized"],
    });
    installProfile(projectRoot, kbRoot);
    const projectPaths = resolvePennyProjectState(projectRoot).paths;

    const initialized = await callTool(
      tool,
      projectRoot,
      "call_init_registered",
      {
        schema_version: 1,
        action: "init",
        kb_profile_id: PROFILE,
        create: true,
        title: "Registered synthetic E2E",
      },
      parentSurfaces
    );
    expect(initialized.details).toMatchObject({ action: "init", status: "complete", met: true });
    expect(readCurrent(kbRoot)?.generation_id).toMatch(/^gen_/);
    const policy = readPolicy(kbRoot);
    writePolicy(kbRoot, {
      ...policy,
      processing_mode: "local_only",
      allowed_parent_models: [{ ...PARENT, locality: "local" }],
      allowed_child_models: [{ ...PARENT, locality: "local" }],
      parent_result: {
        derived_query_answer: "allow_explicit_derived_answer",
        max_utf8_bytes: 8_192,
      },
    });

    const host = new OrchestrationService({
      projectRoot,
      env: process.env,
      playbookName: "knowledge-base",
    });
    const sourcePath = path.join(projectRoot, "synthetic-source.md");
    writeFileSync(
      sourcePath,
      `Synthetic orbital quorum evidence. ${markers.source} ${markers.derived}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    const sourceCapability = mintSourceCapability({
      projectRoot,
      kbProfileId: PROFILE,
      sessionId: SESSION,
      allowedOperation: "ingest",
      absolutePath: sourcePath,
      title: "Synthetic orbital quorum source",
      authors: ["Synthetic Fixture"],
      sourceType: "manual",
      mediaType: "text/markdown",
      capturedAt: NOW,
    });

    // Source capability authority: an unknown envelope reaches no child and is
    // receipted as a bounded error. The minted envelope then admits one snapshot.
    const badIngest = await callTool(
      tool,
      projectRoot,
      "call_ingest_missing_capability",
      {
        schema_version: 1,
        action: "ingest",
        kb_profile_id: PROFILE,
        source_capability_ids: ["cap_missing_registered_e2e"],
      },
      parentSurfaces
    );
    expect(badIngest.details).toMatchObject({ status: "error", warnings: ["ingest_run_failed"] });
    expect(phasePostures).toHaveLength(0);

    const ingest = await callTool(
      tool,
      projectRoot,
      "call_ingest_registered",
      {
        schema_version: 1,
        action: "ingest",
        kb_profile_id: PROFILE,
        source_capability_ids: [sourceCapability.capability_id],
      },
      parentSurfaces
    );
    expect(ingest.details).toMatchObject({ status: "awaiting_user", next: "review" });
    const ingestRunId = String(ingest.details["run_id"]);
    hostSurfaces.push(
      approveContentReview({
        projectRoot,
        host,
        runId: ingestRunId,
        exercisePublicFailure: true,
      })
    );
    const ingestStatus = await callTool(
      tool,
      projectRoot,
      "call_status_ingest_registered",
      { schema_version: 1, action: "status", kb_profile_id: PROFILE, run_id: ingestRunId },
      parentSurfaces
    );
    expect(ingestStatus.details).toMatchObject({ status: "complete", met: true });
    const ingestPage = compositions.ingest?.page;
    if (ingestPage === undefined) throw new Error("published ingest composition fixture is absent");
    expect(readSelectedGeneration(kbRoot)?.catalog.pages[ingestPage.page_id]?.revision_id).toBe(
      ingestPage.revision_id
    );

    const queryRequest = validateQueryRequest({
      schema_version: 1,
      action: "query",
      kb_profile_id: PROFILE,
      query: `What is the synthetic orbital quorum? ${markers.query}`,
      answer_delivery: "parent_tool_result",
    });
    const queryToolRequest: Record<string, unknown> = { ...queryRequest };

    // Parent-delivery authority: a request is not a grant. The first grounded
    // query retains only its artifact handle; the exact second request receives
    // one host-minted, single-use grant and may return only the derived answer.
    const queryWithoutGrant = await callTool(
      tool,
      projectRoot,
      "call_query_without_parent_grant",
      queryToolRequest,
      parentSurfaces
    );
    expect(queryWithoutGrant.details).toMatchObject({ status: "complete", met: true });
    expect(queryWithoutGrant.details["warnings"]).toContain("refused_parent_delivery");
    assertDerivedAbsent("query without parent grant", queryWithoutGrant, markers);

    const parentGrantStore = new ParentDeliveryGrantStore(projectPaths.knowledgeBase.hostGrants);
    parentGrantStore.mint(
      mintParentDeliveryGrant({
        session_id: SESSION,
        invocation_id: "call_query_with_parent_grant",
        request: queryRequest,
        policy_sha256: sha256Hex(canonicalJson(readPolicy(kbRoot))),
        parent_provider: PARENT.provider,
        parent_model: PARENT.model,
        max_utf8_bytes: 4_096,
        issued_at: new Date(Date.now() - 60_000).toISOString(),
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        grant_id: "pgt_registered_e2e",
      })
    );
    parentGrantStore.close();

    const grantedQuery = await callTool(
      tool,
      projectRoot,
      "call_query_with_parent_grant",
      queryToolRequest,
      parentSurfaces
    );
    const queryRunId = String(grantedQuery.details["run_id"]);
    expect(grantedQuery.details).toMatchObject({
      status: "complete",
      met: true,
      derived_answer: { authority: "advisory" },
    });
    expect(text(grantedQuery.details)).toContain(markers.derived);
    const grantedContent = required(
      grantedQuery.content[0],
      "one granted query result content item"
    );
    expect(grantedContent.text).toContain(markers.derived);
    assertRawAbsent("granted query parent result", grantedQuery, markers);

    const replayedDelivery = await callTool(
      tool,
      projectRoot,
      "call_query_consumed_parent_grant",
      queryToolRequest,
      parentSurfaces
    );
    expect(replayedDelivery.details["warnings"]).toContain("refused_parent_delivery");
    assertDerivedAbsent("consumed parent-grant query", replayedDelivery, markers);

    // Terminal status/resume must not silently drop the one required answer
    // handle when its exact same-run sealed bytes cannot be reopened. Every
    // corruption class returns the same bounded body/path-free error projection.
    const queryArtifacts = requireArray(
      grantedQuery.details["artifacts"],
      "granted query omitted artifacts"
    );
    expect(queryArtifacts).toHaveLength(1);
    const queryArtifact = object(required(queryArtifacts[0], "one query answer artifact"));
    const queryArtifactId = requireString(
      queryArtifact.artifact_id,
      "query answer artifact omitted its ID"
    );
    const answerRecord = required(
      host.checkpointer.kbArtifact(queryArtifactId),
      "durable query answer artifact"
    );
    const answerPath = path.join(
      kbRoot,
      "work",
      queryRunId,
      ...answerRecord.storage_key.split("/")
    );
    const answerBytes = readFileSync(answerPath);
    for (const projectedAction of ["status", "resume"] as const) {
      const projected = await callTool(
        tool,
        projectRoot,
        `call_valid_query_${projectedAction}`,
        {
          schema_version: 1,
          action: projectedAction,
          kb_profile_id: PROFILE,
          run_id: queryRunId,
        },
        parentSurfaces
      );
      expect(projected.details).toMatchObject({
        action: projectedAction,
        status: "complete",
        met: true,
        artifacts: [
          {
            artifact_id: answerRecord.artifact_id,
            artifact_kind: "query_answer",
            sha256: answerRecord.sha256,
          },
        ],
      });
      assertRawAbsent(`valid query ${projectedAction} projection`, projected, markers);
      assertDerivedAbsent(`valid query ${projectedAction} projection`, projected, markers);
    }
    const expectCorruptTerminalProjection = async (label: string): Promise<void> => {
      for (const projectedAction of ["status", "resume"] as const) {
        const projected = await callTool(
          tool,
          projectRoot,
          `call_${label}_${projectedAction}`,
          {
            schema_version: 1,
            action: projectedAction,
            kb_profile_id: PROFILE,
            run_id: queryRunId,
          },
          parentSurfaces
        );
        expect(projected.details).toMatchObject({
          action: projectedAction,
          status: "error",
          met: false,
          artifacts: [],
          warnings: ["required_query_answer_corrupt"],
          next: "none",
        });
        expect(text(projected)).not.toContain(kbRoot);
        expect(text(projected)).not.toContain(answerPath);
        assertRawAbsent(`${label} ${projectedAction} corruption projection`, projected, markers);
        assertDerivedAbsent(
          `${label} ${projectedAction} corruption projection`,
          projected,
          markers
        );
      }
    };

    const heldAnswerPath = `${answerPath}.held`;
    renameSync(answerPath, heldAnswerPath);
    try {
      await expectCorruptTerminalProjection("missing_answer");
    } finally {
      renameSync(heldAnswerPath, answerPath);
    }

    renameSync(answerPath, heldAnswerPath);
    symlinkSync(path.basename(heldAnswerPath), answerPath);
    try {
      await expectCorruptTerminalProjection("symlinked_answer");
    } finally {
      rmSync(answerPath);
      renameSync(heldAnswerPath, answerPath);
    }

    writeFileSync(answerPath, Buffer.concat([answerBytes, Buffer.from("tampered")]), {
      mode: 0o600,
    });
    try {
      await expectCorruptTerminalProjection("hash_mismatched_answer");
    } finally {
      writeFileSync(answerPath, answerBytes, { mode: 0o600 });
    }

    const corruptionSqlite = process.getBuiltinModule("node:sqlite");
    if (corruptionSqlite === undefined) throw new Error("node:sqlite unavailable");
    const corruptionDb = new corruptionSqlite.DatabaseSync(projectPaths.orchestration.database);
    corruptionDb
      .prepare("UPDATE kb_run_artifacts SET run_id=? WHERE artifact_id=?")
      .run(ingestRunId, answerRecord.artifact_id);
    corruptionDb.close();
    try {
      await expectCorruptTerminalProjection("cross_run_answer");
    } finally {
      const repairDb = new corruptionSqlite.DatabaseSync(projectPaths.orchestration.database);
      repairDb
        .prepare("UPDATE kb_run_artifacts SET run_id=? WHERE artifact_id=?")
        .run(queryRunId, answerRecord.artifact_id);
      repairDb.close();
    }

    // Save authority: a missing query claim is refused before a child. The
    // granted query's real claim drives compose/lint/verify and a second host callback.
    const badSave = await callTool(
      tool,
      projectRoot,
      "call_save_missing_claim",
      {
        schema_version: 1,
        action: "save",
        kb_profile_id: PROFILE,
        query_run_id: "run_missing_registered_e2e",
        page_kind: "synthesis",
        title: "Missing claim",
      },
      parentSurfaces
    );
    expect(badSave.details).toMatchObject({
      status: "refused",
      warnings: ["save_claim_unavailable"],
    });

    const save = await callTool(
      tool,
      projectRoot,
      "call_save_registered",
      {
        schema_version: 1,
        action: "save",
        kb_profile_id: PROFILE,
        query_run_id: queryRunId,
        page_kind: "synthesis",
        title: "Saved synthetic orbital quorum",
      },
      parentSurfaces
    );
    expect(save.details).toMatchObject({ status: "awaiting_user", next: "review" });
    const saveRunId = String(save.details["run_id"]);
    hostSurfaces.push(
      approveContentReview({ projectRoot, host, runId: saveRunId, exercisePublicFailure: true })
    );
    const savePage = compositions.save?.page;
    if (savePage === undefined) throw new Error("published save composition fixture is absent");
    expect(readSelectedGeneration(kbRoot)?.catalog.pages[savePage.page_id]?.revision_id).toBe(
      savePage.revision_id
    );
    const duplicateSave = await callTool(
      tool,
      projectRoot,
      "call_save_consumed_claim",
      {
        schema_version: 1,
        action: "save",
        kb_profile_id: PROFILE,
        query_run_id: queryRunId,
        page_kind: "synthesis",
        title: "Duplicate save",
      },
      parentSurfaces
    );
    expect(duplicateSave.details).toMatchObject({
      status: "error",
      warnings: ["save_run_failed"],
    });

    const lint = await callTool(
      tool,
      projectRoot,
      "call_lint_registered",
      {
        schema_version: 1,
        action: "lint",
        kb_profile_id: PROFILE,
        mode: "deterministic",
      },
      parentSurfaces
    );
    expect(lint.details).toMatchObject({ action: "lint", status: "complete", met: true });

    const targetRoot = path.join(projectRoot, "canonical-target");
    mkdirSync(targetRoot, { mode: 0o700 });
    const targetPath = path.join(targetRoot, "GUIDANCE.md");
    const original = Buffer.from("# Canonical\n\nOriginal synthetic guidance.\n", "utf8");
    const replacement = `# Canonical\n\nReviewed synthetic guidance. ${markers.patch}\n`;
    writeFileSync(targetPath, original, { mode: 0o600 });
    const targetEnvelope = mintEnvelope({
      kind: "canonical_target",
      session_id: SESSION,
      kb_profile_id: PROFILE,
      resolved_path: targetPath,
      authority_root: targetRoot,
      expected_sha256: sha256Hex(original.toString("utf8")),
      allowed_operation: "promote",
      issued_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const capabilityStore = new CapabilityStore(projectRoot);
    capabilityStore.register(targetEnvelope);
    capabilityStore.close();
    targetFixture.current = {
      capabilityId: targetEnvelope.capability_id,
      targetPath,
      original,
      replacement,
    };

    // Target authority fails once before the valid production-posture prepare.
    const badPromote = await callTool(
      tool,
      projectRoot,
      "call_promote_missing_target",
      {
        schema_version: 1,
        action: "promote",
        kb_profile_id: PROFILE,
        page_revisions: [savePage],
        canonical_target_capability_ids: ["cap_missing_promotion_target"],
      },
      parentSurfaces
    );
    expect(badPromote.details).toMatchObject({
      status: "error",
      warnings: ["promote_run_failed"],
    });
    expect(readFileSync(targetPath)).toEqual(original);

    const promote = await callTool(
      tool,
      projectRoot,
      "call_promote_registered",
      {
        schema_version: 1,
        action: "promote",
        kb_profile_id: PROFILE,
        page_revisions: [savePage],
        canonical_target_capability_ids: [targetEnvelope.capability_id],
      },
      parentSurfaces
    );
    expect(promote.details).toMatchObject({ status: "awaiting_user", next: "review" });
    const promoteRunId = String(promote.details["run_id"]);
    expect(readFileSync(targetPath)).toEqual(original);

    // The public schema has no model/decision/apply override, and generic gate
    // response plus an unsigned receipt both fail before canonical mutation.
    expect(
      Value.Check(tool.parameters, {
        schema_version: 1,
        action: "promote",
        kb_profile_id: PROFILE,
        page_revisions: [savePage],
        canonical_target_capability_ids: [targetEnvelope.capability_id],
        model: "test/model",
      })
    ).toBe(false);
    expect(
      Value.Check(tool.parameters, {
        schema_version: 1,
        action: "promote",
        kb_profile_id: PROFILE,
        page_revisions: [savePage],
        canonical_target_capability_ids: [targetEnvelope.capability_id],
        decision: "approve",
      })
    ).toBe(false);
    expect(Value.Check(tool.parameters, { schema_version: 1, action: "apply" })).toBe(false);
    const promotionRun = required(
      host.checkpointer.loadRunById(promoteRunId),
      "durable promotion run"
    );
    const promotionPending = required(promotionRun.pendingDirective, "pending promotion directive");
    expect(() =>
      host.engine.handle({
        schema_version: 2,
        action: "respond",
        identity: promotionRun.identity,
        gate_id: promotionPending.action === "await_user" ? promotionPending.gate_id : "",
        challenge: promotionPending.action === "await_user" ? promotionPending.challenge : "",
        response: "approve",
      })
    ).toThrow(/host-only/);

    const approval = new PromotionApprovalStore({
      projectRoot,
      kbRoot,
      artifactCheckpointer: host.checkpointer,
      controlBindingForRun: (runId) => host.checkpointer.promotionApprovalBinding(runId),
      reserveApplyOperation: (operation) => {
        host.checkpointer.reserveOperationEventGroup({
          run_id: operation.runId,
          session_id: operation.sessionId,
          transaction_id: operation.transactionId,
          action: "promote",
          source_kind: "promotion_apply",
          source_identity_sha256: promotionApplyOperationSourceIdentity({
            approval_receipt_sha256: operation.receiptSha256,
            transaction_id: operation.transactionId,
          }),
        });
      },
    });
    expect(() => approval.resumeApprovedPromotion("{}")).toThrow();
    expect(readFileSync(targetPath)).toEqual(original);
    approval.rotateKey("pkey_registered_e2e");
    const gate = required(approval.gateForRun(promoteRunId), "promotion approval gate");
    const decision = approval.decide(
      approval.buildDecisionIntent({
        challengeId: gate.challenge_id,
        decision: "approve",
        reviewerSubjectId: authenticateLocalContentReviewer().subjectId,
      })
    );
    const decisionIntentSha256 = required(
      decision.gate.decision_intent_sha256,
      "promotion decision intent digest"
    );
    const receipt = required(decision.receipt, "promotion approval receipt");
    const receiptSha256 = required(decision.receipt_sha256, "promotion approval receipt digest");
    const receiptJcs = required(decision.receipt_jcs, "promotion approval receipt bytes");
    const controlDecision = host.engine.recordPromotionDecision({
      runId: promoteRunId,
      challengeId: gate.challenge_id,
      decision: "approve",
      intentSha256: decisionIntentSha256,
      packetSha256: decision.gate.packet_sha256,
      receiptId: receipt.receipt_id,
      receiptSha256,
    });
    expect(controlDecision.action).toBe("await_user");
    const apply = approval.resumeApprovedPromotion(receiptJcs);
    const promotionTerminal = host.engine.finalizeApprovedPromotion({
      runId: apply.run_id,
      status: apply.status,
      receiptId: apply.receipt_id,
      receiptSha256: apply.receipt_sha256,
      transactionId: apply.transaction_id,
      targetCount: apply.target_count,
      postApplyVerified: apply.post_apply_verified,
    });
    hostSurfaces.push(promotionTerminal);
    expect(promotionTerminal.action).toBe("complete");
    expect(readFileSync(targetPath, "utf8")).toBe(replacement);
    expect(readdirSync(targetRoot).sort()).toEqual(["GUIDANCE.md"]);
    expect(approval.receipt(apply.receipt_id)?.state).toBe("consumed");
    expect(approval.journal(apply.transaction_id)).toMatchObject({
      state: "complete",
      post_apply_verified: true,
    });

    // Actual control state, receipts, capability/approval authority, and private
    // input settlement are inspected before any owner DB is closed.
    const finalCapabilities = new CapabilityStore(projectRoot);
    const sourceAdmissions = finalCapabilities.admissionsForRun(ingestRunId);
    expect(sourceAdmissions).toHaveLength(1);
    expect(sourceAdmissions[0]).toMatchObject({ state: "published" });
    expect(sourceAdmissions[0]?.temporary_storage_key).toBeUndefined();
    expect(finalCapabilities.lease(sourceCapability.capability_id)?.state).toBe("consumed");
    expect(finalCapabilities.lease(targetEnvelope.capability_id)?.state).toBe("consumed");

    const finalParentGrants = new ParentDeliveryGrantStore(projectPaths.knowledgeBase.hostGrants);
    expect(finalParentGrants.list()).toMatchObject({
      grants: [{ grant_id: "pgt_registered_e2e", state: "consumed", run_id: queryRunId }],
      skipped_malformed: 0,
    });
    const saveClaims = new SaveQueryClaimStore(saveClaimStoreDir(projectRoot, PROFILE));
    expect(saveClaims.load(queryRunId)).toMatchObject({
      state: "consumed",
      save_run_id: saveRunId,
    });

    for (const runId of [ingestRunId, queryRunId, saveRunId, promoteRunId]) {
      const groups = host.checkpointer.operationEventGroups(runId);
      const receipts = host.checkpointer.operationReceipts(runId);
      expect(groups.length).toBeGreaterThan(0);
      expect(receipts.length).toBeGreaterThanOrEqual(groups.length);
      assertRawAbsent(`operation groups ${runId}`, groups, markers);
      assertRawAbsent(`operation receipts ${runId}`, receipts, markers);
      assertDerivedAbsent(`operation groups ${runId}`, groups, markers);
      assertDerivedAbsent(`operation receipts ${runId}`, receipts, markers);
    }
    expect(
      host.checkpointer.operationEventGroups(ingestRunId).map((row) => row.source_kind)
    ).toEqual(["external_start", "content_review_decision"]);
    expect(host.checkpointer.operationEventGroups(saveRunId).map((row) => row.source_kind)).toEqual(
      ["external_start", "content_review_decision"]
    );
    expect(
      host.checkpointer.operationEventGroups(promoteRunId).map((row) => row.source_kind)
    ).toEqual(["external_start", "promotion_decision", "promotion_apply"]);

    for (const runId of [ingestRunId, queryRunId, saveRunId, promoteRunId]) {
      expect(host.checkpointer.getPrivateInput(runId)?.state).toBe("discarded");
    }
    for (const posture of phasePostures) {
      const phaseRunId = String(posture["run_id"] ?? "");
      const stateId = String(posture["state"] ?? "");
      const record = host.checkpointer.kbPhaseOperandsRecord(phaseRunId, stateId);
      expect(record).toMatchObject({
        schema_version: 1,
        lifecycle: "closed",
        operands: {
          schema_version: 1,
          run_id: phaseRunId,
          state_id: stateId,
        },
      });
      expect(record?.operands.private_input_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(Array.isArray(record?.operands.allowed_prior_artifacts)).toBe(true);
      expect(Array.isArray(record?.operands.allowed_selected_pages)).toBe(true);
      expect(record?.created_at).toMatch(/Z$/);
      expect(record?.closed_at).toMatch(/Z$/);
      if (stateId === "compose") {
        expect(record?.operands.compose_authority).toBeDefined();
      } else {
        expect(record?.operands.compose_authority).toBeUndefined();
      }
    }
    for (const runId of [ingestRunId, queryRunId, saveRunId, promoteRunId]) {
      const run = required(host.checkpointer.loadRunById(runId), `durable control run ${runId}`);
      assertRawAbsent(`control run ${runId}`, run.snapshot(), markers);
      assertDerivedAbsent(`control run ${runId}`, run.snapshot(), markers);
    }

    const controlDbPath = projectPaths.orchestration.database;
    const sqlite = process.getBuiltinModule("node:sqlite");
    if (sqlite === undefined) throw new Error("node:sqlite unavailable");
    const projectionDb = new sqlite.DatabaseSync(controlDbPath);
    const projections = projectionDb
      .prepare("SELECT context_json FROM runs WHERE playbook='knowledge-base'")
      .all();
    projectionDb.close();
    expect(projections.length).toBeGreaterThan(0);
    for (const value of projections) {
      const row = object(value);
      const contextJson = requireString(row.context_json, "run projection omitted context JSON");
      const projection = object(parseJson(contextJson));
      expect(projection.durable_schema_version).toBe(1);
      expect(projection).not.toHaveProperty("project_root");
      expect(contextJson).not.toContain(projectRoot);
      expect(contextJson).not.toContain(kbRoot);
    }

    const databasePaths = [
      controlDbPath,
      projectPaths.artifacts.manifestDatabase,
      path.join(projectPaths.knowledgeBase.capabilities, "capabilities.sqlite"),
      path.join(projectPaths.knowledgeBase.approval, "receipts.sqlite"),
      path.join(projectPaths.knowledgeBase.hostGrants, "grants.sqlite"),
      path.join(saveClaimStoreDir(projectRoot, PROFILE), "claims.sqlite"),
    ];
    assertDatabaseSurfaces(databasePaths, markers);

    const receiptRoot = projectPaths.knowledgeBase.operationReceipts;
    const receiptFiles = allFiles(receiptRoot);
    expect(receiptFiles.length).toBeGreaterThan(0);
    for (const receiptFile of receiptFiles) {
      const bytes = readFileSync(receiptFile);
      assertRawAbsent(`operation receipt file ${path.basename(receiptFile)}`, bytes, markers);
      assertDerivedAbsent(`operation receipt file ${path.basename(receiptFile)}`, bytes, markers);
    }

    // Raw private bytes exist only on intended private planes. The query input
    // was discarded; temporary names and promotion staging are gone.
    const projectFiles = allFiles(projectRoot);
    const byteLocations = (marker: string) =>
      projectFiles.filter(
        (candidate) =>
          lstatSync(candidate).isFile() && readFileSync(candidate).includes(Buffer.from(marker))
      );
    expect(byteLocations(markers.source).length).toBeGreaterThan(0);
    expect(byteLocations(markers.claim).length).toBeGreaterThan(0);
    expect(byteLocations(markers.page).length).toBeGreaterThan(0);
    expect(byteLocations(markers.report).length).toBeGreaterThan(0);
    expect(byteLocations(markers.patch).length).toBeGreaterThan(0);
    expect(byteLocations(markers.query)).toEqual([]);
    for (const marker of [markers.claim, markers.page, markers.report, markers.patch]) {
      for (const location of byteLocations(marker)) {
        const inKb = location === kbRoot || location.startsWith(`${kbRoot}${path.sep}`);
        expect(inKb || (marker === markers.patch && location === targetPath), location).toBe(true);
      }
    }
    for (const candidate of projectFiles) {
      const relative = path.relative(projectRoot, candidate);
      expect(relative).not.toMatch(/(?:^|\/)(?:\.mempalace)(?:\/|$)|\.jsonl$|\.snap$/);
      expect(path.basename(candidate)).not.toMatch(/\.tmp$|^\.pny-promote-/);
      assertRawAbsent(`temporary path name ${relative}`, relative, markers);
      assertDerivedAbsent(`temporary path name ${relative}`, relative, markers);
    }

    // Every deterministic agent saw the production worker's exact closed tool
    // posture. No memory adapter or ambient extension entered a KB phase.
    expect(agentErrors).toEqual([]);
    expect(phasePostures.map((entry) => `${entry.action}:${entry.state}`)).toEqual([
      "ingest:ingest",
      "ingest:compose",
      "ingest:lint",
      "ingest:verify",
      "query:query",
      "query:verify",
      "query:query",
      "query:verify",
      "query:query",
      "query:verify",
      "save:compose",
      "save:lint",
      "save:verify",
      "promote:plan",
      "promote:patch",
    ]);
    assertRawAbsent("phase posture projections", phasePostures, markers);
    assertDerivedAbsent("phase posture projections", phasePostures, markers);

    // Parent and logger copy surfaces: every raw marker stays private. The one
    // granted query result is the sole parent-side surface carrying DERIVED.
    for (const surface of parentSurfaces)
      assertRawAbsent("registered tool result", surface, markers);
    assertRawAbsent("host callback results", hostSurfaces, markers);
    assertRawAbsent("actual structured logger capture", capturedLogs, markers);
    assertDerivedAbsent("actual structured logger capture", capturedLogs, markers);
    expect(capturedLogs.some((entry) => entry.includes("kb_profile_admission_refused"))).toBe(true);
    for (const surface of parentSurfaces) {
      if (surface !== grantedQuery)
        assertDerivedAbsent("non-granted parent result", surface, markers);
    }

    inspectPackageAndArchiveOutputs(markers);

    saveClaims.close();
    finalParentGrants.close();
    finalCapabilities.close();
    approval.close();
    host.close();
  }, 60_000);
});
