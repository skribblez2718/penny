import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PREREQUISITE_SCRIPT = path.join(
  PACKAGE_ROOT,
  "scripts",
  "verify-release-browser-prerequisites.ts"
);

describe("release browser test prerequisites", () => {
  it("fails clearly when local browser authorization is absent", () => {
    const result = spawnSync("bun", ["run", PREREQUISITE_SCRIPT], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      env: { ...process.env, PENNY_PLAYWRIGHT_BROWSER_TESTS: "0" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("set PENNY_PLAYWRIGHT_BROWSER_TESTS=1");
  });

  it("fails clearly when the configured Chromium executable is missing", () => {
    const result = spawnSync("bun", ["run", PREREQUISITE_SCRIPT], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PENNY_PLAYWRIGHT_BROWSER_TESTS: "1",
        PLAYWRIGHT_BROWSER_PATH: "/definitely/missing/penny-chromium",
      },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Chromium executable is missing or not executable");
  });
});
