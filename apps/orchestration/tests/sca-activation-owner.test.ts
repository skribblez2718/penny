import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import { afterEach, describe, expect, it } from "vitest";

import {
  ScaHostKeyInstallation,
  parseScaHostKeyEnvelopeV1,
} from "../dist/sca/activation-host-key.js";

import { canonicalJson, sha256 } from "../dist/canonical-json.js";
import type { ArtifactRef } from "../dist/contracts.js";
import {
  SqliteScaActivationOwner,
  type ScaActivationIssuanceInstallationV1,
  type ScaActivationInstallationAuthenticationV1,
  type ScaActivationOwnerOptions,
} from "../dist/sca/activation-owner.js";
import {
  SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
  SCA_ACTIVATION_ISSUANCE_V1_SCHEMA,
  sealScaActivationAuthorityV1,
  sealScaActivationIssuanceV1,
} from "../dist/sca/qualification-activation-contracts.js";
import type { VerifiedScaActivationAdmissionViewV1 } from "../dist/sca/qualification-activation.js";

function isSqliteModule(value: unknown): value is typeof import("node:sqlite") {
  return (
    value !== null &&
    typeof value === "object" &&
    "DatabaseSync" in value &&
    typeof value.DatabaseSync === "function"
  );
}
function openSqlite(file: string): DatabaseSync {
  const module: unknown = process.getBuiltinModule("node:" + "sqlite");
  if (!isSqliteModule(module)) throw new Error("node:sqlite unavailable");
  return new module.DatabaseSync(file);
}

const roots: string[] = [];
const NOW = Date.parse("2026-09-23T12:00:00Z");
const HASH = "a".repeat(64);
const issued = new Set<string>();
const authenticateInstallation = (operands: ScaActivationInstallationAuthenticationV1): boolean =>
  issued.has(canonicalJson(operands));
