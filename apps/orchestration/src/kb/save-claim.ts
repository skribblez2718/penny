/**
 * §5.6 save-query claims — the single-use right to publish one query's answer.
 *
 * A useful query does not authorize a save. This owner-only SQLite store turns
 * one verified sealed answer into one transactional authority ratchet:
 *
 * ```text
 *   available ──claim──> claimed ──reserve──> commit_reserved ──selector──> consumed
 *       ^                   │                        │
 *       └──deny/abort───────┘                        └──pre-selector abort──> invalidated
 * ```
 *
 * WAL + synchronous=FULL `BEGIN IMMEDIATE` transactions are the cross-process
 * serialization boundary. Every update compares the exact prior state, run,
 * transaction, answer digest, timestamp, and internal row digest. Exact retries
 * are idempotent; a different process or owner loses. Legacy JSON authority is
 * never discovered or adopted by scanning and therefore fails closed.
 */

import path from "node:path";
import type { SQLOutputValue } from "node:sqlite";

import {
  canonicalJson,
  SaveKbRequestSchema,
  SaveQueryClaimSchema,
  sha256Hex,
  validateKbContract,
  type SaveKbRequest,
  type SaveQueryClaim,
  type SaveQueryClaimState,
  type Sha256Hex,
} from "./contracts.js";
import { OwnerSqliteDatabase } from "./owner-sqlite.js";

const SAVE_CLAIM_DATABASE = "claims.sqlite";

type SaveClaimLastTransition = "release" | "invalidate" | "answer_drift";

interface IndexedSaveClaim {
  readonly claim: SaveQueryClaim;
  readonly row_sha256: Sha256Hex;
  readonly last_save_run_id?: string;
  readonly last_save_transaction_id?: string;
  readonly last_transition?: SaveClaimLastTransition;
}

/** A claim operation refused; nothing was mutated unless the code says drift invalidated it. */
export class SaveClaimError extends Error {
  constructor(
    public readonly code: SaveClaimRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "SaveClaimError";
  }
}

export type SaveClaimRefusalCode =
  | "claim_missing"
  | "claim_malformed"
  | "claim_not_available"
  | "claim_consumed"
  | "claim_invalidated"
  | "claim_profile_mismatch"
  | "claim_answer_drift"
  | "claim_wrong_save_run";

function isLegacySaveClaimAuthorityFile(name: string): boolean {
  return name.endsWith(".json") || name.includes(".json.tmp-");
}

function requiredText(row: Record<string, SQLOutputValue>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new SaveClaimError("claim_malformed", `save claim field '${field}' is malformed`);
  }
  return value;
}

function optionalText(row: Record<string, SQLOutputValue>, field: string): string | undefined {
  const value = row[field];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new SaveClaimError("claim_malformed", `save claim field '${field}' is malformed`);
  }
  return value;
}

function indexedClaimDigest(input: {
  claim: SaveQueryClaim;
  last_save_run_id?: string;
  last_save_transaction_id?: string;
  last_transition?: SaveClaimLastTransition;
}): Sha256Hex {
  return sha256Hex(
    canonicalJson({
      schema_version: 1,
      claim: input.claim,
      ...(input.last_save_run_id !== undefined ? { last_save_run_id: input.last_save_run_id } : {}),
      ...(input.last_save_transaction_id !== undefined
        ? { last_save_transaction_id: input.last_save_transaction_id }
        : {}),
      ...(input.last_transition !== undefined ? { last_transition: input.last_transition } : {}),
    })
  );
}

function immutableClaimMatches(
  left: SaveQueryClaim,
  right: {
    query_run_id: string;
    kb_profile_id: string;
    kb_id: string;
    answer_artifact_id: string;
    answer_sha256: Sha256Hex;
  }
): boolean {
  return (
    left.query_run_id === right.query_run_id &&
    left.kb_profile_id === right.kb_profile_id &&
    left.kb_id === right.kb_id &&
    left.answer_artifact_id === right.answer_artifact_id &&
    left.answer_sha256 === right.answer_sha256
  );
}

/** The owner-only transactional claim store for one KB profile. */
export class SaveQueryClaimStore implements Disposable {
  private readonly storage: OwnerSqliteDatabase;

