/** Real-SDK tool-surface coverage for the TypeScript skill worker path. */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SessionCapture {
  readonly requested: readonly string[];
  readonly active: readonly string[];
  readonly thinkingLevel: unknown;
  readonly systemPrompt: string;
  registeredBrowserAllowlist?: readonly string[];
  playwrightExtensionLoaded?: boolean;
  prompt?: string;
}

const { sessionCaptures, promptBoundary, promptCompletion } = vi.hoisted(() => {
  const promptCompletion: {
    providerCalls: number;
    complete: ((session: AgentSession) => Promise<string>) | undefined;
  } = {
    providerCalls: 0,
    complete: undefined,
  };
  return {
    sessionCaptures: [] as SessionCapture[],
    promptBoundary: new Error("deterministic session boundary before model invocation"),
    promptCompletion,
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: vi.fn(async (...args: Parameters<typeof actual.createAgentSession>) => {
      const created = await actual.createAgentSession(...args);
      const requested = [...(args[0]?.tools ?? [])];
      const capture: SessionCapture = {
        requested,
        systemPrompt: created.session.systemPrompt,
        active: [...created.session.getActiveToolNames()],
        thinkingLevel: args[0]?.thinkingLevel,
      };
      const carrierModule = await import("../dist/browser-policy-carrier.js");
      const carrier = carrierModule.currentRegisteredBrowserPolicyCarrier();
      if (carrier !== undefined) {
        capture.registeredBrowserAllowlist = carrier.allowlist;
        capture.playwrightExtensionLoaded = created.extensionsResult.extensions.some((extension) =>
          extension.resolvedPath.includes("/playwright/")
        );
      }
      sessionCaptures.push(capture);
      created.session.agent.streamFunction = () => {
        promptCompletion.providerCalls += 1;
        throw new Error("provider dispatch is forbidden in this SDK matrix");
      };
      vi.spyOn(created.session, "prompt").mockImplementation(async (prompt) => {
        capture.prompt = prompt;
        if (promptCompletion.complete === undefined) throw promptBoundary;
        const text = await promptCompletion.complete(created.session);
        created.session.messages.push({
          role: "assistant",
          content: [
            { type: "text", text: text.slice(0, 7) },
            { type: "text", text: text.slice(7) },
          ],
          api: "openai-completions",
          provider: "offline-fixture",
          model: "offline-fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 0,
        });
      });
      return created;
    }),
  };
});

import { registerTool } from "../../../.pi/lib/pi-tool-registration.js";
import { ArtifactStore } from "../dist/artifact-store.js";
import { canonicalBrowserNetworkAllowlist } from "../dist/browser-policy-carrier.js";
import { Checkpointer } from "../dist/checkpointer.js";
import { validateContract, type Directive } from "../dist/contracts.js";
import { assertCurrentShippingBuild } from "../dist/build-provenance.js";
import { initializePennyState } from "../dist/state/setup.js";
import { OrchestrationEngine } from "../dist/engine.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";
import {
  PiAgentClient,
  RemoteModelOutcomeUnknownError,
  type AgentInvocation,
  type InlineExtension,
} from "../dist/model-client.js";
import type { WorkerPromptBudget } from "../dist/liveness.js";
import {
  fallbackWorkerLeaseProfile,
  LIVENESS_LEASE_REGISTRY_ID,
} from "../dist/liveness-profiles.js";
import { resolvePlaybook, type PlaybookRegistration } from "../dist/playbooks/registry.js";
import { validateContextSourceRef } from "../dist/skill-contracts/research.js";
import { WorkerExecutor } from "../dist/worker.js";
import { writeModelSelectionFixture } from "./helpers/model-selection-fixture.js";
import { unavailableMemoryReplacement } from "./helpers/unavailable-memory-replacement.js";
import { CORE_ONLY_PLAYBOOK_NAME, CORE_ONLY_REGISTRATION } from "./fixtures/core-only-playbook.js";

