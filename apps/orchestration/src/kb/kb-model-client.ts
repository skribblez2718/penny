/**
 * KB agent runner — a thin adapter over the shared session runner.
 *
 * This module used to stand up its own pi session, model runtime, resource
 * loader, and result handling: a second copy of `model-client.ts` living inside
 * the KB. That was the proliferation failure the universal-skills Foundation
 * stage exists to prevent, and it left KB outside every seam the engine owns.
 *
 * What remains here is only what is genuinely KB-specific:
 *
 * - **Model policy.** Each agent runs on the model declared in its SSOT
 *   frontmatter (`.pi/agents/<agent>.md` `model:`). A phase whose agent declares
 *   no model refuses to run rather than guessing. An explicit `modelOverride` is
 *   a TEST-ONLY escape hatch; production callers leave it unset.
 * - **Guidance.** Phase briefs resolve through the KB skill contract
 *   (`per_agent_phase` → `.pi/skills/knowledge-base/assets/prompts/<agent>-<phase>.md`),
 *   which is the W6 seam built for exactly this shape.
 *
 * The §5.8 private-reader posture lives in `session-tools.ts`, and the session
 * itself is run by `PiAgentClient`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  PiAgentClient,
  resolveDomainGuidancePath,
  ssotModel,
  type AgentSessionTraceSink,
  type SessionThinkingLevel,
} from "../model-client.js";
import { kbSessionSpec, type KbAgentRunner, type KbPhaseInvocation } from "./session-tools.js";

export type { KbAgentRunner, KbPhaseInvocation };
export { ssotModel };

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function optionalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "";
    throw error;
  }
}

export interface KbModelClientOptions {
  readonly projectRoot: string;
  /**
   * TEST-ONLY explicit override (`provider/model-id` or catalog alias).
   * Production leaves this unset; the per-agent SSOT `model:` field wins.
   */
  readonly modelOverride?: string;
  /** TEST-ONLY; production preserves the Pi/settings thinking default. */
  readonly testOnlyThinkingLevelOverride?: SessionThinkingLevel;
  /** Optional content-free lifecycle diagnostics; raw session events never escape PiAgentClient. */
  readonly sessionTrace?: AgentSessionTraceSink;
}

export class KbModelClient {
  private readonly client: PiAgentClient;

  constructor(private readonly options: KbModelClientOptions) {
    this.client = new PiAgentClient({
      ...(options.testOnlyThinkingLevelOverride === undefined
        ? {}
        : { testOnlyThinkingLevelOverride: options.testOnlyThinkingLevelOverride }),
    });
  }

  /** The runner the KB workflows expect. */
  readonly run: KbAgentRunner = async (invocation: KbPhaseInvocation) => {
    const { projectRoot } = this.options;
    const registration = invocation.registration;
    if (
      registration === undefined ||
      registration.playbook_name !== "knowledge-base" ||
      registration.workflow_name !== "knowledge-base" ||
      registration.result_transport !== "host_typed" ||
      registration.model_policy !== "host_private_ssot_model"
    ) {
      throw new Error(
        `KB phase '${invocation.stateId}' has no matching active host-private registration`
      );
    }
    const docPath = path.join(projectRoot, ".pi", "agents", `${invocation.agent}.md`);
    const agentDoc = await optionalText(docPath);
    if (agentDoc.trim().length === 0) {
      throw new Error(
        `KB phase '${invocation.stateId}': agent '${invocation.agent}' has no definition (${docPath}); refuse to run without its SSOT`
      );
    }
    // W6: the phase's guidance comes from the contract's prompt root, not from a
    // literal in this file. Missing guidance is a refusal: an inline fallback is
    // how the prompts drifted out of the skill in the first place.
    const guidancePath = resolveDomainGuidancePath({
      projectRoot,
      agent: invocation.agent,
      stateId: invocation.stateId,
      guidance: registration.guidance,
    });
    const phaseGuidance = await optionalText(guidancePath);
    if (phaseGuidance.trim().length === 0) {
      throw new Error(
        `KB phase '${invocation.stateId}': no guidance at ${guidancePath}; refusing to run a KB phase without its declared prompt`
      );
    }

    const model = this.options.modelOverride ?? ssotModel(agentDoc);
    if (model === undefined) {
      throw new Error(
        `KB phase '${invocation.stateId}': agent '${invocation.agent}' declares no 'model:' in its SSOT frontmatter; refusing to guess a model`
      );
    }
    const cognitiveFrame = await optionalText(path.join(projectRoot, ".pi", "SYSTEM.md"));
    if (cognitiveFrame.trim().length === 0) {
      throw new Error(
        `KB phase '${invocation.stateId}': Cognitive Frame is unavailable; refusing to build a partial private session`
      );
    }

    const session = kbSessionSpec({
      invocation,
      cognitiveFrame,
      phaseGuidance,
    });

    // This private, host-tool-matrix session is deliberately anonymous. It is
    // not an invocation of the catalog agent whose model/quality guidance was
    // consulted above, so it cannot claim that role while replacing YAML tools.
    const completion = await this.client.runAgent({
      agent: `kb-private-${invocation.stateId}`,
      stateId: invocation.stateId,
      task: invocation.phaseBrief,
      projectRoot,
      trustProfile: "hardened-untrusted",
      inputArtifacts: [],
      ...(invocation.signal ? { signal: invocation.signal } : {}),
      ...(invocation.liveness ? { liveness: invocation.liveness } : {}),
      modelOverride: model,
      registration,
      // §5.3: the alias above is not an identity. The runtime resolves it, then
      // this hook admits the resolved tuple BEFORE any session exists.
      ...(invocation.admitModel ? { admitResolvedModel: invocation.admitModel } : {}),
      session:
        this.options.sessionTrace === undefined
          ? session
          : { ...session, trace: this.options.sessionTrace },
    });
    return completion.text;
  };
}
