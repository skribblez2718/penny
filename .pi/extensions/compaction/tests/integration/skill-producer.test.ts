/** Real public skill waits survive the compaction hook without result adapters. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { OrchestrationService, initializePennyState, type ModelClient } from "@penny/orchestration";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestExtensionApi } from "../../../../lib/tests/pi-test-host.js";
import { isRecord, requireDefined } from "../../../../lib/tests/test-narrowers.js";
import { parseCurrentSkillResult, type SkillResult } from "@penny/orchestration";
import skillExtension from "../../../skill/index.js";
import compactionExtension from "../../index.js";
import { createMockCompactionPi } from "../fixtures/compaction-pi.js";

const cognition: ModelClient = {
  async runAgent(invocation) {
    if (invocation.stateId !== "planning") {
      throw new Error(`Unexpected clarification fixture phase: ${invocation.stateId}`);
    }
    return {
      text: 'Scope is unresolved.\nSUMMARY:{"confidence":"CERTAIN","plan_complete":false,"plan_steps":[],"needs_clarification":true,"clarifying_questions":["Which source scope?"]}',
    };
  },
};
vi.mock("@penny/orchestration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@penny/orchestration")>();
  return {
    ...actual,
    OrchestrationService: class extends actual.OrchestrationService {
      constructor(options: ConstructorParameters<typeof actual.OrchestrationService>[0]) {
        super({ ...options, modelClient: cognition });
      }
    },
  };
});
// No provider or telemetry connection participates in this offline integration.
vi.mock("../../summarizer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../summarizer.js")>()),
  generateModelSummary: vi.fn(async () => null),
}));
interface SkillTool {
  name: "skill";
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: undefined,
    update: undefined,
    context: unknown
  ): Promise<{ details: SkillResult }>;
}
function isSkillTool(value: unknown): value is SkillTool {
  return isRecord(value) && value.name === "skill" && typeof value.execute === "function";
}
const envKeys = [
  "PROJECT_ROOT",
  "PENNY_STATE_ROOT",
  "PENNY_SKILLS_DIR",
  "PI_OBSERVABILITY_ENABLED",
];
const original = new Map(envKeys.map((key) => [key, process.env[key]]));
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("skill producer / compaction current boundary", () => {
  it.each(["single", "parallel", "chain"] as const)(
    "preserves an actual public %s clarification in the resume appendix",
    async (mode) => {
      const root = mkdtempSync(path.join(tmpdir(), "penny-compaction-producer-"));
      roots.push(root);
      const projectRoot = path.join(root, "project");
      mkdirSync(projectRoot, { mode: 0o700 });
      process.env.PROJECT_ROOT = projectRoot;
      process.env.PENNY_STATE_ROOT = path.join(root, "state");
      process.env.PENNY_SKILLS_DIR = path.resolve(import.meta.dirname, "../../../../skills");
      process.env.PI_OBSERVABILITY_ENABLED = "false";
      initializePennyState(projectRoot, { env: process.env });
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
      );
      let registered: SkillTool | undefined;
      skillExtension(
        createTestExtensionApi({
          onRegisterTool(value) {
            if (isSkillTool(value)) registered = value;
          },
        })
      );
      const step = {
        skill_name: "research",
        session_id: "exact-step-run",
        goal: "Clarify the source scope",
        // Quick starts at Echo, not Piper; this fixture supplies Piper's exact
        // planning clarification contract and must enter that registered phase.
        constraints: { mode: "standard" },
      };
      const params =
        mode === "single" ? step : mode === "parallel" ? { skills: [step] } : { chain: [step] };
      const result = await requireDefined(registered, "public skill tool missing").execute(
        "skill-call",
        params,
        undefined,
        undefined,
        {
          cwd: projectRoot,
          isProjectTrusted: () => true,
          ui: { theme: { fg: (_color: string, text: string) => text }, notify() {} },
        }
      );
      expect(parseCurrentSkillResult(result.details)).toEqual(result.details);
      using owner = new OrchestrationService({
        projectRoot,
        env: process.env,
        playbookName: "research",
      });
      const gate = owner.checkpointer.loadRunById("exact-step-run")?.pendingDirective;
      if (gate?.action !== "await_user") throw new Error("durable engine wait missing");
      const wait = mode === "parallel" ? result.details.parallel_results?.[0] : result.details;
      expect(wait?.continuation).toEqual({
        kind: "clarification",
        identity: gate.identity,
        gate_id: gate.gate_id,
        challenge: gate.challenge,
        resume_invocation: step,
      });
      const pi = createMockCompactionPi();
      compactionExtension(pi.api);
      const compacted = await pi.emitRequired(
        {
          preparation: {
            firstKeptEntryId: "kept",
            tokensBefore: 15_000,
            fileOps: { read: new Set(), written: new Set(), edited: new Set() },
            previousSummary: undefined,
            messagesToSummarize: [
              { role: "user", content: "Continue the exact paused skill." },
              {
                role: "assistant",
                content: [{ type: "toolCall", id: "skill-call", name: "skill", arguments: params }],
              },
              {
                role: "toolResult",
                toolName: "skill",
                toolCallId: "skill-call",
                content: "Clarification",
                details: result.details,
              },
            ],
            turnPrefixMessages: [],
          },
          branchEntries: [{ type: "session", sessionId: "parent-session" }],
          reason: "threshold",
          signal: new AbortController().signal,
        },
        {
          cwd: projectRoot,
          modelRegistry: {
            find: () => undefined,
            getApiKeyAndHeaders: async () => ({ ok: false }),
          },
        }
      );
      expect(compacted.compaction.summary).toContain("run:exact-step-run");
      if (mode !== "single")
        expect(compacted.compaction.summary).not.toContain(`run:${result.details.session_id}`);
      expect(compacted.compaction.summary).not.toContain("run:parent-session");
    }
  );
});
