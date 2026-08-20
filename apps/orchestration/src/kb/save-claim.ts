/**
 * §5.6 save-query claims — the single-use right to publish one query's answer.
 *
 * ## Why this exists
 *
 * A useful query does not authorize a save. `save` must name the exact prior
 * query run it is proposing to publish, and this store is what turns that name
 * into an authority that can be spent exactly once. Without it, one sealed
 * answer could be saved repeatedly, or two concurrent saves could both believe
 * they own the same answer.
 *
 * ## The ratchet
 *
 * ```text
 *   available ──claim──> claimed ──reserve──> commit_reserved ──selector──> consumed
 *       ^                   │                        │
 *       └──deny/abort───────┘                        └──pre-selector abort──> invalidated
 *        (only while the sealed answer is still valid)
 * ```
 *
 * `commit_reserved` is the point of no return: it can never go back to
 * `available` and never transfers to another save run. A publish that fails
 * after reservation invalidates rather than releases, because the host cannot
 * prove from the outside whether the selector moved — and re-saving a possibly
 * published answer is worse than refusing a legitimate retry.
 *
 * ## Where claims live
 *
 * In the owner-only host control plane (`.penny/kb-save-claims/<profile>/`),
 * never inside the KB root. A claim is control state, and §5.6's no-write rule
 * for `query` permits control-plane writes but not KB-root ones — a claim
 * written under the KB root would put a query in breach of its own contract.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  validateKbContract,
  SaveKbRequestSchema,
  SaveQueryClaimSchema,
  type SaveKbRequest,
  type SaveQueryClaim,
  type SaveQueryClaimState,
  type Sha256Hex,
} from "./contracts.js";

/** A claim operation refused; nothing was mutated. */
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

function ownerUid(): number | undefined {
  try {
    return typeof process.getuid === "function" ? process.getuid() : undefined;
  } catch {
    return undefined;
  }
}

function assertSafeDir(dir: string): void {
  const st = lstatSync(dir);
  if (!st.isDirectory())
    throw new SaveClaimError("claim_malformed", `claim store is not a directory: ${dir}`);
  if (st.mode & 0o022)
    throw new SaveClaimError("claim_malformed", "claim store is group/other writable");
  const uid = ownerUid();
  if (uid !== undefined && st.uid !== uid) {
    throw new SaveClaimError("claim_malformed", "claim store is not current-user-owned");
  }
}

function assertSafeFile(file: string): void {
  const st = lstatSync(file);
  if (!st.isFile())
    throw new SaveClaimError("claim_malformed", `claim entry is not a regular file: ${file}`);
  if (st.nlink !== 1)
    throw new SaveClaimError(
      "claim_malformed",
      `claim entry has an unexpected link count: ${file}`
    );
  if (st.mode & 0o022)
    throw new SaveClaimError("claim_malformed", "claim entry is group/other writable");
  const uid = ownerUid();
  if (uid !== undefined && st.uid !== uid) {
    throw new SaveClaimError("claim_malformed", "claim entry is not current-user-owned");
  }
}

/** The owner-only claim store for one KB profile. */
export class SaveQueryClaimStore {
  private readonly dirPath: string;

  constructor(dir: string) {
    this.dirPath = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    assertSafeDir(dir);
  }

  get dir(): string {
    return this.dirPath;
  }

  private fileFor(queryRunId: string): string {
    // query_run_id is schema-validated as an opaque id (no separators or "..").
    return path.join(this.dirPath, `${queryRunId}.json`);
  }

  /**
   * Create the one claim a completed query with a sealed answer is entitled to.
   *
   * Exclusive by construction (`flag: "wx"`): a second create for the same query
   * run cannot silently replace the first and mint a second right to save.
   */
  create(input: {
    query_run_id: string;
    kb_profile_id: string;
    kb_id: string;
    answer_artifact_id: string;
    answer_sha256: Sha256Hex;
  }): SaveQueryClaim {
    const now = new Date().toISOString();
    const claim: SaveQueryClaim = {
      schema_version: 1,
      query_run_id: input.query_run_id,
      kb_profile_id: input.kb_profile_id,
      kb_id: input.kb_id,
      answer_artifact_id: input.answer_artifact_id,
      answer_sha256: input.answer_sha256,
      state: "available",
      created_at: now,
      updated_at: now,
    };
    try {
      validateKbContract(SaveQueryClaimSchema, claim, "save claim");
    } catch {
      throw new SaveClaimError(
        "claim_malformed",
        "refusing to write a claim that fails its own contract"
      );
    }
    const file = this.fileFor(input.query_run_id);
    const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(tmp, JSON.stringify(claim, null, 2), { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    try {
      // `link` is atomic AND fails when the destination exists. `rename` would
      // silently overwrite, which for a create means quietly minting a second
      // right to save an answer that may already be claimed or spent.
      linkSync(tmp, file);
    } catch {
      throw new SaveClaimError(
        "claim_not_available",
        `a save claim already exists for query run '${input.query_run_id}'`
      );
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // best effort; the claim itself is already linked into place
      }
    }
    chmodSync(file, 0o600);
    return claim;
  }

  /** Read one claim exactly, or refuse. Never returns a partial or defaulted row. */
  load(queryRunId: string): SaveQueryClaim {
    assertSafeDir(this.dirPath);
    const file = this.fileFor(queryRunId);
    if (!existsSync(file)) {
      throw new SaveClaimError(
        "claim_missing",
        `no save claim exists for query run '${queryRunId}'`
      );
    }
    assertSafeFile(file);
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new SaveClaimError("claim_malformed", `save claim is unparseable for '${queryRunId}'`);
    }
    try {
      return validateKbContract(SaveQueryClaimSchema, doc, "save claim");
    } catch {
      throw new SaveClaimError(
        "claim_malformed",
        `save claim failed closed validation for '${queryRunId}'`
      );
    }
  }

