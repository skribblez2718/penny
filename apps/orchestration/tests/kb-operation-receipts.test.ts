import { requireValue } from "./helpers/narrowing.js";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  Checkpointer,
  StartAdmissionMismatchError,
  canonicalJson,
  operationSourceIdentitySha256,
  sha256,
} from "../src/checkpointer.js";
import { RunContext } from "../src/context.js";
import { admitOperationStart, completeOperationStart } from "../src/kb/operation-starts.js";
import {
  OperationReceiptError,
  OperationReceiptStore,
  externalOperationSourceIdentity,
  operationEventForResult,
  operationReceiptRoot,
  toReplayableKnowledgeBaseResult,
} from "../src/kb/operation-receipts.js";
import { jcsCanonicalize } from "../src/kb/approval-receipts.js";
import { OperationActionSchema, validateKbContract } from "../src/kb/contracts.js";
import { installTestProjectState } from "./fixtures/penny-state-fixture.js";

const roots: string[] = [];
const SESSION = "session_receipt_1";
const PROFILE = "kbp_receipt";
const KB_ID = "kb_receipt";
const POLICY = "a".repeat(64);

function root(): string {
  const value = path.join(os.tmpdir(), `penny-kb-operation-${randomUUID()}`);
  mkdirSync(value, { recursive: true, mode: 0o700 });
  chmodSync(value, 0o700);
  roots.push(value);
  installTestProjectState(value);
  return value;
}

function context(runId: string, action = "query"): RunContext {
  const run = RunContext.create({
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: SESSION,
      playbook: "knowledge-base",
      engine_owner: "typescript",
    },
    goal: "Synthetic receipt-plane test.",
    constraints: { action, kb_profile_id: PROFILE },
    projectRoot: "/project",
    trustProfile: "hardened-untrusted",
    maxSteps: 8,
  });
  run.playbookData.action = action;
  run.playbookData.profile_id = PROFILE;
  run.playbookData.kb_id = KB_ID;
  run.playbookData.admitted_policy_sha256 = POLICY;
  return run;
}

function admitted(input: {
  projectRoot: string;
  checkpointer: Checkpointer;
  runId: string;
  invocation?: string;
  requestBody?: string;
}) {
  const request = {
    schema_version: 1,
    action: "query",
    kb_profile_id: PROFILE,
    query: input.requestBody ?? "synthetic query",
  };
  const requestSha = sha256(canonicalJson(request));
  const transactionId = `tx_${input.runId}`;
  input.checkpointer.admitStartRun(context(input.runId), {
    session_id: SESSION,
    invocation_id: input.invocation ?? `call_${input.runId}`,
    request_sha256: requestSha,
    action: "query",
    profile_id: PROFILE,
    transaction_id: transactionId,
    private_input_id: `pri_${input.runId}`,
    storage_key: `${input.runId}/request.json`,
    temporary_storage_key: `${input.runId}/.${transactionId}.tmp`,
  });
  const source = externalOperationSourceIdentity({
    session_id: SESSION,
    invocation_id: input.invocation ?? `call_${input.runId}`,
    action: "query",
    request_sha256: requestSha,
  });
  const group = requireValue(
    input.checkpointer.operationEventGroupBySource("external_start", source),
    "apps/orchestration/tests/kb-operation-receipts.test.ts:106"
  );
  return { request, requestSha, source, group };
}

function artifact(kind: string, id = `artifact_${kind}`) {
  return {
    schema_version: 1,
    artifact_id: id,
    artifact_kind: kind,
    sha256: "0".repeat(64),
    media_type: "application/json",
    byte_length: 2,
  };
}

function replay(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    action: "query",
    run_id: runId,
    kb_id: KB_ID,
    status: "complete",
    met: true,
    ids: [runId, "page_receipt"],
    counts: { candidates: 1 },
    artifacts: [artifact("query_answer")],
    evidence: [],
    warnings: [],
    unresolved: [],
    next: "none",
    ...overrides,
  };
}

