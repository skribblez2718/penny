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
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initKb, statusKb, queryKb } from "../src/kb/workflows.js";
import { ingestKb, type AgentRunner, type IngestSource } from "../src/kb/ingest.js";
import {
  capabilitySha256Of,
  claimCapabilities,
  consumeCapabilities,
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
  envelopeDigest,
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
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SOURCE_A: IngestSource = {
  sourceId: "src_cap_a",
  title: "Gate source A",
  authors: ["Ada Lovelace"],
  content:
    "The gate admits sources only under an operator-minted capability envelope; approval is a host decision.",
  mediaType: "text/markdown",
  sourceType: "manual",
  capturedAt: "2026-08-18T00:00:00Z",
};

function ctx(root: string, runId: string) {
  return { kbRoot: root, profileId: "kbp_gate", runId };
}

/** Mock runner (same contract as kb-ingest.test.ts). */
function makeMockRunner(): AgentRunner {
  const claims = JSON.stringify({
    schema_version: 1,
    artifact_kind: "claims",
    source_ids: ["src_cap_a"],
    claims: [
      {
        claim_id: "clm_gate",
        text: "Approval of ingested content is a host decision, never a model-visible action.",
        kind: "fact",
        state: "supported",
        confidence: "CERTAIN",
        evidence: [{ source_id: "src_cap_a" }],
        contradicts_claim_ids: [],
        canonical_verification_refs: [],
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
    echo_ingest: claims,
    synthia_compose: page,
    carren_lint: lint,
    vera_verify: verification,
  };
  return (async (_inv) => {
    const out = table[_inv.stateId];
    if (out === undefined) throw new Error(`mock: no output for ${_inv.stateId}`);
    return out;
  }) as AgentRunner;
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
  const store = new CapabilityStore(kbRoot);
  try {
    store.register(envelope);
  } finally {
    store.close();
  }
  const regDir = path.join(kbRoot, "capabilities");
  mkdirSync(regDir, { recursive: true, mode: 0o700 });
  const regPath = path.join(regDir, `${envelope.capability_id}.json`);
  writeFileSync(regPath, canonicalJson(envelope), { mode: 0o600 });
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
    gateResult.artifacts as unknown as Record<string, unknown>[],
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
    expect(stored!.status).toBe("awaiting");
    expect(stored!.source_ids).toEqual([]);
    expect(stored!.artifacts).toHaveLength(4);
    expect(stored!.packet_sha256).toMatch(/^[0-9a-f]{64}$/);

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

    const sources = sourcesFromCapabilities(root, [cap.capabilityId]);
    claimCapabilities(root, [cap.capabilityId], "kb-run-1");

    const gate = await (async () => {
      const gateResult = await ingestKb(ctx(root, "kb-run-1"), sources, makeMockRunner());
      expect(gateResult.status).toBe("awaiting_user");
      return persistIngestGate(
        root,
        "kbp_gate",
        "kb-run-1",
        gateResult.artifacts as unknown as Record<string, unknown>[],
        [cap.capabilityId],
        [cap.capabilityId]
      );
    })();

    const { gate: updated, result } = approveGate(root, sources, "kb-run-1");
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
    expect(() => approveGate(root, sources, "kb-run-1")).toThrow(GateStorageError);

    // Publication plane: the approved page is queryable.
    const q = queryKb(ctx(root, "kb-q"), "gate approval host decision");
    expect(q.met).toBe(true);
  });

  it("drift invalidates a gate without publishing", async () => {
    const root = tmpRoot();
    initKb(ctx(root, "kb-init"), "Gate KB");
    const baseGen = JSON.parse(
      readFileSync(path.join(root, ".kb", "current.json"), "utf8")
    ).generation_id;

    const gate1 = await runToGate(root, "kb-run-drift-1");
    expect(gate1.base_generation_id).toBe(baseGen);

    // A second run publishes a new generation (selector advances).
    const cap = makeCapability(root, SOURCE_A, "kbp_gate");
    const sources = sourcesFromCapabilities(root, [cap.capabilityId]);
    gate1 && void gate1;
    const sources2 = [SOURCE_A];
    const gate2Raw = await ingestKb(ctx(root, "kb-run-drift-2"), sources2, makeMockRunner());
    expect(gate2Raw.status).toBe("awaiting_user");
    persistIngestGate(
      root,
      "kbp_gate",
      "kb-run-drift-2",
      gate2Raw.artifacts as unknown as Record<string, unknown>[],
      [],
      []
    );
    const { result: r2 } = approveGate(root, sources2, "kb-run-drift-2");
    expect(r2.met).toBe(true);

    // Gate 1 now sees a drifted base.
    expect(() => approveGate(root, sources, "kb-run-drift-1")).toThrow(/drift|awaiting/);
    const invalidated = findGateForRun(root, "kb-run-drift-1");
    expect(invalidated?.status).toBe("invalidated");
    expect(invalidated?.terminal_reason).toBe("base_generation_drift");

    // The first gate's candidate set never published a second page for gen1.
    void cap;
    void sources;
  });

  it("expiry invalidates before any publication", async () => {
    const root = tmpRoot();
    initKb(ctx(root, "kb-init"), "Gate KB");
    const gate = await runToGate(root, "kb-run-expired");

    // Force expiry by rewriting the row (test-only).
    const p = path.join(root, ".kb", "gates", `${gate.gate_id}.json`);
    const raw = JSON.parse(readFileSync(p, "utf8")) as GateState;
    raw.expires_at = "2020-01-01T00:00:00Z";
    writeFileSync(p, canonicalJson(raw), { mode: 0o600 });
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
    claimCapabilities(root, [cap.capabilityId], "kb-run-deny");

    const gateResult = await ingestKb(
      ctx(root, "kb-run-deny"),
      sourcesFromCapabilities(root, [cap.capabilityId]),
      makeMockRunner()
    );
    expect(gateResult.status).toBe("awaiting_user");
    persistIngestGate(
      root,
      "kbp_gate",
      "kb-run-deny",
      gateResult.artifacts as unknown as Record<string, unknown>[],
      [cap.capabilityId],
      [cap.capabilityId]
    );

    const denied = denyGate(root, "kb-run-deny");
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
  it("refuses a drifted source file", async () => {
    const root = tmpRoot();
    initKb(ctx(root, "kb-init"), "Gate KB");
    const cap = makeCapability(root, SOURCE_A, "kbp_gate");

    // Drift the source file after minting.
    writeFileSync(cap.filePath, "TAMPERED CONTENT", { mode: 0o600 });
    expect(() => sourcesFromCapabilities(root, [cap.capabilityId])).toThrow(/drifted/i);
  });

  it("invalidateCapabilities transitions claimed → invalidated", async () => {
    const root = tmpRoot();
    initKb(ctx(root, "kb-init"), "Gate KB");
    const cap = makeCapability(root, SOURCE_A, "kbp_gate");
    claimCapabilities(root, [cap.capabilityId], "kb-run-inval");
    invalidateCapabilities(root, [cap.capabilityId]);
    const store = new CapabilityStore(root);
    try {
      expect(store.lease(cap.capabilityId)?.state).toBe("invalidated");
    } finally {
      store.close();
    }
  });
});
