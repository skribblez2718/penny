import { describe, expect, it } from "vitest";

import { sha256 } from "../dist/canonical-json.js";
import {
  SCA_P03_BASELINE_QUERY_PAGE_V2_SCHEMA,
  SCA_P03_SOURCE_ORACLE_VALIDATOR,
  SCA_P03_MAX_PATH_HOPS,
  SCA_P03_QUERY_IDS,
  SCA_P03_PARTITIONS,
  SCA_P03_COVERAGE_IDS,
  validateScaP03CoverageMatrixV1,
  validateScaP03GraphManifestV1,
  validateScaP03BaselineQueryAggregateV2,
  validateScaP03GraphCandidatePacketV2,
  validateScaP03PacketAgainstQueryPagesV2,
  makeScaP03QueryCandidateV2,
  validateScaP03BaselineQueryPageV2,
  validateScaP03QueryCandidateV2,
  withScaP03Digest,
} from "../dist/sca/p03-contracts.js";

const query_id = "p03.call-resolution.v2" as const;
const graphSha = sha256("graph");
const sourceSha = sha256("source");
const releaseSha = sha256("release");
const vertexA = {
  node_id: "call-1",
  role: "call_site" as const,
  label: "call",
  name: "invoke",
  full_name: null,
  path: "src/a.php",
  line: 3,
  column: null,
  location_provenance: "direct" as const,
  location_owner_node_id: null,
  location_evidence: null,
};
const vertexB = {
  node_id: "method-2",
  role: "callee" as const,
  label: "method",
  name: "target",
  full_name: null,
  path: "src/a.php",
  line: 9,
  column: null,
  location_provenance: "direct" as const,
  location_owner_node_id: null,
  location_evidence: null,
};
const edge = {
  src_index: 0,
  dst_index: 1,
  src_node_id: vertexA.node_id,
  dst_node_id: vertexB.node_id,
  kind: "call" as const,
  direction: "forward" as const,
  provenance: "observed_cpg" as const,
  branch_orientation: null,
  complement_ref: null,
};
const binding = {
  query_id,
  graph_component_sha256: graphSha,
  source_snapshot_sha256: sourceSha,
  query_release_sha256: releaseSha,
  accounted_paths: ["src/a.php"],
};
const base = {
  candidate_kind: "call_or_unresolved_call" as const,
  query_id,
  claim: "call_resolution" as const,
  disposition: "supported" as const,
  reason_code: null,
  source_selector: null,
  sink_selector: null,
  framework: null,
  registration_form: null,
  callback_resolution: null,
  assumptions: [],
  graph_component_sha256: graphSha,
  source_snapshot_sha256: sourceSha,
  query_release_sha256: releaseSha,
  vertices: [vertexA, vertexB],
  edges: [edge],
  hop_count: 1,
  truncated: false,
  path: "src/a.php",
  line: 3,
  stable_locator: "call-1→method-2",
  summary: "Observed call from call-1 to method-2",
} satisfies Parameters<typeof makeScaP03QueryCandidateV2>[0];
const make = (core: Parameters<typeof makeScaP03QueryCandidateV2>[0] = base) =>
  makeScaP03QueryCandidateV2(core);
const check = (core: Parameters<typeof makeScaP03QueryCandidateV2>[0]) =>
  validateScaP03QueryCandidateV2(make(core), binding);

function ref(label: string, schema: string) {
  const digest = sha256(label);
  return {
    schema_version: 2 as const,
    artifact_id: `art_${digest}`,
    run_id: "run-p03-paths",
    phase: "SCA-P03",
    branch_id: null,
    kind: label.replaceAll("_", "-"),
    operation_id: label,
    version: 1,
    producer: "host:sca-p03-candidate",
    media_type: "application/json",
    byte_length: 100,
    content_digest: digest,
    store_ref: `artifact://sha256/${digest}`,
    content_schema: { schema_id: schema, schema_version: schema.endsWith(".v2") ? 2 : 1 },
  };
}
function page(items: readonly ReturnType<typeof make>[]) {
  const graphRef = ref("graph", "penny.sca-p03-graph-component.v1");
  return withScaP03Digest(
    {
      schema_id: SCA_P03_BASELINE_QUERY_PAGE_V2_SCHEMA,
      schema_version: 2,
      run_id: "run-p03-paths",
      phase_id: "SCA-P03",
      partition: "php",
      source_snapshot_ref: ref("source", "penny.source.v1"),
      source_snapshot_sha256: sourceSha,
      graph_component_ref: {
        ...graphRef,
        content_digest: graphSha,
        store_ref: `artifact://sha256/${graphSha}`,
      },
      graph_component_sha256: graphSha,
      baseline_query_set_ref: ref("query-set", "penny.sca-p03-baseline-query-set.v2"),
      query_release_sha256: releaseSha,
      accounted_paths: ["src/a.php"],
      query_id,
      page_number: 1,
      items,
      item_count: items.length,
      complete: true,
    },
    "page_sha256"
  );
}

