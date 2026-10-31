import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { AgentInvocation, JsonValue, PiAgentClientOptions } from "@penny/orchestration";
import { canonicalJson, sha256 } from "../../../../../apps/orchestration/dist/canonical-json.js";
import {
  executionState,
  slot,
} from "../../../../../apps/orchestration/dist/videogen/execution-state.js";
import { validateGatePacket } from "../../../../../apps/orchestration/dist/videogen/gates.js";
import { VIDEOGEN_RUNTIME_MANIFEST_ENV } from "../../../../../apps/orchestration/dist/videogen/runtime-manifest.js";
import {
  ManifestVideogenFixture,
  minimalVideogenManifest,
} from "../../../../../apps/orchestration/tests/helpers/videogen-manifest-fixture.js";
import { setup } from "../../../../../apps/orchestration/tests/helpers/videogen-executor-fixture.js";
import { FOUNDATION_LIMITS } from "../../../../../apps/orchestration/tests/helpers/videogen-foundation-fixtures.js";
import { videogenStageRequest } from "../../../../../apps/orchestration/tests/helpers/videogen-stage-fixtures.js";
import {
  isRecord,
  parseJson,
  requireRecord,
  requireString,
} from "../../../../lib/tests/test-narrowers.js";
import type { ArtifactReadParams } from "../../../artifacts/types.js";

const invocations = new AsyncLocalStorage<AgentInvocation>();
const captures: {
  state: string;
  agent: string;
  requested: readonly string[];
  active: readonly string[];
  reads: string[];
}[] = [];
let reply: ReturnType<typeof setup>["client"] | undefined;
const fixtureModel: Awaited<ReturnType<NonNullable<PiAgentClientOptions["resolveModel"]>>> = {
  id: "videogen-offline-fixture",
  name: "Offline video fixture",
  provider: "ollama",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 8192,
};
const telemetry = vi.hoisted(() => new Array<string>());
// Observability flags disable service startup, not the shared logger's REST transport.
// Keep real structured logging, but capture it locally before import-time loggers exist.
// Session-ID overwrite telemetry remains isolated across disposable parents as before.
vi.mock("../../../../lib/logger/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/logger/logger.js")>();
  return {
    ...actual,
    createLogger: (...args: Parameters<typeof actual.createLogger>) =>
      actual.createLogger(args[0], args[1] ?? ((entry) => telemetry.push(entry))),
    setSessionId: () => {},
  };
});
// Keep real service/engine/client/tool admission. Replace model lookup and final provider text only.
vi.mock("../../../../../apps/orchestration/dist/model-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../../apps/orchestration/dist/model-client.js")>();
  return {
    ...actual,
    PiAgentClient: class extends actual.PiAgentClient {
      constructor(options: PiAgentClientOptions = {}) {
        super({ ...options, resolveModel: () => fixtureModel });
      }
      override runAgent(invocation: AgentInvocation) {
        return invocations.run(invocation, () => super.runAgent(invocation));
      }
    },
  };
});
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: async (...args: Parameters<typeof actual.createAgentSession>) => {
      const created = await actual.createAgentSession(...args);
      const invocation = invocations.getStore();
      // Only worker cognition is replaced. Parent AgentSession.prompt and its tool loop stay real.
      if (invocation === undefined) return created;
      const capture = {
        state: invocation.stateId,
        agent: invocation.agent,
        requested: [...(args[0]?.tools ?? [])],
        active: [...created.session.getActiveToolNames()],
        reads: [] as string[],
      };
      captures.push(capture);
      vi.spyOn(created.session, "prompt").mockImplementation(async () => {
        const reader = created.session.agent.state.tools.find((t) => t.name === "artifact_read");
        if (reader === undefined || reply === undefined)
          throw new Error("fixture reader/provider absent");
        for (const ref of invocation.inputArtifacts) {
          let request: ArtifactReadParams = { artifact: ref.artifact_id };
          let content = "";
          while (true) {
            const result = await reader.execute(
              `fixture-read:${ref.artifact_id}`,
              request,
              invocation.signal
            );
            const raw: unknown = JSON.parse(
              result.content
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("")
            );
            if (
              !isRecord(raw) ||
              raw.ok !== true ||
              typeof raw.content !== "string" ||
              typeof raw.truncated !== "boolean"
            )
              throw new Error("actual artifact reader refused selected input");
            content += raw.content;
            if (!raw.truncated) break;
            const next = raw.next_range;
            if (
              !isRecord(next) ||
              typeof next.start !== "number" ||
              typeof next.end !== "number" ||
              next.start <= (request.range?.start ?? 0)
            )
              throw new Error("nonprogressing exact read");
            request = { artifact: ref.artifact_id, range: { start: next.start, end: next.end } };
          }
          expect(Buffer.byteLength(content)).toBe(ref.byte_length);
          expect(sha256(content)).toBe(ref.content_digest);
          capture.reads.push(ref.artifact_id);
        }
        const response = await reply.runAgent(invocation);
        created.session.messages.push({
          role: "assistant",
          // Live-shaped final text: exercise PiAgentClient capture and the default
          // persisted parser, not fixture-supplied routing details.
          content: [{ type: "text", text: response.text.replace(/^SUMMARY:/u, "SUMMARY: ") }],
          api: "openai-completions",
          provider: "ollama",
          model: fixtureModel.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        });
      });
      return created;
    },
  };
});
/** Production default factory and native resource lifecycle, isolated from unrelated extensions.
 * No additionalSkillPaths, skillsOverride, custom slash command or direct skill.execute seam.
 */
