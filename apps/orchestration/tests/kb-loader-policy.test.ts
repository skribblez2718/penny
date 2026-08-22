/** Hostile ambient-resource and exact private-session posture tests (§5.8). */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  SessionManager,
  createAgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_SESSION_PROTOCOL_ERROR_CODES,
  contentFreeSessionProtocolErrorRecord,
  contentFreeSessionTraceRecord,
  createPrivateSessionResourceLoader,
  type AgentSessionSpecV1,
} from "../src/model-client.js";
import { sha256Hex, type ArtifactKind } from "../src/kb/contracts.js";
import {
  KB_PHASE_TOOL_MATRIX,
  kbSessionSpec,
  type KbPhaseInvocation,
  type KbPhaseState,
} from "../src/kb/session-tools.js";
import type { ArtifactHandle, StageRunArtifactInput } from "../src/kb/run-artifacts.js";

const roots: string[] = [];
function temporary(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `${label}-`));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CONTRACT: Readonly<Record<KbPhaseState, { agent: string; artifactKind: ArtifactKind }>> = {
  ingest: { agent: "echo", artifactKind: "claims" },
  compose: { agent: "synthia", artifactKind: "page_draft" },
  query: { agent: "synthia", artifactKind: "query_answer" },
  lint: { agent: "carren", artifactKind: "lint_report" },
  verify: { agent: "vera", artifactKind: "verification_report" },
  plan: { agent: "piper", artifactKind: "promotion_plan" },
  patch: { agent: "skribble", artifactKind: "promotion_patch" },
};

function handle(kind: ArtifactKind): ArtifactHandle {
  return {
    schema_version: 1,
    artifact_id: "art_1234567890abcdef1234567890abcdef",
    artifact_kind: kind,
    sha256: sha256Hex("{}"),
    media_type: "application/json",
    byte_length: 2,
  };
}

function invocation(state: KbPhaseState): KbPhaseInvocation {
  const contract = CONTRACT[state];
  const brief =
    state === "query"
      ? {
          action: "query",
          query: "synthetic query",
          page_ids: [],
          source_ids: [],
          max_candidates: 20,
          verify_grounding: true,
        }
      : state === "plan" || state === "patch"
        ? {
            action: "promote",
            page_revisions: [{ page_id: "page_loader", revision_id: "rev_loader" }],
            target_capability_ids: ["target_loader"],
          }
        : { action: "ingest", source_ids: [] };
  return {
    agent: contract.agent,
    stateId: state,
    runId: `run_${state}`,
    profileId: "kbp_loader",
    expectedArtifactKind: contract.artifactKind,
    phaseBrief: "body-free task",
    readPhaseBrief: () =>
      JSON.stringify({
        schema_version: 1,
        run_id: `run_${state}`,
        state_id: state,
        brief,
        allowed_prior_artifacts: [],
        allowed_selected_pages: [],
      }),
    sourceAllowlist: [],
    priorPhaseAllowlist: [],
    allowedPriorArtifacts: [],
    readSource: () => {
      throw new Error("not allowed");
    },
    readRunArtifact: () => {
      throw new Error("not allowed");
    },
    searchSelectedKb: () =>
      JSON.stringify({ schema_version: 1, generation_id: "generation_loader", candidates: [] }),
    readSelectedPage: () => JSON.stringify({ schema_version: 1 }),
    readCanonicalTarget: () => JSON.stringify({ schema_version: 1 }),
    stageArtifact: (_input: StageRunArtifactInput) => handle(contract.artifactKind),
    submitPhaseResult: (result) => JSON.stringify(result),
  };
}

function spec(state: KbPhaseState): AgentSessionSpecV1 {
  return kbSessionSpec({
    invocation: invocation(state),
    cognitiveFrame: "TRUSTED_COGNITIVE_FRAME",
    agentBody: `TRUSTED_ROLE_${state}`,
    phaseGuidance: `TRUSTED_GUIDANCE_${state}`,
  });
}

