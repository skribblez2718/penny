import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ARTIFACT_MANIFEST_DATABASE_NAME,
  CATALOG_DATABASE_NAME,
  OBSERVABILITY_DATABASE_NAME,
  ORCHESTRATION_DATABASE_NAME,
  pennyStatePaths,
  projectStatePaths,
  resolvePennyStateRoot,
} from "../src/state/index.js";

const PROJECT_ID = "prj_0123456789abcdef0123456789abcdef";

describe("Penny state paths", () => {
  it("derives the default state root from Pi's agent directory", () => {
    expect(resolvePennyStateRoot({ env: {}, agentDir: "/srv/pi-agent" })).toBe(
      path.join("/srv/pi-agent", "penny")
    );
  });

  it("accepts only one absolute Penny-specific state override", () => {
    expect(
      resolvePennyStateRoot({
        env: {
          PENNY_STATE_ROOT: "/srv/penny-state",
          PENNY_HOME: "/ignored/install-home",
          PROJECT_ROOT: "/ignored/project",
          XDG_STATE_HOME: "/ignored/xdg",
        },
        agentDir: "/ignored/pi-agent",
      })
    ).toBe("/srv/penny-state");
    expect(() =>
      resolvePennyStateRoot({ env: { PENNY_STATE_ROOT: "relative/state" }, agentDir: "/pi" })
    ).toThrow("PENNY_STATE_ROOT must be an absolute path");
  });

  it("uses stable unversioned canonical database names", () => {
    const state = pennyStatePaths("/srv/pi-agent/penny");
    const project = projectStatePaths(state, PROJECT_ID);
    expect(path.basename(state.catalogDatabase)).toBe(CATALOG_DATABASE_NAME);
    expect(path.basename(state.observability.database)).toBe(OBSERVABILITY_DATABASE_NAME);
    expect(path.basename(project.orchestration.database)).toBe(ORCHESTRATION_DATABASE_NAME);
    expect(path.basename(project.artifacts.manifestDatabase)).toBe(ARTIFACT_MANIFEST_DATABASE_NAME);
    expect(JSON.stringify({ state, project })).not.toMatch(/(?:orchestration|manifest)-v\d+/u);
  });

  it("rejects noncanonical project IDs before composing paths", () => {
    const state = pennyStatePaths("/srv/pi-agent/penny");
    expect(() => projectStatePaths(state, "../escape")).toThrow("project ID is not canonical");
    expect(() => projectStatePaths(state, "project-readable-name")).toThrow(
      "project ID is not canonical"
    );
  });
});