function commitSelectorEvidence(
  checkpointer: Checkpointer,
  input: { runId: string; transactionId: string; candidate: string }
): string {
  const timestamp = "2026-08-21T00:00:00Z";
  const selectorJcs = canonicalJson({
    schema_version: 1,
    kb_id: KB_ID,
    generation_id: input.candidate,
    catalog_sha256: "b".repeat(64),
    index_sha256: "c".repeat(64),
    published_at: timestamp,
  });
  const selectorSha = sha256(selectorJcs);
  const stagingRoot = `work/${input.runId}/transaction/publication/${input.transactionId}`;
  const files = [
    {
      role: "catalog" as const,
      staging_key: `${stagingRoot}/generation/catalog.json`,
      final_key: `.kb/generations/${input.candidate}/catalog.json`,
    },
    {
      role: "index" as const,
      staging_key: `${stagingRoot}/generation/index.sqlite`,
      final_key: `.kb/generations/${input.candidate}/index.sqlite`,
    },
    {
      role: "manifest" as const,
      staging_key: `${stagingRoot}/immutables/manifest/manifest`,
      final_key: "manifest.json",
    },
    {
      role: "policy" as const,
      staging_key: `${stagingRoot}/immutables/policy/policy`,
      final_key: ".kb/policy.json",
    },
    {
      role: "selector" as const,
      staging_key: `.kb/.current.${input.transactionId}.tmp`,
      final_key: ".kb/current.json",
    },
  ].map((file) => ({
    schema_version: 1 as const,
    publication_file_id: `pubf_${file.role}_${input.transactionId}`,
    transaction_id: input.transactionId,
    ...file,
    state: "planned" as const,
  }));
  checkpointer.planKbPublication(
    {
      schema_version: 1,
      run_id: input.runId,
      transaction_id: input.transactionId,
      kb_profile_id: PROFILE,
      kb_id: KB_ID,
      action: "init",
      base_generation_id: null,
      base_selector_sha256: null,
      candidate_generation_id: input.candidate,
      staging_root: stagingRoot,
      generation_staging_key: `${stagingRoot}/generation`,
      generation_final_key: `.kb/generations/${input.candidate}`,
      lifecycle: "planned",
      files,
      created_at: timestamp,
      updated_at: timestamp,
    },
    {
      schema_version: 1,
      kb_profile_id: PROFILE,
      run_id: input.runId,
      transaction_id: input.transactionId,
      request_sha256: "d".repeat(64),
      profile_commitment_sha256: "e".repeat(64),
      kb_id: KB_ID,
      generation_id: input.candidate,
      state: "reserved",
      updated_at: timestamp,
    }
  );
  checkpointer.storeKbPublicationSelector({
    transaction_id: input.transactionId,
    selector_jcs: selectorJcs,
    selector_sha256: selectorSha,
  });
  for (const file of files) {
    const isSelector = file.role === "selector";
    checkpointer.stageKbPublicationFile({
      transaction_id: input.transactionId,
      publication_file_id: file.publication_file_id,
      sha256: isSelector
        ? selectorSha
        : file.role === "catalog"
          ? "b".repeat(64)
          : file.role === "index"
            ? "c".repeat(64)
            : "a".repeat(64),
      byte_length: isSelector ? Buffer.byteLength(selectorJcs) : 1,
    });
    if (!isSelector) {
      checkpointer.publishKbPublicationFile(input.transactionId, file.publication_file_id);
    }
  }
  for (const [expected, next] of [
    ["planned", "staged"],
    ["staged", "immutables_published"],
    ["immutables_published", "generation_published"],
  ] as const) {
    checkpointer.advanceKbPublication({
      transaction_id: input.transactionId,
      expected: [expected],
      next,
    });
  }
  const selectorFile = requireValue(
    files.find((file) => file.role === "selector"),
    "apps/orchestration/tests/kb-operation-receipts.test.ts:254"
  );
  checkpointer.commitKbPublicationSelector(input.transactionId, selectorFile.publication_file_id);
  checkpointer.advanceKbPublication({
    transaction_id: input.transactionId,
    expected: ["selector_committed"],
    next: "finalizing",
  });
  return selectorSha;
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    try {
      rmSync(value, { recursive: true, force: true });
    } catch {
      // best effort fixture cleanup
    }
  }
});

