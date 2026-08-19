/**
 * KB capabilities tests (G7, §5.2).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CapabilityError,
  CapabilityStore,
  envelopeDigest,
  mintEnvelope,
  validateEnvelopeCrossField,
  type CapabilityEnvelope,
} from "../src/kb/capabilities.js";
import { createHash } from "node:crypto";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "penny-kb-cap-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = "2026-01-01T00:00:00Z";
const LATER = "2026-12-31T00:00:00Z";
const ZERO = "0".repeat(64);

function sourceEnvelope(overrides?: Partial<CapabilityEnvelope>): CapabilityEnvelope {
  return mintEnvelope({
    kind: "source_read",
    session_id: "session-1",
    kb_profile_id: "kbp_demo",
    resolved_path: "/tmp/source.md",
    expected_sha256: ZERO,
    allowed_operation: "ingest",
    issued_at: NOW,
    expires_at: LATER,
    media_type: "text/markdown",
    source_metadata: {
      source_type: "file",
      captured_at: NOW,
      title: "Test source",
      authors: ["Author"],
    },
    ...overrides,
  });
}

function targetEnvelope(overrides?: Partial<CapabilityEnvelope>): CapabilityEnvelope {
  return mintEnvelope({
    kind: "canonical_target",
    session_id: "session-1",
    kb_profile_id: "kbp_demo",
    resolved_path: "/tmp/target.md",
    expected_sha256: ZERO,
    allowed_operation: "promote",
    issued_at: NOW,
    expires_at: LATER,
    authority_root: "/tmp",
    ...overrides,
  });
}

describe("KB §5.2 envelope cross-field validation", () => {
  it("accepts a correct source_read envelope", () => {
    expect(() => validateEnvelopeCrossField(sourceEnvelope())).not.toThrow();
  });

  it("accepts a correct canonical_target envelope", () => {
    expect(() => validateEnvelopeCrossField(targetEnvelope())).not.toThrow();
  });

  it("rejects source_read with authority_root", () => {
    expect(() => validateEnvelopeCrossField(sourceEnvelope({ authority_root: "/tmp" }))).toThrow(
      CapabilityError
    );
  });

  it("rejects source_read without source_metadata", () => {
    const env = sourceEnvelope();
    delete (env as Partial<CapabilityEnvelope>).source_metadata;
    expect(() => validateEnvelopeCrossField(env)).toThrow(CapabilityError);
  });

  it("rejects source_read with wrong allowed_operation", () => {
    expect(() =>
      validateEnvelopeCrossField(sourceEnvelope({ allowed_operation: "promote" }))
    ).toThrow(CapabilityError);
  });

  it("rejects canonical_target without authority_root", () => {
    const env = targetEnvelope();
    delete (env as Partial<CapabilityEnvelope>).authority_root;
    expect(() => validateEnvelopeCrossField(env)).toThrow(CapabilityError);
  });

  it("rejects canonical_target with source_metadata", () => {
    expect(() =>
      validateEnvelopeCrossField(
        targetEnvelope({
          source_metadata: {
            source_type: "file",
            captured_at: NOW,
            title: "x",
            authors: ["a"],
          },
        })
      )
    ).toThrow(CapabilityError);
  });

  it("rejects source_read with unsupported media_type", () => {
    expect(() =>
      validateEnvelopeCrossField(sourceEnvelope({ media_type: "application/pdf" }))
    ).toThrow(CapabilityError);
  });
});

describe("KB §5.2 envelope minting", () => {
  it("mints an envelope with a host-generated opaque ID", () => {
    const env = sourceEnvelope();
    expect(env.capability_id).toMatch(/^cap_[a-f0-9]{32}$/);
    expect(env.schema_version).toBe(1);
  });

  it("produces a stable envelope digest", () => {
    const env = sourceEnvelope();
    const d1 = envelopeDigest(env);
    const d2 = envelopeDigest(env);
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("KB §5.2 capability store", () => {
  it("registers an envelope as available", () => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    const env = sourceEnvelope();
    const lease = store.register(env);
    expect(lease.state).toBe("available");
    expect(store.lease(env.capability_id)?.state).toBe("available");
  });

  it("claims all-or-none: all available → all claimed", () => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    const e1 = sourceEnvelope();
    const e2 = sourceEnvelope();
    store.register(e1);
    store.register(e2);
    store.claimAll([e1.capability_id, e2.capability_id], "run-1", "txn-1");
    expect(store.lease(e1.capability_id)?.state).toBe("claimed");
    expect(store.lease(e2.capability_id)?.state).toBe("claimed");
  });

  it("claims all-or-none: one unavailable → none claimed", () => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    const e1 = sourceEnvelope();
    const e2 = sourceEnvelope();
    store.register(e1);
    store.register(e2);
    store.claimAll([e1.capability_id], "run-1", "txn-1");
    // e1 is now claimed; try to claim e1 + e2 together → must fail, neither changes
    expect(() => store.claimAll([e1.capability_id, e2.capability_id], "run-2", "txn-2")).toThrow(
      CapabilityError
    );
    expect(store.lease(e1.capability_id)?.state).toBe("claimed");
    expect(store.lease(e2.capability_id)?.state).toBe("available");
  });

  it("rejects claiming a non-existent capability", () => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    expect(() => store.claimAll(["cap_nonexistent"], "run-1", "txn-1")).toThrow(CapabilityError);
  });

  it("consumes a claimed capability", () => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    const env = sourceEnvelope();
    store.register(env);
    store.claimAll([env.capability_id], "run-1", "txn-1");
    store.consume(env.capability_id);
    expect(store.lease(env.capability_id)?.state).toBe("consumed");
  });

  it("invalidates a claimed capability", () => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    const env = sourceEnvelope();
    store.register(env);
    store.claimAll([env.capability_id], "run-1", "txn-1");
    store.invalidate(env.capability_id);
    expect(store.lease(env.capability_id)?.state).toBe("invalidated");
  });

  it("refuses to consume an already-consumed capability (single-use)", () => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    const env = sourceEnvelope();
    store.register(env);
    store.claimAll([env.capability_id], "run-1", "txn-1");
    store.consume(env.capability_id);
    expect(() => store.consume(env.capability_id)).toThrow(CapabilityError);
  });

  it("refuses to re-claim a consumed capability", () => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    const env = sourceEnvelope();
    store.register(env);
    store.claimAll([env.capability_id], "run-1", "txn-1");
    store.consume(env.capability_id);
    expect(() => store.claimAll([env.capability_id], "run-2", "txn-2")).toThrow(CapabilityError);
  });
});
