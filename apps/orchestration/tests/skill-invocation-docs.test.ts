import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateContract, type StartRequest } from "../src/contracts.js";
import {
  DOCUMENTED_SKILL_INGRESS_NAMES,
  generateSkillInvocationManifests,
} from "../src/skill-invocation-docs.js";
import { resolvePlaybook } from "../src/playbooks/registry.js";

const directories: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..", "..", "..");

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function requestFor(skill: string): StartRequest {
  const registration = resolvePlaybook(skill);
  if (registration?.caller_documentation === undefined) throw new Error("missing caller docs");
  return {
    schema_version: 2,
    action: "start",
    identity: {
      schema_version: 2,
      run_id: `docs-${skill}`,
      session_id: "docs-session",
      playbook: skill,
      engine_owner: "typescript",
    },
    goal: registration.caller_documentation.example.goal,
    constraints: registration.caller_documentation.example.constraints,
    project_root: "/docs-fixture",
    trust_profile: "trusted-interactive",
  };
}

describe("generated skill Invocation contracts", () => {
  it("is byte-current and contains one callable generated contract for every documented ingress", () => {
    expect(() => generateSkillInvocationManifests({ projectRoot, check: true })).not.toThrow();
    for (const skill of DOCUMENTED_SKILL_INGRESS_NAMES) {
      const registration = resolvePlaybook(skill);
      expect(registration?.ingress).toBe("skill");
      expect(registration?.caller_documentation).toBeDefined();
      const manifest = readFileSync(
        path.join(projectRoot, ".pi", "skills", skill, "SKILL.md"),
        "utf8"
      );
      expect(manifest.match(/<!-- PENNY:GENERATED-INVOCATION:START -->/g)).toHaveLength(1);
      expect(manifest.match(/<!-- PENNY:GENERATED-INVOCATION:END -->/g)).toHaveLength(1);
      expect(manifest).toContain("## Invocation\n");
    }
  });

  it("validates every generated example through its runtime schema and real admission path", () => {
    for (const skill of DOCUMENTED_SKILL_INGRESS_NAMES) {
      const registration = resolvePlaybook(skill);
      if (
        registration?.caller_documentation === undefined ||
        registration.start_admission === undefined
      ) {
        throw new Error(`missing generic caller binding for '${skill}'`);
      }
      validateContract(
        registration.caller_documentation.constraints_schema,
        registration.caller_documentation.example.constraints,
        `${skill} generated example`
      );
      expect(() => registration.start_admission?.prepare(requestFor(skill), {})).not.toThrow();
    }
  });

  it("detects stale generated content without writing in check mode", () => {
    const root = mkdtempSync(path.join(tmpdir(), "penny-invocation-docs-"));
    directories.push(root);
    for (const skill of DOCUMENTED_SKILL_INGRESS_NAMES) {
      const target = path.join(root, ".pi", "skills", skill);
      cpSync(path.join(projectRoot, ".pi", "skills", skill), target, { recursive: true });
    }
    const stale = path.join(root, ".pi", "skills", "assess", "SKILL.md");
    const original = readFileSync(stale, "utf8");
    writeFileSync(stale, original.replace("Assess whether", "STALE: Assess whether"), "utf8");
    const before = readFileSync(stale, "utf8");
    expect(() => generateSkillInvocationManifests({ projectRoot: root, check: true })).toThrow(
      "generated Invocation block drifted"
    );
    expect(readFileSync(stale, "utf8")).toBe(before);
  });
});
