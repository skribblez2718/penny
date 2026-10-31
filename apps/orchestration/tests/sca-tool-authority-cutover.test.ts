import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import {
  bindGenericChildYamlAuthority,
  PLAYBOOK_REGISTRY,
  runtimeRegistrationSha256,
} from "../dist/playbooks/registry.js";
import { SCA_MODEL_TOOL_ROSTER, SCA_TOOL_OPERATION_MAP } from "../dist/sca/broker-contracts.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const AGENTS = [
  "annie",
  "carren",
  "demetri",
  "echo",
  "ida",
  "piper",
  "skribble",
  "synthia",
  "tabitha",
  "vera",
] as const;

const EXPECTED_SCA_AUTHORITY = Object.freeze({
  annie: Object.freeze({
    tools: Object.freeze(["sca_source_query", "sca_graph_query"]),
    tool_profiles: Object.freeze(["sca.source_query", "sca.graph_query"]),
  }),
  carren: Object.freeze({ tools: Object.freeze([]), tool_profiles: Object.freeze([]) }),
  demetri: Object.freeze({
    tools: Object.freeze(["sca_graph_query", "sca_application_test"]),
    tool_profiles: Object.freeze(["sca.graph_query", "sca.application_test"]),
  }),
  echo: Object.freeze({
    tools: Object.freeze(["sca_source_query", "sca_graph_query"]),
    tool_profiles: Object.freeze(["sca.source_query", "sca.graph_query"]),
  }),
  ida: Object.freeze({ tools: Object.freeze([]), tool_profiles: Object.freeze([]) }),
  piper: Object.freeze({
    tools: Object.freeze(["sca_graph_query", "sca_application_test"]),
    tool_profiles: Object.freeze(["sca.graph_query", "sca.application_test"]),
  }),
  skribble: Object.freeze({
    tools: Object.freeze(["sca_source_query", "sca_graph_query"]),
    tool_profiles: Object.freeze(["sca.source_query", "sca.graph_query"]),
  }),
  synthia: Object.freeze({
    tools: Object.freeze(["sca_source_query", "sca_graph_query"]),
    tool_profiles: Object.freeze(["sca.source_query", "sca.graph_query"]),
  }),
  tabitha: Object.freeze({ tools: Object.freeze([]), tool_profiles: Object.freeze([]) }),
  vera: Object.freeze({
    tools: Object.freeze(["sca_graph_query", "sca_application_test"]),
    tool_profiles: Object.freeze(["sca.graph_query", "sca.application_test"]),
  }),
});

const EXPECTED_AUTHORITY_SHA256 =
  "148825a695beb0c6f043780a7a8475d7aad794291fb1c128e5196750196701fb";

const GUARDED_ZERO_TOOL_CANONICAL_DOCS = [
  "docs/agents/agents/discovery-and-tools.md",
  "docs/agents/agents/invocation.md",
  "docs/agents/agents/overview.md",
  "docs/agents/agents/system-prompt-security.md",
  "docs/agents/agents/tool-profiles.md",
  "docs/agents/architecture/skill-tool-modes.md",
  "docs/agents/extensions/tool-description-standard.md",
  "docs/agents/orchestration/overview.md",
  "docs/agents/prompts/architecture.md",
  "docs/agents/prompts/layer-reference.md",
  "docs/agents/skills/orchestration.md",
  "docs/agents/skills/skill-standard.md",
  "docs/agents/skills/testing.md",
  "docs/agents/state-management/orchestration-integration.md",
] as const;

const EXPECTED_RUNTIME_REGISTRATION_DIGESTS = Object.freeze({
  // Review-outcome preservation, progress policies and prompt bindings change these current
  // digests, not the separately pinned tool-authority ceiling or historical fixture bytes.
  assess: "d11684e4d7ab2852f0e5c10e77c647d8df5b20b0bc85deff3ba43c97e9f80868",
  decide: "dc679ff08d0ee0ce0b9b37070f1041f20d8abf12b25915f8daeb5a87cc2128b9",
  define: "8c2034bb2fe39524a6a3c19a9b896e58dae553761c232afeb3476c5b61174545",
  diagnose: "49d5786bc474285ace7c1b4d7f6319b26a0431b9ea536a649eec4f3491791317",
  plan: "0379a875c84be0c5deb0a2844ec37940114daa60f95ae32ba19bcb40a33433e7",
  produce: "23e62d408a10a4eb6a3ee0b4e7f8f43ba46201c02f7cd71afa126f28979f6b8b",
  research: "93c94a2cedde719cb1a7158c843ea8cda975756b7f2c856d98d80d9db779be9a",
});

type AgentAuthority = {
  readonly agent: (typeof AGENTS)[number];
  readonly tools: readonly string[];
  readonly tool_profiles: readonly string[];
};

