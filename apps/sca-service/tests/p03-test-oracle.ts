import { readFile } from "node:fs/promises";
import path from "node:path";
import { readSourceOracle } from "./p03-source-oracle.js";
import { sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  makeScaP03QueryCandidateV2,
  projectSourceOracleCases,
  scaP03FrontendLanguageV1,
  scaP03QualificationObservationSha256V2,
  type ScaP03QueryId,
  type ScaP03QualificationFixtureCorpusV2,
} from "../../orchestration/dist/sca/p03-contracts.js";

type ExpectedCase = ScaP03QualificationFixtureCorpusV2["expected_cases"][number];

/** Synthetic fixture-only relationship evidence; never a source-level/live oracle. */
export function syntheticOracleCase(input: {
  fixture: {
    fixture_id: string;
    content_sha256: string;
    path: string;
    language: "php" | "javascript" | "typescript";
  };
  query_id: ScaP03QueryId;
  release_sha256: string;
}): {
  expected: ExpectedCase;
  observed: {
    case_id: string;
    language: "php" | "javascript" | "typescript";
    query_id: ScaP03QueryId;
    frontend_language: "PHP" | "JSSRC";
    status: "passed";
    blocker_code: null;
    fixture_id: string;
    fixture_sha256: string;
    observation_count: number;
    observations: ReturnType<typeof makeScaP03QueryCandidateV2>[];
    observed_sha256: string;
  };
} {
  const { fixture, query_id, release_sha256 } = input;
  const call = query_id === "p03.call-resolution.v2";
  const dispatch = query_id === "p03.framework-dispatch.v2";
  const start = {
    node_id: "start",
    role: dispatch ? ("registration" as const) : ("call_site" as const),
    label: "call",
    name: "invoke",
    full_name: null,
    path: fixture.path,
    line: 1,
    column: null,
    location_provenance: "direct" as const,
    location_owner_node_id: null,
    location_evidence: null,
  };
  const end = {
    node_id: "end",
    role: dispatch ? ("handler" as const) : ("callee" as const),
    label: "method",
    name: "target",
    full_name: null,
    path: fixture.path,
    line: 2,
    column: null,
    location_provenance: "direct" as const,
    location_owner_node_id: null,
    location_evidence: null,
  };
  const edge = {
    src_index: 0,
    dst_index: 1,
    src_node_id: "start",
    dst_node_id: "end",
    kind: "call" as const,
    direction: "forward" as const,
    provenance: "observed_cpg" as const,
    branch_orientation: null,
    complement_ref: null,
  };
  const candidate = makeScaP03QueryCandidateV2({
    candidate_kind: call
      ? "call_or_unresolved_call"
      : dispatch
        ? "route_or_framework_surface"
        : "symbol_or_entrypoint",
    query_id,
    claim: call ? "call_resolution" : dispatch ? "framework_dispatch" : "observation",
    disposition: call ? "supported" : "unresolved",
    reason_code: call ? null : "joern_fidelity_unproven",
    source_selector: null,
    sink_selector: null,
    framework: dispatch ? "express" : null,
    registration_form: dispatch ? "router.get" : null,
    callback_resolution: dispatch ? "observed" : null,
    assumptions: [],
    graph_component_sha256: sha256("synthetic graph"),
    source_snapshot_sha256: fixture.content_sha256,
    query_release_sha256: release_sha256,
    vertices: [start, end],
    edges: [edge],
    hop_count: 1,
    truncated: false,
    path: fixture.path,
    line: 1,
    stable_locator: "start:end",
    summary: "Synthetic fixture path",
  });
  const observations = [candidate];
  const case_id = `p03-${fixture.language}-${query_id.replaceAll(".", "-")}`;
  const observed_sha256 = scaP03QualificationObservationSha256V2({
    fixture_id: fixture.fixture_id,
    fixture_sha256: fixture.content_sha256,
    query_id,
    frontend_language: scaP03FrontendLanguageV1(fixture.language),
    release_sha256,
    blocker_code: null,
    observations,
  });
  const assertion = {
    expectation: "present" as const,
    candidate_kind: candidate.candidate_kind,
    claim: candidate.claim,
    disposition: candidate.disposition,
    start: { path: fixture.path, name: "invoke", line: 1, role: start.role },
    end: { path: fixture.path, name: "target", line: 2, role: end.role },
    edge: {
      kind: edge.kind,
      provenance: edge.provenance,
      branch_orientation: edge.branch_orientation,
    },
    framework: candidate.framework,
    registration_form: candidate.registration_form,
    callback_resolution: candidate.callback_resolution,
  };
  return {
    expected: {
      case_id,
      language: fixture.language,
      query_id,
      expected_observed_sha256: observed_sha256,
      oracle_assertions: [assertion],
    },
    observed: {
      case_id,
      language: fixture.language,
      query_id,
      frontend_language: scaP03FrontendLanguageV1(fixture.language),
      status: "passed",
      blocker_code: null,
      fixture_id: fixture.fixture_id,
      fixture_sha256: fixture.content_sha256,
      observation_count: 1,
      observations,
      observed_sha256,
    },
  };
}

