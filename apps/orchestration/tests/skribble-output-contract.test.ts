import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildCatalogPrompt } from "../dist/catalog-prompt.js";
import { validateContract } from "../dist/contracts.js";
import { PRODUCE_PLAYBOOK_REGISTRATION } from "../dist/playbooks/produce.js";
import { parsePersistedProducedArtifactDraftV2 } from "../dist/skill-contracts/produce.js";
import { parsePersistedRoutingSummary } from "../dist/worker.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../../..");
const role = readFileSync(path.join(PROJECT_ROOT, ".pi/agents/skribble.md"), "utf8");
const domainGuidance = readFileSync(
  path.join(PROJECT_ROOT, ".pi/skills/produce/assets/prompts/skribble-materializing_artifact.md"),
  "utf8"
);

// These checks prove instruction assembly and example compatibility, not live-model behavior.
describe("Skribble direct versus registered output contracts", () => {
  it("retains a complete generation report for direct work without inventing a routing SUMMARY", () => {
    const direct = buildCatalogPrompt({ projectRoot: PROJECT_ROOT, agentName: "skribble", role });
    expect(direct.appended).toContain("For direct work without a bound response schema");
    expect(direct.appended).toContain(
      "Files Created · Files Modified · Validation Results · Issues · Confidence"
    );
    expect(direct.appended).toContain(
      "Identify every file created or modified, every error, and checks not run."
    );
    expect(direct.appended).toContain(
      "Append a routing SUMMARY only when Domain Guidance defines it, with exactly its declared fields."
    );
    expect(direct.appended).not.toContain("every error — in the SUMMARY");
    expect(direct.appended).not.toContain("PRODUCED_ARTIFACT_DRAFT:");
  });

  it("assembles explicit schema-only output without inserting a generation report into Produce", () => {
    const phase = buildCatalogPrompt({
      projectRoot: PROJECT_ROOT,
      agentName: "skribble",
      role,
      domainGuidance,
    });
    expect(phase.appended).toContain(
      "When Domain Guidance defines an exact response schema, return only its supported structure and fields"
    );
    expect(phase.appended).toContain("do not append a separate generation report");
    expect(phase.appended).toContain("or insert report sections into the product");
    expect(phase.appended).toContain(
      "This registered phase returns complete content, not a direct file-generation report."
    );
    expect(phase.appended).toContain("insert report sections into `content`");
    expect(phase.appended).toContain(
      "The routing SUMMARY contains only `confidence` and `complete`; it is not a file or error report."
    );
    expect(phase.appended).toContain("Emit exactly two adjacent single lines and nothing else.");
    expect(phase.appended).toContain("Do not execute, test, compile, write a file");
    expect(phase.appended.indexOf(domainGuidance)).toBeLessThan(
      phase.appended.indexOf("<agent_boundary>")
    );
  });

  it("parses the complete two-line example under the registered schema and rejects added reports", () => {
    const lines = domainGuidance
      .split("\n")
      .filter((line) => /^(?:PRODUCED_ARTIFACT_DRAFT|SUMMARY):/u.test(line));
    expect(lines).toHaveLength(2);
    const output = lines.join("\n");
    const input = {
      request: {
        schema_version: 1,
        purpose_statement: "Create a greeting artifact.",
        output_name: "artifact.txt",
        artifact_kind: "text",
        specification: [{ statement: "Include the greeting." }],
        source_material: [{ statement: "Hello." }],
        acceptance_criteria: [{ statement: "The greeting is exact." }],
        hard_constraints: [],
        non_goals: [],
        known_uncertainties: [],
      },
    };
    const result = parsePersistedProducedArtifactDraftV2(Buffer.from(output), input);
    expect(result.draft.content).toBe("Hello.");
    expect(result.summary).toEqual({ confidence: "PROBABLE", complete: true });
    if (PRODUCE_PLAYBOOK_REGISTRATION.worker.kind !== "catalog-agent") {
      throw new Error("Produce must use catalog agents");
    }
    const registration = PRODUCE_PLAYBOOK_REGISTRATION.worker.phases.get("materializing_artifact");
    if (registration === undefined) throw new Error("Produce materialization phase is absent");
    expect(registration.agent).toBe("skribble");
    const routing = parsePersistedRoutingSummary(output);
    if (routing === undefined) throw new Error("Produce routing SUMMARY is absent");
    expect(routing.confidence).toBe(result.summary.confidence);
    expect(() =>
      validateContract(registration.schema, routing.details, "Produce SUMMARY")
    ).not.toThrow();
    for (const invalid of [
      `${output}\nFiles Created: none`,
      `Validation Results: not run\n${output}`,
      output.replace('"complete":true}', '"complete":true,"files_created":[],"issues":[]}'),
    ]) {
      expect(() => parsePersistedProducedArtifactDraftV2(Buffer.from(invalid), input)).toThrow();
    }
  });
});
