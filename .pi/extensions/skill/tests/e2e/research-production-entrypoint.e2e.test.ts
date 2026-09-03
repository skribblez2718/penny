/** P4 deterministic ordinary-worker production-entrypoint research E2E. */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ArtifactStore,
  Checkpointer,
  canonicalJson,
  initializePennyState,
  sha256,
  type ArtifactRef,
} from "@penny/orchestration/source";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  validateGroundedSynthesis,
  validateResearchProductEnvelope,
  validateResearchProductGraph,
  validateResearchSemanticDraft,
} from "../../../../../apps/orchestration/src/skill-contracts/research.js";
import { createTestExtensionApi, isRecord } from "../../../../lib/tests/test-narrowers.js";
import { parseArtifactRef } from "../../artifact-client.js";
import type { SkillResult } from "../../skill-utils.js";

interface SessionCapture {
  readonly requested: readonly string[];
  readonly active: readonly string[];
  prompt?: string;
}

interface ProviderAssistantErrorFixture {
  readonly text: string;
  readonly stopReason: "error";
  readonly errorMessage: string;
}

const providerBoundary = vi.hoisted(() => ({
  captures: [] as SessionCapture[],
  respond: undefined as undefined | ((prompt: string) => string | ProviderAssistantErrorFixture),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: vi.fn(async (...args: Parameters<typeof actual.createAgentSession>) => {
      const created = await actual.createAgentSession(...args);
      const capture: SessionCapture = {
        requested: [...(args[0]?.tools ?? [])],
        active: [...created.session.getActiveToolNames()],
      };
      providerBoundary.captures.push(capture);
      vi.spyOn(created.session, "prompt").mockImplementation(async (prompt) => {
        capture.prompt = prompt;
        const response = providerBoundary.respond?.(prompt);
        if (response === undefined) throw new Error("P4 provider-response stub is not installed");
        const text = typeof response === "string" ? response : response.text;
        created.session.messages.push({
          role: "assistant",
          content: text.length === 0 ? [] : [{ type: "text", text }],
          api: "anthropic-messages",
          provider: "p4-deterministic-provider-stub",
          model: "p4-deterministic-model-stub",
          usage: {
            input: 1,
            output: text.length === 0 ? 0 : 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: text.length === 0 ? 1 : 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: typeof response === "string" ? "stop" : response.stopReason,
          ...(typeof response === "string" ? {} : { errorMessage: response.errorMessage }),
          timestamp: Date.now(),
        });
      });
      return created;
    }),
  };
});

interface RegisteredSkillTool {
  readonly name: "skill";
  readonly execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: unknown
  ) => Promise<{ readonly details: SkillResult }>;
}

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const LOCAL_OBSERVABILITY_REST_URL = "http://127.0.0.1:1";
const MAX_DIAGNOSTIC_BODY_BYTES = 16_384;
const MAX_DIAGNOSTIC_VALUE_DEPTH = 4;
const MAX_DIAGNOSTIC_COLLECTION_SIZE = 32;
const MAX_DIAGNOSTIC_STRING_LENGTH = 4_096;
const DIAGNOSTIC_LEVELS: ReadonlySet<string> = new Set([
  "DEBUG",
  "INFO",
  "WARN",
  "ERROR",
  "CRITICAL",
]);
const DIAGNOSTIC_KEYS: ReadonlySet<string> = new Set([
  "level",
  "component",
  "event",
  "client_id",
  "session_id",
  "data",
]);
const SENSITIVE_DIAGNOSTIC_KEY =
  /^(?:authorization|cookie|set-cookie|password|secret|token|api[_-]?key)$/iu;
const temporaryRoots: string[] = [];
const originalEnvironment = {
  stateRoot: process.env.PENNY_STATE_ROOT,
  projectRoot: process.env.PROJECT_ROOT,
  skillsDir: process.env.PENNY_SKILLS_DIR,
  observabilityEnabled: process.env.PI_OBSERVABILITY_ENABLED,
  observabilityAutoStart: process.env.PI_OBSERVABILITY_AUTO_START,
  observabilityRestUrl: process.env.PI_OBSERVABILITY_REST_URL,
  artifactRoot: process.env.PENNY_ARTIFACT_ROOT,
};

