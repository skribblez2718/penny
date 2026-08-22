/**
 * KB capabilities tests (G7, §5.2).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CapabilityError,
  CapabilityStore,
  capabilityStoreDirectory,
  envelopeDigest,
  mintEnvelope,
  validateEnvelopeCrossField,
  type CapabilityEnvelope,
} from "../src/kb/capabilities.js";
import { validateHostCapabilityLease, validateSourceAdmissionRecord } from "../src/kb/contracts.js";
import {
  claimCapabilities,
  discardSourceAdmissions,
  mintSourceCapability,
  SimulatedSourceAdmissionCrash,
  sourcesFromAdmissions,
} from "../src/kb/gate.js";

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

function database(pathname: string): import("node:sqlite").DatabaseSync {
  const module = process.getBuiltinModule("node:" + "sqlite") as
    | typeof import("node:sqlite")
    | undefined;
  if (module === undefined) throw new Error("node:sqlite is unavailable");
  return new module.DatabaseSync(pathname);
}

function claimSource(
  store: CapabilityStore,
  envelopes: readonly CapabilityEnvelope[],
  overrides: Partial<{
    runId: string;
    transactionId: string;
    sessionId: string;
    profileId: string;
    operation: "ingest" | "promote";
    now: string;
  }> = {}
): void {
  store.claimAll(envelopes, {
    runId: overrides.runId ?? "run-1",
    transactionId: overrides.transactionId ?? "txn-1",
    sessionId: overrides.sessionId ?? "session-1",
    profileId: overrides.profileId ?? "kbp_demo",
    kind: "source_read",
    operation: overrides.operation ?? "ingest",
    now: overrides.now ?? "2026-06-01T00:00:00Z",
  });
}

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

  it("rejects unknown top-level and nested envelope fields", () => {
    expect(() => validateEnvelopeCrossField({ ...sourceEnvelope(), bearer: "ambient" })).toThrow(
      CapabilityError
    );
    const source = sourceEnvelope();
    expect(() =>
      validateEnvelopeCrossField({
        ...source,
        source_metadata: { ...source.source_metadata!, invented_authority: true },
      })
    ).toThrow(CapabilityError);
  });

  it("accepts an explicitly empty host-reviewed authors array", () => {
    const source = sourceEnvelope();
    expect(() =>
      validateEnvelopeCrossField({
        ...source,
        source_metadata: { ...source.source_metadata!, authors: [] },
      })
    ).not.toThrow();
  });

  it("enforces exact lease and admission lifecycle requiredness", () => {
    const available = {
      schema_version: 1,
      capability_id: "cap_lifecycle",
      envelope_sha256: ZERO,
      state: "available",
    };
    expect(() => validateHostCapabilityLease(available)).not.toThrow();
    expect(() => validateHostCapabilityLease({ ...available, run_id: "run_1" })).toThrow();
    expect(() =>
      validateHostCapabilityLease({
        ...available,
        state: "claimed",
        run_id: "run_1",
        transaction_id: "txn_1",
      })
    ).toThrow();
    expect(() =>
      validateHostCapabilityLease({
        ...available,
        state: "commit_reserved",
        run_id: "run_1",
        transaction_id: "txn_1",
        claimed_at: NOW,
      })
    ).toThrow();
    expect(() => validateHostCapabilityLease({ ...available, state: "consumed" })).toThrow();

    const admission = {
      schema_version: 1,
      source_id: "src_lifecycle",
      capability_id: "cap_lifecycle",
      envelope_sha256: ZERO,
      run_id: "run_1",
      transaction_id: "txn_1",
      sha256: ZERO,
      media_type: "text/plain",
      byte_length: 0,
      storage_key: "work/run_1/transaction/sources/src_lifecycle",
      temporary_storage_key: "work/run_1/transaction/sources/.src_lifecycle.txn_1.tmp",
      state: "preparing",
      created_at: NOW,
      updated_at: NOW,
    };
    expect(() => validateSourceAdmissionRecord(admission)).not.toThrow();
    const { temporary_storage_key: _temporary, ...withoutTemporary } = admission;
    expect(() => validateSourceAdmissionRecord(withoutTemporary)).toThrow();
    expect(() =>
      validateSourceAdmissionRecord({ ...admission, storage_key: "work/another/source" })
    ).toThrow();
    expect(() => validateSourceAdmissionRecord({ ...admission, state: "admitted" })).toThrow();
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

  it("rejects unknown envelope bytes and tampered lease/admission SQLite rows", () => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    const env = sourceEnvelope();
    store.register(env);
    const dbPath = path.join(capabilityStoreDirectory(dir), "capabilities.sqlite");

    let db = database(dbPath);
    db.prepare("UPDATE capability_envelopes SET envelope_jcs=? WHERE capability_id=?").run(
      JSON.stringify({ ...env, unknown_authority: true }),
      env.capability_id
    );
    db.close();
    expect(() => store.envelope(env.capability_id)).toThrow(/closed validation|invalid envelope/i);

    const clean = sourceEnvelope();
    store.register(clean);
    db = database(dbPath);
    db.prepare(
      `UPDATE capability_leases
       SET state='claimed',run_id='run_tampered',transaction_id='txn_tampered',claimed_at=NULL
       WHERE capability_id=?`
    ).run(clean.capability_id);
    db.close();
    expect(() => store.lease(clean.capability_id)).toThrow(/lifecycle/i);

    const digestTampered = sourceEnvelope();
    store.register(digestTampered);
    db = database(dbPath);
    db.prepare("UPDATE capability_leases SET envelope_sha256=? WHERE capability_id=?").run(
      "f".repeat(64),
      digestTampered.capability_id
    );
    db.close();
    expect(() => store.lease(digestTampered.capability_id)).toThrow(/digest/i);

    const admissionEnvelope = sourceEnvelope();
    store.register(admissionEnvelope);
    const [admission] = store.prepareSourceAdmissions({
      envelopes: [admissionEnvelope],
      runId: "run_tampered",
      transactionId: "txn_tampered",
      now: NOW,
    });
    db = database(dbPath);
    db.prepare("UPDATE source_admissions SET storage_key='work/wrong' WHERE source_id=?").run(
      admission!.source_id
    );
    db.close();
    expect(() => store.admission(admission!.source_id)).toThrow(/lifecycle|storage_key/i);
  });

  it("claims all-or-none: all available → all claimed", () => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    const e1 = sourceEnvelope();
    const e2 = sourceEnvelope();
    store.register(e1);
    store.register(e2);
    claimSource(store, [e1, e2]);
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
    claimSource(store, [e1]);
    expect(() => claimSource(store, [e1, e2], { runId: "run-2", transactionId: "txn-2" })).toThrow(
      CapabilityError
    );
    expect(store.lease(e1.capability_id)?.state).toBe("claimed");
    expect(store.lease(e2.capability_id)?.state).toBe("available");
  });

  it("rejects claiming a non-existent capability", () => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    expect(() =>
      claimSource(store, [sourceEnvelope({ capability_id: "cap_nonexistent" })])
    ).toThrow(CapabilityError);
  });

  it.each([
    ["expired", { now: "2027-01-01T00:00:00Z" }, /expired/i],
    ["cross-session", { sessionId: "session-other" }, /another session/i],
    ["cross-profile", { profileId: "kbp_other" }, /another profile/i],
    ["wrong-operation", { operation: "promote" as const }, /authorize/i],
  ])("refuses %s capability admission", (_label, overrides, message) => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    const env = sourceEnvelope();
    store.register(env);
    expect(() => claimSource(store, [env], overrides)).toThrow(message);
    expect(store.lease(env.capability_id)?.state).toBe("available");
  });

  it("refuses an envelope digest tamper and leaves the lease available", () => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    const env = sourceEnvelope();
    store.register(env);
    const tampered: CapabilityEnvelope = {
      ...env,
      source_metadata: { ...env.source_metadata!, title: "Tampered title" },
    };
    expect(() => claimSource(store, [tampered])).toThrow(/envelope|digest/i);
    expect(store.lease(env.capability_id)?.state).toBe("available");
  });

  it("refuses non-finite envelope timestamps", () => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    const env = sourceEnvelope();
    env.expires_at = "not-a-time";
    expect(() => store.register(env)).toThrow(/finite timestamps/i);
  });

  it("consumes and invalidates claimed capabilities", () => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    const consumed = sourceEnvelope();
    const invalidated = sourceEnvelope();
    store.register(consumed);
    store.register(invalidated);
    claimSource(store, [consumed, invalidated]);
    store.consume(consumed.capability_id);
    store.invalidate(invalidated.capability_id);
    expect(store.lease(consumed.capability_id)?.state).toBe("consumed");
    expect(store.lease(invalidated.capability_id)?.state).toBe("invalidated");
  });

  it("refuses to consume an already-consumed capability (single-use)", () => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    const env = sourceEnvelope();
    store.register(env);
    claimSource(store, [env]);
    store.consume(env.capability_id);
    expect(() => store.consume(env.capability_id)).toThrow(CapabilityError);
  });

  it("refuses to re-claim a consumed capability", () => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    const env = sourceEnvelope();
    store.register(env);
    claimSource(store, [env]);
    store.consume(env.capability_id);
    expect(() => claimSource(store, [env], { runId: "run-2", transactionId: "txn-2" })).toThrow(
      CapabilityError
    );
  });

  it("fails source commit reservation when expiry arrives immediately before the cliff", () => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    const env = sourceEnvelope();
    store.register(env);
    claimSource(store, [env]);
    expect(() =>
      store.reserveSourceCommitAll(
        [env.capability_id],
        "run-1",
        "publication-expired",
        "2027-01-01T00:00:00Z"
      )
    ).toThrow(/reservation/i);
    expect(store.lease(env.capability_id)?.state).toBe("claimed");
  });

  it("keeps an exact source commit reservation non-expiring after the cliff", () => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    const env = sourceEnvelope();
    store.register(env);
    claimSource(store, [env]);
    store.reserveSourceCommitAll(
      [env.capability_id],
      "run-1",
      "publication-reserved",
      "2026-12-30T00:00:00Z"
    );
    expect(() =>
      store.reserveSourceCommitAll(
        [env.capability_id],
        "run-1",
        "publication-reserved",
        "2027-01-01T00:00:00Z"
      )
    ).not.toThrow();
    expect(store.lease(env.capability_id)).toMatchObject({
      state: "commit_reserved",
      transaction_id: "publication-reserved",
    });
  });

  it("consumes under the publication transaction while publishing the exact admission binding", () => {
    const dir = tmp();
    using store = new CapabilityStore(dir);
    const env = sourceEnvelope();
    store.register(env);
    claimSource(store, [env], { transactionId: "admission-transaction" });
    const [admission] = store.prepareSourceAdmissions({
      envelopes: [env],
      runId: "run-1",
      transactionId: "admission-transaction",
      now: NOW,
    });
    store.admitSource(admission!.source_id, 0, NOW);
    const settlementNow = "2026-06-01T00:00:00Z";
    store.reserveSourceCommitAll(
      [env.capability_id],
      "run-1",
      "publication-transaction",
      settlementNow
    );

    const settle = () =>
      store.settlePublishedSources({
        capabilityIds: [env.capability_id],
        sourceIds: [admission!.source_id],
        runId: "run-1",
        transactionId: "publication-transaction",
        now: settlementNow,
      });
    expect(settle).not.toThrow();
    expect(store.lease(env.capability_id)).toMatchObject({
      state: "consumed",
      transaction_id: "publication-transaction",
    });
    expect(store.admission(admission!.source_id)).toMatchObject({
      state: "published",
      transaction_id: "admission-transaction",
    });
    expect(settle).not.toThrow();
  });
});

describe("KB §5.2 immutable source admission", () => {
  function fixture(label: string) {
    const projectRoot = tmp();
    const kbRoot = path.join(projectRoot, "private-kb");
    mkdirSync(kbRoot, { mode: 0o700 });
    const sourcePath = path.join(projectRoot, `${label}.md`);
    const original = `immutable source ${label}`;
    writeFileSync(sourcePath, original, { mode: 0o600 });
    const envelope = mintSourceCapability({
      projectRoot,
      kbProfileId: "kbp_demo",
      sessionId: "session-1",
      allowedOperation: "ingest",
      absolutePath: sourcePath,
      title: `Source ${label}`,
      authors: ["Author"],
      mediaType: "text/markdown",
      sourceType: "file",
    });
    return { projectRoot, kbRoot, sourcePath, original, envelope };
  }

  function claimFixture(input: ReturnType<typeof fixture>, boundary?: string): string[] {
    return claimCapabilities({
      projectRoot: input.projectRoot,
      kbRoot: input.kbRoot,
      capabilityIds: [input.envelope.capability_id],
      runId: "run-1",
      transactionId: "txn-1",
      sessionId: "session-1",
      profileId: "kbp_demo",
      kind: "source_read",
      operation: "ingest",
      ...(boundary !== undefined
        ? {
            onSourceBoundary: (point) => {
              if (point === boundary) throw new SimulatedSourceAdmissionCrash(point);
            },
          }
        : {}),
    });
  }

  it("stores the complete envelope only in owner SQLite and allocates an independent source id", () => {
    const input = fixture("independent-id");
    const sourceIds = claimFixture(input);
    expect(sourceIds).toHaveLength(1);
    const sourceId = sourceIds[0]!;
    expect(sourceId).toMatch(/^src_[a-f0-9]{32}$/);
    expect(sourceId).not.toBe(input.envelope.capability_id);
    expect(sourceId).not.toBe(input.envelope.expected_sha256);
    expect(existsSync(path.join(input.kbRoot, "capabilities"))).toBe(false);
    expect(
      existsSync(path.join(capabilityStoreDirectory(input.projectRoot), "capabilities.sqlite"))
    ).toBe(true);
    using store = new CapabilityStore(input.projectRoot);
    expect(store.envelope(input.envelope.capability_id)).toEqual(input.envelope);
    expect(store.admission(sourceId)).toMatchObject({
      capability_id: input.envelope.capability_id,
      state: "admitted",
      run_id: "run-1",
      transaction_id: "txn-1",
    });
  });

  it("serves the immutable snapshot after the external file changes", () => {
    const input = fixture("external-change");
    const [sourceId] = claimFixture(input);
    writeFileSync(input.sourcePath, "changed after snapshot", { mode: 0o600 });
    const [source] = sourcesFromAdmissions(input.projectRoot, input.kbRoot, [sourceId!], {
      runId: "run-1",
      transactionId: "txn-1",
      sessionId: "session-1",
      profileId: "kbp_demo",
    });
    expect(source?.content).toBe(input.original);
    expect(readFileSync(input.sourcePath, "utf8")).toBe("changed after snapshot");
  });

  it.each(["after_preindex", "after_claim"])(
    "recovers %s with the exact preallocated source identity",
    (boundary) => {
      const input = fixture(boundary);
      expect(() => claimFixture(input, boundary)).toThrow(SimulatedSourceAdmissionCrash);
      using before = new CapabilityStore(input.projectRoot);
      const preallocated = before.admissionsForTransaction("run-1", "txn-1")[0]!.source_id;
      before.close();
      const sourceIds = claimFixture(input);
      expect(sourceIds).toEqual([preallocated]);
    }
  );

  it.each(["after_temp_fsync", "after_rename"])(
    "recovers %s only from the exact preindexed row and keys",
    (boundary) => {
      const input = fixture(boundary);
      expect(() => claimFixture(input, boundary)).toThrow(SimulatedSourceAdmissionCrash);
      using before = new CapabilityStore(input.projectRoot);
      const preallocated = before.admissionsForTransaction("run-1", "txn-1")[0]!.source_id;
      before.close();
      // A recovery at these boundaries must not need the external path again.
      rmSync(input.sourcePath);
      const sourceIds = claimFixture(input);
      expect(sourceIds).toEqual([preallocated]);
      using store = new CapabilityStore(input.projectRoot);
      const admission = store.admission(sourceIds[0]!);
      expect(admission?.state).toBe("admitted");
      expect(admission?.storage_key).toBe(`work/run-1/transaction/sources/${sourceIds[0]!}`);
      expect(admission?.temporary_storage_key).toBeUndefined();
    }
  );

  it("cleans only indexed snapshot keys and invalidates the exact claim on deny/failure", () => {
    const input = fixture("cleanup");
    const [sourceId] = claimFixture(input);
    using before = new CapabilityStore(input.projectRoot);
    const admission = before.admission(sourceId!)!;
    const snapshot = path.join(input.kbRoot, ...admission.storage_key.split("/"));
    expect(existsSync(snapshot)).toBe(true);
    before.close();
    discardSourceAdmissions({
      projectRoot: input.projectRoot,
      kbRoot: input.kbRoot,
      runId: "run-1",
      transactionId: "txn-1",
      capabilityIds: [input.envelope.capability_id],
      invalidateClaims: true,
    });
    using after = new CapabilityStore(input.projectRoot);
    expect(after.admission(sourceId!)?.state).toBe("discarded");
    expect(after.lease(input.envelope.capability_id)?.state).toBe("invalidated");
    expect(existsSync(snapshot)).toBe(false);
  });

  it.each([
    ["session replay", { sessionId: "session-other" }, /another session/i],
    ["profile replay", { profileId: "kbp_other" }, /another profile/i],
    ["operation replay", { operation: "promote" as const }, /authorize/i],
  ])("rejects %s before source I/O", (_label, overrides, expected) => {
    const input = fixture(String(_label));
    expect(() =>
      claimCapabilities({
        projectRoot: input.projectRoot,
        kbRoot: input.kbRoot,
        capabilityIds: [input.envelope.capability_id],
        runId: "run-1",
        transactionId: "txn-1",
        sessionId: overrides.sessionId ?? "session-1",
        profileId: overrides.profileId ?? "kbp_demo",
        kind: "source_read",
        operation: overrides.operation ?? "ingest",
      })
    ).toThrow(expected);
    using store = new CapabilityStore(input.projectRoot);
    expect(store.lease(input.envelope.capability_id)?.state).toBe("available");
    expect(store.admissionsForTransaction("run-1", "txn-1")[0]?.state).toBe("discarded");
  });
});

describe("KB §5.2 capability-store custody", () => {
  it("fails closed on a symlinked custody root", () => {
    const parent = tmp();
    const real = path.join(parent, "real");
    const link = path.join(parent, "link");
    new CapabilityStore(real).close();
    symlinkSync(real, link, "dir");
    expect(() => new CapabilityStore(link)).toThrow(/symlink/i);
  });

  it("fails closed instead of repairing a broadened custody mode", () => {
    const dir = tmp();
    new CapabilityStore(dir).close();
    const authority = capabilityStoreDirectory(dir);
    chmodSync(authority, 0o750);
    expect(() => new CapabilityStore(dir)).toThrow(/0700/i);
    chmodSync(authority, 0o700);
  });

  it("fails closed on a broadened SQLite file mode", () => {
    const dir = tmp();
    new CapabilityStore(dir).close();
    const database = path.join(capabilityStoreDirectory(dir), "capabilities.sqlite");
    chmodSync(database, 0o640);
    expect(() => new CapabilityStore(dir)).toThrow(/0600/i);
    chmodSync(database, 0o600);
  });
});
