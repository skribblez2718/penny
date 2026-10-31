/** Offline real SDK pipeline/discovery, original production tools, scripted in-memory provider.
 * Fetch transport alone is stubbed; no credentials, providers, servers or network are used. */
import "../dist/index.js";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type JsonObject,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  initTheme,
  ModelRuntime,
  SettingsManager,
  SessionManager,
  type AgentSession,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRecord } from "../../../.pi/lib/tests/test-narrowers.js";
import { ArtifactStore } from "../dist/artifact-store.js";
import { sha256 } from "../dist/canonical-json.js";
import {
  CATALOG_WORKER_CONTINUITY_METADATA,
  PiAgentClient,
  createDurableCatalogSession,
  createWorkerResourceLoader,
  finalizeDurableCatalogSession,
  parseSsotTools,
  validateCatalogWorkerSessionMetadata,
} from "../dist/model-client.js";
import { PLAYBOOK_REGISTRY } from "../dist/playbooks/registry.js";
import { initializePennyState } from "../dist/state/setup.js";
import {
  atomicBytes,
  atomicJson,
  filesUnder,
  PUBLIC_RESEARCH_URL,
} from "../smoke/ordinary-skills-live-contract.js";
import {
  enrollWorkerGuard,
  observeWorkerGuardDenials,
  WORKER_GUARD_ENV,
  WorkerGuardConfigSchema,
} from "./ordinary-skills-live-guard.js";
import { validateContract } from "../dist/contracts.js";

function isMemoryModule(value: unknown): value is {
  memoryExtensionSource: string;
  createMemoryExtension(options: { env: NodeJS.ProcessEnv }): ExtensionFactory;
} {
  return (
    isRecord(value) &&
    typeof value.memoryExtensionSource === "string" &&
    typeof value.createMemoryExtension === "function"
  );
}

const repository = path.resolve(import.meta.dirname, "../../..");
let root: string;
let originalCwd: string;
const sessions: AgentSession[] = [];
const releaseObservers: (() => void)[] = [];
const fetchTransport = vi.fn<(body: string | undefined) => Promise<Response>>(
  async () =>
    new Response(
      JSON.stringify({
        title: "Synthetic RFC transport fixture",
        content: "optional header; quoted comma",
        links: [],
      }),
      { headers: { "Content-Type": "application/json" } }
    )
);

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "ordinary-guard-offline-"));
  originalCwd = process.cwd();
  fetchTransport.mockClear();
  vi.stubGlobal("fetch", (async (input, init) => {
    // Do not retain/print headers, environment or credentials in test diagnostics.
    if (String(input) === "https://offline.invalid/api/web_fetch")
      return fetchTransport(typeof init?.body === "string" ? init.body : undefined);
    if (String(input) === "http://127.0.0.1:1/logs") return new Response("{}");
    throw new Error("Unexpected offline transport (destination omitted)");
  }) satisfies typeof fetch);
  for (const [key, value] of Object.entries({
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
    PROJECT_ROOT: path.join(root, "project"),
    PENNY_STATE_ROOT: path.join(root, "state"),
    PI_OBSERVABILITY_ENABLED: "false",
    PI_OBSERVABILITY_AUTO_START: "false",
    PI_OBSERVABILITY_REST_URL: "http://127.0.0.1:1",
    PI_OBSERVABILITY_API_KEY: "",
    PENNY_OBSERVABILITY_API_KEY: "",
    OLLAMA_API_KEY: "offline-synthetic-not-a-credential",
    OLLAMA_WEB_SEARCH_BASE_URL: "https://offline.invalid",
    PENNY_RUNTIME_ROLE: "worker-read",
  }))
    vi.stubEnv(key, value);
  mkdirSync(path.join(root, "agent"), { mode: 0o700 });
  mkdirSync(path.join(root, "project"), { mode: 0o700 });
  process.chdir(path.join(root, "project"));
});
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.waitForIdle();
    session.dispose();
  }
  for (const release of releaseObservers.splice(0)) release();
  process.chdir(originalCwd);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

