import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "../../orchestration/dist/canonical-json.js";
import {
  SCA_P03_CLEANUP_EVIDENCE_V2_SCHEMA,
  SCA_P03_REVIEW_RECEIPT_V2_SCHEMA,
  validateScaP03AttemptWitnessV1,
  validateScaP03CleanupEvidenceV2,
  validateScaP03ExternalReviewReceiptV2,
} from "../../orchestration/dist/sca/p03-bootstrap-contracts.js";
import { censusScaP03WorkspaceV1 } from "../src/p03-bootstrap-host.js";
import { ScaP03HostWitnessSinkV1 } from "../src/p03-bootstrap-witness.js";

const digest = sha256("sample");
const ref = {
  schema_version: 2,
  artifact_id: `art_${digest}`,
  run_id: "run",
  phase: "SCA-P03",
  branch_id: null,
  kind: "evidence",
  operation_id: "op",
  version: 1,
  producer: "host:verifier",
  media_type: "application/json",
  byte_length: 4,
  content_digest: digest,
  store_ref: `artifact://sha256/${digest}`,
};
const seal = (value: Record<string, unknown>, key: string) =>
  Buffer.from(canonicalJson({ ...value, [key]: sha256(canonicalJson(value)) }));
const identity = {
  runtime_id: "runtime",
  isolation_id: "isolated",
  implementation_sha256: digest,
  runtime_package_sha256: digest,
  deployment_sha256: digest,
  docker_executable_sha256: digest,
  docker_client_version: "1.0.0",
  docker_server_version: "1.0.0",
  image_id: `sha256:${digest}`,
  joern_version: "1.0.0",
};

describe("P03 host witness and closed evidence", () => {
  it("records only digests, refuses completed lost-create and accepts a fully cleaned attempt", () => {
    const sink = new ScaP03HostWitnessSinkV1({ run_id: "run", candidate_sha256: digest, identity });
    const name = "penny-p03-00000000-0000-4000-8000-000000000001";
    sink.startWorkspace("/private/secret/path");
    sink.create(name, ["container", "create", "/private/secret/path"]);
    sink.finishWorkspace(true);
    expect(() => sink.finalize("completed")).toThrow("p03_witness_incomplete");
    sink.removal(name, true);
    const failed = sink.finalize("failed");
    expect(validateScaP03AttemptWitnessV1(failed).executions[0]?.disposition).toBe(
      "create_reply_lost"
    );
    expect(Buffer.from(failed).toString()).not.toContain("/private/secret/path");
    const valid = new ScaP03HostWitnessSinkV1({
      run_id: "run",
      candidate_sha256: digest,
      identity,
    });
    valid.startWorkspace("/private/other");
    valid.create(name, ["container", "create"]);
    valid.id(name, digest);
    valid.inspect(name, '{"measured":true}', '{"measured":true}');
    valid.startContainer(name);
    valid.command(name, ["exec"], true);
    valid.readback(name, Buffer.from("result"));
    valid.response(name, "ok");
    valid.removal(name, true);
    valid.finishWorkspace(true);
    expect(validateScaP03AttemptWitnessV1(valid.finalize("completed")).disposition).toBe(
      "completed"
    );
    const incomplete = new ScaP03HostWitnessSinkV1({
      run_id: "run",
      candidate_sha256: digest,
      identity,
    });
    incomplete.startWorkspace("workspace");
    incomplete.create(name, ["container", "create"]);
    incomplete.id(name, digest);
    incomplete.inspect(name, "{}", "{}");
    incomplete.startContainer(name);
    incomplete.command(name, ["exec"], true);
    incomplete.response(name, "ok");
    incomplete.removal(name, true);
    incomplete.finishWorkspace(true);
    expect(() => incomplete.finalize("completed")).toThrow("p03_witness_incomplete");
    expect(validateScaP03AttemptWitnessV1(incomplete.finalize("failed")).disposition).toBe(
      "failed"
    );
    const ambiguous = new ScaP03HostWitnessSinkV1({
      run_id: "run",
      candidate_sha256: digest,
      identity,
    });
    ambiguous.startWorkspace("workspace");
    ambiguous.create(name, ["container", "create"]);
    ambiguous.finishWorkspace(false);
    expect(validateScaP03AttemptWitnessV1(ambiguous.finalize("cancelled")).workspace_absent).toBe(
      false
    );
  });

  it("rejects incomplete census, role collision, noncanonical and oversized bytes", () => {
    const cleanup = {
      schema_id: SCA_P03_CLEANUP_EVIDENCE_V2_SCHEMA,
      schema_version: 2,
      attempt_ref: ref,
      record_input_sha256: digest,
      verifier_id: "verifier",
      observed_at: "2026-09-28T10:00:00.000Z",
      containers: [
        { name: "penny-p03-00000000-0000-4000-8000-000000000001", id: null, absent: true },
      ],
      workspace_absent_or_empty: true,
      complete_census: false,
      decision: "PASS",
    };
    expect(() => validateScaP03CleanupEvidenceV2(seal(cleanup, "evidence_sha256"))).toThrow(
      "p03_cleanup_incomplete"
    );
    expect(() =>
      validateScaP03CleanupEvidenceV2(
        Buffer.concat([seal(cleanup, "evidence_sha256"), Buffer.from(" ")])
      )
    ).toThrow("p03_evidence_noncanonical");
    expect(() => validateScaP03CleanupEvidenceV2(Buffer.alloc(1024 * 1024 + 1))).toThrow(
      "p03_evidence_size_invalid"
    );
    const review = {
      schema_id: SCA_P03_REVIEW_RECEIPT_V2_SCHEMA,
      schema_version: 2,
      external_review_id: "external",
      external_review_ref: ref,
      record_ref: ref,
      attempt_ref: ref,
      cleanup_ref: ref,
      isolation_ref: ref,
      reviewer_id: "same",
      evaluator_id: "same",
      attester_id: "attester",
      reviewer_authority_id: "authority",
      reviewed_at: "2026-09-28T10:00:00.000Z",
      decision: "PASS",
    };
    expect(() => validateScaP03ExternalReviewReceiptV2(seal(review, "receipt_sha256"))).toThrow(
      "p03_review_role_collision"
    );
  });

  it("refuses symlink, occupied and missing-parent workspaces", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "p03-workspace-census-"));
    try {
      await expect(censusScaP03WorkspaceV1([path.join(root, "absent")])).resolves.toBeUndefined();
      await writeFile(path.join(root, "occupied"), "data");
      await expect(censusScaP03WorkspaceV1([path.join(root, "occupied")])).rejects.toThrow();
      await symlink(path.join(root, "absent"), path.join(root, "link"));
      await expect(censusScaP03WorkspaceV1([path.join(root, "link")])).rejects.toThrow();
      await expect(
        censusScaP03WorkspaceV1([path.join(root, "missing", "child")])
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
