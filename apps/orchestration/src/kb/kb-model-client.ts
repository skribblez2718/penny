/**
 * KB agent runner (§5.8 direction, pragmatic slice) — the LIVE implementation
 * of the `AgentRunner` contract from ingest.ts.
 *
 * MODEL POLICY (production default):
 * - Each agent runs on the model declared in its SSOT frontmatter
 *   (.pi/agents/<agent>.md, `model:`), resolved through the pi model catalog
 *   (aliases such as `sol`/`terra` resolve to their provider/model).
 * - An explicit `modelOverride` is a TEST-ONLY escape hatch; production
 *   callers never set it. The SSOT `model:` field is required (like `tools:`)
 *   — a phase without a declared model refuses to run rather than guessing.
 *
 * SESSION POSTURE (§5.8):
 * - Purpose-built, host-closed custom tools only:
 *     read_phase_brief()      — the phase instruction brief (output contract)
 *     read_source_snapshot({source_id}) — admitted source content, ONLY for
 *                            source IDs in the per-phase allowlist
 *     read_phase_output({phase})        — a prior phase's sealed output, ONLY
 *                            for phases allowed for this state
 *     submit_phase_result({body}) — the typed phase result, exactly once
 * - No built-in tools are granted (tools: []), and NO private body is embedded
 *   in the system prompt or opening message: inputs arrive exclusively through
 *   the readers, outputs exclusively through the typed submission.
 * - If the session ends without a submission, the invocation fails loudly.
 *   The workflow stages nothing and presents no gate.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import {
  ModelRuntime,
  SessionManager,
  createAgentSession,
  defineTool,
  resolveModelScopeWithDiagnostics,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

import { canonicalAssistantText, createWorkerResourceLoader } from "../model-client.js";

// ── Runner contract (consumed by ingest.ts) ─────────────────────────────────

/** One host-controlled phase input surface for a single agent invocation. */
export interface KbPhaseInvocation {
  readonly agent: string;
  readonly stateId: string;
  /** Instruction brief: role for this phase + the exact output contract. */
  readonly phaseBrief: string;
  /** Source IDs the `read_source_snapshot` reader may serve for this phase. */
  readonly sourceAllowlist: readonly string[];
  /** Prior phase state-ids the `read_phase_output` reader may serve. */
  readonly priorPhaseAllowlist: readonly string[];
  /** Host closure: read one admitted source's content. Called ONLY for allowlisted IDs. */
  readonly readSource: (sourceId: string) => string;
  /** Host closure: read one prior phase's output (by state id). */
  readonly readPhaseOutput: (stateId: string) => string;
}

export type KbAgentRunner = (invocation: KbPhaseInvocation) => Promise<string>;

// ── SSOT parsing ────────────────────────────────────────────────────────────

async function optionalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "";
    throw error;
  }
}

function frontmatter(agentDoc: string): string {
  const m = agentDoc.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  return m?.[1] ?? "";
}

/** The agent's SSOT-declared model (required). Returns undefined when absent. */
export function ssotModel(agentDoc: string): string | undefined {
  const line = frontmatter(agentDoc)
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith("model:"));
  const value = line?.slice(line.indexOf(":") + 1).trim();
  return value && value.length > 0 ? value : undefined;
}

function agentBody(agentDoc: string): string {
  const m = agentDoc.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u);
  return (m ? agentDoc.slice(m[0].length) : agentDoc).trim();
}

// ── Client ──────────────────────────────────────────────────────────────────

export interface KbModelClientOptions {
  readonly projectRoot: string;
  /**
   * TEST-ONLY explicit override (`provider/model-id` or catalog alias).
   * Production leaves this unset; the per-agent SSOT `model:` field wins.
   */
  readonly modelOverride?: string;
  readonly workerExtensions?: readonly InlineExtension[];
}

export class KbModelClient {
  private cachedRuntime: { runtime: ModelRuntime } | undefined;

  constructor(private readonly options: KbModelClientOptions) {}