function restore(name: keyof NodeJS.ProcessEnv, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  providerBoundary.respond = undefined;
  providerBoundary.captures.length = 0;
  vi.restoreAllMocks();
  restore("PENNY_STATE_ROOT", originalEnvironment.stateRoot);
  restore("PROJECT_ROOT", originalEnvironment.projectRoot);
  restore("PENNY_SKILLS_DIR", originalEnvironment.skillsDir);
  restore("PI_OBSERVABILITY_ENABLED", originalEnvironment.observabilityEnabled);
  restore("PI_OBSERVABILITY_AUTO_START", originalEnvironment.observabilityAutoStart);
  restore("PI_OBSERVABILITY_REST_URL", originalEnvironment.observabilityRestUrl);
  restore("PENNY_ARTIFACT_ROOT", originalEnvironment.artifactRoot);
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function isRegisteredSkillTool(value: unknown): value is RegisteredSkillTool {
  return isRecord(value) && value.name === "skill" && typeof value.execute === "function";
}

function assertSafeDiagnosticValue(value: unknown, location: string, depth = 0): void {
  if (depth > MAX_DIAGNOSTIC_VALUE_DEPTH) {
    throw new Error(`${location} exceeds the diagnostic nesting limit`);
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${location} contains a non-finite number`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_DIAGNOSTIC_STRING_LENGTH) {
      throw new Error(`${location} exceeds the diagnostic string limit`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_DIAGNOSTIC_COLLECTION_SIZE) {
      throw new Error(`${location} exceeds the diagnostic array limit`);
    }
    for (const [index, item] of value.entries()) {
      assertSafeDiagnosticValue(item, `${location}[${index}]`, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) throw new Error(`${location} is not JSON diagnostic data`);
  const entries = Object.entries(value);
  if (entries.length > MAX_DIAGNOSTIC_COLLECTION_SIZE) {
    throw new Error(`${location} exceeds the diagnostic object limit`);
  }
  for (const [key, item] of entries) {
    if (["__proto__", "constructor", "prototype"].includes(key)) {
      throw new Error(`${location} contains an unsafe object key`);
    }
    if (SENSITIVE_DIAGNOSTIC_KEY.test(key)) {
      throw new Error(`${location} contains sensitive field '${key}'`);
    }
    assertSafeDiagnosticValue(item, `${location}.${key}`, depth + 1);
  }
}

function expectOnlyLocalObservabilityDiagnostics(
  calls: ReadonlyArray<readonly [input: string | URL | Request, init?: RequestInit]>
): void {
  const configured = process.env.PI_OBSERVABILITY_REST_URL;
  if (configured === undefined) throw new Error("test observability REST URL is not configured");
  const baseUrl = new URL(configured);
  expect(baseUrl.protocol).toBe("http:");
  expect(baseUrl.hostname).toBe("127.0.0.1");
  expect(baseUrl.username).toBe("");
  expect(baseUrl.password).toBe("");
  expect(baseUrl.pathname).toBe("/");
  expect(baseUrl.search).toBe("");
  expect(baseUrl.hash).toBe("");
  const expectedEndpoint = `${baseUrl.toString().replace(/\/$/u, "")}/logs`;

  for (const [index, call] of calls.entries()) {
    const [input, init] = call;
    if (typeof input !== "string") throw new Error(`fetch call ${index} did not use a string URL`);
    expect(input, `fetch call ${index} destination`).toBe(expectedEndpoint);
    if (init === undefined) throw new Error(`fetch call ${index} omitted request options`);
    expect(init.method, `fetch call ${index} method`).toBe("POST");
    expect(
      [...new Headers(init.headers).entries()].sort(([left], [right]) =>
        left.localeCompare(right, "en")
      ),
      `fetch call ${index} headers`
    ).toEqual([
      ["accept", "application/json"],
      ["content-type", "application/json"],
    ]);
    if (typeof init.body !== "string") {
      throw new Error(`fetch call ${index} omitted a JSON diagnostic body`);
    }
    if (Buffer.byteLength(init.body, "utf8") > MAX_DIAGNOSTIC_BODY_BYTES) {
      throw new Error(`fetch call ${index} diagnostic body exceeds the byte limit`);
    }
    const payload: unknown = JSON.parse(init.body);
    if (!isRecord(payload)) throw new Error(`fetch call ${index} diagnostic body is not an object`);
    for (const key of Object.keys(payload)) {
      if (!DIAGNOSTIC_KEYS.has(key)) {
        throw new Error(`fetch call ${index} diagnostic body contains unknown field '${key}'`);
      }
    }
    if (typeof payload.level !== "string" || !DIAGNOSTIC_LEVELS.has(payload.level)) {
      throw new Error(`fetch call ${index} diagnostic level is unsafe`);
    }
    if (
      typeof payload.component !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/u.test(payload.component)
    ) {
      throw new Error(`fetch call ${index} diagnostic component is unsafe`);
    }
    if (
      typeof payload.event !== "string" ||
      payload.event.length === 0 ||
      payload.event.length > MAX_DIAGNOSTIC_STRING_LENGTH
    ) {
      throw new Error(`fetch call ${index} diagnostic event is unsafe`);
    }
    if (payload.client_id !== "penny-extension") {
      throw new Error(`fetch call ${index} diagnostic client is unsafe`);
    }
    if (
      payload.session_id !== undefined &&
      (typeof payload.session_id !== "string" || payload.session_id.length > 256)
    ) {
      throw new Error(`fetch call ${index} diagnostic session is unsafe`);
    }
    if (payload.data !== undefined) {
      assertSafeDiagnosticValue(payload.data, `fetch call ${index} diagnostic data`);
    }
  }
}

function registeredSkillTool(): {
  api: ReturnType<typeof createTestExtensionApi>;
  get: () => RegisteredSkillTool;
} {
  let registered: RegisteredSkillTool | undefined;
  const api = createTestExtensionApi({
    onRegisterTool(definition) {
      if (isRegisteredSkillTool(definition)) registered = definition;
    },
  });
  return {
    api,
    get: () => {
      if (registered === undefined) throw new Error("production skill tool was not registered");
      return registered;
    },
  };
}

function artifactRefsFromPrompt(prompt: string): ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  for (const line of prompt.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes('"artifact_id"')) continue;
    const value: unknown = JSON.parse(trimmed);
    if (!isRecord(value) || typeof value.artifact_id !== "string") continue;
    refs.push(parseArtifactRef(value));
  }
  return refs;
}

function buildDraft(refs: readonly ArtifactRef[]) {
  const evidenceArtifacts = refs
    .filter((ref) => ref.phase === "researching" && ref.kind === "agent-output")
    .sort((left, right) =>
      `${left.branch_id ?? ""}/${left.operation_id}/${left.artifact_id}`.localeCompare(
        `${right.branch_id ?? ""}/${right.operation_id}/${right.artifact_id}`
      )
    );
  const evidence = evidenceArtifacts.map((_artifact, index) => ({
    source_index: index,
    evidence_artifact_slot: index,
    locator: `p4-provider-stub-${index + 1}`,
    excerpt: `p4-provider-stub-${index + 1}`,
    relation: "supports" as const,
  }));
  return validateResearchSemanticDraft({
    schema_id: "penny.research-semantic-draft.v1",
    schema_version: 1,
    title: "P4 ordinary-worker deterministic result",
    executive_summary: "The production entrypoint returned the exact semantic core.",
    claims: [
      {
        statement: "The deterministic P4 provider boundary supplied one cited fixture claim.",
        claim_kind: "fact",
        support_status: "supported",
        confidence: 1,
        evidence_indexes: evidence.map((_item, index) => index),
        qualifications: [],
      },
    ],
    sources: evidence.map((_item, index) => ({
      source_kind: "primary",
      role: "evidentiary",
      tier: 1,
      title: `P4 fixture source ${index + 1}`,
      locator: `https://example.invalid/p4-source-${index + 1}`,
      observed_at: "2026-08-26T00:00:00Z",
    })),
    evidence,
    contradictions: [],
    unresolved_gaps: [],
    irreducible_uncertainties: [],
    sections: [
      {
        heading: "Production entrypoint",
        body: "Echo evidence passed through Synthia, deterministic host projection and sealing, Vera, and rendering.",
        claim_indexes: [0],
        evidence_indexes: evidence.map((_item, index) => index),
      },
    ],
  });
}