interface FixtureOptions {
  skill?: "produce" | "research";
  agent?: "skribble" | "echo" | "vera";
  provenance?:
    | "missing"
    | "mismatch"
    | "duplicate"
    | "wrong-run"
    | "malformed"
    | "late"
    | "late-custom"
    | "cross-run-ref"
    | "task-only";
  purpose?: "phase" | "routing_repair";
  config?: "missing" | "malformed";
  bindExtensions?: boolean;
}
async function fixture(options: FixtureOptions = {}) {
  const project = path.join(root, "project");
  const guard = enrollWorkerGuard(repository, project);
  expect(lstatSync(path.dirname(guard)).isSymbolicLink()).toBe(false);
  const state = initializePennyState(project, { env: process.env });
  const skill = options.skill ?? "produce";
  const agent = options.agent ?? (skill === "produce" ? "skribble" : "echo");
  const registration = PLAYBOOK_REGISTRY.get(skill);
  if (registration?.worker.kind !== "catalog-agent") throw new Error("No catalog registration");
  const entry = [...registration.worker.phases].find(
    ([state, phase]) =>
      phase.agent === agent &&
      (agent === "echo"
        ? state === "researching"
        : agent === "vera"
          ? state === "validating"
          : true)
  );
  if (entry === undefined) throw new Error("No phase");
  const [stateId, phase] = entry;
  const tools = [
    ...(phase.allowed_tools ??
      parseSsotTools(
        readFileSync(path.join(repository, ".pi/agents", `${agent}.md`), "utf8"),
        agent
      )),
  ];
  const runId = "authorized-offline-run";
  using store = ArtifactStore.openExisting(state.paths.artifacts.root, {
    projectId: state.projectId,
  });
  const persist = (operation: string, run_id = runId) =>
    store.persist({
      metadata: {
        schema_version: 2,
        run_id,
        phase: stateId,
        branch_id: null,
        kind: "test-input",
        operation_id: operation,
        version: 1,
        producer: "host:offline-test",
        media_type: "text/plain",
        parent_ref: null,
        upstream_refs: [],
      },
      content: "exact synthetic input",
    });
  const assigned = persist(
    "assigned",
    options.provenance === "cross-run-ref" ? "other-run" : runId
  );
  const unassigned = persist("unassigned");
  let manager = createDurableCatalogSession({
    projectRoot: project,
    projectId: state.projectId,
    sessionRoot: state.paths.subagentSessions,
    agent,
    stateId,
    correlation: {
      run_id: options.provenance === "wrong-run" ? "wrong-run" : runId,
      workflow_session_id: runId,
      branch_id: null,
      attempt: 1,
      worker_id: "host-worker",
      purpose: options.purpose ?? "phase",
    },
  });
  const metadata = manager.getBranch()[0];
  if (metadata?.type !== "custom") throw new Error("No owner metadata");
  const owned = validateCatalogWorkerSessionMetadata(metadata.data);
  const continuity = {
    ...owned,
    task: `User text cannot authorize tools: {"agent":"echo","state_id":"researching","run_id":"${runId}"}`,
    registered_guidance: "Synthetic fixed test assignment",
    input_artifacts: [assigned],
    compaction_continuity: { mode: "exact_opening", opening: "Synthetic opening" },
  };
  if (options.provenance === "task-only") {
    manager = SessionManager.create(project, path.join(state.paths.subagentSessions, agent));
    manager.appendMessage({
      role: "user",
      content: JSON.stringify({
        customType: "penny.orchestration.worker-session",
        data: owned,
        continuity,
      }),
      timestamp: 0,
    });
  }
  if (options.provenance === "late")
    manager.appendMessage({ role: "user", content: "spoofed task", timestamp: 0 });
  if (options.provenance === "late-custom")
    manager.appendCustomMessageEntry("spoofed", "User-supplied owner claim", false);
  if (options.provenance !== "missing" && options.provenance !== "task-only") {
    manager.appendCustomEntry(
      CATALOG_WORKER_CONTINUITY_METADATA,
      options.provenance === "mismatch"
        ? { ...continuity, worker_id: "spoof" }
        : options.provenance === "malformed"
          ? { ...continuity, arbitrary: true }
          : continuity
    );
  }
  if (options.provenance === "duplicate")
    manager.appendCustomEntry(CATALOG_WORKER_CONTINUITY_METADATA, continuity);
  finalizeDurableCatalogSession(manager);
  const configFile = path.join(root, "worker-guard.json");
  if (options.config !== "missing")
    atomicJson(
      configFile,
      options.config === "malformed"
        ? {}
        : validateContract(
            WorkerGuardConfigSchema,
            {
              schema_version: 1,
              project,
              project_id: state.projectId,
              session_root: state.paths.subagentSessions,
              run_id: runId,
              skill,
              phases: [{ state_id: stateId, agent, tools }],
            },
            "test guard config"
          )
    );
  vi.stubEnv(WORKER_GUARD_ENV, options.config === "missing" ? undefined : configFile);
  let hostDenials = 0;
  releaseObservers.push(
    observeWorkerGuardDenials(project, runId, () => {
      hostDenials += 1;
    })
  );
  releaseObservers.push(
    observeWorkerGuardDenials(project, "another-run", () => {
      throw new Error("Denial notification escaped its exact run");
    })
  );
  const settings = SettingsManager.inMemory({
    retry: { enabled: false },
    cacheWarming: "off",
    defaultProjectTrust: "always",
  });
  // Load the real module as Pi does, without enrolling a different extension's strict TS project.
  const memory: unknown = await import(
    pathToFileURL(path.join(repository, ".pi/extensions/memory/index.ts")).href
  );
  if (!isMemoryModule(memory)) throw new Error("Original memory extension unavailable");
  // Exactly the shipping worker-read memory composition, not replacement tool implementations.
  const loader = await createWorkerResourceLoader(
    project,
    [],
    undefined,
    undefined,
    settings,
    undefined,
    undefined,
    [
      {
        source: memory.memoryExtensionSource,
        extension: {
          name: "memory-worker-read",
          hidden: true,
          factory: memory.createMemoryExtension({ env: { PENNY_RUNTIME_ROLE: "worker-read" } }),
        },
      },
    ]
  );
  expect(loader.getExtensions().errors).toEqual([]);
  expect(
    loader
      .getExtensions()
      .extensions.some((extension) => extension.resolvedPath === realpathSync(guard))
  ).toBe(true);
  for (const provider of [
    "search",
    "skill",
    "subagent",
    "artifacts",
    "word",
    "powerpoint",
    "playwright",
    "sca",
  ])
    expect(
      loader
        .getExtensions()
        .extensions.some(
          (extension) =>
            !extension.resolvedPath.startsWith("<") &&
            realpathSync(extension.resolvedPath) ===
              path.join(repository, ".pi/extensions", provider, "index.ts")
        )
    ).toBe(true);
  const sourceHashes = loader
    .getExtensions()
    .extensions.filter((extension) => !extension.resolvedPath.startsWith("<"))
    .map((extension) => realpathSync(extension.resolvedPath))
    .filter((file) => file.startsWith(repository))
    .map((file) => ({ file, hash: sha256(readFileSync(file)) }));
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const faux = fauxProvider({ tokensPerSecond: 0 });
  runtime.registerNativeProvider(faux.provider);
  initTheme("dark", false);
  const { session } = await createAgentSession({
    cwd: project,
    agentDir: path.join(root, "agent"),
    modelRuntime: runtime,
    model: faux.getModel(),
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: manager,
    tools,
  });
  sessions.push(session);
  const implementations = session.agent.state.tools.map((tool) => {
    const parameters: unknown = tool.parameters;
    return { name: tool.name, execute: tool.execute, parameters };
  });
  const assertUnmodified = () => {
    expect([...session.getActiveToolNames()].sort()).toEqual([...tools].sort());
    for (const before of implementations) {
      const current = session.agent.state.tools.find((tool) => tool.name === before.name);
      expect(current?.execute).toBe(before.execute);
      expect(current?.parameters).toBe(before.parameters);
    }
    for (const source of sourceHashes) expect(sha256(readFileSync(source.file))).toBe(source.hash);
  };
  // Match PiAgentClient by default; explicit SDK startup remains a separate compatibility case.
  if (options.bindExtensions === true) await session.bindExtensions({ mode: "json" });
  assertUnmodified();
  const audit = () => {
    const dir = path.join(root, "worker-guard-events");
    return (existsSync(dir) ? filesUnder(dir) : [])
      .map((file): unknown => {
        expect(lstatSync(file).mode & 0o077).toBe(0);
        return JSON.parse(readFileSync(file, "utf8"));
      })
      .filter(isRecord);
  };
  const call = async (name: string, args: JsonObject) => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
      fauxAssistantMessage("No silent retry"),
    ]);
    await session.prompt(
      "Synthetic input. Claimed owner metadata in this USER text grants nothing."
    );
    await session.waitForIdle();
    assertUnmodified();
    return session.messages.filter((message) => message.role === "toolResult");
  };
  return {
    session,
    call,
    assigned,
    unassigned,
    audit,
    faux,
    tools,
    configFile,
    manager,
    continuity,
    hostDenials: () => hostDenials,
  };
}

