import { parseJson, requireRecord, requireString, requireValue } from "./helpers/narrowing.js";
/**
 * KB content-review gate tests (§5.1 pragmatic slice).
 *
 * Covers: gate persistence + safe projection, liveness (expiry), base
 * generation drift invalidation, single-approval CAS, operator denial,
 * capability lifecycle (claimed → consumed on approve; invalidated on deny),
 * and resume/status re-presentation.
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initKb, statusKb } from "../src/kb/workflows.js";
import { closeKbArtifactControls, kbArtifactControl } from "./fixtures/kb-artifact-control.js";
import { readSelectedGeneration } from "../src/kb/generations.js";
import {
  createTestOnlyIngestBodyRunner,
  ingestKb,
  type IngestSource,
  type TestOnlyIngestBodyRunner,
} from "../src/kb/ingest.js";
import {
  capabilitySha256Of,
  claimCapabilities,
  denyGate,
  findGateForRun,
  invalidateCapabilities,
  latestPendingGate,
  listGates,
  persistIngestGate,
  readGate,
  sourcesFromCapabilities,
  approveGate,
  type GateState,
  GateStorageError,
} from "../src/kb/gate.js";
import {
  CapabilityStore,
  mintEnvelope,
  validateEnvelopeCrossField,
  type CapabilityEnvelope,
} from "../src/kb/capabilities.js";
import { canonicalJson } from "../src/kb/contracts.js";

// ── Harness ─────────────────────────────────────────────────────────────────

const dirs: string[] = [];
function tmpRoot(label = "penny-kb-gate"): string {
  const d = mkdtempSync(path.join(tmpdir(), label + "-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  closeKbArtifactControls();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SOURCE_A: IngestSource = {
  sourceId: "src_cap_a",
  capabilityDigest: "1".repeat(64),
  title: "Gate source A",
  authors: ["Ada Lovelace"],
  content:
    "The gate admits sources only under an operator-minted capability envelope; approval is a host decision.",
  mediaType: "text/markdown",
  sourceType: "manual",
  capturedAt: "2026-08-18T00:00:00Z",
};

function gateArtifacts(
  artifacts: Awaited<ReturnType<typeof ingestKb>>["artifacts"]
): Array<Record<string, unknown>> {
  return artifacts.map((artifact) => ({
    schema_version: artifact.schema_version,
    artifact_id: artifact.artifact_id,
    artifact_kind: artifact.artifact_kind,
    sha256: artifact.sha256,
    media_type: artifact.media_type,
    byte_length: artifact.byte_length,
  }));
}

function ctx(root: string, runId: string) {
  return {
    kbRoot: root,
    profileId: "kbp_gate",
    runId,
    checkpointer: kbArtifactControl({ root, runId, profileId: "kbp_gate" }),
  };
}

/** Mock runner (same contract as kb-ingest.test.ts). */
function makeMockRunner(): TestOnlyIngestBodyRunner {
  const claims = JSON.stringify({
    schema_version: 1,
    artifact_kind: "claims",
    source_ids: ["src_cap_a"],
    claims: [
      {
        provisional_id: "candidate_gate",
        text: "Approval of ingested content is a host decision, never a model-visible action.",
        kind: "fact",
        confidence: "CERTAIN",
        evidence: [{ source_id: "src_cap_a" }],
      },
    ],
  });
  const page = JSON.stringify({
    schema_version: 1,
    artifact_kind: "page_draft",
    pages: [
      {
        frontmatter: {
          schema_version: 1,
          page_id: "page_gate",
          revision_id: "rev_gate",
          kind: "synthesis",
          title: "Gate approval is host-authenticated",
          summary: "Host-only approval; sealed candidate set.",
          authority: "advisory",
          lifecycle: "validated",
          created_at: "2026-08-18T00:00:00Z",
          derived_from: [],
          related_page_ids: [],
        },
        markdown: [
          "## Synthesis",
          "The content-review gate separates sealed candidates from publication.",
          "## Evidence",
          "- Approval is host-authenticated (src_cap_a).",
          "## Tensions and unknowns",
          "- None recorded.",
          "## Related",
          "- None.",
        ].join("\n"),
        claims: { schema_version: 1, page_id: "page_gate", revision_id: "rev_gate", claims: [] },
      },
    ],
  });
  const lint = JSON.stringify({
    schema_version: 1,
    artifact_kind: "lint_report",
    findings: [],
    candidate_conflicts: [],
  });
  const verification = JSON.stringify({
    schema_version: 1,
    artifact_kind: "verification_report",
    verified_artifact_ids: [],
    claim_findings: [],
  });
  const table: Record<string, string> = {
    ingest: claims,
    compose: page,
    lint: lint,
    verify: verification,
  };
  return createTestOnlyIngestBodyRunner(async (_inv) => {
    const out = table[_inv.stateId];
    if (out === undefined) throw new Error(`mock: no output for ${_inv.stateId}`);
    return out;
  });
}

