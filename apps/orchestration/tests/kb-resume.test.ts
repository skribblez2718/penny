import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Checkpointer, canonicalJson, sha256 } from "../src/checkpointer.js";
import { RunContext } from "../src/context.js";
import { kbWorkerClientOptionsFromRun } from "../src/kb/kb-worker-client.js";
import { SaveQueryClaimStore, saveClaimStoreDir } from "../src/kb/save-claim.js";
import { initKb, admitKbRun } from "../src/kb/workflows.js";
import { materializeRunInput } from "../src/private-inputs.js";
import { KnowledgeBasePlaybook } from "../src/playbooks/knowledge-base.js";
import { readPolicy, writePolicy } from "../src/kb/filesystem.js";
import {
  KbRunAccessError,
  requireKbCurrentParent,
  requireKbRunAccess,
  requireKbRunIdentityCurrent,
  requireKbRunPolicyCurrent,
} from "../src/kb/run-access.js";
import { PolicyRefusal } from "../src/kb/policy.js";

const PROFILE = "kbp_resume";
const SESSION = "sess_resume";
const PARENT = { provider: "ollama", model: "qwen3.8:latest" };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "penny-kb-resume-"));
  roots.push(projectRoot);
  const kbRoot = path.join(projectRoot, "kb");
  initKb({ kbRoot, profileId: PROFILE, runId: "init_resume" }, "Resume KB");
  const policy = readPolicy(kbRoot);
  writePolicy(kbRoot, {
    ...policy,
    processing_mode: "local_only",
    allowed_parent_models: [{ ...PARENT, locality: "local" }],
    allowed_child_models: [{ ...PARENT, locality: "local" }],
  });
  const admitted = admitKbRun({ kbRoot, parentIdentity: PARENT });
  const run = RunContext.create({
    identity: {
      schema_version: 2,
      run_id: "run_resume",
      session_id: SESSION,
      playbook: "knowledge-base",
      engine_owner: "typescript",
    },
    goal: "resume safely",
    constraints: { action: "ingest", kb_profile_id: PROFILE },
    projectRoot,
    trustProfile: "hardened-untrusted",
    maxSteps: 8,
  });
  run.playbookData.profile_id = PROFILE;
  run.playbookData.admitted_policy_sha256 = admitted.policy_sha256;
  run.playbookData.kb_id = admitted.kb_id;
  return { kbRoot, run };
}

type ResumableAction = "ingest" | "query" | "save" | "promote";