describe("KB §5.8 purpose-built session", () => {
  it("uses noTools=all and the exact per-phase custom-tool matrix", () => {
    for (const state of Object.keys(CONTRACT) as KbPhaseState[]) {
      const posture = spec(state);
      expect(posture.noTools).toBe("all");
      expect(posture.tools).toEqual(KB_PHASE_TOOL_MATRIX[state]);
      expect(posture.customTools?.map((tool) => tool.name)).toEqual(KB_PHASE_TOOL_MATRIX[state]);
      expect(new Set(posture.tools).size).toBe(posture.tools?.length);
    }
  });

  it("keeps provider-visible tool guidance explicit while every schema stays closed", () => {
    for (const state of Object.keys(CONTRACT) as KbPhaseState[]) {
      const tools = spec(state).customTools as ToolDefinition[];
      for (const tool of tools) {
        expect(tool.promptSnippet).toBeTruthy();
        expect(tool.promptGuidelines?.length).toBeGreaterThan(0);
        expect(tool.description.length).toBeGreaterThan(40);
        if (
          tool.name !== "read_phase_brief" &&
          (tool.name.startsWith("read_") || tool.name === "search_selected_kb")
        ) {
          expect(tool.description).toContain("read_phase_brief");
        }
        const parameters = tool.parameters as {
          additionalProperties?: boolean;
          properties?: Record<string, unknown>;
          required?: string[];
        };
        expect(parameters.additionalProperties).toBe(false);
        if (tool.name.startsWith("read_") || tool.name === "search_selected_kb") {
          expect(parameters.properties).toHaveProperty("schema_version");
          expect(parameters.required).toContain("schema_version");
        }
      }
      const stage = tools.find((tool) => tool.name === "stage_run_artifact");
      const submit = tools.find((tool) => tool.name === "submit_phase_result");
      expect(stage?.description).toContain("complete artifact object exactly");
      expect(submit?.description).toContain("only successful phase termination");
      expect(submit?.description).toContain("never reconstruct it or use placeholders");
    }
  });

  it("projects raw Pi events onto content-free turn/tool trace records", () => {
    const privateSentinel = "PRIVATE_EVENT_BODY_MUST_NOT_ESCAPE";
    const allowedTools = new Set(["read_phase_brief"]);
    const toolRecord = contentFreeSessionTraceRecord(
      {
        type: "tool_execution_end",
        toolCallId: `call_${privateSentinel}`,
        toolName: "read_phase_brief",
        result: { content: privateSentinel, args: { private: privateSentinel } },
        isError: true,
      } as AgentSessionEvent,
      allowedTools
    );
    const unknownToolRecord = contentFreeSessionTraceRecord(
      {
        type: "tool_execution_end",
        toolCallId: "call_unknown",
        toolName: privateSentinel,
        result: {},
        isError: true,
      } as AgentSessionEvent,
      allowedTools
    );
    const turnRecord = contentFreeSessionTraceRecord({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: privateSentinel }],
        api: "openai-completions",
        provider: "test",
        model: "test",
        usage: {
          input: 11,
          output: 13,
          cacheRead: 2,
          cacheWrite: 3,
          reasoning: 5,
          totalTokens: 29,
          cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
        },
        stopReason: "toolUse",
        timestamp: 1,
      },
      toolResults: [{ content: privateSentinel }],
    } as unknown as AgentSessionEvent);

    expect(toolRecord).toEqual({
      kind: "tool",
      name: "read_phase_brief",
      outcome: "error",
    });
    expect(unknownToolRecord).toEqual({
      kind: "tool",
      name: "unknown_tool",
      outcome: "error",
      error_code: "unknown_tool",
    });
    expect(turnRecord).toEqual({
      kind: "turn",
      name: "turn",
      outcome: "success",
      stop_reason: "toolUse",
      token_counts: {
        input: 11,
        output: 13,
        cache_read: 2,
        cache_write: 3,
        total: 29,
      },
    });
    const protocolRecords = [
      contentFreeSessionProtocolErrorRecord(new Error("submit_phase_result_schema_invalid")),
      contentFreeSessionProtocolErrorRecord(new Error("artifact_handle_mismatch")),
      contentFreeSessionProtocolErrorRecord(new Error("read_phase_brief_first")),
      contentFreeSessionProtocolErrorRecord(new Error("unknown tool call")),
      contentFreeSessionProtocolErrorRecord(new Error("worker timed out after 300000ms")),
    ];
    expect(protocolRecords).toEqual(
      AGENT_SESSION_PROTOCOL_ERROR_CODES.map((error_code) => ({
        kind: "protocol_error",
        error_code,
      }))
    );
    expect(contentFreeSessionProtocolErrorRecord(new Error(privateSentinel))).toBeUndefined();

    const serialized = JSON.stringify([
      toolRecord,
      unknownToolRecord,
      turnRecord,
      ...protocolRecords,
    ]);
    expect(serialized).not.toContain(privateSentinel);
    expect(serialized).not.toContain("reasoning");
    expect(serialized).not.toContain("toolCallId");
    expect(serialized).not.toContain("content");
    expect(serialized).not.toContain("params");
    expect([...serialized.matchAll(/"error_code":"([^"]+)"/gu)].map((match) => match[1])).toEqual(
      expect.arrayContaining([...AGENT_SESSION_PROTOCOL_ERROR_CODES])
    );
  });

  it("excludes hostile project/global extensions, settings, skills, prompts, and AGENTS", async () => {
    const projectRoot = temporary("penny-kb-hostile-project");
    const agentDir = temporary("penny-kb-hostile-global");
    const sentinel = "HOSTILE_AMBIENT_SENTINEL";

    const files = [
      [path.join(projectRoot, "AGENTS.md"), sentinel],
      [path.join(projectRoot, ".pi", "settings.json"), JSON.stringify({ systemPrompt: sentinel })],
      [path.join(projectRoot, ".pi", "prompts", "evil.md"), sentinel],
      [
        path.join(projectRoot, ".pi", "skills", "evil", "SKILL.md"),
        `---\nname: evil\ndescription: ${sentinel}\n---`,
      ],
      [
        path.join(projectRoot, ".pi", "extensions", "evil", "index.ts"),
        `throw new Error("${sentinel}")`,
      ],
      [path.join(agentDir, "SYSTEM.md"), sentinel],
      [path.join(agentDir, "settings.json"), JSON.stringify({ systemPrompt: sentinel })],
      [path.join(agentDir, "prompts", "evil.md"), sentinel],
      [
        path.join(agentDir, "skills", "evil", "SKILL.md"),
        `---\nname: evil\ndescription: ${sentinel}\n---`,
      ],
      [path.join(agentDir, "extensions", "evil", "index.ts"), `throw new Error("${sentinel}")`],
    ] as const;
    for (const [file, content] of files) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }

    const exactSystem = "TRUSTED_COGNITIVE_FRAME\n\nTRUSTED_ROLE\n\nTRUSTED_GUIDANCE";
    const isolated = await createPrivateSessionResourceLoader({
      projectRoot,
      agentDir,
      systemPrompt: exactSystem,
    });
    expect(isolated.resourceLoader.getExtensions().extensions).toEqual([]);
    expect(isolated.resourceLoader.getExtensions().errors).toEqual([]);
    expect(isolated.resourceLoader.getSkills().skills).toEqual([]);
    expect(isolated.resourceLoader.getPrompts().prompts).toEqual([]);
    expect(isolated.resourceLoader.getThemes().themes).toEqual([]);
    expect(isolated.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(isolated.resourceLoader.getAppendSystemPrompt()).toEqual([]);
    expect(isolated.resourceLoader.getSystemPrompt()).toBe(exactSystem);
    expect(isolated.resourceLoader.getSystemPrompt()).not.toContain(sentinel);
  });

  it("activates only the explicit custom tools under the real SDK filter", async () => {
    const projectRoot = temporary("penny-kb-sdk-tools");
    const posture = spec("query");
    const isolated = await createPrivateSessionResourceLoader({
      projectRoot,
      agentDir: temporary("penny-kb-sdk-global"),
      systemPrompt: posture.isolatedSystemPrompt!,
    });
    const { session } = await createAgentSession({
      cwd: projectRoot,
      sessionManager: SessionManager.inMemory(projectRoot),
      settingsManager: isolated.settingsManager,
      resourceLoader: isolated.resourceLoader,
      noTools: "all",
      tools: [...posture.tools!],
      customTools: posture.customTools as ToolDefinition[],
    });
    try {
      expect(session.getActiveToolNames()).toEqual([...KB_PHASE_TOOL_MATRIX.query]);
      expect(session.getActiveToolNames()).not.toContain("read");
      expect(session.getActiveToolNames()).not.toContain("bash");
      expect(session.getActiveToolNames()).not.toContain("web_search");
      expect(session.getActiveToolNames()).not.toContain("memory_smart_search");
    } finally {
      session.dispose();
    }
  });

  it("terminates on one typed submit and rejects duplicate/body-bearing metadata", async () => {
    const posture = spec("query");
    const stage = posture.customTools?.find((tool) => tool.name === "stage_run_artifact") as
      | ToolDefinition
      | undefined;
    const submit = posture.customTools?.find((tool) => tool.name === "submit_phase_result") as
      | ToolDefinition
      | undefined;
    expect(stage).toBeDefined();
    expect(submit).toBeDefined();

    const artifact = handle("query_answer");
    await stage!.execute(
      "stage-1",
      {
        schema_version: 1,
        artifact_kind: "query_answer",
        media_type: "application/json",
        encoding: "utf8",
        content: JSON.stringify({
          schema_version: 1,
          artifact_kind: "query_answer",
          answer: {
            authority: "advisory",
            text: "Answer",
            citations: [],
            contradictions: [],
            unknowns: ["no_support"],
            canonical_verification_required: true,
          },
        }),
      },
      undefined,
      undefined,
      {} as never
    );
    const metadata = {
      schema_version: 1,
      run_id: "run_query",
      state_id: "query",
      agent: "synthia",
      result_kind: "query_synthesis",
      verdict: "not_met",
      confidence: "CERTAIN",
      evidence: [],
      warnings: [],
      unresolved: ["no_support"],
      page_ids: [],
      citation_count: 0,
      answer_artifact: artifact,
    };
    const accepted = await submit!.execute("submit-1", metadata, undefined, undefined, {} as never);
    expect((accepted as { terminate?: boolean }).terminate).toBe(true);
    await expect(
      submit!.execute("submit-2", metadata, undefined, undefined, {} as never)
    ).rejects.toThrow(/duplicate/);

    const fresh = spec("query");
    const freshSubmit = fresh.customTools?.find(
      (tool) => tool.name === "submit_phase_result"
    ) as ToolDefinition;
    await expect(
      freshSubmit.execute(
        "submit-body",
        { ...metadata, body: "PRIVATE RAW BODY" },
        undefined,
        undefined,
        {} as never
      )
    ).rejects.toThrow(/schema/);
  });
});
