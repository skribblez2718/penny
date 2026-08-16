import path from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_DB_RELATIVE_PATH, loadRuntimeConfig } from "../src/config.js";

describe("TypeScript orchestration runtime configuration", () => {
  it("uses a TypeScript-only v2 database path by default", () => {
    const projectRoot = path.resolve("/tmp/penny-project");
    const config = loadRuntimeConfig(projectRoot, {});
    expect(config.dbPath).toBe(path.join(projectRoot, DEFAULT_DB_RELATIVE_PATH));
    expect(config.dbPath).toContain("orchestration-v2.db");
    expect(config.dbPath).not.toContain("orchestration.db");
  });

  it("accepts only an absolute explicit v2 database path", () => {
    expect(
      loadRuntimeConfig("/tmp/project", {
        PENNY_ORCH_V2_DB: "/tmp/isolated-orchestration-v2.db",
      }).dbPath
    ).toBe("/tmp/isolated-orchestration-v2.db");
    expect(() =>
      loadRuntimeConfig("/tmp/project", {
        PENNY_ORCH_V2_DB: "relative.db",
      })
    ).toThrow("must be an absolute path");
  });

  it("rejects invalid positive-integer limits", () => {
    expect(() =>
      loadRuntimeConfig("/tmp/project", {
        PENNY_ORCH_V2_MAX_STEPS: "0",
      })
    ).toThrow("positive integer");
  });
});