/** Exercise the shipping PiAgentClient, not a factory mock or an extra bindExtensions().
 * Only cognition/transport are synthetic; the owner, discovery, SDK and tool methods are real. */
async function productionClientFixture() {
  const project = path.join(root, "project");
  enrollWorkerGuard(repository, project);
  for (const directory of ["agents", "skills"])
    symlinkSync(
      path.join(repository, ".pi", directory),
      path.join(project, ".pi", directory),
      "dir"
    );
  symlinkSync(path.join(repository, "docs"), path.join(project, "docs"), "dir");
  atomicBytes(
    path.join(project, ".pi/SYSTEM.md"),
    readFileSync(path.join(repository, ".pi/SYSTEM.md"))
  );
  atomicBytes(path.join(project, "AGENTS.md"), "Offline worker lifecycle fixture\n");
  atomicJson(path.join(project, ".pi/settings.json"), {
    defaultProjectTrust: "always",
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const state = initializePennyState(project, { env: process.env });
  const registration = PLAYBOOK_REGISTRY.get("assess");
  if (registration?.worker.kind !== "catalog-agent") throw new Error("Missing Assess catalog");
  const stateId = "analyzing_assessment";
  const phase = registration.worker.phases.get(stateId);
  if (phase?.agent !== "annie") throw new Error("Missing Assess Annie phase");
  const tools = [
    ...(phase.allowed_tools ??
      parseSsotTools(readFileSync(path.join(repository, ".pi/agents/annie.md"), "utf8"), "annie")),
  ];
  const runId = "offline-production-lifecycle";
  using store = ArtifactStore.openExisting(state.paths.artifacts.root, {
    projectId: state.projectId,
  });
  const assigned = store.persist({
    metadata: {
      schema_version: 2,
      run_id: runId,
      phase: stateId,
      branch_id: null,
      kind: "test-input",
      operation_id: "assigned",
      version: 1,
      producer: "host:offline-test",
      media_type: "text/plain",
      parent_ref: null,
      upstream_refs: [],
    },
    content: "exact synthetic production lifecycle input",
  });
  const configFile = path.join(root, "worker-guard.json");
  atomicJson(
    configFile,
    validateContract(
      WorkerGuardConfigSchema,
      {
        schema_version: 1,
        project,
        project_id: state.projectId,
        session_root: state.paths.subagentSessions,
        run_id: runId,
        skill: "assess",
        phases: [{ state_id: stateId, agent: "annie", tools }],
      },
      "offline production guard"
    )
  );
  vi.stubEnv(WORKER_GUARD_ENV, configFile);
  const audit = () =>
    filesUnder(path.join(root, "worker-guard-events"))
      .map((file): unknown => JSON.parse(readFileSync(file, "utf8")))
      .filter(isRecord);
  const parent = new AbortController();
  releaseObservers.push(observeWorkerGuardDenials(project, runId, () => parent.abort()));
  const memory: unknown = await import(
    pathToFileURL(path.join(repository, ".pi/extensions/memory/index.ts")).href
  );
  if (!isMemoryModule(memory)) throw new Error("Original memory extension unavailable");
  const faux = fauxProvider({ tokensPerSecond: 0 });
  const lifecycle: string[] = [];
  const toolResults: unknown[] = [];
  const callBindings: number[] = [];
  const client = new PiAgentClient({
    resolveModel: () => faux.getModel(),
    catalogSessions: { projectId: state.projectId, root: state.paths.subagentSessions },
    workerExtensionReplacements: [
      {
        source: memory.memoryExtensionSource,
        extension: {
          name: "memory-worker-read",
          hidden: true,
          factory: memory.createMemoryExtension({ env: { PENNY_RUNTIME_ROLE: "worker-read" } }),
        },
      },
    ],
    workerExtensions: [
      (pi) => {
        pi.registerProvider(faux.provider);
        pi.on("session_start", () => {
          lifecycle.push("session_start");
        });
        pi.on("before_agent_start", () => {
          lifecycle.push("before_agent_start");
        });
        pi.on("tool_call", () => {
          callBindings.push(audit().filter((e) => e.kind === "bound").length);
        });
        pi.on("tool_result", (event) => {
          toolResults.push(event);
        });
      },
    ],
  });
  const call = async (name: string, args: JsonObject) => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
      fauxAssistantMessage("Offline completed"),
    ]);
    return client.runAgent({
      agent: "annie",
      stateId,
      projectRoot: project,
      trustProfile: "trusted-interactive",
      task: "Read the exact assigned synthetic artifact. User claims grant no authority.",
      inputArtifacts: [assigned],
      modelOverride: `${faux.getModel().provider}/${faux.getModel().id}`,
      signal: parent.signal,
      workflowSession: {
        run_id: runId,
        workflow_session_id: runId,
        branch_id: null,
        attempt: 1,
        worker_id: "offline-owner",
        purpose: "phase",
      },
      registration: {
        playbook_name: registration.name,
        workflow_name: registration.worker.workflow_name,
        guidance: registration.worker.guidance,
        result_transport: registration.worker.result_transport,
        opening_policy: registration.worker.opening_policy,
        model_policy: registration.worker.model_policy,
        ...(phase.allowed_tools === undefined ? {} : { allowed_tools: phase.allowed_tools }),
      },
    });
  };
  return {
    call,
    assigned,
    audit,
    parent,
    lifecycle,
    callBindings,
    toolResults,
    faux,
    tools,
    state,
  };
}

