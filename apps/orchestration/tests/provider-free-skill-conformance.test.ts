import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CANDIDATE_PLAYBOOK_REGISTRY, PLAYBOOK_REGISTRY } from "../src/index.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_EXTENSION_ROOT = path.resolve(PACKAGE_ROOT, "..", "..", ".pi", "extensions", "skill");
const MANIFEST_PATH = path.join(
  PACKAGE_ROOT,
  "tests",
  "fixtures",
  "provider-free-skill-conformance.v1.json"
);
const REQUIRED_CATEGORIES = [
  "known_good",
  "known_bad",
  "boundary",
  "semantic_equivalence",
  "input_mutation",
  "product_integrity",
  "real_entrypoint",
  "fail_closed",
] as const;
const FORBIDDEN_PROVIDER_FREE_PATH =
  /(?:^|[-/])(c6|evaluation|local-live|model-smoke|parity|remote)(?:[-/.]|$)/u;

type ReleaseStatus = "production" | "candidate";
type Category = (typeof REQUIRED_CATEGORIES)[number];

interface ConformanceCheck {
  readonly check_id: string;
  readonly category: Category;
  readonly tier: 1 | 2;
  readonly test_file: string;
  readonly full_name: string;
}

interface ConformanceProfile {
  readonly skill_name: string;
  readonly release_status: ReleaseStatus;
  readonly checks: readonly ConformanceCheck[];
}

interface EntrypointCheck {
  readonly check_id: string;
  readonly registration_scope: string;
  readonly test_config: "unit" | "integration" | "e2e";
  readonly test_file: string;
  readonly full_name: string;
}

