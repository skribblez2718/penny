import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  SCA_P03_QUERY_IDS,
  SCA_P03_SOURCE_ORACLE_SCHEMA,
  SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
  SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
  SCA_P03_SOURCE_ORACLE_PRODUCER,
  SCA_P03_SOURCE_ORACLE_VALIDATOR,
  SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
  SCA_P03_QUALIFICATION_DATAFLOW_MAX_HOPS,
  scaP03FrontendLanguageV1,
  scaP03QualificationObservationSha256V2,
  scaP03QualificationAssertionsMatchV2,
  validateScaP03OperationRequestV1,
  validateScaP03QueryPlanV2,
  withScaP03Digest,
  validateScaP03QueryCandidateV2,
  validateScaP03QualificationCaseObservationsV2,
  validateScaP03QualificationFixtureCorpusV2,
  type ScaP03QualificationCaseV2,
  type ScaP03QueryPlanV2,
} from "../../orchestration/dist/sca/p03-contracts.js";
import {
  createScaP03DockerJoernCandidateV1,
  createScaP03DockerSimulatedTestRuntimeV1,
  scaP03OwnedDockerLabelsMatchV1,
  type DockerRunnerV1,
  type ScaP03DockerRuntimeConfigV1,
} from "../src/p03-docker-runtime.js";
import type { ScaP03FrozenQueryReleaseV1 } from "../src/p03-operations.js";
import { projectSourceOracleCases, validateAndSealSourceOracle } from "../src/p03-source-oracle.js";
import { revalidateP03SourceOracle } from "../src/p03-oracle-authority.js";
import { pinnedInventory, syntheticOracleCase } from "./p03-test-oracle.js";
import { readSourceOracle } from "./p03-source-oracle.js";

const manifestDigest = "b".repeat(64);
const imageDigest = "c".repeat(64);
const image = `registry.example/joern@sha256:${manifestDigest}`;
const ref = {
  schema_version: 2,
  artifact_id: `art_${"a".repeat(64)}`,
  run_id: "run",
  phase: "SCA-P03",
  branch_id: null,
  kind: "p03-input",
  operation_id: "p03-input",
  version: 1,
  producer: "host:test",
  media_type: "application/json",
  byte_length: 1,
  content_digest: "c".repeat(64),
  store_ref: `artifact://sha256/${"c".repeat(64)}`,
} as const;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "p03-docker-test-"));
  roots.push(parent);
  const executableSha = sha256(await readFile(process.execPath));
  const config: ScaP03DockerRuntimeConfigV1 = {
    docker_executable: process.execPath,
    image_ref: image,
    expected_joern_version: "4.0.627",
    expected_docker_executable_sha256: executableSha,
    expected_docker_client_version: "1.0.0",
    expected_docker_server_version: "1.0.0",
    runtime_id: "runtime",
    isolation_id: "isolation",
    isolation_profile_sha256: "1".repeat(64),
    implementation_identity_sha256: "2".repeat(64),
    deployment_identity_sha256: sha256(
      canonicalJson({
        docker_executable_sha256: executableSha,
        docker_client_version: "1.0.0",
        docker_server_version: "1.0.0",
        image_id: `sha256:${imageDigest}`,
        joern_version: "4.0.627",
      })
    ),
    staging_parent: parent,
    memory_bytes: 512 * 1024 * 1024,
    cpus: 1,
    pids: 128,
    max_workspace_bytes: 4 * 1024 * 1024,
    max_num_def: 100,
    max_command_output_bytes: 100_000,
    timeout_ms: 3000,
  };
  return { parent, config };
}
function graphRequest(
  content: Uint8Array,
  runtimeDigest = imageDigest,
  maxGraphBytes = 4096,
  partition: "php" | "javascript_typescript" = "php",
  filePath = "src/a.php"
) {
  const common = {
    schema_id: "penny.sca-p03-graph-build-request.v1",
    schema_version: 1,
    tenant_id: "tenant",
    project_id: "project",
    run_id: "run",
    phase_id: "SCA-P03",
    operation_id:
      partition === "php"
        ? "sca-p03-build-source-graph-php"
        : "sca-p03-build-source-graph-javascript-typescript",
    operation_kind: "build_source_graph",
    p01_binding_sha256: "1".repeat(64),
    p02_binding_sha256: "2".repeat(64),
    p03_runtime_binding_sha256: "3".repeat(64),
    source_snapshot_ref: ref,
    source_snapshot_sha256: ref.content_digest,
    p03_request_ref: ref,
    runtime_policy_ref: ref,
    joern_runtime_identity_ref: ref,
    isolation_evidence_ref: ref,
    host_isolation_attestation_ref: ref,
    implementation_identity_ref: ref,
    qualification_profile_ref: ref,
    baseline_query_set_ref: ref,
    runtime_id: "runtime",
    runtime_kind: "host_qualified_joern",
    qualification_scope: "live_qualified",
    runtime_tree_sha256: runtimeDigest,
    isolation_id: "isolation",
    isolation_profile_sha256: "1".repeat(64),
    partition,
    frontend_language: partition === "php" ? ("PHP" as const) : ("JSSRC" as const),
    source_file_manifest_ref: ref,
    source_custody_ref: ref,
    expected_files: [{ path: filePath, content_sha256: sha256(content), role: "primary" }],
    max_num_def: 100,
    max_graph_bytes: maxGraphBytes,
  } as const;
  return validateScaP03OperationRequestV1(
    "build_source_graph",
    withScaP03Digest(common, "request_sha256")
  );
}
async function reviewedInventory(
  fixturePath: string,
  encode: (value: string) => string,
  defect?: "bad-line" | "ambiguous"
): Promise<string> {
  const { oracle } = await readSourceOracle();
  const fixture = oracle.fixtures.find((entry) => entry.path === fixturePath);
  if (fixture === undefined) throw new Error("reviewed fixture absent");
  const fixtureBytes = (await readSourceOracle()).fixtures.find(
    (entry) => entry.path === fixturePath
  )?.bytes;
  if (fixtureBytes === undefined) throw new Error("reviewed fixture bytes absent");
  const awaitedSourceLines = fixtureBytes.toString("utf8").split("\n");
  const nodes = new Map<
    string,
    { id: string; label: string; name: string; line: number; code: string }
  >();
  const edges: string[] = [];
  const nodeFor = (
    selector: { line: number; name: string | null; role: string },
    queryId: string
  ) => {
    if (selector.name === null) throw new Error("reviewed selector unnamed");
    const label =
      selector.role === "symbol" || selector.role === "callee" || selector.role === "handler"
        ? "METHOD"
        : selector.role === "call_site" || selector.role === "registration"
          ? "CALL"
          : selector.role === "guard"
            ? "CONTROL_STRUCTURE"
            : selector.role === "source" &&
                (fixture.language === "php" || fixture.language === "typescript") &&
                queryId === "p03.dataflow-source-sink.v2"
              ? "METHOD_PARAMETER_IN"
              : "IDENTIFIER";
    const key = `${String(selector.line)}:${selector.name}:${label}`;
    let node = nodes.get(key);
    if (node === undefined) {
      node = {
        id: String(nodes.size + 1),
        label,
        name:
          selector.role === "registration" && selector.name === "@Get"
            ? "Get"
            : selector.role === "registration" && selector.name === "router.get"
              ? "get"
              : selector.name.startsWith("$")
                ? selector.name.slice(1)
                : selector.name,
        line: selector.line,
        code:
          selector.role === "guard"
            ? `if (${selector.name})`
            : selector.role === "registration"
              ? selector.name === "@Get"
                ? 'Get("one")'
                : selector.name === "router.get"
                  ? 'router.get("/records", handleRecord)'
                  : 'add_action("init", "handle_record")'
              : selector.role === "handler"
                ? (awaitedSourceLines[selector.line - 1] ?? "").trim()
                : selector.name,
      };
      nodes.set(key, node);
    }
    void queryId;
    return node;
  };
  for (const material of fixture.material_cases) {
    const positive = material.assertions.find((assertion) => assertion.expectation === "present");
    if (positive?.start === undefined) throw new Error("reviewed positive absent");
    const chain = [
      positive.start,
      ...(positive.via ?? []),
      ...(positive.end ? [positive.end] : []),
    ].map((selector) => nodeFor(selector, material.query_id));
    if (
      material.query_id === "p03.call-resolution.v2" ||
      material.query_id === "p03.control-guard.v2" ||
      material.query_id === "p03.framework-dispatch.v2" ||
      (fixture.language === "javascript" && material.query_id === "p03.dataflow-source-sink.v2")
    ) {
      const edge =
        material.query_id === "p03.control-guard.v2"
          ? "CFG"
          : material.query_id === "p03.dataflow-source-sink.v2"
            ? "REACHING_DEF"
            : "CALL";
      for (let index = 1; index < chain.length; index++) {
        const before = chain[index - 1];
        const after = chain[index];
        if (before === undefined || after === undefined) throw new Error("reviewed chain absent");
        edges.push(`EDGE\t${before.id}\t${after.id}\t${encode(edge)}`);
      }
    }
  }
  return (
    [
      `FILE\t${encode(`/source/${fixturePath}`)}`,
      ...[...nodes.values()].map(
        (node) =>
          `NODE\t${node.id}\t${encode(node.label)}\t${encode(`/source/${fixturePath}`)}\t${encode(String(defect === "bad-line" && node.label === "CONTROL_STRUCTURE" ? node.line + 1 : node.line))}\t${encode(node.name)}\t\t${encode(node.code)}`
      ),
      ...(defect === "ambiguous"
        ? [...nodes.values()]
            .filter((node) => node.label === "CONTROL_STRUCTURE")
            .map(
              (node) =>
                `NODE\t${String(nodes.size + Number(node.id))}\t${encode(node.label)}\t${encode(`/source/${fixturePath}`)}\t${encode(String(node.line))}\t${encode(node.name)}\t\t${encode(node.code)}`
            )
        : []),
      ...edges,
    ].join("\n") + "\n"
  );
}

