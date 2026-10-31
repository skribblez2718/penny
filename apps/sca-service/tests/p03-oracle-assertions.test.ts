import { describe, expect, it } from "vitest";

import { sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  makeScaP03QueryCandidateV2,
  validateScaP03QueryCandidateV2,
  projectScaP03OracleTargetObservationsV2,
  validateScaP03QualificationCaseProjectionV2,
  scaP03QualificationCaseMatchesV2,
  scaP03QualificationAssertionsMatchV2,
  scaP03QualificationObservationSha256V2,
  validateScaP03QualificationCaseObservationsV2,
} from "../../orchestration/dist/sca/p03-contracts.js";
import { syntheticOracleCase } from "./p03-test-oracle.js";

const release_sha256 = sha256("frozen release");
const fixture = {
  fixture_id: "synthetic-php",
  language: "php" as const,
  content_sha256: sha256("synthetic source"),
  path: "src/a.php",
};
const query_id = "p03.call-resolution.v2" as const;
const { expected, observed } = syntheticOracleCase({ fixture, query_id, release_sha256 });

function changedCandidate(core: Parameters<typeof makeScaP03QueryCandidateV2>[0]) {
  const candidate = makeScaP03QueryCandidateV2(core);
  const observations = [candidate];
  return {
    ...observed,
    observations,
    observed_sha256: scaP03QualificationObservationSha256V2({
      fixture_id: fixture.fixture_id,
      fixture_sha256: fixture.content_sha256,
      query_id,
      frontend_language: observed.frontend_language,
      release_sha256,
      blocker_code: null,
      observations,
    }),
  };
}
const { candidate_id: _candidateId, serialized_bytes: _bytes, ...core } = observed.observations[0];
void _candidateId;
void _bytes;