function independentYamlTools(agent: string): string[] {
  const document = readFileSync(path.join(PROJECT_ROOT, ".pi", "agents", `${agent}.md`), "utf8");
  const frontmatter = document.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? "";
  const tools = frontmatter
    .split(/\r?\n/u)
    .find((line) => line.startsWith("tools:"))
    ?.slice("tools:".length)
    .split(",")
    .map((name) => name.trim());
  if (tools === undefined || tools.length === 0) throw new Error(`missing YAML tools for ${agent}`);
  return tools;
}

function phaseFromPrompt(prompt: string): "researching" | "synthesizing" | "validating" {
  if (prompt.includes("Research '") && prompt.includes("tiered, cited findings"))
    return "researching";
  if (
    prompt.includes("Synthesize the exact research artifacts") &&
    prompt.includes("ResearchSemanticDraftV1")
  )
    return "synthesizing";
  if (prompt.includes("Verify every material claim")) return "validating";
  throw new Error(`unexpected production research prompt: ${prompt.slice(0, 160)}`);
}

describe("P4 production skill entrypoint", () => {
  it("completes Quick through ordinary PiAgentClient sessions with only provider responses stubbed", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "penny-p4-production-entrypoint-"));
    temporaryRoots.push(sandbox);
    const projectRoot = path.join(sandbox, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    symlinkSync(path.join(PROJECT_ROOT, ".pi"), path.join(projectRoot, ".pi"), "dir");
    process.env.PENNY_STATE_ROOT = path.join(sandbox, "state");
    process.env.PROJECT_ROOT = projectRoot;
    process.env.PENNY_SKILLS_DIR = path.join(projectRoot, ".pi", "skills");
    process.env.PI_OBSERVABILITY_ENABLED = "false";
    process.env.PI_OBSERVABILITY_AUTO_START = "false";
    process.env.PI_OBSERVABILITY_REST_URL = LOCAL_OBSERVABILITY_REST_URL;
    delete process.env.PENNY_ARTIFACT_ROOT;
    const state = initializePennyState(projectRoot, { env: process.env });
    const artifacts = ArtifactStore.openExisting(state.paths.artifacts.root, {
      projectId: state.projectId,
    });
    const providerReads: string[] = [];
    const providerStates: string[] = [];
    providerBoundary.respond = (prompt) => {
      const stateId = phaseFromPrompt(prompt);
      providerStates.push(stateId);
      const refs = artifactRefsFromPrompt(prompt);
      for (const ref of refs) {
        artifacts.read(ref);
        providerReads.push(ref.artifact_id);
      }
      if (stateId === "researching") {
        return 'p4-provider-stub-1\nSUMMARY:{"confidence":"CERTAIN","explore_complete":true}';
      }
      if (stateId === "synthesizing") {
        return `${canonicalJson(buildDraft(refs))}\nSUMMARY:{"confidence":"CERTAIN","synthesis_complete":true}`;
      }
      return 'grounded\nSUMMARY:{"confidence":"CERTAIN","verdict":"PASS","unsupported_claims":[],"evidence":["exact provider-stub evidence"]}';
    };

    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const registration = registeredSkillTool();
    const extension = await import("../../index.js");
    extension.default(registration.api);
    const result = await registration.get().execute(
      "p4-production-entrypoint",
      {
        skill_name: "research",
        goal: "Prove the deterministic P4 production entrypoint.",
        session_id: "p4-production-entrypoint",
        constraints: { mode: "quick" },
      },
      undefined,
      undefined,
      {
        cwd: projectRoot,
        isProjectTrusted: () => true,
        ui: { theme: { fg: () => "" }, notify: vi.fn() },
      }
    );

    expect(result.details).toMatchObject({
      success: true,
      session_id: "p4-production-entrypoint",
      skill_name: "research",
      state: "complete",
    });
    expect(providerStates).toEqual(["researching", "synthesizing", "validating"]);
    expect(providerBoundary.captures).toHaveLength(3);
    const agents = ["echo", "synthia", "vera"];
    for (const [index, capture] of providerBoundary.captures.entries()) {
      const expected = independentYamlTools(agents[index] ?? "");
      expect(capture.requested).toEqual(expected);
      expect([...capture.active].sort()).toEqual([...expected].sort());
      expect(capture.prompt).toContain("Read every task-provided input_artifact");
    }
    expect(providerReads.length).toBeGreaterThan(0);
    expect(new Set(providerReads).size).toBeGreaterThan(0);
    expectOnlyLocalObservabilityDiagnostics(network.mock.calls);
    for (const agent of agents) {
      const jsonl = readdirSync(path.join(state.paths.subagentSessions, agent)).filter((entry) =>
        entry.endsWith(".jsonl")
      );
      expect(jsonl, `${agent} durable workflow session`).toHaveLength(1);
    }
    expect(existsSync(path.join(state.paths.subagentSessions, "skribble"))).toBe(false);

    const output = result.details.output_artifact_ref;
    if (output === undefined) throw new Error("production entrypoint omitted semantic-core ref");
    expect(output.kind).toBe("semantic-core");
    expect(output.phase).toBe("sealing_core");
    const core = validateGroundedSynthesis(JSON.parse(artifacts.read(output).toString("utf8")));
    const resultBody = result.details.result;
    if (!isRecord(resultBody)) throw new Error("production terminal result is absent");
    const envelopeRef = parseArtifactRef(resultBody.product_envelope_ref);
    const envelope = validateResearchProductEnvelope(
      JSON.parse(artifacts.read(envelopeRef).toString("utf8"))
    );
    expect(envelope.semantic_core.artifact_ref).toEqual(output);
    expect(envelope.semantic_core.sha256).toBe(output.content_digest);
    const receipts: unknown[] = envelope.receipts.map((binding) => {
      const value: unknown = JSON.parse(artifacts.read(binding.artifact_ref).toString("utf8"));
      return value;
    });
    validateResearchProductGraph({ core, envelope, receipts, renders: envelope.renders });
    expect(envelope.receipts.map((receipt) => receipt.receipt_kind).sort()).toEqual([
      "deterministic_product_validation",
      "grounding_verification",
    ]);
    expect(envelope.renders.map((render) => render.render_name).sort()).toEqual([
      "readme",
      "report",
      "sources",
    ]);
    const reportFiles = resultBody.report_files;
    expect(reportFiles).toEqual([
      path.join(String(resultBody.report_dir), "report.md"),
      path.join(String(resultBody.report_dir), "sources.md"),
      path.join(String(resultBody.report_dir), "README.md"),
    ]);
    for (const render of envelope.renders) {
      const file = path.join(String(resultBody.report_dir), render.target_relative_path);
      const fileBytes = readFileSync(file);
      expect(fileBytes).toEqual(artifacts.read(render.artifact_ref));
      expect(sha256(fileBytes)).toBe(render.content_sha256);
    }

    const checkpointer = Checkpointer.openExisting(state.paths.orchestration.database, undefined, {
      projectId: state.projectId,
    });
    expect(
      checkpointer.stateVisits("p4-production-entrypoint").map((visit) => visit.state_id)
    ).toEqual(["intake", "researching", "synthesizing", "sealing_core", "validating", "rendering"]);
    expect(checkpointer.completionAdmission("p4-production-entrypoint")?.origin_state).toBe(
      "rendering"
    );
    checkpointer.close();

    const unknownCandidate = await registration
      .get()
      .execute(
        "p4-no-p5",
        { skill_name: "p4-candidate", goal: "must refuse", session_id: "p4-no-p5" },
        undefined,
        undefined,
        { cwd: projectRoot, isProjectTrusted: () => true, ui: { theme: { fg: () => "" } } }
      );
    expect(unknownCandidate.details.success).toBe(false);
    expect(unknownCandidate.details).toMatchObject({ refusal_code: "SKILL_NOT_REGISTERED" });
    expect(unknownCandidate.details.errors[0]).toMatch(/^SKILL_NOT_REGISTERED:/u);
    expect(providerBoundary.captures).toHaveLength(3);
    artifacts.close();
  }, 120_000);

  it("returns durable incomplete for an exact mocked Pi liveness final", async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "penny-p4-production-liveness-"));
    temporaryRoots.push(sandbox);
    const projectRoot = path.join(sandbox, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    symlinkSync(path.join(PROJECT_ROOT, ".pi"), path.join(projectRoot, ".pi"), "dir");
    process.env.PENNY_STATE_ROOT = path.join(sandbox, "state");
    process.env.PROJECT_ROOT = projectRoot;
    process.env.PENNY_SKILLS_DIR = path.join(projectRoot, ".pi", "skills");
    process.env.PI_OBSERVABILITY_ENABLED = "false";
    process.env.PI_OBSERVABILITY_AUTO_START = "false";
    process.env.PI_OBSERVABILITY_REST_URL = LOCAL_OBSERVABILITY_REST_URL;
    delete process.env.PENNY_ARTIFACT_ROOT;
    const state = initializePennyState(projectRoot, { env: process.env });

    providerBoundary.respond = (prompt) => {
      expect(phaseFromPrompt(prompt)).toBe("researching");
      return {
        text: "",
        stopReason: "error",
        errorMessage: "external_request_budget_exhausted",
      };
    };
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const registration = registeredSkillTool();
    const extension = await import("../../index.js");
    extension.default(registration.api);

    const result = await registration.get().execute(
      "p4-production-liveness",
      {
        skill_name: "research",
        goal: "Prove exact Pi liveness errors reach durable research terminal truth.",
        session_id: "p4-production-liveness",
        constraints: { mode: "quick" },
      },
      undefined,
      undefined,
      {
        cwd: projectRoot,
        isProjectTrusted: () => true,
        ui: { theme: { fg: () => "" }, notify: vi.fn() },
      }
    );

    expect(result.details).toMatchObject({
      success: false,
      session_id: "p4-production-liveness",
      skill_name: "research",
      state: "incomplete",
      result: {
        terminal_reason: "external_request_budget_exhausted",
        liveness: { open_workers: 0 },
      },
    });
    expect(providerBoundary.captures).toHaveLength(1);
    expect(providerBoundary.captures[0]?.prompt).toContain("HOST-ENFORCED LIVENESS BUDGET:");
    expectOnlyLocalObservabilityDiagnostics(network.mock.calls);

    const checkpointer = Checkpointer.openExisting(state.paths.orchestration.database, undefined, {
      projectId: state.projectId,
    });
    const durable = checkpointer.loadRunById("p4-production-liveness");
    if (durable === undefined) throw new Error("production liveness run is absent");
    expect(durable.status).toBe("incomplete");
    expect(durable.stateId).toBe("complete");
    expect(durable.met).toBe(false);
    expect(durable.terminalDirective).toMatchObject({
      action: "incomplete",
      result: { terminal_reason: "external_request_budget_exhausted" },
    });
    expect(
      durable.selectedArtifacts.some((artifact) =>
        ["semantic-core", "product-envelope", "deterministic-render"].includes(artifact.kind)
      )
    ).toBe(false);
    checkpointer.close();
    expect(
      readdirSync(path.join(state.paths.subagentSessions, "echo")).filter((entry) =>
        entry.endsWith(".jsonl")
      )
    ).toHaveLength(1);
  }, 120_000);
});
