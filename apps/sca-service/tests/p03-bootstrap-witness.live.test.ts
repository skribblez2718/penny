import { describe, expect, it } from "vitest";
import { sha256, canonicalJson } from "../../orchestration/dist/canonical-json.js";
import { validateScaP03AttemptWitnessV1 } from "../../orchestration/dist/sca/p03-bootstrap-contracts.js";
import { createScaP03DockerJoernCandidateV1 } from "../src/p03-docker-runtime.js";
import { ScaP03HostWitnessSinkV1 } from "../src/p03-bootstrap-witness.js";

// Opt in deliberately on a controlled Docker host with fully pinned caller-supplied inputs.
// Never run in the default non-live gate.
const enabled = process.env.PENNY_P03_LIVE_WITNESS === "1";
const required = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`missing live test input ${key}`);
  return value;
};
describe("controlled live host witness", () => {
  it.skipIf(!enabled)(
    "captures measured construction and exact cleanup, without issuing attestation",
    async () => {
      const config = {
        docker_executable: required("P03_DOCKER_EXECUTABLE"),
        image_ref: required("P03_IMAGE_REF"),
        expected_joern_version: required("P03_JOERN_VERSION"),
        expected_docker_executable_sha256: required("P03_DOCKER_SHA256"),
        expected_docker_client_version: required("P03_DOCKER_CLIENT_VERSION"),
        expected_docker_server_version: required("P03_DOCKER_SERVER_VERSION"),
        runtime_id: required("P03_RUNTIME_ID"),
        isolation_id: required("P03_ISOLATION_ID"),
        isolation_profile_sha256: required("P03_PROFILE_SHA256"),
        implementation_identity_sha256: required("P03_IMPLEMENTATION_SHA256"),
        deployment_identity_sha256: required("P03_DEPLOYMENT_SHA256"),
        staging_parent: required("P03_STAGING_PARENT"),
        memory_bytes: Number(required("P03_MEMORY_BYTES")),
        cpus: Number(required("P03_CPUS")),
        pids: Number(required("P03_PIDS")),
        max_workspace_bytes: Number(required("P03_WORKSPACE_BYTES")),
        max_num_def: Number(required("P03_MAX_NUM_DEF")),
        max_command_output_bytes: Number(required("P03_COMMAND_BYTES")),
        timeout_ms: Number(required("P03_TIMEOUT_MS")),
      };
      const imageId = required("P03_IMAGE_ID");
      if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) {
        throw new Error("P03_IMAGE_ID must be Docker's measured sha256 configuration ID");
      }
      const sink = new ScaP03HostWitnessSinkV1({
        run_id: required("P03_RUN_ID"),
        candidate_sha256: sha256(canonicalJson(config)),
        identity: {
          runtime_id: config.runtime_id,
          isolation_id: config.isolation_id,
          implementation_sha256: config.implementation_identity_sha256,
          runtime_package_sha256: required("P03_PACKAGE_CLOSURE_SHA256"),
          deployment_sha256: config.deployment_identity_sha256,
          docker_executable_sha256: config.expected_docker_executable_sha256,
          docker_client_version: config.expected_docker_client_version,
          docker_server_version: config.expected_docker_server_version,
          image_id: imageId,
          joern_version: config.expected_joern_version,
        },
      });
      await createScaP03DockerJoernCandidateV1(config, undefined, sink);
      const witness = validateScaP03AttemptWitnessV1(sink.finalize("completed"));
      expect(witness.executions.length).toBeGreaterThan(0);
      expect(witness.executions.every((entry) => entry.absence_observed)).toBe(true);
    },
    300_000
  );
});