interface ConformanceManifest {
  readonly schema_version: 1;
  readonly claim_scope: "engine_and_contract_conformance_only";
  readonly required_categories: readonly Category[];
  readonly entrypoint_checks: readonly EntrypointCheck[];
  readonly profiles: readonly ConformanceProfile[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function isCategory(value: string): value is Category {
  return REQUIRED_CATEGORIES.some((category) => category === value);
}

function parseCheck(value: unknown, label: string): ConformanceCheck {
  const item = record(value, label);
  expect(Object.keys(item).sort()).toEqual(
    ["category", "check_id", "full_name", "test_file", "tier"].sort()
  );
  const category = string(item.category, `${label}.category`);
  if (!isCategory(category)) throw new Error(`${label}.category is unknown`);
  if (item.tier !== 1 && item.tier !== 2) throw new Error(`${label}.tier must be 1 or 2`);
  return {
    check_id: string(item.check_id, `${label}.check_id`),
    category,
    tier: item.tier,
    test_file: string(item.test_file, `${label}.test_file`),
    full_name: string(item.full_name, `${label}.full_name`),
  };
}

function parseEntrypointCheck(value: unknown, index: number): EntrypointCheck {
  const label = `entrypoint_checks[${index}]`;
  const item = record(value, label);
  expect(Object.keys(item).sort()).toEqual(
    ["check_id", "full_name", "registration_scope", "test_config", "test_file"].sort()
  );
  if (
    item.test_config !== "unit" &&
    item.test_config !== "integration" &&
    item.test_config !== "e2e"
  ) {
    throw new Error(`${label}.test_config is unknown`);
  }
  return {
    check_id: string(item.check_id, `${label}.check_id`),
    registration_scope: string(item.registration_scope, `${label}.registration_scope`),
    test_config: item.test_config,
    test_file: string(item.test_file, `${label}.test_file`),
    full_name: string(item.full_name, `${label}.full_name`),
  };
}

function parseProfile(value: unknown, index: number): ConformanceProfile {
  const label = `profiles[${index}]`;
  const item = record(value, label);
  expect(Object.keys(item).sort()).toEqual(["checks", "release_status", "skill_name"].sort());
  if (item.release_status !== "production" && item.release_status !== "candidate") {
    throw new Error(`${label}.release_status is unknown`);
  }
  if (!Array.isArray(item.checks)) throw new Error(`${label}.checks must be an array`);
  return {
    skill_name: string(item.skill_name, `${label}.skill_name`),
    release_status: item.release_status,
    checks: item.checks.map((check, checkIndex) =>
      parseCheck(check, `${label}.checks[${checkIndex}]`)
    ),
  };
}

function loadManifest(): ConformanceManifest {
  const raw: unknown = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const item = record(raw, "provider-free conformance manifest");
  expect(Object.keys(item).sort()).toEqual(
    ["claim_scope", "entrypoint_checks", "profiles", "required_categories", "schema_version"].sort()
  );
  expect(item.schema_version).toBe(1);
  expect(item.claim_scope).toBe("engine_and_contract_conformance_only");
  expect(item.required_categories).toEqual(REQUIRED_CATEGORIES);
  if (!Array.isArray(item.entrypoint_checks)) {
    throw new Error("entrypoint_checks must be an array");
  }
  if (!Array.isArray(item.profiles)) throw new Error("profiles must be an array");
  return {
    schema_version: 1,
    claim_scope: "engine_and_contract_conformance_only",
    required_categories: REQUIRED_CATEGORIES,
    entrypoint_checks: item.entrypoint_checks.map(parseEntrypointCheck),
    profiles: item.profiles.map(parseProfile),
  };
}

const manifest = loadManifest();
const registrations = [
  ...[...PLAYBOOK_REGISTRY.values()].map((registration) => ({
    registration,
    releaseStatus: "production" as const,
  })),
  ...[...CANDIDATE_PLAYBOOK_REGISTRY.values()].map((registration) => ({
    registration,
    releaseStatus: "candidate" as const,
  })),
].sort((left, right) => left.registration.name.localeCompare(right.registration.name, "en"));

describe("provider-free skill conformance manifest", () => {
  it("covers exactly the production and candidate registration union", () => {
    const registrationNames = registrations.map(({ registration }) => registration.name);
    const profileNames = manifest.profiles.map((profile) => profile.skill_name).sort();
    expect(new Set(registrationNames).size).toBe(registrationNames.length);
    expect(new Set(profileNames).size).toBe(profileNames.length);
    expect(profileNames).toEqual(registrationNames);
  });

  it.each(registrations)(
    "binds a complete closed profile for registered $registration.name",
    ({ registration, releaseStatus }) => {
      const profile = manifest.profiles.find((item) => item.skill_name === registration.name);
      if (profile === undefined) throw new Error(`missing profile for ${registration.name}`);
      expect(profile.release_status).toBe(releaseStatus);
      expect(profile.checks.map((check) => check.category).sort()).toEqual(
        [...REQUIRED_CATEGORIES].sort()
      );
      expect(new Set(profile.checks.map((check) => check.check_id)).size).toBe(
        profile.checks.length
      );
      expect(profile.checks.some((check) => check.tier === 1)).toBe(true);
      expect(profile.checks.some((check) => check.tier === 2)).toBe(true);

      for (const check of profile.checks) {
        expect(check.check_id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
        expect(check.test_file).toMatch(/^tests\/[A-Za-z0-9._/-]+\.test\.ts$/u);
        expect(check.test_file).not.toMatch(/\.\./u);
        expect(check.test_file).not.toMatch(FORBIDDEN_PROVIDER_FREE_PATH);
        const absolute = path.resolve(PACKAGE_ROOT, check.test_file);
        expect(absolute.startsWith(`${path.join(PACKAGE_ROOT, "tests")}${path.sep}`)).toBe(true);
        expect(statSync(absolute).isFile()).toBe(true);
      }
    }
  );

  it("binds real extension entrypoints without admitting remote evaluation suites", () => {
    const scopes = manifest.entrypoint_checks.map((check) => check.registration_scope).sort();
    const productionNames = registrations
      .filter(({ releaseStatus }) => releaseStatus === "production")
      .map(({ registration }) => registration.name)
      .sort();
    expect(scopes.filter((scope) => scope === "candidate")).toHaveLength(1);
    expect(scopes.filter((scope) => scope !== "candidate").sort()).toEqual(productionNames);
    for (const check of manifest.entrypoint_checks) {
      expect(check.check_id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
      expect(check.test_file).toMatch(/^tests\/[A-Za-z0-9._/-]+\.test\.ts$/u);
      expect(check.test_file).not.toMatch(/\.\./u);
      expect(check.test_file).not.toMatch(FORBIDDEN_PROVIDER_FREE_PATH);
      const absolute = path.resolve(SKILL_EXTENSION_ROOT, check.test_file);
      expect(absolute.startsWith(`${path.join(SKILL_EXTENSION_ROOT, "tests")}${path.sep}`)).toBe(
        true
      );
      expect(statSync(absolute).isFile()).toBe(true);
    }
  });

  it("uses unique evidence bindings and never claims semantic quality", () => {
    const evidenceBindings = [
      ...manifest.profiles.flatMap((profile) =>
        profile.checks.map((check) => `${check.test_file}\u0000${check.full_name}`)
      ),
      ...manifest.entrypoint_checks.map(
        (check) => `skill-extension/${check.test_file}\u0000${check.full_name}`
      ),
    ];
    expect(new Set(evidenceBindings).size).toBe(evidenceBindings.length);
    expect(manifest.claim_scope).toBe("engine_and_contract_conformance_only");
  });
});