function crashRestartPosture(action: ResumableAction) {
  const projectRoot = mkdtempSync(path.join(tmpdir(), `penny-kb-${action}-restart-`));
  roots.push(projectRoot);
  const kbRoot = path.join(projectRoot, "private-kb");
  const dbPath = path.join(projectRoot, "orchestration.db");
  mkdirSync(path.join(projectRoot, ".penny"), { mode: 0o700 });
  const runId = `run_${action}_restart`;
  const phase =
    action === "query"
      ? "query"
      : action === "save"
        ? "compose"
        : action === "promote"
          ? "plan"
          : "ingest";
  const request =
    action === "query"
      ? {
          schema_version: 1,
          action,
          kb_profile_id: PROFILE,
          query: "private restart query",
        }
      : action === "save"
        ? {
            schema_version: 1,
            action,
            kb_profile_id: PROFILE,
            query_run_id: "run_query_claimed",
            page_kind: "synthesis",
            title: "Private saved title",
          }
        : action === "promote"
          ? {
              schema_version: 1,
              action,
              kb_profile_id: PROFILE,
              page_revisions: [{ page_id: "page_restart", revision_id: "rev_restart" }],
              canonical_target_capability_ids: ["cap_target_restart"],
            }
          : {
              schema_version: 1,
              action,
              kb_profile_id: PROFILE,
              source_capability_ids: ["cap_source_restart"],
            };
  const constraints = {
    action,
    kb_profile_id: PROFILE,
    ...(action === "ingest" ? { source_capability_ids: ["cap_source_restart"] } : {}),
    ...(action === "save" ? { query_run_id: "run_query_claimed", page_kind: "synthesis" } : {}),
    ...(action === "promote"
      ? {
          page_revisions: [{ page_id: "page_restart", revision_id: "rev_restart" }],
          canonical_target_capability_ids: ["cap_target_restart"],
        }
      : {}),
    parent_identity: PARENT,
  };
  const run = RunContext.create({
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: SESSION,
      playbook: "knowledge-base",
      engine_owner: "typescript",
    },
    goal: `recover ${action}`,
    constraints,
    projectRoot,
    trustProfile: "hardened-untrusted",
    maxSteps: 8,
  });
  run.playbookData.action = action;
  run.playbookData.profile_id = PROFILE;
  run.playbookData.kb_id = "kb_restart";
  run.playbookData.admitted_policy_sha256 = "a".repeat(64);
  if (action === "ingest") {
    run.playbookData.source_capability_ids = ["cap_source_restart"];
    run.playbookData.source_ids = ["src_source_restart"];
  }
  if (action === "save") {
    run.playbookData.query_run_id = "run_query_claimed";
    run.playbookData.answer_artifact_id = "art_answer_restart";
  }
  if (action === "promote") {
    run.playbookData.page_revisions = [{ page_id: "page_restart", revision_id: "rev_restart" }];
    run.playbookData.target_capability_ids = ["cap_target_restart"];
  }
  run.transition(phase);
  new KnowledgeBasePlaybook().dispatch(run);

  const requestSha256 = sha256(canonicalJson(request));
  const checkpointer = new Checkpointer(dbPath);
  checkpointer.admitStartRun(run, {
    session_id: SESSION,
    invocation_id: `call_${action}_restart`,
    request_sha256: requestSha256,
    action,
    profile_id: PROFILE,
    transaction_id: `tx_${action}_restart`,
    private_input_id: `pri_${action}_restart`,
    storage_key: `${runId}/request.json`,
    temporary_storage_key: `${runId}/.tx_${action}_restart.tmp`,
  });
  materializeRunInput({ projectRoot, checkpointer, runId, request, requestSha256 });
  checkpointer.close();

  if (action === "save") {
    const claims = new SaveQueryClaimStore(saveClaimStoreDir(projectRoot, PROFILE));
    claims.create({
      query_run_id: "run_query_claimed",
      kb_profile_id: PROFILE,
      kb_id: "kb_restart",
      answer_artifact_id: "art_answer_restart",
      answer_sha256: "b".repeat(64),
    });
    claims.claimForSave({
      query_run_id: "run_query_claimed",
      kb_profile_id: PROFILE,
      save_run_id: runId,
      save_transaction_id: "tx_save_claimed",
      answer_sha256: "b".repeat(64),
    });
  }

  const reopened = new Checkpointer(dbPath);
  reopened.bindKbRuntimeProjectRoot(projectRoot);
  const restored = reopened.loadRunById(runId);
  if (restored === undefined) throw new Error("restart fixture lost its durable run");
  const options = kbWorkerClientOptionsFromRun({
    projectRoot,
    kbRoot,
    checkpointer: reopened,
    run: restored,
  });
  return { options, reopened };
}

