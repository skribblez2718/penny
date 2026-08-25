import type { CheckpointObservation, CheckpointObserver } from "./checkpointer.js";

export interface ObservabilityClientOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

function baseUrl(env: NodeJS.ProcessEnv): string {
  const candidate = env.PI_OBSERVABILITY_REST_URL;
  if (candidate?.startsWith("http://") || candidate?.startsWith("https://")) {
    return candidate.replace(/\/$/u, "");
  }
  return "http://127.0.0.1:8765";
}

export class ObservabilityClient {
  readonly observe: CheckpointObserver;
  private readonly enabled: boolean;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private circuitOpen = false;

  constructor(options: ObservabilityClientOptions = {}) {
    const env = options.env ?? process.env;
    this.enabled = env.PI_OBSERVABILITY_ENABLED !== "false";
    this.url = baseUrl(env);
    this.apiKey = env.PI_OBSERVABILITY_API_KEY ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 1_500;
    this.observe = (observation) => {
      void this.emit(observation);
    };
  }

  private async emit(observation: CheckpointObservation): Promise<void> {
    if (!this.enabled || this.circuitOpen) {
      return;
    }
    await this.post("/logs", {
      timestamp: observation.timestamp,
      level: ["error", "cancelled"].includes(observation.status) ? "ERROR" : "INFO",
      component: "orchestration",
      event: observation.eventType,
      session_id: observation.identity.session_id,
      client_id: "penny-orchestration",
      data: {
        run_id: observation.identity.run_id,
        playbook: observation.identity.playbook,
        status: observation.status,
        state_id: observation.stateId,
        sequence: observation.sequence,
        payload: observation.payload,
      },
    });
  }

  private async post(path: string, payload: unknown): Promise<void> {
    if (this.circuitOpen) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.url}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.circuitOpen = true;
      }
    } catch {
      this.circuitOpen = true;
    } finally {
      clearTimeout(timer);
    }
  }
}