describe("§5.5 operation group reservation", () => {
  it("atomically creates a non-query start run with its reserved group before work", () => {
    const projectRoot = root();
    const checkpointer = new Checkpointer(path.join(projectRoot, ".penny", "control.db"));
    const run = context("run_promote_start");
    run.playbookData.action = "promote";
    const sourceIdentity = operationSourceIdentitySha256({
      session_id: SESSION,
      invocation_id: "call_promote_start",
      action: "promote",
      request_sha256: "b".repeat(64),
    });
    checkpointer.createRun(
      run,
      "created",
      {},
      {
        run_id: run.identity.run_id,
        session_id: SESSION,
        transaction_id: "tx_promote_start",
        action: "promote",
        source_kind: "external_start",
        source_identity_sha256: sourceIdentity,
      }
    );
    expect(checkpointer.loadRunById(run.identity.run_id)?.stateId).toBe("intake");
    expect(
      checkpointer.operationEventGroupBySource("external_start", sourceIdentity)
    ).toMatchObject({
      run_id: run.identity.run_id,
      event_sequence: 0,
      state: "reserved",
    });
    checkpointer.close();
  });

  it("reserves contiguous per-run sequences from zero and globally deduplicates source identity", () => {
    const projectRoot = root();
    const checkpointer = new Checkpointer(path.join(projectRoot, ".penny", "control.db"));
    const run = context("run_sequence");
    checkpointer.createRun(run, "created", {});
    const store = new OperationReceiptStore({ projectRoot, checkpointer });

    const groups = [0, 1, 2].map(
      (ordinal) =>
        store.reserve({
          run_id: run.identity.run_id,
          session_id: SESSION,
          transaction_id: `tx_sequence_${ordinal}`,
          action: ordinal === 2 ? "resume" : "query",
          source_kind: ordinal === 2 ? "external_resume" : "external_start",
          source_identity_sha256: operationSourceIdentitySha256({ ordinal }),
        }).group
    );
    expect(groups.map((group) => group.event_sequence)).toEqual([0, 1, 2]);

    const duplicate = store.reserve({
      run_id: run.identity.run_id,
      session_id: SESSION,
      transaction_id: "tx_sequence_2",
      action: "resume",
      source_kind: "external_resume",
      source_identity_sha256: operationSourceIdentitySha256({ ordinal: 2 }),
    });
    expect(duplicate.kind).toBe("existing");
    expect(duplicate.group.request_event_group_id).toBe(
      requireValue(groups[2], "apps/orchestration/tests/kb-operation-receipts.test.ts:339")
        .request_event_group_id
    );
    expect(checkpointer.operationEventGroups(run.identity.run_id)).toHaveLength(3);

    // `status` is intentionally outside OperationAction and never reserves a row.
    const malformedAction: unknown = "status";
    expect(() =>
      validateKbContract(OperationActionSchema, malformedAction, "operation action")
    ).toThrow();
    expect(checkpointer.operationEventGroups(run.identity.run_id)).toHaveLength(3);
    checkpointer.close();
  });
});