  constructor(dir: string) {
    let storage: OwnerSqliteDatabase | undefined;
    try {
      storage = new OwnerSqliteDatabase({
        directory: dir,
        databaseName: SAVE_CLAIM_DATABASE,
        label: "save-query claim store",
        isLegacyAuthorityFile: isLegacySaveClaimAuthorityFile,
      });
      storage.db.exec(`
        CREATE TABLE IF NOT EXISTS save_query_claims (
          query_run_id TEXT PRIMARY KEY,
          kb_profile_id TEXT NOT NULL,
          kb_id TEXT NOT NULL,
          answer_artifact_id TEXT NOT NULL,
          answer_sha256 TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN (
            'available','claimed','commit_reserved','consumed','invalidated'
          )),
          save_run_id TEXT,
          save_transaction_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_save_run_id TEXT,
          last_save_transaction_id TEXT,
          last_transition TEXT CHECK(last_transition IN ('release','invalidate','answer_drift')),
          row_sha256 TEXT NOT NULL,
          CHECK(
            (state = 'available' AND save_run_id IS NULL AND save_transaction_id IS NULL) OR
            (state IN ('claimed','commit_reserved','consumed') AND
              save_run_id IS NOT NULL AND save_transaction_id IS NOT NULL) OR
            (state = 'invalidated' AND
              ((save_run_id IS NULL AND save_transaction_id IS NULL) OR
               (save_run_id IS NOT NULL AND save_transaction_id IS NOT NULL)))
          ),
          CHECK(
            (last_save_run_id IS NULL AND last_save_transaction_id IS NULL) OR
            (last_save_run_id IS NOT NULL AND last_save_transaction_id IS NOT NULL)
          )
        );
      `);
    } catch (error) {
      storage?.close();
      throw new SaveClaimError(
        "claim_malformed",
        `save claim store failed closed: ${(error as Error).message}`
      );
    }
    this.storage = storage;
  }

  get dir(): string {
    return this.storage.directory;
  }

  /**
   * Create the one claim a completed query is entitled to. Concurrent exact
   * retries all observe the same row; a different immutable claim loses.
   */
  create(input: {
    query_run_id: string;
    kb_profile_id: string;
    kb_id: string;
    answer_artifact_id: string;
    answer_sha256: Sha256Hex;
  }): SaveQueryClaim {
    const now = new Date().toISOString();
    const claim = this.validateClaim({
      schema_version: 1,
      query_run_id: input.query_run_id,
      kb_profile_id: input.kb_profile_id,
      kb_id: input.kb_id,
      answer_artifact_id: input.answer_artifact_id,
      answer_sha256: input.answer_sha256,
      state: "available",
      created_at: now,
      updated_at: now,
    });
    return this.transact(() => {
      const existing = this.row(input.query_run_id);
      if (existing !== undefined) {
        const indexed = this.indexedFromRow(existing);
        if (immutableClaimMatches(indexed.claim, input)) return indexed.claim;
        throw new SaveClaimError(
          "claim_not_available",
          `a different save claim already exists for query run '${input.query_run_id}'`
        );
      }
      const rowSha256 = indexedClaimDigest({ claim });
      this.storage.db
        .prepare(
          `INSERT INTO save_query_claims (
             query_run_id, kb_profile_id, kb_id, answer_artifact_id, answer_sha256,
             state, save_run_id, save_transaction_id, created_at, updated_at,
             last_save_run_id, last_save_transaction_id, last_transition, row_sha256
           ) VALUES (?, ?, ?, ?, ?, 'available', NULL, NULL, ?, ?, NULL, NULL, NULL, ?)`
        )
        .run(
          claim.query_run_id,
          claim.kb_profile_id,
          claim.kb_id,
          claim.answer_artifact_id,
          claim.answer_sha256,
          claim.created_at,
          claim.updated_at,
          rowSha256
        );
      return claim;
    });
  }

  /** Read one exact indexed claim, or refuse. */
  load(queryRunId: string): SaveQueryClaim {
    this.assertCustody();
    const row = this.row(queryRunId);
    if (row === undefined) {
      throw new SaveClaimError(
        "claim_missing",
        `no save claim exists for query run '${queryRunId}'`
      );
    }
    return this.indexedFromRow(row).claim;
  }

