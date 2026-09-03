/** Real-SDK tool-surface coverage for the TypeScript skill worker path. */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

interface SessionCapture {
  readonly requested: readonly string[];
  readonly active: readonly string[];
  readonly thinkingLevel: unknown;
  prompt?: string;
}

const { sessionCaptures, promptBoundary } = vi.hoisted(() => ({
  sessionCaptures: [] as SessionCapture[],
  promptBoundary: new Error("deterministic session boundary before model invocation"),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: vi.fn(async (...args: Parameters<typeof actual.createAgentSession>) => {
      const created = await actual.createAgentSession(...args);
      const requested = [...(args[0]?.tools ?? [])];
      const capture: SessionCapture = {
        requested,
        active: [...created.session.getActiveToolNames()],
        thinkingLevel: args[0]?.thinkingLevel,
      };
      sessionCaptures.push(capture);
      vi.spyOn(created.session, "prompt").mockImplementation(async (prompt) => {
        capture.prompt = prompt;
        throw promptBoundary;
      });
      return created;
    }),
  };
});

import { registerTool } from "../../../.pi/lib/pi-tool-registration.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { canonicalJson, Checkpointer } from "../src/checkpointer.js";
import type { Directive } from "../src/contracts.js";
import { OrchestrationEngine } from "../src/engine.js";
import { TEST_RECEIPT_AUTHORITY } from "./fixtures/test-receipt-authority.js";
import { PiAgentClient, type AgentInvocation, type InlineExtension } from "../src/model-client.js";
import type { WorkerPromptBudgetV1 } from "../src/liveness.js";
import { resolvePlaybook, type PlaybookRegistrationV1 } from "../src/playbooks/registry.js";
import { validateContextSourceRef } from "../src/skill-contracts/research.js";
import { buildRoutingRepairGuidance, WorkerExecutor } from "../src/worker.js";
import { CORE_ONLY_PLAYBOOK_NAME, CORE_ONLY_REGISTRATION } from "./fixtures/core-only-playbook.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENTS_DIR = path.join(PROJECT_ROOT, ".pi", "agents");
const TRUST_PROFILES = ["trusted-interactive", "hardened-untrusted"] as const;
const QUICK_PROMPT_BUDGET = {
  schema_version: 1,
  preset: "quick",
  purpose: "phase",
  model_turns: { worker_remaining: 16, run_remaining: 48, effective_remaining: 16 },
  tool_calls: { worker_remaining: 20, run_remaining: 64, effective_remaining: 20 },
  external_requests: { worker_remaining: 8, run_remaining: 12, effective_remaining: 8 },
} satisfies WorkerPromptBudgetV1;

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

function independentlyExternallyCharged(toolName: string): boolean {
  return (
    toolName === "web_search" ||
    toolName === "web_fetch" ||
    toolName === "youtube_transcript" ||
    toolName === "bash" ||
    toolName.startsWith("playwright_")
  );
}

function unavailableMemoryExtension(names: readonly string[]): InlineExtension {
  return (pi) => {
    for (const name of names) {
      registerTool(pi, {
        name,
        label: name,
        description: "Typed unavailable optional-service test provider",
        parameters: Type.Object({}, { additionalProperties: true }),
        async execute() {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: false,
                  error: { code: "MEMPALACE_UNAVAILABLE", retryable: true },
                }),
              },
            ],
            details: {},
          };
        },
      });
    }
  };
}

