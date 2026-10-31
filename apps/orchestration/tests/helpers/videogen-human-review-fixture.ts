import { writeFileSync } from "node:fs";
import path from "node:path";
import { RunContext } from "../../dist/context.js";
import { initializeVideogenOwnerSelection } from "../../dist/videogen/owner-selection.js";
import { saveExecution } from "../../dist/videogen/execution-state.js";
import { JsonValueSchema, validateContract } from "../../dist/contracts.js";
import { FoundationFixture, FOUNDATION_LIMITS } from "./videogen-foundation-fixtures.js";
import { editFixture, packageFixture } from "./videogen-edit-fixtures.js";
import type { HumanReviewService } from "../../dist/videogen/human-review.js";
/** Synthetic, deliberately unplayable fixture. NOT human approval, native qualification or media. */
export function humanReviewFixture(f: FoundationFixture) {
  const edit = editFixture(f),
    pkg = packageFixture(f, edit);
  const master = edit.video,
    project = pkg.project;
  const manifest = f.json(
    {
      ...pkg.manifest,
      accepted_master: {
        ...pkg.manifest.accepted_master,
        sha256: master.content_digest,
        bytes: master.byte_length,
      },
      native_project: {
        ...pkg.manifest.native_project,
        sha256: project.content_digest,
        bytes: project.byte_length,
      },
      files: pkg.manifest.files
        .filter((x) => x.role !== "master" && x.role !== "project")
        .concat([
          {
            relative_path: pkg.manifest.accepted_master.relative_path,
            role: "master",
            producer_ref: master,
            sha256: master.content_digest,
            bytes: master.byte_length,
            media_type: master.media_type,
            used_by: [],
          },
          {
            relative_path: pkg.manifest.native_project.relative_path,
            role: "project",
            producer_ref: project,
            sha256: project.content_digest,
            bytes: project.byte_length,
            media_type: project.media_type,
            used_by: [],
          },
        ]),
    },
    "penny.videogen-portable-package.v1"
  );
  const proof = f.opaque("synthetic native proof; no editor was run");
  const native = f.json(
    {
      schema_id: "penny.videogen-native-build-result.v1",
      schema_version: 1,
      project_ref: project,
      normalized_project_ref: project,
      roundtrip_edit_ref: edit.edit_ref,
      dependency_refs: [],
      open_save_receipt_ref: proof,
      reopen_receipt_ref: proof,
      relocation_receipt_ref: proof,
      render_comparison_ref: proof,
      diagnostics: ["synthetic only"],
      status: "qualified",
    },
    "penny.videogen-native-build-result.v1"
  );
  const packet = f.json(
    {
      schema_id: "penny.videogen-gate-packet.v1",
      schema_version: 1,
      run_id: f.run_id,
      kind: "clarification",
      gate_id: "clarify",
      challenge: "fixture-challenge",
      producer_state: "finish_prepare",
      presented: [{ role: "target", ref: master, revision: 1 }],
      prior_decisions: [],
      change_summary: "synthetic review wait",
      affected_shot_ids: [],
      limitations: ["not production"],
      rights_refs: [],
      review_evidence_refs: [],
      questions: ["review"],
      choices: ["answer", "cancel"],
    },
    "penny.videogen-gate-packet.v1"
  );
  const c = RunContext.create({
    identity: {
      schema_version: 2,
      run_id: f.run_id,
      session_id: f.run_id,
      playbook: "videogen",
      engine_owner: "typescript",
    },
    goal: "synthetic review delivery",
    constraints: {},
    projectRoot: f.root,
    trustProfile: "hardened-untrusted",
    maxSteps: 100,
  });
  initializeVideogenOwnerSelection(c, {
    project_id: f.project_id,
    limits: FOUNDATION_LIMITS,
    admitted_destination_id: "fixture",
    territory: "test",
  });
  const owner = c.playbookData.videogen_owner_selection;
  if (owner === null || typeof owner !== "object" || Array.isArray(owner))
    throw new Error("fixture owner missing");
  owner.presented = [
    { role: "target", ref: validateContract(JsonValueSchema, master, "fixture ref"), revision: 1 },
  ];
  saveExecution(c, {
    schema_version: 1,
    config_digest: "a".repeat(64),
    slots: [
      { slot: "master", ref: master },
      { slot: "manifest", ref: manifest },
      { slot: "native", ref: native },
      { slot: "packet", ref: packet },
    ],
    shot_ids: [],
    shot_index: 0,
    asset_index: 0,
    effect_index: 0,
    effects: [],
    return_state: "master_critique",
  });
  c.selectedArtifacts = [master, manifest, native, packet, project];
  c.stateId = "clarify";
  c.status = "awaiting_user";
  c.pendingDirective = {
    schema_version: 2,
    action: "await_user",
    identity: c.identity,
    state_id: c.stateId,
    gate_id: "fixture-playback",
    challenge: "fixture-challenge",
    payload_digest: packet.content_digest,
    questions: [{ id: "review", prompt: "Synthetic review wait" }],
  };
  f.checkpointer.createRun(c, "fixture_created", {});
  const file = path.join(f.root, "master.mp4");
  writeFileSync(file, f.store.read(master), { mode: 0o600 });
  const device = f.opaque("synthetic device profile; no actual playback", "text/plain");
  const service: HumanReviewService = {
    artifacts: f.store,
    checkpointer: f.checkpointer,
    config: { projectId: f.project_id },
  };
  return { service, master, manifest, native, packet, project, device, file };
}