  /** Read without throwing when absent or malformed (safe projection only). */
  find(queryRunId: string): SaveQueryClaim | undefined {
    try {
      return this.load(queryRunId);
    } catch {
      return undefined;
    }
  }

  /** Transactional CAS `available → claimed(save_run_id, transaction_id)`. */
  claimForSave(input: {
    query_run_id: string;
    kb_profile_id: string;
    save_run_id: string;
    save_transaction_id: string;
    /** The sealed answer digest as it is RIGHT NOW; must equal the claim's. */
    answer_sha256: Sha256Hex;
  }): SaveQueryClaim {
    const outcome = this.transact(() => {
      const current = this.requireIndexed(input.query_run_id);
      const claim = current.claim;
      if (claim.kb_profile_id !== input.kb_profile_id) {
        throw new SaveClaimError(
          "claim_profile_mismatch",
          "the claimed query run belongs to a different KB profile"
        );
      }
      if (claim.state === "consumed") {
        throw new SaveClaimError("claim_consumed", "that query answer has already been saved");
      }
      if (claim.state === "invalidated") {
        throw new SaveClaimError(
          "claim_invalidated",
          "that query answer's save claim is invalidated"
        );
      }
      if (claim.state === "claimed") {
        if (
          claim.save_run_id === input.save_run_id &&
          claim.save_transaction_id === input.save_transaction_id &&
          claim.answer_sha256 === input.answer_sha256
        ) {
          return { claim, drifted: false };
        }
        throw new SaveClaimError(
          "claim_not_available",
          "the save claim is not available; it is owned by another save run or transaction"
        );
      }
      if (claim.state !== "available") {
        throw new SaveClaimError(
          "claim_not_available",
          `the save claim is '${claim.state}', not available; another save owns it`
        );
      }
      if (claim.answer_sha256 !== input.answer_sha256) {
        const invalidated = this.transition(
          current,
          { ...claim, state: "invalidated", updated_at: new Date().toISOString() },
          { last_transition: "answer_drift" }
        );
        return { claim: invalidated.claim, drifted: true };
      }
      const claimed = this.transition(current, {
        ...claim,
        state: "claimed",
        save_run_id: input.save_run_id,
        save_transaction_id: input.save_transaction_id,
        updated_at: new Date().toISOString(),
      });
      return { claim: claimed.claim, drifted: false };
    });
    if (outcome.drifted) {
      throw new SaveClaimError(
        "claim_answer_drift",
        "the sealed query answer changed since its claim was created; claim invalidated"
      );
    }
    return outcome.claim;
  }

  /** CAS `claimed → commit_reserved` for the exact publication transaction. */
  reserveCommit(input: {
    query_run_id: string;
    save_run_id: string;
    publication_transaction_id?: string;
  }): SaveQueryClaim {
    return this.transact(() => {
      const current = this.requireIndexed(input.query_run_id);
      const claim = current.claim;
      if (claim.state === "commit_reserved") {
        if (
          claim.save_run_id === input.save_run_id &&
          (input.publication_transaction_id === undefined ||
            claim.save_transaction_id === input.publication_transaction_id)
        ) {
          return claim;
        }
        throw new SaveClaimError(
          "claim_wrong_save_run",
          "the claim is reserved by a different save run or publication transaction"
        );
      }
      if (claim.state !== "claimed") {
        throw new SaveClaimError("claim_not_available", `cannot reserve a '${claim.state}' claim`);
      }
      if (claim.save_run_id !== input.save_run_id || claim.save_transaction_id === undefined) {
        throw new SaveClaimError(
          "claim_wrong_save_run",
          "the claim is held by a different save run"
        );
      }
      return this.transition(current, {
        ...claim,
        state: "commit_reserved",
        save_transaction_id: input.publication_transaction_id ?? claim.save_transaction_id,
        updated_at: new Date().toISOString(),
      }).claim;
    });
  }