function registration(agent: string): PlaybookRegistrationV1 {
  const shipped = resolvePlaybook("research");
  if (shipped === undefined || shipped.worker.kind !== "catalog-agent") {
    throw new Error("research catalog registration is unavailable");
  }
  const guidance = { skill_root: ".pi/agents", resolution: "per_agent" } as const;
  return {
    ...shipped,
    contract: {
      ...shipped.contract,
      guidance,
      repair_routing: { schema_version: 1, routes: [] },
    },
    worker: {
      ...shipped.worker,
      guidance,
      phases: new Map([
        [
          "tool-surface-verification",
          {
            agent,
            result_schema_id: "penny.test.tool-surface-summary",
            result_schema_version: 1,
            schema: Type.Record(Type.String(), Type.Unknown()),
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
        workerExtensions: [unavailableMemoryExtension(memoryNames)],
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

      await expect(workers.execute(pending)).rejects.toBe(promptBoundary);
      const capture = sessionCaptures[0];
      if (capture === undefined || capture.prompt === undefined) {
        throw new Error("generic PiAgentClient prompt capture is absent");
      }
      expect(capture.requested).toEqual(declared);
      expect([...capture.active].sort()).toEqual([...declared].sort());
      expect(capture.thinkingLevel).toBeUndefined();
      expect(capture.prompt).toContain("'piper' role for a registered workflow");
      expect(capture.prompt).toContain("# Generic Fixture Planning");
      expect(capture.prompt).not.toContain(`'${CORE_ONLY_PLAYBOOK_NAME}' workflow`);
      expect(capture.prompt).not.toContain("'research' workflow");
      expect(pending).toMatchObject({ state_id: "planning", agent: "piper" });
    } finally {
      checkpointer.close();
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
        workerExtensions: [unavailableMemoryExtension(memoryNames)],
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

      await expect(workers.execute(pending)).rejects.toBe(promptBoundary);

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
        workerExtensions: [unavailableMemoryExtension(memoryNames)],
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
          await expect(workers.execute(directive(agent, trustProfile, sequence))).rejects.toBe(
            promptBoundary
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

  it("keeps exact Skribble YAML equality while routing guidance is summary-only", async () => {
    sessionCaptures.length = 0;
    const agent = "skribble";
    const declared = declaredTools(agent);
    const memoryNames = declared.filter((name) => name.startsWith("memory_"));
    const client = new PiAgentClient({
      workerExtensions: [unavailableMemoryExtension(memoryNames)],
      testOnlySessionManagerFactory: (invocation) =>
        SessionManager.inMemory(invocation.projectRoot),
    });
    const activeRegistration = registration(agent);
    await expect(
      client.runAgent({
        agent,
        stateId: "tool-surface-verification",
        task: "Repair routing metadata only.",
        projectRoot: PROJECT_ROOT,
        trustProfile: "trusted-interactive",
        inputArtifacts: [],
        executionPurpose: "routing_repair",
        routingRepairGuidance: buildRoutingRepairGuidance(
          activeRegistration,
          "tool-surface-verification"
        ),
        workflowSession: {
          run_id: "tool-surface-repair",
          workflow_session_id: "tool-surface-repair",
          branch_id: null,
          attempt: 2,
          worker_id: "worker-tool-surface-repair",
          purpose: "routing_repair",
        },
        registration: {
          playbook_name: activeRegistration.name,
          workflow_name: activeRegistration.worker.workflow_name,
          guidance: activeRegistration.worker.guidance,
          result_transport: activeRegistration.worker.result_transport,
          opening_policy: activeRegistration.worker.opening_policy,
          model_policy: activeRegistration.worker.model_policy,
        },
      })
    ).rejects.toBe(promptBoundary);
    const capture = sessionCaptures[0];
    if (capture === undefined) throw new Error("routing-repair SDK session capture is absent");
    expect(capture.requested).toEqual(declared);
    expect([...capture.active].sort()).toEqual([...declared].sort());
  });

  it("keeps exact Echo YAML equality for document-only, approved-KB-only, and combined overlays", async () => {
    sessionCaptures.length = 0;
    const agent = "echo";
    const declared = declaredTools(agent);
    const memoryNames = declared.filter((name) => name.startsWith("memory_"));
    const client = new PiAgentClient({
      workerExtensions: [unavailableMemoryExtension(memoryNames)],
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
        await expect(
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
        ).rejects.toBe(promptBoundary);
        const capture = sessionCaptures[captureIndex];
        if (capture === undefined) throw new Error("context-mode SDK capture is absent");
        expect(capture.requested).toEqual(declared);
        expect([...capture.active].sort()).toEqual([...declared].sort());
        if (capture.prompt === undefined) throw new Error("Echo opening prompt was not captured");
        expect(capture.prompt).toContain("HOST-ENFORCED LIVENESS BUDGET:");
        expect(capture.prompt).toContain(canonicalJson(QUICK_PROMPT_BUDGET));
        expect(capture.prompt).toContain(
          JSON.stringify(declared.filter(independentlyExternallyCharged).sort())
        );
        expect(capture.prompt.indexOf("HOST-ENFORCED LIVENESS BUDGET:")).toBeLessThan(
          capture.prompt.indexOf("TASK:")
        );
        expect(capture.prompt).toContain("Every requested tool call—including each");
      }
    }
    expect(sessionCaptures).toHaveLength(TRUST_PROFILES.length * modes.length);
  }, 120_000);
});
