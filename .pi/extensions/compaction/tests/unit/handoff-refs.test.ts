import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArtifactStore, initializePennyState } from "@penny/orchestration";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectCurrentSessionArtifactRefs,
  collectExplicitRunIds,
  createResumeRefSet,
  persistHandoffIndex,
} from "../../index.js";
import type { SessionMessage } from "../../pi-messages.js";
import {
  parseJson,
  requireArray,
  requireRecord,
  requireString,
} from "../../../../lib/tests/test-narrowers.js";

const roots: string[] = [];
const savedStateRoot = process.env.PENNY_STATE_ROOT;
const savedArtifactRoot = process.env.PENNY_ARTIFACT_ROOT;
afterEach(() => {
  if (savedStateRoot === undefined) delete process.env.PENNY_STATE_ROOT;
  else process.env.PENNY_STATE_ROOT = savedStateRoot;
  if (savedArtifactRoot === undefined) delete process.env.PENNY_ARTIFACT_ROOT;
  else process.env.PENNY_ARTIFACT_ROOT = savedArtifactRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storeFixture() {
  const root = mkdtempSync(join(tmpdir(), "penny-compaction-handoff-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot, { mode: 0o700 });
  process.env.PENNY_STATE_ROOT = join(root, "state");
  delete process.env.PENNY_ARTIFACT_ROOT;
  const state = initializePennyState(projectRoot, { env: process.env });
  const store = new ArtifactStore(state.paths.artifacts.root, { projectId: state.projectId });
  return { projectRoot, state, store };
}

function persistFixture(
  store: ArtifactStore,
  runId: string,
  operationId: string,
  content: string,
  kind = "agent-output"
) {
  return store.persist({
    metadata: {
      schema_version: 2,
      run_id: runId,
      phase: "agent-output-0001",
      branch_id: null,
      kind,
      operation_id: operationId,
      version: 1,
      producer: "agent:annie",
      media_type: "text/plain",
      parent_ref: null,
      upstream_refs: [],
    },
    content,
  });
}

describe("current-session handoff refs", () => {
  it("collects only completed result metadata and explicitly passed IDs", () => {
    const item = storeFixture();
    using store = item.store;
    const produced = persistFixture(store, "run-produced", "operation-produced", "produced");
    const explicit = persistFixture(store, "run-explicit", "operation-explicit", "explicit");
    persistFixture(store, "old-global-run", "operation-unreferenced", "must not appear");
    const messages: SessionMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "subagent-produced",
            name: "subagent",
            arguments: { agent: "annie", task: "produce" },
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "subagent",
        toolCallId: "subagent-produced",
        details: {
          mode: "single",
          outputArtifactRefs: [produced],
          finalOutputArtifactRef: produced,
          results: [{ agent: "annie", outputArtifactRef: produced }],
        },
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "subagent-explicit",
            name: "subagent",
            arguments: {
              agent: "synthia",
              task: "integrate",
              input_artifacts: [explicit.artifact_id],
            },
          },
        ],
      },
    ];
    expect(
      collectCurrentSessionArtifactRefs(messages, item.projectRoot).map((ref) => ref.artifact_id)
    ).toEqual([produced.artifact_id, explicit.artifact_id]);
  });

  it("retains current success/diagnostic refs through nested aggregates without changing saved history bytes", () => {
    const item = storeFixture();
    using store = item.store;
    const output = persistFixture(store, "run-current", "current-output", "current output");
    const partial = persistFixture(store, "run-current", "current-partial", "best partial");
    const sealDiagnostic = persistFixture(
      store,
      "run-current",
      "seal-diagnostic",
      "{}",
      "seal-diagnostic"
    );
    const assurance = store.persist({
      metadata: {
        schema_version: 2,
        run_id: "run-current",
        phase: "admission",
        branch_id: null,
        kind: "composition-assurance",
        operation_id: "input-assurance",
        version: 1,
        producer: "host:plan",
        media_type: "application/json",
        parent_ref: null,
        upstream_refs: [],
      },
      content: "{}",
    });
    const oldBytes = '{"state":"report","success":true,"retired_history":true}';
    const history = persistFixture(store, "saved-history", "history-bytes", oldBytes);
    const base = {
      session_id: "session-current",
      skill_name: "plan",
      requires_approval: false,
      steps_total: 257,
      agents_invoked: Array.from({ length: 257 }, () => "echo"),
      errors: [],
    };
    const success = {
      ...base,
      success: true,
      state: "complete",
      result: { met: true, output_artifact_ref: output },
      output_artifact_ref: output,
      input_assurance: {
        mode: "not_applicable",
        specification_artifact_id: null,
        assurance_ref: assurance,
      },
    };
    const negative = {
      ...base,
      success: false,
      state: "incomplete",
      result: { met: false },
      output_artifact_ref: partial,
      best_partial_artifact_refs: [partial],
      repair_diagnostics: {
        origin_state: "reviewing",
        feedback_kind: "evidence_gap",
        budget: { used: 1, limit: null },
        feedback_report_refs: [],
      },
      seal_diagnostics: {
        latest_diagnostic_ref: sealDiagnostic,
        rejected_draft_ref: partial,
        epoch_anchor_ref: null,
        corrections_used: 1,
        correction_limit: 1,
        disposition: "exhausted",
      },
    };
    const exchange = (id: string, details: unknown): SessionMessage[] => [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id,
            name: "skill",
            arguments: { skill_name: "plan", goal: "current contract" },
          },
        ],
      },
      { role: "toolResult", toolName: "skill", toolCallId: id, details },
    ];
    const messages = [
      ...exchange("current", success),
      ...exchange("nested", {
        ...base,
        success: false,
        state: "partial",
        skill_name: "parallel",
        mode: "parallel",
        parallel_results: [
          {
            ...base,
            success: false,
            state: "failed",
            skill_name: "chain",
            mode: "chain",
            chain_results: [negative],
          },
        ],
      }),
      ...exchange("unknown-history", { ...success, unknown: true, output_artifact_ref: history }),
    ];
    expect(collectExplicitRunIds(messages)).toEqual(["run-current"]);
    expect(
      collectCurrentSessionArtifactRefs(messages, item.projectRoot).map((ref) => ref.artifact_id)
    ).toEqual([output.artifact_id, partial.artifact_id]);
    // Result adapter retirement does not touch the independent exact artifact reader.
    expect(store.readById(history.artifact_id).toString("utf8")).toBe(oldBytes);
    expect(store.readById(output.artifact_id).toString("utf8")).toBe("current output");
    const malformedTree = exchange("bad-child", {
      ...success,
      parallel_results: [{ ...negative, unexpected: true }],
    });
    expect(collectCurrentSessionArtifactRefs(malformedTree, item.projectRoot)).toEqual([]);
    const ambiguous = [...exchange("duplicate", success), ...exchange("duplicate", negative)];
    expect(collectCurrentSessionArtifactRefs(ambiguous, item.projectRoot)).toEqual([]);
    expect(collectExplicitRunIds(ambiguous)).toEqual([]);
  });

  it("materializes one readable handoff-index artifact for a large exact set", () => {
    const item = storeFixture();
    const first = persistFixture(item.store, "run-a", "operation-a", "alpha");
    const second = persistFixture(item.store, "run-b", "operation-b", "beta");
    item.store.close();
    const resumeRefs = createResumeRefSet([], [first, second]);
    const index = persistHandoffIndex({
      sessionId: "session-current",
      compactionSeq: 3,
      projectRoot: item.projectRoot,
      resumeRefs,
      artifactRefs: [first, second],
    });
    using reopened = new ArtifactStore(item.state.paths.artifacts.root, {
      projectId: item.state.projectId,
    });
    const body = requireRecord(
      parseJson(reopened.readById(index.artifact_id).toString("utf8")),
      "handoff index body"
    );
    const artifactIds = requireArray(body.records).map((record) =>
      requireString(requireRecord(record, "handoff record").artifact_id, "handoff artifact ID")
    );
    expect(index.kind).toBe("handoff-index");
    expect(artifactIds).toEqual([first.artifact_id, second.artifact_id]);
  });
});
