import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { privateInputRoot } from "../src/private-inputs.js";
import { CapabilityStore, capabilityStoreDirectory } from "../src/kb/capabilities.js";
import {
  hostGrantAuthorityDir,
  kbHostStatePaths,
  kbProfileRegistryPath,
} from "../src/kb/host-state.js";
import { operationReceiptRoot } from "../src/kb/operation-receipts.js";
import { approvalRootFor } from "../src/kb/promotion.js";
import { saveClaimStoreDir } from "../src/kb/save-claim.js";
import { installTestProjectState } from "./fixtures/penny-state-fixture.js";

const roots: string[] = [];
const originalStateRoot = process.env.PENNY_STATE_ROOT;

function project(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `${label}-`));
  roots.push(root);
  return root;
}

afterEach(() => {
  if (originalStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
  else process.env.PENNY_STATE_ROOT = originalStateRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("catalog-bound KB host-control paths", () => {
  it("resolves every host-control authority below the opaque project partition", () => {
    const projectRoot = project("penny-kb-host-state");
    const state = installTestProjectState(projectRoot);

    expect(privateInputRoot(projectRoot)).toBe(state.paths.orchestration.inputs);
    expect(kbProfileRegistryPath(projectRoot)).toBe(state.paths.knowledgeBase.profiles);
    expect(hostGrantAuthorityDir(projectRoot)).toBe(state.paths.knowledgeBase.hostGrants);
    expect(capabilityStoreDirectory(projectRoot)).toBe(state.paths.knowledgeBase.capabilities);
    expect(saveClaimStoreDir(projectRoot, "kbp_demo")).toBe(
      path.join(state.paths.knowledgeBase.saveClaims, "kbp_demo")
    );
    expect(operationReceiptRoot(projectRoot)).toBe(state.paths.knowledgeBase.operationReceipts);
    expect(approvalRootFor(projectRoot)).toBe(state.paths.knowledgeBase.approval);
    expect(kbHostStatePaths(projectRoot).root).toBe(state.paths.knowledgeBase.root);
    expect(state.paths.knowledgeBase.root.startsWith(projectRoot)).toBe(false);
  });

  it("isolates two registered projects and never creates a project-local legacy root", () => {
    const firstRoot = project("penny-kb-host-first");
    const secondRoot = project("penny-kb-host-second");
    const first = installTestProjectState(firstRoot);
    const second = installTestProjectState(secondRoot);

    using _firstCapabilities = new CapabilityStore(firstRoot);
    using _secondCapabilities = new CapabilityStore(secondRoot);
    expect(first.paths.knowledgeBase.root).not.toBe(second.paths.knowledgeBase.root);
    expect(capabilityStoreDirectory(firstRoot)).not.toBe(capabilityStoreDirectory(secondRoot));
    expect(existsSync(path.join(firstRoot, ".penny"))).toBe(false);
    expect(existsSync(path.join(secondRoot, ".penny"))).toBe(false);
  });

  it("refuses an unregistered project instead of creating or scanning legacy state", () => {
    const registered = project("penny-kb-host-registered");
    installTestProjectState(registered);
    const unregistered = project("penny-kb-host-unregistered");

    expect(() => kbHostStatePaths(unregistered)).toThrow("run explicit state setup");
    expect(existsSync(path.join(unregistered, ".penny"))).toBe(false);
  });
});