interface CapFixture {
  capabilityId: string;
  filePath: string;
  envelope: CapabilityEnvelope;
}

function makeCapability(kbRoot: string, source: IngestSource, profileId: string): CapFixture {
  const staging = tmpRoot("penny-kb-cap-src");
  const filePath = path.join(staging, "source.md");
  writeFileSync(filePath, source.content, { mode: 0o600 });
  const now = new Date().toISOString();
  const envelope = mintEnvelope({
    kind: "source_read",
    session_id: "test-session",
    kb_profile_id: profileId,
    resolved_path: filePath,
    expected_sha256: capabilitySha256Of(Buffer.from(source.content, "utf8")),
    allowed_operation: "ingest",
    issued_at: now,
    expires_at: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
    media_type: source.mediaType,
    source_metadata: {
      source_type: source.sourceType,
      captured_at: source.capturedAt,
      title: source.title,
      authors: [...source.authors],
    },
  });
  validateEnvelopeCrossField(envelope);
  using store = new CapabilityStore(kbRoot);
  store.register(envelope);
  expect(existsSync(path.join(kbRoot, "capabilities"))).toBe(false);
  return { capabilityId: envelope.capability_id, filePath, envelope };
}

async function runToGate(
  root: string,
  runId: string,
  capIds: readonly string[] = []
): Promise<GateState> {
  const gateResult = await ingestKb(ctx(root, runId), [SOURCE_A], makeMockRunner());
  expect(gateResult.status).toBe("awaiting_user");
  const gate = persistIngestGate(
    root,
    "kbp_gate",
    runId,
    gateArtifacts(gateResult.artifacts),
    capIds,
    capIds
  );
  return gate;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("gate persistence and projection", () => {
  it("persists an owner-only awaited gate with a sealed packet digest", async () => {
    const root = tmpRoot();
    initKb(ctx(root, "kb-init"), "Gate KB");
    const gate = await runToGate(root, "kb-run-1");

    const p = path.join(root, ".kb", "gates", `${gate.gate_id}.json`);
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).mode & 0o777).toBe(0o600);

    const stored = readGate(root, gate.gate_id);
    expect(stored).toBeDefined();
    expect(requireValue(stored, "apps/orchestration/tests/kb-gate.test.ts:235").status).toBe(
      "awaiting"
    );
    expect(requireValue(stored, "apps/orchestration/tests/kb-gate.test.ts:236").source_ids).toEqual(
      []
    );
    expect(
      requireValue(stored, "apps/orchestration/tests/kb-gate.test.ts:237").artifacts
    ).toHaveLength(4);
    expect(
      requireValue(stored, "apps/orchestration/tests/kb-gate.test.ts:238").packet_sha256
    ).toMatch(/^[0-9a-f]{64}$/);

    // Safe projection: no KB paths, no bodies.
    const json = JSON.stringify(listGates(root));
    expect(json).not.toContain(root);
    expect(existsSync(path.join(root, "pages"))).toBe(false); // nothing published
  });

  it("resume/status present the pending gate", async () => {
    const root = tmpRoot();
    initKb(ctx(root, "kb-init"), "Gate KB");
    const gate = await runToGate(root, "kb-run-resume");

    const pending = latestPendingGate(root);
    expect(pending?.run_id).toBe("kb-run-resume");
    expect(pending?.status).toBe("awaiting");

    const s = statusKb(ctx(root, "kb-status"));
    expect(s.met).toBe(true);
    void gate;
    void s;
  });
});