function mockRunner(
  calls: string[][],
  mode:
    | "normal"
    | "drift"
    | "missing"
    | "cleanup-fails"
    | "graph"
    | "graph-unlocated"
    | "graph-target-negative"
    | "graph-flow"
    | "graph-flow-negative"
    | "graph-flow-deep"
    | "graph-flow-at-limit"
    | "graph-flow-too-deep"
    | "graph-flow-byte-limit"
    | "graph-code-targets"
    | "graph-reviewed-anchors"
    | "graph-reviewed-bad-line"
    | "graph-reviewed-ambiguous"
    | "graph-pinned-anchors"
    | "graph-pinned-bad-line"
    | "graph-pinned-ambiguous"
    | "graph-pinned-wrong-handler"
    | "graph-pinned-wrong-registration"
    | "graph-pinned-wrong-action"
    | "graph-pinned-outside-handler"
    | "graph-pinned-reuse"
    | "graph-pinned-no-param-ast"
    | "graph-pinned-param-contains"
    | "graph-pinned-foreign-param-owner"
    | "graph-pinned-duplicate-param-owner"
    | "graph-pinned-wrong-param-code"
    | "graph-pinned-wrong-param-name"
    | "graph-pinned-wrong-param-line"
    | "graph-pinned-wrong-param-method"
    | "graph-pinned-param-cycle"
    | "graph-pinned-param-depth"
    | "graph-pinned-param-outside-span"
    | "graph-ts-many"
    | "graph-ts-over-limit"
    | "graph-ambiguous"
    | "graph-external-owner"
    | "graph-no-call-line"
    | "wrong-frontend"
    | "reject-frontend"
    | "zero-nodes"
    | "invalid-inventory"
    | "missing-code-field"
    | "invalid-code-encoding"
    | "reject-inventory"
    | "output-limit"
    | "unknown-failure"
    | "bad-posture"
    | "joern-drift"
    | "extra-output"
    | "linked-output"
    | "workspace-full" = "normal"
): DockerRunnerV1 {
  let name = "";
  let entrypoint = "";
  let running = false;
  let removed = false;
  let created: readonly string[] = [];
  let parseFrontend = "PHP";
  return async ({ argv, signal }) => {
    if (signal.aborted) throw new Error("aborted");
    calls.push([...argv]);
    if (argv[0] === "version")
      return JSON.stringify({ Client: { Version: "1.0.0" }, Server: { Version: "1.0.0" } });
    if (argv[0] === "image")
      return JSON.stringify({
        Id: `sha256:${mode === "drift" ? "d".repeat(64) : imageDigest}`,
        RepoDigests: [image],
      });
    if (argv[0] !== "container") throw new Error("unexpected Docker call");
    if (argv[1] === "create") {
      created = argv;
      name = argv[argv.indexOf("--name") + 1] ?? "";
      entrypoint = argv[argv.indexOf("--entrypoint") + 1] ?? "";
      removed = false;
      running = false;
      return "e".repeat(64) + "\n";
    }
    if (argv[1] === "inspect") {
      const mounts = created
        .flatMap((arg, index) => (arg === "--mount" ? [created[index + 1] ?? ""] : []))
        .map((mount) => {
          const parts = mount.split(",");
          return {
            Type: "bind",
            Source: parts.find((part) => part.startsWith("src="))?.slice(4),
            Destination: parts.find((part) => part.startsWith("dst="))?.slice(4),
            RW: !parts.includes("readonly"),
          };
        });
      return JSON.stringify({
        Id: "e".repeat(64),
        Image: `sha256:${mode === "drift" ? "d".repeat(64) : imageDigest}`,
        Name: `/${name}`,
        State: { Status: running ? "running" : "created", Running: running },
        Mounts: mounts,
        Config: {
          User: created[created.indexOf("--user") + 1],
          WorkingDir: "/tmp",
          Env: ["HOME=/tmp"],
          Entrypoint: ["sleep"],
          Cmd: created.slice(created.indexOf(image) + 1),
        },
        HostConfig: {
          NetworkMode: mode === "bad-posture" ? "bridge" : "none",
          ReadonlyRootfs: true,
          Init: true,
          Privileged: false,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          PidsLimit: 128,
          Memory: 512 * 1024 * 1024,
          MemorySwap: 512 * 1024 * 1024,
          NanoCpus: 1_000_000_000,
          LogConfig: { Type: "none" },
          Tmpfs: {
            "/tmp": "rw,exec,nosuid,nodev,size=67108864",
            "/work":
              created[created.indexOf("/tmp:rw,exec,nosuid,nodev,size=67108864") + 2]?.slice(6),
          },
        },
      });
    }
    if (argv[1] === "start") {
      running = true;
      return "";
    }
    if (argv[1] === "exec") {
      entrypoint = argv[3] ?? "";
      if (entrypoint === "find") {
        const pattern = argv[argv.indexOf("-name") + 1] ?? "";
        if (pattern === "io.joern.joern-cli-*.jar")
          return `io.joern.joern-cli-${mode === "joern-drift" ? "4.0.626" : "4.0.627"}.jar\n`;
        if (pattern === "io.joern.php2cpg-*.jar")
          return "io.joern.php2cpg-4.0.627-launcher.jar\nio.joern.php2cpg-4.0.627.jar\n";
        if (pattern === "io.joern.jssrc2cpg-*.jar")
          return "io.joern.jssrc2cpg-4.0.627.jar\nio.joern.jssrc2cpg-4.0.627-launcher.jar\n";
      }
      if (entrypoint === "which") return "/opt/joern/joern-cli/joern\n";
      if (entrypoint === "joern" && argv[4] === "--help")
        return "Usage: joern [options] [<cpg.bin>]\n\nScript execution\n";
      if (entrypoint === "joern-parse") {
        parseFrontend = argv[argv.indexOf("--language") + 1] ?? "";
        if (mode === "reject-frontend" && parseFrontend === "JSSRC")
          throw new Error("docker_container_exec_exit_1");
        if (mode === "unknown-failure" && parseFrontend === "JSSRC")
          throw new Error("secret stdout: token=do-not-disclose");
      }
      if (mode === "workspace-full") throw new Error("docker_container_exec_exit_1");
      if (mode === "output-limit" && parseFrontend === "JSSRC")
        throw new Error("docker_output_limit");
      if (mode === "reject-inventory" && entrypoint === "joern" && parseFrontend === "JSSRC")
        throw new Error("docker_container_exec_exit_9");
      if (entrypoint === "python3") {
        const sourceMount = created.find((arg) => arg.endsWith("dst=/source,readonly"));
        const source = sourceMount
          ?.split(",")
          .find((part) => part.startsWith("src="))
          ?.slice(4);
        const fileName =
          source === undefined ? "a.php" : (await readdir(path.join(source, "src")))[0];
        if (fileName === undefined) throw new Error("mock source missing");
        const fixturePath = `src/${fileName}`;
        const encode = (value: string) => Buffer.from(value).toString("base64");
        const metadata = `META\t${encode(mode === "wrong-frontend" && parseFrontend === "JSSRC" ? "JAVASCRIPT" : parseFrontend)}\n`;
        const fixtureNode = `NODE\t1\t${encode("METHOD")}\t${encode(`/source/${fixturePath}`)}\t${encode("1")}\t${encode("sample")}\t\t`;
        const fixtureFile = `FILE\t${encode(`/source/${fixturePath}`)}`;
        if (mode === "linked-output" || mode === "extra-output")
          throw new Error("docker_container_exec_exit_2");
        const isGraphReadback = argv[5] === "graph.cpg.bin";
        if (mode === "invalid-inventory" && !isGraphReadback && parseFrontend === "JSSRC")
          return Buffer.from("INVALID\tprivate payload").toString("base64");
        if (!isGraphReadback && mode === "missing-code-field")
          return Buffer.from(`${metadata}${fixtureFile}\n${fixtureNode.slice(0, -2)}\n`).toString(
            "base64"
          );
        if (!isGraphReadback && mode === "invalid-code-encoding")
          return Buffer.from(`${metadata}${fixtureFile}\n${fixtureNode}not_base64!\n`).toString(
            "base64"
          );
        const data = isGraphReadback
          ? "real-cpg-output"
          : mode === "missing"
            ? "FILE\tL3NvdXJjZS9vdGhlci5waHA=\n"
            : (mode === "graph-ts-many" || mode === "graph-ts-over-limit") &&
                fixturePath === "src/a.ts"
              ? [
                  fixtureFile,
                  ...Array.from(
                    { length: mode === "graph-ts-many" ? 129 : 257 },
                    (_, index) =>
                      `NODE\t${String(index + 1)}\t${encode("METHOD")}\t${encode(`/source/${fixturePath}`)}\t${encode(String(index + 1))}\t${encode(`method${String(index)}`)}\t\t`
                  ),
                ].join("\n") + "\n"
              : mode === "graph-unlocated" ||
                  mode === "graph-ambiguous" ||
                  mode === "graph-external-owner" ||
                  mode === "graph-no-call-line"
                ? [
                    fixtureFile,
                    ...[
                      ["1", "METHOD", `/source/${fixturePath}`, "1"],
                      ["2", "CALL", "", mode === "graph-no-call-line" ? "" : "2"],
                      ["3", "METHOD", "", ""],
                      ["4", "CALL", "/generated/out.php", "8"],
                      ["5", "IDENTIFIER", "", ""],
                      [
                        "6",
                        "METHOD",
                        mode === "graph-external-owner"
                          ? "/generated/out.php"
                          : `/source/${fixturePath}`,
                        "",
                      ],
                    ].map(
                      ([id, kind, file, line]) =>
                        `NODE\t${id}\t${Buffer.from(kind ?? "").toString("base64")}\t${Buffer.from(file ?? "").toString("base64")}\t${Buffer.from(line ?? "").toString("base64")}\t${Buffer.from("external-name").toString("base64")}\t\t`
                    ),
                    ...[
                      ["6", "2", "CONTAINS"],
                      ...(mode === "graph-ambiguous" ? [["1", "2", "CONTAINS"]] : []),
                      ["2", "3", "CALL"],
                      ["2", "1", "CALL"],
                      ["4", "1", "CALL"],
                      ["2", "6", "CALL"],
                      ["1", "5", "CFG"],
                      ["1", "5", "REACHING_DEF"],
                    ].map(
                      ([src, dst, label]) =>
                        `EDGE\t${src}\t${dst}\t${Buffer.from(label ?? "").toString("base64")}`
                    ),
                  ].join("\n") + "\n"
                : mode.startsWith("graph-pinned-")
                  ? await pinnedInventory(
                      fixturePath,
                      encode,
                      mode === "graph-pinned-bad-line"
                        ? "bad-line"
                        : mode === "graph-pinned-ambiguous"
                          ? "ambiguous"
                          : mode === "graph-pinned-wrong-handler"
                            ? "wrong-handler"
                            : mode === "graph-pinned-wrong-registration"
                              ? "wrong-registration"
                              : mode === "graph-pinned-wrong-action"
                                ? "wrong-action"
                                : mode === "graph-pinned-outside-handler"
                                  ? "outside-handler"
                                  : mode === "graph-pinned-reuse"
                                    ? "reuse"
                                    : mode === "graph-pinned-no-param-ast"
                                      ? "no-param-ast"
                                      : mode === "graph-pinned-param-contains"
                                        ? "param-contains"
                                        : mode === "graph-pinned-foreign-param-owner"
                                          ? "foreign-param-owner"
                                          : mode === "graph-pinned-duplicate-param-owner"
                                            ? "duplicate-param-owner"
                                            : mode === "graph-pinned-wrong-param-code"
                                              ? "wrong-param-code"
                                              : mode === "graph-pinned-wrong-param-name"
                                                ? "wrong-param-name"
                                                : mode === "graph-pinned-wrong-param-line"
                                                  ? "wrong-param-line"
                                                  : mode === "graph-pinned-wrong-param-method"
                                                    ? "wrong-param-method"
                                                    : mode === "graph-pinned-param-cycle"
                                                      ? "param-cycle"
                                                      : mode === "graph-pinned-param-depth"
                                                        ? "param-depth"
                                                        : mode === "graph-pinned-param-outside-span"
                                                          ? "param-outside-span"
                                                          : undefined
                    )
                  : mode === "graph-reviewed-anchors" ||
                      mode === "graph-reviewed-bad-line" ||
                      mode === "graph-reviewed-ambiguous"
                    ? await reviewedInventory(
                        fixturePath,
                        encode,
                        mode === "graph-reviewed-bad-line"
                          ? "bad-line"
                          : mode === "graph-reviewed-ambiguous"
                            ? "ambiguous"
                            : undefined
                      )
                    : mode === "graph-code-targets"
                      ? [
                          fixtureFile,
                          ...[
                            [1, "METHOD", 1, "handler", ""],
                            [2, "CALL", 2, "get", "router.get('/x', handler)"],
                            [3, "CONTROL_STRUCTURE", 3, "if", "if (condition)"],
                            [4, "IDENTIFIER", 4, "action", "action"],
                          ].map(
                            ([id, kind, line, name, code]) =>
                              `NODE\t${String(id)}\t${encode(String(kind))}\t${encode(`/source/${fixturePath}`)}\t${encode(String(line))}\t${encode(String(name))}\t\t${encode(String(code))}`
                          ),
                          `EDGE\t2\t1\t${encode("CALL")}`,
                          `EDGE\t3\t4\t${encode("CFG")}`,
                        ].join("\n") + "\n"
                      : mode === "graph-flow-deep" ||
                          mode === "graph-flow-at-limit" ||
                          mode === "graph-flow-too-deep"
                        ? [
                            fixtureFile,
                            `NODE\t1\t${encode("METHOD")}\t${encode(`/source/${fixturePath}`)}\t${encode("1")}\t${encode("other")}\t\t`,
                            ...Array.from(
                              {
                                length:
                                  mode === "graph-flow-too-deep"
                                    ? 18
                                    : mode === "graph-flow-at-limit"
                                      ? 17
                                      : 9,
                              },
                              (_, index) => {
                                const name =
                                  index === 0
                                    ? "source"
                                    : index === 2
                                      ? "via1"
                                      : index === 5
                                        ? "via2"
                                        : index === 7
                                          ? "via3"
                                          : index ===
                                              (mode === "graph-flow-too-deep"
                                                ? 17
                                                : mode === "graph-flow-at-limit"
                                                  ? 16
                                                  : 8)
                                            ? "sink"
                                            : `use${String(index)}`;
                                const line =
                                  index === 0
                                    ? 4
                                    : index <= 2
                                      ? 5
                                      : index <= 5
                                        ? 6
                                        : index <= 7
                                          ? 7
                                          : 8;
                                return `NODE\t${String(index + 4)}\t${encode(index === 4 ? "CALL" : "IDENTIFIER")}\t${encode(`/source/${fixturePath}`)}\t${encode(String(line))}\t${encode(name)}\t\t`;
                              }
                            ),
                            ...Array.from(
                              {
                                length:
                                  mode === "graph-flow-too-deep"
                                    ? 17
                                    : mode === "graph-flow-at-limit"
                                      ? 16
                                      : 8,
                              },
                              (_, index) =>
                                `EDGE\t${String(index + 4)}\t${String(index + 5)}\t${encode("REACHING_DEF")}`
                            ),
                            // Same spelling, wrong source line: this fanout exceeds the AST
                            // work budget if start selection is postponed until after traversal.
                            ...(mode === "graph-flow-deep"
                              ? [
                                  `NODE\t1000\t${encode("IDENTIFIER")}\t${encode(`/source/${fixturePath}`)}\t${encode("50")}\t${encode("source")}\t\t`,
                                  ...Array.from(
                                    { length: 257 },
                                    (_, index) =>
                                      `NODE\t${String(index + 1001)}\t${encode("IDENTIFIER")}\t${encode(`/source/${fixturePath}`)}\t${encode("51")}\t${encode(`decoy${String(index)}`)}\t\t`
                                  ),
                                  ...Array.from(
                                    { length: 257 },
                                    (_, index) =>
                                      `EDGE\t1000\t${String(index + 1001)}\t${encode("REACHING_DEF")}`
                                  ),
                                ]
                              : []),
                          ].join("\n") + "\n"
                        : mode === "graph-flow-byte-limit"
                          ? [
                              fixtureFile,
                              `NODE\t4\t${encode("IDENTIFIER")}\t${encode(`/source/${fixturePath}`)}\t${encode("4")}\t${encode("source")}\t\t`,
                              ...Array.from(
                                { length: 240 },
                                (_, index) =>
                                  `NODE\t${String(index + 10)}\t${encode("IDENTIFIER")}\t${encode(`/source/${fixturePath}`)}\t${encode("8")}\t${encode("sink")}\t\t`
                              ),
                              ...Array.from(
                                { length: 240 },
                                (_, index) =>
                                  `EDGE\t4\t${String(index + 10)}\t${encode("REACHING_DEF")}`
                              ),
                            ].join("\n") + "\n"
                          : mode === "graph-flow" || mode === "graph-flow-negative"
                            ? [
                                fixtureFile,
                                `NODE\t1\t${encode("METHOD")}\t${encode(`/source/${fixturePath}`)}\t${encode("1")}\t${encode("other")}\t\t`,
                                ...["source", "via1", "via2", "via3", "sink", "wrong"].map(
                                  (name, index) =>
                                    `NODE\t${String(index + 4)}\t${encode("IDENTIFIER")}\t${encode(`/source/${fixturePath}`)}\t${encode(String(index + 4))}\t${encode(name)}\t\t`
                                ),
                                ...[
                                  [4, 5],
                                  [5, 6],
                                  [6, 7],
                                  [7, 8],
                                  ...(mode === "graph-flow-negative" ? [[7, 9]] : []),
                                ].map(
                                  ([src, dst]) =>
                                    `EDGE\t${String(src)}\t${String(dst)}\t${encode("REACHING_DEF")}`
                                ),
                              ].join("\n") + "\n"
                            : mode === "graph" || mode === "graph-target-negative"
                              ? [
                                  fixtureFile,
                                  ...[
                                    "method",
                                    "call",
                                    "control_structure",
                                    "identifier",
                                    "identifier",
                                  ].map(
                                    (kind, index) =>
                                      `NODE\t${String(index + 1)}\t${Buffer.from(kind.toUpperCase()).toString("base64")}\t${Buffer.from(`/source/${fixturePath}`).toString("base64")}\t${Buffer.from(String(index + 1)).toString("base64")}\t${Buffer.from(kind).toString("base64")}\t\t`
                                  ),
                                  ...(mode === "graph-target-negative"
                                    ? [
                                        `NODE\t6\t${encode("METHOD")}\t${encode(`/source/${fixturePath}`)}\t${encode("6")}\t${encode("decoy")}\t\t`,
                                      ]
                                    : []),
                                  ...["call", "cfg", "reaching_def"].map(
                                    (edge) =>
                                      `EDGE\t${edge === "call" ? "2" : edge === "cfg" ? "3" : "4"}\t${edge === "call" ? "1" : edge === "cfg" ? "4" : "5"}\t${Buffer.from(edge.toUpperCase()).toString("base64")}`
                                  ),
                                  ...(mode === "graph-target-negative"
                                    ? [`EDGE\t2\t6\t${encode("CALL")}`]
                                    : []),
                                ].join("\n") + "\n"
                              : `${fixtureFile}\n${mode === "zero-nodes" && fixturePath === "src/a.ts" ? "" : `${fixtureNode}\n`}`;
        return Buffer.from(isGraphReadback ? data : metadata + data).toString("base64");
      }
      return "";
    }
    if (argv[1] === "rm") {
      if (mode === "cleanup-fails") throw new Error("daemon unreachable");
      removed = true;
      return name;
    }
    if (argv[1] === "ls") return removed ? "" : "e".repeat(12);
    throw new Error("unexpected Docker call");
  };
}