async function nativeParent(f: ManifestVideogenFixture) {
  initTheme("dark", false);
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline fixture"));
  const faux = fauxProvider({
    tokensPerSecond: 0,
    models: [{ id: "command-conformance", contextWindow: 131072, maxTokens: 8192 }],
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
  const outcomes: { isError: boolean; result: unknown }[] = [];
  const extension = await import("../../index.js");
  const loader = new DefaultResourceLoader({
    cwd: f.root,
    agentDir: path.join(f.root, "parent-agent"),
    settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
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
  // Normal recursive discovery loads hidden packages before session binding, without path injection.
  expect(loader.getSkills().skills.filter((skill) => skill.name === "videogen")).toMatchObject([
    { disableModelInvocation: true },
  ]);
  const { session } = await createAgentSession({
    cwd: f.root,
    agentDir: path.join(f.root, "parent-agent"),
    modelRuntime,
    model: faux.getModel(),
    settingsManager,
    sessionManager: SessionManager.inMemory(f.root),
    resourceLoader: loader,
    tools: ["skill"],
  });
  await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_end" && event.toolName === "skill") {
      outcomes.push({ isError: event.isError, result: event.result });
    }
  });
  return {
    session,
    loader,
    errors,
    prompts,
    outcomes,
    async dispatch(params: Record<string, JsonValue>) {
      const description = params.goal;
      if (typeof description !== "string") throw new Error("fixture description missing");
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("skill", params), { stopReason: "toolUse" }),
        fauxAssistantMessage("Command-path fixture stopped; no approval or film completion."),
      ]);
      const previousCount = outcomes.length;
      const previousModelCalls = faux.state.callCount;
      expect(vi.isMockFunction(session.prompt)).toBe(false);
      await session.prompt(`/skill:videogen ${description}`);
      expect(faux.state.callCount).toBe(previousModelCalls + 2);
      expect(session.getLastAssistantText()).toBe(
        "Command-path fixture stopped; no approval or film completion."
      );
      const manifest = path.join(f.root, ".pi", "skills", "videogen", "SKILL.md");
      const body = parseFrontmatter(readFileSync(manifest, "utf8")).body.trim();
      // Exact native expansion, including the real manifest body and unchanged description.
      expect(prompts.at(-1)).toBe(
        `<skill name="videogen" location="${manifest}">\nReferences are relative to ${path.dirname(manifest)}.\n\n${body}\n</skill>\n\n${description}`
      );
      expect(formatSkillsForPrompt(loader.getSkills().skills)).not.toContain(
        "<name>videogen</name>"
      );
      expect(session.systemPrompt).not.toContain("<name>videogen</name>");
      expect(outcomes).toHaveLength(previousCount + 1);
      expect(errors).toEqual([]);
      // Missing optional memory configuration must stay a typed, local warning,
      // not an outbound attempt or an ignored diagnostic (one per real worker).
      expect(
        telemetry.map((entry) => {
          const { timestamp, ...diagnostic } = requireRecord(parseJson(entry));
          expect(Number.isFinite(Date.parse(requireString(timestamp)))).toBe(true);
          return diagnostic;
        })
      ).toEqual(
        captures.map(() => ({
          level: 2,
          extension: "memory",
          message: "Memory worker-read unavailable: invalid configuration",
          context: { errorCode: "MEMPALACE_INVALID" },
        }))
      );
      expect(network).not.toHaveBeenCalled();
      const outcome = outcomes.at(-1);
      if (outcome === undefined) throw new Error("normal Pi skill dispatch missing");
      return { ...outcome, result: requireRecord(outcome.result) };
    },
    [Symbol.dispose]() {
      unsubscribe();
      session.dispose();
    },
  };
}
const environmentKeys = [
  "PROJECT_ROOT",
  "PENNY_STATE_ROOT",
  "PENNY_SKILLS_DIR",
  VIDEOGEN_RUNTIME_MANIFEST_ENV,
  "PI_OBSERVABILITY_ENABLED",
  "PI_OBSERVABILITY_AUTO_START",
  "PENNY_ARTIFACT_ROOT",
  "PENNY_MEMORY_MCP_ENDPOINT",
  "PI_LOG_LEVEL",
  "PI_LOG_LEVEL_MEMORY",
  "PI_LOG_FORMAT",
];
const originalEnv = new Map(environmentKeys.map((key) => [key, process.env[key]]));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  captures.length = 0;
  telemetry.length = 0;
  reply = undefined;
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
function environment(f: ManifestVideogenFixture): void {
  process.env.PROJECT_ROOT = f.root;
  process.env.PENNY_STATE_ROOT = f.stateRoot;
  process.env.PENNY_SKILLS_DIR = path.join(f.root, ".pi", "skills");
  process.env.PI_OBSERVABILITY_ENABLED = "false";
  process.env.PI_OBSERVABILITY_AUTO_START = "false";
  delete process.env.PENNY_ARTIFACT_ROOT;
  // This fixture exercises unavailable optional memory, even on a configured host.
  // Missing endpoint refuses before credential loading; keep the warning oracle observable.
  delete process.env.PENNY_MEMORY_MCP_ENDPOINT;
  process.env.PI_LOG_LEVEL = "WARN";
  process.env.PI_LOG_LEVEL_MEMORY = "WARN";
  process.env.PI_LOG_FORMAT = "json";
}
function yamlTools(f: ManifestVideogenFixture, agent: string): string[] {
  const text = readFileSync(path.join(f.root, ".pi", "agents", `${agent}.md`), "utf8");
  const tools = text.match(/^tools:\s*(.+)$/mu)?.[1];
  if (tools === undefined) throw new Error("fixture YAML tools missing");
  return tools.split(",").map((x) => x.trim());
}
describe("native /skill:videogen command-path conformance (provider-free cognition, not live qualification)", () => {
  it("expands the literal native command and dispatches through the real parent tool loop to durable G1, then reopens without workers", async () => {
    using f = new ManifestVideogenFixture();
    // A valid synthetic ambient configuration must not defeat the absent-memory fixture.
    // No real credential or reachable provider is needed to reproduce that contamination.
    for (const [key, value] of Object.entries({
      PENNY_MEMORY_MCP_ENDPOINT: "http://127.0.0.1:1/mcp",
      PENNY_MEMORY_MCP_TOKEN_FILE: "",
      PENNY_MEMORY_MCP_TOKEN_ENV: "VIDEOGEN_FIXTURE_MEMORY_TOKEN",
      VIDEOGEN_FIXTURE_MEMORY_TOKEN: "synthetic-memory-token-0123456789abcdef",
      PENNY_MEMORY_PALACE_ID: "videogen-fixture",
      PENNY_MEMORY_PRINCIPAL_ID: "videogen-fixture",
      PENNY_MEMORY_TRUST_MODE: "isolated",
      PENNY_MEMORY_ISOLATION_BOUNDARY_ID: "videogen-fixture",
      PENNY_MEMORY_DATA_ROOT_ID: "videogen-fixture",
    }))
      vi.stubEnv(key, value);
    environment(f);
    const base = minimalVideogenManifest(f);
    if (!isRecord(base.config)) throw new Error("fixture config object missing");
    const manifest = {
      ...base,
      artifacts: [
        ...base.artifacts,
        {
          id: "author-context",
          kind: "videogen-author-context",
          media_type: "application/json",
          source: { json: { saved_voice: "synthetic-existing-selection", playback: "unassessed" } },
        },
      ],
      config: { ...base.config, brief_context_refs: [{ $artifact: "author-context" }] },
    };
    const filename = path.join(f.root, "private-manifest.json");
    writeFileSync(filename, canonicalJson(manifest), { mode: 0o600 });
    process.env[VIDEOGEN_RUNTIME_MANIFEST_ENV] = filename;
    const fixtureReply = setup(f).client;
    reply = {
      runAgent: async (invocation) => {
        if (invocation.stateId === "brief_analysis") {
          expect(invocation.inputArtifacts).toHaveLength(4);
          const contextRef = invocation.inputArtifacts.at(-1);
          if (contextRef === undefined) throw new Error("missing exact author context");
          expect(invocation.task).toContain(
            canonicalJson({ slot: "context-0", artifact_id: contextRef.artifact_id })
          );
          expect(f.store.readById(contextRef.artifact_id).toString("utf8")).toBe(
            canonicalJson({ saved_voice: "synthetic-existing-selection", playback: "unassessed" })
          );
        }
        return fixtureReply.runAgent(invocation);
      },
    };
    const request = videogenStageRequest();
    const params = {
      skill_name: "videogen",
      goal: request.brief,
      session_id: "default-videogen-manifest",
      model: `${fixtureModel.provider}/${fixtureModel.id}`,
      constraints: request,
    };
    using parent = await nativeParent(f);
    const first = await parent.dispatch(params);
    expect(first.isError, JSON.stringify(first.result)).toBe(false);
    expect(first.result.details).toMatchObject({
      success: false,
      state: "g1",
      skill_name: "videogen",
    });
    const current = f.checkpointer.loadRunById(params.session_id);
    if (current === undefined) throw new Error(canonicalJson(first.result.details));
    const packetRef = slot(executionState(current), "packet");
    expect(
      validateGatePacket(JSON.parse(f.store.read(packetRef).toString()), FOUNDATION_LIMITS).gate_id
    ).toBe("G1");
    expect(captures.map((c) => c.state)).toEqual([
      "brief_analysis",
      "story_plan",
      "script_text",
      "story_check",
    ]);
    for (const c of captures) {
      const expected = yamlTools(f, c.agent);
      expect(c.requested).toEqual(expected);
      expect([...c.active].sort()).toEqual([...expected].sort());
      expect(c.reads.length).toBeGreaterThan(0);
    }
    const count = captures.length;
    // Reload is the normal Pi lifecycle, not a manual skill-path override.
    await parent.session.reload();
    expect(
      parent.loader.getSkills().skills.filter((skill) => skill.name === "videogen")
    ).toHaveLength(1);
    const reopened = await parent.dispatch(params);
    expect(reopened.result.details).toMatchObject({ success: false, state: "g1" });
    expect(slot(executionState(f.checkpointer.loadRun(current.identity)), "packet")).toEqual(
      packetRef
    );
    expect(captures).toHaveLength(count);
    expect(f.checkpointer.hostOperationCallsForRun(current.identity.run_id)).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("rejects executable-module selectors at the default manifest boundary before run creation", async () => {
    using f = new ManifestVideogenFixture();
    environment(f);
    const filename = path.join(f.root, "invalid-manifest.json");
    writeFileSync(
      filename,
      canonicalJson({ ...minimalVideogenManifest(f), module: "untrusted-code" }),
      { mode: 0o600 }
    );
    process.env[VIDEOGEN_RUNTIME_MANIFEST_ENV] = filename;
    const request = videogenStageRequest();
    using parent = await nativeParent(f);
    const refused = await parent.dispatch({
      skill_name: "videogen",
      goal: request.brief,
      session_id: "invalid-video-manifest",
      constraints: request,
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.result)).toContain("videogen runtime manifest");
    expect(f.checkpointer.loadRunById("invalid-video-manifest")).toBeUndefined();
    expect(captures).toEqual([]);
  });
  it("refuses absent private configuration before creating a run or a worker", async () => {
    using f = new ManifestVideogenFixture();
    environment(f);
    delete process.env[VIDEOGEN_RUNTIME_MANIFEST_ENV];
    const request = videogenStageRequest();
    using parent = await nativeParent(f);
    const refused = await parent.dispatch({
      skill_name: "videogen",
      goal: request.brief,
      session_id: "absent-video-runtime",
      constraints: request,
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.result)).toContain("VIDEOGEN_PRIVATE_CONFIG_MISSING");
    expect(f.checkpointer.loadRunById("absent-video-runtime")).toBeUndefined();
    expect(captures).toEqual([]);
  });
});
