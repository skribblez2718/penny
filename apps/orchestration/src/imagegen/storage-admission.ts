import { randomBytes } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { OwnerSqliteDatabase } from "../state/owner-sqlite.js";
import {
  IMAGEGEN_MAX_RUN_STORAGE_BYTES,
  ImagegenStorageCommitReceiptV1Schema,
  ImagegenStorageReleaseReceiptV1Schema,
  ImagegenStorageReservationReceiptV1Schema,
  type ImagegenStorageCommitReceiptV1,
  type ImagegenStorageReleaseReceiptV1,
  type ImagegenStorageReservationReceiptV1,
} from "../skill-contracts/imagegen.js";
import { assertOpaqueId, validateSkillSchema } from "../skill-contracts/common.js";
import type { ImagegenStorageAdmission, ImagegenStorageReservationInputV1 } from "./types.js";

const STORAGE_SCHEMA_VERSION = 1 as const;
const STORAGE_DATABASE_NAME = "imagegen-storage.sqlite";

interface ReservationRow extends Record<string, SQLOutputValue> {
  reservation_id: string;
  run_id: string;
  admission_sha256: string;
  requested_seed: number | null;
  base_seed: number;
  reserved_bytes: number;
  committed_bytes: number;
  state: "active" | "released";
  receipt_jcs: string;
  created_at: string;
  updated_at: string;
}

function isSqliteRow(value: unknown): value is Record<string, SQLOutputValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(
    (item) =>
      item === null ||
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "bigint" ||
      item instanceof Uint8Array
  );
}

function rowText(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`imagegen storage row '${key}' is not text`);
  return value;
}

function rowInteger(
  row: Record<string, SQLOutputValue>,
  key: string,
  nullable = false
): number | null {
  const value = row[key];
  if (nullable && value === null) return null;
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    throw new Error(`imagegen storage row '${key}' is not an integer`);
  }
  return number;
}

function parseReservationRow(value: unknown): ReservationRow {
  if (!isSqliteRow(value)) throw new Error("imagegen storage reservation row is malformed");
  const state = rowText(value, "state");
  if (state !== "active" && state !== "released") {
    throw new Error("imagegen storage reservation state is invalid");
  }
  return {
    reservation_id: rowText(value, "reservation_id"),
    run_id: rowText(value, "run_id"),
    admission_sha256: rowText(value, "admission_sha256"),
    requested_seed: rowInteger(value, "requested_seed", true),
    base_seed: rowInteger(value, "base_seed") ?? 0,
    reserved_bytes: rowInteger(value, "reserved_bytes") ?? 0,
    committed_bytes: rowInteger(value, "committed_bytes") ?? 0,
    state,
    receipt_jcs: rowText(value, "receipt_jcs"),
    created_at: rowText(value, "created_at"),
    updated_at: rowText(value, "updated_at"),
  };
}

function parseJson(text: string, label: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new Error(`${label} is not JSON`);
  }
}