async function expectRemoteUnknownAtPromptBoundary(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error("expected provider-boundary failure");
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteModelOutcomeUnknownError);
    expect(error).toHaveProperty("cause", promptBoundary);
  }
}

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENTS_DIR = path.join(PROJECT_ROOT, ".pi", "agents");
const TRUST_PROFILES = ["trusted-interactive", "hardened-untrusted"] as const;
const lease = fallbackWorkerLeaseProfile("phase");
const QUICK_PROMPT_BUDGET = {
  schema_version: 3,
  preset: "quick",
  purpose: "phase",
  inactivity_lease: {
    registry_id: LIVENESS_LEASE_REGISTRY_ID,
    profile_id: lease.profile_id,
    profile_sha256: lease.profile_sha256,
    interval_ms: lease.inactivity_interval_ms,
    remaining_ms: lease.inactivity_interval_ms,
    last_progress_at_ms: 0,
    accepted_progress_signals: 0,
  },
} satisfies WorkerPromptBudget;

const ArtifactChunkSchema = Type.Object(
  {
    ok: Type.Literal(true),
    artifact_ref: Type.Object({ artifact_id: Type.String() }, { additionalProperties: true }),
    content_digest: Type.String(),
    content: Type.String(),
    truncated: Type.Boolean(),
    returned_range: Type.Object({ start: Type.Integer(), end: Type.Integer() }),
    next_range: Type.Union([
      Type.Object({ start: Type.Integer(), end: Type.Integer() }),
      Type.Null(),
    ]),
  },
  { additionalProperties: true }
);

function isInstalledArtifactWorker(value: unknown): value is {
  createArtifactReadExtension(host: {
    projectRoot: string;
    env: NodeJS.ProcessEnv;
  }): ExtensionFactory;
} {
  return (
    value !== null &&
    typeof value === "object" &&
    "createArtifactReadExtension" in value &&
    typeof value.createArtifactReadExtension === "function"
  );
}

type TrustProfile = AgentInvocation["trustProfile"];
type InvokeAgentDirective = Extract<Directive, { action: "invoke_agent" }>;

function agentNames(): string[] {
  return readdirSync(AGENTS_DIR)
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => entry.replace(/\.md$/u, ""))
    .sort();
}

/** Independent YAML oracle: do not reuse the production parser under test. */
function declaredTools(agent: string): string[] {
  const document = readFileSync(path.join(AGENTS_DIR, `${agent}.md`), "utf8");
  const frontmatter = document.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? "";
  const line = frontmatter.split(/\r?\n/u).find((candidate) => candidate.startsWith("tools:"));
  if (line === undefined) throw new Error(`agent '${agent}' declares no tools:`);
  const tools = line
    .slice("tools:".length)
    .split(",")
    .map((name) => name.trim());
  if (tools.length === 0 || tools.some((name) => name.length === 0)) {
    throw new Error(`agent '${agent}' has an empty tools: declaration`);
  }
  return tools;
}

function registration(
  agent: string,
  browserNetworkAllowlist?: readonly string[]
): PlaybookRegistration {
  const shipped = resolvePlaybook("research");
  if (shipped === undefined || shipped.worker.kind !== "catalog-agent") {
    throw new Error("research catalog registration is unavailable");
  }
  const guidance = { skill_root: ".pi/agents", resolution: "per_agent" } as const;
  const { generic_child: shippedAuthority, seal_policy: _sealPolicy, ...synthetic } = shipped;
  const { prompt_sources: _promptSources, ...syntheticWorker } = shipped.worker;
  if (shippedAuthority === undefined) {
    throw new Error("research generic-child authority is unavailable");
  }
  return {
    ...synthetic,
    contract: {
      ...shipped.contract,
      guidance,
      repair_routing: { schema_version: 1, routes: [] },
    },
    worker: {
      ...syntheticWorker,
      guidance,
      phases: new Map([
        [
          "tool-surface-verification",
          {
            agent,
            result_schema_id: "penny.test.tool-surface-summary",
            result_schema_version: 1,
            schema: Type.Record(Type.String(), Type.Unknown()),
            ...(browserNetworkAllowlist === undefined
              ? {}
              : { browser_network_allowlist: browserNetworkAllowlist }),
          },
        ],
      ]),
    },
  };
}