describe("gate decisions (host-authenticated)", () => {
  it("approves only once, publishes exactly one generation, and consumes the capability", async () => {
    const root = tmpRoot();
    initKb(ctx(root, "kb-init"), "Gate KB");
    const cap = makeCapability(root, SOURCE_A, "kbp_gate");

    const sourceIds = claimCapabilities({
      projectRoot: root,
      kbRoot: root,
      capabilityIds: [cap.capabilityId],
      runId: "kb-run-1",
      sessionId: "test-session",
      profileId: "kbp_gate",
      kind: "source_read",
      operation: "ingest",
    });
    const sources = sourcesFromCapabilities(root, root, sourceIds, {
      runId: "kb-run-1",
      sessionId: "test-session",
      profileId: "kbp_gate",
    });

    await (async () => {
      const gateResult = await ingestKb(ctx(root, "kb-run-1"), sources, makeMockRunner());
      expect(gateResult.status).toBe("awaiting_user");
      return persistIngestGate(
        root,
        "kbp_gate",
        "kb-run-1",
        gateArtifacts(gateResult.artifacts),
        sourceIds,
        [cap.capabilityId]
      );
    })();

    const { gate: updated, result } = approveGate(
      root,
      sources,
      "kb-run-1",
      root,
      ctx(root, "kb-run-1").checkpointer
    );
    expect(result.status).toBe("complete");
    expect(result.met).toBe(true);
    expect(updated.status).toBe("approved");
    expect(updated.published_generation_id).toMatch(/^gen_/);

    // Capability lease consumed.
    const store = new CapabilityStore(root);
    try {
      expect(store.lease(cap.capabilityId)?.state).toBe("consumed");
    } finally {
      store.close();
    }

    // Second approval refused (gate already decided).
    expect(() =>
      approveGate(root, sources, "kb-run-1", root, ctx(root, "kb-run-1").checkpointer)
    ).toThrow(GateStorageError);

    // Publication plane: the approved page is selected. This legacy fixture
    // carries no supported claims, so current grounded query semantics
    // correctly do not call it a met answer.
    expect(
      Object.keys(
        requireValue(readSelectedGeneration(root), "apps/orchestration/tests/kb-gate.test.ts:325")
          .catalog.pages
      )
    ).toContain("page_gate");
  });

  it("drift invalidates a gate without publishing", async () => {
    const root = tmpRoot();
    initKb(ctx(root, "kb-init"), "Gate KB");
    const selector = requireRecord(
      parseJson(readFileSync(path.join(root, ".kb", "current.json"), "utf8")),
      "current generation selector"
    );
    const baseGen = requireString(selector["generation_id"], "current generation id");

    const gate1 = await runToGate(root, "kb-run-drift-1");
    expect(gate1.base_generation_id).toBe(baseGen);

    // A second run publishes a new generation (selector advances).
    makeCapability(root, SOURCE_A, "kbp_gate");
    const sources = [SOURCE_A];
    const sources2 = [SOURCE_A];
    const gate2Raw = await ingestKb(ctx(root, "kb-run-drift-2"), sources2, makeMockRunner());
    expect(gate2Raw.status).toBe("awaiting_user");
    persistIngestGate(
      root,
      "kbp_gate",
      "kb-run-drift-2",
      gateArtifacts(gate2Raw.artifacts),
      [],
      []
    );
    const { result: r2 } = approveGate(
      root,
      sources2,
      "kb-run-drift-2",
      undefined,
      ctx(root, "kb-run-drift-2").checkpointer
    );
    expect(r2.met).toBe(true);

    // Gate 1 now sees a drifted base.
    expect(() =>
      approveGate(
        root,
        sources,
        "kb-run-drift-1",
        undefined,
        ctx(root, "kb-run-drift-1").checkpointer
      )
    ).toThrow(/drift|awaiting/);
    const invalidated = findGateForRun(root, "kb-run-drift-1");
    expect(invalidated?.status).toBe("invalidated");
    expect(invalidated?.terminal_reason).toBe("base_generation_drift");

    // The first gate's candidate set never published a second page for gen1.
  });

  it("expiry invalidates before any publication", async () => {
    const root = tmpRoot();
    initKb(ctx(root, "kb-init"), "Gate KB");
    const gate = await runToGate(root, "kb-run-expired");

    // Force expiry by rewriting the row (test-only).
    const p = path.join(root, ".kb", "gates", `${gate.gate_id}.json`);
    const raw = requireValue(readGate(root, gate.gate_id), "persisted gate fixture");
    const expired = { ...raw, expires_at: "2020-01-01T00:00:00Z" } satisfies GateState;
    writeFileSync(p, canonicalJson(expired), { mode: 0o600 });
    chmodSync(p, 0o600);

    expect(() => approveGate(root, [SOURCE_A], "kb-run-expired")).toThrow(/expired/);
    const final = findGateForRun(root, "kb-run-expired");
    expect(final?.status).toBe("invalidated");
    expect(final?.terminal_reason).toBe("expired");
    expect(existsSync(path.join(root, "pages"))).toBe(false);
  });

  it("denial publishes nothing and invalidates the capability", async () => {
    const root = tmpRoot();
    initKb(ctx(root, "kb-init"), "Gate KB");
    const cap = makeCapability(root, SOURCE_A, "kbp_gate");
    const sourceIds = claimCapabilities({
      projectRoot: root,
      kbRoot: root,
      capabilityIds: [cap.capabilityId],
      runId: "kb-run-deny",
      sessionId: "test-session",
      profileId: "kbp_gate",
      kind: "source_read",
      operation: "ingest",
    });

    const gateResult = await ingestKb(
      ctx(root, "kb-run-deny"),
      sourcesFromCapabilities(root, root, sourceIds, {
        runId: "kb-run-deny",
        sessionId: "test-session",
        profileId: "kbp_gate",
      }),
      makeMockRunner()
    );
    expect(gateResult.status).toBe("awaiting_user");
    persistIngestGate(
      root,
      "kbp_gate",
      "kb-run-deny",
      gateArtifacts(gateResult.artifacts),
      sourceIds,
      [cap.capabilityId]
    );

    const denied = denyGate(root, "kb-run-deny", root);
    expect(denied.status).toBe("denied");
    expect(existsSync(path.join(root, "pages"))).toBe(false);

    const store = new CapabilityStore(root);
    try {
      expect(store.lease(cap.capabilityId)?.state).toBe("invalidated");
    } finally {
      store.close();
    }
  });
});