function frontmatterField(document: string, field: string): readonly string[] {
  const frontmatter = document.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1] ?? "";
  const prefix = `${field}:`;
  const line = frontmatter.split(/\r?\n/u).find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) throw new Error(`agent declaration is missing '${field}'`);
  return line
    .slice(prefix.length)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function currentScaAuthority(): readonly AgentAuthority[] {
  return AGENTS.map((agent) => {
    const document = readFileSync(path.join(PROJECT_ROOT, ".pi", "agents", `${agent}.md`), "utf8");
    const allTools = frontmatterField(document, "tools");
    const allProfiles = frontmatterField(document, "tool_profiles");
    expect(new Set(allTools).size, `${agent} tools must be unique`).toBe(allTools.length);
    expect(new Set(allProfiles).size, `${agent} tool profiles must be unique`).toBe(
      allProfiles.length
    );
    return Object.freeze({
      agent,
      tools: Object.freeze(allTools.filter((tool) => tool.startsWith("sca_"))),
      tool_profiles: Object.freeze(allProfiles.filter((profile) => profile.startsWith("sca."))),
    });
  });
}

describe("S-03-T4 canonical SCA tool-authority cutover", () => {
  it("binds only the approved phase-role agents to the exact stable SCA tools", () => {
    const actual = currentScaAuthority();
    expect(actual).toEqual(
      AGENTS.map((agent) => Object.freeze({ agent, ...EXPECTED_SCA_AUTHORITY[agent] }))
    );
    expect(SCA_MODEL_TOOL_ROSTER).toEqual([
      "sca_source_query",
      "sca_graph_query",
      "sca_application_test",
    ]);
    expect(SCA_TOOL_OPERATION_MAP).toEqual({
      sca_source_query: "source_query",
      sca_graph_query: "graph_query",
      sca_application_test: "application_test",
    });
    expect(sha256(canonicalJson({ schema_version: 1, agents: actual }))).toBe(
      EXPECTED_AUTHORITY_SHA256
    );
  });

  it("keeps ordinary SCA cognition artifact-only and other registrations denied SCA tools", () => {
    const registration = PLAYBOOK_REGISTRY.get("sca");
    if (registration === undefined || registration.worker.kind !== "catalog-agent") {
      throw new Error("SCA catalog registration is absent");
    }
    expect(
      Object.fromEntries(
        [...registration.worker.phases.entries()].map(([state, phase]) => [
          state,
          phase.allowed_tools,
        ])
      )
    ).toEqual(
      Object.fromEntries(
        [
          "selecting_scanner_dependency_leads",
          "selecting_underdetected_no_alert_surfaces",
          "forming_hypotheses",
          "challenging_hypotheses",
          "selecting_evidence_actions",
          "adjudicating_evidence",
          "assessing_learning",
          "materializing_report",
          "reviewing_report",
          "verifying_final_product",
        ].map((state) => [state, ["artifact_read"]])
      )
    );
    for (const [name, ordinary] of PLAYBOOK_REGISTRY) {
      if (name === "sca" || ordinary.worker.kind !== "catalog-agent") continue;
      for (const phase of ordinary.worker.phases.values()) {
        expect(phase.allowed_tools?.some((tool) => tool.startsWith("sca_")) ?? false).toBe(false);
      }
    }
  });

  it("pins all six registered host-operation kinds and adapters separately from cognitive tools", () => {
    const registration = PLAYBOOK_REGISTRY.get("sca");
    if (registration?.host_operations === undefined) {
      throw new Error("SCA host-operation registration is absent");
    }
    // Host-owner declarations do not grant model-visible tools or execution consent.
    expect(
      registration.host_operations.declarations.map(({ operation_kind, adapter_id }) => ({
        operation_kind,
        adapter_id,
      }))
    ).toEqual([
      { operation_kind: "sca.preparation.v1", adapter_id: "sca-ordinary-analysis-v1" },
      { operation_kind: "sca.evidence.v1", adapter_id: "sca-ordinary-analysis-v1" },
      { operation_kind: "sca.application.v1", adapter_id: "sca-ordinary-advanced-v1" },
      { operation_kind: "sca.validation.v1", adapter_id: "sca-ordinary-advanced-v1" },
      { operation_kind: "sca.promotion.v1", adapter_id: "sca-ordinary-advanced-v1" },
      { operation_kind: "sca.rescan.v1", adapter_id: "sca-ordinary-advanced-v1" },
    ]);
  });

  it("keeps every canonical tool-authority route explicit about the guarded zero-tool exception", () => {
    for (const relativePath of GUARDED_ZERO_TOOL_CANONICAL_DOCS) {
      const document = readFileSync(path.join(PROJECT_ROOT, relativePath), "utf8");
      expect(document, relativePath).toContain("guarded zero-tool");
    }
  });

  it("freezes the seven ordinary runtime registration digests after YAML authority binding", () => {
    const actual = Object.fromEntries(
      Object.keys(EXPECTED_RUNTIME_REGISTRATION_DIGESTS).map((name) => {
        const registration = PLAYBOOK_REGISTRY.get(name);
        if (registration === undefined) throw new Error(`missing playbook registration '${name}'`);
        return [
          name,
          runtimeRegistrationSha256(bindGenericChildYamlAuthority(registration, PROJECT_ROOT)),
        ];
      })
    );
    expect(actual).toEqual(EXPECTED_RUNTIME_REGISTRATION_DIGESTS);
  });
});
