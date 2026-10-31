import path from "node:path";
import { ScaP01JoernRootInputV1Schema } from "./p01-joern-root.js";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  validateScaP03AttemptWitnessV1,
  type ScaP03AttemptWitnessV1,
} from "../../orchestration/dist/sca/p03-bootstrap-contracts.js";
import {
  ScaP03InitialResourcesV1Schema,
  type ScaP03InitialResourcesV1,
} from "../../orchestration/dist/sca/p03-initial-authorization.js";
import { validateContract } from "../../orchestration/dist/contracts.js";
import { scaP03FrontendLanguageV1 } from "../../orchestration/dist/sca/p03-contracts.js";
import { ScaP03InitialEvidenceV1Schema, type ScaP03InitialEvidenceV1 } from "./p03-initial-live.js";
import {
  scaP03NativeCreateArgvV1,
  scaP03NativeDockerVersionMatchesV1,
  scaP03NativeDockerImageIdV1,
  scaP03NativeContainerMatchesV1,
  scaP03NativeContainerRunningV1,
  scaP03NativeConfinementProjectionV1,
  scaP03OwnedDockerLabelsMatchV1,
} from "./p03-docker-runtime.js";
import {
  assertScaP03JoernLauncherProbeV1,
  parseScaP03JoernPackageListingV1,
} from "./p03-toolchain-version.js";
import {
  consumedFixtureCheckV1 as check,
  consumedFixtureGuardV1 as guard,
  parseScaP03ConsumedJsonV1 as json,
  decodeScaP03ConsumedBase64V1 as base64,
} from "./p03-consumed-fixture-custody.js";

/** Current retained successful native grammar: 3 + 5 + 3 probes, then 3 parse/inventory pairs. */
const NATIVE_FIXTURE_EXECUTION_COUNT = 17;

