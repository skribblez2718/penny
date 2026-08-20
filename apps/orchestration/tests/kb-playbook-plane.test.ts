import { randomUUID } from "node:crypto";
/**
 * KB playbook ↔ real ingest plane integration (§6.2 step 2).
 *
 * The unit tests drive the playbook against a recording plane. This suite proves the
 * *real* plane satisfies the same contract against a live KB root: seal freezes the
 * candidate set, the gate binds to the base generation, approval publishes a
 * generation and consumes the capability leases, and denial publishes nothing.
 *
 * No agents run here. The phase bodies are staged directly, which is exactly what the
 * executor will do in step 4 — so this pins the host-side half independently of any
 * model.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RunContext } from "../src/context.js";
import { KnowledgeBasePlaybook } from "../src/playbooks/knowledge-base.js";
import { defaultKbIngestPlane, resolveKbRoot } from "../src/kb/ingest-plane.js";
import { initKb } from "../src/kb/workflows.js";
import { readPolicy, writePolicy } from "../src/kb/filesystem.js";

/** The active parent identity these runs execute under (§5.3). */
const PARENT = { provider: "ollama", model: "qwen327b:latest" };

/** The §5.3 out-of-band policy install a default-deny KB requires. */
function installTestPolicy(kbRoot: string): void {
  const policy = readPolicy(kbRoot);
  writePolicy(kbRoot, {
    ...policy,
    processing_mode: "local_only",
    allowed_parent_models: [{ ...PARENT, locality: "local" }],
    allowed_child_models: [{ ...PARENT, locality: "local" }],
  });
}
import { RunArtifactStore } from "../src/kb/run-artifacts.js";
import { findGateForRun, mintSourceCapability } from "../src/kb/gate.js";
import { CapabilityStore } from "../src/kb/capabilities.js";
import { readSelectedGeneration } from "../src/kb/generations.js";
import type { Confidence, JsonValue } from "../src/contracts.js";

const PROFILE = "kbp_integration";
const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "penny-kb-plane-"));
  roots.push(dir);
  return dir;
}

/** Mint a source capability the way the host CLI does. */
/** Mint a source capability through the shared function the CLI uses. */
function mintSource(kbRoot: string, projectRoot: string, name: string, content: string): string {
  const file = path.join(projectRoot, name);
  writeFileSync(file, content, { mode: 0o600 });
  return mintSourceCapability({
    kbRoot,
    kbProfileId: PROFILE,
    absolutePath: file,
    title: `Source ${name}`,
    authors: ["P. Operator"],
    mediaType: "text/markdown",
    expiresHours: 1,
  }).capability_id;
}

interface Fixture {
  projectRoot: string;
  kbRoot: string;
  runId: string;
  capabilityIds: string[];
  context: RunContext;
  playbook: KnowledgeBasePlaybook;
}

function seedRun(): Fixture {
  const projectRoot = tmpProject();
  const kbRoot = resolveKbRoot(projectRoot, PROFILE);
  const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  initKb({ kbRoot, profileId: PROFILE, runId: `${runId}_init` }, "Integration KB");
  installTestPolicy(kbRoot);
  const capabilityIds = [
    mintSource(kbRoot, projectRoot, "a.md", "Quorum requires two of three acknowledgements."),
    mintSource(kbRoot, projectRoot, "b.md", "Replay was fixed by a monotonic sequence number."),
  ];
  const context = RunContext.create({
    identity: {
      schema_version: 2,
      run_id: runId,
      session_id: "sess_integration",
      playbook: "knowledge-base",
      engine_owner: "typescript",
    },
    goal: "ingest two admitted sources",
    constraints: {
      action: "ingest",
      kb_profile_id: PROFILE,
      source_capability_ids: capabilityIds,
      parent_identity: { ...PARENT },
    },
    projectRoot,
    trustProfile: "hardened-untrusted",
    maxSteps: 40,
  });
  return {
    projectRoot,
    kbRoot,
    runId,
    capabilityIds,
    context,
    playbook: new KnowledgeBasePlaybook(undefined, defaultKbIngestPlane()),
  };
}

const PAGE_ID = "page_int_0001";
const REVISION_ID = "rev_int_0001";

function claimsBody(sourceIds: readonly string[]): string {
  return JSON.stringify({
    schema_version: 1,
    artifact_kind: "claims",
    source_ids: [...sourceIds],
    claims: [
      {
        claim_id: "clm_0001",
        text: "Quorum requires two of three acknowledgements.",
        kind: "fact",
        state: "supported",
        confidence: "PROBABLE",
        evidence: [{ source_id: sourceIds[0]! }],
        contradicts_claim_ids: [],
        canonical_verification_refs: [],
      },
    ],
  });
}

function pageBody(sourceIds: readonly string[]): string {
  return JSON.stringify({
    schema_version: 1,
    artifact_kind: "page_draft",
    pages: [
      {
        frontmatter: {
          schema_version: 1,
          page_id: PAGE_ID,
          revision_id: REVISION_ID,
          kind: "synthesis",
          title: "Quorum acknowledgement rules",
          summary: "How quorum acknowledgements and replay protection work.",
          authority: "advisory",
          lifecycle: "draft",
          created_at: new Date().toISOString(),
          derived_from: [],
          related_page_ids: [],
        },
        markdown:
          "## Synthesis\n\nQuorum needs two of three.\n\n## Evidence\n\nSource A.\n\n## Tensions and unknowns\n\nNone recorded.\n\n## Related\n\nNone.\n",
        claims: {
          schema_version: 1,
          page_id: PAGE_ID,
          revision_id: REVISION_ID,
          claims: JSON.parse(claimsBody(sourceIds)).claims,
        },
      },
    ],
  });
}

