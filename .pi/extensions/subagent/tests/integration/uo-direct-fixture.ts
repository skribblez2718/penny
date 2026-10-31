/** Real public subagent -> unmodified runner -> real SDK/print subprocess fixture. */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCurrentShippingBuild,
  initializePennyState,
  resolvePennyRuntimeState,
} from "@penny/orchestration";
import { vi } from "vitest";
import { createTestExtensionApi, createTestToolInfos } from "../../../../lib/tests/pi-test-host.js";
import {
  isRecord,
  isUnknownFunction,
  requireDefined,
  requireRecord,
} from "../../../../lib/tests/test-narrowers.js";
import { persistArtifactOutput, type ArtifactRef } from "../../../artifacts/owner-client.js";
import subagentExtension from "../../index.js";
import { getFinalOutput, type SubagentDetails, type OnUpdateCallback } from "../../agent-runner.js";
import { discoverAgents } from "../../agents.js";
import {
  directTask,
  directContext,
  inputBytes,
  cancelledBytes,
  type DirectMode,
} from "./uo-direct-child.js";

// Bind to the verified current build once; never refresh the expected generation mid-run.
export const compiledGeneration = requireDefined(
  assertCurrentShippingBuild(),
  "compiled identity absent"
).generation;
const repository = path.resolve(import.meta.dirname, "../../../../..");
interface PublicTool {
  name: "subagent";
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: OnUpdateCallback | undefined,
    ctx: { cwd: string; hasUI: false; sessionManager: { getSessionId(): string } }
  ): Promise<{
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
    details: SubagentDetails;
  }>;
}
function isPublicTool(value: unknown): value is PublicTool {
  return isRecord(value) && value.name === "subagent" && typeof value.execute === "function";
}
export async function directFixture(
  mode: DirectMode,
  registerCleanup: (cleanup: () => void | Promise<void>) => void
) {
  const identity = requireDefined(assertCurrentShippingBuild(), "compiled identity absent");
  if (identity.generation !== compiledGeneration)
    throw new Error("Compiled generation changed; do not build or bypass provenance");
  const root = mkdtempSync(path.join(tmpdir(), "penny-direct-owner-"));
  let shutdown: (() => Promise<void>) | undefined;
  const watchers: Array<ReturnType<typeof watch>> = [];
  registerCleanup(async () => {
    for (const watcher of watchers) watcher.close();
    try {
      await shutdown?.();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  // Do not let the real child inherit operator credentials or retained Pi resources.
  // Tool arguments still flow through the real owner; this changes only test-process inputs.
  for (const name of Object.keys(process.env)) {
    if (!["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"].includes(name))
      vi.stubEnv(name, undefined);
  }
  vi.stubEnv("HOME", path.join(root, "home"));
  const projectRoot = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  mkdirSync(path.join(projectRoot, ".pi/agents"), { recursive: true });
  mkdirSync(path.join(projectRoot, ".pi/extensions"));
  mkdirSync(agentDir);
  mkdirSync(path.join(root, "home"));
  cpSync(path.join(repository, ".pi/agents/echo.md"), path.join(projectRoot, ".pi/agents/echo.md"));
  cpSync(path.join(repository, ".pi/SYSTEM.md"), path.join(projectRoot, ".pi/SYSTEM.md"));
  cpSync(path.join(repository, "AGENTS.md"), path.join(projectRoot, "AGENTS.md"));
  // Only this additional extension loads. Its provider is registered in the disposable child,
  // never in the retained operator runtime; the real direct owner still selects all paths/argv.
  writeFileSync(
    path.join(projectRoot, ".pi/extensions/offline.ts"),
    `export { default } from ${JSON.stringify(fileURLToPath(new URL("./uo-direct-child.ts", import.meta.url)))};\n`
  );
  const env = {
    PROJECT_ROOT: projectRoot,
    PI_DIRECTORY: path.join(projectRoot, ".pi"),
    PI_CODING_AGENT_DIR: agentDir,
    PENNY_STATE_ROOT: path.join(root, "state"),
    PI_PACKAGE_DIR: getPackageDir(),
    PI_OBSERVABILITY_ENABLED: "false",
    NODE_OPTIONS: `--import=${JSON.stringify(fileURLToPath(new URL("./uo-direct-offline.ts", import.meta.url)))}`,
    UO_DIRECT_MODE: mode,
  };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.stubGlobal("fetch", () => Promise.reject(new Error("Parent fixture forbids network")));
  initializePennyState(projectRoot, { env: process.env });
  const input: ArtifactRef = await persistArtifactOutput({
    cwd: projectRoot,
    metadata: {
      schema_version: 2,
      run_id: "direct-predecessor",
      phase: "exact-input",
      branch_id: null,
      kind: "agent-output",
      operation_id: "direct-predecessor-output",
      version: 1,
      producer: "agent:fixture",
      media_type: "text/markdown; charset=utf-8",
      parent_ref: null,
      upstream_refs: [],
    },
    output: inputBytes,
  });
  vi.stubEnv("UO_DIRECT_INPUT", input.artifact_id);
  const names = requireDefined(
    discoverAgents(projectRoot, "project").agents[0],
    "echo absent"
  ).tools;
  let selected: PublicTool | undefined;
  subagentExtension(
    createTestExtensionApi({
      getAllTools: () => createTestToolInfos(names),
      onEvent(event, handler) {
        if (event === "session_shutdown" && isUnknownFunction(handler))
          shutdown = async () => {
            await handler({ reason: "quit" }, {});
          };
      },
      onRegisterTool(tool) {
        if (isPublicTool(tool)) selected = tool;
      },
    })
  );
  const tool = requireDefined(selected, "public subagent tool absent");
  const cancellation = new AbortController();
  const run = () =>
    tool.execute(
      "direct-owner",
      {
        agent: "echo",
        task: directTask,
        model: "faux/direct-continuation",
        // Exceed native keepRecentTokens through actual fixture input, not a settings change.
        // Otherwise a tiny overflow input need not contain any compactable prefix.
        skillContext:
          directContext +
          (mode === "overflow" || mode === "silent"
            ? "\n" +
              "Supplied disposable context padding for native overflow recovery. ".repeat(1600)
            : ""),
        input_artifacts: [input.artifact_id],
      },
      cancellation.signal,
      (update) => {
        const worker = update.details.results[0];
        if (
          mode === "cancel" &&
          worker !== undefined &&
          getFinalOutput(worker.messages) === cancelledBytes
        )
          cancellation.abort(
            new Error("Caller cancelled real child after completed partial message")
          );
      },
      { cwd: projectRoot, hasUI: false, sessionManager: { getSessionId: () => "direct-parent" } }
    );
  function observations(): Record<string, unknown>[] {
    return readFileSync(path.join(projectRoot, "observations.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => requireRecord(JSON.parse(line), "invalid child observation"));
  }
  function entries(): Record<string, unknown>[] {
    const state = resolvePennyRuntimeState(projectRoot, { env: process.env });
    const sessionDir = path.join(state.paths.subagentSessions, "echo");
    const files = readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl"));
    if (files.length !== 1) throw new Error("Expected exactly one real durable child session");
    return readFileSync(path.join(sessionDir, requireDefined(files[0])), "utf8")
      .trim()
      .split("\n")
      .map((line) => requireRecord(JSON.parse(line), "invalid durable child entry"));
  }
  function summaryStarted() {
    const marker = path.join(projectRoot, "summary-started");
    if (existsSync(marker)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const watcher = watch(projectRoot, () => {
        if (existsSync(marker)) {
          watcher.close();
          resolve();
        }
      });
      watchers.push(watcher);
    });
  }
  return {
    root,
    projectRoot,
    input,
    names,
    run,
    observations,
    entries,
    summaryStarted,
  };
}
