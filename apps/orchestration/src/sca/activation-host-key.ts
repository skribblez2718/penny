import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { currentArtifactRef } from "../artifact-store.js";
import { ArtifactRefSchema, validateContract } from "../contracts.js";
import {
  assertOwnerFile,
  assertSafeAncestorChain,
  ensureOwnerDirectory,
  fsyncDirectory,
} from "../state/custody.js";
import { OwnerSqliteDatabase } from "../state/owner-sqlite.js";
import {
  OpaqueIdSchema,
  Rfc3339UtcSchema,
  assertOpaqueId,
  assertRfc3339Utc,
} from "../skill-contracts/common.js";
import {
  ScaActivationAuthorityV1Schema,
  ScaActivationIssuanceV1Schema,
  ScaActivationScopeV1Schema,
  validateScaActivationAuthorityV1,
  validateScaActivationIssuanceV1,
} from "./qualification-activation-contracts.js";
import type {
  ScaActivationInstallationAuthenticationV1,
  ScaActivationInstallationAuthenticator,
} from "./activation-owner.js";

const DOMAIN = "penny.sca-activation.host-key-installation.v1";
const DB_NAME = "sca-host-keys.sqlite";
const MAX_ENVELOPE_BYTES = 32_768;
const DDL = [
  "CREATE TABLE host (id TEXT PRIMARY KEY, active_key TEXT)",
  "CREATE TABLE keys (id TEXT PRIMARY KEY, public_der TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','verify-only','revoked')))",
  "CREATE TABLE grants (id TEXT PRIMARY KEY, issuance_id TEXT NOT NULL UNIQUE, authority_id TEXT NOT NULL UNIQUE, nonce TEXT NOT NULL UNIQUE, envelope TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','revoked')))",
] as const;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const PayloadSchema = Type.Object(
  {
    domain: Type.Literal(DOMAIN),
    schema_version: Type.Literal(1),
    host_installation_id: OpaqueIdSchema,
    key_id: OpaqueIdSchema,
    grant_id: OpaqueIdSchema,
    issuer_policy_id: OpaqueIdSchema,
    operator_principal_id: OpaqueIdSchema,
    revocation_generation: Type.Integer({ minimum: 0, maximum: 2_147_483_647 }),
    issued_at: Rfc3339UtcSchema,
    not_before: Rfc3339UtcSchema,
    expires_at: Rfc3339UtcSchema,
    authority: ScaActivationAuthorityV1Schema,
    record: ScaActivationIssuanceV1Schema,
    ref: ArtifactRefSchema,
    scope: ScaActivationScopeV1Schema,
  },
  { additionalProperties: false }
);
export type ScaHostKeyPayloadV1 = Readonly<Static<typeof PayloadSchema>>;
const EnvelopeSchema = Type.Object(
  {
    payload: PayloadSchema,
    signature: Type.String({ minLength: 88, maxLength: 88, pattern: B64.source }),
  },
  { additionalProperties: false }
);
export type ScaHostKeyEnvelopeV1 = Readonly<Static<typeof EnvelopeSchema>>;