describe("P03 raw reaching-definition oracle", () => {
  const path = fixture.path;
  const node = (
    id: string,
    name: string | null,
    line: number | null,
    role: "source" | "unknown" | "sink"
  ) => ({
    node_id: id,
    role,
    label: "identifier" as const,
    name,
    full_name: null,
    path,
    line,
    column: null,
    location_provenance: "direct" as const,
    location_owner_node_id: null,
    location_evidence: null,
  });
  const vertices = [
    node("1", "source", 4, "source"),
    node("2", "source", 5, "unknown"),
    node("3", "via1", 5, "unknown"),
    node("4", "operator", 6, "unknown"),
    node("5", "via2", 6, "unknown"),
    node("6", "via2", 7, "unknown"),
    node("7", "via3", 7, "unknown"),
    node("8", "sink", 8, "sink"),
  ];
  const edges = vertices.slice(1).map((vertex, index) => ({
    src_index: index,
    dst_index: index + 1,
    src_node_id: vertices[index]?.node_id ?? "missing",
    dst_node_id: vertex.node_id,
    kind: "reaching_def" as const,
    direction: "forward" as const,
    provenance: "observed_cpg" as const,
    branch_orientation: null,
    complement_ref: null,
  }));
  const base = {
    ...core,
    query_id: "p03.dataflow-source-sink.v2" as const,
    candidate_kind: "source_to_sink_flow" as const,
    claim: "reaching_definition" as const,
    disposition: "supported" as const,
    reason_code: null,
    source_selector: "source",
    sink_selector: "sink",
    vertices,
    edges,
    hop_count: edges.length,
    path,
    line: 4,
    stable_locator: "raw-flow",
    truncated: false,
  };
  const mark = (name: string, line: number, role: "source" | "unknown" | "sink") => ({
    path,
    name,
    line,
    role,
  });
  const positive = {
    expectation: "present" as const,
    candidate_kind: "source_to_sink_flow" as const,
    claim: "reaching_definition" as const,
    disposition: "supported" as const,
    start: mark("source", 4, "source"),
    end: mark("sink", 8, "sink"),
    via: [mark("via1", 5, "unknown"), mark("via2", 6, "unknown"), mark("via3", 7, "unknown")],
    edge: {
      kind: "reaching_def" as const,
      provenance: "observed_cpg" as const,
      branch_orientation: null,
    },
    source_selector: "source",
    sink_selector: "sink",
  };
  const make = (change: Partial<Parameters<typeof makeScaP03QueryCandidateV2>[0]> = {}) =>
    makeScaP03QueryCandidateV2({ ...base, ...change });
  it("matches only increasing intermediate milestones with exact source/sink and every raw edge", () => {
    const flow = make();
    expect(scaP03QualificationAssertionsMatchV2([flow], [positive])).toBe(true);
    validateScaP03QueryCandidateV2(flow, {
      query_id: base.query_id,
      graph_component_sha256: base.graph_component_sha256,
      source_snapshot_sha256: base.source_snapshot_sha256,
      query_release_sha256: base.query_release_sha256,
      accounted_paths: [path],
    });
    const negative = {
      ...positive,
      expectation: "absent" as const,
      end: mark("decoy", 9, "sink"),
      sink_selector: "decoy",
    };
    expect(scaP03QualificationAssertionsMatchV2([flow], [positive, negative])).toBe(true);
    const decoy = make({
      vertices: [...vertices.slice(0, -1), node("9", "decoy", 9, "sink")],
      edges: [...edges.slice(0, -1), { ...edges[edges.length - 1], dst_node_id: "9" }],
      sink_selector: "decoy",
    });
    expect(scaP03QualificationAssertionsMatchV2([flow, decoy], [positive, negative])).toBe(false);
    expect(scaP03QualificationAssertionsMatchV2([flow, decoy], [positive])).toBe(true);
    for (const wrong of [
      { via: [positive.via[1], positive.via[0], positive.via[2]] },
      { via: [...positive.via, mark("missing", 7, "unknown")] },
      { via: [positive.via[0], positive.via[0], positive.via[1], positive.via[2]] },
      { end: mark("sink", 7, "sink") },
      { start: mark("source", 5, "source") },
    ])
      expect(scaP03QualificationAssertionsMatchV2([flow], [{ ...positive, ...wrong }])).toBe(false);
    for (const wrong of [
      make({
        vertices: [
          ...vertices.slice(0, -1),
          {
            ...vertices[7],
            path: null,
            line: null,
            name: null,
            location_provenance: "external_unaccounted" as const,
          },
        ],
      }),
      make({ vertices: vertices.slice(0, -1), edges: edges.slice(0, -1), hop_count: 6 }),
      make({ edges: edges.map((e, i) => (i === 3 ? { ...e, src_node_id: "omitted" } : e)) }),
      make({ edges: edges.map((e, i) => (i === 3 ? { ...e, dst_index: 7 } : e)) }),
      make({ edges: edges.map((e, i) => (i === 3 ? { ...e, kind: "call" as const } : e)) }),
      make({
        edges: edges.map((e, i) => (i === 3 ? { ...e, provenance: "joern_semantic" as const } : e)),
      }),
      make({
        edges: edges.map((e, i) => (i === 3 ? { ...e, branch_orientation: "true" as const } : e)),
      }),
      make({ hop_count: 17 }),
    ])
      expect(scaP03QualificationAssertionsMatchV2([wrong], [positive])).toBe(false);
  });

  it("keeps r12-like incomplete/external siblings without waiving exact negative sinks", () => {
    const complete = make();
    const external = {
      ...vertices[7],
      node_id: "external-return",
      path: null,
      name: null,
      full_name: null,
      line: null,
      location_provenance: "external_unaccounted" as const,
    };
    const incomplete = make({
      disposition: "unresolved",
      reason_code: "path_location_unaccounted",
      vertices: [...vertices.slice(0, -1), external],
      edges: [...edges.slice(0, -1), { ...edges[edges.length - 1], dst_node_id: external.node_id }],
      sink_selector: external.node_id,
    });
    const binding = {
      query_id: base.query_id,
      graph_component_sha256: base.graph_component_sha256,
      source_snapshot_sha256: base.source_snapshot_sha256,
      query_release_sha256: base.query_release_sha256,
      accounted_paths: [path],
    };
    validateScaP03QueryCandidateV2(incomplete, binding);
    const decoy = make({
      vertices: [...vertices.slice(0, -1), node("9", "decoy", 9, "sink")],
      edges: [...edges.slice(0, -1), { ...edges[edges.length - 1], dst_node_id: "9" }],
      sink_selector: "decoy",
    });
    const negative = {
      ...positive,
      expectation: "absent" as const,
      end: mark("decoy", 9, "sink"),
      sink_selector: "decoy",
    };
    expect(scaP03QualificationAssertionsMatchV2([complete, incomplete], [positive, negative])).toBe(
      true
    );
    expect(
      scaP03QualificationAssertionsMatchV2([complete, incomplete, decoy], [positive, negative])
    ).toBe(false);
    expect(scaP03QualificationAssertionsMatchV2([incomplete], [positive, negative])).toBe(false);
    expect(scaP03QualificationAssertionsMatchV2([complete, incomplete], [negative])).toBe(false);
  });
});