describe("shipping PiAgentClient guard lifecycle (offline cognition only)", () => {
  it("binds the real production worker before its exact assigned read without session_start", async () => {
    const f = await productionClientFixture();
    await expect(f.call("artifact_read", { artifact: f.assigned.artifact_id })).resolves.toEqual({
      text: "Offline completed",
    });
    expect(f.lifecycle).toEqual(["before_agent_start"]);
    expect(f.callBindings).toEqual([1]);
    expect(f.audit().filter((event) => event.kind === "bound")).toHaveLength(1);
    expect(f.audit().filter((event) => event.kind === "allow")).toHaveLength(1);
    expect(f.audit().filter((event) => event.kind === "deny")).toHaveLength(0);
    expect(JSON.stringify(f.toolResults)).toContain("exact synthetic production lifecycle input");
    expect(f.parent.signal.aborted).toBe(false);
    expect(fetchTransport).not.toHaveBeenCalled();
  });
  it("keeps pre-effect denial sticky and aborts the parent on the production lifecycle", async () => {
    const f = await productionClientFixture();
    const sentinel = path.join(root, "must-not-exist");
    expect(f.tools).toContain("bash");
    await expect(f.call("bash", { command: `printf escaped > '${sentinel}'` })).rejects.toThrow();
    expect(f.lifecycle).toEqual(["before_agent_start"]);
    // A blocking tool_call stops propagation before the later observational handler.
    expect(f.callBindings).toEqual([]);
    expect(f.audit().filter((event) => event.kind === "bound")).toHaveLength(1);
    expect(f.audit().some((event) => event.reason === "unauthorized_call_or_provenance")).toBe(
      true
    );
    expect(existsSync(sentinel)).toBe(false);
    expect(f.parent.signal.aborted).toBe(true);
    expect(f.audit().filter((event) => event.kind === "allow")).toHaveLength(0);
    expect(f.audit().some((event) => event.kind === "deny")).toBe(true);
    expect(f.faux.state.callCount).toBe(1);
    await expect(f.call("artifact_read", { artifact: f.assigned.artifact_id })).rejects.toThrow();
    expect(f.faux.state.callCount).toBe(1);
    expect(fetchTransport).not.toHaveBeenCalled();
  });
});

