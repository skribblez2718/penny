/**
 * KB agent runner — the live implementation of the `AgentRunner` contract
 * from ingest.ts.
 *
 * Creates one purpose-limited Pi SDK session per KB phase (§5.8 direction,
 * pragmatic slice):
 * - system context: the agent's SSOT body (.pi/agents/<agent>.md)
 * - grants NO tools: the phase's complete inputs (sources, prior phase output)
 *   are embedded in the task prompt and the phase output is a single JSON
 *   artifact body. The §5.8 private reader tools are the follow-on slice;
 *   this slice embeds instead of granting.
 * - model: pinned to an explicit `provider/model-id` (live E2E uses
 *   `ollama/qwen3.8:latest`), resolved through ModelRuntime with no network
 *   refresh of unrelated providers.
 *
 * Returns the JSON artifact body extracted from the assistant text. If no
 * well-formed JSON object is present, the invocation fails loudly — the
 * workflow stages nothing and no gate is presented.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ModelRuntime,
  SessionManager,
  createAgentSession,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

import { canonicalAssistantText, createWorkerResourceLoader } from "../model-client.js";
import { type AgentRunner } from "./ingest.js";

export interface KbModelClientOptions {
  readonly projectRoot: string;
  /** `provider/model-id`, e.g. `ollama/qwen3.8:latest`. */
  readonly model: string;
  /** Optional host-provided model resolution (mirrors PiAgentClientOptions). */
  readonly resolveModel?: (modelSpec: string) => Promise<unknown> | unknown;
  readonly workerExtensions?: readonly InlineExtension[];
}

async function optionalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "";
    throw error;
  }
}

/** Strip the frontmatter block; return the agent body only. */
function agentBody(agentDoc: string): string {
  const m = agentDoc.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u);
  return (m ? agentDoc.slice(m[0].length) : agentDoc).trim();
}

/**
 * Extract the JSON artifact body from assistant text.
 * Accepts a bare JSON object, or one object embedded in prose/markdown fences.
 * Fails when no single parseable object is present.
 */
export function extractJsonBody(text: string): string {
  const trimmed = text.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    /* fall through */
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = trimmed.slice(start, end + 1);
    const parsed = JSON.parse(candidate);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return candidate;
    }
  }
  throw new Error(
    `agent output contains no JSON artifact object (first 300 chars: ${trimmed.slice(0, 300)}…)`
  );
}

export class KbModelClient {
  constructor(private readonly options: KbModelClientOptions) {}

  /** The `AgentRunner` the KB workflows expect. */
  readonly run: AgentRunner = async ({ agent, task, stateId }) => {
    const { projectRoot, model } = this.options;
    const agentDocPath = path.join(projectRoot, ".pi", "agents", `${agent}.md`);
    const agentDoc = await optionalText(agentDocPath);
    if (agentDoc.trim().length === 0) {
      throw new Error(
        `KB phase '${stateId}': agent '${agent}' has no definition (${agentDocPath}); refuse to run without its SSOT body`
      );
    }

    const resourceLoader = await createWorkerResourceLoader(
      projectRoot,
      this.options.workerExtensions ?? []
    );
    type CreateSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
    const sessionOptions: CreateSessionOptions = {
      cwd: projectRoot,
      sessionManager: SessionManager.inMemory(projectRoot),
      resourceLoader,
      tools: [], // no tools: inputs embedded in the task, output is the JSON body
    };

    if (this.options.resolveModel !== undefined) {
      (sessionOptions as { model?: unknown }).model = await this.options.resolveModel(model);
    } else {
      const separator = model.indexOf("/");
      if (separator <= 0 || separator === model.length - 1) {
        throw new Error(`KB model '${model}' must be 'provider/model-id'`);
      }
      const provider = model.slice(0, separator);
      const modelId = model.slice(separator + 1);
      const runtime = await ModelRuntime.create();
      await runtime.refresh({ allowNetwork: false });
      const piModel = runtime.getModel(provider, modelId);
      if (piModel === undefined) {
        throw new Error(`KB model '${model}' is unavailable`);
      }
      (sessionOptions as { modelRuntime?: unknown }).modelRuntime = runtime;
      (sessionOptions as { model?: unknown }).model = piModel;
    }

    const { session } = await createAgentSession(sessionOptions);
    try {
      await session.prompt(
        [
          `You are executing the '${agent}' role in a knowledge-base ingest workflow (phase: ${stateId}).`,
          "AGENT CONTEXT:",
          agentBody(agentDoc),
          "TASK:",
          task,
          "Return EXACTLY the single JSON object the task specifies — no prose before or after it, no markdown fences, no commentary. Do not use tools; complete the task from the content given in this message.",
        ].join("\n\n"),
        { expandPromptTemplates: false, source: "rpc" }
      );
      const text = canonicalAssistantText(session.messages);
      return extractJsonBody(text);
    } finally {
      session.dispose();
    }
  };
}