describe("P03 synthetic independent oracle", () => {
  it("projects the positive start domain without hiding an unexpected callee", () => {
    const assertion = expected.oracle_assertions[0];
    const start = core.vertices[0];
    const end = core.vertices[1];
    if (
      assertion === undefined ||
      assertion.end === undefined ||
      start === undefined ||
      end === undefined
    )
      throw new Error("synthetic target absent");
    const negative = {
      ...assertion,
      expectation: "absent" as const,
      end: { ...assertion.end, name: "decoy" },
    };
    const negativeCandidate = makeScaP03QueryCandidateV2({
      ...core,
      vertices: [start, { ...end, name: "decoy" }],
    });
    const wrongEnd = makeScaP03QueryCandidateV2({
      ...core,
      vertices: [start, { ...end, name: "unreviewed" }],
    });
    const wrongRole = makeScaP03QueryCandidateV2({
      ...core,
      vertices: [{ ...start, role: "unknown" }, end],
    });
    const targets = [assertion, negative];
    const raw = [wrongEnd, negativeCandidate, wrongRole, observed.observations[0]];
    const projected = projectScaP03OracleTargetObservationsV2(raw, targets);
    expect(projected).toEqual([wrongEnd, negativeCandidate, observed.observations[0]]);
    expect(projected[1]).toBe(negativeCandidate);
    expect(scaP03QualificationAssertionsMatchV2(projected, targets)).toBe(false);
    expect(scaP03QualificationAssertionsMatchV2([observed.observations[0]], targets)).toBe(true);
    const unreviewed = { ...observed, observations: [wrongEnd], observation_count: 1 };
    expect(() =>
      validateScaP03QualificationCaseProjectionV2(unreviewed, {
        ...expected,
        oracle_assertions: targets,
      })
    ).not.toThrow();
    expect(
      scaP03QualificationAssertionsMatchV2([wrongEnd, observed.observations[0]], targets)
    ).toBe(true);
    const retainedForeign = { ...observed, observations: [wrongRole, observed.observations[0]] };
    expect(() =>
      validateScaP03QualificationCaseProjectionV2(retainedForeign, {
        ...expected,
        oracle_assertions: targets,
      })
    ).toThrow(/foreign oracle targets/u);
    expect(() =>
      validateScaP03QualificationCaseProjectionV2(observed, {
        ...expected,
        oracle_assertions: targets,
      })
    ).not.toThrow();
    expect(projectScaP03OracleTargetObservationsV2([wrongRole], targets)).toEqual([]);
    const exactFields = {
      ...assertion,
      source_selector: null,
      sink_selector: null,
      reason_code: null,
    };
    expect(
      projectScaP03OracleTargetObservationsV2([observed.observations[0]], [exactFields])
    ).toHaveLength(1);
    for (const variant of [
      { ...core, framework: "express" as const },
      { ...core, registration_form: "other" },
      { ...core, callback_resolution: "dynamic" as const },
      { ...core, source_selector: "other" },
      { ...core, sink_selector: "other" },
      { ...core, reason_code: "call_unproven" },
      { ...core, edges: [{ ...core.edges[0], provenance: "joern_semantic" as const }] },
    ]) {
      expect(
        projectScaP03OracleTargetObservationsV2(
          [makeScaP03QueryCandidateV2(variant)],
          [exactFields]
        )
      ).toHaveLength(1);
    }
    expect(
      projectScaP03OracleTargetObservationsV2(
        [observed.observations[0]],
        [{ ...exactFields, via: [assertion.end] }]
      )
    ).toHaveLength(1);
    expect(projectScaP03OracleTargetObservationsV2([], targets)).toEqual([]);
  });
  it("accepts exact evidence, rejects changed candidate bytes even with recomputed identity and hash", () => {
    expect(scaP03QualificationCaseMatchesV2(observed, expected, fixture, release_sha256)).toBe(
      true
    );
    validateScaP03QualificationCaseObservationsV2(observed, release_sha256, [fixture.path]);
    const changed = changedCandidate({ ...core, summary: "different bytes" });
    expect(scaP03QualificationCaseMatchesV2(changed, expected, fixture, release_sha256)).toBe(
      false
    );
    expect(() =>
      validateScaP03QualificationCaseObservationsV2(
        { ...observed, observations: changed.observations },
        release_sha256,
        [fixture.path]
      )
    ).toThrow();
    expect(() =>
      validateScaP03QualificationCaseObservationsV2(
        { ...observed, observation_count: 0 },
        release_sha256,
        [fixture.path]
      )
    ).toThrow();
    const duplicate = [observed.observations[0], observed.observations[0]];
    expect(() =>
      validateScaP03QualificationCaseObservationsV2(
        {
          ...observed,
          observation_count: 2,
          observations: duplicate,
          observed_sha256: scaP03QualificationObservationSha256V2({
            fixture_id: fixture.fixture_id,
            fixture_sha256: fixture.content_sha256,
            query_id,
            frontend_language: observed.frontend_language,
            release_sha256,
            blocker_code: null,
            observations: duplicate,
          }),
        },
        release_sha256,
        [fixture.path]
      )
    ).toThrow();
  });

  it("evaluates material relations before hashes, rejects empty, wrong callee and incomplete chain", () => {
    expect(scaP03QualificationAssertionsMatchV2([], expected.oracle_assertions)).toBe(false);
    expect(
      scaP03QualificationCaseMatchesV2(
        observed,
        { ...expected, expected_observed_sha256: null },
        fixture,
        release_sha256
      )
    ).toBe(true);
    const start = observed.observations[0]?.vertices[0];
    const end = observed.observations[0]?.vertices[1];
    if (!start || !end) throw new Error("synthetic candidate absent");
    const wrong = changedCandidate({ ...core, vertices: [start, { ...end, name: "decoy" }] });
    expect(
      scaP03QualificationCaseMatchesV2(
        wrong,
        { ...expected, expected_observed_sha256: null },
        fixture,
        release_sha256
      )
    ).toBe(false);
    const chain = [
      {
        ...expected.oracle_assertions[0],
        via: [{ path: fixture.path, line: 3, name: "assigned", role: "unknown" as const }],
      },
    ];
    expect(scaP03QualificationAssertionsMatchV2(observed.observations, chain)).toBe(false);
  });

  it("binds blocker codes to the hash, status, and independent expected-case oracle", () => {
    const blocked = {
      ...observed,
      status: "blocked" as const,
      blocker_code: "p03_fixture_nodes_absent" as const,
      observation_count: 0,
      observations: [],
      observed_sha256: scaP03QualificationObservationSha256V2({
        fixture_id: fixture.fixture_id,
        fixture_sha256: fixture.content_sha256,
        query_id,
        frontend_language: observed.frontend_language,
        release_sha256,
        blocker_code: "p03_fixture_nodes_absent",
        observations: [],
      }),
    };
    validateScaP03QualificationCaseObservationsV2(blocked, release_sha256);
    expect(scaP03QualificationCaseMatchesV2(blocked, expected, fixture, release_sha256)).toBe(
      false
    );
    expect(() =>
      validateScaP03QualificationCaseObservationsV2(
        { ...blocked, blocker_code: "p03_graph_frontend_mismatch" },
        release_sha256
      )
    ).toThrow();
    expect(() =>
      validateScaP03QualificationCaseObservationsV2(
        { ...blocked, blocker_code: null },
        release_sha256
      )
    ).toThrow();
    expect(() =>
      validateScaP03QualificationCaseObservationsV2(
        { ...observed, blocker_code: "p03_fixture_nodes_absent" },
        release_sha256
      )
    ).toThrow();
  });

  it("refuses a substituted frontend even when observations and hash are recomputed", () => {
    const substituted = {
      ...observed,
      frontend_language: "JSSRC" as const,
      observed_sha256: scaP03QualificationObservationSha256V2({
        fixture_id: fixture.fixture_id,
        fixture_sha256: fixture.content_sha256,
        query_id,
        frontend_language: "JSSRC",
        release_sha256,
        blocker_code: null,
        observations: observed.observations,
      }),
    };
    expect(substituted.observed_sha256).not.toBe(observed.observed_sha256);
    expect(() =>
      validateScaP03QualificationCaseObservationsV2(substituted, release_sha256, [fixture.path])
    ).toThrow(/observations or digest diverge/u);
    expect(scaP03QualificationCaseMatchesV2(substituted, expected, fixture, release_sha256)).toBe(
      false
    );
  });

  it("refuses wrong callee, path, disposition, provenance, or required absence independently", () => {
    const failures = [
      { ...core, vertices: [core.vertices[0], { ...core.vertices[1], name: "wrong" }] },
      { ...core, vertices: [core.vertices[0], { ...core.vertices[1], path: "src/foreign.php" }] },
      { ...core, disposition: "unresolved" as const, reason_code: "call_unproven" },
      { ...core, edges: [{ ...core.edges[0], provenance: "joern_semantic" as const }] },
    ];
    for (const variant of failures) {
      const changed = changedCandidate(variant);
      expect(
        scaP03QualificationCaseMatchesV2(
          changed,
          { ...expected, expected_observed_sha256: changed.observed_sha256 },
          fixture,
          release_sha256
        )
      ).toBe(false);
    }
    const assertion = expected.oracle_assertions[0];
    if (assertion === undefined) throw new Error("synthetic oracle missing");
    expect(
      scaP03QualificationCaseMatchesV2(
        observed,
        {
          ...expected,
          oracle_assertions: [
            ...expected.oracle_assertions,
            { ...assertion, expectation: "absent" },
          ],
        },
        fixture,
        release_sha256
      )
    ).toBe(false);
  });
});
