import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  defineTool,
  getAgentDir,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
export type { InlineExtension };
import { Type } from "typebox";

import {
  ConfidenceSchema,
  type ArtifactRef,
  type Confidence,
  type JsonValue,
  type SkillContract,
  validateContract,
} from "./contracts.js";
import { researchSummarySchema } from "./playbooks/research.js";

type CreateSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
type PiModel = NonNullable<CreateSessionOptions["model"]>;

export interface AgentInvocation {
  readonly agent: string;
  readonly stateId: string;
  readonly task: string;
  readonly projectRoot: string;
  readonly trustProfile: "trusted-interactive" | "hardened-untrusted";
  readonly inputArtifacts: readonly ArtifactRef[];
  readonly artifactConsumer: string;
  readonly signal?: AbortSignal;
  readonly modelOverride?: string;
  /**
   * W6: the active skill's guidance declaration. Optional so existing callers keep
   * working; when absent, resolution falls back to research's layout, which is exactly
   * what the hardcoded path did before.
   */
  readonly guidance?: SkillContract["guidance"];
}

/** W6 — the resolved worker posture. Tool authority still comes from the agent SSOT. */
export interface WorkerPostureV1 {
  readonly agentGuidancePath: string;
  readonly domainGuidancePath: string;
  readonly allowedTools: readonly string[];
}

/**
 * Default guidance declaration.
 *
 * Before W6 the domain-guidance path was the string literal
 * `.pi/skills/research/assets/prompts/<agent>.md`. Keeping research's values as the
 * fallback is what makes W6 a pure parameterization: with no contract supplied, the
 * resolver produces byte-identical paths to the pre-refactor code.
 */
export const DEFAULT_GUIDANCE: SkillContract["guidance"] = {
  skill_root: ".pi/skills/research/assets/prompts",
  resolution: "per_agent",
};

/**
 * W6 — resolve the domain-guidance file for one agent in one phase.
 *
 * `per_agent` yields `<agent>.md` (research today). `per_agent_phase` yields
 * `<agent>-<phase>.md`, which is the shape the knowledge-base prompts require
 * (agents-md-research §4.6) and is why the phase dimension exists now rather than later.
 */
export function resolveDomainGuidancePath(input: {
  projectRoot: string;
  agent: string;
  stateId: string;
  guidance?: SkillContract["guidance"];
}): string {
  const guidance = input.guidance ?? DEFAULT_GUIDANCE;
  const file =
    guidance.resolution === "per_agent_phase"
      ? `${input.agent}-${input.stateId}.md`
      : `${input.agent}.md`;
  return path.join(input.projectRoot, ...guidance.skill_root.split("/"), file);
}

export interface AgentCompletion {
  readonly text: string;
  readonly confidence?: Confidence;
  readonly details?: Record<string, JsonValue>;
}

export interface ModelClient {
  runAgent(invocation: AgentInvocation): Promise<AgentCompletion>;
}

/**
 * Owner-supplied extension factories to load into each worker session (e.g. a
 * worker-read, read-only memory factory). These supply capabilities that need
 * the owner's scoping (actor role, a minimal pinned env). They are NOT a tool
 * allow-list: the tools a worker may call come from the SSOT
 * (`.pi/agents/<agent>.md` `tools:`), exactly as the native agent-runner does
 * (the frontmatter `tools:` field is the control plane). The app stays agnostic
 * about the capability's domain.
 */
export interface PiAgentClientOptions {
  readonly resolveModel?: (modelId: string) => Promise<PiModel> | PiModel;
  readonly readArtifact?: (ref: ArtifactRef, consumer: string) => Promise<Buffer> | Buffer;
  readonly workerExtensions?: readonly InlineExtension[];
}

interface ParsedSummary {
  readonly confidence: Confidence;
  readonly details: Record<string, JsonValue>;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function balancedObject(text: string, start: number): string | undefined {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

export function parseSummaryFromText(text: string): ParsedSummary {
  const marker = text.lastIndexOf("SUMMARY:");
  if (marker < 0) {
    throw new Error("agent output is missing a SUMMARY: JSON object");
  }
  const objectStart = text.indexOf("{", marker + "SUMMARY:".length);
  if (objectStart < 0) {
    throw new Error("agent SUMMARY does not contain a JSON object");
  }
  const json = balancedObject(text, objectStart);
  if (json === undefined) {
    throw new Error("agent SUMMARY JSON object is incomplete");
  }
  const parsed = objectValue(JSON.parse(json), "agent SUMMARY");
  const confidence = validateContract(
    ConfidenceSchema,
    parsed.confidence ?? "UNCERTAIN",
    "agent confidence"
  );
  const details = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => key !== "confidence")
  ) as Record<string, JsonValue>;
  return { confidence, details };
}

export function canonicalAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = objectValue(messages[index], "agent message");
    if (message.role !== "assistant") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => objectValue(part, "assistant content part"))
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => String(part.text))
        .join("");
    }
  }
  throw new Error("agent session produced no assistant text");
}

