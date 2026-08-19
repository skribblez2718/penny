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

import { PiAgentClient, ssotBody, ssotModel, type InlineExtension } from "../model-client.js";
import { KNOWLEDGE_BASE_SKILL_CONTRACT } from "../playbooks/knowledge-base.js";
import { kbSessionSpec, type KbAgentRunner, type KbPhaseInvocation } from "./session-tools.js";

export type { KbAgentRunner, KbPhaseInvocation };
export { ssotModel };

async function optionalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
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
  readonly workerExtensions?: readonly InlineExtension[];
}

export class KbModelClient {
  private readonly client: PiAgentClient;

  constructor(private readonly options: KbModelClientOptions) {
    this.client = new PiAgentClient({
      ...(options.workerExtensions ? { workerExtensions: options.workerExtensions } : {}),
    });
  }

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
    const body = ssotBody(agentDoc);
    if (body.length === 0) {
      throw new Error(
        `KB phase '${invocation.stateId}': agent '${invocation.agent}' has an empty SSOT body; refusing to run`
      );
    }

    const model = this.options.modelOverride ?? ssotModel(agentDoc);
    if (model === undefined) {
      throw new Error(
        `KB phase '${invocation.stateId}': agent '${invocation.agent}' declares no 'model:' in its SSOT frontmatter; refusing to guess a model`
      );
    }

    const completion = await this.client.runAgent({
      agent: invocation.agent,
      stateId: invocation.stateId,
      task: invocation.phaseBrief,
      projectRoot,
      trustProfile: "hardened-untrusted",
      inputArtifacts: [],
      artifactConsumer: `kb:${invocation.stateId}`,
      modelOverride: model,
      guidance: KNOWLEDGE_BASE_SKILL_CONTRACT.guidance,
      session: kbSessionSpec({ invocation, agentBody: body }),
    });
    return completion.text;
  };
}
