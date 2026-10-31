import type { OrchestrationService, Directive } from "@penny/orchestration";
import { prepareVideogenPlaybackUi } from "./videogen-human-review-driver.js";
import { createLogger } from "../../lib/logger/logger.js";

const logger = createLogger("playbook-ui");

export interface PreparedPlaybookUi {
  readonly capability: string;
  readonly text: string;
  dispose(): void;
}
export interface PlaybookUiInput {
  readonly service: OrchestrationService;
  readonly directive: Extract<Directive, { action: "await_user" }>;
  /** Release the retained service and all UI resources; idempotent. */
  release(): void;
}
type PlaybookUiProvider = (input: PlaybookUiInput) => Promise<PreparedPlaybookUi | undefined>;

/** Fixed compiled machine-interface mapping, not prompt/keyword-selected routing. Providers only
 * present an existing engine wait. They cannot dispatch workers or answer another human gate. */
const PROVIDERS: ReadonlyMap<string, PlaybookUiProvider> = new Map([
  ["videogen", prepareVideogenPlaybackUi],
]);

/** Session-local resource custody for the existing generic clarification route. Durable workflow
 * truth remains in the engine. Nothing here is serialized or reconstructed after restart. */
export class PlaybookUiOwner {
  private readonly pending = new Map<string, () => void>();

  assertAvailable(projectRoot: string, runId: string): void {
    if (this.pending.has(`${projectRoot}\0${runId}`))
      throw new Error(
        "finish or cancel the existing trusted questionnaire before continuing this run"
      );
  }

  async prepare(input: {
    service: OrchestrationService;
    directive: Extract<Directive, { action: "await_user" }>;
    projectRoot: string;
  }): Promise<PreparedPlaybookUi | undefined> {
    const provider = PROVIDERS.get(input.directive.identity.playbook);
    if (provider === undefined) return undefined;
    const key = `${input.projectRoot}\0${input.directive.identity.run_id}`;
    this.assertAvailable(input.projectRoot, input.directive.identity.run_id);
    if (this.pending.size >= 128) throw new Error("pending native UI limit");
    let prepared: PreparedPlaybookUi | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.pending.delete(key);
      try {
        try {
          prepared?.dispose();
        } finally {
          input.service.close();
        }
      } catch (error) {
        // Revocation is already committed. A timer/HTTP close must not cause an unhandled
        // rejection or keep another session resource alive if finalization reports failure.
        logger.warn("native_ui_finalization_failed", {
          reason: error instanceof Error ? error.name : "unknown",
        });
      }
    };
    this.pending.set(key, release);
    try {
      prepared = await provider({ ...input, release });
      if (prepared === undefined) {
        // Ownership did not transfer: the invoking route still closes its service.
        this.pending.delete(key);
        return undefined;
      }
      if (released) {
        prepared.dispose();
        throw new Error("native UI cancelled during preparation");
      }
      return prepared;
    } catch (error) {
      release();
      throw error;
    }
  }

  close(): void {
    for (const release of [...this.pending.values()]) release();
  }
}