// Under the `hardened-untrusted` trust profile a worker may read and gather but
// must not execute or mutate the (untrusted) target. With the allow-list now
// derived from the SSOT, these built-in execution/mutation tools are stripped
// (the native agent-runner enforces the same authority boundary).
const HARDENED_STRIP = new Set(["bash", "write", "edit"]);

const WORKER_EXTENSION_NAMES = new Set(["search", "youtube"]);

/**
 * Derive a worker's tool allow-list from the SSOT: the `tools:` frontmatter of
 * `.pi/agents/<agent>.md`. That file is the single source of truth for per-agent
 * tool authority (enforced by check_tool_profiles.py); the orchestration app
 * must not maintain a private per-agent table. Fails loudly rather than running
 * a worker with an empty or guessed allow-list.
 */
export function parseSsotTools(agentDoc: string, agent: string): readonly string[] {
  if (agentDoc.trim().length === 0) {
    throw new Error(
      `agent '${agent}' has no definition (.pi/agents/${agent}.md missing); its SSOT 'tools:' allow-list is required`
    );
  }
  const frontmatter = agentDoc.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const region = frontmatter?.[1] ?? agentDoc;
  const line = region.split(/\r?\n/).find((candidate) => candidate.startsWith("tools:"));
  if (line === undefined) {
    throw new Error(
      `agent '${agent}' declares no top-level 'tools:' in .pi/agents/${agent}.md; the SSOT is required and must not be bypassed`
    );
  }
  const names = line
    .slice(line.indexOf(":") + 1)
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    throw new Error(
      `agent '${agent}' has an empty 'tools:' list; refusing to run with no declared authority`
    );
  }
  return [...new Set(names)];
}

export async function createWorkerResourceLoader(
  projectRoot: string,
  extensionFactories: readonly InlineExtension[] = []
) {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(projectRoot, agentDir);
  const loader = new DefaultResourceLoader({
    cwd: projectRoot,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(extensionFactories.length > 0 ? { extensionFactories: [...extensionFactories] } : {}),
    extensionsOverride(base) {
      const extensions = base.extensions.filter((extension) => {
        // Owner-supplied inline grants are always kept: the execution owner decides
        // what a worker may use (e.g. read-only memory). Only *file* extensions are
        // restricted to the worker-safe set so no other on-disk extension leaks in.
        if (extension.path.startsWith("<inline:")) {
          return true;
        }
        const parent = path.basename(path.dirname(extension.resolvedPath));
        return WORKER_EXTENSION_NAMES.has(parent);
      });
      const allowedPaths = new Set(
        extensions.flatMap((extension) => [extension.path, extension.resolvedPath])
      );
      return {
        ...base,
        extensions,
        errors: base.errors.filter((error) => allowedPaths.has(error.path)),
      };
    },
  });
  await loader.reload();
  return loader;
}

