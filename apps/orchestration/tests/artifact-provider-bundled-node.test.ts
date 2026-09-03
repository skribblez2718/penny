import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

interface ProbeScenario {
  readonly trust_profile: string;
  readonly context_and_input_present: boolean;
  readonly error: string | null;
}

interface BundledProbeRecord {
  readonly node_version: string;
  readonly artifact_extension_loaded: boolean;
  readonly artifact_extension_errors: readonly string[];
  readonly yaml_tools: readonly string[];
  readonly requested_tools: readonly string[];
  readonly active_tools: readonly string[];
  readonly missing: readonly string[];
  readonly added: readonly string[];
  readonly scenarios: readonly ProbeScenario[];
  readonly model_turns: number;
  readonly tool_calls: number;
  readonly external_calls: number;
  readonly prompt_invocations: number;
  readonly provider_requests: number;
  readonly state_entries: readonly string[];
  readonly agent_entries: readonly string[];
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isProbeScenario(value: unknown): value is ProbeScenario {
  return (
    isUnknownRecord(value) &&
    typeof value.trust_profile === "string" &&
    typeof value.context_and_input_present === "boolean" &&
    (typeof value.error === "string" || value.error === null)
  );
}

function requireStringArray(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  if (!isStringArray(value)) {
    throw new Error(`bundled artifact-provider probe has invalid '${key}'`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") {
    throw new Error(`bundled artifact-provider probe has invalid '${key}'`);
  }
  return value;
}

function requireBundledProbeRecord(value: unknown): BundledProbeRecord {
  if (!isUnknownRecord(value)) {
    throw new Error("bundled artifact-provider probe returned no object");
  }
  const scenarios = value.scenarios;
  if (
    typeof value.node_version !== "string" ||
    typeof value.artifact_extension_loaded !== "boolean" ||
    !Array.isArray(scenarios) ||
    !scenarios.every(isProbeScenario)
  ) {
    throw new Error("bundled artifact-provider probe has an invalid envelope");
  }
  return {
    node_version: value.node_version,
    artifact_extension_loaded: value.artifact_extension_loaded,
    artifact_extension_errors: requireStringArray(value, "artifact_extension_errors"),
    yaml_tools: requireStringArray(value, "yaml_tools"),
    requested_tools: requireStringArray(value, "requested_tools"),
    active_tools: requireStringArray(value, "active_tools"),
    missing: requireStringArray(value, "missing"),
    added: requireStringArray(value, "added"),
    scenarios,
    model_turns: requireNumber(value, "model_turns"),
    tool_calls: requireNumber(value, "tool_calls"),
    external_calls: requireNumber(value, "external_calls"),
    prompt_invocations: requireNumber(value, "prompt_invocations"),
    provider_requests: requireNumber(value, "provider_requests"),
    state_entries: requireStringArray(value, "state_entries"),
    agent_entries: requireStringArray(value, "agent_entries"),
  };
}

const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu;

function projectNodeModulesWithDependencies(
  projectRoot: string,
  packageNames: readonly string[]
): string {
  if (packageNames.length === 0 || new Set(packageNames).size !== packageNames.length) {
    throw new Error("temporary bundling dependencies must be nonempty and unique");
  }
  const nodeModules = path.join(projectRoot, "node_modules");
  for (const packageName of packageNames) {
    if (!PACKAGE_NAME_PATTERN.test(packageName)) {
      throw new Error(`temporary bundling dependency '${packageName}' is not a package name`);
    }
    const installedPath = path.join(nodeModules, ...packageName.split("/"));
    if (!existsSync(installedPath) || !statSync(installedPath).isDirectory()) {
      throw new Error(`temporary bundling requires project-installed dependency '${packageName}'`);
    }
  }
  return nodeModules;
}

function environmentWithProjectDependencies(
  projectRoot: string,
  packageNames: readonly string[],
  baseEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const nodeModules = projectNodeModulesWithDependencies(projectRoot, packageNames);
  return {
    ...baseEnvironment,
    NODE_PATH: [nodeModules, baseEnvironment.NODE_PATH]
      .filter((entry): entry is string => entry !== undefined && entry.length > 0)
      .join(path.delimiter),
  };
}

function temporaryProjectDependencyBridge(
  temporaryRoot: string,
  projectRoot: string,
  packageNames: readonly string[]
): Disposable {
  const projectNodeModules = projectNodeModulesWithDependencies(projectRoot, packageNames);
  const temporaryNodeModules = path.join(temporaryRoot, "node_modules");
  if (existsSync(temporaryNodeModules)) {
    throw new Error("temporary bundling dependency bridge already exists");
  }
  symlinkSync(
    projectNodeModules,
    temporaryNodeModules,
    process.platform === "win32" ? "junction" : "dir"
  );
  return {
    [Symbol.dispose]() {
      if (existsSync(temporaryNodeModules)) unlinkSync(temporaryNodeModules);
    },
  };
}

function run(command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: env ?? process.env,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${String(result.status)}): ${result.stderr.slice(0, 8_192)}`
    );
  }
  return result;
}

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ORCHESTRATION_ROOT = path.join(PROJECT_ROOT, "apps", "orchestration");
const PROBE_PROJECT_DEPENDENCIES = ["@earendil-works/pi-coding-agent", "typebox"] as const;

const probeSource = String.raw`
import { readdirSync } from "node:fs";
import path from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { createWorkerResourceLoader, PiAgentClient } from __MODEL_CLIENT__;

const projectRoot = process.env.PROJECT_ROOT;
const tempRoot = process.env.P4_PROBE_TEMP_ROOT;
if (!projectRoot || !tempRoot) throw new Error("probe roots are required");

function independentlyParseYamlTools(document) {
  const match = document.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  if (!match) throw new Error("Echo frontmatter is absent");
  const toolsLine = match[1].split(/\r?\n/u).find((line) => line.startsWith("tools:"));
  if (!toolsLine) throw new Error("Echo tools are absent");
  const tools = toolsLine.slice("tools:".length).split(",").map((name) => name.trim());
  if (!tools.length || tools.some((name) => !name) || new Set(tools).size !== tools.length) {
    throw new Error("Echo tools are empty or duplicated");
  }
  return tools;
}

const echoDocument = await import("node:fs/promises").then((fs) =>
  fs.readFile(path.join(projectRoot, ".pi", "agents", "echo.md"), "utf8")
);
const yamlTools = independentlyParseYamlTools(echoDocument);
const requestedTools = [...yamlTools].sort();
const loader = await createWorkerResourceLoader(projectRoot);
const loaded = loader.getExtensions();
const artifactPath = path.join(projectRoot, ".pi", "extensions", "artifacts", "index.ts");
const artifactExtension = loaded.extensions.find((extension) => extension.resolvedPath === artifactPath);
const artifactExtensionErrors = loaded.errors
  .filter((error) => path.resolve(error.path) === artifactPath)
  .map((error) => error.error);
const created = await createAgentSession({
  cwd: projectRoot,
  sessionManager: SessionManager.inMemory(projectRoot),
  resourceLoader: loader,
  tools: yamlTools,
});
let activeTools;
try {
  activeTools = [...created.session.getActiveToolNames()].sort();
} finally {
  created.session.dispose();
}
const missing = requestedTools.filter((name) => !activeTools.includes(name));
const added = activeTools.filter((name) => !requestedTools.includes(name));

const counters = { model_turns: 0, tool_calls: 0 };
const scenarios = [];
for (const trustProfile of ["trusted-interactive", "hardened-untrusted"]) {
  for (const contextAndInputPresent of [false, true]) {
    const controller = new AbortController();
    controller.abort();
    let errorMessage = null;
    try {
      await new PiAgentClient({
        testOnlySessionManagerFactory: (invocation) =>
          SessionManager.inMemory(invocation.projectRoot),
      }).runAgent({
        agent: "echo",
        stateId: "researching",
        task: "Stop at the deterministic pre-model regression boundary.",
        projectRoot,
        trustProfile,
        inputArtifacts: contextAndInputPresent ? [{ artifact_id: "offline-regression" }] : [],
        contextOverlays: contextAndInputPresent
          ? [{ source: { source_id: "offline-regression" }, content: "offline" }]
          : [],
        signal: controller.signal,
        liveness(event) {
          if (event.kind === "model_turn") counters.model_turns += 1;
          if (event.kind === "tool_call") counters.tool_calls += 1;
        },
        registration: {
          playbook_name: "research",
          workflow_name: "research",
          guidance: {
            skill_root: ".pi/skills/research/assets/prompts",
            resolution: "per_agent_phase",
          },
          result_transport: "persisted_summary",
          opening_policy: "registration_guidance_task_artifacts",
          model_policy: "directive_override_or_runtime_default",
        },
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    scenarios.push({
      trust_profile: trustProfile,
      context_and_input_present: contextAndInputPresent,
      error: errorMessage,
    });
  }
}

process.stdout.write(JSON.stringify({
  node_version: process.version,
  artifact_extension_loaded:
    artifactExtension?.tools.has("artifact_read") === true,
  artifact_extension_errors: artifactExtensionErrors,
  yaml_tools: requestedTools,
  requested_tools: requestedTools,
  active_tools: activeTools,
  missing,
  added,
  scenarios,
  model_turns: counters.model_turns,
  tool_calls: counters.tool_calls,
  external_calls: 0,
  prompt_invocations: 0,
  provider_requests: 0,
  state_entries: readdirSync(path.join(tempRoot, "state")),
  agent_entries: readdirSync(path.join(tempRoot, "agent")),
}));
`;

describe("bundled Node artifact provider", () => {
  it("loads artifact_read on the built production path before every Echo prompt boundary", () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "penny-artifact-provider-node-"));
    try {
      const source = path.join(temporary, "probe.mjs");
      const bundle = path.join(temporary, "probe.bundle.mjs");
      const state = path.join(temporary, "state");
      const agent = path.join(temporary, "agent");
      mkdirSync(state, { mode: 0o700 });
      mkdirSync(agent, { mode: 0o700 });
      using _dependencyBridge = temporaryProjectDependencyBridge(
        temporary,
        PROJECT_ROOT,
        PROBE_PROJECT_DEPENDENCIES
      );

      const modelClient = path.join(ORCHESTRATION_ROOT, "dist", "model-client.js");
      if (!existsSync(modelClient)) {
        throw new Error("build apps/orchestration before the bundled-Node regression");
      }
      writeFileSync(source, probeSource.replace("__MODEL_CLIENT__", JSON.stringify(modelClient)), {
        mode: 0o600,
      });
      run(
        "bun",
        ["build", "--target=node", "--format=esm", `--outfile=${bundle}`, source],
        PROJECT_ROOT,
        environmentWithProjectDependencies(PROJECT_ROOT, PROBE_PROJECT_DEPENDENCIES)
      );
      const executed = run(
        process.execPath,
        [bundle],
        PROJECT_ROOT,
        environmentWithProjectDependencies(PROJECT_ROOT, PROBE_PROJECT_DEPENDENCIES, {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          PROJECT_ROOT,
          P4_PROBE_TEMP_ROOT: temporary,
          PI_CODING_AGENT_DIR: agent,
          PENNY_STATE_ROOT: state,
          PI_OFFLINE: "1",
          PENNY_RUNTIME_ROLE: "worker-read",
          PENNY_ARTIFACT_DISPATCH_MODE: "paused",
          PI_OBSERVABILITY_ENABLED: "false",
          PI_OBSERVABILITY_AUTO_START: "false",
        })
      );
      const parsed: unknown = JSON.parse(executed.stdout);
      const record = requireBundledProbeRecord(parsed);

      expect(record.node_version).toBe(process.version);
      expect(record.artifact_extension_errors).toEqual([]);
      expect(record.yaml_tools).toContain("artifact_read");
      expect(record.requested_tools).toEqual(record.yaml_tools);
      expect(record.active_tools).toEqual(record.yaml_tools);
      expect(record.artifact_extension_loaded).toBe(true);
      expect(record.missing).toEqual([]);
      expect(record.added).toEqual([]);
      expect(record.scenarios).toEqual([
        {
          trust_profile: "trusted-interactive",
          context_and_input_present: false,
          error: "agent invocation aborted before prompt",
        },
        {
          trust_profile: "trusted-interactive",
          context_and_input_present: true,
          error: "agent invocation aborted before prompt",
        },
        {
          trust_profile: "hardened-untrusted",
          context_and_input_present: false,
          error: "agent invocation aborted before prompt",
        },
        {
          trust_profile: "hardened-untrusted",
          context_and_input_present: true,
          error: "agent invocation aborted before prompt",
        },
      ]);
      expect(record.model_turns).toBe(0);
      expect(record.tool_calls).toBe(0);
      expect(record.external_calls).toBe(0);
      expect(record.prompt_invocations).toBe(0);
      expect(record.provider_requests).toBe(0);
      expect(record.state_entries).toEqual([]);
      expect(record.agent_entries).not.toContain("penny");
      expect(readFileSync(bundle).length).toBeGreaterThan(0);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }, 180_000);

  it("refuses a temp-entry dependency bridge when the dependency is absent", () => {
    const temporary = mkdtempSync(path.join(tmpdir(), "penny-absent-bundle-dependency-"));
    try {
      expect(() =>
        temporaryProjectDependencyBridge(temporary, PROJECT_ROOT, ["@penny/absent-bundling-probe"])
      ).toThrow(/requires project-installed dependency '@penny\/absent-bundling-probe'/u);
      expect(existsSync(path.join(temporary, "node_modules"))).toBe(false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