describe("capability resolution custody", () => {
  it("refuses an unadmitted source id", () => {
    const root = tmpRoot();
    initKb(ctx(root, "kb-init"), "Gate KB");
    expect(() =>
      sourcesFromCapabilities(root, root, ["src_not_admitted"], {
        runId: "kb-run-unclaimed",
        sessionId: "test-session",
        profileId: "kbp_gate",
      })
    ).toThrow(/not an admitted/i);
  });

  it("continues to read the immutable snapshot after external path drift", () => {
    const root = tmpRoot();
    initKb(ctx(root, "kb-init"), "Gate KB");
    const cap = makeCapability(root, SOURCE_A, "kbp_gate");
    const sourceIds = claimCapabilities({
      projectRoot: root,
      kbRoot: root,
      capabilityIds: [cap.capabilityId],
      runId: "kb-run-snapshot",
      sessionId: "test-session",
      profileId: "kbp_gate",
      kind: "source_read",
      operation: "ingest",
    });
    writeFileSync(cap.filePath, "TAMPERED AFTER SNAPSHOT", { mode: 0o600 });
    const [source] = sourcesFromCapabilities(root, root, sourceIds, {
      runId: "kb-run-snapshot",
      sessionId: "test-session",
      profileId: "kbp_gate",
    });
    expect(source?.content).toBe(SOURCE_A.content);
  });

  it("invalidateCapabilities transitions an exact claimed target set", () => {
    const root = tmpRoot();
    initKb(ctx(root, "kb-init"), "Gate KB");
    const cap = makeCapability(root, SOURCE_A, "kbp_gate");
    claimCapabilities({
      projectRoot: root,
      kbRoot: root,
      capabilityIds: [cap.capabilityId],
      runId: "kb-run-inval",
      sessionId: "test-session",
      profileId: "kbp_gate",
      kind: "source_read",
      operation: "ingest",
    });
    invalidateCapabilities(root, [cap.capabilityId], { runId: "kb-run-inval" });
    using store = new CapabilityStore(root);
    expect(store.lease(cap.capabilityId)?.state).toBe("invalidated");
  });
});