  /** Selector evidence: exact reserved publication transaction → consumed. */
  consume(input: {
    query_run_id: string;
    save_run_id: string;
    publication_transaction_id?: string;
  }): SaveQueryClaim {
    return this.transact(() => {
      const current = this.requireIndexed(input.query_run_id);
      const claim = current.claim;
      if (claim.state === "consumed") {
        if (
          claim.save_run_id === input.save_run_id &&
          (input.publication_transaction_id === undefined ||
            claim.save_transaction_id === input.publication_transaction_id)
        ) {
          return claim;
        }
        throw new SaveClaimError(
          "claim_wrong_save_run",
          "the claim was consumed by a different save run or publication transaction"
        );
      }
      if (claim.state !== "commit_reserved") {
        throw new SaveClaimError(
          "claim_not_available",
          `only a commit_reserved claim may be consumed; this one is '${claim.state}'`
        );
      }
      if (
        claim.save_run_id !== input.save_run_id ||
        claim.save_transaction_id === undefined ||
        (input.publication_transaction_id !== undefined &&
          claim.save_transaction_id !== input.publication_transaction_id)
      ) {
        throw new SaveClaimError(
          "claim_wrong_save_run",
          "the claim is held by a different save/publication transaction"
        );
      }
      return this.transition(current, {
        ...claim,
        state: "consumed",
        updated_at: new Date().toISOString(),
      }).claim;
    });
  }

  /**
   * Release an ordinary claimed row while its exact answer digest still holds.
   * Same-owner retries observe the prior release metadata; another owner loses.
   */
  release(input: {
    query_run_id: string;
    save_run_id: string;
    answer_sha256: Sha256Hex | undefined;
  }): SaveQueryClaim {
    return this.transact(() => {
      const current = this.requireIndexed(input.query_run_id);
      const claim = current.claim;
      const exactReleasedRetry =
        current.last_transition === "release" &&
        current.last_save_run_id === input.save_run_id &&
        (claim.state === "available" || claim.state === "invalidated");
      if (exactReleasedRetry) return claim;
      if (claim.state === "commit_reserved") {
        throw new SaveClaimError(
          "claim_not_available",
          "a commit_reserved claim cannot be released; it is consumed or invalidated"
        );
      }
      if (claim.state === "consumed") {
        if (claim.save_run_id !== input.save_run_id) {
          throw new SaveClaimError(
            "claim_wrong_save_run",
            "the claim was consumed by a different save run"
          );
        }
        throw new SaveClaimError(
          "claim_not_available",
          "a consumed claim has no releasable reservation"
        );
      }
      if (claim.state !== "claimed") {
        throw new SaveClaimError(
          "claim_not_available",
          `cannot release a '${claim.state}' claim without an exact prior release`
        );
      }
      if (claim.save_run_id !== input.save_run_id || claim.save_transaction_id === undefined) {
        throw new SaveClaimError(
          "claim_wrong_save_run",
          "the claim is held by a different save run"
        );
      }
      const metadata = {
        last_save_run_id: claim.save_run_id,
        last_save_transaction_id: claim.save_transaction_id,
        last_transition: "release" as const,
      };
      if (input.answer_sha256 === undefined || input.answer_sha256 !== claim.answer_sha256) {
        return this.transition(
          current,
          { ...claim, state: "invalidated", updated_at: new Date().toISOString() },
          metadata
        ).claim;
      }
      const {
        save_run_id: _saveRunId,
        save_transaction_id: _saveTransactionId,
        ...withoutOwner
      } = claim;
      return this.transition(
        current,
        { ...withoutOwner, state: "available", updated_at: new Date().toISOString() },
        metadata
      ).claim;
    });
  }

  /** A proven pre-selector abort; a consumed claim is never un-spent. */
  invalidate(queryRunId: string, saveRunId?: string): SaveQueryClaim {
    return this.transact(() => {
      const current = this.requireIndexed(queryRunId);
      const claim = current.claim;
      const ownerMatches =
        saveRunId === undefined ||
        claim.save_run_id === saveRunId ||
        current.last_save_run_id === saveRunId;
      if (!ownerMatches) {
        throw new SaveClaimError(
          "claim_wrong_save_run",
          "the claim is held by a different save run"
        );
      }
      if (claim.state === "consumed" || claim.state === "invalidated") return claim;
      if (saveRunId !== undefined && claim.save_run_id !== saveRunId) {
        throw new SaveClaimError(
          "claim_wrong_save_run",
          "only the exact owning save run may invalidate this claim"
        );
      }
      const metadata =
        claim.save_run_id !== undefined && claim.save_transaction_id !== undefined
          ? {
              last_save_run_id: claim.save_run_id,
              last_save_transaction_id: claim.save_transaction_id,
              last_transition: "invalidate" as const,
            }
          : { last_transition: "invalidate" as const };
      return this.transition(
        current,
        { ...claim, state: "invalidated", updated_at: new Date().toISOString() },
        metadata
      ).claim;
    });
  }