describe("P03 V2 structural path custody", () => {
  it("accepts a connected observed call with exact graph/source/query identity and byte accounting", () => {
    const candidate = make();
    expect(() => validateScaP03QueryCandidateV2(candidate, binding)).not.toThrow();
    expect(validateScaP03BaselineQueryPageV2(page([candidate])).items[0]).toEqual(candidate);
    expect(candidate.hop_count).toBe(1);
    expect(candidate.edges[0]?.dst_node_id).toBe(candidate.vertices[1]?.node_id);
  });

  it("rejects wrong callee, disconnected, reversed, duplicate, foreign and substituted paths", () => {
    for (const changed of [
      { ...base, vertices: [vertexA, { ...vertexB, node_id: "wrong-callee" }] },
      { ...base, edges: [{ ...edge, src_index: 1 }] },
      { ...base, edges: [{ ...edge, src_node_id: vertexB.node_id, dst_node_id: vertexA.node_id }] },
      { ...base, vertices: [vertexA, { ...vertexB, path: "foreign/other.php" }] },
      { ...base, graph_component_sha256: sha256("other-graph") },
      { ...base, query_release_sha256: sha256("old-v1-release") },
      { ...base, truncated: true },
    ])
      expect(() => check(changed)).toThrow();
    expect(() => validateScaP03BaselineQueryPageV2(page([make(), make()]))).toThrow(/unique/u);
    expect(() =>
      validateScaP03BaselineQueryPageV2({ ...page([make()]), schema_version: 1 })
    ).toThrow();
  });

  it("requires observed, accounted ownership for an inherited call-site file", () => {
    const inherited = {
      ...vertexA,
      location_provenance: "containing_method" as const,
      location_owner_node_id: "owner-3",
      location_evidence: {
        owner_node_id: "owner-3",
        owner_label: "method" as const,
        owner_path: "src/a.php",
        edge_kind: "contains" as const,
        edge_src_node_id: "owner-3",
        edge_dst_node_id: vertexA.node_id,
      },
    };
    expect(() => check({ ...base, vertices: [inherited, vertexB] })).not.toThrow();
    expect(() =>
      check({
        ...base,
        vertices: [
          {
            ...inherited,
            location_owner_node_id: vertexB.node_id,
            location_evidence: {
              ...inherited.location_evidence,
              owner_node_id: vertexB.node_id,
              edge_src_node_id: vertexB.node_id,
              owner_label: "type",
            },
          },
          vertexB,
        ],
      })
    ).toThrow();
    for (const changed of [
      { ...inherited, location_provenance: "direct" as const },
      { ...inherited, location_owner_node_id: "method-2" },
      { ...inherited, location_evidence: null },
      {
        ...inherited,
        location_evidence: { ...inherited.location_evidence, owner_path: "foreign/x.php" },
      },
      {
        ...inherited,
        location_evidence: { ...inherited.location_evidence, edge_src_node_id: "other" },
      },
      {
        ...inherited,
        location_evidence: { ...inherited.location_evidence, edge_dst_node_id: "other" },
      },
    ]) {
      expect(() => check({ ...base, vertices: [changed, vertexB] })).toThrow();
    }
    expect(() =>
      check({
        ...base,
        vertices: [{ ...inherited, line: null }, vertexB],
        line: null,
        disposition: "unresolved",
        reason_code: "relationship_unproven",
      })
    ).not.toThrow();
    expect(() =>
      check({ ...base, vertices: [{ ...inherited, line: null }, vertexB], line: null })
    ).toThrow();
  });

  it("accepts receipt-bound control, framework and reaching definition only in qualification", () => {
    const approved = {
      ...ref("source-oracle-validation", "penny.sca-p03-source-oracle-validation.v1"),
      kind: "sca-p03-source-oracle-validation",
      producer: SCA_P03_SOURCE_ORACLE_VALIDATOR,
    };
    const reviewed = {
      location_provenance: "qualified_source_oracle" as const,
      source_location_ref: approved,
    };
    const a = {
      ...vertexA,
      ...reviewed,
      cpg_line: 3,
      node_id: "1",
      role: "guard" as const,
      label: "control_structure",
    };
    const b = {
      ...vertexB,
      ...reviewed,
      cpg_line: 9,
      node_id: "2",
      role: "action" as const,
      label: "identifier",
    };
    const control = make({
      ...base,
      query_id: "p03.control-guard.v2",
      claim: "control_reachability",
      candidate_kind: "guard_or_control_relationship",
      vertices: [a, b],
      edges: [
        {
          ...edge,
          src_node_id: "1",
          dst_node_id: "2",
          kind: "dispatch",
          provenance: "qualified_complement",
          branch_orientation: "true",
          complement_ref: approved,
        },
      ],
    });
    const bind = { ...binding, query_id: control.query_id, approved_complement_ref: approved };
    const complementEdge = control.edges[0];
    if (complementEdge === undefined) throw new Error("complement edge missing");
    expect(() => validateScaP03QueryCandidateV2(control, bind)).not.toThrow();
    for (const invalid of [
      { ...a, source_location_ref: ref("foreign", "penny.sca-p03-source-oracle-validation.v1") },
      { ...a, location_provenance: "direct" as const },
      { ...a, cpg_line: 0 },
    ])
      expect(() =>
        validateScaP03QueryCandidateV2(make({ ...control, vertices: [invalid, b] }), bind)
      ).toThrow();
    expect(() => validateScaP03QueryCandidateV2(control, binding)).toThrow();
    expect(() =>
      validateScaP03QueryCandidateV2(control, {
        ...bind,
        approved_complement_ref: ref("foreign", "penny.sca-p03-source-oracle-validation.v1"),
      })
    ).toThrow();
    expect(() => validateScaP03BaselineQueryPageV2(page([control]))).toThrow();
    // Rehashing a forged candidate does not repair its missing semantic authority.
    for (const changed of [
      { ...control, edges: [{ ...complementEdge, complement_ref: null }] },
      { ...control, edges: [{ ...complementEdge, provenance: "observed_cpg" as const }] },
      { ...control, edges: [{ ...complementEdge, kind: "cfg" as const }] },
      { ...control, vertices: [{ ...a, node_id: "synthetic" }, b] },
      { ...control, claim: "call_resolution" as const },
      { ...control, query_id: "p03.graph-integrity.v2" as const },
    ]) {
      const { candidate_id: _candidate, serialized_bytes: _bytes, ...core } = changed;
      void _candidate;
      void _bytes;
      expect(() =>
        validateScaP03QueryCandidateV2(make(core), { ...bind, query_id: core.query_id })
      ).toThrow();
    }
    const middle = { ...b, node_id: "3", role: "unknown" as const };
    const twoHop = {
      ...control,
      vertices: [a, middle, b],
      edges: [
        { ...complementEdge, dst_node_id: "3" },
        { ...complementEdge, src_index: 1, dst_index: 2, src_node_id: "3" },
      ],
      hop_count: 2,
    };
    const { candidate_id: _twoId, serialized_bytes: _twoSize, ...twoCore } = twoHop;
    void _twoId;
    void _twoSize;
    for (const altered of [
      {
        ...complementEdge,
        src_index: 1,
        dst_index: 2,
        src_node_id: "3",
        provenance: "observed_cpg" as const,
        complement_ref: null,
      },
      {
        ...complementEdge,
        src_index: 1,
        dst_index: 2,
        src_node_id: "3",
        complement_ref: ref("foreign", "penny.sca-p03-source-oracle-validation.v1"),
      },
      {
        ...complementEdge,
        src_index: 1,
        dst_index: 2,
        src_node_id: "3",
        branch_orientation: "false" as const,
      },
    ])
      expect(() =>
        validateScaP03QueryCandidateV2(
          make({ ...twoCore, edges: [twoCore.edges[0] ?? complementEdge, altered] }),
          bind
        )
      ).toThrow();
    const framework = make({
      ...base,
      candidate_kind: "route_or_framework_surface",
      query_id: "p03.framework-dispatch.v2",
      claim: "framework_dispatch",
      framework: "express",
      registration_form: "router.get",
      callback_resolution: "observed",
      vertices: [
        { ...a, role: "registration", label: "call" },
        { ...b, role: "handler", label: "method" },
      ],
      edges: [{ ...complementEdge, branch_orientation: null }],
    });
    expect(() =>
      validateScaP03QueryCandidateV2(framework, { ...bind, query_id: framework.query_id })
    ).not.toThrow();
    const { candidate_id: _id, serialized_bytes: _length, ...frameworkCore } = framework;
    void _id;
    void _length;
    expect(() =>
      validateScaP03QueryCandidateV2(
        make({
          ...frameworkCore,
          edges: [{ ...complementEdge, kind: "call", branch_orientation: null }],
        }),
        { ...bind, query_id: framework.query_id }
      )
    ).toThrow();
    const flow = make({
      ...base,
      candidate_kind: "source_to_sink_flow",
      query_id: "p03.dataflow-source-sink.v2",
      claim: "reaching_definition",
      source_selector: "invoke",
      sink_selector: "target",
      vertices: [
        { ...a, role: "source", label: "identifier" },
        { ...b, role: "sink", label: "identifier" },
      ],
      edges: [{ ...complementEdge, kind: "reaching_def", branch_orientation: null }],
    });
    expect(() =>
      validateScaP03QueryCandidateV2(flow, { ...bind, query_id: flow.query_id })
    ).not.toThrow();
  });

  it("refuses CFG without branch control evidence, unqualified flow and dynamic callbacks", () => {
    for (const changed of [
      {
        ...base,
        query_id: "p03.control-guard.v2" as const,
        claim: "control_reachability" as const,
        vertices: [
          { ...vertexA, role: "guard" as const },
          { ...vertexB, role: "action" as const },
        ],
        edges: [{ ...edge, kind: "cfg" as const, branch_orientation: null }],
      },
      {
        ...base,
        query_id: "p03.dataflow-source-sink.v2" as const,
        claim: "reaching_definition" as const,
        source_selector: "request.body",
        sink_selector: "eval",
        vertices: [
          { ...vertexA, role: "source" as const },
          { ...vertexB, role: "sink" as const },
        ],
        edges: [{ ...edge, kind: "reaching_def" as const }],
      },
      {
        ...base,
        query_id: "p03.framework-dispatch.v2" as const,
        claim: "framework_dispatch" as const,
        framework: "express" as const,
        registration_form: "app.get",
        callback_resolution: "dynamic" as const,
        vertices: [
          { ...vertexA, role: "registration" as const },
          { ...vertexB, role: "handler" as const },
        ],
      },
    ])
      expect(() =>
        validateScaP03QueryCandidateV2(make(changed), { ...binding, query_id: changed.query_id })
      ).toThrow();
  });

  it("retains external endpoints only as unresolved traces; never promotes endpoint-only fidelity", () => {
    const external = {
      ...vertexB,
      path: null,
      line: null,
      column: null,
      name: null,
      full_name: null,
      location_provenance: "external_unaccounted" as const,
    };
    const unresolved = {
      ...base,
      disposition: "unresolved" as const,
      reason_code: "path_location_unaccounted",
      vertices: [vertexA, external],
      summary: "Full relationship path location unavailable",
    };
    expect(() => check(unresolved)).not.toThrow();
    expect(validateScaP03BaselineQueryPageV2(page([make(unresolved)])).item_count).toBe(1);
    const externalStart = {
      ...unresolved,
      vertices: [
        {
          ...vertexA,
          path: null,
          line: null,
          name: null,
          full_name: null,
          location_provenance: "external_unaccounted" as const,
        },
        vertexB,
      ],
      path: null,
      line: null,
    };
    expect(() => check(externalStart)).not.toThrow();
    expect(() =>
      check({
        ...externalStart,
        vertices: [
          {
            ...vertexA,
            path: null,
            line: null,
            name: null,
            full_name: null,
            location_provenance: "external_unaccounted" as const,
          },
        ],
        edges: [],
        hop_count: 0,
      })
    ).not.toThrow();
    for (const changed of [
      { ...unresolved, disposition: "supported" as const, reason_code: null },
      { ...unresolved, reason_code: "relationship_unproven" },
      { ...unresolved, vertices: [vertexA, { ...external, path: "src/a.php" }] },
      { ...unresolved, vertices: [vertexA, { ...external, name: "generated" }] },
      { ...unresolved, vertices: [vertexA, { ...external, path: "foreign/other.php", line: 1 }] },
      { ...base, disposition: "unresolved" as const, reason_code: "path_location_unaccounted" },
      { ...externalStart, path: "src/a.php", line: 3 },
    ])
      expect(() => check(changed)).toThrow();
    for (const [query, claim, roles, kind] of [
      ["p03.control-guard.v2", "control_reachability", ["guard", "action"], "cfg"],
      ["p03.dataflow-source-sink.v2", "reaching_definition", ["source", "sink"], "reaching_def"],
      ["p03.framework-dispatch.v2", "framework_dispatch", ["registration", "handler"], "call"],
    ] as const) {
      const proposed = {
        ...unresolved,
        query_id: query,
        claim,
        source_selector: claim === "reaching_definition" ? "call-1" : null,
        sink_selector: claim === "reaching_definition" ? "method-2" : null,
        callback_resolution: claim === "framework_dispatch" ? ("dynamic" as const) : null,
        vertices: [
          { ...vertexA, role: roles[0] },
          { ...external, role: roles[1] },
        ],
        edges: [{ ...edge, kind }],
      };
      expect(() =>
        validateScaP03QueryCandidateV2(make(proposed), { ...binding, query_id: query })
      ).not.toThrow();
      expect(() =>
        validateScaP03QueryCandidateV2(
          make({ ...proposed, disposition: "supported", reason_code: null }),
          { ...binding, query_id: query }
        )
      ).toThrow();
    }
  });

  it("refuses forged complement provenance, excessive hops and missing framework query", () => {
    expect(() =>
      check({ ...base, edges: [{ ...edge, provenance: "qualified_complement" }] })
    ).toThrow();
    expect(() => check({ ...base, hop_count: SCA_P03_MAX_PATH_HOPS + 1 })).toThrow();
    expect(() =>
      validateScaP03BaselineQueryPageV2({
        ...page([make()]),
        items: [{ ...make(), serialized_bytes: 64 * 1024 * 1024 + 1 }],
      })
    ).toThrow();
    expect(SCA_P03_QUERY_IDS).toHaveLength(7);
    expect(SCA_P03_QUERY_IDS[5]).toBe("p03.framework-dispatch.v2");
  });
});