export interface ScaP03ConsumedFixtureReadbackV1 {
  readonly language: "php" | "javascript" | "typescript";
  readonly graph: Buffer;
  readonly inventory: Buffer;
}
export interface ScaP03ConsumedFixtureTranscriptV1 {
  readonly attempt_witness: ScaP03AttemptWitnessV1;
  readonly attempt_witness_bytes: Uint8Array;
  readonly readbacks: readonly ScaP03ConsumedFixtureReadbackV1[];
}
function object(value: unknown): Record<string, unknown> {
  check(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "witness_consistency"
  );
  return Object.fromEntries(Object.entries(value));
}
/** Replays only retained native evidence. No host/process inspection, runtime constructors or V3 policy. */
export function verifyScaP03ConsumedFixtureTranscriptV1(input: {
  readonly evidence: ScaP03InitialEvidenceV1;
  readonly resources: ScaP03InitialResourcesV1;
  readonly operation_record_id: string;
  readonly run_id: string;
  readonly request_sha256: string;
}): ScaP03ConsumedFixtureTranscriptV1 {
  return guard("witness_consistency", () => {
    const e = validateContract(ScaP03InitialEvidenceV1Schema, input.evidence, "P03 transcript");
    const r = validateContract(
      ScaP03InitialResourcesV1Schema,
      input.resources,
      "P03 recorded resources"
    );
    check(e.original_observations.length <= r.max_commands, "bounds");
    let representationBytes = 0;
    const observations = e.original_observations.map((o, i) => {
      check(o.ordinal === i + 1, "witness_consistency");
      const bytes = base64(o.output_base64, r.command_output_bytes);
      check(bytes.byteLength === o.byte_length && sha256(bytes) === o.output_sha256, "bytes");
      representationBytes += Buffer.byteLength(canonicalJson(o));
      check(representationBytes <= r.max_evidence_bytes, "bounds");
      return {
        argv_sha256: o.argv_sha256,
        bytes,
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    });
    const witnessBytes = base64(e.attempt_witness_base64, 1_048_576);
    json(witnessBytes, 1_048_576);
    const w = validateScaP03AttemptWitnessV1(witnessBytes);
    check(
      w.run_id === input.run_id &&
        w.candidate_sha256 === input.request_sha256 &&
        w.disposition === "completed" &&
        w.workspace_absent &&
        w.executions.length === NATIVE_FIXTURE_EXECUTION_COUNT,
      "witness_consistency"
    );
    const E = e.environment;
    validateContract(
      ScaP01JoernRootInputV1Schema.properties.image_ref,
      E.image_ref,
      "P03 recorded image ref"
    );
    check(!E.image_ref.includes("//"), "witness_consistency");
    const { docker_executable_sha256, ...versions } = E;
    const deployment = {
      docker_executable_sha256,
      docker_client_version: E.docker_client_version,
      docker_server_version: E.docker_server_version,
      image_id: E.image_id,
      joern_version: E.joern_version,
    };
    check(
      w.identity.runtime_package_sha256 === sha256(canonicalJson(versions)) &&
        w.identity.deployment_sha256 === sha256(canonicalJson(deployment)),
      "witness_consistency"
    );
    for (const key of [
      "docker_executable_sha256",
      "docker_client_version",
      "docker_server_version",
      "image_id",
      "joern_version",
    ] as const)
      check(w.identity[key] === E[key], "witness_consistency");
    const seed = sha256(input.operation_record_id);
    let cursor = 0,
      executionIndex = 0;
    const take = (argv: readonly string[]) => {
      const observation = observations[cursor++];
      check(
        observation !== undefined && observation.argv_sha256 === sha256(canonicalJson(argv)),
        "witness_consistency"
      );
      return observation;
    };
    const image = () => {
      const value = object(
        json(
          take(["image", "inspect", "--format", "{{json .}}", E.image_ref]).bytes,
          r.command_output_bytes,
          false
        )
      );
      check(scaP03NativeDockerImageIdV1(value, E.image_ref) === E.image_id, "witness_consistency");
      const config = object(value.Config);
      check(
        config.Volumes == null || Object.keys(object(config.Volumes)).length === 0,
        "witness_consistency"
      );
      return config;
    };
    let groupRoot: string | null = null;
    const newGroup = () => {
      groupRoot = null;
    };
    const container = (
      primary: readonly string[],
      mountsKind: "probe" | "parse" | "inventory",
      filename: "graph.cpg.bin" | "inventory.tsv" | null
    ) => {
      const execution = w.executions[executionIndex++];
      check(execution !== undefined && execution.id !== null, "witness_consistency");
      const id = execution.id;
      const n = sha256(`${seed}:${String(execution.ordinal + 1)}`);
      const name = `penny-p03-${n.slice(0, 8)}-${n.slice(8, 12)}-${n.slice(12, 16)}-${n.slice(16, 20)}-${n.slice(20, 32)}`;
      check(execution.name === name, "witness_consistency");
      const create = observations[cursor++];
      check(create !== undefined && create.text.trim() === id, "witness_consistency");
      const imageConfig = image();
      const inspectionArgv = ["container", "inspect", "--format", "{{json .}}", id];
      const before = json(take(inspectionArgv).bytes, r.command_output_bytes, false);
      const beforeObject = object(before),
        beforeState = object(beforeObject.State),
        config = object(beforeObject.Config);
      check(
        beforeState.Status === "created" && beforeState.Running === false,
        "witness_consistency"
      );
      check(
        typeof config.User === "string" && /^[0-9]+:[0-9]+$/.test(config.User),
        "witness_consistency"
      );
      const [uid, gid] = config.User.split(":").map(Number);
      check(
        uid !== undefined &&
          gid !== undefined &&
          Number.isSafeInteger(uid) &&
          Number.isSafeInteger(gid) &&
          uid > 0 &&
          gid > 0,
        "witness_consistency"
      );
      check(Array.isArray(beforeObject.Mounts), "witness_consistency");
      const mounts = beforeObject.Mounts.map(object);
      const scripts = mounts.find((m) => m.Destination === "/scripts")?.Source;
      check(
        typeof scripts === "string" &&
          path.posix.isAbsolute(scripts) &&
          path.posix.normalize(scripts) === scripts &&
          path.posix.basename(scripts) === "scripts",
        "witness_consistency"
      );
      const root = path.posix.dirname(scripts);
      // A removed pathname may be reused. No retained dev/inode preimage exists;
      // only the within-phase mount relationship is replayable here.
      if (groupRoot === null) groupRoot = root;
      check(root === groupRoot, "witness_consistency");
      const source = mountsKind === "probe" ? null : `${root}/source`;
      const mountInput = mountsKind === "inventory" ? `${root}/output` : null;
      const tmpfs = `/tmp:rw,exec,nosuid,nodev,size=${String(r.tmp_bytes)}`;
      const workspaceTmpfs = `/work:rw,exec,nosuid,nodev,size=${String(r.work_bytes)},mode=0700,uid=${String(uid)},gid=${String(gid)}`;
      const mountArgs = [
        "--mount",
        `type=bind,src=${scripts},dst=/scripts,readonly`,
        ...(source === null ? [] : ["--mount", `type=bind,src=${source},dst=/source,readonly`]),
        ...(mountInput === null
          ? []
          : ["--mount", `type=bind,src=${mountInput},dst=/input,readonly`]),
      ];
      const createArgv = scaP03NativeCreateArgvV1({
        config: { ...r, image_ref: E.image_ref },
        seed,
        attemptOrdinal: execution.ordinal + 1,
        currentName: name,
        uid,
        gid,
        tmpfs,
        workspaceTmpfs,
        mounts: mountArgs,
        jvmHeapBytes: r.jvm_heap_bytes,
      });
      check(
        create.argv_sha256 === sha256(canonicalJson(createArgv)) &&
          execution.create_sha256 === create.argv_sha256,
        "witness_consistency"
      );
      const confined = (value: unknown) => {
        check(
          scaP03NativeContainerMatchesV1(value, id, E.image_id, name, {
            config: r,
            uid,
            gid,
            source,
            input: mountInput,
            scripts,
            workspaceTmpfs,
            tmpfs,
          }),
          "witness_consistency"
        );
        const c = object(object(value).Config);
        check(
          scaP03OwnedDockerLabelsMatchV1(c.Labels, imageConfig.Labels, seed, execution.ordinal + 1),
          "witness_consistency"
        );
        check(
          Array.isArray(c.Env) &&
            c.Env.filter((v) => typeof v === "string" && v.startsWith("JAVA_TOOL_OPTIONS="))
              .length === 1 &&
            c.Env.includes(`JAVA_TOOL_OPTIONS=-Xmx${String(r.jvm_heap_bytes)}`),
          "witness_consistency"
        );
      };
      confined(before);
      take(["container", "start", id]);
      const running = json(take(inspectionArgv).bytes, r.command_output_bytes, false);
      confined(running);
      check(scaP03NativeContainerRunningV1(running), "witness_consistency");
      const projection = scaP03NativeConfinementProjectionV1(running);
      check(
        execution.inspect_sha256 === sha256(canonicalJson(running)) &&
          execution.confinement_projection === projection &&
          execution.confinement_sha256 === sha256(projection),
        "witness_consistency"
      );
      const primaryArgv = ["container", "exec", id, ...primary];
      const response = take(primaryArgv);
      check(
        execution.command_sha256 === sha256(canonicalJson(primaryArgv)) &&
          execution.response_sha256 === sha256(response.bytes) &&
          execution.requires_readback === (filename !== null),
        "witness_consistency"
      );
      let readback: Buffer | null = null;
      if (filename !== null) {
        const limit = filename === "graph.cpg.bin" ? r.max_graph_bytes : r.max_query_bytes;
        const encoded = take([
          "container",
          "exec",
          id,
          "python3",
          "/scripts/readback.py",
          filename,
          String(limit),
        ]);
        readback = base64(encoded.text, limit);
        check(
          readback.byteLength > 0 && execution.readback_sha256 === sha256(readback),
          "witness_consistency"
        );
      } else check(execution.readback_sha256 === null, "witness_consistency");
      take(["container", "rm", "--force", name]);
      check(
        take([
          "container",
          "ls",
          "--all",
          "--filter",
          `name=^/${name}$`,
          "--format",
          "{{.ID}}",
        ]).text.trim() === "",
        "witness_consistency"
      );
      return { response: response.text, readback };
    };
    const listing = (component: "joern-cli" | "php2cpg" | "jssrc2cpg") => {
      const output = container(
        [
          "find",
          "/opt/joern",
          "-type",
          "f",
          "-name",
          `io.joern.${component}-*.jar`,
          "-printf",
          "%f\\n",
        ],
        "probe",
        null
      ).response;
      const version = parseScaP03JoernPackageListingV1(output, component);
      check(version === E.joern_version, "witness_consistency");
      return version;
    };
    const measure = () => {
      newGroup();
      check(
        scaP03NativeDockerVersionMatchesV1(
          json(take(["version", "--format", "{{json .}}"]).bytes, r.command_output_bytes, false),
          E.docker_client_version,
          E.docker_server_version
        ),
        "witness_consistency"
      );
      image();
      listing("joern-cli");
      assertScaP03JoernLauncherProbeV1(
        container(["which", "joern"], "probe", null).response,
        container(["joern", "--help"], "probe", null).response
      );
    };
    measure();
    newGroup();
    check(
      listing("php2cpg") === E.php_frontend_version &&
        listing("jssrc2cpg") === E.javascript_frontend_version,
      "witness_consistency"
    );
    for (const [tool, expected] of [
      ["java", E.jvm_version],
      ["php", E.php_runtime_version],
      ["python3", E.helper_version],
    ]) {
      check(tool !== undefined && expected !== undefined, "witness_consistency");
      const output = container([tool, "--version"], "probe", null).response;
      check(
        output
          .trim()
          .split("\n")[0]
          ?.match(/\b[0-9]+(?:\.[0-9]+){0,5}(?:[-+][A-Za-z0-9.]+)?\b/)?.[0] === expected,
        "witness_consistency"
      );
    }
    measure();
    const readbacks: ScaP03ConsumedFixtureReadbackV1[] = [];
    for (const language of ["php", "javascript", "typescript"] as const) {
      newGroup();
      const graph = container(
        [
          "joern-parse",
          "--language",
          scaP03FrontendLanguageV1(language),
          "--output",
          "/work/graph.cpg.bin",
          "--max-num-def",
          String(r.max_num_def),
          "/source",
        ],
        "parse",
        "graph.cpg.bin"
      ).readback;
      const inventory = container(
        [
          "joern",
          "--script",
          "/scripts/inventory.sc",
          "--param",
          "cpgFile=/input/graph.cpg.bin",
          "--param",
          "outFile=/work/inventory.tsv",
        ],
        "inventory",
        "inventory.tsv"
      ).readback;
      check(graph !== null && inventory !== null, "witness_consistency");
      readbacks.push({ language, graph, inventory });
    }
    check(
      cursor === observations.length && executionIndex === w.executions.length,
      "witness_consistency"
    );
    return { attempt_witness: w, attempt_witness_bytes: Buffer.from(witnessBytes), readbacks };
  });
}