  close(): void {
    this.storage.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private validateClaim(raw: unknown): SaveQueryClaim {
    try {
      return validateKbContract(SaveQueryClaimSchema, raw, "save claim");
    } catch {
      throw new SaveClaimError("claim_malformed", "save claim failed closed validation");
    }
  }

  private assertCustody(): void {
    try {
      this.storage.assertCustody();
    } catch (error) {
      if (error instanceof SaveClaimError) throw error;
      throw new SaveClaimError(
        "claim_malformed",
        `save claim custody failed closed: ${(error as Error).message}`
      );
    }
  }

  private transact<T>(operation: () => T): T {
    try {
      return this.storage.transaction(operation);
    } catch (error) {
      if (error instanceof SaveClaimError) throw error;
      throw new SaveClaimError(
        "claim_malformed",
        `save claim transaction failed closed: ${(error as Error).message}`
      );
    }
  }

  private row(queryRunId: string): Record<string, SQLOutputValue> | undefined {
    return this.storage.db
      .prepare("SELECT * FROM save_query_claims WHERE query_run_id = ?")
      .get(queryRunId) as Record<string, SQLOutputValue> | undefined;
  }

  private requireIndexed(queryRunId: string): IndexedSaveClaim {
    const row = this.row(queryRunId);
    if (row === undefined) {
      throw new SaveClaimError(
        "claim_missing",
        `no save claim exists for query run '${queryRunId}'`
      );
    }
    return this.indexedFromRow(row);
  }

  private indexedFromRow(row: Record<string, SQLOutputValue>): IndexedSaveClaim {
    const queryRunId = requiredText(row, "query_run_id");
    const state = requiredText(row, "state") as SaveQueryClaimState;
    const saveRunId = optionalText(row, "save_run_id");
    const saveTransactionId = optionalText(row, "save_transaction_id");
    const lastSaveRunId = optionalText(row, "last_save_run_id");
    const lastSaveTransactionId = optionalText(row, "last_save_transaction_id");
    const rawLastTransition = optionalText(row, "last_transition");
    if (
      rawLastTransition !== undefined &&
      rawLastTransition !== "release" &&
      rawLastTransition !== "invalidate" &&
      rawLastTransition !== "answer_drift"
    ) {
      throw new SaveClaimError(
        "claim_malformed",
        `save claim '${queryRunId}' has malformed transition metadata`
      );
    }
    if ((lastSaveRunId === undefined) !== (lastSaveTransactionId === undefined)) {
      throw new SaveClaimError(
        "claim_malformed",
        `save claim '${queryRunId}' has partial prior ownership`
      );
    }
    const claim = this.validateClaim({
      schema_version: 1,
      query_run_id: queryRunId,
      kb_profile_id: requiredText(row, "kb_profile_id"),
      kb_id: requiredText(row, "kb_id"),
      answer_artifact_id: requiredText(row, "answer_artifact_id"),
      answer_sha256: requiredText(row, "answer_sha256"),
      state,
      ...(saveRunId !== undefined ? { save_run_id: saveRunId } : {}),
      ...(saveTransactionId !== undefined ? { save_transaction_id: saveTransactionId } : {}),
      created_at: requiredText(row, "created_at"),
      updated_at: requiredText(row, "updated_at"),
    });
    const ownedState = state === "claimed" || state === "commit_reserved" || state === "consumed";
    if (
      (ownedState && (saveRunId === undefined || saveTransactionId === undefined)) ||
      (state === "available" && (saveRunId !== undefined || saveTransactionId !== undefined)) ||
      (saveRunId === undefined) !== (saveTransactionId === undefined)
    ) {
      throw new SaveClaimError(
        "claim_malformed",
        `save claim '${queryRunId}' has malformed state ownership`
      );
    }
    const indexed: IndexedSaveClaim = {
      claim,
      row_sha256: requiredText(row, "row_sha256") as Sha256Hex,
      ...(lastSaveRunId !== undefined ? { last_save_run_id: lastSaveRunId } : {}),
      ...(lastSaveTransactionId !== undefined
        ? { last_save_transaction_id: lastSaveTransactionId }
        : {}),
      ...(rawLastTransition !== undefined ? { last_transition: rawLastTransition } : {}),
    };
    if (indexedClaimDigest(indexed) !== indexed.row_sha256) {
      throw new SaveClaimError(
        "claim_malformed",
        `save claim '${queryRunId}' state digest mismatch`
      );
    }
    return indexed;
  }

  private transition(
    current: IndexedSaveClaim,
    rawNextClaim: SaveQueryClaim,
    metadata: {
      last_save_run_id?: string;
      last_save_transaction_id?: string;
      last_transition?: SaveClaimLastTransition;
    } = {}
  ): IndexedSaveClaim {
    const nextClaim = this.validateClaim(rawNextClaim);
    const next: IndexedSaveClaim = {
      claim: nextClaim,
      row_sha256: indexedClaimDigest({ claim: nextClaim, ...metadata }),
      ...metadata,
    };
    const result = this.storage.db
      .prepare(
        `UPDATE save_query_claims
         SET state = ?, save_run_id = ?, save_transaction_id = ?, updated_at = ?,
             last_save_run_id = ?, last_save_transaction_id = ?, last_transition = ?,
             row_sha256 = ?
         WHERE query_run_id = ? AND kb_profile_id = ? AND kb_id = ?
           AND answer_artifact_id = ? AND answer_sha256 = ? AND state = ?
           AND save_run_id IS ? AND save_transaction_id IS ?
           AND created_at = ? AND updated_at = ? AND row_sha256 = ?`
      )
      .run(
        nextClaim.state,
        nextClaim.save_run_id ?? null,
        nextClaim.save_transaction_id ?? null,
        nextClaim.updated_at,
        next.last_save_run_id ?? null,
        next.last_save_transaction_id ?? null,
        next.last_transition ?? null,
        next.row_sha256,
        current.claim.query_run_id,
        current.claim.kb_profile_id,
        current.claim.kb_id,
        current.claim.answer_artifact_id,
        current.claim.answer_sha256,
        current.claim.state,
        current.claim.save_run_id ?? null,
        current.claim.save_transaction_id ?? null,
        current.claim.created_at,
        current.claim.updated_at,
        current.row_sha256
      );
    if (Number(result.changes) !== 1) {
      throw new SaveClaimError(
        "claim_not_available",
        `save claim '${current.claim.query_run_id}' lost its exact transition race`
      );
    }
    return next;
  }
}

/** The owner-only claim directory for one profile, outside the KB root. */
export function saveClaimStoreDir(projectRoot: string, profileId: string): string {
  return path.join(projectRoot, ".penny", "kb-save-claims", profileId);
}

/** §5.6 closed validation for the public `save` request. */
export function validateSaveRequest(raw: unknown): SaveKbRequest {
  return validateKbContract(SaveKbRequestSchema, raw, "save request");
}

/** The exact claim for one query run, or undefined on any fail-closed miss. */
export function findSaveClaim(
  projectRoot: string,
  profileId: string,
  queryRunId: string
): SaveQueryClaim | undefined {
  let store: SaveQueryClaimStore | undefined;
  try {
    store = new SaveQueryClaimStore(saveClaimStoreDir(projectRoot, profileId));
    return store.find(queryRunId);
  } catch {
    return undefined;
  } finally {
    store?.close();
  }
}

/** Bounded, body-free projection for operator listings and safe results. */
export function claimProjection(claim: SaveQueryClaim): {
  query_run_id: string;
  state: SaveQueryClaimState;
  save_run_id?: string;
} {
  return {
    query_run_id: claim.query_run_id,
    state: claim.state,
    ...(claim.save_run_id !== undefined ? { save_run_id: claim.save_run_id } : {}),
  };
}
