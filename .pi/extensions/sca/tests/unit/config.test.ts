import { describe, expect, it } from "vitest";

import {
  DEFAULT_SCA_CLIENT_POLL_INTERVAL_MS,
  DEFAULT_SCA_CLIENT_RESPONSE_TIMEOUT_MS,
  SCA_CLIENT_MAX_POLL_ATTEMPTS_ENV,
  SCA_SERVICE_SOCKET_ENV,
  SCA_SERVICE_TOKEN_ENV,
  loadScaClientConfig,
} from "../../src/config.js";

const TOKEN = "config-test-token-000000000000000000000";

function environment(): NodeJS.ProcessEnv {
  return {
    [SCA_SERVICE_SOCKET_ENV]: "/tmp/penny-sca-config/service.sock",
    [SCA_SERVICE_TOKEN_ENV]: TOKEN,
  };
}

describe("SCA client liveness configuration", () => {
  it("keeps transport inactivity and polling cadence separate from job progress", () => {
    expect(loadScaClientConfig(environment())).toMatchObject({
      responseTimeoutMs: DEFAULT_SCA_CLIENT_RESPONSE_TIMEOUT_MS,
      pollIntervalMs: DEFAULT_SCA_CLIENT_POLL_INTERVAL_MS,
    });
  });

  it("rejects the retired elapsed poll-attempt ceiling", () => {
    expect(() =>
      loadScaClientConfig({
        ...environment(),
        [SCA_CLIENT_MAX_POLL_ATTEMPTS_ENV]: "10",
      })
    ).toThrow(/configuration is unavailable/u);
  });
});