describe("§5.5 result/event mapping", () => {
  it("rejects malformed result members instead of silently dropping them", () => {
    expect(() =>
      toReplayableKnowledgeBaseResult(
        replay("run_malformed", {
          artifacts: [{ ...artifact("query_answer"), artifact_id: "bad..artifact" }],
        })
      )
    ).toThrow(OperationReceiptError);
    expect(() =>
      toReplayableKnowledgeBaseResult(replay("run_malformed_counts", { counts: { ok: 1, Bad: 2 } }))
    ).toThrow(OperationReceiptError);
  });

  it("implements the closed mapping including selector-backed publication", () => {
    const base = replay("run_map");
    const asResult = (patch: Record<string, unknown>) =>
      toReplayableKnowledgeBaseResult({ ...base, ...patch });

    expect(
      operationEventForResult({
        result: asResult({ status: "awaiting_user", met: false, next: "review" }),
        transaction_id: "tx_map",
      })
    ).toBe("prepared");
    expect(operationEventForResult({ result: asResult({}), transaction_id: "tx_map" })).toBe(
      "completed"
    );
    expect(
      operationEventForResult({
        result: asResult({ action: "save" }),
        transaction_id: "tx_map",
        selector_evidence: {
          transaction_id: "tx_map",
          candidate_generation_id: "generation_map",
          selector_sha256: "d".repeat(64),
        },
      })
    ).toBe("published");
    expect(() =>
      operationEventForResult({
        result: asResult({ action: "save" }),
        transaction_id: "tx_map",
        selector_evidence: {
          transaction_id: "tx_other",
          candidate_generation_id: "generation_map",
          selector_sha256: "d".repeat(64),
        },
      })
    ).toThrow(/selector evidence/);
    expect(
      operationEventForResult({
        result: asResult({ status: "running", met: false, next: "resume" }),
        transaction_id: "tx_map",
      })
    ).toBe("incomplete");
    expect(
      operationEventForResult({
        result: asResult({ status: "exhausted", met: false, next: "none" }),
        transaction_id: "tx_map",
      })
    ).toBe("incomplete");
    expect(
      operationEventForResult({
        result: asResult({ status: "refused", met: false, next: "none" }),
        transaction_id: "tx_map",
      })
    ).toBe("failed");
    expect(
      operationEventForResult({
        result: asResult({ status: "error", met: false, next: "none" }),
        transaction_id: "tx_map",
      })
    ).toBe("failed");
  });
});

describe("§5.5 preindexed receipt filesystem recovery", () => {
  for (const boundary of [
    "after_outcome_preindexed",
    "after_receipt_temp_fsync",
    "after_receipt_staged",
    "after_receipt_rename",
    "after_receipt_parent_fsync",
    "before_receipt_db_publish",
  ]) {
    it(`recovers exactly after ${boundary}`, () => {
      const projectRoot = root();
      const db = path.join(projectRoot, ".penny", "control.db");
      const checkpointer = new Checkpointer(db);
      const prepared = admitted({ projectRoot, checkpointer, runId: `run_${boundary}` });
      let fired = false;
      const store = new OperationReceiptStore({
        projectRoot,
        checkpointer,
        fault: (found) => {
          if (!fired && found === boundary) {
            fired = true;
            throw new Error(`crash:${boundary}`);
          }
        },
      });
      expect(() =>
        store.complete({
          request_event_group_id: prepared.group.request_event_group_id,
          kb_profile_id: PROFILE,
          kb_id: KB_ID,
          result: replay(prepared.group.run_id),
          input_digests: [prepared.requestSha],
          policy_sha256: POLICY,
        })
      ).toThrow(`crash:${boundary}`);

      const mid = requireValue(
        checkpointer.operationEventGroup(prepared.group.request_event_group_id),
        "apps/orchestration/tests/kb-operation-receipts.test.ts:471"
      );
      expect(mid.state === "outcome_preparing" || mid.state === "committed").toBe(true);
      if (boundary === "after_outcome_preindexed") {
        const row = requireValue(
          checkpointer.operationReceipt(
            requireValue(
              mid.receipt_id,
              "apps/orchestration/tests/kb-operation-receipts.test.ts:474"
            )
          ),
          "apps/orchestration/tests/kb-operation-receipts.test.ts:474"
        );
        expect(row.state).toBe("preparing");
        expect(existsSync(operationReceiptRoot(projectRoot))).toBe(true);
      }

      const recovered = new OperationReceiptStore({ projectRoot, checkpointer }).finish(
        prepared.group.request_event_group_id
      );
      expect(recovered.group.state).toBe("committed");
      expect(recovered.receipt.state).toBe("published");
      expect(recovered.replay_result).toEqual(
        toReplayableKnowledgeBaseResult(replay(prepared.group.run_id))
      );
      const final = path.join(
        operationReceiptRoot(projectRoot),
        recovered.receipt.final_storage_key
      );
      expect(readFileSync(final, "utf8")).toBe(recovered.receipt.receipt_jcs);
      expect((lstatMode(final) & 0o7777).toString(8)).toBe("600");
      checkpointer.close();
    });
  }

  it("recreates a missing published file from stored receipt_jcs and blocks mismatched bytes", () => {
    const projectRoot = root();
    const checkpointer = new Checkpointer(path.join(projectRoot, ".penny", "control.db"));
    const prepared = admitted({ projectRoot, checkpointer, runId: "run_missing" });
    const store = new OperationReceiptStore({ projectRoot, checkpointer });
    const committed = store.complete({
      request_event_group_id: prepared.group.request_event_group_id,
      kb_profile_id: PROFILE,
      kb_id: KB_ID,
      result: replay(prepared.group.run_id),
      input_digests: [prepared.requestSha],
      policy_sha256: POLICY,
    });
    const final = path.join(operationReceiptRoot(projectRoot), committed.receipt.final_storage_key);
    unlinkSync(final);
    expect(store.finish(prepared.group.request_event_group_id).receipt.state).toBe("published");
    expect(readFileSync(final, "utf8")).toBe(committed.receipt.receipt_jcs);

    writeFileSync(final, "{}", { mode: 0o600 });
    chmodSync(final, 0o600);
    expect(() => store.finish(prepared.group.request_event_group_id)).toThrow(
      OperationReceiptError
    );
    checkpointer.close();
  });
});