function contextVector() {
  const fixture: unknown = JSON.parse(
    readFileSync(
      path.join(
        PROJECT_ROOT,
        "apps",
        "orchestration",
        "tests",
        "fixtures",
        "skills",
        "research",
        "positive-vectors.json"
      ),
      "utf8"
    )
  );
  if (fixture === null || typeof fixture !== "object" || Array.isArray(fixture)) {
    throw new Error("research positive vector is not an object");
  }
  if (!("context_source_ref" in fixture)) throw new Error("research context vector is absent");
  return validateContextSourceRef(fixture.context_source_ref);
}

function directive(
  agent: string,
  trustProfile: TrustProfile,
  sequence: number
): InvokeAgentDirective {
  const runId = `tool-surface-${trustProfile}-${sequence}`;
  return {
    schema_version: 2,
    action: "invoke_agent",
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: `session-${sequence}`,
      playbook: "research",
      engine_owner: "typescript",
    },
    state_id: "tool-surface-verification",
    agent,
    attempt: 1,
    trust_profile: trustProfile,
    task: "Stop at the deterministic pre-model test boundary.",
    input_artifacts: { schema_version: 2, artifacts: [] },
    output_artifact: {
      schema_version: 2,
      run_id: runId,
      phase: "tool-surface-verification",
      branch_id: null,
      kind: "agent-output",
      operation_id: `${runId}-output`,
      version: 1,
      producer: `agent:${agent}`,
      media_type: "text/plain; charset=utf-8",
      parent_ref: null,
      upstream_refs: [],
    },
  };
}

