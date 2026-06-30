/** Shared types for Caido extension tools */

export interface OutputOpts {
  maxBodyLines: number;
  maxBodyChars: number;
  noRequest: boolean;
  headersOnly: boolean;
}

export const DEFAULT_OUTPUT_OPTS: OutputOpts = {
  maxBodyLines: 200,
  maxBodyChars: 5000,
  noRequest: false,
  headersOnly: false,
};

export interface CaidoConfig {
  url: string;
  pat: string;
}

export interface CaidoErrorClassification {
  category: "CONNECTION_REFUSED" | "NOT_READY" | "AUTH_FAILURE" | "TIMEOUT" | "UNKNOWN";
  userMessage: string;
  retryable: boolean;
}

export interface TokenCache {
  load(): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string } | undefined>;
  save(token: { accessToken: string; refreshToken?: string; expiresAt?: string }): Promise<void>;
  clear(): Promise<void>;
}