describe("external init/ingest/save/lint start integrations", () => {
  const cases = [
    {
      action: "init" as const,
      request: (sentinel: string) => ({
        schema_version: 1,
        action: "init",
        kb_profile_id: PROFILE,
        create: true,
        title: sentinel,
      }),
      result: (runId: string) => replay(runId, { action: "init", artifacts: [] }),
      event: "published",
    },
    {
      action: "ingest" as const,
      request: () => ({
        schema_version: 1,
        action: "ingest",
        kb_profile_id: PROFILE,
        source_capability_ids: ["cap_receipt"],
      }),
      result: (runId: string) =>
        replay(runId, {
          action: "ingest",
          status: "awaiting_user",
          met: false,
          next: "review",
          artifacts: [
            artifact("page_draft"),
            artifact("lint_report"),
            artifact("verification_report"),
          ],
        }),
      event: "prepared",
    },
    {
      action: "save" as const,
      request: (sentinel: string) => ({
        schema_version: 1,
        action: "save",
        kb_profile_id: PROFILE,
        query_run_id: "run_query_receipt",
        page_kind: "synthesis",
        title: sentinel,
      }),
      result: (runId: string) =>
        replay(runId, {
          action: "save",
          status: "awaiting_user",
          met: false,
          next: "review",
          artifacts: [
            artifact("page_draft"),
            artifact("lint_report"),
            artifact("verification_report"),
          ],
        }),
      event: "prepared",
    },
    {
      action: "lint" as const,
      request: () => ({
        schema_version: 1,
        action: "lint",
        kb_profile_id: PROFILE,
        mode: "deterministic",
      }),
      result: (runId: string) =>
        replay(runId, { action: "lint", artifacts: [artifact("lint_report")] }),
      event: "completed",
    },
  ];

  for (const specification of cases) {
    it(`${specification.action} reserves before work and replays one exact outcome`, () => {
      const projectRoot = root();
      const checkpointer = new Checkpointer(path.join(projectRoot, ".penny", "control.db"));
      const sentinel = `PRIVATE_${specification.action.toUpperCase()}_BODY_SENTINEL`;
      const runId = `run_${specification.action}_start`;
      const run = context(runId, specification.action);
      const request = specification.request(sentinel);
      const admittedStart = admitOperationStart({
        projectRoot,
        checkpointer,
        context: run,
        session_id: SESSION,
        invocation_id: `call_${specification.action}`,
        action: specification.action,
        profile_id: PROFILE,
        request,
      });
      expect(admittedStart.group).toMatchObject({
        run_id: runId,
        event_sequence: 0,
        state: "reserved",
      });
      expect(checkpointer.getPrivateInput(runId)?.state).toBe("active");

      const candidate = `gen_${specification.action}_receipt`;
      const selectorSha =
        specification.action === "init"
          ? commitSelectorEvidence(checkpointer, {
              runId,
              transactionId: admittedStart.transaction_id,
              candidate,
            })
          : undefined;
      const completion = completeOperationStart({
        projectRoot,
        checkpointer,
        group_id: admittedStart.group.request_event_group_id,
        profile_id: PROFILE,
        result: specification.result(runId),
        input_digests: [admittedStart.request_sha256],
        kb_id: KB_ID,
        policy_sha256: POLICY,
        ...(specification.action === "init"
          ? {
              candidate_generation_id: candidate,
              selector_evidence: {
                transaction_id: admittedStart.transaction_id,
                candidate_generation_id: candidate,
                selector_sha256: requireValue(
                  selectorSha,
                  "apps/orchestration/tests/kb-operation-receipts.test.ts:647"
                ),
              },
            }
          : {}),
      });
      expect(completion.receipt).toMatchObject({
        action: specification.action,
        event: specification.event,
        event_sequence: 0,
        state: "published",
      });
      expect(completion.receipt.receipt_jcs).not.toContain(sentinel);
      expect(completion.group.replay_result_jcs).not.toContain(sentinel);

      const duplicateContext = context(
        `run_duplicate_${specification.action}`,
        specification.action
      );
      const duplicate = admitOperationStart({
        projectRoot,
        checkpointer,
        context: duplicateContext,
        session_id: SESSION,
        invocation_id: `call_${specification.action}`,
        action: specification.action,
        profile_id: PROFILE,
        request,
      });
      expect(duplicate.replay?.receipt.receipt_id).toBe(completion.receipt.receipt_id);
      expect(duplicate.replay?.replay_result).toEqual(completion.replay_result);
      expect(checkpointer.operationEventGroups(runId)).toHaveLength(1);
      checkpointer.close();
    });
  }

  it("refuses a mutated same-invocation body without a second group", () => {
    const projectRoot = root();
    const checkpointer = new Checkpointer(path.join(projectRoot, ".penny", "control.db"));
    const first = context("run_idempotent_lint", "lint");
    admitOperationStart({
      projectRoot,
      checkpointer,
      context: first,
      session_id: SESSION,
      invocation_id: "call_same_lint",
      action: "lint",
      profile_id: PROFILE,
      request: { schema_version: 1, action: "lint", kb_profile_id: PROFILE, mode: "deterministic" },
    });
    const changed = context("run_changed_lint", "lint");
    expect(() =>
      admitOperationStart({
        projectRoot,
        checkpointer,
        context: changed,
        session_id: SESSION,
        invocation_id: "call_same_lint",
        action: "lint",
        profile_id: PROFILE,
        request: {
          schema_version: 1,
          action: "lint",
          kb_profile_id: PROFILE,
          mode: "deterministic_and_semantic",
        },
      })
    ).toThrow(StartAdmissionMismatchError);
    expect(checkpointer.operationEventGroups(first.identity.run_id)).toHaveLength(1);
    checkpointer.close();
  });

  it("recovers a start outcome crash by indexed bytes and keeps later resume sequences contiguous", () => {
    const projectRoot = root();
    const checkpointer = new Checkpointer(path.join(projectRoot, ".penny", "control.db"));
    const run = context("run_integrated_crash", "lint");
    const request = {
      schema_version: 1,
      action: "lint",
      kb_profile_id: PROFILE,
      mode: "deterministic",
    };
    const start = admitOperationStart({
      projectRoot,
      checkpointer,
      context: run,
      session_id: SESSION,
      invocation_id: "call_integrated_crash",
      action: "lint",
      profile_id: PROFILE,
      request,
    });
    expect(() =>
      new OperationReceiptStore({
        projectRoot,
        checkpointer,
        fault: (boundary) => {
          if (boundary === "after_outcome_preindexed") throw new Error("crash:start_outcome");
        },
      }).complete({
        request_event_group_id: start.group.request_event_group_id,
        kb_profile_id: PROFILE,
        result: replay(run.identity.run_id, {
          action: "lint",
          artifacts: [artifact("lint_report")],
        }),
        input_digests: [start.request_sha256],
        kb_id: KB_ID,
        policy_sha256: POLICY,
      })
    ).toThrow("crash:start_outcome");

    const retry = admitOperationStart({
      projectRoot,
      checkpointer,
      context: context("run_retry_crash", "lint"),
      session_id: SESSION,
      invocation_id: "call_integrated_crash",
      action: "lint",
      profile_id: PROFILE,
      request,
    });
    expect(retry.replay?.receipt).toMatchObject({ event_sequence: 0, event: "completed" });
    const store = new OperationReceiptStore({ projectRoot, checkpointer });
    const resumeOne = store.reserve({
      run_id: run.identity.run_id,
      session_id: SESSION,
      transaction_id: "tx_resume_one",
      action: "resume",
      source_kind: "external_resume",
      source_identity_sha256: operationSourceIdentitySha256({ resume: 1 }),
    }).group;
    const resumeTwo = store.reserve({
      run_id: run.identity.run_id,
      session_id: SESSION,
      transaction_id: "tx_resume_two",
      action: "resume",
      source_kind: "external_resume",
      source_identity_sha256: operationSourceIdentitySha256({ resume: 2 }),
    }).group;
    expect([resumeOne.event_sequence, resumeTwo.event_sequence]).toEqual([1, 2]);
    checkpointer.close();
  });
});

