import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { executeStateCommand } from "../src/state/index.js";

const roots: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-state-command-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("penny-state command", () => {
  it("requires an explicit absolute project root", async () => {
    await expect(executeStateCommand(["init"], {})).rejects.toThrow(
      "--project-root=PATH is required"
    );
    await expect(executeStateCommand(["init", "--project-root=relative"], {})).rejects.toThrow(
      "must be an absolute path"
    );
  });

  it("initializes and reports canonical stable paths", async () => {
    const root = sandbox();
    const projectRoot = path.join(root, "project");
    mkdirSync(projectRoot, { mode: 0o700 });
    const env = { PENNY_STATE_ROOT: path.join(root, "state") };

    const initialized = await executeStateCommand(["init", `--project-root=${projectRoot}`], env);
    const status = await executeStateCommand(["status", `--project-root=${projectRoot}`], env);

    if (initialized.action !== "init") throw new Error("state init returned an unexpected result");
    if (status.action !== "status") throw new Error("state status returned an unexpected result");
    expect(status.project_id).toBe(initialized.project_id);
    expect(path.basename(status.orchestration_database)).toBe("orchestration.db");
    expect(path.basename(status.artifact_manifest_database)).toBe("manifest.db");
  });

  it("does not expose a legacy import or migration through setup", async () => {
    const help = await executeStateCommand(["help"], {});
    expect(help.action).toBe("help");
    if (help.action !== "help") throw new Error("expected help result");
    expect(help.text).toContain("never inspect or import legacy roots");
    expect(help.text).not.toContain("orchestration-v2.db");
  });
});