/** Stage the four phase bodies the way the executor will, returning their details. */
function stagePhases(fixture: Fixture): Record<string, Record<string, JsonValue>> {
  const store = new RunArtifactStore(fixture.kbRoot, fixture.runId);
  try {
    const stage = (stateId: string, kind: string, content: string): string =>
      store.stage({
        state_id: stateId,
        kb_profile_id: PROFILE,
        artifact_kind: kind as Parameters<RunArtifactStore["stage"]>[0]["artifact_kind"],
        content,
      }).artifact_id;

    const ingestId = stage("ingest", "claims", claimsBody(fixture.capabilityIds));
    const composeId = stage("compose", "page_draft", pageBody(fixture.capabilityIds));
    const lintId = stage(
      "lint",
      "lint_report",
      JSON.stringify({
        schema_version: 1,
        artifact_kind: "lint_report",
        findings: [],
        candidate_conflicts: [],
      })
    );
    const verifyId = stage(
      "verify",
      "verification_report",
      JSON.stringify({
        schema_version: 1,
        artifact_kind: "verification_report",
        verified_artifact_ids: [],
        claim_findings: [
          {
            claim_ref: { page_id: PAGE_ID, revision_id: REVISION_ID, claim_id: "clm_0001" },
            verdict: "supported",
            notes: "Source A states it.",
          },
        ],
      })
    );
    return {
      ingest: {
        kb_artifact_id: ingestId,
        artifact_kind: "claims",
        complete: true,
        claim_count: 1,
        source_ids: [...fixture.capabilityIds],
      },
      compose: {
        kb_artifact_id: composeId,
        artifact_kind: "page_draft",
        complete: true,
        claim_count: 1,
        page_id: PAGE_ID,
        revision_id: REVISION_ID,
      },
      lint: {
        kb_artifact_id: lintId,
        artifact_kind: "lint_report",
        complete: true,
        finding_count: 0,
        error_count: 0,
        candidate_conflict_count: 0,
      },
      verify: {
        kb_artifact_id: verifyId,
        artifact_kind: "verification_report",
        complete: true,
        supported: 1,
        partially_supported: 0,
        unsupported: 0,
      },
    };
  } finally {
    store.close();
  }
}

/** Drive the machine to the review gate using staged real artifacts. */
function driveToGate(fixture: Fixture): void {
  const details = stagePhases(fixture);
  fixture.playbook.initialize(fixture.context);
  for (let guard = 0; guard < 10 && fixture.context.stateId !== "awaiting_review"; guard += 1) {
    const phase = fixture.context.stateId;
    const phaseDetails = details[phase];
    if (phaseDetails === undefined) break;
    fixture.playbook.validateDetails(phase, phaseDetails);
    fixture.playbook.acceptSummary(fixture.context, phaseDetails, "PROBABLE" as Confidence);
  }
}

describe("KB playbook ↔ real ingest plane", () => {
  it("seals the candidate set and persists a gate bound to the base generation", () => {
    const fixture = seedRun();
    const base = readSelectedGeneration(fixture.kbRoot);
    driveToGate(fixture);

    expect(fixture.context.stateId).toBe("awaiting_review");
    // eslint-disable-next-line no-console
    const gate = findGateForRun(fixture.kbRoot, fixture.runId);
    expect(gate).toBeDefined();
    expect(gate!.status).toBe("awaiting");
    expect(gate!.base_generation_id).toBe(base!.selector.generation_id);
    expect(String(fixture.context.playbookData.gate_id)).toBe(gate!.gate_id);
  });

  it("approval publishes a generation and consumes the capability leases", () => {
    const fixture = seedRun();
    const base = readSelectedGeneration(fixture.kbRoot);
    driveToGate(fixture);

    const terminal = fixture.playbook.resume(fixture.context, "approve");
    expect(terminal.action).toBe("complete");

    const selected = readSelectedGeneration(fixture.kbRoot);
    expect(selected!.selector.generation_id).not.toBe(base!.selector.generation_id);
    expect(String(fixture.context.playbookData.published_generation_id)).toBe(
      selected!.selector.generation_id
    );
    expect(Object.keys(selected!.catalog.pages)).toContain(PAGE_ID);

    const store = new CapabilityStore(fixture.kbRoot);
    try {
      for (const id of fixture.capabilityIds) {
        expect(store.lease(id)?.state).toBe("consumed");
      }
    } finally {
      store.close();
    }
    expect(findGateForRun(fixture.kbRoot, fixture.runId)!.status).toBe("approved");
  });

  it("denial publishes nothing and leaves the selector untouched", () => {
    const fixture = seedRun();
    const base = readSelectedGeneration(fixture.kbRoot);
    driveToGate(fixture);

    const terminal = fixture.playbook.resume(fixture.context, "deny");
    expect(terminal.action).toBe("incomplete");

    const selected = readSelectedGeneration(fixture.kbRoot);
    expect(selected!.selector.generation_id).toBe(base!.selector.generation_id);
    expect(findGateForRun(fixture.kbRoot, fixture.runId)!.status).toBe("denied");
    expect(fixture.context.playbookData.published_generation_id).toBeUndefined();
  });

  it("refuses to publish twice for the same run", () => {
    const fixture = seedRun();
    driveToGate(fixture);
    fixture.playbook.resume(fixture.context, "approve");
    // The gate is terminal; a second approval must not publish again.
    expect(() =>
      defaultKbIngestPlane().approve({ kbRoot: fixture.kbRoot, runId: fixture.runId })
    ).toThrow();
  });
});
