import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseFlow, validateStaticFlow } from "../../scripts/validate-flow-html.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "../../../../..");
const TEMPLATE = readFileSync(
  path.join(REPO_ROOT, "scripts", "tools", "templates", "skill-flow.html"),
  "utf8"
);

function diagram(nodes: string, edges: string): string {
  return TEMPLATE.replace("__N_JSON__", nodes)
    .replace("__E_JSON__", edges)
    .replaceAll("__FLOW_TITLE__", "Test flow")
    .replaceAll("__FLOW_HEADING__", "Test flow")
    .replaceAll("__FLOW_SUMMARY__", "Test summary")
    .replaceAll("__FLOW_CALLOUT__", "Test invariant")
    .replaceAll("__FLOW_NOTES__", "Test notes");
}

const NODES =
  '{"intake":{"title":"Intake","desc":"Host intake","cls":"host","lane":"center","y":20,"badge":"HOST"},"complete":{"title":"Complete","desc":"Positive terminal","cls":"done","lane":"center","y":180,"badge":"TERM"}}';
const EDGES = '[{"from":"intake","to":"complete","kind":"exit","label":"admitted"}]';

describe("validate-flow-html", () => {
  it("parses strict JSON flow data without executing the page", () => {
    const parsed = parseFlow(diagram(NODES, EDGES));
    expect(Object.keys(parsed.nodes)).toEqual(["intake", "complete"]);
    expect(parsed.edges).toEqual([
      { from: "intake", to: "complete", kind: "exit", label: "admitted" },
    ]);
  });

  it("rejects duplicate JSON keys before JSON.parse can erase them", () => {
    const duplicateNodes =
      '{"intake":{"title":"Intake","title":"Duplicate","desc":"Host intake","cls":"host","lane":"center","y":20,"badge":"HOST"}}';
    expect(() => parseFlow(diagram(duplicateNodes, "[]"))).toThrow(/duplicate JSON key/u);
  });

  it("rejects missing edge labels and unsafe external assets in static validation", () => {
    expect(() =>
      parseFlow(diagram(NODES, '[{"from":"intake","to":"complete","kind":"exit"}]'))
    ).toThrow(/label/u);
    const pathToFlow = path.join(REPO_ROOT, ".pi", "skills", "research", "resources", "flow.html");
    const result = validateStaticFlow(pathToFlow);
    expect(result.failures).toEqual([]);
  });
});
