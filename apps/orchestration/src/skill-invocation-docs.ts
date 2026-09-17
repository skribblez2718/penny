import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { canonicalJson } from "./checkpointer.js";
import { GENERIC_CHILD_WORKFLOW_NAMES, resolvePlaybook } from "./playbooks/registry.js";

const START = "<!-- PENNY:GENERATED-INVOCATION:START -->";
const END = "<!-- PENNY:GENERATED-INVOCATION:END -->";

export interface InvocationManifestOptions {
  readonly projectRoot: string;
  readonly check?: boolean;
}

function assertSafeManifestPath(projectRoot: string, skill: string): string {
  const root = realpathSync(projectRoot);
  const skillsRoot = path.join(root, ".pi", "skills");
  const skillRoot = path.join(skillsRoot, skill);
  const target = path.join(skillRoot, "SKILL.md");
  if (!existsSync(target) || lstatSync(target).isSymbolicLink()) {
    throw new Error(`unsafe or missing skill manifest for '${skill}'`);
  }
  const realSkillRoot = realpathSync(skillRoot);
  if (
    path.dirname(realpathSync(target)) !== realSkillRoot ||
    !realSkillRoot.startsWith(`${skillsRoot}${path.sep}`)
  ) {
    throw new Error(`skill manifest escapes the declared skills root for '${skill}'`);
  }
  return target;
}

function renderInvocation(skill: string): string {
  const registration = resolvePlaybook(skill);
  if (registration?.ingress !== "skill" || registration.caller_documentation === undefined) {
    throw new Error(`generic skill '${skill}' lacks caller-documentation registration`);
  }
  const doc = registration.caller_documentation;
  const request = registration.contract.io.request;
  const ports = [
    request,
    ...registration.contract.io.input_ports,
    ...registration.contract.io.active_output_ports,
  ];
  const portLines = ports.map(
    (port) =>
      `- \`${port.name}\` — ${port.direction}/${port.transport}; schema \`${port.schema_id}\` v${port.schema_version_required}; ${port.min_items}..${port.max_items} item(s)${port.artifact_kind === null ? "" : `; artifact kind ${port.artifact_kind}`}.`
  );
  return [
    START,
    "",
    "## Invocation",
    "",
    "This block is generated from the active runtime registration, its real caller constraints schema, and contract I/O. Do not edit it by hand.",
    "",
    "<!-- prettier-ignore -->",
    "```ts",
    "skill({",
    `  skill_name: ${JSON.stringify(skill)},`,
    `  goal: ${JSON.stringify(doc.example.goal)},`,
    `  constraints: ${canonicalJson(doc.example.constraints)},`,
    "});",
    "```",
    "",
    `The request port is \`${request.schema_id}\` v${request.schema_version_required}. ${doc.semantic_caveat}`,
    "",
    "### Contract I/O",
    "",
    ...portLines,
    "",
    "### Runtime constraints schema",
    "",
    "<!-- prettier-ignore -->",
    "```json",
    JSON.stringify(doc.constraints_schema, null, 2),
    "```",
    "",
    END,
  ].join("\n");
}

function replaceInvocationBlock(source: string, rendered: string): string {
  const starts = source.split(START).length - 1;
  const ends = source.split(END).length - 1;
  if (starts === 1 && ends === 1) {
    const begin = source.indexOf(START);
    const finish = source.indexOf(END, begin) + END.length;
    return `${source.slice(0, begin)}${rendered}${source.slice(finish)}`;
  }
  if (starts !== 0 || ends !== 0)
    throw new Error("invocation generation markers must be paired exactly once");

  // One-time migration of an old handwritten Invocation section. "Invocation Boundary" is
  // intentionally excluded: it is policy prose, not a callable contract.
  const heading = /^## Invocation\s*$/m.exec(source);
  if (heading?.index !== undefined) {
    const begin = heading.index;
    const next = /^##\s+/gm;
    next.lastIndex = begin + heading[0].length;
    const match = next.exec(source);
    const finish = match?.index ?? source.length;
    return `${source.slice(0, begin)}${rendered}\n\n${source.slice(finish)}`;
  }
  const boundary = /^## Invocation Boundary\s*$/m.exec(source);
  if (boundary?.index === undefined)
    throw new Error("skill manifest has no Invocation heading or boundary");
  const next = /^##\s+/gm;
  next.lastIndex = boundary.index + boundary[0].length;
  const following = next.exec(source);
  const insertAt = following?.index ?? source.length;
  return `${source.slice(0, insertAt)}${rendered}\n\n${source.slice(insertAt)}`;
}

export const DOCUMENTED_SKILL_INGRESS_NAMES = Object.freeze([
  ...GENERIC_CHILD_WORKFLOW_NAMES,
  "sca",
] as const);

/** Generate or check every registered model-visible skill invocation section. */
export function generateSkillInvocationManifests(options: InvocationManifestOptions): void {
  for (const skill of DOCUMENTED_SKILL_INGRESS_NAMES) {
    const target = assertSafeManifestPath(options.projectRoot, skill);
    const current = readFileSync(target, "utf8");
    const next = replaceInvocationBlock(current, renderInvocation(skill));
    if (options.check === true) {
      if (next !== current) throw new Error(`generated Invocation block drifted for '${skill}'`);
    } else if (next !== current) {
      writeFileSync(target, next, "utf8");
    }
  }
}