describe("§5.6 exact replay and body containment", () => {
  it("returns the stored replay on duplicate, never duplicates, and never persists derived/private bodies", () => {
    const projectRoot = root();
    const checkpointer = new Checkpointer(path.join(projectRoot, ".penny", "control.db"));
    const sentinel = "PRIVATE-BODY-SENTINEL-7f02c9";
    const prepared = admitted({
      projectRoot,
      checkpointer,
      runId: "run_replay",
      requestBody: sentinel,
    });
    const store = new OperationReceiptStore({ projectRoot, checkpointer });
    const first = store.complete({
      request_event_group_id: prepared.group.request_event_group_id,
      kb_profile_id: PROFILE,
      kb_id: KB_ID,
      result: {
        ...replay(prepared.group.run_id),
        derived_answer: {
          authority: "advisory",
          text: sentinel,
          citations: [{ kind: "page", page_id: "page_receipt", revision_id: "revision_1" }],
          contradictions: [],
          unknowns: [],
          canonical_verification_required: true,
        },
      },
      input_digests: [prepared.requestSha],
      policy_sha256: POLICY,
    });
    const duplicate = store.complete({
      request_event_group_id: prepared.group.request_event_group_id,
      kb_profile_id: PROFILE,
      kb_id: KB_ID,
      result: replay(prepared.group.run_id, {
        counts: { candidates: 999 },
        warnings: ["later_projection_must_not_win"],
      }),
      input_digests: [prepared.requestSha],
      policy_sha256: POLICY,
    });

    expect(duplicate.group.request_event_group_id).toBe(first.group.request_event_group_id);
    expect(duplicate.receipt.receipt_id).toBe(first.receipt.receipt_id);
    expect(duplicate.replay_result).toEqual(first.replay_result);
    expect(duplicate.replay_result).not.toHaveProperty("derived_answer");
    expect(checkpointer.operationEventGroups(prepared.group.run_id)).toHaveLength(1);
    expect(checkpointer.operationReceipts(prepared.group.run_id)).toHaveLength(1);
    expect(checkpointer.terminalResult(prepared.group.run_id)?.result).toEqual(first.replay_result);
    expect(checkpointer.lastOperationReceiptId(prepared.group.run_id)).toBe(
      first.receipt.receipt_id
    );

    const receiptFile = path.join(
      operationReceiptRoot(projectRoot),
      first.receipt.final_storage_key
    );
    expect((lstatMode(operationReceiptRoot(projectRoot)) & 0o7777).toString(8)).toBe("700");
    expect(
      (
        lstatMode(path.join(operationReceiptRoot(projectRoot), PROFILE, prepared.group.run_id)) &
        0o7777
      ).toString(8)
    ).toBe("700");
    expect(readFileSync(receiptFile, "utf8")).toBe(
      jcsCanonicalize(JSON.parse(first.receipt.receipt_jcs))
    );
    expect(readFileSync(receiptFile, "utf8")).not.toContain(sentinel);
    expect(first.receipt.receipt_jcs).not.toContain(sentinel);
    expect(first.group.replay_result_jcs).not.toContain(sentinel);
    expect(canonicalJson(checkpointer.terminalResult(prepared.group.run_id))).not.toContain(
      sentinel
    );
    checkpointer.close();
  });
});

function lstatMode(file: string): number {
  return lstatSync(file).mode;
}