describe("P03 exhaustive extraction boundary", () => {
  const common = {
    tenant_id: "tenant",
    project_id: "project",
    run_id: "run-p03-paths",
    phase_id: "SCA-P03",
    p01_binding_sha256: sha256("p01"),
    p02_binding_sha256: sha256("p02"),
    p03_runtime_binding_sha256: sha256("p03"),
    source_snapshot_ref: ref("source", "penny.source.v1"),
    source_snapshot_sha256: sourceSha,
  };
  function cohort() {
    const unresolved = make({
      ...base,
      disposition: "unresolved",
      reason_code: "relationship_unproven",
    });
    const phpPage = validateScaP03BaselineQueryPageV2(page([unresolved]));
    const { page_sha256: _pageSha, ...pageCore } = phpPage;
    const pages = SCA_P03_PARTITIONS.flatMap((partition) =>
      SCA_P03_QUERY_IDS.map((queryId, index) => {
        const queryPage = validateScaP03BaselineQueryPageV2(
          withScaP03Digest(
            {
              ...pageCore,
              partition,
              query_id: queryId,
              items: partition === "php" && queryId === query_id ? [unresolved] : [],
              item_count: partition === "php" && queryId === query_id ? 1 : 0,
            },
            "page_sha256"
          )
        );
        return {
          ref: ref(partition + "-page-" + index, "penny.sca-p03-baseline-query-page.v2"),
          page: queryPage,
        };
      })
    );
    const graph = validateScaP03GraphManifestV1(
      withScaP03Digest(
        {
          schema_id: "penny.sca-p03-graph-manifest.v1",
          schema_version: 1,
          ...common,
          components: SCA_P03_PARTITIONS.map((partition) => ({
            partition,
            graph_component_ref: phpPage.graph_component_ref,
            graph_build_result_ref: ref(
              partition + "-build",
              "penny.sca-p03-graph-build-result.v1"
            ),
            graph_provenance_ref: ref(
              partition + "-provenance",
              "penny.sca-p03-graph-provenance.v1"
            ),
            graph_id: partition + "-graph",
            status: "complete",
          })),
          complete: true,
        },
        "manifest_sha256"
      )
    );
    const aggregate = validateScaP03BaselineQueryAggregateV2(
      withScaP03Digest(
        {
          schema_id: "penny.sca-p03-baseline-query-aggregate.v2",
          schema_version: 2,
          ...common,
          baseline_query_set_ref: phpPage.baseline_query_set_ref,
          complete: true,
          batches: SCA_P03_PARTITIONS.map((partition) => ({
            partition,
            graph_component_ref: phpPage.graph_component_ref,
            query_batch_request_ref: ref(
              partition + "-request",
              "penny.sca-p03-baseline-query-batch-request.v2"
            ),
            query_batch_result_ref: ref(
              partition + "-result",
              "penny.sca-p03-baseline-query-batch-result.v2"
            ),
            page_refs: pages
              .filter((entry) => entry.page.partition === partition)
              .map((entry) => entry.ref),
            ordered_query_ids: SCA_P03_QUERY_IDS,
            complete: true,
            truncated: false,
          })),
        },
        "aggregate_sha256"
      )
    );
    const sourcePage = pages.find((entry) => entry.page.items.length > 0);
    if (sourcePage === undefined) throw new Error("candidate page absent");
    const packet = validateScaP03GraphCandidatePacketV2(
      withScaP03Digest(
        {
          schema_id: "penny.sca-p03-graph-candidate-packet.v2",
          schema_version: 2,
          ...common,
          baseline_query_set_ref: phpPage.baseline_query_set_ref,
          graph_manifest_ref: ref("graph-manifest", "penny.sca-p03-graph-manifest.v1"),
          candidates: [
            {
              ...unresolved,
              partition: "php",
              accounted_paths: phpPage.accounted_paths,
              graph_component_ref: phpPage.graph_component_ref,
              page_ref: sourcePage.ref,
            },
          ],
          complete: true,
          source_bound: true,
        },
        "packet_sha256"
      )
    );
    return { packet, aggregate, graph_manifest: graph, pages };
  }
  it("accepts complete extraction with unchanged unresolved candidates", () => {
    const input = cohort();
    expect(() => validateScaP03PacketAgainstQueryPagesV2(input)).not.toThrow();
    expect(input.packet.candidates[0]?.disposition).toBe("unresolved");
  });
  it.each(["dropped", "modified", "relabelled", "duplicate", "missing_provenance", "truncated"])(
    "rejects %s even with recomputed packet identity",
    (defect) => {
      const input = cohort();
      const candidate = input.packet.candidates[0];
      if (candidate === undefined) throw new Error("candidate absent");
      const {
        candidate_id: _id,
        serialized_bytes: _size,
        partition: _partition,
        accounted_paths: _paths,
        graph_component_ref: _graph,
        page_ref: _page,
        ...core
      } = candidate;
      const changed =
        defect === "modified"
          ? makeScaP03QueryCandidateV2({ ...core, summary: "Changed summary" })
          : defect === "relabelled"
            ? makeScaP03QueryCandidateV2({ ...core, disposition: "supported", reason_code: null })
            : defect === "truncated"
              ? makeScaP03QueryCandidateV2({ ...core, truncated: true })
              : candidate;
      const { packet_sha256: _packetSha, ...packetCore } = input.packet;
      const value = withScaP03Digest(
        {
          ...packetCore,
          candidates:
            defect === "dropped"
              ? []
              : defect === "duplicate"
                ? [candidate, candidate]
                : [
                    {
                      ...candidate,
                      ...changed,
                      page_ref:
                        defect === "missing_provenance"
                          ? ref("foreign-page", "penny.sca-p03-baseline-query-page.v2")
                          : candidate.page_ref,
                    },
                  ],
        },
        "packet_sha256"
      );
      expect(() => {
        const packet = validateScaP03GraphCandidatePacketV2(value);
        validateScaP03PacketAgainstQueryPagesV2({ ...input, packet });
      }).toThrow();
    }
  );
  it("pins all nine coverage entries and rejects missing, extra and order drift", () => {
    expect(SCA_P03_COVERAGE_IDS).toHaveLength(9);
    const entries = SCA_P03_COVERAGE_IDS.map((coverage_id) => ({
      coverage_id,
      status: "complete",
      blocker_codes: [],
      evidence_refs: [ref("evidence", "penny.evidence.v1")],
    }));
    const build = (rows: typeof entries) =>
      withScaP03Digest(
        {
          schema_id: "penny.sca-p03-coverage-matrix.v1",
          schema_version: 1,
          ...common,
          entries: rows,
        },
        "coverage_sha256"
      );
    expect(validateScaP03CoverageMatrixV1(build(entries)).entries).toHaveLength(9);
    const first = entries[0];
    if (first === undefined) throw new Error("coverage empty");
    for (const rows of [entries.slice(1), [...entries, first], [...entries].reverse()])
      expect(() => validateScaP03CoverageMatrixV1(build(rows))).toThrow();
  });
});