// Shared by the opt-in live test and the offline writer regression; never overwrites a result.
async function writeCandidateObservations(
  outputPath: string,
  observations: {
    readonly cases: readonly ScaP03QualificationCaseV2[];
    readonly executed_query_release_sha256: string;
  }
): Promise<void> {
  await writeFile(outputPath, canonicalJson(observations), { flag: "wx", mode: 0o600 });
}

function makeFrozenRelease(
  release_id: string,
  filterSteps: readonly ScaP03QueryPlanV2["steps"][number][]
): ScaP03FrozenQueryReleaseV1 {
  const queries: ScaP03FrozenQueryReleaseV1["queries"] = SCA_P03_QUERY_IDS.map(
    (query_id, index) => {
      const edge =
        query_id === "p03.call-resolution.v2" || query_id === "p03.framework-dispatch.v2"
          ? "call"
          : query_id === "p03.control-guard.v2"
            ? "cfg"
            : query_id === "p03.dataflow-source-sink.v2"
              ? "reaching_def"
              : null;
      const plan = validateScaP03QueryPlanV2(
        withScaP03Digest(
          {
            schema_id: "penny.sca-p03-query-plan.v2",
            schema_version: 2,
            plan_id: `plan-${String(index)}`,
            query_id,
            steps: [
              {
                kind: "select_node",
                node_class:
                  query_id === "p03.call-resolution.v2" || query_id === "p03.framework-dispatch.v2"
                    ? "call"
                    : query_id === "p03.control-guard.v2"
                      ? "control_structure"
                      : query_id === "p03.dataflow-source-sink.v2"
                        ? "identifier"
                        : "method",
              },
              ...filterSteps,
              ...(release_id === "qualification-release" &&
              query_id === "p03.dataflow-source-sink.v2"
                ? [
                    {
                      kind: "filter_property" as const,
                      property: "name" as const,
                      operator: "present" as const,
                      value: null,
                    },
                  ]
                : []),
              ...(edge === null
                ? []
                : [
                    {
                      kind: "traverse_edge",
                      edge,
                      max_hops:
                        release_id === "qualification-release" && edge === "reaching_def"
                          ? SCA_P03_QUALIFICATION_DATAFLOW_MAX_HOPS
                          : 1,
                    },
                  ]),
              { kind: "project", fields: ["file_name", "line_number"] },
              // Qualification's candidate runtime is capped at 1,000 per query; production stays at 10.
              { kind: "limit", max_items: release_id === "qualification-release" ? 1000 : 10 },
            ],
            max_ast_depth: 8,
            max_ast_nodes: release_id === "qualification-release" ? 256 : 32,
          },
          "plan_sha256"
        )
      );
      const binding = {
        schema_id: "penny.sca-p03-query-binding.v2" as const,
        schema_version: 2 as const,
        release_id,
        query_id,
        executor_id: query_id,
        plan_id: plan.plan_id,
        plan_sha256: plan.plan_sha256,
      };
      return {
        query_id,
        script_id: `script-${String(index)}`,
        script_sha256: sha256(canonicalJson(binding)),
        plan,
        binding,
      };
    }
  );
  return {
    release_id,
    query_set_id: "frozen-set",
    release_sha256: sha256(
      canonicalJson({
        release_id,
        queries: queries.map((q) => ({
          query_id: q.query_id,
          script_sha256: q.script_sha256,
          plan: q.plan,
          binding: q.binding,
        })),
      })
    ),
    queries,
  };
}

// The PHP-specific mock release is intentionally separate from the language-neutral qualification release.
function frozenRelease(includeExternalStarts = false): ScaP03FrozenQueryReleaseV1 {
  return makeFrozenRelease(
    "frozen-release",
    includeExternalStarts
      ? []
      : [{ kind: "filter_property", property: "file_name", operator: "equals", value: "src/a.php" }]
  );
}

function qualificationRelease(): ScaP03FrozenQueryReleaseV1 {
  return makeFrozenRelease("qualification-release", [
    { kind: "filter_property", property: "file_name", operator: "present", value: null },
  ]);
}

function qualificationFixtures() {
  return (["php", "javascript", "typescript"] as const).map((language) => {
    const bytes = Buffer.from(`${language} fixture`);
    return {
      fixture_id: `${language}-fixture`,
      language,
      path: language === "php" ? "src/a.php" : language === "javascript" ? "src/a.js" : "src/a.ts",
      content_sha256: sha256(bytes),
      bytes,
    };
  });
}

function expectedCases(
  fixtures: readonly {
    fixture_id: string;
    content_sha256: string;
    path: string;
    language: "php" | "javascript" | "typescript";
  }[],
  release: ScaP03FrozenQueryReleaseV1
) {
  return (["php", "javascript", "typescript"] as const).flatMap((language) => {
    const fixture = fixtures.find((f) => f.language === language);
    if (!fixture) throw new Error("missing test fixture");
    return release.queries.map(
      (query) =>
        syntheticOracleCase({
          fixture,
          query_id: query.query_id,
          release_sha256: release.release_sha256,
        }).expected
    );
  });
}

// Match each observed case to the reviewed fixture's identity, not the oracle JSON order.
function assertReviewedCandidateObservations(
  cases: readonly ScaP03QualificationCaseV2[],
  fixtures: readonly {
    fixture_id: string;
    language: "php" | "javascript" | "typescript";
    content_sha256: string;
    path: string;
  }[],
  releaseSha256: string
): void {
  expect(cases).toHaveLength(fixtures.length * SCA_P03_QUERY_IDS.length);
  for (const fixture of fixtures) {
    const matched = cases.filter(
      (entry) => entry.fixture_id === fixture.fixture_id && entry.language === fixture.language
    );
    expect(matched.map((entry) => entry.query_id)).toEqual(SCA_P03_QUERY_IDS);
    expect(matched.every((entry) => entry.observation_count === entry.observations.length)).toBe(
      true
    );
    for (const entry of matched) {
      expect(entry.frontend_language).toBe(scaP03FrontendLanguageV1(fixture.language));
      expect(entry.fixture_sha256).toBe(fixture.content_sha256);
      expect(entry.observed_sha256).toBe(
        scaP03QualificationObservationSha256V2({
          fixture_id: fixture.fixture_id,
          fixture_sha256: fixture.content_sha256,
          query_id: entry.query_id,
          frontend_language: entry.frontend_language,
          release_sha256: releaseSha256,
          blocker_code: entry.blocker_code,
          observations: entry.observations,
        })
      );
      expect(
        entry.observations.every(
          (item) =>
            item.disposition !== "supported" ||
            item.vertices.every((vertex) => vertex.path === fixture.path)
        )
      ).toBe(true);
    }
  }
}

// Use the production issuer and revalidator for both offline and opt-in live qualification.
async function reviewedQualificationAuthority() {
  const { oracle, fixtures } = await readSourceOracle();
  const ordered = (["php", "javascript", "typescript"] as const).map((language) => {
    const fixture = fixtures.find((entry) => entry.language === language);
    if (fixture === undefined) throw new Error("reviewed fixture absent");
    return fixture;
  });
  const artifact = (kind: string, bytes: Uint8Array, schema?: string, producer?: string) => {
    const digest = sha256(bytes);
    return {
      ...ref,
      kind,
      content_digest: digest,
      store_ref: `artifact://sha256/${digest}`,
      byte_length: bytes.byteLength,
      artifact_id: `art_${digest}`,
      ...(schema === undefined ? {} : { content_schema: { schema_id: schema, schema_version: 1 } }),
      ...(producer === undefined ? {} : { producer }),
    };
  };
  const oracleBytes = Buffer.from(canonicalJson(oracle));
  const oracleRef = artifact(
    "sca-p03-source-oracle",
    oracleBytes,
    SCA_P03_SOURCE_ORACLE_SCHEMA,
    SCA_P03_SOURCE_ORACLE_PRODUCER
  );
  const fixtureRefs = ordered.map((item) =>
    artifact("sca-p03-qualification-fixture-content", item.bytes)
  );
  const corpus = validateScaP03QualificationFixtureCorpusV2(
    withScaP03Digest(
      {
        schema_id: "penny.sca-p03-qualification-fixture-corpus.v2",
        schema_version: 2,
        corpus_id: "reviewed-mock-inventory",
        fixture_content_refs: fixtureRefs,
        fixture_ids: ordered.map((item) => item.fixture_id),
        languages: ["php", "javascript", "typescript"],
        expected_cases: projectSourceOracleCases(oracle),
      },
      "corpus_sha256"
    )
  );
  const corpusRef = artifact("sca-p03-fixture-corpus", Buffer.from(canonicalJson(corpus)));
  const reviewCore = {
    schema_id: SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
    schema_version: 1,
    producer: SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER,
    oracle_sha256: oracle.oracle_sha256,
    parser_identity_sha256: oracle.parser.identity_sha256,
    fixture_content_sha256: ordered.map((item) => item.content_sha256),
    expected_cases: corpus.expected_cases,
  };
  const reviewBytes = Buffer.from(canonicalJson(withScaP03Digest(reviewCore, "review_sha256")));
  const reviewRef = artifact(
    "sca-p03-source-oracle-review",
    reviewBytes,
    SCA_P03_SOURCE_ORACLE_REVIEW_SCHEMA,
    SCA_P03_SOURCE_ORACLE_REVIEW_PRODUCER
  );
  const fixtureInputs = ordered.map((fixture, index) => {
    const reviewedRef = fixtureRefs[index];
    if (reviewedRef === undefined) throw new Error("fixture ref absent");
    return { ...fixture, ref: reviewedRef };
  });
  const receipt = validateAndSealSourceOracle({
    oracle_bytes: oracleBytes,
    oracle_ref: oracleRef,
    review_ref: reviewRef,
    corpus_ref: corpusRef,
    corpus,
    fixtures: fixtureInputs,
    validated_at: "2026-09-28T00:00:00.000Z",
  });
  const receiptBytes = Buffer.from(canonicalJson(receipt));
  const receiptRef = artifact(
    "sca-p03-source-oracle-validation",
    receiptBytes,
    SCA_P03_SOURCE_ORACLE_RECEIPT_SCHEMA,
    SCA_P03_SOURCE_ORACLE_VALIDATOR
  );
  const validated = revalidateP03SourceOracle({
    run_id: oracleRef.run_id,
    oracle_ref: oracleRef,
    oracle_bytes: oracleBytes,
    receipt_ref: receiptRef,
    receipt_bytes: receiptBytes,
    review_ref: reviewRef,
    review_bytes: reviewBytes,
    corpus_ref: corpusRef,
    corpus,
    fixtures: fixtureInputs,
  });
  return {
    fixtures: ordered,
    expected_cases: corpus.expected_cases,
    receiptRef,
    sealedReceipt: receipt,
    validatedReceipt: validated.validated_receipt,
  };
}

function needsReviewedComplement(entry: ScaP03QualificationCaseV2): boolean {
  return (
    entry.query_id === "p03.control-guard.v2" ||
    entry.query_id === "p03.framework-dispatch.v2" ||
    (entry.query_id === "p03.dataflow-source-sink.v2" && entry.language !== "javascript")
  );
}

function assertReviewedComplementCases(
  cases: readonly ScaP03QualificationCaseV2[],
  receiptRef: Awaited<ReturnType<typeof reviewedQualificationAuthority>>["receiptRef"]
): void {
  expect(cases).toHaveLength(21);
  for (const entry of cases) {
    expect(entry.status, entry.case_id).toBe("passed");
    const complements = entry.observations.filter(
      (item) =>
        item.disposition === "supported" &&
        item.edges.some((edge) => edge.provenance === "qualified_complement")
    );
    if (needsReviewedComplement(entry)) {
      expect(complements.length, entry.case_id).toBeGreaterThan(0);
      for (const complement of complements) {
        expect(complement.edges.length, entry.case_id).toBeGreaterThan(0);
        for (const edge of complement.edges) {
          expect(edge.provenance).toBe("qualified_complement");
          expect(edge.complement_ref).toEqual(receiptRef);
        }
        for (const vertex of complement.vertices) {
          expect(vertex.location_provenance).toBe("qualified_source_oracle");
          expect(vertex.source_location_ref).toEqual(receiptRef);
        }
      }
    } else {
      expect(
        entry.observations.every((item) =>
          item.edges.every((edge) => edge.provenance !== "qualified_complement")
        ),
        entry.case_id
      ).toBe(true);
    }
    if (entry.language === "javascript" && entry.query_id === "p03.dataflow-source-sink.v2") {
      expect(
        entry.observations.some(
          (item) =>
            item.disposition === "supported" &&
            item.edges.length > 0 &&
            item.edges.every((edge) => edge.provenance === "observed_cpg")
        ),
        entry.case_id
      ).toBe(true);
    }
  }
}

