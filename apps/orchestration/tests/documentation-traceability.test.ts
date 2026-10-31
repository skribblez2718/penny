import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RESEARCH = path.join(ROOT, ".pi", "skills", "research");
const REFERENCE = path.join(RESEARCH, "resources", "reference.md");

const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  "RSC-001": ["package-surface.test.ts", "documentation-traceability.test.ts"],
  "RSC-002": ["research-product-activation.test.ts", "research-parity.test.ts"],
  "RSC-003": ["research-contract-v2.test.ts", "research-product-activation.test.ts"],
  "RSC-004": ["flow-diagrams.test.ts", "research-product-activation.test.ts"],
  "RSC-005": ["liveness-budget.test.ts", "worker-cancellation.test.ts"],
  "RSC-006": ["research-context.test.ts", "prompt-guidance-contract.test.ts"],
  "RSC-007": ["research-request-admission.test.ts", "research-parity.test.ts"],
  "RSC-008": ["worker-tool-surface-matrix.test.ts", "worker-registration.test.ts"],
};

function text(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("P3 research documentation truthfulness oracle", () => {
  it("has exact bidirectional claim-to-source-to-test equality", () => {
    const reference = readFileSync(REFERENCE, "utf8");
    const rows = reference.split("\n").filter((line) => /^\| `RSC-[0-9]{3}` \|/u.test(line));
    const ids = rows.map((row) => row.match(/`(RSC-[0-9]{3})`/u)?.[1]);
    expect(ids.sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const row of rows) {
      const id = row.match(/`(RSC-[0-9]{3})`/u)?.[1];
      if (id === undefined || !Object.hasOwn(EXPECTED, id)) {
        throw new Error(`unknown research truth claim '${String(id)}'`);
      }
      const tests = EXPECTED[id];
      if (tests === undefined) throw new Error(`claim '${id}' has no test mapping`);
      for (const test of tests) expect(row, `${id} -> ${test}`).toContain(test);
      const cells = row.split("|").map((cell) => cell.trim());
      expect(cells[3]?.length, `${id} source surface`).toBeGreaterThan(0);
      expect(cells[4]?.length, `${id} test surface`).toBeGreaterThan(0);
    }
  });

  it("states the active semantic core, P3 graph, and ordered topology", () => {
    for (const relative of [
      ".pi/skills/research/SKILL.md",
      ".pi/skills/research/README.md",
      ".pi/skills/research/resources/reference.md",
      "docs/agents/capabilities/research-skill/research-skill.md",
    ]) {
      const document = text(relative);
      expect(document, relative).toMatch(
        /sole active output|authoritative output|authoritative `GroundedSynthesisV1`/iu
      );
      expect(document, relative).toMatch(
        /P3[\s\S]{0,120}(activates|topology|graph)|activated P3/iu
      );
    }
    const flow = text(".pi/skills/research/resources/flow.html");
    expect(flow).toContain("apps/orchestration/src/playbooks/research.ts");
    expect(flow).not.toContain("research.py");
    expect(flow).toContain("sealing_core");
    expect(flow).toContain('{"from":"synthesizing","to":"sealing_core"');
    expect(flow).toContain('{"from":"sealing_core","to":"validating"');
    expect(flow).not.toContain("report_writing");
    expect(flow).toContain('{"from":"validating","to":"critiquing_report"');
  });

  it("keeps one historical qualification owner with precise scoped consumer references", () => {
    const reference = readFileSync(REFERENCE, "utf8");
    const sections = reference.split(/^## Qualification evidence$/mu);
    expect(sections).toHaveLength(2);
    const remainder = sections[1];
    if (remainder === undefined) throw new Error("qualification evidence section is absent");
    const qualification = remainder.split(/^## /mu)[0];
    if (qualification === undefined) throw new Error("qualification evidence body is absent");

    expect(qualification).toMatch(
      /As recorded, the historical live-model PG4[\s\S]{0,120}passed[\s\S]{0,120}p4-qr-live-20260827-009/iu
    );
    expect(reference.match(/p4-qr-live-20260827-009/gu)).toHaveLength(1);
    expect(reference.replace(qualification, "")).not.toMatch(/live-model PG4[\s\S]{0,120}passed/iu);
    expect(qualification).toContain("ignored local PG4 verification bundle");
    expect(qualification).toContain("not supplied or reproduced here");
    expect(qualification).toContain("not a clean-checkout prerequisite");
    expect(qualification).toContain("without independently verifying or disproving it");
    expect(qualification).toContain(
      "not fresh or current qualification of current code, prompts, or documentation"
    );
    expect(qualification).toContain("current seven-skill seal/assurance changes");
    expect(qualification).toContain("No new live run or repeated cohort");
    expect(qualification).toContain("Deterministic PG3 and offline test conformance");
    expect(qualification).toContain("not live-model reliability or golden-template certification");
    expect(qualification).toContain("not independent live-pass evidence");
    expect(qualification).toContain("Gate 2 remains `not_run`");

    const livenessClaim = reference.split("\n").find((line) => line.startsWith("| `RSC-005` |"));
    if (livenessClaim === undefined) throw new Error("RSC-005 is absent");
    expect(livenessClaim).toContain("[Qualification evidence](#qualification-evidence)");
    expect(livenessClaim).not.toContain("ignored local PG4 verification bundle");

    const consumers: Readonly<Record<string, string>> = {
      ".pi/skills/research/SKILL.md": "resources/reference.md#qualification-evidence",
      ".pi/skills/research/README.md": "resources/reference.md#qualification-evidence",
      ".pi/skills/research/resources/research-frontier-evaluation.md":
        "reference.md#qualification-evidence",
      "docs/agents/capabilities/research-skill/research-skill.md":
        "../../../../.pi/skills/research/resources/reference.md#qualification-evidence",
    };
    for (const [relative, target] of Object.entries(consumers)) {
      const document = text(relative);
      expect(document, relative).toContain(`](${target})`);
      expect(document, relative).toContain("not fresh or current qualification");
      expect(document, relative).not.toContain("p4-qr-live-20260827-009");
      expect(document, relative).not.toMatch(/live-model PG4[\s\S]{0,120}passed/iu);
      expect(document, relative).not.toMatch(/^## Qualification evidence$/mu);
    }
  });

  it("does not advertise phantom rigor, Python runtime, or legacy output authority", () => {
    const publicDocuments = [
      ".pi/skills/research/SKILL.md",
      ".pi/skills/research/README.md",
      ".pi/skills/research/resources/reference.md",
      ".pi/skills/research/resources/flow.html",
      ".pi/skills/research/resources/research-frontier-evaluation.md",
      "docs/agents/capabilities/research-skill/research-skill.md",
      "apps/orchestration/README.md",
    ].map(text);
    for (const document of publicDocuments) {
      expect(document).not.toMatch(/research\.py|Python child is spawned/iu);
      expect(document).not.toMatch(
        /rigor escalation can|permit one earned|rigor_escalation.*default/iu
      );
      expect(document).not.toMatch(
        /production (?:terminal )?output remains the legacy|legacy agent-output is authoritative/iu
      );
    }
    const skill = publicDocuments[0];
    expect(skill).not.toMatch(/^\| `rigor_escalation` \|/mu);
  });

  it("keeps rigor_escalated decoder-only and makes report_format reach exact consumers", () => {
    const playbook = text("apps/orchestration/src/playbooks/research.ts");
    const durable = text("apps/orchestration/src/durable-state.ts");
    const schemas = text("apps/orchestration/src/skill-contracts/research.ts");
    expect(durable).toContain("rigor_escalated: Type.Boolean()");
    expect(playbook).not.toContain("rigor_escalated: research.rigor_escalated");
    expect(schemas).toContain('binding_kind: "caller_input"');
    expect(schemas).toContain("output_shape_guidance: [");
    for (const state of ["synthesizing", "critiquing_report", "validating"]) {
      expect(schemas).toContain(`"${state}"`);
    }
    expect(schemas).not.toContain('Type.Literal("report_writing")');
  });

  it("keeps artifact handoff grant-free and repair routing host-registered", () => {
    const skillTool = text("docs/agents/capabilities/skill-tool/skill-tool.md");
    expect(skillTool).toContain("passes that direct exact ID");
    expect(skillTool).toContain("active catalog-bound");
    expect(skillTool).not.toMatch(
      /grants? only|pointing to the grant|caller-selected.*state root/iu
    );

    const patterns = text("docs/agents/state-management/skill-patterns.md");
    expect(patterns).toContain("owner-selected exact input IDs");
    expect(patterns).toContain("unique host-registered origin-state/feedback-kind route");
    expect(patterns).toContain("cannot name a target or claim exhaustion");
    expect(patterns).not.toMatch(/input grants?|verifier.*names its producer target/iu);
  });
});