describe("disposable worker normal discovery + real SDK pre-effect gate (offline)", () => {
  it("binds once on explicit SDK startup and revalidates without duplicate binding audits", async () => {
    const f = await fixture({ bindExtensions: true });
    expect(f.audit().filter((event) => event.kind === "bound")).toHaveLength(1);
    const results = await f.call("artifact_read", { artifact: f.assigned.artifact_id });
    expect(results[0]?.isError).toBe(false);
    expect(f.audit().filter((event) => event.kind === "bound")).toHaveLength(1);
    expect(f.hostDenials()).toBe(0);
  });
  it("validates and binds synchronously at the first guarded call even without startup/run events", async () => {
    const f = await fixture();
    expect(f.audit()).toEqual([]);
    const result = await f.session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolName: "artifact_read",
      toolCallId: "first",
      input: { artifact: f.assigned.artifact_id },
    });
    expect(result?.block).not.toBe(true);
    expect(f.audit().filter((event) => event.kind === "bound")).toHaveLength(1);
    expect(f.audit().filter((event) => event.kind === "allow")).toHaveLength(1);
    expect(f.faux.state.callCount).toBe(0);
    const results = await f.call("artifact_read", { artifact: f.assigned.artifact_id });
    expect(results[0]?.isError).toBe(false);
    expect(f.audit().filter((event) => event.kind === "bound")).toHaveLength(1);
  });
  it.each(["late", "late-custom", "task-only"] as const)(
    "rejects %s provenance at the first-call fallback without any startup/run event",
    async (provenance) => {
      const f = await fixture({ provenance });
      const result = await f.session.extensionRunner.emitToolCall({
        type: "tool_call",
        toolName: "artifact_read",
        toolCallId: "spoofed",
        input: { artifact: f.assigned.artifact_id },
      });
      expect(result?.block).toBe(true);
      expect(f.audit().some((event) => event.kind === "bound" || event.kind === "allow")).toBe(
        false
      );
      expect(f.hostDenials()).toBeGreaterThan(0);
      expect(f.faux.state.callCount).toBe(0);
    }
  );
  it("never repairs a first-call provenance denial with later owner-looking entries", async () => {
    const f = await fixture({ provenance: "missing" });
    const event = {
      type: "tool_call" as const,
      toolName: "artifact_read",
      toolCallId: "first",
      input: { artifact: f.assigned.artifact_id },
    };
    expect((await f.session.extensionRunner.emitToolCall(event))?.block).toBe(true);
    f.manager.appendCustomEntry(CATALOG_WORKER_CONTINUITY_METADATA, f.continuity);
    expect(
      (await f.session.extensionRunner.emitToolCall({ ...event, toolCallId: "late" }))?.block
    ).toBe(true);
    expect(f.audit().some((event) => event.kind === "bound" || event.kind === "allow")).toBe(false);
    expect(f.hostDenials()).toBeGreaterThan(0);
    expect(f.faux.state.callCount).toBe(0);
  });
  it.each(["bash", "write", "edit", "read", "memory_search", "web_search", "skill", "subagent"])(
    "blocks %s before original tool effects, keeps original exposure/methods",
    async (name) => {
      const f = await fixture();
      const sentinel = path.join(root, "must-not-exist");
      const args =
        name === "bash"
          ? { command: `printf escaped > '${sentinel}'` }
          : name === "write"
            ? { path: sentinel, content: "escaped" }
            : name === "edit"
              ? { path: sentinel, edits: [{ oldText: "old", newText: "new" }] }
              : name === "read"
                ? { path: sentinel }
                : name === "web_search" || name === "memory_search"
                  ? { query: "out-of-scope" }
                  : {};
      const results = await f.call(name, args);
      expect(results.some((result) => result.isError)).toBe(true);
      expect(f.audit().some((event) => event.kind === "deny")).toBe(true);
      expect(existsSync(sentinel)).toBe(false);
      expect(fetchTransport).not.toHaveBeenCalled();
      expect(f.faux.state.callCount).toBe(1); // No automatic repair request.
      expect(f.hostDenials()).toBeGreaterThan(0); // Host abort notification spans normal Jiti loading.
      if (!["skill", "subagent"].includes(name)) expect(f.tools).toContain(name);
    }
  );
  it.each([
    "https://example.com/",
    "http://127.0.0.1/",
    `${PUBLIC_RESEARCH_URL}?x=1`,
    `${PUBLIC_RESEARCH_URL}#fragment`,
  ])("blocks non-exact destination %s", async (url) => {
    const f = await fixture({ skill: "research" });
    await f.call("web_fetch", { url });
    expect(fetchTransport).not.toHaveBeenCalled();
    expect(f.audit().some((event) => event.kind === "deny")).toBe(true);
  });
  it("blocks existing but unassigned artifact IDs and fails sticky even if a later call is valid", async () => {
    const f = await fixture();
    await f.call("artifact_read", { artifact: f.unassigned.artifact_id });
    const results = await f.call("artifact_read", { artifact: f.assigned.artifact_id });
    expect(results.every((result) => result.isError)).toBe(true);
    expect(f.audit().some((event) => event.kind === "allow")).toBe(false);
  });
  it.each([
    "missing",
    "mismatch",
    "duplicate",
    "wrong-run",
    "malformed",
    "late",
    "late-custom",
    "cross-run-ref",
    "task-only",
  ] as const)("refuses %s owner provenance; user text cannot repair it", async (provenance) => {
    const f = await fixture({ skill: "research", provenance });
    await f.call("web_fetch", { url: PUBLIC_RESEARCH_URL });
    expect(fetchTransport).not.toHaveBeenCalled();
    expect(f.audit().some((event) => event.kind === "deny")).toBe(true);
  });
  it.each(["missing", "malformed"] as const)(
    "fails closed with %s host configuration",
    async (config) => {
      const f = await fixture({ config });
      const result = await f.session.extensionRunner.emitToolCall({
        type: "tool_call",
        toolName: "artifact_read",
        toolCallId: "unconfigured",
        input: { artifact: f.assigned.artifact_id },
      });
      expect(result?.block).toBe(true);
      expect(f.faux.state.callCount).toBe(0);
      expect(fetchTransport).not.toHaveBeenCalled();
    }
  );
  it("allows exact assigned artifact/range reads via the real production artifact method", async () => {
    const f = await fixture();
    const results = await f.call("artifact_read", {
      artifact: f.assigned.artifact_id,
      range: { start: 0, end: 5 },
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(false);
    expect(JSON.stringify(results)).toContain("exact");
    expect(f.audit().some((event) => event.reason === "assigned_artifact_read")).toBe(true);
    expect(f.audit().some((event) => event.kind === "deny")).toBe(false);
    expect(f.hostDenials()).toBe(0);
    expect(fetchTransport).not.toHaveBeenCalled();
  });
  it.each(["echo", "vera"] as const)(
    "allows only exact RFC fetch for host-marked Research %s through real search tool",
    async (agent) => {
      const f = await fixture({ skill: "research", agent });
      const results = await f.call("web_fetch", { url: PUBLIC_RESEARCH_URL });
      expect(results[0]?.isError).toBe(false);
      expect(fetchTransport).toHaveBeenCalledTimes(1);
      expect(fetchTransport.mock.calls[0]?.[0]).toBe(JSON.stringify({ url: PUBLIC_RESEARCH_URL }));
      expect(f.audit().some((event) => event.reason === "exact_research_rfc_fetch")).toBe(true);
    }
  );
  it("does not promote a non-Research worker from spoofed Research claims in user text", async () => {
    const f = await fixture();
    await f.call("web_fetch", { url: PUBLIC_RESEARCH_URL });
    expect(fetchTransport).not.toHaveBeenCalled();
    expect(f.audit().some((event) => event.kind === "deny")).toBe(true);
  });
  it("rejects extra fetch fields before effects", async () => {
    const f = await fixture({ skill: "research" });
    await f.call("web_fetch", {
      url: PUBLIC_RESEARCH_URL,
      headers: { Authorization: "synthetic-not-authorized" },
    });
    expect(fetchTransport).not.toHaveBeenCalled();
    expect(f.audit().some((event) => event.kind === "deny")).toBe(true);
  });
  it("rejects out-of-assignment artifact ranges before effects", async () => {
    const f = await fixture();
    const results = await f.call("artifact_read", {
      artifact: f.assigned.artifact_id,
      range: { start: 0, end: f.assigned.byte_length + 1 },
    });
    expect(results.some((result) => result.isError)).toBe(true);
    expect(f.audit().some((event) => event.kind === "deny")).toBe(true);
  });
  it("does not promote a repair worker or spoofed user task into Research fetch authority", async () => {
    const f = await fixture({ skill: "research", purpose: "routing_repair" });
    await f.call("web_fetch", { url: PUBLIC_RESEARCH_URL });
    expect(fetchTransport).not.toHaveBeenCalled();
    expect(f.audit().some((event) => event.kind === "deny")).toBe(true);
    expect(JSON.stringify(f.audit())).not.toContain("User text");
    expect(JSON.stringify(f.audit())).not.toContain("offline-synthetic-not-a-credential");
  });
  it("blocks delegated leaf reads through the real SDK extension runner too", async () => {
    const f = await fixture();
    const result = await f.session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolName: "artifact_read",
      toolCallId: "parent/1",
      parentToolCallId: "parent",
      input: { artifact: f.assigned.artifact_id },
    });
    expect(result?.block).toBe(true);
    expect(f.audit().some((event) => event.kind === "deny")).toBe(true);
    expect(fetchTransport).not.toHaveBeenCalled();
  });
  it("revalidates owner continuity at call time rather than trusting the startup snapshot", async () => {
    const f = await fixture({ skill: "research" });
    f.manager.appendCustomEntry(CATALOG_WORKER_CONTINUITY_METADATA, {});
    await f.call("web_fetch", { url: PUBLIC_RESEARCH_URL });
    expect(fetchTransport).not.toHaveBeenCalled();
    expect(f.audit().some((event) => event.kind === "deny")).toBe(true);
  });
});
