import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { planScaOsvV2, queryScaOsvV2, validateScaOsvResultV2 } from "../src/adapters/osv-v2.js";
import { createP02OsvExternalTransport, validateP02OsvHostConfig } from "../src/p02-osv-host.js";

// Both an explicit opt-in AND a caller-supplied complete pinned fixture are required.
// Ordinary CI, even with a stray fixture path, never dispatches a service or network call.
const fixturePath = process.env.PENNY_P02_OSV_LIVE_FIXTURE;
const enabled = process.env.PENNY_P02_OSV_LIVE_APPROVED === "1" && fixturePath !== undefined;

describe.skipIf(!enabled)("authorized external OSV egress qualification candidate", () => {
  it("verifies the caller-bounded plan through the actual unit and worker", async () => {
    if (!fixturePath) throw Error("explicit fixture required");
    const fixture: unknown = JSON.parse(await readFile(fixturePath, "utf8"));
    const config = validateP02OsvHostConfig(fixture);
    const plan = planScaOsvV2(config.component_request);
    const result = await queryScaOsvV2(config.component_request, {
      transport: createP02OsvExternalTransport(config),
    });
    expect(validateScaOsvResultV2(result, config.component_request, plan).status).toBe("succeeded");
  }, 300_000);
});