export function observedFromSourceCase(
  expected: ReturnType<typeof projectSourceOracleCases>[number],
  fixture: { fixture_id: string; content_sha256: string; path: string },
  release_sha256: string,
  approvedComplementRef?: import("../../orchestration/dist/contracts.js").ArtifactRef
) {
  const assertion = expected.oracle_assertions.find((item) => item.expectation === "present");
  if (assertion?.start === undefined) throw new Error("reviewed positive selector missing");
  const selectors = [
    assertion.start,
    ...(assertion.via ?? []),
    ...(assertion.end ? [assertion.end] : []),
  ];
  const complemented =
    assertion.edge?.provenance === "qualified_complement" && approvedComplementRef !== undefined;
  const vertices = selectors.map((selector, index) => ({
    node_id: String(index + 1),
    role: selector.role,
    label:
      expected.query_id === "p03.call-resolution.v2"
        ? index === 0
          ? "call"
          : "method"
        : expected.query_id === "p03.dataflow-source-sink.v2"
          ? complemented && index === 0 && expected.language !== "javascript"
            ? "method_parameter_in"
            : "identifier"
          : expected.query_id === "p03.control-guard.v2"
            ? index === 0
              ? "control_structure"
              : "identifier"
            : expected.query_id === "p03.framework-dispatch.v2"
              ? index === 0
                ? "call"
                : "method"
              : "method",
    name: selector.name,
    full_name: null,
    path: selector.path,
    line: selector.line,
    column: null,
    location_provenance: complemented ? ("qualified_source_oracle" as const) : ("direct" as const),
    ...(complemented
      ? { source_location_ref: approvedComplementRef, cpg_line: selector.line }
      : {}),
    location_owner_node_id: null,
    location_evidence: null,
  }));
  const edge = assertion.edge;
  const edges =
    edge === undefined
      ? []
      : vertices.slice(1).map((_, index) => ({
          src_index: index,
          dst_index: index + 1,
          src_node_id: String(index + 1),
          dst_node_id: String(index + 2),
          kind: edge.kind,
          provenance: edge.provenance,
          branch_orientation: edge.branch_orientation,
          direction: "forward" as const,
          complement_ref:
            edge.provenance === "qualified_complement" ? (approvedComplementRef ?? null) : null,
        }));
  const candidate = makeScaP03QueryCandidateV2({
    candidate_kind: assertion.candidate_kind,
    query_id: expected.query_id,
    claim: assertion.claim,
    disposition: assertion.disposition,
    reason_code:
      assertion.reason_code ??
      (assertion.disposition === "supported" ? null : "relationship_unproven"),
    source_selector: assertion.source_selector ?? null,
    sink_selector: assertion.sink_selector ?? null,
    framework: assertion.framework ?? null,
    registration_form: assertion.registration_form ?? null,
    callback_resolution: assertion.callback_resolution ?? null,
    assumptions: [],
    graph_component_sha256: sha256("synthetic graph"),
    source_snapshot_sha256: fixture.content_sha256,
    query_release_sha256: release_sha256,
    vertices,
    edges,
    hop_count: edges.length,
    truncated: false,
    path: fixture.path,
    line: assertion.start.line,
    stable_locator: `${expected.case_id}:positive`,
    summary: "Reviewed source selector observation",
  });
  const observations = [candidate];
  const frontend_language = scaP03FrontendLanguageV1(expected.language);
  return {
    case_id: expected.case_id,
    language: expected.language,
    query_id: expected.query_id,
    frontend_language,
    status: "passed" as const,
    blocker_code: null,
    fixture_id: fixture.fixture_id,
    fixture_sha256: fixture.content_sha256,
    observation_count: 1,
    observations,
    observed_sha256: scaP03QualificationObservationSha256V2({
      fixture_id: fixture.fixture_id,
      fixture_sha256: fixture.content_sha256,
      query_id: expected.query_id,
      frontend_language,
      release_sha256,
      blocker_code: null,
      observations,
    }),
  };
}

