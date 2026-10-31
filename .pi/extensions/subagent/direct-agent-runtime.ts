/** Penny's isolated direct child, composed entirely from Pi's public SDK. */
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createEventBus,
  getAgentDir,
  hasTrustRequiringProjectResources,
  parseArgs,
  ProjectTrustStore,
  resolveCliModel,
  runPrintMode,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionRuntimeFactory,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  enforceNativeAutoCompaction,
  createCompactionProgressObserver,
  type CompactionProgress,
} from "../../lib/compaction-policy.mjs";

/** Testable public-SDK composition; no CLI main(), settings rewrite or custom scheduler. */
export async function createDirectAgentRuntime(
  args: string[],
  options: {
    cwd?: string;
    agentDir?: string;
    modelRuntime?: ModelRuntime;
    reportProgress?: (progress: CompactionProgress) => void;
  } = {}
) {
  const parsed = parseArgs(args);
  if (parsed.mode !== "json" || !parsed.print || parsed.fileArgs.length > 0) {
    throw new Error("direct agent requires the owner's JSON print invocation");
  }
  if (
    parsed.tools === undefined ||
    parsed.tools.length === 0 ||
    new Set(parsed.tools).size !== parsed.tools.length
  ) {
    throw new Error("direct agent requires an exact non-empty duplicate-free tool list");
  }
  const requestedTools = [...parsed.tools];
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? getAgentDir();
  // Resolve explicit CLI paths once, as Pi main() does, before session replacements.
  const extensionPaths = parsed.extensions?.map((entry) => path.resolve(cwd, entry));
  const createRuntime: CreateAgentSessionRuntimeFactory = async (target) => {
    const settingsManager = enforceNativeAutoCompaction(
      SettingsManager.create(target.cwd, target.agentDir, {
        projectTrusted:
          !hasTrustRequiringProjectResources(target.cwd) ||
          new ProjectTrustStore(target.agentDir).get(target.cwd) === true,
      })
    );
    const eventBus = createEventBus();
    const compactionProgress = createCompactionProgressObserver(
      options.reportProgress ??
        ((progress) => {
          process.stdout.write(
            `${JSON.stringify({ type: "penny_compaction_progress", ...progress })}\n`
          );
        })
    );
    const progressObserver: { release?: () => void } = {};
    const services = await createAgentSessionServices({
      cwd: target.cwd,
      agentDir: target.agentDir,
      settingsManager,
      ...(options.modelRuntime === undefined ? {} : { modelRuntime: options.modelRuntime }),
      extensionFlagValues: parsed.unknownFlags,
      resourceLoaderOptions: {
        eventBus,
        extensionsOverride: compactionProgress.extensionsOverride,
        additionalExtensionPaths: extensionPaths,
        noExtensions: parsed.noExtensions,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: parsed.systemPrompt,
        appendSystemPrompt: parsed.appendSystemPrompt,
        extensionFactories: [
          (pi) => {
            pi.on("session_shutdown", (event) => {
              // Reload replaces extensions, not this session or its native stream.
              // The loader rebinds the private producer; keep its session observer.
              if (event.reason !== "reload") progressObserver.release?.();
            });
          },
        ],
      },
    });
    const failure = services.diagnostics.find((entry) => entry.type === "error");
    if (failure) throw new Error(failure.message);
    const resolved = resolveCliModel({
      cliProvider: parsed.provider,
      cliModel: parsed.model,
      cliThinking: parsed.thinking,
      modelRuntime: services.modelRuntime,
    });
    if (resolved.error) throw new Error(resolved.error);
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: target.sessionManager,
      sessionStartEvent: target.sessionStartEvent,
      ...(resolved.model === undefined ? {} : { model: resolved.model }),
      thinkingLevel: parsed.thinking ?? resolved.thinkingLevel,
      tools: requestedTools,
    });
    try {
      // Pi silently drops unavailable names; passing YAML is not proof of activation.
      // This factory also admits every replacement session before it can be prompted.
      const active = [...created.session.getActiveToolNames()].sort();
      const expected = [...requestedTools].sort();
      if (
        active.length !== expected.length ||
        active.some((tool, index) => tool !== expected[index])
      ) {
        throw new Error("direct agent tool surface mismatch before model invocation");
      }
    } catch (error) {
      try {
        if (created.session.hasExtensionHandlers("session_shutdown")) {
          await created.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        }
      } finally {
        created.session.dispose();
      }
      throw error;
    }
    progressObserver.release = compactionProgress.observe(created.session);
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: SessionManager.create(cwd, parsed.sessionDir),
  });
  return { runtime, messages: parsed.messages };
}

export async function runDirectAgent(args: string[]): Promise<number> {
  const { runtime, messages } = await createDirectAgentRuntime(args);
  // Pi retains its native JSON framing, prompting, retry, compaction, extension
  // reload/replacement, signal handling and awaited session_shutdown lifecycle.
  return runPrintMode(runtime, { mode: "json", messages });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runDirectAgent(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write("Direct agent SDK setup failed\n");
      process.exitCode = 1;
    }
  );
}