let isolatedAgentDir: string | undefined;
beforeEach(() => {
  isolatedAgentDir = mkdtempSync(path.join(tmpdir(), "penny-matrix-agent-"));
  writeModelSelectionFixture(isolatedAgentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", isolatedAgentDir);
  promptCompletion.providerCalls = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (isolatedAgentDir !== undefined) rmSync(isolatedAgentDir, { recursive: true, force: true });
  isolatedAgentDir = undefined;
});

describe("TypeScript skill worker exact tool surfaces", () => {
  it("drives a non-Research/non-KB fixture through ordinary PiAgentClient from registration-owned surfaces", async () => {
    sessionCaptures.length = 0;
    const directory = mkdtempSync(path.join(tmpdir(), "penny-generic-pi-client-"));
    const declared = declaredTools("piper");
    const memoryNames = declared.filter((name) => name.startsWith("memory_"));
    const checkpointer = new Checkpointer(path.join(directory, "orchestration.db"));
    try {
      using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
      const engine = new OrchestrationEngine(checkpointer, {
        projectRoot: PROJECT_ROOT,
        maxSteps: 16,
        receiptAuthority: TEST_RECEIPT_AUTHORITY,
        artifactRevisions: artifacts,
        artifactStore: artifacts,
        artifactReader: artifacts,
        playbookName: CORE_ONLY_PLAYBOOK_NAME,
        playbookRegistry: new Map([[CORE_ONLY_REGISTRATION.name, CORE_ONLY_REGISTRATION]]),
      });
      const client = new PiAgentClient({
        workerExtensionReplacements: [unavailableMemoryReplacement(PROJECT_ROOT, memoryNames)],
        testOnlySessionManagerFactory: (invocation) =>
          SessionManager.inMemory(invocation.projectRoot),
      });
      const workers = new WorkerExecutor(client, artifacts, {
        projectRoot: PROJECT_ROOT,
        parallelConcurrency: 1,
        registration: CORE_ONLY_REGISTRATION,
      });
      workers.setReceiptAuthority(engine.receiptAuthority);
      workers.setLivenessController(engine.liveness);
      const pending = engine.handle({
        schema_version: 2,
        action: "start",
        identity: {
          schema_version: 2,
          run_id: "generic-pi-client-fixture",
          session_id: "generic-pi-client-fixture",
          playbook: CORE_ONLY_PLAYBOOK_NAME,
          engine_owner: "typescript",
        },
        goal: "Reach the deterministic pre-model fixture boundary.",
        constraints: {},
        project_root: PROJECT_ROOT,
        trust_profile: "hardened-untrusted",
      });

      await expectRemoteUnknownAtPromptBoundary(workers.execute(pending));
      const capture = sessionCaptures[0];
      if (capture === undefined || capture.prompt === undefined) {
        throw new Error("generic PiAgentClient prompt capture is absent");
      }
      expect(capture.requested).toEqual(declared);
      expect([...capture.active].sort()).toEqual([...declared].sort());
      const thinking = readFileSync(path.join(AGENTS_DIR, "piper.md"), "utf8").match(
        /^thinking:\s*(\S+)\s*$/mu
      )?.[1];
      expect(thinking).toBeDefined();
      expect(capture.thinkingLevel).toBe(thinking);
      expect(capture.prompt).toContain("'piper' role for a registered workflow");
      expect(capture.prompt).not.toContain("# Generic Fixture Planning");
      expect(capture.systemPrompt).toContain("# Generic Fixture Planning");
      expect(capture.systemPrompt).toContain("You are **Piper**");
      expect(capture.systemPrompt).toContain("# Penny Index");
      expect(capture.systemPrompt.indexOf("# Generic Fixture Planning")).toBeLessThan(
        capture.systemPrompt.indexOf("<agent_boundary>")
      );
      expect(capture.systemPrompt).not.toContain("# On-Demand Protocols");
      expect(capture.prompt).not.toContain(`'${CORE_ONLY_PLAYBOOK_NAME}' workflow`);
      expect(capture.prompt).not.toContain("'research' workflow");
      expect(pending).toMatchObject({ state_id: "planning", agent: "piper" });
    } finally {
      checkpointer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("carries a synthetic registered browser policy through real Pi extension loading", async () => {
    sessionCaptures.length = 0;
    const directory = mkdtempSync(path.join(tmpdir(), "penny-browser-policy-session-"));
    const agent = "echo";
    const declared = declaredTools(agent);
    const memoryNames = declared.filter((name) => name.startsWith("memory_"));
    const browserAllowlist = canonicalBrowserNetworkAllowlist(["HTTPS://Allowed.Example"]);
    const activeRegistration = registration(agent, browserAllowlist);
    try {
      using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
      const client = new PiAgentClient({
        workerExtensionReplacements: [unavailableMemoryReplacement(PROJECT_ROOT, memoryNames)],
        testOnlySessionManagerFactory: (invocation) =>
          SessionManager.inMemory(invocation.projectRoot),
      });
      const workers = new WorkerExecutor(client, artifacts, {
        projectRoot: PROJECT_ROOT,
        parallelConcurrency: 1,
        registration: activeRegistration,
      });

      await expectRemoteUnknownAtPromptBoundary(
        workers.execute(directive(agent, "hardened-untrusted", 10_001))
      );
      const capture = sessionCaptures[0];
      if (capture === undefined) throw new Error("browser policy SDK session capture is absent");
      expect(capture.requested).toEqual(declared);
      expect([...capture.active].sort()).toEqual([...declared].sort());
      expect(capture.registeredBrowserAllowlist).toEqual(["https://allowed.example:443"]);
      expect(capture.playwrightExtensionLoaded).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps exact Echo YAML equality when Quick host policy supplies low thinking", async () => {
    sessionCaptures.length = 0;
    const directory = mkdtempSync(path.join(tmpdir(), "penny-worker-thinking-tools-"));
    const agent = "echo";
    const declared = declaredTools(agent);
    const memoryNames = declared.filter((name) => name.startsWith("memory_"));
    const checkpointer = new Checkpointer(path.join(directory, "orchestration.db"));
    try {
      using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
      const engine = new OrchestrationEngine(checkpointer, {
        projectRoot: PROJECT_ROOT,
        maxSteps: 96,
        receiptAuthority: TEST_RECEIPT_AUTHORITY,
        artifactRevisions: artifacts,
        artifactStore: artifacts,
        artifactReader: artifacts,
      });
      const client = new PiAgentClient({
        workerExtensionReplacements: [unavailableMemoryReplacement(PROJECT_ROOT, memoryNames)],
        testOnlySessionManagerFactory: (invocation) =>
          SessionManager.inMemory(invocation.projectRoot),
        testOnlyThinkingLevelOverride: "low",
      });
      const workers = new WorkerExecutor(client, artifacts, {
        projectRoot: PROJECT_ROOT,
        parallelConcurrency: 1,
        registration: engine.registration,
      });
      workers.setReceiptAuthority(engine.receiptAuthority);
      workers.setLivenessController(engine.liveness);
      const pending = engine.handle({
        schema_version: 2,
        action: "start",
        identity: {
          schema_version: 2,
          run_id: "tool-surface-quick-thinking",
          session_id: "tool-surface-quick-thinking",
          playbook: "research",
          engine_owner: "typescript",
        },
        goal: "Stop at the deterministic pre-model test boundary.",
        constraints: { mode: "quick" },
        project_root: PROJECT_ROOT,
        trust_profile: "trusted-interactive",
      });

      await expectRemoteUnknownAtPromptBoundary(workers.execute(pending));

      const capture = sessionCaptures[0];
      if (capture === undefined) throw new Error("Quick SDK session capture is absent");
      expect(capture.thinkingLevel).toBe("low");
      expect(capture.requested).toEqual(declared);
      expect([...capture.active].sort()).toEqual([...declared].sort());
    } finally {
      checkpointer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("activates every catalog agent's exact YAML set under both trust profiles when memory is unavailable", async () => {
    sessionCaptures.length = 0;
    const agents = agentNames();
    const declaredByAgent = new Map(agents.map((agent) => [agent, declaredTools(agent)] as const));
    const memoryNames = [
      ...new Set([...declaredByAgent.values()].flat().filter((name) => name.startsWith("memory_"))),
    ];
    expect(memoryNames.length).toBeGreaterThan(0);

    const directory = mkdtempSync(path.join(tmpdir(), "penny-worker-tool-surface-"));
    try {
      using artifacts = new ArtifactStore(path.join(directory, "artifacts"));
      const client = new PiAgentClient({
        workerExtensionReplacements: [unavailableMemoryReplacement(PROJECT_ROOT, memoryNames)],
        testOnlySessionManagerFactory: (invocation) =>
          SessionManager.inMemory(invocation.projectRoot),
      });
      let sequence = 0;
      for (const trustProfile of TRUST_PROFILES) {
        for (const agent of agents) {
          const captureIndex = sessionCaptures.length;
          sequence += 1;
          const workers = new WorkerExecutor(client, artifacts, {
            projectRoot: PROJECT_ROOT,
            parallelConcurrency: agents.length,
            registration: registration(agent),
          });
          await expectRemoteUnknownAtPromptBoundary(
            workers.execute(directive(agent, trustProfile, sequence))
          );
          const capture = sessionCaptures[captureIndex];
          if (capture === undefined) {
            throw new Error(`missing SDK session capture for ${agent}/${trustProfile}`);
          }
          const declared = declaredByAgent.get(agent);
          if (declared === undefined) throw new Error(`missing YAML oracle for '${agent}'`);

          expect(capture.requested, `${agent}/${trustProfile} requested`).toEqual(declared);
          expect([...capture.active].sort(), `${agent}/${trustProfile} active`).toEqual(
            [...declared].sort()
          );
          expect(
            [...capture.requested].sort(),
            `${agent}/${trustProfile} requested versus active`
          ).toEqual([...capture.active].sort());
          expect(capture.active, `${agent}/${trustProfile} optional memory visibility`).toEqual(
            expect.arrayContaining(declared.filter((name) => name.startsWith("memory_")))
          );
        }
      }

      expect(sessionCaptures).toHaveLength(agents.length * TRUST_PROFILES.length);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it("reads exact artifacts and persists outputs for every catalog role in ordinary and routing-repair SDK sessions", async () => {
    sessionCaptures.length = 0;
    const agents = agentNames();
    expect(agents.length).toBeGreaterThan(0);
    const directory = mkdtempSync(path.join(tmpdir(), "penny-all-role-artifact-sdk-"));
    const env = { PENNY_STATE_ROOT: path.join(directory, "state") };
    const state = initializePennyState(PROJECT_ROOT, { env });
    const output = 'SUMMARY:{"confidence":"CERTAIN","complete":true,"artifact_text":"β🙂漢"}';
    const input = "aβ🙂漢\n".repeat(4_000);
    try {
      using artifacts = ArtifactStore.openExisting(state.paths.artifacts.root, {
        projectId: state.projectId,
      });
      const firstAgent = agents[0];
      if (firstAgent === undefined) throw new Error("catalog discovery returned no roles");
      const source = artifacts.persist({
        metadata: {
          ...directive(firstAgent, "trusted-interactive", 0).output_artifact,
          run_id: "prior-artifact-input",
          operation_id: "prior-artifact-input",
        },
        content: input,
      });
      // Same installed-helper assembly as the service: freshness first, no ambient reader/fallback.
      const installedReader: InlineExtension = {
        name: "artifact-worker-read",
        hidden: true,
        factory: async (pi) => {
          const identity = assertCurrentShippingBuild();
          if (identity === undefined) throw new Error("matrix requires a compiled shipping helper");
          const helper: unknown = await import(
            new URL("../dist/artifact-worker.js", import.meta.url).href
          );
          if (!isInstalledArtifactWorker(helper))
            throw new Error("Installed artifact reader unavailable");
          await helper.createArtifactReadExtension({ projectRoot: PROJECT_ROOT, env })(pi);
        },
      };
      const builtins = new Set([
        "read",
        "write",
        "edit",
        "bash",
        "grep",
        "find",
        "ls",
        "artifact_read",
      ]);
      const fixtureNames = [...new Set(agents.flatMap(declaredTools))].filter(
        (name) => !builtins.has(name)
      );
      const optionalProviders: InlineExtension = (pi) => {
        for (const name of fixtureNames)
          registerTool(pi, {
            name,
            label: name,
            description: "Offline registration fixture; not an executable service.",
            parameters: Type.Object({}),
            execute: async () => {
              throw new Error("unrelated fixture tool must not execute");
            },
          });
      };
      const client = new PiAgentClient({
        workerExtensions: [optionalProviders, installedReader],
        sessionRuntime: {
          settingsManager: SettingsManager.inMemory(),
          noAmbientExtensions: true,
          attach: () => () => {},
        },
        testOnlySessionManagerFactory: () => SessionManager.inMemory(PROJECT_ROOT),
      });
      let readCalls = 0;
      promptCompletion.complete = async (session) => {
        const reader = session.agent.state.tools.find((tool) => tool.name === "artifact_read");
        if (reader === undefined) throw new Error("active SDK reader is absent");
        let range: { start: number; end?: number } | undefined;
        let content = "";
        let chunks = 0;
        for (;;) {
          const result = await reader.execute(`artifact-chunk-${chunks}`, {
            artifact: source.artifact_id,
            ...(range === undefined ? {} : { range }),
          });
          const text = result.content[0];
          if (text?.type !== "text") throw new Error("artifact reader returned no JSON text");
          const candidate: unknown = JSON.parse(text.text);
          const body = validateContract(ArtifactChunkSchema, candidate, "SDK artifact chunk");
          expect(body.artifact_ref.artifact_id).toBe(source.artifact_id);
          expect(body.content_digest).toBe(source.content_digest);
          expect(body.returned_range.start).toBe(Buffer.byteLength(content, "utf8"));
          content += body.content;
          chunks += 1;
          readCalls += 1;
          if (!body.truncated) {
            expect(body.next_range).toBeNull();
            break;
          }
          if (body.next_range === null || body.next_range.start <= body.returned_range.start)
            throw new Error("continuation made no progress");
          range = body.next_range;
        }
        expect(chunks).toBeGreaterThan(1);
        expect(Buffer.from(content, "utf8")).toEqual(Buffer.from(input, "utf8"));
        return output;
      };
      let sequence = 20_000;
      for (const trustProfile of TRUST_PROFILES) {
        for (const agent of agents) {
          for (const purpose of ["phase", "routing_repair"] as const) {
            const base = directive(agent, trustProfile, ++sequence);
            const active: InvokeAgentDirective = {
              ...base,
              input_artifacts: {
                schema_version: 2,
                artifacts: [{ slot: "exact-input", ref: source }],
              },
              ...(purpose === "phase"
                ? {}
                : {
                    execution_purpose: purpose,
                    routing_repair_binding: {
                      schema_version: 1,
                      source_state_id: base.state_id,
                      source_branch_id: null,
                      source_agent: agent,
                      source_attempt: 1,
                      source_artifact_ref: source,
                      source_receipt_id: "synthetic-matrix-source-receipt",
                      source_result_sha256: source.content_digest,
                    },
                    output_artifact: { ...base.output_artifact, kind: "routing-metadata" },
                  }),
            };
            const workers = new WorkerExecutor(client, artifacts, {
              projectRoot: PROJECT_ROOT,
              parallelConcurrency: 1,
              registration: registration(agent),
            });
            workers.setReceiptAuthority(TEST_RECEIPT_AUTHORITY);
            const captureIndex = sessionCaptures.length;
            const result = (await workers.execute(active))[0];
            if (result?.output_artifact === undefined)
              throw new Error("owner returned no persisted output");
            const capture = sessionCaptures[captureIndex];
            if (capture === undefined) throw new Error(`missing ${agent}/${purpose} SDK capture`);
            const declared = declaredTools(agent);
            expect(capture.requested).toEqual(declared);
            expect([...capture.active].sort()).toEqual([...declared].sort());
            expect(capture.active).not.toContain("artifact_write");
            expect(artifacts.readById(result.output_artifact.artifact_id)).toEqual(
              Buffer.from(output)
            );
            expect(result.worker_receipt.output_digest).toBe(result.output_artifact.content_digest);
            expect(result.details).toEqual({ complete: true, artifact_text: "β🙂漢" });
          }
        }
      }
      expect(sessionCaptures).toHaveLength(agents.length * TRUST_PROFILES.length * 2);
      expect(readCalls).toBeGreaterThan(sessionCaptures.length);
      expect(promptCompletion.providerCalls).toBe(0);

      // Owner persistence is independent of filesystem-write role authority. Both faults must
      // refuse BEFORE a later successful owner capture; no failure is turned into a result ref.
      const readOnlyAgent = agents.find(
        (agent) => !declaredTools(agent).includes("write") && !declaredTools(agent).includes("edit")
      );
      if (readOnlyAgent === undefined)
        throw new Error("catalog has no non-writing role to exercise");
      const workers = new WorkerExecutor(client, artifacts, {
        projectRoot: PROJECT_ROOT,
        parallelConcurrency: 1,
        registration: registration(readOnlyAgent),
      });
      workers.setReceiptAuthority(TEST_RECEIPT_AUTHORITY);
      const persist = vi.spyOn(artifacts, "persist").mockImplementationOnce(() => {
        throw new Error("synthetic output persistence corruption");
      });
      await expect(
        workers.execute(directive(readOnlyAgent, "trusted-interactive", ++sequence))
      ).rejects.toThrow(/synthetic output persistence corruption/u);
      persist.mockRestore();
      const originalPersist = artifacts.persist.bind(artifacts);
      let damagedObject: string | undefined;
      const corrupt = vi.spyOn(artifacts, "persist").mockImplementationOnce((request) => {
        const ref = originalPersist(request);
        damagedObject = path.join(
          state.paths.artifacts.root,
          "objects",
          "sha256",
          ref.content_digest.slice(0, 2),
          ref.content_digest.slice(2)
        );
        writeFileSync(damagedObject, "corrupt fixture bytes");
        return ref;
      });
      await expect(
        workers.execute(directive(readOnlyAgent, "trusted-interactive", ++sequence))
      ).rejects.toThrow(/failed exact-byte verification/u);
      corrupt.mockRestore();
      if (damagedObject === undefined)
        throw new Error("readback corruption fixture did not execute");
      writeFileSync(damagedObject, output); // Restore only this synthetic test object to its exact bytes.
      const success = (
        await workers.execute(directive(readOnlyAgent, "trusted-interactive", ++sequence))
      )[0];
      if (success?.output_artifact === undefined)
        throw new Error("owner success after faults is absent");
      expect(artifacts.readById(success.output_artifact.artifact_id).toString("utf8")).toBe(output);
      expect(promptCompletion.providerCalls).toBe(0);
    } finally {
      promptCompletion.complete = undefined;
      vi.restoreAllMocks();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it("keeps exact Echo YAML equality for document-only, approved-KB-only, and combined overlays", async () => {
    sessionCaptures.length = 0;
    const agent = "echo";
    const declared = declaredTools(agent);
    const memoryNames = declared.filter((name) => name.startsWith("memory_"));
    const client = new PiAgentClient({
      workerExtensionReplacements: [unavailableMemoryReplacement(PROJECT_ROOT, memoryNames)],
      testOnlySessionManagerFactory: (invocation) =>
        SessionManager.inMemory(invocation.projectRoot),
    });
    const shipped = registration(agent);
    const document = contextVector();
    const approvedKb = validateContextSourceRef({
      ...document,
      source_kind: "approved_kb_result",
      source_id: "approved-kb-vector",
      role: "advisory",
      revision: {
        kind: "approved_kb",
        kb_profile_id: "kb-profile-vector",
        result_id: "kb-result-vector",
        approval_id: "kb-approval-vector",
        approval_sha256: "c".repeat(64),
      },
      upstream_locators: [{ source_id: "approved-kb-vector", locator: "kb-result:vector" }],
      verification_disposition: "advisory_only",
    });
    const modes = [
      [{ source: document, content: "document content" }],
      [{ source: approvedKb, content: "approved KB content" }],
      [
        { source: document, content: "document content" },
        { source: approvedKb, content: "approved KB content" },
      ],
    ] as const;
    for (const trustProfile of TRUST_PROFILES) {
      for (const overlays of modes) {
        const captureIndex = sessionCaptures.length;
        await expectRemoteUnknownAtPromptBoundary(
          client.runAgent({
            agent,
            stateId: "researching",
            task: "Stop at the deterministic pre-model test boundary.",
            projectRoot: PROJECT_ROOT,
            trustProfile,
            inputArtifacts: [],
            contextOverlays: overlays,
            livenessBudget: QUICK_PROMPT_BUDGET,
            registration: {
              playbook_name: shipped.name,
              workflow_name: shipped.worker.workflow_name,
              guidance: shipped.worker.guidance,
              result_transport: shipped.worker.result_transport,
              opening_policy: shipped.worker.opening_policy,
              model_policy: shipped.worker.model_policy,
            },
          })
        );
        const capture = sessionCaptures[captureIndex];
        if (capture === undefined) throw new Error("context-mode SDK capture is absent");
        expect(capture.requested).toEqual(declared);
        expect([...capture.active].sort()).toEqual([...declared].sort());
        if (capture.prompt === undefined) throw new Error("Echo opening prompt was not captured");
        expect(capture.prompt).toContain("HOST-ENFORCED RENEWABLE INACTIVITY LEASE:");
        expect(capture.prompt).not.toContain("HOST-ENFORCED LEGACY V1 LIVENESS BUDGET:");
        expect(capture.prompt.indexOf("HOST-ENFORCED RENEWABLE INACTIVITY LEASE:")).toBeLessThan(
          capture.prompt.indexOf("TASK:")
        );
        expect(capture.prompt).toContain("Total elapsed work is not a liveness budget");
      }
    }
    expect(sessionCaptures).toHaveLength(TRUST_PROFILES.length * modes.length);
  }, 120_000);
});