// Pinned Joern r14 NODE rows (base64-encoded CODE/NAME/LINE), with only the
// inventory's missing META/FILE/CONTAINS/relationship rows reconstructed for the mock.
// No executable graph parser, Docker daemon, or runtime source is consulted here.
export async function pinnedInventory(
  fixturePath: string,
  encode: (value: string) => string,
  defect?:
    | "bad-line"
    | "ambiguous"
    | "wrong-handler"
    | "wrong-registration"
    | "wrong-action"
    | "outside-handler"
    | "reuse"
    | "no-param-ast"
    | "param-contains"
    | "foreign-param-owner"
    | "duplicate-param-owner"
    | "wrong-param-code"
    | "wrong-param-name"
    | "wrong-param-line"
    | "wrong-param-method"
    | "param-cycle"
    | "param-depth"
    | "param-outside-span",
  fixtureRoot?: string
): Promise<string> {
  const { oracle } = await readSourceOracle(fixtureRoot);
  const fixture = oracle.fixtures.find((entry) => entry.path === fixturePath);
  if (fixture === undefined) throw new Error("pinned fixture absent");
  const filename = {
    javascript: "joern-javascript-nodes.tsv",
    php: "joern-php-nodes.tsv",
    typescript: "joern-typescript-nodes.tsv",
  }[fixture.language];
  const raw = await readFile(
    fixtureRoot === undefined
      ? new URL(`./fixtures/p03-v2/${filename}`, import.meta.url)
      : path.join(fixtureRoot, filename),
    "utf8"
  );
  const rows = raw.trimEnd().split("\n");
  const nodes = rows.map((row) => {
    const fields = row.split("\t");
    if (fields.length !== 8 || fields[0] !== "NODE") throw new Error("pinned node row invalid");
    if (Buffer.from(fields[3] ?? "", "base64").toString("utf8") === path.basename(fixturePath))
      fields[3] = encode(`/source/${fixturePath}`);
    return fields;
  });
  const decoded = nodes.map((fields) => ({
    id: fields[1] ?? "",
    label: Buffer.from(fields[2] ?? "", "base64").toString("utf8"),
    file: Buffer.from(fields[3] ?? "", "base64").toString("utf8"),
    line: Number(Buffer.from(fields[4] ?? "", "base64").toString("utf8")),
    name: Buffer.from(fields[5] ?? "", "base64").toString("utf8"),
    code: Buffer.from(fields[7] ?? "", "base64").toString("utf8"),
  }));
  const edges: string[] = [];
  const edge = (src: string, dst: string, label: string) =>
    edges.push(`EDGE\t${src}\t${dst}\t${encode(label)}`);
  for (const node of decoded) {
    if (
      node.file !== "" ||
      node.label === "METHOD_PARAMETER_IN" ||
      !Number.isInteger(node.line) ||
      node.line < 1
    )
      continue;
    const owners = decoded.filter(
      (owner) =>
        owner.label === "METHOD" &&
        owner.file === `/source/${fixturePath}` &&
        owner.line <= node.line &&
        owner.line + owner.code.split("\n").length > node.line
    );
    const owner =
      owners.sort((a, b) => a.code.split("\n").length - b.code.split("\n").length)[0] ??
      decoded.find(
        (candidate) =>
          candidate.label === "METHOD" &&
          candidate.file === `/source/${fixturePath}` &&
          (candidate.name === "<global>" || candidate.name === ":program")
      );
    if (owner !== undefined && owner.id !== node.id) edge(owner.id, node.id, "CONTAINS");
  }
  // Pinned NODE rows retain Joern's empty parameter FILENAME. Model only the
  // observed AST ownership shape; no synthetic CONTAINS location for parameters.
  if (fixture.language !== "javascript") {
    const param = decoded.find(
      (node) =>
        node.label === "METHOD_PARAMETER_IN" &&
        node.name === (fixture.language === "php" ? "input_value" : "inputValue")
    );
    const owner = decoded.find(
      (node) =>
        node.label === "METHOD" &&
        node.name === (fixture.language === "php" ? "handle_record" : "handleRecord")
    );
    if (param === undefined || owner === undefined)
      throw new Error("pinned parameter owner absent");
    const paramRow = nodes.find((row) => row[1] === param.id);
    const ownerRow = nodes.find((row) => row[1] === owner.id);
    if (paramRow === undefined || ownerRow === undefined) throw new Error("pinned row absent");
    if (defect === "wrong-param-code") paramRow[7] = encode("different: string");
    if (defect === "wrong-param-name") paramRow[5] = encode("different");
    if (defect === "wrong-param-line") paramRow[4] = encode(String(param.line + 1));
    if (defect === "wrong-param-method") ownerRow[5] = encode("decoyMethod");
    if (defect === "foreign-param-owner") ownerRow[3] = encode("/generated/foreign.php");
    if (defect === "param-outside-span") ownerRow[4] = encode(String(owner.line + 2));
    if (defect === "duplicate-param-owner") {
      nodes.push(["NODE", "999999999998", ...ownerRow.slice(2)]);
      edge("999999999998", param.id, "AST");
    }
    if (defect === "param-cycle" || defect === "param-depth") {
      const count = defect === "param-cycle" ? 2 : 9;
      for (let index = 0; index < count; index++) {
        const id = String(999999900000 + index);
        nodes.push(["NODE", id, encode("BLOCK"), "", "", "", "", ""]);
        edge(index === count - 1 ? owner.id : String(999999900001 + index), id, "AST");
      }
      edge("999999900000", param.id, "AST");
      if (defect === "param-cycle") edge("999999900000", "999999900001", "AST");
    } else if (defect === "param-contains") edge(owner.id, param.id, "CONTAINS");
    else if (defect !== "no-param-ast") edge(owner.id, param.id, "AST");
  }
  const anchor = (selector: { role: string; line: number; name: string | null }) => {
    const label =
      selector.role === "guard"
        ? "CONTROL_STRUCTURE"
        : selector.role === "handler" || selector.role === "callee" || selector.role === "symbol"
          ? "METHOD"
          : selector.role === "registration" || selector.role === "call_site"
            ? "CALL"
            : selector.role === "source" && fixture.language !== "javascript"
              ? "METHOD_PARAMETER_IN"
              : "IDENTIFIER";
    const match = decoded.find(
      (node) =>
        node.label === label &&
        (node.line === selector.line ||
          (selector.role === "handler" &&
            node.code
              .split("\n")
              [selector.line - node.line]?.trim()
              .startsWith(`${selector.name}(`))) &&
        (node.name === selector.name ||
          node.code === selector.name ||
          (selector.role === "guard" && node.code.startsWith(`if (${selector.name})`)) ||
          (selector.role === "registration" &&
            (node.code.startsWith(`${selector.name?.slice(1)}(`) ||
              node.code.startsWith(`${selector.name}(`))))
    );
    if (match === undefined)
      throw new Error(
        `pinned selector missing: ${selector.role}:${selector.line}:${selector.name}`
      );
    return match.id;
  };
  for (const material of fixture.material_cases) {
    const positive = material.assertions.find((assertion) => assertion.expectation === "present");
    if (positive?.start === undefined) throw new Error("pinned positive absent");
    if (material.query_id === "p03.dataflow-source-sink.v2" && fixture.language !== "javascript")
      continue;
    if (
      ![
        "p03.call-resolution.v2",
        "p03.control-guard.v2",
        "p03.framework-dispatch.v2",
        "p03.dataflow-source-sink.v2",
      ].includes(material.query_id)
    )
      continue;
    const chain = [
      positive.start,
      ...(positive.via ?? []),
      ...(positive.end === undefined ? [] : [positive.end]),
    ].map(anchor);
    for (let i = 1; i < chain.length; i++)
      edge(
        chain[i - 1] ?? "",
        chain[i] ?? "",
        material.query_id === "p03.dataflow-source-sink.v2"
          ? "REACHING_DEF"
          : material.query_id === "p03.control-guard.v2"
            ? "CFG"
            : "CALL"
      );
  }
  if (defect !== undefined) {
    const target = decoded.find((node) =>
      defect === "wrong-handler" || defect === "outside-handler"
        ? node.label === "METHOD" && node.name === "handleRecord"
        : defect === "wrong-registration"
          ? node.label === "CALL" && node.code.startsWith('router.get("/records"')
          : defect === "wrong-action"
            ? node.label === "IDENTIFIER" && node.name === "guardedAction" && node.line === 18
            : node.label === "CONTROL_STRUCTURE"
    );
    if (target !== undefined) {
      const fields = nodes.find((row) => row[1] === target.id);
      if (fields === undefined) throw new Error("pinned target absent");
      if (defect === "bad-line") fields[4] = encode(String(target.line + 1));
      else if (defect === "wrong-handler")
        fields[7] = encode('@Get("decoy")\n  decoyHandler(inputValue: string): string {');
      else if (defect === "outside-handler") fields[4] = encode(String(target.line - 2));
      else if (defect === "wrong-action") fields[4] = encode(String(target.line + 1));
      else if (defect === "wrong-registration")
        fields[7] = encode('router.get("/decoy", decoyHandler)');
      else if (defect === "ambiguous")
        nodes.push([
          "NODE",
          "999999999999",
          fields[2] ?? "",
          encode(`/source/${fixturePath}`),
          ...fields.slice(4),
        ]);
      else if (defect === "reuse") {
        // A second selector cannot borrow the first anchor ID; inventory rejects duplicate IDs.
        nodes.push([...fields]);
      }
    }
  }
  return (
    [
      `FILE\t${encode(`/source/${fixturePath}`)}`,
      ...nodes.map((row) => row.join("\t")),
      ...edges,
    ].join("\n") + "\n"
  );
}
