import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  resolvePlaybook,
  skillContractSha256,
  type PlaybookRegistrationV1,
  type PlaybookRegistryV1,
} from "@penny/orchestration/source";
import { afterEach, describe, expect, it } from "vitest";

import { resolveSkillIngress } from "../../skill-ingress.js";

const roots: string[] = [];

function projectRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "penny-skill-ingress-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function registration(): PlaybookRegistrationV1 {
  const research = resolvePlaybook("research");
  if (research === undefined || research.worker.kind !== "catalog-agent") {
    throw new Error("research registration fixture is unavailable");
  }
  const name = "fixture-skill";
  return {
    ...research,
    name,
    contract: { ...research.contract, name },
    worker: { ...research.worker, workflow_name: name },
  };
}

function registry(item: PlaybookRegistrationV1): PlaybookRegistryV1 {
  return new Map([[item.name, item]]);
}

function writeSkillPackage(root: string, name: string, disabled = false): void {
  const directory = path.join(root, ".pi", "skills", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      "description: Fixture skill. Use when testing generic ingress. Do not use for direct work.",
      `disable-model-invocation: ${disabled ? "true" : "false"}`,
      "metadata:",
      "  penny:",
      "    engine: orchestration",
      "---",
      "",
    ].join("\n"),
    "utf8"
  );
}

describe("generic registered skill ingress", () => {
  it("refuses an unregistered package, including a model-disabled development package", () => {
    const root = projectRoot();
    writeSkillPackage(root, "sca", true);
    expect(resolveSkillIngress({ projectRoot: root, name: "sca", registry: new Map() })).toEqual({
      ok: false,
      code: "SKILL_NOT_REGISTERED",
      message: "skill 'sca' is not registered",
    });
  });

  it("admits a matching registered package and returns its exact contract digest", () => {
    const root = projectRoot();
    const item = registration();
    writeSkillPackage(root, item.name);
    expect(
      resolveSkillIngress({ projectRoot: root, name: item.name, registry: registry(item) })
    ).toMatchObject({
      ok: true,
      registration: item,
      contract_sha256: skillContractSha256(item.contract),
    });
  });

  it("keeps model visibility separate from registered generic execution", () => {
    const root = projectRoot();
    const item = registration();
    writeSkillPackage(root, item.name, true);
    expect(
      resolveSkillIngress({ projectRoot: root, name: item.name, registry: registry(item) })
    ).toMatchObject({ ok: true });
  });

  it("fails closed for missing, unsafe, or mismatched package metadata", () => {
    const item = registration();

    const missing = projectRoot();
    expect(
      resolveSkillIngress({ projectRoot: missing, name: item.name, registry: registry(item) })
    ).toMatchObject({ ok: false, code: "SKILL_PACKAGE_INVALID" });

    const unsafe = projectRoot();
    const directory = path.join(unsafe, ".pi", "skills", item.name);
    mkdirSync(directory, { recursive: true });
    const target = path.join(unsafe, "target.md");
    writeFileSync(target, "---\nname: fixture-skill\n---\n", "utf8");
    symlinkSync(target, path.join(directory, "SKILL.md"));
    expect(
      resolveSkillIngress({ projectRoot: unsafe, name: item.name, registry: registry(item) })
    ).toMatchObject({ ok: false, code: "SKILL_PACKAGE_INVALID" });

    const mismatched = projectRoot();
    writeSkillPackage(mismatched, item.name);
    const manifest = path.join(mismatched, ".pi", "skills", item.name, "SKILL.md");
    writeFileSync(
      manifest,
      "---\nname: fixture-skill\ndescription: Fixture. Use when testing. Do not use otherwise.\nmetadata:\n  penny:\n    engine: other\n---\n",
      "utf8"
    );
    expect(
      resolveSkillIngress({ projectRoot: mismatched, name: item.name, registry: registry(item) })
    ).toMatchObject({ ok: false, code: "SKILL_PACKAGE_INVALID" });
  });

  it("refuses a dedicated-tool registration at the generic skill entrypoint", () => {
    const root = projectRoot();
    writeSkillPackage(root, "knowledge-base");
    const knowledgeBase = resolvePlaybook("knowledge-base");
    if (knowledgeBase === undefined) throw new Error("knowledge-base fixture is unavailable");
    expect(
      resolveSkillIngress({
        projectRoot: root,
        name: "knowledge-base",
        registry: new Map([["knowledge-base", knowledgeBase]]),
      })
    ).toMatchObject({ ok: false, code: "SKILL_ENTRYPOINT_MISMATCH" });
  });
});
