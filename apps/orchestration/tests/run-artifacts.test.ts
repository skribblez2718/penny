/** Exact §5.7 artifact content-plane boundary tests. */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Checkpointer } from "../src/checkpointer.js";
import { RunContext } from "../src/context.js";
import { canonicalJson, sha256Hex } from "../src/kb/contracts.js";
import { materializeRunInput } from "../src/private-inputs.js";
import {
  ArtifactStoreError,
  RunArtifactSimulatedCrash,
  RunArtifactStore,
  type ArtifactHandle,
  type ArtifactIndexRecord,
  type RunArtifactFaultBoundary,
  type RunArtifactStoreTestOptions,
} from "../src/kb/run-artifacts.js";

const dirs: string[] = [];
const controls = new Map<string, Checkpointer>();
function tmpRoot(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "penny-kb-art-"));
  dirs.push(directory);
  return directory;
}
function control(root: string): Checkpointer {
  let checkpointer = controls.get(root);
  if (checkpointer === undefined) {
    checkpointer = new Checkpointer(path.join(root, "control.db"));
    controls.set(root, checkpointer);
  }
  return checkpointer;
}
function artifactStore(
  root: string,
  runId: string,
  options: RunArtifactStoreTestOptions = {}
): RunArtifactStore {
  const checkpointer = control(root);
  if (!checkpointer.runExists(runId)) {
    const context = RunContext.create({
      identity: {
        schema_version: 2,
        run_id: runId,
        session_id: `session_${runId}`,
        playbook: "knowledge-base",
        engine_owner: "typescript",
      },
      goal: "Test KB artifact custody.",
      constraints: { action: "ingest", kb_profile_id: "kbp_demo" },
      projectRoot: root,
      trustProfile: "hardened-untrusted",
      maxSteps: 8,
    });
    context.playbookData.action = "ingest";
    context.playbookData.profile_id = "kbp_demo";
    context.playbookData.admitted_policy_sha256 = "a".repeat(64);
    const request = {
      schema_version: 1,
      action: "ingest",
      kb_profile_id: "kbp_demo",
      source_capability_ids: ["source_capability_1"],
    } as const;
    const requestSha256 = sha256Hex(canonicalJson(request));
    checkpointer.admitStartRun(context, {
      session_id: `session_${runId}`,
      invocation_id: `invocation_${runId}`,
      request_sha256: requestSha256,
      action: "ingest",
      profile_id: "kbp_demo",
      transaction_id: `transaction_${runId}`,
      private_input_id: `private_${runId}`,
      storage_key: `${runId}/request.json`,
      temporary_storage_key: `${runId}/.transaction_${runId}.tmp`,
    });
    mkdirSync(path.join(root, ".penny"), { recursive: true, mode: 0o700 });
    materializeRunInput({
      projectRoot: root,
      checkpointer,
      runId,
      request,
      requestSha256,
    });
  }
  return new RunArtifactStore(root, runId, checkpointer, options);
}
afterEach(() => {
  for (const checkpointer of controls.values()) checkpointer.close();
  controls.clear();
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const CLAIMS = {
  schema_version: 1,
  artifact_kind: "claims",
  source_ids: ["src_01"],
  claims: [
    {
      provisional_id: "clm_01",
      text: "Test claim",
      kind: "fact",
      confidence: "CERTAIN",
      evidence: [{ source_id: "src_01" }],
    },
  ],
} as const;
const CONTENT = JSON.stringify(CLAIMS);
const CANONICAL_CONTENT = canonicalJson(CLAIMS);

function stageClaims(
  store: RunArtifactStore,
  input: { state?: string; profile?: string } = {}
): ArtifactHandle {
  return store.stage({
    state_id: input.state ?? "ingest",
    kb_profile_id: input.profile ?? "kbp_demo",
    artifact_kind: "claims",
    content: CONTENT,
  });
}

function bindOperands(
  root: string,
  store: RunArtifactStore,
  runId: string,
  stateId: string,
  allowedPriorArtifacts: readonly {
    run_id: string;
    state_id: string;
    handle: ArtifactHandle;
  }[] = []
) {
  const privateInputSha256 = control(root).getPrivateInput(runId)?.request_sha256;
  if (privateInputSha256 === undefined) throw new Error("test private input is absent");
  return store.bindPhaseOperands({
    schema_version: 1,
    run_id: runId,
    state_id: stateId,
    session_id: `session_${runId}`,
    kb_profile_id: "kbp_demo",
    operation: "ingest",
    agent: stateId === "ingest" ? "echo" : "carren",
    expected_artifact_kind: stateId === "ingest" ? "claims" : "lint_report",
    expected_media_type: "application/json",
    source_ids: ["src_01"],
    prior_state_ids: allowedPriorArtifacts.map((artifact) => artifact.state_id),
    allowed_prior_artifacts: allowedPriorArtifacts,
    allowed_selected_pages: [],
    private_input_sha256: privateInputSha256,
    admitted_policy_sha256: "a".repeat(64),
  });
}

function stageToolClaims(
  store: RunArtifactStore,
  overrides: Partial<Parameters<RunArtifactStore["stageFromTool"]>[0]> = {}
): ArtifactHandle {
  return store.stageFromTool({
    state_id: "ingest",
    kb_profile_id: "kbp_demo",
    producer: "echo",
    expected_producer: "echo",
    expected_kind: "claims",
    expected_media_type: "application/json",
    max_bytes: 1_048_576,
    max_artifacts: 1,
    tool_input: {
      schema_version: 1,
      artifact_kind: "claims",
      media_type: "application/json",
      encoding: "utf8",
      content: CONTENT,
    },
    ...overrides,
  });
}

const PAGE_DRAFT = {
  schema_version: 1,
  artifact_kind: "page_draft",
  pages: [
    {
      frontmatter: {
        schema_version: 1,
        page_id: "page_01",
        revision_id: "rev_01",
        kind: "synthesis",
        title: "Page",
        summary: "Summary",
        authority: "advisory",
        lifecycle: "draft",
        created_at: "2026-08-20T00:00:00Z",
        derived_from: [],
        related_page_ids: [],
      },
      markdown:
        "## Synthesis\nOne.\n## Evidence\nTwo.\n## Tensions and unknowns\nThree.\n## Related\nFour.",
      claims: {
        schema_version: 1,
        page_id: "page_01",
        revision_id: "rev_01",
        claims: [],
      },
    },
  ],
} as const;

describe("KB §5.7 artifact content plane", () => {
  it("canonicalizes valid JSON to JCS and returns a path-free handle", () => {
    const root = tmpRoot();
    using store = artifactStore(root, "run_001");
    const handle = stageClaims(store);
    const read = store.read(handle.artifact_id);

    expect(read.content).toBe(CANONICAL_CONTENT);
    expect(handle.sha256).toBe(sha256Hex(CANONICAL_CONTENT));
    expect(handle.byte_length).toBe(Buffer.byteLength(CANONICAL_CONTENT, "utf8"));
    expect(handle.artifact_id).toMatch(/^art_[a-f0-9]{32}$/);
    expect(handle.artifact_kind).toBe("claims");
    expect(handle.media_type).toBe("application/json");
    expect(JSON.stringify(handle)).not.toContain(root);
    expect(JSON.stringify(handle)).not.toContain("/work/");
    expect(JSON.stringify(handle)).not.toContain("path");
  });

  it("preindexes exact ownership before bytes and writes artifact bytes mode 0600", () => {
    const root = tmpRoot();
    let preparedBeforeBytes = false;
    using store = artifactStore(root, "run_001", {
      testOnlyBeforeArtifactWrite: (record) => {
        preparedBeforeBytes = record.lifecycle === "prepared";
        expect(record.temporary_storage_key).toBeDefined();
        expect(existsSync(path.join(root, "work", "run_001", record.storage_key))).toBe(false);
        expect(existsSync(path.join(root, "work", "run_001", record.temporary_storage_key!))).toBe(
          false
        );
      },
    });
    const handle = stageClaims(store);
    expect(preparedBeforeBytes).toBe(true);
    const record = store.getIndexRecord(handle.artifact_id);
    expect(record).toMatchObject({
      run_id: "run_001",
      state_id: "ingest",
      kb_profile_id: "kbp_demo",
      artifact_kind: "claims",
      lifecycle: "staged",
    });
    expect(record.temporary_storage_key).toBeUndefined();
    const artifactFile = path.join(root, "work", "run_001", record.storage_key);
    expect(statSync(artifactFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.dirname(artifactFile))).toContain(handle.artifact_id);
  });

  it("seals a typed result atomically, then permits host consumption", () => {
    const root = tmpRoot();
    using store = artifactStore(root, "run_001");
    const handle = stageToolClaims(store);
    bindOperands(root, store, "run_001", "ingest");
    store.sealWithPhaseResult({
      state_id: "ingest",
      kb_profile_id: "kbp_demo",
      result: {
        schema_version: 1,
        result_kind: "ingest_extraction",
        claims_artifact: handle,
      },
      handles: [handle],
    });
    expect(store.getIndexRecord(handle.artifact_id).lifecycle).toBe("sealed");
    store.consume([handle.artifact_id]);
    expect(store.getIndexRecord(handle.artifact_id).lifecycle).toBe("consumed");
    expect(store.read(handle.artifact_id).content).toBe(CANONICAL_CONTENT);
  });

  it("requires durable private-input-bound operands before every child termination", () => {
    const root = tmpRoot();
    using store = artifactStore(root, "run_operand_required");
    const handle = stageToolClaims(store);
    expect(() =>
      store.sealWithPhaseResult({
        state_id: "ingest",
        kb_profile_id: "kbp_demo",
        result: { schema_version: 1, claims_artifact: handle },
        handles: [handle],
      })
    ).toThrow(/phase_result_rejected/);
    expect(store.getIndexRecord(handle.artifact_id).lifecycle).toBe("staged");
    const operands = bindOperands(root, store, "run_operand_required", "ingest");
    expect(() =>
      store.bindPhaseOperands({ ...operands, private_input_sha256: "f".repeat(64) })
    ).toThrow(/private-input binding/);
  });

  it("rejects duplicate JSON members at any payload depth", () => {
    const root = tmpRoot();
    using store = artifactStore(root, "run_001");
    const duplicate =
      '{"schema_version":1,"artifact_kind":"claims","source_ids":["src_01"],"claims":[{"provisional_id":"clm_01","provisional_id":"clm_02","text":"x","kind":"fact","confidence":"CERTAIN","evidence":[]}]}';
    expect(() =>
      stageToolClaims(store, {
        tool_input: {
          schema_version: 1,
          artifact_kind: "claims",
          media_type: "application/json",
          encoding: "utf8",
          content: duplicate,
        },
      })
    ).toThrow(ArtifactStoreError);
  });

  it("rejects unknown/path-shaped payload and outer tool keys", () => {
    const root = tmpRoot();
    using store = artifactStore(root, "run_001");
    expect(() =>
      stageToolClaims(store, {
        tool_input: {
          schema_version: 1,
          artifact_kind: "claims",
          media_type: "application/json",
          encoding: "utf8",
          content: JSON.stringify({ ...CLAIMS, path: "/private/leak" }),
        },
      })
    ).toThrow(ArtifactStoreError);
    expect(() =>
      stageToolClaims(store, {
        tool_input: {
          schema_version: 1,
          artifact_kind: "claims",
          media_type: "application/json",
          encoding: "utf8",
          content: CONTENT,
          path: "/model/chosen",
        },
      })
    ).toThrow(ArtifactStoreError);
  });

  it("enforces producer, kind, media, byte, and per-phase count", () => {
    const root = tmpRoot();
    using producerStore = artifactStore(root, "run_producer");
    expect(() => stageToolClaims(producerStore, { producer: "synthia" })).toThrow(
      ArtifactStoreError
    );

    using kindStore = artifactStore(root, "run_kind");
    expect(() =>
      stageToolClaims(kindStore, {
        tool_input: {
          schema_version: 1,
          artifact_kind: "page_draft",
          media_type: "application/json",
          encoding: "utf8",
          content: JSON.stringify(PAGE_DRAFT),
        },
      })
    ).toThrow(ArtifactStoreError);

    using mediaStore = artifactStore(root, "run_media");
    expect(() =>
      stageToolClaims(mediaStore, {
        tool_input: {
          schema_version: 1,
          artifact_kind: "claims",
          media_type: "text/plain",
          encoding: "utf8",
          content: CONTENT,
        },
      })
    ).toThrow(ArtifactStoreError);

    using sizeStore = artifactStore(root, "run_size");
    expect(() => stageToolClaims(sizeStore, { max_bytes: 10 })).toThrow(ArtifactStoreError);

    using countStore = artifactStore(root, "run_count");
    const first = stageToolClaims(countStore);
    const recoveredDuplicate = stageToolClaims(countStore);
    expect(recoveredDuplicate).toEqual(first);
    expect(control(root).kbArtifacts({ run_id: "run_count", state_id: "ingest" })).toHaveLength(1);
  });

  it("rejects cross-state, cross-run, altered-handle, and raw-body phase results", () => {
    const root = tmpRoot();
    using first = artifactStore(root, "run_first");
    const handle = stageToolClaims(first);
    expect(() =>
      first.sealWithPhaseResult({
        state_id: "compose",
        kb_profile_id: "kbp_demo",
        result: { schema_version: 1, page_revision_artifact: handle },
        handles: [handle],
      })
    ).toThrow(ArtifactStoreError);

    using second = artifactStore(root, "run_second");
    expect(() =>
      second.sealWithPhaseResult({
        state_id: "ingest",
        kb_profile_id: "kbp_demo",
        result: { schema_version: 1, claims_artifact: handle },
        handles: [handle],
      })
    ).toThrow(ArtifactStoreError);

    expect(() =>
      first.sealWithPhaseResult({
        state_id: "ingest",
        kb_profile_id: "kbp_demo",
        result: { schema_version: 1, claims_artifact: { ...handle, sha256: sha256Hex("wrong") } },
        handles: [{ ...handle, sha256: sha256Hex("wrong") }],
      })
    ).toThrow(ArtifactStoreError);

    expect(() =>
      first.sealWithPhaseResult({
        state_id: "ingest",
        kb_profile_id: "kbp_demo",
        result: { schema_version: 1, body: "PRIVATE RAW BODY", claims_artifact: handle },
        handles: [handle],
      })
    ).toThrow(ArtifactStoreError);
  });

  it("rejects hash changes on reopen", () => {
    const root = tmpRoot();
    using store = artifactStore(root, "run_001");
    const handle = stageClaims(store);
    const record = store.getIndexRecord(handle.artifact_id);
    writeFileSync(path.join(root, "work", "run_001", record.storage_key), "{}", { mode: 0o600 });
    expect(() => store.read(handle.artifact_id)).toThrow(ArtifactStoreError);
  });

  it("lists only the requested state/lifecycle", () => {
    const root = tmpRoot();
    using store = artifactStore(root, "run_001");
    stageClaims(store, { state: "ingest" });
    store.stage({
      state_id: "compose",
      kb_profile_id: "kbp_demo",
      artifact_kind: "page_draft",
      content: JSON.stringify(PAGE_DRAFT),
    });
    expect(store.listByState("ingest")).toHaveLength(1);
    expect(store.listByState("compose")[0]?.artifact_kind).toBe("page_draft");
    expect(store.listByState("compose", "sealed")).toEqual([]);
  });

  const stageFaultBoundaries: readonly RunArtifactFaultBoundary[] = [
    "before_prepared_index",
    "after_prepared_index",
    "before_temp_write",
    "after_temp_write",
    "before_temp_fsync",
    "after_temp_fsync",
    "before_rename",
    "after_rename",
    "before_directory_fsync",
    "after_directory_fsync",
    "before_stage_cas",
    "after_stage_cas",
  ];

  for (const boundary of stageFaultBoundaries) {
    it(`recovers deterministically after the ${boundary} boundary`, () => {
      const root = tmpRoot();
      let fired = false;
      const crashing = artifactStore(root, `run_${boundary}`, {
        testOnlyFault: (current) => {
          if (!fired && current === boundary) {
            fired = true;
            throw new RunArtifactSimulatedCrash(current);
          }
        },
      });
      expect(() => stageClaims(crashing)).toThrow(RunArtifactSimulatedCrash);
      crashing.close();
      expect(fired).toBe(true);

      using recovered = artifactStore(root, `run_${boundary}`);
      const handle = stageClaims(recovered);
      expect(recovered.read(handle.artifact_id).content).toBe(CANONICAL_CONTENT);
      const rows = control(root).kbArtifacts({
        run_id: `run_${boundary}`,
        state_id: "ingest",
      });
      expect(rows.filter((row) => row.lifecycle === "staged")).toHaveLength(1);
      expect(rows.filter((row) => row.lifecycle === "prepared")).toHaveLength(0);
      expect(rows.filter((row) => row.lifecycle === "discarding")).toHaveLength(0);
    });
  }

  const cleanupFaultBoundaries: readonly RunArtifactFaultBoundary[] = [
    "before_discarding_cas",
    "after_discarding_cas",
    "before_cleanup",
    "after_cleanup",
    "before_cleanup_fsync",
    "after_cleanup_fsync",
    "before_discarded_cas",
    "after_discarded_cas",
  ];

  for (const boundary of cleanupFaultBoundaries) {
    it(`resumes exact cleanup after the ${boundary} boundary`, () => {
      const root = tmpRoot();
      const runId = `cleanup_${boundary}`;
      const stranded = artifactStore(root, runId, {
        testOnlyFault: (current) => {
          if (current === "after_prepared_index") {
            throw new RunArtifactSimulatedCrash(current);
          }
        },
      });
      expect(() => stageClaims(stranded)).toThrow(RunArtifactSimulatedCrash);
      stranded.close();

      let fired = false;
      expect(() =>
        artifactStore(root, runId, {
          testOnlyFault: (current) => {
            if (!fired && current === boundary) {
              fired = true;
              throw new RunArtifactSimulatedCrash(current);
            }
          },
        })
      ).toThrow(RunArtifactSimulatedCrash);
      expect(fired).toBe(true);

      using recovered = artifactStore(root, runId);
      expect(
        control(root)
          .kbArtifacts({ run_id: runId })
          .filter((row) => row.lifecycle === "discarded")
      ).toHaveLength(1);
      const replacement = stageClaims(recovered);
      expect(recovered.getIndexRecord(replacement.artifact_id).lifecycle).toBe("staged");
      expect(
        control(root)
          .kbArtifacts({ run_id: runId })
          .filter((row) => row.lifecycle === "staged")
      ).toHaveLength(1);
    });
  }

  for (const boundary of ["before_seal", "after_seal"] as const) {
    it(`keeps seal + one body-free phase result atomic at ${boundary}`, () => {
      const root = tmpRoot();
      const runId = `seal_${boundary}`;
      let fired = false;
      const crashing = artifactStore(root, runId, {
        testOnlyFault: (current) => {
          if (!fired && current === boundary) {
            fired = true;
            throw new RunArtifactSimulatedCrash(current);
          }
        },
      });
      const handle = stageToolClaims(crashing);
      bindOperands(root, crashing, runId, "ingest");
      const result = {
        schema_version: 1,
        run_id: runId,
        state_id: "ingest",
        agent: "echo",
        result_kind: "ingest_extraction",
        verdict: "pass",
        confidence: "CERTAIN",
        evidence: [],
        warnings: [],
        unresolved: [],
        source_ids: ["src_01"],
        claim_count: 1,
        claims_artifact: handle,
      };
      expect(() =>
        crashing.sealWithPhaseResult({
          state_id: "ingest",
          kb_profile_id: "kbp_demo",
          result,
          handles: [handle],
        })
      ).toThrow(RunArtifactSimulatedCrash);
      crashing.close();

      using recovered = artifactStore(root, runId);
      if (boundary === "before_seal") {
        expect(recovered.getIndexRecord(handle.artifact_id).lifecycle).toBe("staged");
        recovered.sealWithPhaseResult({
          state_id: "ingest",
          kb_profile_id: "kbp_demo",
          result,
          handles: [handle],
        });
      }
      expect(recovered.getIndexRecord(handle.artifact_id).lifecycle).toBe("sealed");
      expect(recovered.phaseResult("ingest")?.result_jcs).toBe(canonicalJson(result));
      expect(control(root).kbPhaseResult(runId, "ingest")?.artifact_ids).toEqual([
        handle.artifact_id,
      ]);
    });
  }

  it("rejects and discards a mismatched prepared temp without consuming the phase limit", () => {
    const root = tmpRoot();
    const runId = "run_bad_prepared_temp";
    let record: ArtifactIndexRecord | undefined;
    const crashing = artifactStore(root, runId, {
      testOnlyFault: (boundary, prepared) => {
        if (boundary === "after_temp_write") {
          record = prepared;
          throw new RunArtifactSimulatedCrash(boundary);
        }
      },
    });
    expect(() => stageClaims(crashing)).toThrow(RunArtifactSimulatedCrash);
    crashing.close();
    const prepared = record!;
    writeFileSync(path.join(root, "work", runId, prepared.temporary_storage_key!), "{}", {
      mode: 0o600,
    });
    expect(() => artifactStore(root, runId)).toThrow(/hash_mismatch/);
    expect(control(root).kbArtifact(prepared.artifact_id)?.lifecycle).toBe("discarded");
    using retry = artifactStore(root, runId);
    const handle = stageClaims(retry);
    expect(retry.getIndexRecord(handle.artifact_id).lifecycle).toBe("staged");
  });

  it("never follows a prepared temp symlink and removes only the indexed link", () => {
    const root = tmpRoot();
    const runId = "run_symlink_temp";
    let record: ArtifactIndexRecord | undefined;
    const crashing = artifactStore(root, runId, {
      testOnlyFault: (boundary, prepared) => {
        if (boundary === "after_prepared_index") {
          record = prepared;
          throw new RunArtifactSimulatedCrash(boundary);
        }
      },
    });
    expect(() => stageClaims(crashing)).toThrow(RunArtifactSimulatedCrash);
    crashing.close();
    const prepared = record!;
    const decoy = path.join(root, "decoy.json");
    writeFileSync(decoy, CANONICAL_CONTENT, { mode: 0o600 });
    const temp = path.join(root, "work", runId, prepared.temporary_storage_key!);
    symlinkSync(decoy, temp);
    expect(() => artifactStore(root, runId)).toThrow(/artifact_file_unreadable/);
    expect(readFileSync(decoy, "utf8")).toBe(CANONICAL_CONTENT);
    expect(existsSync(temp)).toBe(false);
    expect(control(root).kbArtifact(prepared.artifact_id)?.lifecycle).toBe("discarded");
  });

  it("persists exact body-free phase operands and allowed prior handles across restart", () => {
    const root = tmpRoot();
    const runId = "run_operands";
    const first = artifactStore(root, runId);
    const handle = stageToolClaims(first);
    bindOperands(root, first, runId, "ingest");
    first.sealWithPhaseResult({
      state_id: "ingest",
      kb_profile_id: "kbp_demo",
      result: {
        schema_version: 1,
        run_id: runId,
        state_id: "ingest",
        agent: "echo",
        result_kind: "ingest_extraction",
        claims_artifact: handle,
      },
      handles: [handle],
    });
    const operands = first.bindPhaseOperands({
      schema_version: 1,
      run_id: runId,
      state_id: "lint",
      session_id: `session_${runId}`,
      kb_profile_id: "kbp_demo",
      operation: "ingest",
      agent: "carren",
      expected_artifact_kind: "lint_report",
      expected_media_type: "application/json",
      source_ids: ["src_01"],
      prior_state_ids: ["ingest"],
      allowed_prior_artifacts: [{ run_id: runId, state_id: "ingest", handle }],
      allowed_selected_pages: [],
      private_input_sha256: control(root).getPrivateInput(runId)!.request_sha256,
      admitted_policy_sha256: "a".repeat(64),
    });
    first.close();
    control(root).close();
    controls.delete(root);

    const reopenedControl = new Checkpointer(path.join(root, "control.db"));
    reopenedControl.bindKbRuntimeProjectRoot(root);
    controls.set(root, reopenedControl);
    using reopened = new RunArtifactStore(root, runId, reopenedControl);
    expect(reopened.phaseOperands("lint")).toEqual(operands);
    expect(
      reopened.read(handle.artifact_id, {
        expected_state_id: "ingest",
        expected_handle: handle,
        required_lifecycle: "sealed",
      }).content
    ).toBe(CANONICAL_CONTENT);
    expect(() =>
      reopened.bindPhaseOperands({
        ...operands,
        allowed_prior_artifacts: [
          {
            run_id: runId,
            state_id: "ingest",
            handle: { ...handle, sha256: sha256Hex("changed") },
          },
        ],
      })
    ).toThrow(/phase_operands_changed/);
  });

  it("closes phase operands atomically with the body-free terminating result", () => {
    const root = tmpRoot();
    const runId = "run_operand_lifecycle";
    const store = artifactStore(root, runId);
    const prior = stageToolClaims(store);
    bindOperands(root, store, runId, "ingest");
    store.sealWithPhaseResult({
      state_id: "ingest",
      kb_profile_id: "kbp_demo",
      result: {
        schema_version: 1,
        run_id: runId,
        state_id: "ingest",
        agent: "echo",
        result_kind: "ingest_extraction",
        claims_artifact: prior,
      },
      handles: [prior],
    });
    const operands = store.bindPhaseOperands({
      schema_version: 1,
      run_id: runId,
      state_id: "lint",
      session_id: `session_${runId}`,
      kb_profile_id: "kbp_demo",
      operation: "ingest",
      agent: "carren",
      expected_artifact_kind: "lint_report",
      expected_media_type: "application/json",
      source_ids: ["src_01"],
      prior_state_ids: ["ingest"],
      allowed_prior_artifacts: [{ run_id: runId, state_id: "ingest", handle: prior }],
      allowed_selected_pages: [],
      private_input_sha256: control(root).getPrivateInput(runId)!.request_sha256,
      admitted_policy_sha256: "a".repeat(64),
    });
    expect(store.phaseOperandsRecord("lint")).toMatchObject({
      schema_version: 1,
      lifecycle: "open",
      operands: {
        ...operands,
        private_input_sha256: control(root).getPrivateInput(runId)!.request_sha256,
        allowed_selected_pages: [],
      },
      created_at: expect.stringMatching(/Z$/),
    });
    const report = store.stage({
      state_id: "lint",
      kb_profile_id: "kbp_demo",
      artifact_kind: "lint_report",
      content: JSON.stringify({
        schema_version: 1,
        artifact_kind: "lint_report",
        findings: [],
        candidate_conflicts: [],
      }),
    });
    const result = {
      schema_version: 1,
      run_id: runId,
      state_id: "lint",
      agent: "carren",
      result_kind: "semantic_lint",
      report_artifact: report,
    };
    store.sealWithPhaseResult({
      state_id: "lint",
      kb_profile_id: "kbp_demo",
      result,
      handles: [report],
    });
    const closed = store.phaseOperandsRecord("lint");
    expect(closed).toMatchObject({
      schema_version: 1,
      lifecycle: "closed",
      closed_result_sha256: sha256Hex(canonicalJson(result)),
      closed_at: expect.stringMatching(/Z$/),
    });
    expect(() => store.requireOpenPhaseOperands("lint")).toThrow(/phase_operands_closed/);
    expect(() => store.bindPhaseOperands(operands)).toThrow(/phase_operands_changed/);
    expect(store.phaseResult("lint")?.result_sha256).toBe(closed?.closed_result_sha256);
    store.close();
  });

  it("stores artifact/phase metadata in control DB without storing artifact bodies", () => {
    const root = tmpRoot();
    const runId = "run_control_body_free";
    const sentinel = "PRIVATE-ARTIFACT-BODY-77cf12";
    const payload = {
      ...CLAIMS,
      claims: [{ ...CLAIMS.claims[0], text: sentinel }],
    };
    const store = artifactStore(root, runId);
    const handle = store.stage({
      state_id: "ingest",
      kb_profile_id: "kbp_demo",
      artifact_kind: "claims",
      content: JSON.stringify(payload),
    });
    store.seal([handle.artifact_id]);
    store.close();
    control(root).close();
    controls.delete(root);
    const databaseBytes = ["", "-wal", "-shm"]
      .map((suffix) => path.join(root, `control.db${suffix}`))
      .filter(existsSync)
      .map((file) => readFileSync(file, "latin1"))
      .join("\u0000");
    expect(databaseBytes).not.toContain(sentinel);
    expect(existsSync(path.join(root, "work", runId, "artifacts.db"))).toBe(false);
  });
});
