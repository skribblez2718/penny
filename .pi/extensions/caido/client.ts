/** Caido SDK client singleton with InMemoryTokenCache */

import { Client } from "@caido/sdk-client";
import type { CaidoConfig, CaidoErrorClassification, TokenCache } from "./types.js";

export function classifyCaidoError(err: Error): CaidoErrorClassification {
  const msg = err.message || String(err);
  if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND")) {
    return {
      category: "CONNECTION_REFUSED",
      userMessage:
        "Cannot connect to Caido at the configured URL. Please verify Caido is running and the URL is correct.",
      retryable: true,
    };
  }
  if (msg.includes("not ready")) {
    return {
      category: "NOT_READY",
      userMessage:
        "Caido is not ready. It may still be initializing. Please wait a moment and try again.",
      retryable: true,
    };
  }
  if (msg.includes("401") || msg.includes("Unauthorized") || msg.includes("authentication")) {
    return {
      category: "AUTH_FAILURE",
      userMessage: "Authentication failed. Please verify CAIDO_PAT is set correctly in .env.",
      retryable: false,
    };
  }
  if (msg.includes("timeout") || msg.includes("ETIMEDOUT")) {
    return {
      category: "TIMEOUT",
      userMessage:
        "Request to Caido timed out. Please check your network connection or try again later.",
      retryable: true,
    };
  }
  return {
    category: "UNKNOWN",
    userMessage: `An unexpected error occurred: ${msg}`,
    retryable: false,
  };
}

export function loadConfig(): CaidoConfig {
  return {
    url: process.env.CAIDO_URL || "http://localhost:8080",
    pat: process.env.CAIDO_PAT || "",
  };
}

/** Simple in-memory token cache for SDK authentication */
export class InMemoryTokenCache implements TokenCache {
  private _token: { accessToken: string; refreshToken?: string; expiresAt?: string } | null = null;

  async load(): Promise<
    { accessToken: string; refreshToken?: string; expiresAt?: string } | undefined
  > {
    return this._token ?? undefined;
  }

  async save(token: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: string;
  }): Promise<void> {
    this._token = token;
  }

  async clear(): Promise<void> {
    this._token = null;
  }
}

let _client: Client | null = null;

export async function getClient(): Promise<Client> {
  if (_client) return _client;

  const config = loadConfig();

  _client = new Client({
    url: config.url,
    auth: { pat: config.pat, cache: new InMemoryTokenCache() },
  });

  try {
    await _client.connect({ ready: { retries: 3, timeout: 5000, interval: 1000 } });
  } catch (err) {
    _client = null;
    throw err;
  }

  return _client;
}

export function resetClient(): void {
  _client = null;
}

export interface WithCaidoClientDeps {
  acquireSemaphore: () => Promise<void>;
  releaseSemaphore: () => void;
  logger: { error: (msg: string, ctx?: Record<string, unknown>) => void };
}

export async function withCaidoClient<T>(
  toolName: string,
  config: CaidoConfig,
  deps: WithCaidoClientDeps,
  fn: () => Promise<T>
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: T; isError?: boolean }> {
  if (!config.pat) {
    return {
      content: [{ type: "text", text: "Error: CAIDO_PAT not set. Configure CAIDO_PAT in .env." }],
      isError: true,
    };
  }

  await deps.acquireSemaphore();
  try {
    const result = await fn();
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text", text }], details: result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const classification = classifyCaidoError(err instanceof Error ? err : new Error(msg));
    deps.logger.error(`${toolName} failed`, { error: msg, category: classification.category });
    return {
      content: [{ type: "text", text: `Error: ${classification.userMessage}` }],
      isError: true,
    };
  } finally {
    deps.releaseSemaphore();
  }
}
