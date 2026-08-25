import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArtifactStore, initializePennyState } from "@penny/orchestration/source";
import { afterEach, describe, expect, it } from "vitest";

import {
  collectCurrentSessionArtifactRefs,
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

function persistFixture(store: ArtifactStore, runId: string, operationId: string, content: string) {
  return store.persist({
    metadata: {
      schema_version: 2,
      run_id: runId,
      phase: "agent-output-0001",
      branch_id: null,
      kind: "agent-output",
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
        role: "toolResult",
        toolName: "subagent",
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