function safeInteger(value: number, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer no less than ${minimum}`);
  }
  return value;
}

function randomUint32(): number {
  return randomBytes(4).readUInt32BE(0);
}

/** Durable transactional reservation authority for one caller-selected image artifact partition. */
export class SqliteImagegenStorageAdmission implements ImagegenStorageAdmission, Disposable {
  private readonly store: OwnerSqliteDatabase;
  private readonly ceilingBytes: number;
  private readonly warningThresholdBytes: number;
  private readonly now: () => number;

  constructor(input: {
    readonly directory: string;
    readonly ceiling_bytes: number;
    readonly warning_threshold_bytes: number;
    readonly mode?: "provision" | "existing";
    readonly now?: () => number;
  }) {
    this.ceilingBytes = safeInteger(input.ceiling_bytes, "imagegen storage ceiling", 1);
    this.warningThresholdBytes = safeInteger(
      input.warning_threshold_bytes,
      "imagegen storage warning threshold"
    );
    if (
      this.ceilingBytes > IMAGEGEN_MAX_RUN_STORAGE_BYTES ||
      this.warningThresholdBytes > this.ceilingBytes
    ) {
      throw new Error("imagegen storage limits exceed the supported partition policy");
    }
    this.now = input.now ?? Date.now;
    this.store = new OwnerSqliteDatabase({
      directory: input.directory,
      databaseName: STORAGE_DATABASE_NAME,
      label: "Penny imagegen storage admission",
      mode: input.mode ?? "provision",
    });
    if ((input.mode ?? "provision") === "provision") this.provisionSchema();
    this.assertSchemaAndPolicy();
  }

  reserve(input: ImagegenStorageReservationInputV1): ImagegenStorageReservationReceiptV1 {
    assertOpaqueId(input.run_id, "imagegen storage reservation run_id");
    if (!/^[a-f0-9]{64}$/u.test(input.admission_sha256)) {
      throw new Error("imagegen storage admission digest is invalid");
    }
    safeInteger(input.requested_bytes, "imagegen requested reservation", 1);
    if (input.requested_bytes > this.ceilingBytes) {
      throw new Error("imagegen storage reservation exceeds the partition ceiling");
    }
    if (
      input.requested_seed !== null &&
      (!Number.isInteger(input.requested_seed) ||
        input.requested_seed < 0 ||
        input.requested_seed > 0xffff_ffff)
    ) {
      throw new Error("imagegen requested seed is not an unsigned 32-bit integer");
    }
    return this.store.transaction(() => {
      const existingValue = this.store.db
        .prepare("SELECT * FROM imagegen_storage_reservations WHERE run_id = ?")
        .get(input.run_id);
      if (existingValue !== undefined) {
        const existing = parseReservationRow(existingValue);
        if (
          existing.state !== "active" ||
          existing.admission_sha256 !== input.admission_sha256 ||
          existing.reserved_bytes !== input.requested_bytes ||
          existing.requested_seed !== input.requested_seed
        ) {
          throw new Error("imagegen storage reservation conflicts with durable admission");
        }
        return this.reservationReceipt(existing);
      }
      const used = this.accountedBytes();
      if (used + input.requested_bytes > this.ceilingBytes) {
        throw new Error("imagegen storage partition is saturated");
      }
      const baseSeed = input.requested_seed ?? randomUint32();
      const reservationId = `imgres_${sha256(
        canonicalJson({
          schema_version: 1,
          run_id: input.run_id,
          admission_sha256: input.admission_sha256,
        })
      )}`;
      const createdAt = new Date(this.now()).toISOString();
      const receipt = validateSkillSchema(
        ImagegenStorageReservationReceiptV1Schema,
        {
          schema_id: "penny.image-storage-reservation-receipt.v1",
          schema_version: 1,
          reservation_id: reservationId,
          run_id: input.run_id,
          admission_sha256: input.admission_sha256,
          reserved_bytes: input.requested_bytes,
          base_seed: baseSeed,
          partition_ceiling_bytes: this.ceilingBytes,
          warning_threshold_bytes: this.warningThresholdBytes,
          guaranteed_remaining_bytes: this.ceilingBytes - used - input.requested_bytes,
          state: "active",
          created_at: createdAt,
        },
        "ImagegenStorageReservationReceiptV1"
      );
      this.store.db
        .prepare(
          `INSERT INTO imagegen_storage_reservations(
             reservation_id, run_id, admission_sha256, requested_seed, base_seed,
             reserved_bytes, committed_bytes, state, receipt_jcs, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?)`
        )
        .run(
          reservationId,
          input.run_id,
          input.admission_sha256,
          input.requested_seed,
          baseSeed,
          input.requested_bytes,
          canonicalJson(receipt),
          createdAt,
          createdAt
        );
      return receipt;
    });
  }

  commit(input: {
    readonly reservation_id: string;
    readonly commit_key: string;
    readonly byte_length: number;
  }): ImagegenStorageCommitReceiptV1 {
    assertOpaqueId(input.reservation_id, "imagegen storage reservation ID");
    assertOpaqueId(input.commit_key, "imagegen storage commit key");
    safeInteger(input.byte_length, "imagegen storage committed bytes");
    return this.store.transaction(() => {
      const reservation = this.requiredReservation(input.reservation_id);
      if (reservation.state !== "active") {
        throw new Error("imagegen storage reservation is no longer active");
      }
      const existing = this.store.db
        .prepare(
          `SELECT receipt_jcs, byte_length FROM imagegen_storage_commits
           WHERE reservation_id = ? AND commit_key = ?`
        )
        .get(input.reservation_id, input.commit_key);
      if (existing !== undefined) {
        if (!isSqliteRow(existing) || rowInteger(existing, "byte_length") !== input.byte_length) {
          throw new Error("imagegen storage commit key conflicts with durable bytes");
        }
        return validateSkillSchema(
          ImagegenStorageCommitReceiptV1Schema,
          parseJson(rowText(existing, "receipt_jcs"), "imagegen storage commit receipt"),
          "ImagegenStorageCommitReceiptV1"
        );
      }
      const committedTotal = reservation.committed_bytes + input.byte_length;
      if (committedTotal > reservation.reserved_bytes) {
        throw new Error("imagegen storage commit exceeds its reserved bytes");
      }
      const committedAt = new Date(this.now()).toISOString();
      const commitId = `imgcommit_${sha256(
        canonicalJson({
          reservation_id: input.reservation_id,
          commit_key: input.commit_key,
          byte_length: input.byte_length,
        })
      )}`;
      const receipt = validateSkillSchema(
        ImagegenStorageCommitReceiptV1Schema,
        {
          schema_id: "penny.image-storage-commit-receipt.v1",
          schema_version: 1,
          commit_id: commitId,
          reservation_id: input.reservation_id,
          commit_key: input.commit_key,
          committed_delta_bytes: input.byte_length,
          committed_total_bytes: committedTotal,
          reserved_bytes: reservation.reserved_bytes,
          committed_at: committedAt,
        },
        "ImagegenStorageCommitReceiptV1"
      );
      this.store.db
        .prepare(
          `INSERT INTO imagegen_storage_commits(
             commit_id, reservation_id, commit_key, byte_length, receipt_jcs, committed_at
           ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          commitId,
          input.reservation_id,
          input.commit_key,
          input.byte_length,
          canonicalJson(receipt),
          committedAt
        );
      const updated = this.store.db
        .prepare(
          `UPDATE imagegen_storage_reservations
           SET committed_bytes = ?, updated_at = ?
           WHERE reservation_id = ? AND state = 'active' AND committed_bytes = ?`
        )
        .run(committedTotal, committedAt, input.reservation_id, reservation.committed_bytes);
      if (Number(updated.changes) !== 1) throw new Error("imagegen storage commit lost its CAS");
      return receipt;
    });
  }

  release(reservationId: string): ImagegenStorageReleaseReceiptV1 {
    assertOpaqueId(reservationId, "imagegen storage reservation ID");
    return this.store.transaction(() => {
      const reservation = this.requiredReservation(reservationId);
      const existing = this.store.db
        .prepare("SELECT receipt_jcs FROM imagegen_storage_releases WHERE reservation_id = ?")
        .get(reservationId);
      if (existing !== undefined) {
        if (!isSqliteRow(existing)) throw new Error("imagegen storage release row is malformed");
        return validateSkillSchema(
          ImagegenStorageReleaseReceiptV1Schema,
          parseJson(rowText(existing, "receipt_jcs"), "imagegen storage release receipt"),
          "ImagegenStorageReleaseReceiptV1"
        );
      }
      if (reservation.state !== "active") {
        throw new Error("released imagegen storage reservation lacks its exact receipt");
      }
      const releasedAt = new Date(this.now()).toISOString();
      const unused = reservation.reserved_bytes - reservation.committed_bytes;
      const releaseId = `imgrelease_${sha256(
        canonicalJson({
          reservation_id: reservationId,
          committed_bytes: reservation.committed_bytes,
        })
      )}`;
      const receipt = validateSkillSchema(
        ImagegenStorageReleaseReceiptV1Schema,
        {
          schema_id: "penny.image-storage-release-receipt.v1",
          schema_version: 1,
          release_id: releaseId,
          reservation_id: reservationId,
          committed_bytes_retained: reservation.committed_bytes,
          unused_bytes_released: unused,
          released_at: releasedAt,
        },
        "ImagegenStorageReleaseReceiptV1"
      );
      const updated = this.store.db
        .prepare(
          `UPDATE imagegen_storage_reservations SET state = 'released', updated_at = ?
           WHERE reservation_id = ? AND state = 'active'`
        )
        .run(releasedAt, reservationId);
      if (Number(updated.changes) !== 1) throw new Error("imagegen storage release lost its CAS");
      this.store.db
        .prepare(
          `INSERT INTO imagegen_storage_releases(
             release_id, reservation_id, receipt_jcs, released_at
           ) VALUES (?, ?, ?, ?)`
        )
        .run(releaseId, reservationId, canonicalJson(receipt), releasedAt);
      return receipt;
    });
  }

  reservation(reservationId: string): ImagegenStorageReservationReceiptV1 | undefined {
    assertOpaqueId(reservationId, "imagegen storage reservation ID");
    this.store.assertCustody();
    const value = this.store.db
      .prepare("SELECT * FROM imagegen_storage_reservations WHERE reservation_id = ?")
      .get(reservationId);
    if (value === undefined) return undefined;
    const row = parseReservationRow(value);
    return row.state === "active" ? this.reservationReceipt(row) : undefined;
  }

  close(): void {
    this.store.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private provisionSchema(): void {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS imagegen_storage_policy (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        ceiling_bytes INTEGER NOT NULL,
        warning_threshold_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS imagegen_storage_reservations (
        reservation_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        admission_sha256 TEXT NOT NULL,
        requested_seed INTEGER,
        base_seed INTEGER NOT NULL,
        reserved_bytes INTEGER NOT NULL,
        committed_bytes INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'released')),
        receipt_jcs TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(committed_bytes >= 0 AND committed_bytes <= reserved_bytes)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS imagegen_storage_commits (
        commit_id TEXT PRIMARY KEY,
        reservation_id TEXT NOT NULL REFERENCES imagegen_storage_reservations(reservation_id),
        commit_key TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        receipt_jcs TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        UNIQUE(reservation_id, commit_key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS imagegen_storage_releases (
        release_id TEXT PRIMARY KEY,
        reservation_id TEXT NOT NULL UNIQUE REFERENCES imagegen_storage_reservations(reservation_id),
        receipt_jcs TEXT NOT NULL,
        released_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version=${STORAGE_SCHEMA_VERSION};
    `);
    const existing = this.store.db
      .prepare(
        "SELECT ceiling_bytes, warning_threshold_bytes FROM imagegen_storage_policy WHERE singleton = 1"
      )
      .get();
    if (existing === undefined) {
      this.store.db
        .prepare(
          `INSERT INTO imagegen_storage_policy(
             singleton, ceiling_bytes, warning_threshold_bytes, created_at
           ) VALUES (1, ?, ?, ?)`
        )
        .run(this.ceilingBytes, this.warningThresholdBytes, new Date(this.now()).toISOString());
    }
  }

  private assertSchemaAndPolicy(): void {
    this.store.assertCustody();
    const version = this.store.db.prepare("PRAGMA user_version").get();
    if (!isSqliteRow(version) || rowInteger(version, "user_version") !== STORAGE_SCHEMA_VERSION) {
      throw new Error(`imagegen storage admission requires schema ${STORAGE_SCHEMA_VERSION}`);
    }
    const policy = this.store.db
      .prepare(
        "SELECT ceiling_bytes, warning_threshold_bytes FROM imagegen_storage_policy WHERE singleton = 1"
      )
      .get();
    if (
      !isSqliteRow(policy) ||
      rowInteger(policy, "ceiling_bytes") !== this.ceilingBytes ||
      rowInteger(policy, "warning_threshold_bytes") !== this.warningThresholdBytes
    ) {
      throw new Error("imagegen storage runtime policy diverges from durable policy");
    }
  }

  private accountedBytes(): number {
    const value = this.store.db
      .prepare(
        `SELECT COALESCE(SUM(
           CASE WHEN state = 'active' THEN reserved_bytes ELSE committed_bytes END
         ), 0) AS used_bytes FROM imagegen_storage_reservations`
      )
      .get();
    if (!isSqliteRow(value)) throw new Error("imagegen storage accounting row is malformed");
    return rowInteger(value, "used_bytes") ?? 0;
  }

  private requiredReservation(reservationId: string): ReservationRow {
    const value = this.store.db
      .prepare("SELECT * FROM imagegen_storage_reservations WHERE reservation_id = ?")
      .get(reservationId);
    if (value === undefined) throw new Error("imagegen storage reservation does not exist");
    return parseReservationRow(value);
  }

  private reservationReceipt(row: ReservationRow): ImagegenStorageReservationReceiptV1 {
    const receipt = validateSkillSchema(
      ImagegenStorageReservationReceiptV1Schema,
      parseJson(row.receipt_jcs, "imagegen storage reservation receipt"),
      "ImagegenStorageReservationReceiptV1"
    );
    if (
      receipt.reservation_id !== row.reservation_id ||
      receipt.run_id !== row.run_id ||
      receipt.admission_sha256 !== row.admission_sha256 ||
      receipt.base_seed !== row.base_seed ||
      receipt.reserved_bytes !== row.reserved_bytes
    ) {
      throw new Error("imagegen storage reservation receipt diverges from its row");
    }
    return receipt;
  }
}