async function optionalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export class PiAgentClient implements ModelClient {
  constructor(private readonly options: PiAgentClientOptions = {}) {}

  async runAgent(invocation: AgentInvocation): Promise<AgentCompletion> {
    const summarySchema = researchSummarySchema(invocation.stateId);
    const ToolParameters = Type.Object(
      {
        confidence: Type.String({
          pattern: "^(CERTAIN|PROBABLE|POSSIBLE|UNCERTAIN)$",
        }),
        details: summarySchema,
      },
      { additionalProperties: false }
    );
    let captured: ParsedSummary | undefined;
    const readArtifact = this.options.readArtifact;
    const resultTool = defineTool({
      name: "submit_orchestration_result",
      label: "Submit orchestration result",
      description:
        "Submit the typed routing result for this phase exactly once after completing the task.",
      promptSnippet: "Submit the typed result for the current orchestration phase.",
      promptGuidelines: [
        "Call submit_orchestration_result exactly once after the complete stage output is ready.",
      ],
      parameters: ToolParameters,
      async execute(_toolCallId, params) {
        if (captured !== undefined) {
          throw new Error("phase result was already submitted");
        }
        const confidence = validateContract(ConfidenceSchema, params.confidence, "tool confidence");
        const details = validateContract(
          summarySchema,
          params.details,
          `${invocation.stateId} tool result`
        ) as Record<string, JsonValue>;
        captured = { confidence, details };
        return {
          content: [
            {
              type: "text" as const,
              text: "Typed phase result accepted. Finish with the complete stage output.",
            },
          ],
          details: { accepted: true },
        };
      },
    });

    const artifactTool = defineTool({
      name: "artifact_read",
      label: "Read exact artifact",
      description:
        "Read one exact task-granted artifact. Continue from next_offset until truncated is false.",
      parameters: Type.Object(
        {
          artifact_id: Type.String({ pattern: "^art_[a-f0-9]{64}$" }),
          offset: Type.Optional(Type.Integer({ minimum: 0 })),
        },
        { additionalProperties: false }
      ),
      async execute(_toolCallId, params) {
        const ref = invocation.inputArtifacts.find(
          (candidate) => candidate.artifact_id === params.artifact_id
        );
        if (ref === undefined) {
          throw new Error(`artifact '${params.artifact_id}' is not granted`);
        }
        if (readArtifact === undefined) {
          throw new Error("artifact reader is not configured");
        }
        const bytes = await readArtifact(ref, invocation.artifactConsumer);
        const offset = params.offset ?? 0;
        if (offset > bytes.length) {
          throw new Error("artifact offset exceeds byte length");
        }
        let end = Math.min(bytes.length, offset + 48_000);
        while (end > offset && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
          end -= 1;
        }
        const truncated = end < bytes.length;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                artifact_id: ref.artifact_id,
                offset,
                next_offset: end,
                truncated,
                text: bytes.subarray(offset, end).toString("utf8"),
              }),
            },
          ],
          details: { nextOffset: end, truncated },
        };
      },
    });

    const agentGuidance = await optionalText(
      path.join(invocation.projectRoot, ".pi", "agents", `${invocation.agent}.md`)
    );
    // W6: contract-resolved, not hardcoded. With no contract supplied this produces the
    // exact path the previous string literal produced.
    const domainGuidance = await optionalText(
      resolveDomainGuidancePath({
        projectRoot: invocation.projectRoot,
        agent: invocation.agent,
        stateId: invocation.stateId,
        ...(invocation.guidance ? { guidance: invocation.guidance } : {}),
      })
    );
    // The worker's tool authority comes from the SSOT (.pi/agents/<agent>.md),
    // not from a private table in the app. The result tool is always added. Under
    // hardened-untrusted, built-in execution/mutation tools are stripped.
    const ssotTools = parseSsotTools(agentGuidance, invocation.agent);
    const allowed = (
      invocation.trustProfile === "hardened-untrusted"
        ? ssotTools.filter((tool) => !HARDENED_STRIP.has(tool))
        : [...ssotTools]
    ).concat("submit_orchestration_result");
    const resourceLoader = await createWorkerResourceLoader(
      invocation.projectRoot,
      this.options.workerExtensions ?? []
    );
    const sessionOptions: CreateSessionOptions = {
      cwd: invocation.projectRoot,
      sessionManager: SessionManager.inMemory(invocation.projectRoot),
      resourceLoader,
      tools: allowed,
      customTools: [resultTool, ...(invocation.inputArtifacts.length > 0 ? [artifactTool] : [])],
    };
    if (invocation.modelOverride !== undefined) {
      if (this.options.resolveModel !== undefined) {
        sessionOptions.model = await this.options.resolveModel(invocation.modelOverride);
      } else {
        const separator = invocation.modelOverride.indexOf("/");
        if (separator <= 0 || separator === invocation.modelOverride.length - 1) {
          throw new Error(`model override '${invocation.modelOverride}' must be provider/model-id`);
        }
        const provider = invocation.modelOverride.slice(0, separator);
        const modelId = invocation.modelOverride.slice(separator + 1);
        const runtime = await ModelRuntime.create();
        await runtime.refresh({ allowNetwork: false });
        const model = runtime.getModel(provider, modelId);
        if (model === undefined) {
          throw new Error(`model override '${invocation.modelOverride}' is unavailable`);
        }
        sessionOptions.modelRuntime = runtime;
        sessionOptions.model = model;
      }
    }

    const { session } = await createAgentSession(sessionOptions);
    const abort = (): void => {
      void session.abort();
    };
    invocation.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (invocation.signal?.aborted) {
        throw new Error("agent invocation aborted before prompt");
      }
      await session.prompt(
        [
          `You are executing the '${invocation.agent}' role in a durable research workflow.`,
          agentGuidance,
          domainGuidance,
          "TASK:",
          invocation.task,
          invocation.inputArtifacts.length > 0
            ? `GRANTED INPUT ARTIFACTS:\n${invocation.inputArtifacts
                .map((ref) => JSON.stringify(ref))
                .join("\n")}\nRead each with artifact_read before working.`
            : "GRANTED INPUT ARTIFACTS: none.",
          "Return the complete stage output in assistant text. Use the result tool for routing metadata.",
        ]
          .filter((part) => part.length > 0)
          .join("\n\n"),
        { expandPromptTemplates: false, source: "rpc" }
      );
      const text = canonicalAssistantText(session.messages);
      if (captured === undefined) {
        // The execution owner persists exact assistant bytes before parsing fallback
        // SUMMARY text. WorkerExecutor performs that parse after artifact persistence.
        return { text };
      }
      return {
        text,
        confidence: captured.confidence,
        details: captured.details,
      };
    } finally {
      invocation.signal?.removeEventListener("abort", abort);
      session.dispose();
    }
  }
}