  /** Read without throwing when absent (operator listings, best-effort checks). */
  find(queryRunId: string): SaveQueryClaim | undefined {
    try {
      return this.load(queryRunId);
    } catch {
      return undefined;
    }
  }

  private write(claim: SaveQueryClaim): SaveQueryClaim {
    const next = { ...claim, updated_at: new Date().toISOString() };
    try {
      validateKbContract(SaveQueryClaimSchema, next, "save claim");
    } catch {
      throw new SaveClaimError(
        "claim_malformed",
        "refusing to write a claim that fails its own contract"
      );
    }
    const file = this.fileFor(next.query_run_id);
    const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
    chmodSync(file, 0o600);
    return next;
  }

  /**
   * CAS `available → claimed(save_run_id, transaction_id)`.
   *
   * This is the first thing a save does and it happens BEFORE any side effect,
   * so a drifted, consumed, or already-claimed answer stops the save before it
   * composes, reads, or writes anything.
   */
  claimForSave(input: {
    query_run_id: string;
    kb_profile_id: string;
    save_run_id: string;
    save_transaction_id: string;
    /** The sealed answer digest as it is RIGHT NOW; must equal the claim's. */
    answer_sha256: Sha256Hex;
  }): SaveQueryClaim {
    const claim = this.load(input.query_run_id);
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
    if (claim.state !== "available") {
      throw new SaveClaimError(
        "claim_not_available",
        `the save claim is '${claim.state}', not available; another save owns it`
      );
    }
    if (claim.answer_sha256 !== input.answer_sha256) {
      // The sealed answer is not the one the claim was minted over.
      this.write({ ...claim, state: "invalidated" });
      throw new SaveClaimError(
        "claim_answer_drift",
        "the sealed query answer changed since its claim was created; claim invalidated"
      );
    }
    return this.write({
      ...claim,
      state: "claimed",
      save_run_id: input.save_run_id,
      save_transaction_id: input.save_transaction_id,
    });
  }

  /**
   * CAS `claimed → commit_reserved` for the same save transaction, immediately
   * before publication. After this the claim can only reach `consumed` or
   * `invalidated` — never `available`, and never another save run.
   */
  reserveCommit(input: { query_run_id: string; save_run_id: string }): SaveQueryClaim {
    const claim = this.load(input.query_run_id);
    if (claim.state === "commit_reserved") return claim; // idempotent within the transaction
    if (claim.state !== "claimed") {
      throw new SaveClaimError("claim_not_available", `cannot reserve a '${claim.state}' claim`);
    }
    if (claim.save_run_id !== input.save_run_id) {
      throw new SaveClaimError("claim_wrong_save_run", "the claim is held by a different save run");
    }
    return this.write({ ...claim, state: "commit_reserved" });
  }

  /** Selector evidence: the publication happened, so the claim is spent. */
  consume(input: { query_run_id: string; save_run_id: string }): SaveQueryClaim {
    const claim = this.load(input.query_run_id);
    if (claim.state === "consumed") return claim;
    if (claim.state !== "commit_reserved") {
      throw new SaveClaimError(
        "claim_not_available",
        `only a commit_reserved claim may be consumed; this one is '${claim.state}'`
      );
    }
    if (claim.save_run_id !== input.save_run_id) {
      throw new SaveClaimError("claim_wrong_save_run", "the claim is held by a different save run");
    }
    return this.write({ ...claim, state: "consumed" });
  }

  /**
   * Release an ordinary `claimed` row after a deny, pre-commit error, or
   * cancellation.
   *
   * Returns to `available` ONLY while the exact sealed answer is still valid;
   * otherwise the claim is invalidated. A `commit_reserved` row is never
   * released — it can only be consumed or invalidated.
   */
  release(input: {
    query_run_id: string;
    save_run_id: string;
    /** The sealed answer digest now, or `undefined` when it can no longer be read. */
    answer_sha256: Sha256Hex | undefined;
  }): SaveQueryClaim {
    const claim = this.load(input.query_run_id);
    if (claim.state === "commit_reserved") {
      throw new SaveClaimError(
        "claim_not_available",
        "a commit_reserved claim cannot be released; it is consumed or invalidated"
      );
    }
    if (claim.state !== "claimed") return claim;
    if (claim.save_run_id !== input.save_run_id) {
      throw new SaveClaimError("claim_wrong_save_run", "the claim is held by a different save run");
    }
    if (input.answer_sha256 === undefined || input.answer_sha256 !== claim.answer_sha256) {
      return this.write({ ...claim, state: "invalidated" });
    }
    const { save_run_id: _run, save_transaction_id: _tx, ...rest } = claim;
    return this.write({ ...rest, state: "available" });
  }

  /** A proven pre-selector abort, or any state a save must not resume from. */
  invalidate(queryRunId: string): SaveQueryClaim {
    const claim = this.load(queryRunId);
    if (claim.state === "consumed") return claim; // never un-spend a publication
    return this.write({ ...claim, state: "invalidated" });
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

/**
 * The claim for one query run, or `undefined` when none exists.
 *
 * Used by the host to resolve which sealed artifact a save is entitled to read
 * before the run starts. Absence is a refusal at the caller, never a default.
 */
export function findSaveClaim(
  projectRoot: string,
  profileId: string,
  queryRunId: string
): SaveQueryClaim | undefined {
  try {
    return new SaveQueryClaimStore(saveClaimStoreDir(projectRoot, profileId)).find(queryRunId);
  } catch {
    return undefined;
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