function encoded(value: unknown): string {
  const text = canonicalJson(value);
  if (Buffer.byteLength(text, "utf8") > MAX_ENVELOPE_BYTES)
    throw new Error("SCA host-key envelope too large");
  return text;
}
function parseCanonical(text: string): unknown {
  if (Buffer.byteLength(text, "utf8") > MAX_ENVELOPE_BYTES)
    throw new Error("SCA host-key envelope too large");
  const value: unknown = JSON.parse(text);
  if (encoded(value) !== text) throw new Error("SCA host-key noncanonical JSON");
  return value;
}
function base64(text: string, bytes: number): Buffer {
  if (!B64.test(text)) throw new Error("SCA host-key encoding denied");
  const result = Buffer.from(text, "base64");
  if (result.length !== bytes || result.toString("base64") !== text)
    throw new Error("SCA host-key encoding denied");
  return result;
}
function keyId(publicDer: Buffer): string {
  return `key_${sha256(Buffer.concat([Buffer.from("penny.sca-host-key.ed25519.spki.v1\0"), publicDer]))}`;
}
function validOperands(
  input: ScaActivationInstallationAuthenticationV1
): ScaActivationInstallationAuthenticationV1 {
  const authority = validateScaActivationAuthorityV1(input.authority);
  const record = validateScaActivationIssuanceV1(input.record);
  const ref = currentArtifactRef(input.ref);
  const scope = authority.scope;
  if (
    encoded(scope) !== encoded(input.scope) ||
    encoded(ref) !== encoded(currentArtifactRef(authority.issuance_record_ref)) ||
    record.authority_id !== scope.authority_id ||
    record.operator_principal_id !== scope.operator_principal_id ||
    record.issuer_policy_id !== scope.issuer_policy_id ||
    record.issued_at !== scope.issued_at ||
    record.scope_sha256 !== sha256(encoded(scope)) ||
    ref.content_digest !== sha256(encoded(record)) ||
    ref.byte_length !== Buffer.byteLength(encoded(record), "utf8")
  )
    throw new Error("SCA host-key operands conflict");
  return { authority, record, ref, scope };
}
function validatePayload(input: unknown): ScaHostKeyPayloadV1 {
  const payload = validateContract(PayloadSchema, input, "SCA host-key payload");
  for (const id of [
    payload.host_installation_id,
    payload.key_id,
    payload.grant_id,
    payload.issuer_policy_id,
    payload.operator_principal_id,
  ])
    assertOpaqueId(id, "SCA host-key ID");
  if (!/^key_[a-f0-9]{64}$/u.test(payload.key_id)) throw new Error("SCA host-key ID denied");
  for (const time of [payload.issued_at, payload.not_before, payload.expires_at])
    assertRfc3339Utc(time, "SCA host-key time");
  const operands = validOperands(payload);
  if (
    payload.issued_at !== operands.scope.issued_at ||
    payload.not_before !== operands.scope.not_before ||
    payload.expires_at !== operands.scope.expires_at ||
    payload.issuer_policy_id !== operands.scope.issuer_policy_id ||
    payload.operator_principal_id !== operands.scope.operator_principal_id ||
    payload.revocation_generation !== operands.scope.revocation_generation ||
    Date.parse(payload.issued_at) > Date.parse(payload.not_before) ||
    Date.parse(payload.not_before) >= Date.parse(payload.expires_at)
  )
    throw new Error("SCA host-key payload conflict");
  return payload;
}
/** Parse exact canonical UTF-8 JSON. Duplicate/unknown members and alternative encodings cannot survive reserialization. */
export function parseScaHostKeyEnvelopeV1(bytes: Uint8Array): ScaHostKeyEnvelopeV1 {
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) throw new Error("SCA host-key envelope too large");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = validateContract(EnvelopeSchema, parseCanonical(text), "SCA host-key envelope");
  validatePayload(value.payload);
  base64(value.signature, 64);
  return value;
}
function row(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("SCA host-key ledger row absent");
  return Object.fromEntries(Object.entries(value));
}
function field(value: Record<string, unknown>, name: string): string {
  const v = value[name];
  if (typeof v !== "string") throw new Error("SCA host-key ledger corrupt");
  return v;
}
function writeExclusive(file: string, bytes: Uint8Array, directory: string): void {
  // Publish a fully fsynced file with a create-never hard link. Crashes before
  // publication leave only a pending file; a crash before unlink fails custody
  // (nlink=2) instead of exposing an incomplete key at its final name.
  const pending = path.join(directory, `.pending-key-${randomUUID()}`);
  const fd = openSync(
    pending,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    try {
      fchmodSync(fd, 0o600);
      let written = 0;
      while (written < bytes.length)
        written += writeSync(fd, bytes, written, bytes.length - written);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(pending, file); // EEXIST never replaces an existing key
  } finally {
    unlinkSync(pending);
  }
  fsyncDirectory(directory);
  assertOwnerFile(file, "SCA host-key private key");
}

/** Host-key-authenticated only: same-UID code can access the key and is NOT proven human. */
export class ScaHostKeyInstallation implements ScaActivationInstallationAuthenticator, Disposable {
  readonly authenticator_id: string;
  private readonly db: OwnerSqliteDatabase;
  private readonly directory: string;
  private readonly hostId: string;
  private readonly now: () => number;

  private constructor(
    directory: string,
    hostId: string,
    mode: "existing" | "provision",
    now: () => number
  ) {
    assertOpaqueId(hostId, "host installation ID");
    if (!path.isAbsolute(directory)) throw new Error("SCA host-key state path must be absolute");
    this.hostId = hostId;
    this.authenticator_id = `sca-host-key-v1:${hostId}`;
    assertOpaqueId(this.authenticator_id, "authenticator ID");
    this.directory = path.resolve(directory);
    assertSafeAncestorChain(this.directory, "SCA host-key ledger");
    this.now = now;
    this.db = new OwnerSqliteDatabase({
      directory: this.directory,
      databaseName: DB_NAME,
      label: "SCA host-key ledger",
      mode,
    });
    try {
      if (mode === "provision")
        this.db.transaction(() => {
          if (
            Number(row(this.db.db.prepare("PRAGMA user_version").get())["user_version"]) !== 0 ||
            this.db.db
              .prepare("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")
              .all().length !== 0
          )
            throw new Error("SCA host-key ledger already provisioned");
          for (const statement of DDL) this.db.db.exec(statement);
          this.db.db.exec("PRAGMA user_version=1");
          this.db.db.prepare("INSERT INTO host VALUES (?,NULL)").run(hostId);
        });
      this.check();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  /** Explicit state creation; never called by runtime open or owner construction. */
  static provision(
    directory: string,
    hostInstallationId: string,
    now: () => number = Date.now
  ): ScaHostKeyInstallation {
    assertOpaqueId(hostInstallationId, "host installation ID");
    if (!path.isAbsolute(directory)) throw new Error("SCA host-key state path must be absolute");
    ensureOwnerDirectory(directory, "SCA host-key ledger");
    return new ScaHostKeyInstallation(directory, hostInstallationId, "provision", now);
  }
  static open(
    directory: string,
    hostInstallationId: string,
    now: () => number = Date.now
  ): ScaHostKeyInstallation {
    return new ScaHostKeyInstallation(directory, hostInstallationId, "existing", now);
  }
  private check(): void {
    this.db.assertCustody();
    if (Number(row(this.db.db.prepare("PRAGMA user_version").get())["user_version"]) !== 1)
      throw new Error("SCA host-key ledger incompatible schema");
    const objects = this.db.db
      .prepare(
        "SELECT type,name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name"
      )
      .all();
    if (
      objects.length !== DDL.length ||
      objects.some((object, index) => {
        const actual = row(object);
        const expected = DDL.find((statement) =>
          statement.startsWith(`CREATE TABLE ${String(actual["name"])} (`)
        );
        return (
          field(actual, "type") !== "table" ||
          expected === undefined ||
          field(actual, "sql") !== expected ||
          ["grants", "host", "keys"][index] !== field(actual, "name")
        );
      })
    )
      throw new Error("SCA host-key ledger layout mismatch");
    const hosts = this.db.db.prepare("SELECT id FROM host").all();
    if (hosts.length !== 1 || field(row(hosts[0]), "id") !== this.hostId)
      throw new Error("SCA host-key identity mismatch");
  }
  /** A BEGIN IMMEDIATE lock serializes revoke/rotation with owner install and consume commits. */
  withLock<T>(operation: () => T): T {
    return this.db.transaction(() => {
      this.check();
      return operation();
    });
  }
  /** Explicit create-never provisioning and rotation. The old key remains verify-only. */
  provisionKey(): string {
    const pair = generateKeyPairSync("ed25519");
    const publicDer = pair.publicKey.export({ format: "der", type: "spki" });
    const privateDer = pair.privateKey.export({ format: "der", type: "pkcs8" });
    const id = keyId(publicDer);
    this.withLock(() => {
      if (this.db.db.prepare("SELECT id FROM keys WHERE id=?").get(id) !== undefined)
        throw new Error("SCA host-key already provisioned");
      writeExclusive(path.join(this.directory, `${id}.pk8`), privateDer, this.directory);
      this.db.db.prepare("UPDATE keys SET status='verify-only' WHERE status='active'").run();
      this.db.db
        .prepare("INSERT INTO keys VALUES (?,?,'active')")
        .run(id, publicDer.toString("base64"));
      this.db.db.prepare("UPDATE host SET active_key=? WHERE id=?").run(id, this.hostId);
    });
    return id;
  }
  revokeKey(id: string): void {
    assertOpaqueId(id, "key ID");
    this.withLock(() => {
      const changed = this.db.db.prepare("UPDATE keys SET status='revoked' WHERE id=?").run(id);
      if (Number(changed.changes) !== 1) throw new Error("SCA host-key absent");
      this.db.db.prepare("UPDATE host SET active_key=NULL WHERE active_key=?").run(id);
    });
  }
  revokeGrant(id: string): void {
    assertOpaqueId(id, "grant ID");
    this.withLock(() => {
      const changed = this.db.db.prepare("UPDATE grants SET status='revoked' WHERE id=?").run(id);
      if (Number(changed.changes) !== 1) throw new Error("SCA host-key grant absent");
    });
  }
  /** Sign validated complete operands, not a caller-supplied payload. Does not install or start anything. */
  signGrant(
    grantId: string,
    input: ScaActivationInstallationAuthenticationV1
  ): { readonly grant_id: string; readonly key_id: string } {
    assertOpaqueId(grantId, "grant ID");
    const operands = validOperands(input);
    return this.withLock(() => {
      const active = field(
        row(this.db.db.prepare("SELECT active_key FROM host WHERE id=?").get(this.hostId)),
        "active_key"
      );
      if (!/^key_[a-f0-9]{64}$/u.test(active)) throw new Error("SCA host-key signer ID malformed");
      const key = row(
        this.db.db.prepare("SELECT public_der,status FROM keys WHERE id=?").get(active)
      );
      if (field(key, "status") !== "active") throw new Error("SCA host-key signer disabled");
      const file = path.join(this.directory, `${active}.pk8`);
      assertOwnerFile(file, "SCA host-key private key");
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let secret: Buffer;
      try {
        const before = fstatSync(fd);
        const atPath = lstatSync(file);
        if (
          !before.isFile() ||
          before.size < 1 ||
          before.size > 4096 ||
          before.nlink !== 1 ||
          (before.mode & 0o777) !== 0o600 ||
          before.dev !== atPath.dev ||
          before.ino !== atPath.ino ||
          (typeof process.geteuid === "function" && before.uid !== process.geteuid())
        )
          throw new Error("SCA host-key private key custody lost");
        secret = readFileSync(fd);
      } finally {
        closeSync(fd);
      }
      const privateKey = createPrivateKey({
        key: secret,
        format: "der",
        type: "pkcs8",
      });
      const publicDer = base64(field(key, "public_der"), 44);
      if (
        privateKey.asymmetricKeyType !== "ed25519" ||
        keyId(publicDer) !== active ||
        !createPublicKey(privateKey).equals(
          createPublicKey({ key: publicDer, format: "der", type: "spki" })
        )
      )
        throw new Error("SCA host-key signer mismatch");
      const scope = operands.scope;
      const payload = validatePayload({
        domain: DOMAIN,
        schema_version: 1,
        host_installation_id: this.hostId,
        key_id: active,
        grant_id: grantId,
        issuer_policy_id: scope.issuer_policy_id,
        operator_principal_id: scope.operator_principal_id,
        revocation_generation: scope.revocation_generation,
        issued_at: scope.issued_at,
        not_before: scope.not_before,
        expires_at: scope.expires_at,
        ...operands,
      });
      const signature = sign(null, Buffer.from(encoded(payload), "utf8"), privateKey).toString(
        "base64"
      );
      const envelope = encoded({ payload, signature });
      const parsed = parseScaHostKeyEnvelopeV1(Buffer.from(envelope));
      if (!this.verifyEnvelope(parsed, operands))
        throw new Error("SCA host-key self verification denied");
      this.db.db
        .prepare("INSERT INTO grants VALUES (?,?,?,?,?,'active')")
        .run(grantId, operands.record.issuance_id, scope.authority_id, scope.nonce, envelope);
      return { grant_id: grantId, key_id: active };
    });
  }
  /** Called under withLock by the owner. Never trusts a supplied key or grant status. */
  authenticate(input: ScaActivationInstallationAuthenticationV1): boolean {
    try {
      this.check();
      const operands = validOperands(input);
      const matches = this.db.db
        .prepare("SELECT id,envelope,status FROM grants WHERE issuance_id=?")
        .all(operands.record.issuance_id);
      if (matches.length !== 1) return false;
      const grant = row(matches[0]);
      if (field(grant, "status") !== "active") return false;
      const envelope = parseScaHostKeyEnvelopeV1(Buffer.from(field(grant, "envelope"), "utf8"));
      if (
        field(grant, "id") !== envelope.payload.grant_id ||
        !this.verifyEnvelope(envelope, operands)
      )
        return false;
      const now = this.now();
      return (
        Number.isFinite(now) &&
        Date.parse(envelope.payload.issued_at) <= now &&
        Date.parse(envelope.payload.not_before) <= now &&
        now < Date.parse(envelope.payload.expires_at)
      );
    } catch {
      return false;
    }
  }
  private verifyEnvelope(
    envelope: ScaHostKeyEnvelopeV1,
    operands: ScaActivationInstallationAuthenticationV1
  ): boolean {
    const payload = validatePayload(envelope.payload);
    if (
      payload.host_installation_id !== this.hostId ||
      encoded({
        authority: payload.authority,
        record: payload.record,
        ref: payload.ref,
        scope: payload.scope,
      }) !== encoded(operands)
    )
      return false;
    const key = row(
      this.db.db.prepare("SELECT public_der,status FROM keys WHERE id=?").get(payload.key_id)
    );
    if (field(key, "status") !== "active" && field(key, "status") !== "verify-only") return false;
    const der = Buffer.from(field(key, "public_der"), "base64");
    if (der.toString("base64") !== field(key, "public_der") || keyId(der) !== payload.key_id)
      return false;
    const publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
    return (
      publicKey.asymmetricKeyType === "ed25519" &&
      verify(null, Buffer.from(encoded(payload), "utf8"), publicKey, base64(envelope.signature, 64))
    );
  }
  close(): void {
    this.db.close();
  }
  [Symbol.dispose](): void {
    this.close();
  }
}
