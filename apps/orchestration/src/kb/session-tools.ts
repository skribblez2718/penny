/**
 * KB private-reader session tools (§5.8).
 *
 * These are the *only* tools a KB phase agent holds. The session grants no
 * built-in tool authority, and no private body is ever placed in a prompt:
 * inputs arrive exclusively through these readers and the result leaves
 * exclusively through the typed submission.
 *
 * The tools close over host state (the per-phase admitted-source allowlist, the
 * prior-phase allowlist, and the reader closures), which is why they are built
 * here by the dispatcher and handed to the shared session runner rather than
 * being constructed inside it. The runner stays agnostic about KB; KB keeps its
 * own privacy contract.
 */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

import type { AgentSessionSpecV1 } from "../model-client.js";

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
  /**
   * §5.3 child admission. Called with the RESOLVED provider/model immediately
   * before the session is created; throwing denies the phase with no session
   * created and no private body read.
   */
  readonly admitModel?: (resolved: { provider: string; model: string }) => void;
}

export type KbAgentRunner = (invocation: KbPhaseInvocation) => Promise<string>;

/**
 * Build the §5.8 session posture for one phase invocation.
 *
 * The returned spec is what the shared `PiAgentClient` needs to run a KB phase:
 * no built-in tools, exactly four host-closed tools, a KB opening, and a result
 * contract that fails loudly rather than accepting prose.
 */
export function kbSessionSpec(input: {
  invocation: KbPhaseInvocation;
  /** The agent's SSOT body, used for role context in the opening. */
  agentBody: string;
  /**
   * The phase's guidance, resolved from the KB skill contract
   * (`per_agent_phase` → `<agent>-<phase>.md`). Required: a phase whose guidance
   * file is missing must refuse rather than fall back to an inline prompt, or the
   * contract's guidance root becomes decorative again.
   */
  phaseGuidance: string;
}): AgentSessionSpecV1 {
  const { invocation } = input;
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
        throw new Error(`source '${sourceId}' is not in this phase's admission allowlist; refuse`);
      }
      const text = invocation.readSource(sourceId);
      return {
        content: [{ type: "text" as const, text }],
        details: { source_id: sourceId, bytes: text.length },
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

  return {
    noTools: "builtin",
    customTools: [briefTool, sourceTool, priorTool, submitTool],
    opening: [
      `You are executing the '${invocation.agent}' role in a knowledge-base workflow (phase: ${invocation.stateId}).`,
      "AGENT CONTEXT (SSOT):",
      input.agentBody,
      "PHASE GUIDANCE:",
      input.phaseGuidance,
      "PHASE RULES:",
      "- Gather ALL inputs through the reader tools: read_phase_brief, read_source_snapshot (admission allowlist), read_phase_output (allowed prior phases).",
      "- Complete the phase entirely from reader output. Do not assume paths, files, or content you were not given.",
      "Return your result by calling submit_phase_result EXACTLY ONCE with the single JSON object the brief specifies. No prose result is accepted.",
    ].join("\n\n"),
    readResult: () => submitted,
    requireResultMessage: `KB phase '${invocation.stateId}' (agent '${invocation.agent}') ended without submit_phase_result`,
  };
}