function directory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "sca-activation-owner-"));
  roots.push(root);
  return path.join(root, "owner");
}
afterEach(() => {
  issued.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function ref(name: string, run: string, content: string): ArtifactRef {
  return {
    schema_version: 2,
    artifact_id: `art_${sha256(canonicalJson({ branch_id: null, kind: "activation-issuance", operation_id: name, phase: "sca-activation-admission", run_id: run, version: 1 }))}`,
    run_id: run,
    phase: "sca-activation-admission",
    branch_id: null,
    kind: "activation-issuance",
    operation_id: name,
    version: 1,
    producer: "host:operator",
    media_type: "application/json",
    content_schema: { schema_id: SCA_ACTIVATION_ISSUANCE_V1_SCHEMA, schema_version: 1 },
    byte_length: Buffer.byteLength(content),
    content_digest: sha256(content),
    store_ref: `artifact://sha256/${sha256(content)}`,
  };
}
function fixture(suffix = "1"): {
  installation: ScaActivationIssuanceInstallationV1;
  view: VerifiedScaActivationAdmissionViewV1;
} {
  const scope = {
    authority_id: `authority-${suffix}`,
    nonce: `nonce-${suffix}`,
    tenant_id: "tenant",
    project_id: "project",
    phase_id: "phase",
    production_playbook_name: "sca",
    qualification_run_id: "qualification",
    activation_run_id: `activation-${suffix}`,
    decision: "authorize_activation_admission" as const,
    qualification_ref: ref("qualification", "qualification", "qualification"),
    gate_ref: ref("gate", "qualification", "gate"),
    implementation_identity_ref: ref("identity", "qualification", "identity"),
    qualification_policy_data_sha256: HASH,
    registration_contract_sha256: HASH,
    runtime_registration_sha256: HASH,
    host_implementation_binding_sha256: HASH,
    operator_principal_id: "operator",
    issuer_policy_id: "policy",
    proposed_start_sha256: HASH,
    issued_at: "2026-09-23T11:59:00Z",
    not_before: "2026-09-23T11:59:00Z",
    expires_at: "2026-09-23T12:01:00Z",
    revocation_generation: 4,
  };
  const record = sealScaActivationIssuanceV1({
    schema_id: SCA_ACTIVATION_ISSUANCE_V1_SCHEMA,
    schema_version: 1,
    issuance_id: `issuance-${suffix}`,
    authority_id: scope.authority_id,
    operator_principal_id: scope.operator_principal_id,
    issuer_policy_id: scope.issuer_policy_id,
    scope_sha256: sha256(canonicalJson(scope)),
    issued_at: scope.issued_at,
  });
  const issuanceRef = ref(`issuance-${suffix}`, scope.activation_run_id, canonicalJson(record));
  const authority = sealScaActivationAuthorityV1({
    schema_id: SCA_ACTIVATION_AUTHORITY_V1_SCHEMA,
    schema_version: 1,
    scope,
    issuance_record_ref: issuanceRef,
  });
  issued.add(canonicalJson({ authority, record, ref: issuanceRef, scope }));
  return {
    installation: { authority, record, ref: issuanceRef },
    view: {
      authority_id: scope.authority_id,
      authority_sha256: authority.authority_sha256,
      issuance_sha256: record.issuance_sha256,
      tenant_id: scope.tenant_id,
      project_id: scope.project_id,
      phase_id: scope.phase_id,
      production_playbook_name: scope.production_playbook_name,
      qualification_run_id: scope.qualification_run_id,
      activation_run_id: scope.activation_run_id,
      qualification_artifact_content_sha256: scope.qualification_ref.content_digest,
      gate_artifact_content_sha256: scope.gate_ref.content_digest,
      implementation_identity_artifact_content_sha256:
        scope.implementation_identity_ref.content_digest,
      qualification_policy_data_sha256: HASH,
      registration_contract_sha256: HASH,
      runtime_registration_sha256: HASH,
      host_implementation_binding_sha256: HASH,
      proposed_start_sha256: HASH,
      revocation_generation: 4,
      checked_at: new Date(NOW).toISOString(),
      expires_at: scope.expires_at,
    },
  };
}
function testAuthenticator(
  authenticate: (operands: ScaActivationInstallationAuthenticationV1) => boolean
): ScaActivationOwnerOptions["installation_authenticator"] {
  return {
    authenticator_id: "test-operator-ledger-v1",
    withLock: (operation) => operation(),
    authenticate,
  };
}
function ownerOptions(dir: string): ScaActivationOwnerOptions {
  return {
    directory: dir,
    issuer_policy_id: "policy",
    operator_principal_id: "operator",
    installation_authenticator_id: "test-operator-ledger-v1",
    installation_authenticator: {
      authenticator_id: "test-operator-ledger-v1",
      withLock: (operation) => operation(),
      authenticate: authenticateInstallation,
    },
    max_admission_age_ms: 30_000,
    revocation_generation: 4,
    now: () => NOW,
  };
}
function owner(
  dir: string,
  now = () => NOW,
  revocation_generation = 4,
  overrides: Partial<ScaActivationOwnerOptions> = {}
) {
  return new SqliteScaActivationOwner({
    ...ownerOptions(dir),
    revocation_generation,
    now,
    ...overrides,
  });
}
function issuanceCount(dir: string): number {
  const db = openSqlite(path.join(dir, "sca-activation-owner.sqlite"));
  try {
    const value: unknown = db.prepare("SELECT count(*) AS n FROM sca_activation_issuances").get();
    if (
      value === null ||
      typeof value !== "object" ||
      !("n" in value) ||
      typeof value.n !== "number"
    )
      throw new Error("missing issuance count");
    return value.n;
  } finally {
    db.close();
  }
}
function verify(o: SqliteScaActivationOwner, f: ReturnType<typeof fixture>) {
  return o.verifyIssuance({
    record: f.installation.record,
    ref: f.installation.ref,
    scope: f.installation.authority.scope,
    policy_id: "policy",
  });
}

describe("SCA activation host-only owner", () => {
  it("requires authenticator configuration and rejects false or throwing authentication without writes", () => {
    const dir = directory();
    const incomplete = { ...ownerOptions(dir), installation_authenticator: undefined };
    expect(() => {
      Reflect.construct(SqliteScaActivationOwner, [incomplete]);
    }).toThrow("authenticator missing");
    expect(existsSync(dir)).toBe(false);
    const f = fixture();
    const denied = owner(dir, () => NOW, 4, {
      installation_authenticator: testAuthenticator(() => false),
    });
    try {
      expect(() => denied.install(f.installation)).toThrow("authentication denied");
      expect(issuanceCount(dir)).toBe(0);
      expect(verify(denied, f)).toBe(false);
    } finally {
      denied.close();
    }
    const throwing = owner(dir, () => NOW, 4, {
      installation_authenticator: testAuthenticator(() => {
        throw new Error("independent ledger unavailable");
      }),
    });
    try {
      expect(() => throwing.install(f.installation)).toThrow("independent ledger unavailable");
      expect(issuanceCount(dir)).toBe(0);
    } finally {
      throwing.close();
    }
    const mutable = fixture("mutated");
    const mutating = owner(dir, () => NOW, 4, {
      installation_authenticator: testAuthenticator((operands) => {
        Reflect.set(operands.record, "issued_at", "2026-09-23T11:58:00Z");
        return true;
      }),
    });
    try {
      expect(() => mutating.install(mutable.installation)).toThrow("authentication denied");
      expect(issuanceCount(dir)).toBe(0);
    } finally {
      mutating.close();
    }
    const valid = owner(dir);
    try {
      valid.install(f.installation);
      expect(issuanceCount(dir)).toBe(1);
    } finally {
      valid.close();
    }
    const noAdoption = owner(dir, () => NOW, 4, {
      installation_authenticator: testAuthenticator(() => false),
    });
    try {
      expect(() => noAdoption.install(f.installation)).toThrow("authentication denied");
      expect(issuanceCount(dir)).toBe(1);
    } finally {
      noAdoption.close();
    }
  });

  it("binds authenticator identity and bounded admission age across restarts", () => {
    const dir = directory();
    const o = owner(dir);
    o.close();
    expect(() =>
      owner(dir, () => NOW, 4, { installation_authenticator_id: "other-ledger" })
    ).toThrow("authenticator missing");
    expect(() => owner(dir, () => NOW, 4, { max_admission_age_ms: 30_001 })).toThrow(
      "policy conflict"
    );
    for (const age of [0, -1, 300_001, 1.5, NaN, Infinity]) {
      const invalid = directory();
      expect(() => owner(invalid, () => NOW, 4, { max_admission_age_ms: age })).toThrow(
        "max admission age malformed"
      );
      expect(existsSync(invalid)).toBe(false);
    }
    const minimum = owner(directory(), () => NOW, 4, { max_admission_age_ms: 1 });
    minimum.close();
    const maximum = owner(directory(), () => NOW, 4, { max_admission_age_ms: 300_000 });
    maximum.close();
  });

  it("admits exactly the configured age boundary while expiry independently denies", () => {
    const dir = directory();
    const f = fixture();
    const o = owner(dir);
    try {
      o.install(f.installation);
      const atBoundary = { ...f.view, checked_at: new Date(NOW - 30_000).toISOString() };
      expect(() =>
        o.consume({ ...atBoundary, checked_at: new Date(NOW - 30_001).toISOString() })
      ).toThrow("stale admission");
      expect(o.consume(atBoundary).decision).toBe("consumed");
    } finally {
      o.close();
    }
    const expired = owner(dir, () => NOW + 60_000);
    try {
      expect(() =>
        expired.consume({ ...f.view, checked_at: new Date(NOW + 60_000).toISOString() })
      ).toThrow("stale admission");
    } finally {
      expired.close();
    }
  });

  it("denies absence; exact-adopts, recovers consumption and never rearms", () => {
    const dir = directory();
    const f = fixture();
    const first = owner(dir);
    expect(verify(first, f)).toBe(false);
    first.install(f.installation);
    first.install(f.installation);
    expect(verify(first, f)).toBe(true);
    const consumed = first.consume(f.view);
    expect(consumed.decision).toBe("consumed");
    first.close();
    const recovered = owner(dir);
    try {
      expect(verify(recovered, f)).toBe(true);
      const resumed = recovered.consume(f.view);
      expect(resumed).toMatchObject({
        decision: "resumed",
        receipt_id: consumed.receipt_id,
        admitted_at: consumed.admitted_at,
      });
      expect(recovered.consume(f.view)).toEqual(resumed);
      expect(() => recovered.install(f.installation)).toThrow("cannot be rearmed");
      expect(() => recovered.consume({ ...f.view, activation_run_id: "other-run" })).toThrow();
      expect(() =>
        recovered.consume({ ...f.view, proposed_start_sha256: "b".repeat(64) })
      ).toThrow();
    } finally {
      recovered.close();
    }
  });

  it("rejects changed immutable issuance, policy, principal, generation and time", () => {
    const dir = directory();
    const f = fixture();
    const o = owner(dir);
    try {
      o.install(f.installation);
      expect(() => o.install(fixture("2").installation)).not.toThrow();
      expect(() =>
        o.install({ ...f.installation, record: fixture("2").installation.record })
      ).toThrow();
      expect(
        o.verifyIssuance({
          record: f.installation.record,
          ref: f.installation.ref,
          scope: f.installation.authority.scope,
          policy_id: "other",
        })
      ).toBe(false);
      expect(
        o.verifyIssuance({
          record: f.installation.record,
          ref: { ...f.installation.ref, content_digest: HASH },
          scope: f.installation.authority.scope,
          policy_id: "policy",
        })
      ).toBe(false);
      expect(
        o.verifyIssuance({
          record: f.installation.record,
          ref: f.installation.ref,
          scope: { ...f.installation.authority.scope, operator_principal_id: "other" },
          policy_id: "policy",
        })
      ).toBe(false);
      expect(() => o.consume({ ...f.view, checked_at: "2026-09-23T11:59:00Z" })).toThrow();
      expect(() =>
        o.consume({ ...f.view, host_implementation_binding_sha256: "b".repeat(64) })
      ).toThrow();
    } finally {
      o.close();
    }
    expect(
      () => new SqliteScaActivationOwner({ ...ownerOptions(dir), issuer_policy_id: "other" })
    ).toThrow();
    const expired = owner(dir, () => NOW + 60_000);
    expect(verify(expired, f)).toBe(false);
    expired.close();
    const newer = owner(dir, () => NOW, 5);
    try {
      expect(verify(newer, f)).toBe(false);
      expect(() => newer.consume(f.view)).toThrow();
      expect(verify(o, f)).toBe(false);
    } finally {
      newer.close();
    }
    expect(() => owner(dir)).toThrow("stale generation");
  });

  it("revokes installed or consumed authority durably, idempotently, without deleting history", () => {
    const dir = directory();
    const f = fixture();
    const o = owner(dir);
    o.install(f.installation);
    o.consume(f.view);
    const input = {
      authority_id: f.view.authority_id,
      reason: "operator-revoked",
      evidence_sha256: HASH,
    };
    const receipt = o.revoke(input);
    expect(o.revoke(input)).toEqual(receipt);
    expect(verify(o, f)).toBe(false);
    expect(() => o.consume(f.view)).toThrow();
    expect(() => o.install(f.installation)).toThrow("cannot be rearmed");
    expect(() => o.revoke({ ...input, evidence_sha256: "b".repeat(64) })).toThrow("conflict");
    o.close();
    const reopened = owner(dir);
    try {
      expect(reopened.revoke(input)).toEqual(receipt);
      expect(verify(reopened, f)).toBe(false);
    } finally {
      reopened.close();
    }
  });

  it("preserves same-run resume across two owners and denies custody or incompatible schema", () => {
    const dir = directory();
    const f = fixture();
    const a = owner(dir);
    const b = owner(dir);
    try {
      a.install(f.installation);
      // This contract check is sequential; separate-connection contention is tested below.
      const first = a.consume(f.view);
      const second = b.consume(f.view);
      expect(first.decision).toBe("consumed");
      expect(second.decision).toBe("resumed");
      expect(first.receipt_id).toBe(second.receipt_id);
      expect(() => b.consume({ ...f.view, activation_run_id: "other" })).toThrow();
      chmodSync(dir, 0o755);
      expect(verify(a, f)).toBe(false);
      expect(() => a.consume(f.view)).toThrow("0700");
      chmodSync(dir, 0o700);
    } finally {
      a.close();
      b.close();
    }
    const db = openSqlite(path.join(dir, "sca-activation-owner.sqlite"));
    db.exec("PRAGMA user_version=99");
    db.close();
    expect(() => owner(dir)).toThrow("incompatible schema");
  });

  it("rejects malformed retained rows and schema without silently repairing state", () => {
    const dir = directory();
    const f = fixture();
    const o = owner(dir);
    o.install(f.installation);
    o.close();
    const db = openSqlite(path.join(dir, "sca-activation-owner.sqlite"));
    db.prepare("UPDATE sca_activation_issuances SET record_json=? WHERE issuance_id=?").run(
      "{}",
      f.installation.record.issuance_id
    );
    db.close();
    const reopened = owner(dir);
    try {
      expect(verify(reopened, f)).toBe(false);
      expect(() => reopened.consume(f.view)).toThrow();
      expect(() => reopened.install(f.installation)).toThrow();
    } finally {
      reopened.close();
    }
    const changed = openSqlite(path.join(dir, "sca-activation-owner.sqlite"));
    changed.exec("ALTER TABLE sca_activation_issuances ADD COLUMN shadow TEXT");
    changed.close();
    expect(() => owner(dir)).toThrow("schema layout mismatch");
  });

  it("rejects unexpected views, triggers and explicit indexes on reopen and use", () => {
    const additions = [
      "CREATE VIEW unexpected_view AS SELECT issuance_id FROM sca_activation_issuances",
      "CREATE TRIGGER unexpected_trigger AFTER INSERT ON sca_activation_issuances BEGIN SELECT 1; END",
      "CREATE INDEX unexpected_index ON sca_activation_issuances(state)",
      "CREATE VIEW sqliteXunexpected_view AS SELECT issuance_id FROM sca_activation_issuances",
    ];
    for (const statement of additions) {
      const dir = directory();
      const f = fixture();
      const o = owner(dir);
      o.install(f.installation);
      const db = openSqlite(path.join(dir, "sca-activation-owner.sqlite"));
      db.exec(statement);
      db.close();
      expect(verify(o, f)).toBe(false);
      expect(() => o.install(fixture("fresh").installation)).toThrow("schema layout mismatch");
      o.close();
      expect(() => owner(dir)).toThrow("schema layout mismatch");
      expect(issuanceCount(dir)).toBe(1);
    }
  });

  it("revokes before consumption and refuses any later admission", () => {
    const dir = directory();
    const f = fixture();
    const o = owner(dir);
    try {
      o.install(f.installation);
      o.revoke({
        authority_id: f.view.authority_id,
        reason: "operator-revoked",
        evidence_sha256: HASH,
      });
      expect(verify(o, f)).toBe(false);
      expect(() => o.consume(f.view)).toThrow();
    } finally {
      o.close();
    }
  });

  it("rejects preexisting unversioned tables rather than repairing them", () => {
    const dir = directory();
    const opened = owner(dir);
    opened.close();
    const db = openSqlite(path.join(dir, "sca-activation-owner.sqlite"));
    db.exec("PRAGMA user_version=0");
    db.close();
    expect(() => owner(dir)).toThrow("unversioned schema");
  });
});

// This worker owns its own node:sqlite connection. Its UPDATE is the same single-row
// mutation as revokeGrant/revokeKey; the production owner and host verifier run on
// the other connection. Shared memory coordinates entry into SQLite, not the result.
const REVOCATION_WORKER = `
  const { DatabaseSync } = require('node:sqlite');
  const { workerData } = require('node:worker_threads');
  const { file, kind, id, control, first } = workerData;
  const state = new Int32Array(control);
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout=5000');
    if (first) {
      db.exec('BEGIN IMMEDIATE');
      Atomics.store(state, 0, 1); // lock held, parent may start verify/consume
      Atomics.notify(state, 0);
      if (Atomics.wait(state, 1, 0, 4000) === 'timed-out') throw new Error('parent did not start');
      // Hold the real write lock while the owner enters BEGIN IMMEDIATE.
      Atomics.wait(state, 1, 1, 150);
    } else {
      if (Atomics.wait(state, 1, 0, 4000) === 'timed-out') throw new Error('owner did not finish');
      Atomics.store(state, 0, 2); // about to enter SQLite, while owner holds the host lock
      Atomics.notify(state, 0);
      db.exec('BEGIN IMMEDIATE');
    }
    const table = kind === 'grant' ? 'grants' : kind === 'key' ? 'keys' : null;
    if (!table && kind !== 'hold') throw new Error('invalid revocation kind');
    if (table) {
      const result = db.prepare('UPDATE ' + table + " SET status='revoked' WHERE id=? AND status!='revoked'").run(id);
      if (result.changes !== 1) throw new Error('revocation did not change one row');
    }
    db.exec('COMMIT');
    Atomics.store(state, 0, 3); // committed before reporting success
    Atomics.notify(state, 0);
  } catch (error) {
    Atomics.store(state, 0, -1);
    Atomics.notify(state, 0);
    throw error;
  } finally {
    if (db) db.close();
  }
`;

type RevocationKind = "grant" | "key";
function revocationWorker(
  keys: string,
  kind: RevocationKind | "hold",
  id: string,
  first: boolean
): { worker: Worker; state: Int32Array; finished: Promise<void> } {
  const state = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
  const worker = new Worker(REVOCATION_WORKER, {
    eval: true,
    workerData: {
      file: path.join(keys, "sca-host-keys.sqlite"),
      kind,
      id,
      control: state.buffer,
      first,
    },
  });
  let failure: Error | undefined;
  const finished = new Promise<void>((resolve, reject) => {
    worker.on("error", (error: Error) => {
      failure = error;
    });
    worker.once("exit", (code) => {
      if (code === 0 && failure === undefined && Atomics.load(state, 0) === 3) resolve();
      else
        reject(
          failure ?? new Error(`revocation worker exited ${code}, state ${Atomics.load(state, 0)}`)
        );
    });
  });
  // Keep a rejection handler attached even if a synchronous owner call is still
  // waiting on SQLite when the worker fails; the original promise still rejects.
  void finished.catch(() => undefined);
  return { worker, state, finished };
}
function awaitState(state: Int32Array, expected: number): void {
  const deadline = Date.now() + 4_000;
  while (Atomics.load(state, 0) === 0 && Date.now() < deadline)
    Atomics.wait(state, 0, 0, deadline - Date.now());
  expect(Atomics.load(state, 0)).toBe(expected);
}
function releaseWorker(state: Int32Array): void {
  Atomics.store(state, 1, 1);
  Atomics.notify(state, 1);
}
function ledgerStatus(keys: string, kind: RevocationKind, id: string): string {
  const db = openSqlite(path.join(keys, "sca-host-keys.sqlite"));
  try {
    const table = kind === "grant" ? "grants" : "keys";
    const result = db.prepare(`SELECT status FROM ${table} WHERE id=?`).get(id);
    if (result === undefined || typeof result.status !== "string")
      throw new Error("revocation row missing");
    return result.status;
  } finally {
    db.close();
  }
}
function consumptionState(dir: string): { state: string; run: string | null } {
  const db = openSqlite(path.join(dir, "sca-activation-owner.sqlite"));
  try {
    const result = db.prepare("SELECT state,consumed_run_id FROM sca_activation_issuances").get();
    if (
      result === undefined ||
      typeof result.state !== "string" ||
      (result.consumed_run_id !== null && typeof result.consumed_run_id !== "string")
    )
      throw new Error("consumption row missing");
    return { state: result.state, run: result.consumed_run_id };
  } finally {
    db.close();
  }
}

// The production verifier uses a separate host-key ledger; this suite wires it through
// the real owner instead of using the synthetic ledger in the owner contract tests.
describe("host-key signed installation", () => {
  function setup(now = () => NOW) {
    const dir = directory();
    const keys = path.join(path.dirname(dir), "host-keys");
    const verifier = ScaHostKeyInstallation.provision(keys, "host-one", now);
    const key = verifier.provisionKey();
    const options = {
      ...ownerOptions(dir),
      installation_authenticator_id: verifier.authenticator_id,
      installation_authenticator: verifier,
      now,
    };
    const o = new SqliteScaActivationOwner(options);
    const f = fixture();
    const operands = { ...f.installation, scope: f.installation.authority.scope };
    return { dir, keys, verifier, key, options, o, f, operands };
  }
  it("resumes the exact same run after real lock contention only within the admission window", async () => {
    let now = NOW;
    const t = setup(() => now);
    t.verifier.signGrant("grant-one", t.operands);
    t.o.install(t.f.installation);
    const first = t.o.consume(t.f.view);
    const secondOwner = new SqliteScaActivationOwner({ ...t.options, now: () => now });
    const { worker, state, finished } = revocationWorker(t.keys, "hold", "", true);
    try {
      awaitState(state, 1);
      releaseWorker(state);
      const resumed = secondOwner.consume(t.f.view);
      expect(Atomics.load(state, 0)).toBe(3); // owner waited for the held SQLite lock
      await finished;
      expect(resumed).toEqual({ ...first, decision: "resumed" });
      expect(consumptionState(t.dir)).toEqual({
        state: "consumed",
        run: t.f.view.activation_run_id,
      });
      expect(() => secondOwner.install(t.f.installation)).toThrow("cannot be rearmed");
      expect(() => secondOwner.consume({ ...t.f.view, activation_run_id: "other-run" })).toThrow();
      expect(() =>
        secondOwner.consume({ ...t.f.view, proposed_start_sha256: "b".repeat(64) })
      ).toThrow();
      now += 30_001;
      expect(() => secondOwner.consume(t.f.view)).toThrow("stale admission");
      now = Date.parse(t.f.view.expires_at);
      expect(verify(secondOwner, t.f)).toBe(false);
      expect(() =>
        secondOwner.consume({ ...t.f.view, checked_at: new Date(now).toISOString() })
      ).toThrow("authentication denied"); // host-key expiry is checked before admission age
    } finally {
      releaseWorker(state);
      await worker.terminate();
      await finished.catch(() => undefined);
      secondOwner.close();
      t.o.close();
      t.verifier.close();
    }
  });
  for (const kind of ["grant", "key"] as const) {
    for (const operation of ["verify", "consume"] as const) {
      it(`serializes ${kind} revocation committed before owner ${operation} on separate SQLite connections`, async () => {
        const t = setup();
        const id = kind === "grant" ? "grant-one" : t.key;
        t.verifier.signGrant("grant-one", t.operands);
        t.o.install(t.f.installation);
        const { worker, state, finished } = revocationWorker(t.keys, kind, id, true);
        try {
          awaitState(state, 1); // the revoker has BEGIN IMMEDIATE
          releaseWorker(state);
          if (operation === "verify") expect(verify(t.o, t.f)).toBe(false);
          else expect(() => t.o.consume(t.f.view)).toThrow("authentication denied");
          expect(Atomics.load(state, 0)).toBe(3); // decision must follow COMMIT, not a busy denial
          await finished;
          expect(ledgerStatus(t.keys, kind, id)).toBe("revoked");
          expect(consumptionState(t.dir)).toEqual({ state: "installed", run: null });
          expect(verify(t.o, t.f)).toBe(false);
          expect(() => t.o.consume(t.f.view)).toThrow("authentication denied");
          expect(() => t.o.install(t.f.installation)).toThrow("authentication denied");
        } finally {
          releaseWorker(state);
          await worker.terminate();
          await finished.catch(() => undefined);
          t.o.close();
          t.verifier.close();
        }
      });
      it(`serializes owner ${operation} before ${kind} revocation without rearming`, async () => {
        const t = setup();
        t.verifier.signGrant("grant-one", t.operands);
        t.o.install(t.f.installation);
        t.o.close();
        const id = kind === "grant" ? "grant-one" : t.key;
        const { worker, state, finished } = revocationWorker(t.keys, kind, id, false);
        let armed = false;
        const instrumented = {
          authenticator_id: t.verifier.authenticator_id,
          authenticate: (input: ScaActivationInstallationAuthenticationV1) =>
            t.verifier.authenticate(input),
          withLock: <T>(operationUnderLock: () => T): T =>
            t.verifier.withLock(() => {
              const value = operationUnderLock();
              if (armed) {
                // The owner has completed its decision but the host-key write lock
                // is still held. A revoker on a second connection must wait.
                releaseWorker(state);
                awaitState(state, 2);
                expect(Atomics.wait(state, 0, 2, 150)).toBe("timed-out");
                expect(Atomics.load(state, 0)).toBe(2);
              }
              return value;
            }),
        };
        const o = new SqliteScaActivationOwner({
          ...t.options,
          installation_authenticator: instrumented,
        });
        try {
          armed = true;
          const receipt = operation === "consume" ? o.consume(t.f.view) : undefined;
          if (operation === "verify") expect(verify(o, t.f)).toBe(true);
          else expect(receipt?.decision).toBe("consumed");
          armed = false;
          await finished;
          expect(ledgerStatus(t.keys, kind, id)).toBe("revoked");
          expect(consumptionState(t.dir)).toEqual(
            operation === "consume"
              ? { state: "consumed", run: t.f.view.activation_run_id }
              : { state: "installed", run: null }
          );
          expect(verify(o, t.f)).toBe(false);
          expect(() => o.consume(t.f.view)).toThrow("authentication denied");
          expect(() => o.install(t.f.installation)).toThrow("authentication denied");
          if (receipt !== undefined) {
            expect(() => o.consume({ ...t.f.view, activation_run_id: "another-run" })).toThrow();
            expect(() => o.consume({ ...t.f.view, checked_at: "2026-09-23T11:00:00Z" })).toThrow();
          }
        } finally {
          armed = false;
          releaseWorker(state);
          await worker.terminate();
          await finished.catch(() => undefined);
          o.close();
          t.verifier.close();
        }
      });
    }
  }
  it("provisions create-never private and public state, signs explicitly, installs and rechecks on use", () => {
    const t = setup();
    try {
      expect(() =>
        ScaHostKeyInstallation.open(path.join(path.dirname(t.dir), "absent"), "host-one")
      ).toThrow();
      expect(() => ScaHostKeyInstallation.provision(t.keys, "host-one")).toThrow();
      expect(verify(t.o, t.f)).toBe(false);
      expect(() => t.o.install(t.f.installation)).toThrow("authentication denied");
      expect(t.verifier.signGrant("grant-one", t.operands)).toEqual({
        grant_id: "grant-one",
        key_id: t.key,
      });
      expect(() => t.verifier.signGrant("grant-one", t.operands)).toThrow();
      expect(lstatSync(t.keys).mode & 0o777).toBe(0o700);
      expect(lstatSync(path.join(t.keys, `${t.key}.pk8`)).mode & 0o777).toBe(0o600);
      expect(lstatSync(path.join(t.keys, "sca-host-keys.sqlite")).mode & 0o777).toBe(0o600);
      expect(
        t.verifier.authenticate({ ...t.operands, ref: { ...t.operands.ref, producer: "other" } })
      ).toBe(false);
      expect(
        t.verifier.authenticate({
          ...t.operands,
          scope: { ...t.operands.scope, project_id: "other" },
        })
      ).toBe(false);
      expect(
        t.verifier.authenticate({
          ...t.operands,
          authority: { ...t.operands.authority, authority_sha256: HASH },
        })
      ).toBe(false);
      t.o.install(t.f.installation);
      expect(verify(t.o, t.f)).toBe(true);
      expect(t.o.consume(t.f.view).decision).toBe("consumed");
      t.verifier.revokeGrant("grant-one");
      expect(verify(t.o, t.f)).toBe(false);
      expect(() => t.o.consume(t.f.view)).toThrow("authentication denied");
    } finally {
      t.o.close();
      t.verifier.close();
    }
  });
  it("survives rotation and restart, and key revocation denies already installed grants", () => {
    const t = setup();
    t.verifier.signGrant("grant-one", t.operands);
    t.o.install(t.f.installation);
    const replacement = t.verifier.provisionKey();
    expect(replacement).not.toBe(t.key);
    expect(verify(t.o, t.f)).toBe(true); // old public key is verify-only
    t.o.close();
    t.verifier.close();
    const reopened = ScaHostKeyInstallation.open(t.keys, "host-one", () => NOW);
    const owner2 = new SqliteScaActivationOwner({
      ...t.options,
      installation_authenticator: reopened,
    });
    try {
      expect(verify(owner2, t.f)).toBe(true);
      rmSync(path.join(t.keys, `${replacement}.pk8`));
      expect(verify(owner2, t.f)).toBe(true); // verification uses pinned public state
      const another = fixture("another").installation;
      expect(() =>
        reopened.signGrant("another", { ...another, scope: another.authority.scope })
      ).toThrow();
      reopened.revokeKey(t.key);
      expect(verify(owner2, t.f)).toBe(false);
      expect(() => owner2.consume(t.f.view)).toThrow("authentication denied");
      expect(() => owner2.install(t.f.installation)).toThrow("authentication denied");
    } finally {
      owner2.close();
      reopened.close();
    }
  });
  it("rejects canonical ambiguity, replay, expiry, custody loss and leaks no secret in API responses", () => {
    const t = setup();
    try {
      const grant = t.verifier.signGrant("grant-one", t.operands);
      const privateBytes = readFileSync(path.join(t.keys, `${t.key}.pk8`));
      expect(JSON.stringify(grant)).not.toContain(privateBytes.toString("base64"));
      expect(JSON.stringify(grant)).not.toContain("signature");
      const db = openSqlite(path.join(t.keys, "sca-host-keys.sqlite"));
      const stored = db.prepare("SELECT envelope FROM grants WHERE id='grant-one'").get();
      if (stored === undefined || typeof stored.envelope !== "string")
        throw new Error("missing grant");
      const envelopeText = stored.envelope;
      const valid = Buffer.from(envelopeText);
      expect(parseScaHostKeyEnvelopeV1(valid).payload.grant_id).toBe("grant-one");
      expect(() =>
        parseScaHostKeyEnvelopeV1(
          Buffer.from(envelopeText.replace('"payload":', '"payload":null,"payload":'))
        )
      ).toThrow();
      expect(() => parseScaHostKeyEnvelopeV1(Buffer.from(` ${envelopeText}`))).toThrow();
      expect(() =>
        parseScaHostKeyEnvelopeV1(
          Buffer.from(
            envelopeText.replace('"grant_id":"grant-one"', '"grant_id":"grant-one","unexpected":1')
          )
        )
      ).toThrow();
      expect(() => parseScaHostKeyEnvelopeV1(Buffer.from([0xff]))).toThrow();
      expect(() => parseScaHostKeyEnvelopeV1(Buffer.alloc(32_769, 0x20))).toThrow();
      const forged = envelopeText.replace(
        '"host_installation_id":"host-one"',
        '"host_installation_id":"host-two"'
      );
      db.prepare("UPDATE grants SET envelope=? WHERE id='grant-one'").run(forged);
      expect(t.verifier.authenticate(t.operands)).toBe(false);
      const signaturePrefix = /"signature":"(.)/u.exec(envelopeText);
      if (signaturePrefix === null) throw new Error("missing signature");
      const badSignature = envelopeText.replace(
        /"signature":"./u,
        `"signature":"${signaturePrefix[1] === "A" ? "B" : "A"}`
      );
      db.prepare("UPDATE grants SET envelope=? WHERE id='grant-one'").run(badSignature);
      expect(t.verifier.authenticate(t.operands)).toBe(false);
      db.prepare("UPDATE grants SET envelope=? WHERE id='grant-one'").run(` ${envelopeText}`);
      db.close();
      expect(t.verifier.authenticate(t.operands)).toBe(false);
      expect(() => t.o.install(t.f.installation)).toThrow("authentication denied");
      expect(() => ScaHostKeyInstallation.open(t.keys, "other-host")).toThrow("identity mismatch");
      chmodSync(t.keys, 0o755);
      expect(t.verifier.authenticate(t.operands)).toBe(false);
    } finally {
      t.o.close();
      t.verifier.close();
    }
    const later = setup(() => NOW + 60_000);
    try {
      later.verifier.signGrant("grant-later", later.operands);
      expect(later.verifier.authenticate(later.operands)).toBe(false);
    } finally {
      later.o.close();
      later.verifier.close();
    }
  });
  it("denies future, expiry, key substitution, symlink and hardlink custody failures", () => {
    let clock = NOW - 120_000;
    const t = setup(() => clock);
    try {
      t.verifier.signGrant("grant-one", t.operands);
      expect(t.verifier.authenticate(t.operands)).toBe(false); // issuer time is still future
      clock = NOW;
      expect(t.verifier.authenticate(t.operands)).toBe(true);
      const db = openSqlite(path.join(t.keys, "sca-host-keys.sqlite"));
      const original = db.prepare("SELECT public_der FROM keys WHERE id=?").get(t.key);
      if (original === undefined || typeof original.public_der !== "string")
        throw new Error("missing public key");
      db.prepare("UPDATE keys SET public_der=? WHERE id=?").run(
        Buffer.alloc(44).toString("base64"),
        t.key
      );
      expect(t.verifier.authenticate(t.operands)).toBe(false);
      db.prepare("UPDATE keys SET public_der=? WHERE id=?").run(original.public_der, t.key);
      db.close();
      const privatePath = path.join(t.keys, `${t.key}.pk8`);
      const parked = path.join(t.keys, "parked.pk8");
      renameSync(privatePath, parked);
      symlinkSync(parked, privatePath);
      const other = fixture("other").installation;
      const otherOperands = { ...other, scope: other.authority.scope };
      expect(() => t.verifier.signGrant("other-grant", otherOperands)).toThrow();
      rmSync(privatePath);
      linkSync(parked, privatePath);
      expect(() => t.verifier.signGrant("other-grant", otherOperands)).toThrow();
      expect(() => t.verifier.provisionKey()).not.toThrow(); // rotation does not need the old private key
      clock = NOW + 60_000;
      expect(t.verifier.authenticate(t.operands)).toBe(false);
    } finally {
      t.o.close();
      t.verifier.close();
    }
  });
});
