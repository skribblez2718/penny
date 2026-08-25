import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  initializePennyState,
  projectRootCommitment,
  relinkPennyProject,
  resolvePennyProjectState,
} from "../src/state/index.js";

const roots: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-state-catalog-test-"));
  roots.push(root);
  return root;
}

function directory(parent: string, name: string): string {
  const candidate = path.join(parent, name);
  mkdirSync(candidate, { mode: 0o700 });
  return candidate;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Penny project catalog", () => {
  it("initializes owner-only target state idempotently", () => {
    const root = sandbox();
    const projectRoot = directory(root, "project");
    const stateRoot = path.join(root, "state");
    const options = { env: { PENNY_STATE_ROOT: stateRoot }, agentDir: "/ignored" } as const;

    const first = initializePennyState(projectRoot, options);
    const second = initializePennyState(projectRoot, options);

    expect(second.projectId).toBe(first.projectId);
    expect(second.rootCommitment).toBe(first.rootCommitment);
    expect(path.basename(first.paths.orchestration.database)).toBe("orchestration.db");
    expect(path.basename(first.paths.artifacts.manifestDatabase)).toBe("manifest.db");
    for (const candidate of [
      first.state.root,
      first.state.projects,
      first.paths.root,
      first.paths.orchestration.root,
      first.paths.artifacts.root,
      first.paths.skillChains,
      first.paths.subagentSessions,
      first.paths.knowledgeBase.approval,
    ]) {
      expect(lstatSync(candidate).mode & 0o777).toBe(0o700);
    }
    expect(lstatSync(first.state.catalogDatabase).mode & 0o777).toBe(0o600);
  });

  it("stores a commitment rather than the canonical project path", () => {
    const root = sandbox();
    const projectRoot = directory(root, "private-project-name");
    const stateRoot = path.join(root, "state");
    const binding = initializePennyState(projectRoot, {
      env: { PENNY_STATE_ROOT: stateRoot },
    });

    expect(binding.rootCommitment).toBe(projectRootCommitment(projectRoot));
    expect(binding.rootCommitment).not.toContain(projectRoot);
    expect(readFileSync(binding.state.catalogDatabase).includes(Buffer.from(projectRoot))).toBe(
      false
    );
  });

  it("isolates distinct canonical project roots", () => {
    const root = sandbox();
    const firstProject = directory(root, "first-project");
    const secondProject = directory(root, "second-project");
    const options = { env: { PENNY_STATE_ROOT: path.join(root, "state") } } as const;

    const first = initializePennyState(firstProject, options);
    const second = initializePennyState(secondProject, options);

    expect(second.projectId).not.toBe(first.projectId);
    expect(second.paths.root).not.toBe(first.paths.root);
    expect(resolvePennyProjectState(firstProject, options).projectId).toBe(first.projectId);
    expect(resolvePennyProjectState(secondProject, options).projectId).toBe(second.projectId);
  });

  it("relinks one existing opaque partition transactionally", () => {
    const root = sandbox();
    const currentRoot = directory(root, "current-project");
    const replacementRoot = directory(root, "replacement-project");
    const options = { env: { PENNY_STATE_ROOT: path.join(root, "state") } } as const;
    const original = initializePennyState(currentRoot, options);

    const relinked = relinkPennyProject(original.projectId, currentRoot, replacementRoot, options);

    expect(relinked.projectId).toBe(original.projectId);
    expect(() => resolvePennyProjectState(currentRoot, options)).toThrow(
      "project is not registered"
    );
    expect(resolvePennyProjectState(replacementRoot, options).projectId).toBe(original.projectId);
  });

  it("refuses relink collisions", () => {
    const root = sandbox();
    const firstRoot = directory(root, "first-project");
    const secondRoot = directory(root, "second-project");
    const options = { env: { PENNY_STATE_ROOT: path.join(root, "state") } } as const;
    const first = initializePennyState(firstRoot, options);
    initializePennyState(secondRoot, options);

    expect(() => relinkPennyProject(first.projectId, firstRoot, secondRoot, options)).toThrow(
      "already registered"
    );
    expect(resolvePennyProjectState(firstRoot, options).projectId).toBe(first.projectId);
  });

  it("does not create missing state during ordinary resolution", () => {
    const root = sandbox();
    const projectRoot = directory(root, "project");
    const stateRoot = path.join(root, "missing-state");

    expect(() =>
      resolvePennyProjectState(projectRoot, { env: { PENNY_STATE_ROOT: stateRoot } })
    ).toThrow();
    expect(() => lstatSync(stateRoot)).toThrow();
  });

  it("rejects symlinked and broadly accessible managed roots", () => {
    const root = sandbox();
    const projectRoot = directory(root, "project");
    const actualStateRoot = directory(root, "actual-state");
    const linkedStateRoot = path.join(root, "linked-state");
    symlinkSync(actualStateRoot, linkedStateRoot);

    expect(() =>
      initializePennyState(projectRoot, { env: { PENNY_STATE_ROOT: linkedStateRoot } })
    ).toThrow("symlink ancestor");

    const broadStateRoot = directory(root, "broad-state");
    chmodSync(broadStateRoot, 0o755);
    expect(() =>
      initializePennyState(projectRoot, { env: { PENNY_STATE_ROOT: broadStateRoot } })
    ).toThrow("mode must be exactly 0700");
  });
});