  /** The runner the KB workflows expect. */
  readonly run: KbAgentRunner = async (invocation: KbPhaseInvocation) => {
    const { projectRoot } = this.options;
    const docPath = path.join(projectRoot, ".pi", "agents", `${invocation.agent}.md`);
    const agentDoc = await optionalText(docPath);
    if (agentDoc.trim().length === 0) {
      throw new Error(
        `KB phase '${invocation.stateId}': agent '${invocation.agent}' has no definition (${docPath}); refuse to run without its SSOT`
      );
    }
    const body = agentBody(agentDoc);
    if (body.length === 0) {
      throw new Error(
        `KB phase '${invocation.stateId}': agent '${invocation.agent}' has an empty SSOT body; refusing to run`
      );
    }

    // ── Model policy: SSOT frontmatter first; explicit override is test-only ──
    const modelPattern = this.options.modelOverride ?? ssotModel(agentDoc);
    if (modelPattern === undefined) {
      throw new Error(
        `KB phase '${invocation.stateId}': agent '${invocation.agent}' declares no 'model:' in its SSOT frontmatter; refusing to guess a model`
      );
    }

    let runtime: ModelRuntime;
    if (this.cachedRuntime?.runtime) {
      runtime = this.cachedRuntime.runtime;
    } else {
      runtime = await ModelRuntime.create();
      await runtime.refresh({ allowNetwork: false });
      this.cachedRuntime = { runtime };
    }
    const resolved = await resolveModelScopeWithDiagnostics([modelPattern], runtime);
    if (resolved.scopedModels.length === 0) {
      throw new Error(
        `KB phase '${invocation.stateId}': model '${modelPattern}' (${this.options.modelOverride === undefined ? "SSOT declaration" : "test override"}) does not resolve to an available model`
      );
    }
    const piModel = resolved.scopedModels[0]!.model;

    // ── Host-closed readers + typed submission ───────────────────────────────
    const allowSources = new Set(invocation.sourceAllowlist);
    const allowPrior = new Set(invocation.priorPhaseAllowlist);
    let submitted: string | undefined;

    const briefTool = defineTool({
      name: "read_phase_brief",
      label: "Read phase brief",
      description: "Read the instruction brief and output contract for this phase.",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() {
        return {
          content: [{ type: "text" as const, text: invocation.phaseBrief }],
          details: {},
        };
      },
    });

    const sourceTool = defineTool({
      name: "read_source_snapshot",
      label: "Read source snapshot",
      description:
        "Read the full content of one ADMISSION allowlisted source. Accepts a source_id only; never a path.",
      parameters: Type.Object(
        { source_id: Type.String({ minLength: 1, maxLength: 128 }) },
        { additionalProperties: false }
      ),
      async execute(_id, params) {
        const sourceId = String(params.source_id);
        if (!allowSources.has(sourceId)) {
          throw new Error(
            `source '${sourceId}' is not in this phase's admission allowlist; refuse`
          );
        }
        return {
          content: [{ type: "text" as const, text: invocation.readSource(sourceId) }],
          details: { source_id: sourceId, bytes: invocation.readSource(sourceId).length },
        };
      },
    });

    const priorTool = defineTool({
      name: "read_phase_output",
      label: "Read prior phase output",
      description: "Read the exact output of one allowed earlier phase (by phase state id).",
      parameters: Type.Object(
        { phase: Type.String({ minLength: 1, maxLength: 128 }) },
        { additionalProperties: false }
      ),
      async execute(_id, params) {
        const phase = String(params.phase);
        if (!allowPrior.has(phase)) {
          throw new Error(`phase '${phase}' is not in this state's prior-phase allowlist; refuse`);
        }
        const text = invocation.readPhaseOutput(phase);
        return { content: [{ type: "text" as const, text }], details: { phase } };
      },
    });

    const submitTool = defineTool({
      name: "submit_phase_result",
      label: "Submit phase result",
      description:
        "Submit the typed phase result EXACTLY ONCE. `body` must be one JSON object (a string) matching the brief's output contract.",
      parameters: Type.Object(
        { body: Type.String({ minLength: 2, maxLength: 1_048_576 }) },
        { additionalProperties: false }
      ),
      async execute(_id, params) {
        if (submitted !== undefined) {
          throw new Error("phase result was already submitted");
        }
        const raw = String(params.body);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error("phase result body is not valid JSON");
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("phase result body must be a single JSON object");
        }
        submitted = raw;
        return {
          content: [{ type: "text" as const, text: "Typed phase result accepted." }],
          details: { accepted: true, bytes: raw.length },
        };
      },
    });

    const resourceLoader = await createWorkerResourceLoader(
      projectRoot,
      this.options.workerExtensions ?? []
    );
    type CreateSessionOptions = NonNullable<Parameters<typeof createAgentSession>[0]>;
    const sessionOptions: CreateSessionOptions = {
      cwd: projectRoot,
      sessionManager: SessionManager.inMemory(projectRoot),
      resourceLoader,
      noTools: "builtin", // only the purpose-built reader/submit tools are exposed
      customTools: [briefTool, sourceTool, priorTool, submitTool],
    };
    (sessionOptions as { modelRuntime?: unknown }).modelRuntime = runtime;
    (sessionOptions as { model?: unknown }).model = piModel;

    const opening = [
      `You are executing the '${invocation.agent}' role in a knowledge-base ingest workflow (phase: ${invocation.stateId}).`,
      "AGENT CONTEXT (SSOT):",
      body,
      "PHASE RULES:",
      "- Gather ALL inputs through the reader tools: read_phase_brief, read_source_snapshot (admission allowlist), read_phase_output (allowed prior phases).",
      "- Complete the phase entirely from reader output. Do not assume paths, files, or content you were not given.",
      "Return your result by calling submit_phase_result EXACTLY ONCE with the single JSON object the brief specifies. No prose result is accepted.",
    ].join("\n\n");

    const { session } = await createAgentSession(sessionOptions);
    try {
      await session.prompt(opening, { expandPromptTemplates: false, source: "rpc" });
      if (submitted !== undefined) {
        return submitted;
      }
      // Fail loudly: capture the assistant tail for diagnostics, but do NOT
      // accept an untyped text result (contract violation).
      const tail = safeTail(session.messages);
      throw new Error(
        `KB phase '${invocation.stateId}' (agent '${invocation.agent}') ended without submit_phase_result. Assistant tail: ${tail}`
      );
    } finally {
      session.dispose();
    }
  };
}

function safeTail(messages: readonly unknown[]): string {
  try {
    return canonicalAssistantText(messages).slice(0, 400);
  } catch {
    return "(no assistant text)";
  }
}