describe("KB crash/restart worker posture reconstruction", () => {
  it("restores the ingest source-capability posture", () => {
    const { options, reopened } = crashRestartPosture("ingest");
    try {
      expect(options.operation).toBe("ingest");
      expect(options.sourceIds).toEqual(["src_source_restart"]);
      expect(options.sourceCapabilityIds).toBeUndefined();
      expect(options.queryReader).toBeUndefined();
      expect(options.evidenceReader).toBeUndefined();
      expect(options.promotionReader).toBeUndefined();
    } finally {
      reopened.close();
    }
  });

  it("restores the query private-input reader posture", () => {
    const { options, reopened } = crashRestartPosture("query");
    try {
      expect(options.operation).toBe("query");
      expect(JSON.parse(options.queryReader!.readRequest())).toMatchObject({
        action: "query",
        query: "private restart query",
      });
      expect(options.sourceIds).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it("restores the save claim, phase brief, prior answer, and evidence-reader posture", () => {
    const { options, reopened } = crashRestartPosture("save");
    try {
      expect(options.operation).toBe("save");
      expect(JSON.parse(options.readPhaseBrief!())).toMatchObject({
        action: "save",
        title: "Private saved title",
      });
      expect(options.seedPhaseOutputs).toEqual({
        ingest: { runId: "run_query_claimed", artifactId: "art_answer_restart" },
      });
      expect(options.evidenceReader?.readSelectedPage).toBeTypeOf("function");
      expect(options.evidenceReader?.readSelectedSource).toBeTypeOf("function");
    } finally {
      reopened.close();
    }
  });

  it("restores the promotion page/target reader posture without apply authority", () => {
    const { options, reopened } = crashRestartPosture("promote");
    try {
      expect(options.operation).toBe("promote");
      expect(JSON.parse(options.promotionReader!.readPhaseBrief())).toEqual({
        schema_version: 1,
        action: "promote",
        page_revisions: [{ page_id: "page_restart", revision_id: "rev_restart" }],
        target_capability_ids: ["cap_target_restart"],
      });
      expect(options.sourceIds).toEqual([]);
    } finally {
      reopened.close();
    }
  });
});

describe("KB exact status/resume authority", () => {
  it("admits only the exact run, active session, playbook, and profile", () => {
    const { run } = fixture();
    expect(
      requireKbRunAccess(run, { runId: "run_resume", sessionId: SESSION, profileId: PROFILE })
    ).toBe(run);
    for (const expected of [
      { runId: "run_other", sessionId: SESSION, profileId: PROFILE },
      { runId: "run_resume", sessionId: "sess_other", profileId: PROFILE },
      { runId: "run_resume", sessionId: SESSION, profileId: "kbp_other" },
    ]) {
      expect(() => requireKbRunAccess(run, expected)).toThrow(KbRunAccessError);
    }
  });

  it("refuses registry remapping to a different KB identity", () => {
    const { kbRoot, run } = fixture();
    expect(() => requireKbRunIdentityCurrent(run, kbRoot)).not.toThrow();
    run.playbookData.kb_id = "kb_other";
    expect(() => requireKbRunIdentityCurrent(run, kbRoot)).toThrow(KbRunAccessError);
  });

  it("refuses a nonterminal continuation after policy drift", () => {
    const { kbRoot, run } = fixture();
    expect(() => requireKbRunPolicyCurrent(run, kbRoot)).not.toThrow();
    const policy = readPolicy(kbRoot);
    writePolicy(kbRoot, {
      ...policy,
      reader_limits: { ...policy.reader_limits, max_calls_per_phase: 15 },
    });
    expect(() => requireKbRunPolicyCurrent(run, kbRoot)).toThrow(PolicyRefusal);
  });

  it("requires the current parent allowlist even for terminal artifact replay", () => {
    const { kbRoot } = fixture();
    expect(() => requireKbCurrentParent(kbRoot, PARENT)).not.toThrow();
    expect(() => requireKbCurrentParent(kbRoot, undefined)).toThrow(PolicyRefusal);
    expect(() => requireKbCurrentParent(kbRoot, { provider: "remote", model: "other" })).toThrow(
      PolicyRefusal
    );
  });

  it("permits terminal status replay under a newly valid current policy", () => {
    const { kbRoot, run } = fixture();
    run.status = "complete";
    run.met = true;
    const policy = readPolicy(kbRoot);
    writePolicy(kbRoot, {
      ...policy,
      reader_limits: { ...policy.reader_limits, max_calls_per_phase: 15 },
    });
    expect(() => requireKbRunPolicyCurrent(run, kbRoot)).not.toThrow();
  });
});