describe("explicit Docker P03 runtime", () => {
  it("accepts exact pinned-image labels with owned overrides and rejects label drift", () => {
    const inherited = {
      "org.opencontainers.image.version": "nightly",
      "penny.sca.p03.operation": "image-cannot-supply-owner",
    };
    const owned = {
      "penny.sca.p03.operation": "a".repeat(64),
      "penny.sca.p03.attempt": "1",
    };
    const labels = { ...inherited, ...owned };
    expect(scaP03OwnedDockerLabelsMatchV1(labels, inherited, "a".repeat(64), 1)).toBe(true);
    expect(scaP03OwnedDockerLabelsMatchV1(owned, null, "a".repeat(64), 1)).toBe(true);
    expect(scaP03OwnedDockerLabelsMatchV1(owned, undefined, "a".repeat(64), 1)).toBe(true);
    for (const invalid of [
      inherited,
      owned,
      { ...labels, extra: "not-in-image" },
      { ...labels, "org.opencontainers.image.version": "changed" },
      { ...labels, "penny.sca.p03.attempt": "2" },
      { ...labels, "penny.sca.p03.operation": "b".repeat(64) },
      { ...labels, malformed: 1 },
      null,
      [],
    ])
      expect(scaP03OwnedDockerLabelsMatchV1(invalid, inherited, "a".repeat(64), 1)).toBe(false);
    expect(scaP03OwnedDockerLabelsMatchV1(labels, { malformed: 1 }, "a".repeat(64), 1)).toBe(false);
    expect(scaP03OwnedDockerLabelsMatchV1(labels, [], "a".repeat(64), 1)).toBe(false);
    expect(scaP03OwnedDockerLabelsMatchV1(labels, inherited, "invalid", 1)).toBe(false);
    expect(scaP03OwnedDockerLabelsMatchV1(labels, inherited, "a".repeat(64), 0)).toBe(false);
  });
  it("freezes a language-neutral, query-specific bounded qualification release", () => {
    const release = qualificationRelease();
    expect(release.queries.map((q) => q.query_id)).toEqual(SCA_P03_QUERY_IDS);
    expect(new Set(release.queries.map((q) => q.script_sha256)).size).toBe(7);
    for (const query of release.queries)
      expect(query.script_sha256).toBe(sha256(canonicalJson(query.binding)));
    expect(release.queries.map((q) => q.plan.steps[0])).toEqual([
      { kind: "select_node", node_class: "method" },
      { kind: "select_node", node_class: "method" },
      { kind: "select_node", node_class: "call" },
      { kind: "select_node", node_class: "control_structure" },
      { kind: "select_node", node_class: "identifier" },
      { kind: "select_node", node_class: "call" },
      { kind: "select_node", node_class: "method" },
    ]);
    for (const query of release.queries) {
      expect(query.plan.steps).toContainEqual({
        kind: "filter_property",
        property: "file_name",
        operator: "present",
        value: null,
      });
      expect(query.plan.steps.at(-1)).toEqual({ kind: "limit", max_items: 1000 });
      expect(JSON.stringify(query.plan.steps)).not.toMatch(/src\/a\.php|src\/express\.js/u);
    }
    expect(release.queries[4]?.plan.steps).toContainEqual({
      kind: "filter_property",
      property: "name",
      operator: "present",
      value: null,
    });
    expect(release.queries[4]?.plan.steps).toContainEqual({
      kind: "traverse_edge",
      edge: "reaching_def",
      max_hops: 16,
    });
    expect(frozenRelease().queries[4]?.plan.steps).toContainEqual({
      kind: "traverse_edge",
      edge: "reaching_def",
      max_hops: 1,
    });
  });
  it("adds qualification-only anchored complements after production source validation, retaining raw CFG/CALL", async () => {
    const { config } = await setup();
    const {
      fixtures: ordered,
      expected_cases,
      receiptRef,
      sealedReceipt,
      validatedReceipt,
    } = await reviewedQualificationAuthority();
    const candidate = await createScaP03DockerJoernCandidateV1(
      config,
      mockRunner([], "graph-reviewed-anchors")
    );
    await expect(
      candidate.qualify({
        fixtures: ordered,
        expected_cases: expected_cases,
        source_oracle_validation_ref: receiptRef,
        source_oracle_validation_receipt: sealedReceipt,
        query_release: qualificationRelease(),
        fidelity_requirements: [],
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/receipt_not_validated/u);
    const result = await candidate.qualify({
      fixtures: ordered,
      expected_cases: expected_cases,
      source_oracle_validation_ref: receiptRef,
      source_oracle_validation_receipt: validatedReceipt,
      query_release: qualificationRelease(),
      fidelity_requirements: [],
      signal: new AbortController().signal,
    });
    expect(result.cases).toHaveLength(21);
    for (const entry of result.cases) {
      expect(entry.status).toBe("passed");
      const complement = entry.observations.find((item) =>
        item.edges.some((edge) => edge.provenance === "qualified_complement")
      );
      if (
        ["p03.control-guard.v2", "p03.framework-dispatch.v2"].includes(entry.query_id) ||
        (entry.language !== "javascript" && entry.query_id === "p03.dataflow-source-sink.v2")
      ) {
        expect(
          complement?.edges.every(
            (edge) => canonicalJson(edge.complement_ref) === canonicalJson(receiptRef)
          )
        ).toBe(true);
        if (entry.query_id !== "p03.dataflow-source-sink.v2") {
          expect(
            entry.observations.some(
              (item) => item !== complement && item.candidate_id === complement?.candidate_id
            )
          ).toBe(false);
          expect(
            entry.observations.some(
              (item) =>
                item.disposition === "unresolved" &&
                item.edges.some((edge) => edge.provenance === "observed_cpg")
            )
          ).toBe(true);
        }
      } else expect(complement).toBeUndefined();
    }
    // r14 pinned node inventory, not an idealized oracle-shaped node table.
    const pinned = await (
      await createScaP03DockerJoernCandidateV1(config, mockRunner([], "graph-pinned-anchors"))
    ).qualify({
      fixtures: ordered,
      expected_cases: expected_cases,
      source_oracle_validation_ref: receiptRef,
      source_oracle_validation_receipt: validatedReceipt,
      query_release: qualificationRelease(),
      fidelity_requirements: [],
      signal: new AbortController().signal,
    });
    assertReviewedComplementCases(pinned.cases, receiptRef);
    for (const entry of pinned.cases) {
      expect(
        entry.status,
        `${entry.case_id}: ${entry.blocker_code}: ${JSON.stringify(entry.observations.map((c) => c.vertices))}`
      ).toBe("passed");
      const complement = entry.observations.find((candidate) =>
        candidate.edges.some((e) => e.provenance === "qualified_complement")
      );
      const needsComplement =
        ["p03.control-guard.v2", "p03.framework-dispatch.v2"].includes(entry.query_id) ||
        (entry.query_id === "p03.dataflow-source-sink.v2" && entry.language !== "javascript");
      if (needsComplement) expect(complement, entry.case_id).toBeDefined();
      else expect(complement, entry.case_id).toBeUndefined();
      const reviewed = expected_cases.find(
        (item) => item.query_id === entry.query_id && item.language === entry.language
      );
      if (reviewed === undefined) throw new Error("expected pinned oracle absent");
      expect(
        scaP03QualificationAssertionsMatchV2(entry.observations, reviewed.oracle_assertions)
      ).toBe(true);
      for (const negative of reviewed.oracle_assertions.filter(
        (item) => item.expectation === "absent"
      )) {
        expect(
          entry.observations.some(
            (candidate) =>
              candidate.disposition === "supported" &&
              candidate.vertices[0]?.role === negative.start?.role &&
              candidate.vertices.at(-1)?.name === negative.end?.name &&
              candidate.vertices.at(-1)?.line === negative.end?.line
          )
        ).toBe(false);
      }
      if (complement !== undefined) {
        expect(
          complement.vertices.every(
            (v) =>
              v.location_provenance === "qualified_source_oracle" &&
              canonicalJson(v.source_location_ref) === canonicalJson(receiptRef) &&
              v.cpg_line !== undefined
          )
        ).toBe(true);
        if (entry.language === "typescript" && entry.query_id === "p03.framework-dispatch.v2")
          expect(complement.vertices.at(-1)).toMatchObject({
            line: 22,
            cpg_line: 21,
            label: "method",
            node_id: "107374182408",
          });
        if (entry.query_id === "p03.dataflow-source-sink.v2")
          expect(complement.vertices[0]).toMatchObject({
            label: entry.language === "javascript" ? "identifier" : "method_parameter_in",
            ...(entry.language === "javascript"
              ? {}
              : {
                  node_id: entry.language === "php" ? "111669149698" : "111669149710",
                  name: entry.language === "php" ? "$input_value" : "inputValue",
                  cpg_line: entry.language === "php" ? 5 : 22,
                  path: entry.language === "php" ? "src/wordpress.php" : "src/nest.ts",
                  source_location_ref: receiptRef,
                }),
          });
        if (entry.language === "javascript" && entry.query_id === "p03.framework-dispatch.v2")
          expect(complement.vertices[0]).toMatchObject({ label: "call", node_id: "30064771092" });
      }
    }
    for (const [mode, affected] of [
      ["graph-pinned-bad-line", "p03.control-guard.v2"],
      ["graph-pinned-ambiguous", "p03.control-guard.v2"],
      ["graph-pinned-wrong-handler", "p03.framework-dispatch.v2"],
      ["graph-pinned-wrong-registration", "p03.framework-dispatch.v2"],
      ["graph-pinned-wrong-action", "p03.control-guard.v2"],
      ["graph-pinned-outside-handler", "p03.framework-dispatch.v2"],
      ["graph-pinned-reuse", "p03.control-guard.v2"],
    ] as const) {
      const changed = await (
        await createScaP03DockerJoernCandidateV1(config, mockRunner([], mode))
      ).qualify({
        fixtures: ordered,
        expected_cases: expected_cases,
        source_oracle_validation_ref: receiptRef,
        source_oracle_validation_receipt: validatedReceipt,
        query_release: qualificationRelease(),
        fidelity_requirements: [],
        signal: new AbortController().signal,
      });
      expect(
        changed.cases
          .filter((entry) => entry.query_id === affected)
          .some(
            (entry) =>
              entry.status === "blocked" &&
              entry.observations.every((candidate) =>
                candidate.edges.every((e) => e.provenance !== "qualified_complement")
              )
          ),
        mode
      ).toBe(true);
    }
    await expect(
      candidate.qualify({
        fixtures: ordered,
        expected_cases: expected_cases,
        source_oracle_validation_ref: receiptRef,
        query_release: qualificationRelease(),
        fidelity_requirements: [],
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/receipt_not_validated/u);
    await expect(
      candidate.qualify({
        fixtures: ordered,
        expected_cases: expected_cases,
        source_oracle_validation_ref: { ...receiptRef, content_digest: sha256("foreign") },
        source_oracle_validation_receipt: sealedReceipt,
        query_release: qualificationRelease(),
        fidelity_requirements: [],
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/receipt_not_validated/u);
    for (const mode of ["graph-reviewed-bad-line", "graph-reviewed-ambiguous"] as const) {
      const altered = await createScaP03DockerJoernCandidateV1(config, mockRunner([], mode));
      const output = await altered.qualify({
        fixtures: ordered,
        expected_cases: expected_cases,
        source_oracle_validation_ref: receiptRef,
        source_oracle_validation_receipt: validatedReceipt,
        query_release: qualificationRelease(),
        fidelity_requirements: [],
        signal: new AbortController().signal,
      });
      expect(
        output.cases
          .filter((entry) => entry.query_id === "p03.control-guard.v2")
          .every(
            (entry) =>
              entry.status === "blocked" &&
              entry.observations.every((candidate) =>
                candidate.edges.every((edge) => edge.provenance !== "qualified_complement")
              )
          )
      ).toBe(true);
    }
  });

  it("accepts an exact direct parameter-owner edge as an alternative to AST only under the receipt", async () => {
    const { config } = await setup();
    const { fixtures, expected_cases, receiptRef, validatedReceipt } =
      await reviewedQualificationAuthority();
    const output = await (
      await createScaP03DockerJoernCandidateV1(
        config,
        mockRunner([], "graph-pinned-param-contains")
      )
    ).qualify({
      fixtures,
      expected_cases,
      source_oracle_validation_ref: receiptRef,
      source_oracle_validation_receipt: validatedReceipt,
      query_release: qualificationRelease(),
      fidelity_requirements: [],
      signal: new AbortController().signal,
    });
    assertReviewedComplementCases(output.cases, receiptRef);
  });

  it("rejects ambiguous, absent, foreign, cyclic or nonmatching parameter ownership without changing observed paths", async () => {
    const { config } = await setup();
    const { fixtures, expected_cases, receiptRef, validatedReceipt } =
      await reviewedQualificationAuthority();
    for (const mode of [
      "graph-pinned-no-param-ast",
      "graph-pinned-foreign-param-owner",
      "graph-pinned-duplicate-param-owner",
      "graph-pinned-wrong-param-code",
      "graph-pinned-wrong-param-name",
      "graph-pinned-wrong-param-line",
      "graph-pinned-wrong-param-method",
      "graph-pinned-param-cycle",
      "graph-pinned-param-depth",
      "graph-pinned-param-outside-span",
    ] as const) {
      const output = await (
        await createScaP03DockerJoernCandidateV1(config, mockRunner([], mode))
      ).qualify({
        fixtures,
        expected_cases,
        source_oracle_validation_ref: receiptRef,
        source_oracle_validation_receipt: validatedReceipt,
        query_release: qualificationRelease(),
        fidelity_requirements: [],
        signal: new AbortController().signal,
      });
      for (const language of ["php", "typescript"] as const) {
        const flow = output.cases.find(
          (entry) => entry.language === language && entry.query_id === "p03.dataflow-source-sink.v2"
        );
        expect(flow, `${mode}:${language}`).toBeDefined();
        expect(flow?.status, `${mode}:${language}`).toBe("blocked");
        expect(
          flow?.observations.some((candidate) =>
            candidate.edges.some((edge) => edge.provenance === "qualified_complement")
          ),
          `${mode}:${language}`
        ).toBe(false);
      }
      expect(
        output.cases.find(
          (entry) =>
            entry.language === "javascript" && entry.query_id === "p03.dataflow-source-sink.v2"
        )?.status,
        mode
      ).toBe("passed");
    }
  });

  it("blocks reviewed complement cases when validated authority is omitted", async () => {
    const { config } = await setup();
    const { fixtures, expected_cases } = await reviewedQualificationAuthority();
    const candidate = await createScaP03DockerJoernCandidateV1(
      config,
      mockRunner([], "graph-pinned-anchors")
    );
    // Same parsed inventory as the passing path, but no request-bound validated receipt.
    const unreviewed = await candidate.qualify({
      fixtures,
      expected_cases,
      query_release: qualificationRelease(),
      fidelity_requirements: [],
      signal: new AbortController().signal,
    });
    expect(unreviewed.cases).toHaveLength(21);
    const required = unreviewed.cases.filter(needsReviewedComplement);
    expect(required).toHaveLength(8);
    for (const entry of required) expect(entry.status, entry.case_id).toBe("blocked");
    for (const entry of unreviewed.cases) {
      expect(
        entry.observations.every((item) =>
          item.edges.every((edge) => edge.provenance !== "qualified_complement")
        ),
        entry.case_id
      ).toBe(true);
    }
  });

  it("uses reviewed source cases and matches observation hashes by fixture identity offline", async () => {
    const { config } = await setup();
    const { oracle, fixtures } = await readSourceOracle();
    const release = qualificationRelease();
    const expected_cases = projectSourceOracleCases(oracle);
    expect(expected_cases).toHaveLength(21);
    expect(expected_cases.every((entry) => entry.expected_observed_sha256 === null)).toBe(true);
    for (const entry of expected_cases) {
      const fixture = oracle.fixtures.find((item) => item.language === entry.language);
      expect(entry.oracle_assertions).toEqual(
        fixture?.material_cases.find((item) => item.query_id === entry.query_id)?.assertions
      );
    }
    // The reviewed file lists JS before PHP; neither input nor output position binds a case.
    const reordered = [...fixtures].reverse();
    const candidate = await createScaP03DockerJoernCandidateV1(config, mockRunner([], "graph"));
    const observed = await candidate.qualify({
      fixtures: reordered,
      query_release: release,
      expected_cases,
      fidelity_requirements: [],
      signal: new AbortController().signal,
    });
    expect(observed.executed_query_release_sha256).toBe(release.release_sha256);
    assertReviewedCandidateObservations(observed.cases, reordered, release.release_sha256);
    const first = observed.cases[0];
    if (first === undefined) throw new Error("reviewed case absent");
    expect(() =>
      assertReviewedCandidateObservations(
        [{ ...first, observed_sha256: sha256("wrong") }, ...observed.cases.slice(1)],
        reordered,
        release.release_sha256
      )
    ).toThrow();
  });

  it("projects exact call targets after broad raw queries, retains a negative, and blocks missing positives", async () => {
    const { config } = await setup();
    const fixtures = qualificationFixtures();
    const release = qualificationRelease();
    const cases = expectedCases(fixtures, release);
    const positive = {
      expectation: "present" as const,
      candidate_kind: "call_or_unresolved_call" as const,
      claim: "call_resolution" as const,
      disposition: "supported" as const,
      start: { path: "src/a.php", name: "call", line: 2, role: "call_site" as const },
      end: { path: "src/a.php", name: "method", line: 1, role: "callee" as const },
      edge: {
        kind: "call" as const,
        provenance: "observed_cpg" as const,
        branch_orientation: null,
      },
    };
    const negative = {
      ...positive,
      expectation: "absent" as const,
      end: { path: "src/a.php", name: "decoy", line: 6, role: "callee" as const },
    };
    const expected_cases = cases.map((entry) =>
      entry.language === "php" && entry.query_id === "p03.call-resolution.v2"
        ? { ...entry, oracle_assertions: [positive, negative] }
        : entry
    );
    const run = async (mode: "graph" | "graph-target-negative", targets = expected_cases) =>
      (await createScaP03DockerJoernCandidateV1(config, mockRunner([], mode))).qualify({
        fixtures,
        query_release: release,
        expected_cases: targets,
        fidelity_requirements: [],
        signal: new AbortController().signal,
      });
    const target = (output: Awaited<ReturnType<typeof run>>) => {
      const entry = output.cases.find(
        (item) => item.language === "php" && item.query_id === "p03.call-resolution.v2"
      );
      if (entry === undefined) throw new Error("call case absent");
      return entry;
    };
    const clean = target(await run("graph"));
    expect(clean).toMatchObject({ status: "passed", observation_count: 1 });
    expect(clean.observations[0]?.vertices.at(-1)?.name).toBe("method");
    // Other calls/symbols from the broad query are not reviewed targets.
    const dirty = target(await run("graph-target-negative"));
    expect(dirty).toMatchObject({
      status: "blocked",
      blocker_code: "p03_oracle_assertion_mismatch",
      observation_count: 2,
    });
    expect(dirty.observations.map((item) => item.vertices.at(-1)?.name).sort()).toEqual([
      "decoy",
      "method",
    ]);
    // A caller cannot pre-filter the raw negative away: the runtime itself projects it.
    expect(scaP03QualificationAssertionsMatchV2(clean.observations, [positive, negative])).toBe(
      true
    );
    expect(scaP03QualificationAssertionsMatchV2(dirty.observations, [positive, negative])).toBe(
      false
    );
    const missing = target(
      await run(
        "graph",
        expected_cases.map((entry) =>
          entry.language === "php" && entry.query_id === "p03.call-resolution.v2"
            ? { ...entry, oracle_assertions: [{ ...positive, end: negative.end }, negative] }
            : entry
        )
      )
    );
    expect(missing).toMatchObject({ status: "blocked", observation_count: 1 });
    expect(missing.observations[0]?.vertices.at(-1)?.name).toBe("method");
  });

  it("queries only positive symbol starts, never a real decoy named solely by an absence assertion", async () => {
    const { config } = await setup();
    const fixtures = qualificationFixtures();
    const release = qualificationRelease();
    const expected_cases = expectedCases(fixtures, release).map((entry) =>
      entry.language === "php" && entry.query_id === "p03.symbol-entrypoint-index.v2"
        ? {
            ...entry,
            oracle_assertions: [
              {
                expectation: "present" as const,
                candidate_kind: "symbol_or_entrypoint" as const,
                claim: "observation" as const,
                disposition: "supported" as const,
                start: { path: "src/a.php", line: 1, name: "method", role: "symbol" as const },
              },
              {
                expectation: "absent" as const,
                candidate_kind: "symbol_or_entrypoint" as const,
                claim: "observation" as const,
                disposition: "supported" as const,
                start: { path: "src/a.php", line: 6, name: "decoy", role: "symbol" as const },
              },
            ],
          }
        : entry
    );
    const candidate = await createScaP03DockerJoernCandidateV1(
      config,
      mockRunner([], "graph-target-negative")
    );
    const result = await candidate.qualify({
      fixtures,
      query_release: release,
      expected_cases,
      fidelity_requirements: [],
      signal: new AbortController().signal,
    });
    const symbol = result.cases.find(
      (entry) => entry.language === "php" && entry.query_id === "p03.symbol-entrypoint-index.v2"
    );
    expect(symbol).toMatchObject({ status: "passed", observation_count: 1 });
    expect(symbol?.observations.map((item) => item.vertices[0]?.name)).toEqual(["method"]);
  });

  it("retains same-source wrong sinks for review but blocks only an exact declared negative", async () => {
    const { config } = await setup();
    const fixtures = qualificationFixtures();
    const release = qualificationRelease();
    const vertex = (name: string, line: number, role: "source" | "sink" | "unknown") => ({
      path: "src/a.php",
      name,
      line,
      role,
    });
    const positive = {
      expectation: "present" as const,
      candidate_kind: "source_to_sink_flow" as const,
      claim: "reaching_definition" as const,
      disposition: "supported" as const,
      start: vertex("source", 4, "source"),
      via: [
        vertex("via1", 5, "unknown"),
        vertex("via2", 6, "unknown"),
        vertex("via3", 7, "unknown"),
      ],
      end: vertex("sink", 8, "sink"),
      edge: {
        kind: "reaching_def" as const,
        provenance: "observed_cpg" as const,
        branch_orientation: null,
      },
      source_selector: "source",
      sink_selector: "sink",
    };
    const absent = {
      ...positive,
      expectation: "absent" as const,
      end: vertex("wrong", 9, "sink"),
      sink_selector: "wrong",
    };
    const cases = expectedCases(fixtures, release);
    const run = async (
      mode: "graph-flow" | "graph-flow-negative",
      assertions: readonly (typeof positive | typeof absent)[]
    ) => {
      const expected_cases = cases.map((entry) =>
        entry.language === "php" && entry.query_id === "p03.dataflow-source-sink.v2"
          ? { ...entry, oracle_assertions: [...assertions] }
          : entry
      );
      const runtime = await createScaP03DockerJoernCandidateV1(config, mockRunner([], mode));
      const result = await runtime.qualify({
        fixtures,
        query_release: release,
        expected_cases,
        fidelity_requirements: [],
        signal: new AbortController().signal,
      });
      const flow = result.cases.find(
        (entry) => entry.language === "php" && entry.query_id === "p03.dataflow-source-sink.v2"
      );
      if (flow === undefined) throw new Error("flow case missing");
      return flow;
    };
    const clean = await run("graph-flow", [positive, absent]);
    expect(clean).toMatchObject({ status: "passed", observation_count: 1 });
    expect(clean.observations[0]?.hop_count).toBe(4);
    expect(clean.observations[0]?.vertices.map((v) => v.role)).toEqual([
      "source",
      "unknown",
      "unknown",
      "unknown",
      "sink",
    ]);
    const dirty = await run("graph-flow-negative", [positive, absent]);
    expect(dirty).toMatchObject({ status: "blocked", observation_count: 2 });
    expect(dirty.observations.map((item) => item.vertices.at(-1)?.name).sort()).toEqual([
      "sink",
      "wrong",
    ]);
    const withoutNegative = await run("graph-flow-negative", [positive]);
    expect(withoutNegative).toMatchObject({ status: "passed", observation_count: 2 });
    expect(withoutNegative.observations).toEqual(dirty.observations);
  });

  it("keeps ordered raw duplicate-use/operator vertices through a deeper sink and blocks paths beyond 16", async () => {
    const { config } = await setup();
    const fixtures = qualificationFixtures();
    const release = qualificationRelease();
    const vertex = (name: string, line: number, role: "source" | "sink" | "unknown") => ({
      path: "src/a.php",
      name,
      line,
      role,
    });
    const positive = {
      expectation: "present" as const,
      candidate_kind: "source_to_sink_flow" as const,
      claim: "reaching_definition" as const,
      disposition: "supported" as const,
      start: vertex("source", 4, "source"),
      via: [
        vertex("via1", 5, "unknown"),
        vertex("via2", 6, "unknown"),
        vertex("via3", 7, "unknown"),
      ],
      end: vertex("sink", 8, "sink"),
      edge: {
        kind: "reaching_def" as const,
        provenance: "observed_cpg" as const,
        branch_orientation: null,
      },
      source_selector: "source",
      sink_selector: "sink",
    };
    const expected_cases = expectedCases(fixtures, release).map((entry) =>
      entry.language === "php" && entry.query_id === "p03.dataflow-source-sink.v2"
        ? { ...entry, oracle_assertions: [positive] }
        : entry
    );
    const run = async (
      mode:
        | "graph-flow-deep"
        | "graph-flow-at-limit"
        | "graph-flow-too-deep"
        | "graph-flow-byte-limit"
    ) => {
      const candidate = await createScaP03DockerJoernCandidateV1(config, mockRunner([], mode));
      const result = await candidate.qualify({
        fixtures,
        query_release: release,
        expected_cases,
        fidelity_requirements: [],
        signal: new AbortController().signal,
      });
      const flow = result.cases.find(
        (entry) => entry.language === "php" && entry.query_id === "p03.dataflow-source-sink.v2"
      );
      if (flow === undefined) throw new Error("flow case missing");
      return flow;
    };
    const deep = await run("graph-flow-deep");
    expect(deep).toMatchObject({ status: "passed", observation_count: 1 });
    const candidate = deep.observations[0];
    if (candidate === undefined) throw new Error("flow candidate missing");
    expect(candidate.hop_count).toBe(8);
    expect(candidate.vertices.map((v) => v.node_id)).toEqual(
      Array.from({ length: 9 }, (_, index) => String(index + 4))
    );
    expect(candidate.vertices[4]?.label).toBe("call");
    expect(candidate.edges.map((edge) => [edge.src_node_id, edge.dst_node_id])).toEqual(
      Array.from({ length: 8 }, (_, index) => [String(index + 4), String(index + 5)])
    );
    expect(
      candidate.edges.every((edge) => edge.kind === "reaching_def" && edge.direction === "forward")
    ).toBe(true);
    const boundary = await run("graph-flow-at-limit");
    expect(boundary).toMatchObject({ status: "passed", observation_count: 1 });
    expect(boundary.observations[0]?.hop_count).toBe(16);
    expect(boundary.observations[0]?.vertices).toHaveLength(17);
    const overflow = await run("graph-flow-too-deep");
    expect(overflow).toMatchObject({
      status: "blocked",
      blocker_code: "p03_traversal_limit_reached",
      observation_count: 0,
    });
    const oversized = await run("graph-flow-byte-limit");
    expect(oversized).toMatchObject({
      status: "blocked",
      blocker_code: "p03_query_limit_reached",
      observation_count: 0,
    });
  });

  it("selects source-spelled guards and qualified registrations without granting their complements", async () => {
    const { config } = await setup();
    const fixtures = qualificationFixtures();
    const release = qualificationRelease();
    const expected_cases = expectedCases(fixtures, release).map((entry) => {
      if (entry.language !== "php") return entry;
      if (entry.query_id === "p03.control-guard.v2")
        return {
          ...entry,
          oracle_assertions: [
            {
              expectation: "present" as const,
              candidate_kind: "guard_or_control_relationship" as const,
              claim: "control_reachability" as const,
              disposition: "supported" as const,
              start: { path: "src/a.php", line: 3, name: "condition", role: "guard" as const },
              end: { path: "src/a.php", line: 4, name: "action", role: "action" as const },
              edge: {
                kind: "cfg" as const,
                provenance: "observed_cpg" as const,
                branch_orientation: null,
              },
              reason_code: "relationship_unproven",
            },
          ],
        };
      if (entry.query_id === "p03.framework-dispatch.v2")
        return {
          ...entry,
          oracle_assertions: [
            {
              expectation: "present" as const,
              candidate_kind: "route_or_framework_surface" as const,
              claim: "framework_dispatch" as const,
              disposition: "supported" as const,
              start: {
                path: "src/a.php",
                line: 2,
                name: "router.get",
                role: "registration" as const,
              },
              end: { path: "src/a.php", line: 1, name: "handler", role: "handler" as const },
              edge: {
                kind: "call" as const,
                provenance: "observed_cpg" as const,
                branch_orientation: null,
              },
              reason_code: "relationship_unproven",
            },
          ],
        };
      return entry;
    });
    const candidate = await createScaP03DockerJoernCandidateV1(
      config,
      mockRunner([], "graph-code-targets")
    );
    const output = await candidate.qualify({
      fixtures,
      query_release: release,
      expected_cases,
      fidelity_requirements: [],
      signal: new AbortController().signal,
    });
    expect(
      output.cases.find(
        (entry) => entry.language === "php" && entry.query_id === "p03.control-guard.v2"
      )?.observations[0]?.vertices[0]?.name
    ).toBe("condition");
    expect(
      output.cases.find(
        (entry) => entry.language === "php" && entry.query_id === "p03.framework-dispatch.v2"
      )?.observations[0]?.vertices[0]?.name
    ).toBe("router.get");
    // Observing a CFG/CALL edge alone is not a qualified branch or framework callback proof.
    expect(
      output.cases
        .filter(
          (entry) =>
            entry.language === "php" &&
            ["p03.control-guard.v2", "p03.framework-dispatch.v2"].includes(entry.query_id)
        )
        .every((entry) => entry.status === "blocked")
    ).toBe(true);
  });

  it("excludes unreviewed observations for three fixture frontends without granting graph authority", async () => {
    const { config, parent } = await setup();
    const calls: string[][] = [];
    const runtime = await createScaP03DockerJoernCandidateV1(config, mockRunner(calls, "graph"));
    const fixtures = (["php", "javascript", "typescript"] as const).map((language) => {
      const bytes = Buffer.from(`${language} fixture`);
      return {
        fixture_id: `${language}-fixture`,
        language,
        path:
          language === "php" ? "src/a.php" : language === "javascript" ? "src/a.js" : "src/a.ts",
        content_sha256: sha256(bytes),
        bytes,
      };
    });
    const release = qualificationRelease();
    const observed = await runtime.qualify({
      fixtures,
      query_release: release,
      expected_cases: expectedCases(fixtures, release),
      fidelity_requirements: [],
      signal: new AbortController().signal,
    });
    expect(observed.cases).toHaveLength(21);
    expect("buildGraph" in runtime).toBe(false);
    expect("runBaselineQueries" in runtime).toBe(false);
    expect("qualification_scope" in runtime).toBe(false);
    expect("host_attestation_ref" in runtime).toBe(false);
    expect(observed.cases.every((entry) => entry.status === "blocked")).toBe(true);
    for (const [index] of fixtures.entries()) {
      const cases = observed.cases.slice(
        index * SCA_P03_QUERY_IDS.length,
        (index + 1) * SCA_P03_QUERY_IDS.length
      );
      expect(cases.every((entry) => entry.observation_count === 0)).toBe(true);
    }
    const parseCalls = calls.filter((args) => args[1] === "exec" && args[3] === "joern-parse");
    expect(parseCalls.map((args) => args[args.indexOf("--language") + 1])).toEqual([
      "PHP",
      "JSSRC",
      "JSSRC",
    ]);
    expect(observed.cases.map((entry) => entry.frontend_language)).toEqual([
      ...Array.from({ length: 7 }, () => "PHP"),
      ...Array.from({ length: 14 }, () => "JSSRC"),
    ]);
    expect(observed.executed_query_release_sha256).toBe(release.release_sha256);
    expect(observed.cases[0]?.observed_sha256).not.toBe(observed.cases[7]?.observed_sha256);
    expect(await readdir(parent)).toEqual([]);
  });

  it("projects unreviewed neutral observations away and refuses unbounded plans", async () => {
    const { config, parent } = await setup();
    const fixtures = (["php", "javascript", "typescript"] as const).map((language) => {
      const bytes = Buffer.from(`${language} fixture`);
      return {
        fixture_id: `${language}-fixture`,
        language,
        path:
          language === "php" ? "src/a.php" : language === "javascript" ? "src/a.js" : "src/a.ts",
        content_sha256: sha256(bytes),
        bytes,
      };
    });
    const release = qualificationRelease();
    expect(release.release_sha256).not.toBe(frozenRelease().release_sha256);
    for (const query of release.queries) {
      expect(query.plan.steps).toContainEqual({
        kind: "filter_property",
        property: "file_name",
        operator: "present",
        value: null,
      });
      expect(query.plan.steps.at(-1)).toEqual({ kind: "limit", max_items: 1000 });
      expect(query.plan.max_ast_nodes).toBe(256);
      expect(validateScaP03QueryPlanV2(query.plan)).toEqual(query.plan);
    }
    const candidate = await createScaP03DockerJoernCandidateV1(
      config,
      mockRunner([], "graph-unlocated")
    );
    const observations = await candidate.qualify({
      fixtures,
      query_release: release,
      expected_cases: expectedCases(fixtures, release),
      fidelity_requirements: [],
      signal: new AbortController().signal,
    });
    expect(observations.executed_query_release_sha256).toBe(release.release_sha256);
    for (const [index, fixture] of fixtures.entries()) {
      const cases = observations.cases.slice(
        index * SCA_P03_QUERY_IDS.length,
        (index + 1) * SCA_P03_QUERY_IDS.length
      );
      expect(cases).toHaveLength(SCA_P03_QUERY_IDS.length);
      expect(cases.every((entry) => entry.status === "blocked")).toBe(true);
      expect(cases.every((entry) => entry.observation_count === 0)).toBe(true);
      for (const entry of cases) {
        expect(entry.observed_sha256).toBe(
          scaP03QualificationObservationSha256V2({
            fixture_id: fixture.fixture_id,
            fixture_sha256: fixture.content_sha256,
            query_id: entry.query_id,
            frontend_language: entry.frontend_language,
            release_sha256: release.release_sha256,
            blocker_code: entry.blocker_code,
            observations: entry.observations,
          })
        );
        for (const item of entry.observations) {
          expect(
            item.vertices.every((vertex) => vertex.path === fixture.path || vertex.path === null)
          ).toBe(true);
          if (item.vertices.some((vertex) => vertex.path === null)) {
            expect(item).toMatchObject({
              disposition: "unresolved",
              reason_code: "path_location_unaccounted",
            });
          }
        }
      }
    }
    // A valid digest and binding do not make a release without a limit executable.
    const queries = release.queries.map((query, index) => {
      if (index !== 0) return query;
      const plan = validateScaP03QueryPlanV2(
        withScaP03Digest(
          {
            ...Object.fromEntries(
              Object.entries(query.plan).filter(([key]) => key !== "plan_sha256")
            ),
            steps: query.plan.steps.filter((step) => step.kind !== "limit"),
          },
          "plan_sha256"
        )
      );
      return { ...query, plan, binding: { ...query.binding, plan_sha256: plan.plan_sha256 } };
    });
    const widened = await candidate.qualify({
      fixtures,
      query_release: { ...release, release_sha256: sha256("unbounded-release"), queries },
      expected_cases: expectedCases(fixtures, release),
      fidelity_requirements: [],
      signal: new AbortController().signal,
    });
    expect(widened.cases.map((entry) => entry.blocker_code)).toEqual(
      Array(21).fill("p03_plan_unbounded")
    );
    expect(widened.cases.every((entry) => entry.observation_count === 0)).toBe(true);
    expect(await readdir(parent)).toEqual([]);
  });

  it("bounds the neutral TypeScript JSSRC release without raising production ceilings", async () => {
    const { config } = await setup();
    const fixtures = qualificationFixtures();
    const release = qualificationRelease();
    expect(frozenRelease().queries[0]?.plan.steps.at(-1)).toEqual({ kind: "limit", max_items: 10 });
    expect(frozenRelease().queries[0]?.plan.max_ast_nodes).toBe(32);
    const within = await createScaP03DockerJoernCandidateV1(
      config,
      mockRunner([], "graph-ts-many")
    );
    const observations = await within.qualify({
      fixtures,
      query_release: release,
      expected_cases: expectedCases(fixtures, release),
      fidelity_requirements: [],
      signal: new AbortController().signal,
    });
    expect(
      observations.cases.find(
        (entry) => entry.language === "typescript" && entry.query_id === "p03.graph-integrity.v2"
      )
    ).toMatchObject({ status: "blocked", observation_count: 0 });
    const exceeded = await createScaP03DockerJoernCandidateV1(
      config,
      mockRunner([], "graph-ts-over-limit")
    );
    const blocked = await exceeded.qualify({
      fixtures,
      query_release: release,
      expected_cases: expectedCases(fixtures, release),
      fidelity_requirements: [],
      signal: new AbortController().signal,
    });
    const typescriptCases = blocked.cases.filter((entry) => entry.language === "typescript");
    expect(typescriptCases).toHaveLength(7);
    expect(typescriptCases.every((entry) => entry.status === "blocked")).toBe(true);
    // Selection is bounded *after* positive starts, not by all decoy methods in the graph.
    expect(typescriptCases.some((entry) => entry.blocker_code === "p03_query_limit_reached")).toBe(
      false
    );
  });

  it("does not retain ambiguous or external CONTAINS locations as reviewed targets", async () => {
    const { config } = await setup();
    const fixtures = qualificationFixtures();
    for (const mode of ["graph-ambiguous", "graph-external-owner"] as const) {
      const candidate = await createScaP03DockerJoernCandidateV1(config, mockRunner([], mode));
      const output = await candidate.qualify({
        fixtures,
        query_release: frozenRelease(true),
        expected_cases: expectedCases(fixtures, frozenRelease(true)),
        fidelity_requirements: [],
        signal: new AbortController().signal,
      });
      const call = output.cases
        .find((entry) => entry.language === "php" && entry.query_id === "p03.call-resolution.v2")
        ?.observations.find(
          (entry) => entry.vertices[0]?.node_id === "2" && entry.vertices[1]?.node_id === "1"
        );
      expect(call).toBeUndefined();
      expect(
        output.cases.find(
          (entry) => entry.language === "php" && entry.query_id === "p03.call-resolution.v2"
        )?.status
      ).toBe("blocked");
    }
  });

  it("does not retain a location with only a containing method line", async () => {
    const { config } = await setup();
    const candidate = await createScaP03DockerJoernCandidateV1(
      config,
      mockRunner([], "graph-no-call-line")
    );
    const release = qualificationRelease();
    const output = await candidate.qualify({
      fixtures: qualificationFixtures(),
      query_release: release,
      expected_cases: expectedCases(qualificationFixtures(), release),
      fidelity_requirements: [],
      signal: new AbortController().signal,
    });
    const call = output.cases
      .find(
        (entry) => entry.language === "javascript" && entry.query_id === "p03.call-resolution.v2"
      )
      ?.observations.find(
        (entry) => entry.vertices[0]?.node_id === "2" && entry.vertices[1]?.node_id === "1"
      );
    expect(call).toBeUndefined();
    expect(
      output.cases.find(
        (entry) => entry.language === "javascript" && entry.query_id === "p03.call-resolution.v2"
      )?.status
    ).toBe("blocked");
  });

  it("blocks wrong effective frontend and successful zero-node fixtures instead of passing empty cases", async () => {
    const { config, parent } = await setup();
    const fixtures = (["php", "javascript", "typescript"] as const).map((language) => {
      const bytes = Buffer.from(`${language} sample`);
      return {
        fixture_id: `${language}-fixture`,
        language,
        path:
          language === "php" ? "src/a.php" : language === "javascript" ? "src/a.js" : "src/a.ts",
        content_sha256: sha256(bytes),
        bytes,
      };
    });
    const run = async (
      mode:
        | "graph"
        | "wrong-frontend"
        | "reject-frontend"
        | "zero-nodes"
        | "invalid-inventory"
        | "reject-inventory"
        | "output-limit"
        | "unknown-failure"
    ) => {
      const calls: string[][] = [];
      const runtime = await createScaP03DockerJoernCandidateV1(config, mockRunner(calls, mode));
      const output = await runtime.qualify({
        fixtures,
        query_release: qualificationRelease(),
        expected_cases: expectedCases(fixtures, qualificationRelease()),
        fidelity_requirements: [],
        signal: new AbortController().signal,
      });
      expect(
        calls
          .filter((args) => args[3] === "joern-parse")
          .map((args) => args[args.indexOf("--language") + 1])
      ).toEqual(["PHP", "JSSRC", "JSSRC"]);
      return output;
    };
    const baseline = await run("graph");
    expect(
      baseline.cases.every((entry) => entry.blocker_code === "p03_oracle_assertion_mismatch")
    ).toBe(true);
    const wrong = await run("wrong-frontend");
    expect(wrong.cases.map((entry) => entry.status)).toEqual([
      ...Array.from({ length: 7 }, () => "blocked"),
      ...Array.from({ length: 14 }, () => "blocked"),
    ]);
    expect(wrong.cases.slice(7).map((entry) => entry.blocker_code)).toEqual(
      Array(14).fill("p03_graph_frontend_mismatch")
    );
    expect(wrong.cases[7]?.observation_count).toBe(0);
    expect(wrong.cases[7]?.frontend_language).toBe("JSSRC");
    expect(wrong.cases[7]?.observed_sha256).not.toBe(baseline.cases[7]?.observed_sha256);
    const rejected = await run("reject-frontend");
    expect(rejected.cases.map((entry) => entry.status)).toEqual([
      ...Array.from({ length: 7 }, () => "blocked"),
      ...Array.from({ length: 14 }, () => "blocked"),
    ]);
    expect(rejected.cases.slice(7).map((entry) => entry.blocker_code)).toEqual(
      Array(14).fill("p03_fixture_parse_failed")
    );
    const invalid = await run("invalid-inventory");
    expect(invalid.cases.slice(7).map((entry) => entry.blocker_code)).toEqual(
      Array(14).fill("p03_inventory_invalid")
    );
    const inventoryExit = await run("reject-inventory");
    expect(inventoryExit.cases.slice(7).map((entry) => entry.blocker_code)).toEqual(
      Array(14).fill("p03_fixture_inventory_failed")
    );
    const limited = await run("output-limit");
    expect(limited.cases.slice(7).map((entry) => entry.blocker_code)).toEqual(
      Array.from({ length: 14 }, () => "docker_output_limit")
    );
    const unknown = await run("unknown-failure");
    expect(unknown.cases.slice(7).map((entry) => entry.blocker_code)).toEqual(
      Array(14).fill("p03_qualification_runtime_failed")
    );
    expect(canonicalJson(unknown)).not.toContain("do-not-disclose");
    const empty = await run("zero-nodes");
    expect(empty.cases.map((entry) => entry.status)).toEqual([
      ...Array.from({ length: 14 }, () => "blocked"),
      ...Array.from({ length: 7 }, () => "blocked"),
    ]);
    expect(empty.cases.slice(14).map((entry) => entry.blocker_code)).toEqual(
      Array(7).fill("p03_fixture_nodes_absent")
    );
    expect(empty.cases[14]?.observation_count).toBe(0);
    // A graph with nodes still cannot pass a fixture if every frozen query observes nothing.
    const noCandidates = await (
      await createScaP03DockerJoernCandidateV1(config, mockRunner([], "graph"))
    ).qualify({
      fixtures,
      query_release: frozenRelease(),
      expected_cases: expectedCases(fixtures, frozenRelease()),
      fidelity_requirements: [],
      signal: new AbortController().signal,
    });
    expect(noCandidates.cases.map((entry) => entry.status)).toEqual([
      ...Array.from({ length: 7 }, () => "blocked"),
      ...Array.from({ length: 14 }, () => "blocked"),
    ]);
    expect(noCandidates.cases.slice(7).map((entry) => entry.blocker_code)).toEqual(
      Array(14).fill("p03_query_semantics_unsupported")
    );
    const blocked = wrong.cases[7];
    if (blocked === undefined) throw new Error("blocked case absent");
    validateScaP03QualificationCaseObservationsV2(blocked, wrong.executed_query_release_sha256);
    expect(() =>
      validateScaP03QualificationCaseObservationsV2(
        { ...blocked, blocker_code: null },
        wrong.executed_query_release_sha256
      )
    ).toThrow();
    expect(() =>
      validateScaP03QualificationCaseObservationsV2(
        { ...blocked, status: "passed" },
        wrong.executed_query_release_sha256
      )
    ).toThrow();
    const outputPath = path.join(parent, "candidate-observations.json");
    await writeCandidateObservations(outputPath, wrong);
    const persisted: unknown = JSON.parse(await readFile(outputPath, "utf8"));
    expect(persisted).toEqual(wrong);
    expect(await readdir(parent)).toEqual(["candidate-observations.json"]);
  });

  it("rejects missing and noncanonical CODE fields before any qualification observation", async () => {
    const { config } = await setup();
    const fixtures = qualificationFixtures();
    const release = qualificationRelease();
    for (const mode of ["missing-code-field", "invalid-code-encoding"] as const) {
      const candidate = await createScaP03DockerJoernCandidateV1(config, mockRunner([], mode));
      const result = await candidate.qualify({
        fixtures,
        query_release: release,
        expected_cases: expectedCases(fixtures, release),
        fidelity_requirements: [],
        signal: new AbortController().signal,
      });
      expect(
        result.cases.every(
          (entry) => entry.blocker_code === "p03_inventory_invalid" && entry.observation_count === 0
        )
      ).toBe(true);
    }
  });

  it("rejects wrong graph frontend request, and uses JSSRC for JS/TS while PHP uses PHP", async () => {
    const { config, parent } = await setup();
    const calls: string[][] = [];
    const runtime = await createScaP03DockerSimulatedTestRuntimeV1(config, mockRunner(calls));
    for (const [partition, filePath, content, frontend] of [
      ["php", "src/a.php", "<?php function sample() {}", "PHP"],
      ["javascript_typescript", "src/a.js", "function sample() {}", "JSSRC"],
      ["javascript_typescript", "src/a.ts", "function sample(): void {}", "JSSRC"],
    ] as const) {
      const bytes = Buffer.from(content);
      const request = graphRequest(bytes, imageDigest, 4096, partition, filePath);
      const built = await runtime.buildGraph({
        request,
        files: [{ path: filePath, content_sha256: sha256(bytes), bytes, role: "primary" }],
        signal: new AbortController().signal,
      });
      expect(built.accounted_files[0]?.disposition).toBe("parsed");
      const parse = calls.filter((args) => args[3] === "joern-parse").at(-1);
      expect(parse?.[parse.indexOf("--language") + 1]).toBe(frontend);
      expect(() =>
        validateScaP03OperationRequestV1("build_source_graph", {
          ...request,
          frontend_language: partition === "php" ? "JSSRC" : "JAVASCRIPT",
        })
      ).toThrow();
    }
    expect(await readdir(parent)).toEqual([]);
  });

  it("executes bounded frozen graph steps, refuses an unproven edge, and binds graph bytes", async () => {
    const { config, parent } = await setup();
    const runtime = await createScaP03DockerSimulatedTestRuntimeV1(config, mockRunner([], "graph"));
    const graph_bytes = Buffer.from("real-cpg-output");
    const graphDigest = sha256(graph_bytes);
    const base = graphRequest(Buffer.from("<?php echo 1;"));
    const omitted = new Set([
      "schema_id",
      "operation_id",
      "operation_kind",
      "request_sha256",
      "partition",
      "frontend_language",
      "source_file_manifest_ref",
      "source_custody_ref",
      "expected_files",
      "max_num_def",
      "max_graph_bytes",
    ]);
    const request = validateScaP03OperationRequestV1(
      "run_baseline_query_batch",
      withScaP03Digest(
        {
          ...Object.fromEntries(Object.entries(base).filter(([key]) => !omitted.has(key))),
          schema_id: "penny.sca-p03-baseline-query-batch-request.v2",
          schema_version: 2,
          operation_kind: "run_baseline_query_batch",
          operation_id: "sca-p03-baseline-query-batch-php",
          partition: "php",
          graph_component_ref: {
            ...ref,
            content_digest: graphDigest,
            store_ref: `artifact://sha256/${graphDigest}`,
          },
          graph_component_sha256: graphDigest,
          graph_build_request_ref: ref,
          graph_build_result_ref: ref,
          ordered_query_ids: SCA_P03_QUERY_IDS,
          fidelity_requirements: [
            {
              requirement_id: "language-php",
              dimension: "language",
              subject: "php",
              partition: "php",
              materiality: "material",
              complement_evidence_ref: null,
            },
          ],
          query_script_refs: SCA_P03_QUERY_IDS.map((_, index) => ({
            ...ref,
            artifact_id: `art_${sha256(`script-${String(index)}`)}`,
          })),
          query_plan_refs: SCA_P03_QUERY_IDS.map((_, index) => ({
            ...ref,
            artifact_id: `art_${sha256(`plan-${String(index)}`)}`,
          })),
          max_query_output_bytes: 1_000_000,
          max_query_items: 100,
          max_page_items: 10,
          max_pages_per_query: 10,
        },
        "request_sha256"
      )
    );
    const accounted_files = [
      {
        path: "src/a.php",
        content_sha256: sha256(Buffer.from("<?php echo 1;")),
        disposition: "parsed" as const,
        reason_code: null,
      },
    ];
    const output = await runtime.runBaselineQueries({
      request,
      graph_bytes,
      accounted_files,
      query_release: frozenRelease(),
      signal: new AbortController().signal,
    });
    expect(output.pages.map((page) => page.query_id)).toEqual(SCA_P03_QUERY_IDS);
    // An extra caller field cannot turn the baseline into an oracle-scoped query.
    const injectedInput = {
      request,
      graph_bytes,
      accounted_files,
      query_release: frozenRelease(),
      expected_cases: expectedCases(qualificationFixtures(), qualificationRelease()),
      signal: new AbortController().signal,
    };
    const injected = await runtime.runBaselineQueries(injectedInput);
    expect(injected.pages).toEqual(output.pages);
    expect(
      output.pages.find((page) => page.query_id === "p03.dataflow-source-sink.v2")?.items[0]
    ).toMatchObject({
      path: "src/a.php",
      line: 4,
      candidate_kind: "source_to_sink_flow",
      disposition: "supported",
      hop_count: 1,
      vertices: [
        { node_id: "4", line: 4 },
        { node_id: "5", line: 5 },
      ],
      edges: [
        {
          src_index: 0,
          dst_index: 1,
          kind: "reaching_def",
          direction: "forward",
          provenance: "observed_cpg",
        },
      ],
    });
    expect(
      output.pages.find((page) => page.query_id === "p03.call-resolution.v2")?.items[0]
    ).toMatchObject({
      disposition: "supported",
      hop_count: 1,
      vertices: [
        { node_id: "2", role: "call_site" },
        { node_id: "1", role: "callee" },
      ],
      edges: [{ src_node_id: "2", dst_node_id: "1", kind: "call", provenance: "observed_cpg" }],
    });
    expect(
      output.pages.find((page) => page.query_id === "p03.framework-dispatch.v2")?.items[0]
    ).toMatchObject({
      disposition: "unresolved",
      callback_resolution: "dynamic",
      framework: null,
    });
    expect(output.fidelity_observations[0]?.support).toBe("partial");
    expect(output.pages[0]?.items[0]?.vertices[0]?.path).toBe("src/a.php");

    const unlocatedRuntime = await createScaP03DockerSimulatedTestRuntimeV1(
      config,
      mockRunner([], "graph-unlocated")
    );
    const release = frozenRelease(true);
    const unlocated = await unlocatedRuntime.runBaselineQueries({
      request,
      graph_bytes,
      accounted_files,
      query_release: release,
      signal: new AbortController().signal,
    });
    const callItems = unlocated.pages.find(
      (page) => page.query_id === "p03.call-resolution.v2"
    )?.items;
    expect(callItems).toHaveLength(4); // External/empty-line endpoints are counted.
    expect(callItems?.map((item) => item.disposition)).toEqual([
      "unresolved",
      "supported",
      "unresolved",
      "unresolved",
    ]);
    expect(callItems?.[1]?.vertices[0]).toMatchObject({
      node_id: "2",
      path: "src/a.php",
      line: 2,
      location_provenance: "containing_method",
      location_owner_node_id: "6",
      location_evidence: {
        owner_node_id: "6",
        owner_label: "method",
        edge_kind: "contains",
        edge_src_node_id: "6",
        edge_dst_node_id: "2",
      },
    });
    expect(callItems?.[0]?.vertices[1]).toMatchObject({
      node_id: "3",
      location_provenance: "external_unaccounted",
      path: null,
    });
    expect(callItems?.[2]?.vertices[1]).toMatchObject({
      node_id: "6",
      path: "src/a.php",
      line: null,
      location_provenance: "direct",
    });
    expect(
      callItems?.filter((item) => item.reason_code === "path_location_unaccounted")
    ).toHaveLength(2);
    for (const page of unlocated.pages) {
      expect(page.complete).toBe(true);
      for (const item of page.items) {
        expect(() =>
          validateScaP03QueryCandidateV2(item, {
            query_id: page.query_id,
            graph_component_sha256: graphDigest,
            source_snapshot_sha256: request.source_snapshot_sha256,
            query_release_sha256: release.release_sha256,
            accounted_paths: ["src/a.php"],
          })
        ).not.toThrow();
        if (item.vertices.some((vertex) => vertex.path === null)) {
          expect(item).toMatchObject({
            disposition: "unresolved",
            reason_code: "path_location_unaccounted",
            truncated: false,
          });
          expect(item.summary).toContain("full relationship path location unavailable");
          expect(item.vertices.filter((vertex) => vertex.path === null)).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ path: null, line: null, name: null, full_name: null }),
            ])
          );
          expect(item.stable_locator).not.toContain("/generated/");
        }
      }
    }
    expect(callItems?.[3]).toMatchObject({ path: null, line: null, hop_count: 1 });
    expect(unlocated.truncated).toBe(false);
    expect(unlocated.fidelity_observations[0]).toMatchObject({ support: "partial" });
    const pagedRequest = validateScaP03OperationRequestV1(
      "run_baseline_query_batch",
      withScaP03Digest(
        {
          ...Object.fromEntries(
            Object.entries(request).filter(([key]) => key !== "request_sha256")
          ),
          max_page_items: 2,
          max_pages_per_query: 2,
        },
        "request_sha256"
      )
    );
    const paged = await unlocatedRuntime.runBaselineQueries({
      request: pagedRequest,
      graph_bytes,
      accounted_files,
      query_release: release,
      signal: new AbortController().signal,
    });
    expect(
      paged.pages
        .filter((page) => page.query_id === "p03.call-resolution.v2")
        .map((page) => ({ count: page.items.length, complete: page.complete }))
    ).toEqual([
      { count: 2, complete: false },
      { count: 2, complete: true },
    ]);
    const singlePageRequest = validateScaP03OperationRequestV1(
      "run_baseline_query_batch",
      withScaP03Digest(
        {
          ...Object.fromEntries(
            Object.entries(pagedRequest).filter(([key]) => key !== "request_sha256")
          ),
          max_pages_per_query: 1,
        },
        "request_sha256"
      )
    );
    await expect(
      unlocatedRuntime.runBaselineQueries({
        request: singlePageRequest,
        graph_bytes,
        accounted_files,
        query_release: release,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("p03_query_page_limit");
    const tightRequest = validateScaP03OperationRequestV1(
      "run_baseline_query_batch",
      withScaP03Digest(
        {
          ...Object.fromEntries(
            Object.entries(request).filter(([key]) => key !== "request_sha256")
          ),
          max_query_items: 5,
        },
        "request_sha256"
      )
    );
    await expect(
      unlocatedRuntime.runBaselineQueries({
        request: tightRequest,
        graph_bytes,
        accounted_files,
        query_release: release,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("p03_query_item_limit");
    const fixtures = (["php", "javascript", "typescript"] as const).map((language) => {
      const bytes = Buffer.from(`${language} fixture`);
      return {
        fixture_id: `${language}-fixture`,
        language,
        path:
          language === "php" ? "src/a.php" : language === "javascript" ? "src/a.js" : "src/a.ts",
        content_sha256: sha256(bytes),
        bytes,
      };
    });
    const unlocatedCandidate = await createScaP03DockerJoernCandidateV1(
      config,
      mockRunner([], "graph-unlocated")
    );
    const qualification = await unlocatedCandidate.qualify({
      fixtures,
      query_release: qualificationRelease(),
      expected_cases: expectedCases(fixtures, qualificationRelease()),
      fidelity_requirements: [],
      signal: new AbortController().signal,
    });
    expect(qualification.cases).toHaveLength(21);
    expect(qualification.cases.every((entry) => entry.status === "blocked")).toBe(true);
    expect(qualification.cases[2]?.observed_sha256).toBe(
      (
        await unlocatedCandidate.qualify({
          fixtures,
          query_release: qualificationRelease(),
          expected_cases: expectedCases(fixtures, qualificationRelease()),
          fidelity_requirements: [],
          signal: new AbortController().signal,
        })
      ).cases[2]?.observed_sha256
    );
    await expect(
      runtime.runBaselineQueries({
        request,
        graph_bytes: Buffer.from("wrong"),
        accounted_files,
        query_release: frozenRelease(),
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("p03_graph_custody_invalid");
    const changed = frozenRelease();
    const queries = changed.queries.map((q) =>
      q.query_id === "p03.dataflow-source-sink.v2"
        ? {
            ...q,
            plan: {
              ...q.plan,
              steps: q.plan.steps.filter((step) => step.kind !== "traverse_edge"),
            },
          }
        : q
    );
    await expect(
      runtime.runBaselineQueries({
        request,
        graph_bytes,
        accounted_files,
        query_release: { ...changed, queries },
        signal: new AbortController().signal,
      })
    ).rejects.toThrow();
    expect(await readdir(parent)).toEqual([]);
  });
  it.skipIf(process.env.PENNY_P03_DOCKER_LIVE !== "1")(
    "measures and runs candidate fixtures first; observations alone are not live attestation",
    async () => {
      const exactImage = process.env.PENNY_P03_DOCKER_IMAGE;
      const dockerExecutable = process.env.PENNY_P03_DOCKER_EXECUTABLE;
      if (exactImage === undefined || dockerExecutable === undefined)
        throw new Error("live Docker inputs required");
      const { config, parent } = await setup();
      if (!/@sha256:[a-f0-9]{64}$/u.test(exactImage)) throw new Error("image digest absent");
      const dockerSha = sha256(await readFile(dockerExecutable));
      const imageId = execFileSync(
        dockerExecutable,
        ["image", "inspect", "--format", "{{.Id}}", exactImage],
        { encoding: "utf8" }
      ).trim();
      if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) throw new Error("Docker image ID absent");
      const [clientVersion, serverVersion] = execFileSync(
        dockerExecutable,
        ["version", "--format", "{{.Client.Version}} {{.Server.Version}}"],
        { encoding: "utf8" }
      )
        .trim()
        .split(" ");
      if (clientVersion === undefined || serverVersion === undefined)
        throw new Error("Docker version absent");
      const candidate = await createScaP03DockerJoernCandidateV1({
        ...config,
        docker_executable: dockerExecutable,
        image_ref: exactImage,
        expected_docker_executable_sha256: dockerSha,
        expected_docker_client_version: clientVersion,
        expected_docker_server_version: serverVersion,
        deployment_identity_sha256: sha256(
          canonicalJson({
            docker_executable_sha256: dockerSha,
            docker_client_version: clientVersion,
            docker_server_version: serverVersion,
            image_id: imageId,
            joern_version: config.expected_joern_version,
          })
        ),
        timeout_ms: 120_000,
        memory_bytes: 2 * 1024 * 1024 * 1024,
        max_workspace_bytes: 32 * 1024 * 1024,
      });
      const { fixtures, expected_cases, receiptRef, validatedReceipt } =
        await reviewedQualificationAuthority();
      const release = qualificationRelease();
      const observations = await candidate.qualify({
        fixtures,
        query_release: release,
        expected_cases,
        source_oracle_validation_ref: receiptRef,
        source_oracle_validation_receipt: validatedReceipt,
        fidelity_requirements: [],
        signal: new AbortController().signal,
      });
      const outputPath = process.env.PENNY_P03_DOCKER_OBSERVATIONS_OUT;
      if (outputPath !== undefined && outputPath.length > 0) {
        // Test-only opt-in: preserve even a blocked observation set for review before assertions.
        await writeCandidateObservations(outputPath, observations);
      }
      assertReviewedComplementCases(observations.cases, receiptRef);
      expect(observations.executed_query_release_sha256).toBe(release.release_sha256);
      assertReviewedCandidateObservations(observations.cases, fixtures, release.release_sha256);
      for (const key of [
        "host_attestation_id",
        "host_attestation_sha256",
        "host_attestation_ref",
        "qualification_scope",
        "buildGraph",
        "runBaselineQueries",
      ]) {
        expect(key in candidate, key).toBe(false);
        expect(key in observations, key).toBe(false);
      }
      expect(await readdir(parent)).toEqual([]);
    },
    280_000
  );
  it("refuses candidate attestation claims and structural host runtime injection", async () => {
    const { config } = await setup();
    const forgedConfig = { ...config, host_attestation_id: "forged" };
    await expect(createScaP03DockerJoernCandidateV1(forgedConfig, mockRunner([]))).rejects.toThrow(
      "p03_candidate_attestation_forbidden"
    );
    const candidate = await createScaP03DockerJoernCandidateV1(config, mockRunner([]));
    const { createScaP03OperationAdaptersV1 } = await import("../src/p03-operations.js");
    const forged = {
      ...candidate,
      runtime_kind: "host_qualified_joern" as const,
      qualification_scope: "live_qualified" as const,
      host_attestation_id: "forged",
      host_attestation_sha256: ref.content_digest,
      host_attestation_ref: ref,
      source_oracle_ref: ref,
      source_oracle_validation_ref: ref,
      parser_identity_sha256: ref.content_digest,
      staging_parent: config.staging_parent,
      max_num_def: config.max_num_def,
      buildGraph: async () => {
        throw new Error("not executable");
      },
      runBaselineQueries: async () => {
        throw new Error("not executable");
      },
    };
    expect(() => createScaP03OperationAdaptersV1({ runtime: forged })).toThrow(
      "p03_unverified_host_runtime_injection"
    );
  });

  it("rejects tags and measured image drift before graph execution", async () => {
    const { config, parent } = await setup();
    await expect(
      createScaP03DockerSimulatedTestRuntimeV1(
        { ...config, image_ref: "registry.example/joern:latest" },
        mockRunner([])
      )
    ).rejects.toThrow("p03_docker_config_invalid");
    await expect(
      createScaP03DockerSimulatedTestRuntimeV1(config, mockRunner([], "bad-posture"))
    ).rejects.toThrow("p03_container_identity_drift");
    await expect(
      createScaP03DockerSimulatedTestRuntimeV1(config, mockRunner([], "joern-drift"))
    ).rejects.toThrow("p03_joern_version_drift");
    await expect(
      createScaP03DockerSimulatedTestRuntimeV1(config, mockRunner([], "drift"))
    ).rejects.toThrow("p03_deployment_measurement_mismatch");
    await expect(
      createScaP03DockerSimulatedTestRuntimeV1(
        { ...config, expected_docker_server_version: "2.0.0" },
        mockRunner([])
      )
    ).rejects.toThrow("p03_docker_daemon_drift");
    await expect(
      createScaP03DockerSimulatedTestRuntimeV1(
        { ...config, expected_docker_executable_sha256: "0".repeat(64) },
        mockRunner([])
      )
    ).rejects.toThrow("p03_docker_executable_drift");
    expect(await readdir(parent)).toEqual([]);
  });

  it("uses exact confined create argv, accounts only Joern-observed files, and cleans private workspace", async () => {
    const { config, parent } = await setup();
    const calls: string[][] = [];
    const runtime = await createScaP03DockerSimulatedTestRuntimeV1(config, mockRunner(calls));
    const bytes = Buffer.from("<?php echo 1;");
    const result = await runtime.buildGraph({
      request: graphRequest(bytes),
      files: [{ path: "src/a.php", content_sha256: sha256(bytes), bytes, role: "primary" }],
      signal: new AbortController().signal,
    });
    expect(Buffer.from(result.graph_bytes).toString()).toBe("real-cpg-output");
    expect(result.accounted_files[0]?.disposition).toBe("parsed");
    expect(result.graph_opened).toBe(true);
    expect(result.cleanup_evidence.workspace_removed).toBe(true);
    const create = calls.find(
      (args) =>
        args[0] === "container" &&
        args[1] === "create" &&
        args.some((arg) => arg.includes("dst=/source,"))
    );
    if (create === undefined) throw new Error("create absent");
    for (const flag of [
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "no-new-privileges",
      "--pids-limit",
      "--memory",
      "--memory-swap",
      "--cpus",
      "--user",
      "--pull=never",
      "--log-driver",
    ])
      expect(create).toContain(flag);
    expect(create).not.toContain("--privileged");
    expect(create).toContain(
      `/work:rw,exec,nosuid,nodev,size=${String(config.max_workspace_bytes)},mode=0700,uid=${String(process.getuid?.())},gid=${String(process.getgid?.())}`
    );
    expect(create.some((arg) => arg.includes("dst=/work"))).toBe(false);
    expect(create.some((arg) => arg.includes("dst=/scripts,readonly"))).toBe(true);
    expect(create.some((arg) => arg.includes("dst=/source,readonly"))).toBe(true);
    expect(calls.some((args) => args[1] === "exec" && args[3] === "python3")).toBe(true);
    expect(create).toContain(image);
    expect(await readdir(parent)).toEqual([]);
  });

  it("waits for exact container and workspace cleanup on cancellation", async () => {
    const { config, parent } = await setup();
    const calls: string[][] = [];
    const simulatedDocker = mockRunner(calls);
    const controller = new AbortController();
    let cancelOnStart = false;
    const runtime = await createScaP03DockerSimulatedTestRuntimeV1(config, async (command) => {
      const response = await simulatedDocker(command);
      if (cancelOnStart && command.argv[0] === "container" && command.argv[1] === "exec") {
        controller.abort(new Error("cancelled by caller"));
      }
      return response;
    });
    cancelOnStart = true;
    const bytes = Buffer.from("<?php echo 1;");
    await expect(
      runtime.buildGraph({
        request: graphRequest(bytes),
        files: [{ path: "src/a.php", content_sha256: sha256(bytes), bytes, role: "primary" }],
        signal: controller.signal,
      })
    ).rejects.toThrow();
    expect(calls.some((args) => args[1] === "rm")).toBe(true);
    expect(await readdir(parent)).toEqual([]);
  });

  it("enforces the tmpfs ceiling and refuses linked or extra readback outputs", async () => {
    const { config, parent } = await setup();
    const bytes = Buffer.from("<?php echo 1;");
    for (const [mode, message] of [
      ["workspace-full", "docker_container_exec_exit_1"],
      ["linked-output", "docker_container_exec_exit_2"],
      ["extra-output", "docker_container_exec_exit_2"],
    ] as const) {
      const calls: string[][] = [];
      const runtime = await createScaP03DockerSimulatedTestRuntimeV1(
        config,
        mockRunner(calls, mode)
      );
      await expect(
        runtime.buildGraph({
          request: graphRequest(bytes),
          files: [{ path: "src/a.php", content_sha256: sha256(bytes), bytes, role: "primary" }],
          signal: new AbortController().signal,
        })
      ).rejects.toThrow(message);
      expect(calls.some((args) => args[1] === "rm")).toBe(true);
      expect(await readdir(parent)).toEqual([]);
    }
  });

  it("refuses dishonest file accounting, unsafe custody and unproven cleanup", async () => {
    const { config, parent } = await setup();
    const bytes = Buffer.from("<?php echo 1;");
    const request = graphRequest(bytes);
    const runtime = await createScaP03DockerSimulatedTestRuntimeV1(
      config,
      mockRunner([], "missing")
    );
    const result = await runtime.buildGraph({
      request,
      files: [{ path: "src/a.php", content_sha256: sha256(bytes), bytes, role: "primary" }],
      signal: new AbortController().signal,
    });
    expect(result.accounted_files[0]).toMatchObject({
      disposition: "unsupported",
      reason_code: "joern_file_absent",
    });
    await expect(
      runtime.buildGraph({
        request,
        files: [{ path: "../escape", content_sha256: sha256(bytes), bytes, role: "primary" }],
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("p03_source_custody_invalid");
    expect(await readdir(parent)).toEqual([]);
    await expect(
      createScaP03DockerSimulatedTestRuntimeV1(config, mockRunner([], "cleanup-fails"))
    ).rejects.toThrow("p03_cleanup_unproven");
  });
});
