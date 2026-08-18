import type { CheckpointObservation, CheckpointObserver } from "./checkpointer.js";

export interface ObservabilityClientOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

function baseUrl(env: NodeJS.ProcessEnv): string {
  for (const candidate of [env.PI_OBSERVABILITY_REST_URL, env.PI_OBSERVABILITY_URL]) {
    if (candidate?.startsWith("http://") || candidate?.startsWith("https://")) {
      return candidate.replace(/\/$/, "");
    }
  }
  return "http://localhost:8765";
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
    if (observation.eventType === "run_started") {
      await this.post("/orchestration/runs", {
        run_id: observation.identity.run_id,
        session_id: observation.identity.session_id,
        playbook: observation.identity.playbook,
        goal_sha256: observation.payload.goal_sha256,
        goal_bytes: observation.payload.goal_bytes,
        status: observation.status,
        started_at: observation.timestamp,
      });
    }
    await this.post("/orchestration/events", {
      events: [
        {
          run_id: observation.identity.run_id,
          session_id: observation.identity.session_id,
          seq: observation.sequence,
          event_type: observation.eventType,
          state_id: observation.stateId,
          primitive:
            typeof observation.payload.state_id === "string" ? observation.payload.state_id : null,
          agent: typeof observation.payload.agent === "string" ? observation.payload.agent : null,
          data: observation.payload,
          timestamp: observation.timestamp,
        },
      ],
    });
    if (["complete", "incomplete", "error", "cancelled"].includes(observation.status)) {
      await this.post("/orchestration/runs", {
        run_id: observation.identity.run_id,
        session_id: observation.identity.session_id,
        status: observation.status,
        ended_at: observation.timestamp,
        met: observation.status === "complete",
      });
    }
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
