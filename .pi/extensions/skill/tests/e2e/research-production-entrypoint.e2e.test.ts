/** P4 deterministic ordinary-worker production-entrypoint research E2E. */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  cpSync,
  existsSync,
  writeFileSync,
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
  InMemoryCredentialStore,
  InMemoryModelsStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  formatSkillsForPrompt,
  initTheme,
  ModelRuntime,
  parseFrontmatter,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  ArtifactStore,
  Checkpointer,
  canonicalJson,
  initializePennyState,
  parseCurrentSkillResult,
  sha256,
  type ArtifactRef,
  type PiAgentClientOptions,
} from "@penny/orchestration";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  validateGroundedSynthesis,
  validateResearchProductEnvelope,
  validateResearchProductGraph,
  validateResearchSemanticDraft,
} from "../../../../../apps/orchestration/dist/skill-contracts/research.js";
import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { isRecord } from "../../../../lib/tests/test-narrowers.js";
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

// Worker model identity is synthetic; no provider lookup or service call is needed.
const fixtureWorkerModel: Awaited<ReturnType<NonNullable<PiAgentClientOptions["resolveModel"]>>> = {
  id: "research-offline-fixture",
  name: "Offline research fixture",
  provider: "ollama",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 8192,
};

// Only the explicitly scoped parent factory call bypasses the worker cognition fixture.
// Parent AgentSession.prompt, native expansion, tool dispatch and continuation stay real.
const parentCreation = new AsyncLocalStorage<boolean>();
vi.mock("../../../../../apps/orchestration/dist/model-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../../apps/orchestration/dist/model-client.js")>();
  return {
    ...actual,
    PiAgentClient: class extends actual.PiAgentClient {
      constructor(options: PiAgentClientOptions = {}) {
        super({ ...options, resolveModel: () => fixtureWorkerModel });
      }
    },
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: vi.fn(async (...args: Parameters<typeof actual.createAgentSession>) => {
      const created = await actual.createAgentSession(...args);
      if (parentCreation.getStore() === true) return created;
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

function installCanonicalWritingDocs(projectRoot: string): void {
  mkdirSync(path.join(projectRoot, "docs", "agents"), { recursive: true, mode: 0o700 });
  cpSync(
    path.join(PROJECT_ROOT, "docs", "agents", "writing"),
    path.join(projectRoot, "docs", "agents", "writing"),
    { recursive: true }
  );
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

function researchProject(prefix: string) {
  const sandbox = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryRoots.push(sandbox);
  const projectRoot = path.join(sandbox, "project");
  mkdirSync(path.join(projectRoot, ".pi"), { recursive: true, mode: 0o700 });
  // Catalogs are private copies: never link fixture writes back into the real project.
  for (const name of ["agents", "skills"]) {
    cpSync(path.join(PROJECT_ROOT, ".pi", name), path.join(projectRoot, ".pi", name), {
      recursive: true,
    });
  }
  symlinkSync(
    path.join(PROJECT_ROOT, ".pi", "extensions"),
    path.join(projectRoot, ".pi", "extensions"),
    "dir"
  );
  symlinkSync(path.join(PROJECT_ROOT, ".pi", "lib"), path.join(projectRoot, ".pi", "lib"), "dir");
  cpSync(path.join(PROJECT_ROOT, ".pi", "SYSTEM.md"), path.join(projectRoot, ".pi", "SYSTEM.md"));
  writeFileSync(path.join(projectRoot, "AGENTS.md"), "# Provider-free command fixture\n");
  installCanonicalWritingDocs(projectRoot);
  process.env.PENNY_STATE_ROOT = path.join(sandbox, "state");
  process.env.PROJECT_ROOT = projectRoot;
  process.env.PENNY_SKILLS_DIR = path.join(projectRoot, ".pi", "skills");
  process.env.PI_OBSERVABILITY_ENABLED = "false";
  process.env.PI_OBSERVABILITY_AUTO_START = "false";
  process.env.PI_OBSERVABILITY_REST_URL = LOCAL_OBSERVABILITY_REST_URL;
  delete process.env.PENNY_ARTIFACT_ROOT;
  const state = initializePennyState(projectRoot, { env: process.env });
  return { projectRoot, sandbox, state };
}

describe("P4 production skill entrypoint", () => {
  it("expands visible /skill:research natively and completes Quick through the real parent skill-tool loop (fixture cognition only)", async () => {
    const { projectRoot, sandbox, state } = researchProject("penny-research-native-command-");
    const artifacts = ArtifactStore.openExisting(state.paths.artifacts.root, {
      projectId: state.projectId,
    });
    const checkpointer = Checkpointer.openExisting(state.paths.orchestration.database, undefined, {
      projectId: state.projectId,
    });
    const providerStates: string[] = [];
    const providerReads: string[] = [];
    // Explicit synthetic worker cognition, not evidence of live research or model quality.
    providerBoundary.respond = (prompt) => {
      const phase = phaseFromPrompt(prompt);
      providerStates.push(phase);
      const refs = artifactRefsFromPrompt(prompt);
      for (const ref of refs) {
        artifacts.read(ref);
        providerReads.push(ref.artifact_id);
      }
      if (phase === "researching") {
        return 'p4-provider-stub-1\nSUMMARY:{"confidence":"CERTAIN","explore_complete":true}';
      }
      if (phase === "synthesizing") {
        return `${canonicalJson(buildDraft(refs))}\nSUMMARY:{"confidence":"CERTAIN","synthesis_complete":true}`;
      }
      return 'grounded\nSUMMARY:{"confidence":"CERTAIN","verdict":"PASS","unsupported_claims":[],"evidence":["exact provider-stub evidence"]}';
    };
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    initTheme("dark", false);
    const faux = fauxProvider({
      tokensPerSecond: 0,
      models: [
        {
          id: "research-command-parent",
          contextWindow: 131072,
          maxTokens: 8192,
        },
      ],
    });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false },
      cacheWarming: "off",
    });
    const prompts: string[] = [];
    const errors: unknown[] = [];
    const extension = await import("../../index.js");
    const loader = new DefaultResourceLoader({
      cwd: projectRoot,
      agentDir: path.join(sandbox, "parent-agent"),
      settingsManager,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      // Same production default factory seam as the hidden VideoGen command E2E.
      // No skill paths, overrides, custom slash commands or direct tool.execute calls.
      extensionFactories: [
        extension.default,
        (pi) => {
          pi.on("before_agent_start", (event) => {
            if ("prompt" in event) prompts.push(event.prompt);
          });
        },
      ],
    });
    await loader.reload();
    const { session } = await parentCreation.run(true, () =>
      createAgentSession({
        cwd: projectRoot,
        agentDir: path.join(sandbox, "parent-agent"),
        modelRuntime,
        model: faux.getModel(),
        settingsManager,
        sessionManager: SessionManager.inMemory(projectRoot),
        resourceLoader: loader,
        tools: ["skill", "read"],
      })
    );
    const starts: { toolCallId: string; args: unknown }[] = [];
    const outcomes: {
      toolCallId: string;
      isError: boolean;
      result: unknown;
    }[] = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start" && event.toolName === "skill") {
        starts.push({ toolCallId: event.toolCallId, args: event.args });
      }
      if (event.type === "tool_execution_end" && event.toolName === "skill") {
        outcomes.push({
          toolCallId: event.toolCallId,
          isError: event.isError,
          result: event.result,
        });
      }
    });
    try {
      await session.bindExtensions({
        mode: "json",
        onError: (error) => errors.push(error),
      });
      expect(loader.getExtensions().errors).toEqual([]);
      expect(session.getActiveToolNames().sort()).toEqual(["read", "skill"]);
      expect(vi.isMockFunction(session.prompt)).toBe(false);
      expect(providerBoundary.captures).toEqual([]);
      expect(loader.getSkills().skills.filter((skill) => skill.name === "research")).toMatchObject([
        { disableModelInvocation: false },
      ]);
      expect(formatSkillsForPrompt(loader.getSkills().skills)).toContain("<name>research</name>");
      expect(session.systemPrompt).toContain("<name>research</name>");
      const goal = "Prove visible native Research dispatch with synthetic evidence only.";
      const params = {
        skill_name: "research",
        goal,
        session_id: "research-native-command",
        model: `${fixtureWorkerModel.provider}/${fixtureWorkerModel.id}`,
        constraints: { mode: "quick" },
      };
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("skill", params), {
          stopReason: "toolUse",
        }),
        (context) => {
          const results = context.messages.filter(
            (message) => message.role === "toolResult" && message.toolName === "skill"
          );
          expect(results).toHaveLength(1);
          const result = results[0];
          if (result === undefined || result.role !== "toolResult") {
            throw new Error("parent continuation did not receive the real skill result");
          }
          expect(result.isError).toBe(false);
          expect(result.toolCallId).toBe(outcomes[0]?.toolCallId);
          return fauxAssistantMessage(
            "Parent fixture observed the tool result; no live research claim."
          );
        },
      ]);
      await session.prompt(`/skill:research ${goal}`);
      const manifest = path.join(projectRoot, ".pi", "skills", "research", "SKILL.md");
      const body = parseFrontmatter(readFileSync(manifest, "utf8")).body.trim();
      expect(prompts).toEqual([
        `<skill name="research" location="${manifest}">\nReferences are relative to ${path.dirname(manifest)}.\n\n${body}\n</skill>\n\n${goal}`,
      ]);
      expect(faux.state.callCount).toBe(2);
      expect(session.getLastAssistantText()).toBe(
        "Parent fixture observed the tool result; no live research claim."
      );
      expect(starts).toHaveLength(1);
      expect(starts[0]?.args).toEqual(params);
      expect(outcomes).toHaveLength(1);
      const outcome = outcomes[0];
      if (outcome === undefined || !isRecord(outcome.result)) {
        throw new Error("native parent skill execution did not return a tool result");
      }
      expect(outcome.toolCallId).toBe(starts[0]?.toolCallId);
      expect(outcome.isError, JSON.stringify(outcome.result)).toBe(false);
      const result = parseCurrentSkillResult(outcome.result.details);
      expect(result).toMatchObject({
        success: true,
        session_id: params.session_id,
        skill_name: "research",
        state: "complete",
        requires_approval: false,
        errors: [],
      });
      const durable = checkpointer.loadRunById(params.session_id);
      if (durable === undefined) throw new Error("native Research run was not persisted");
      expect(durable.status).toBe("complete");
      expect(durable.met).toBe(true);
      expect(checkpointer.stateVisits(params.session_id).map((visit) => visit.state_id)).toEqual([
        "intake",
        "researching",
        "synthesizing",
        "sealing_core",
        "validating",
        "rendering",
      ]);
      expect(checkpointer.completionAdmission(params.session_id)?.origin_state).toBe("rendering");
      expect(providerStates).toEqual(["researching", "synthesizing", "validating"]);
      expect(providerBoundary.captures).toHaveLength(3);
      for (const [index, agent] of ["echo", "synthia", "vera"].entries()) {
        const expected = independentYamlTools(agent);
        const capture = providerBoundary.captures[index];
        if (capture === undefined) throw new Error(`missing ${agent} worker capture`);
        expect(capture.requested).toEqual(expected);
        expect([...capture.active].sort()).toEqual([...expected].sort());
      }
      expect(providerReads.length).toBeGreaterThan(0);
      const output = result.output_artifact_ref;
      if (output === undefined || !isRecord(result.result)) {
        throw new Error("native Research result omitted its real product");
      }
      expect(output).toMatchObject({
        kind: "semantic-core",
        phase: "sealing_core",
      });
      const core = validateGroundedSynthesis(JSON.parse(artifacts.read(output).toString("utf8")));
      const envelopeRef = parseArtifactRef(result.result.product_envelope_ref);
      const envelope = validateResearchProductEnvelope(
        JSON.parse(artifacts.read(envelopeRef).toString("utf8"))
      );
      expect(envelope.semantic_core.artifact_ref).toEqual(output);
      const receipts: unknown[] = envelope.receipts.map((binding) => {
        const value: unknown = JSON.parse(artifacts.read(binding.artifact_ref).toString("utf8"));
        return value;
      });
      validateResearchProductGraph({
        core,
        envelope,
        receipts,
        renders: envelope.renders,
      });
      expect(envelope.receipts.map((binding) => binding.receipt_kind).sort()).toEqual([
        "deterministic_product_validation",
        "grounding_verification",
      ]);
      expect(envelope.renders.map((render) => render.render_name).sort()).toEqual([
        "readme",
        "report",
        "sources",
      ]);
      for (const render of envelope.renders) {
        const bytes = readFileSync(
          path.join(String(result.result.report_dir), render.target_relative_path)
        );
        expect(bytes).toEqual(artifacts.read(render.artifact_ref));
        expect(sha256(bytes)).toBe(render.content_sha256);
      }
      expect(errors).toEqual([]);
      expectOnlyLocalObservabilityDiagnostics(network.mock.calls);
    } finally {
      unsubscribe();
      session.dispose();
      checkpointer.close();
      artifacts.close();
    }
  }, 120_000);

  it("completes Quick through ordinary PiAgentClient sessions with only provider responses stubbed", async () => {
    const { projectRoot, state } = researchProject("penny-p4-production-entrypoint-");
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
        model: `${fixtureWorkerModel.provider}/${fixtureWorkerModel.id}`,
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
    const { projectRoot, state } = researchProject("penny-p4-production-liveness-");

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
        model: `${fixtureWorkerModel.provider}/${fixtureWorkerModel.id}`,
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
    expect(providerBoundary.captures[0]?.prompt).toContain(
      "HOST-ENFORCED RENEWABLE INACTIVITY LEASE:"
    );
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
