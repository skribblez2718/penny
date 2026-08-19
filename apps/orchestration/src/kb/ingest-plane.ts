/**
 * The KB ingest plane — the deterministic host I/O the playbook performs between
 * agent phases.
 *
 * ## Why this is an interface
 *
 * The playbook is the host-side orchestrator for KB, so it genuinely owns the
 * sealing, gating, and publication steps: these are not agent work, and there is no
 * directive action for "the host does something deterministic" (adding one would
 * expand the engine's directive contract and touch every consumer plus research
 * parity, to express something only KB needs).
 *
 * Putting that I/O behind this interface keeps two properties that matter:
 *
 * - the playbook's state machine stays testable without a filesystem, and
 * - the KB's privacy rules stay in the KB modules that already enforce them, rather
 *   than being re-implemented inside a playbook.
 *
 * ## Roots are resolved here, never accepted
 *
 * `resolveKbRoot` derives the root from the project root and a **validated** profile
 * id. A profile id reaches this code from a model-facing tool parameter, so it is
 * validated against the opaque-id contract before it is ever used as a path segment;
 * a root supplied by a caller is ignored rather than trusted.
 */

import path from "node:path";

import { isValidProfileId } from "./profile-registry.js";
import {
  approveGate,
  claimCapabilities,
  denyGate,
  findGateForRun,
  persistIngestGate,
  sourcesFromCapabilities,
  type GateState,
} from "./gate.js";
import { RunArtifactStore } from "./run-artifacts.js";
import { writeSourceObject, writeSourceRecord } from "./filesystem.js";
import { sha256Hex } from "./contracts.js";
import { sourceRecordFor } from "./ingest.js";

export interface KbSealInput {
  readonly kbRoot: string;
  readonly runId: string;
  readonly artifactIds: readonly string[];
}

export interface KbGateInput {
  readonly kbRoot: string;
  readonly profileId: string;
  readonly runId: string;
  /**
   * Ids of the sealed artifacts, in phase order.
   *
   * Ids rather than handles: the playbook holds only handles-as-ids in control
   * state, and the plane resolves the full records from the content plane. Letting
   * the caller pass partial handle objects is how a gate once got written with
   * `undefined` fields — unparseable JSON that readers then skipped as "no gate".
   */
  readonly artifactIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly capabilityIds: readonly string[];
}

export interface KbPublishOutcome {
  readonly generationId: string;
  readonly counts: Record<string, number>;
}

/**
 * Deterministic KB operations the playbook performs itself.
 *
 * Every method is synchronous. KB storage is synchronous by construction
 * (`node:sqlite` plus atomic file replacement), which is what lets the playbook's
 * `acceptSummary`/`resume` remain ordinary synchronous state transitions.
 */
export interface KbIngestPlaneV1 {
  /**
   * Bind the admitted source capabilities to this run, all-or-none.
   *
   * Claiming happens before any phase work: a capability that cannot be claimed
   * (expired, replayed, already bound to another run) must stop the run before an
   * agent reads anything, not after.
   */
  claim(input: { kbRoot: string; capabilityIds: readonly string[]; runId: string }): void;
  /**
   * Admit the run's sources into the publication plane (content-addressed
   * objects + records), re-verifying each against its capability envelope.
   *
   * Approval publishes the source objects this admits, so it must happen
   * before any agent reads — the agents then see exactly what will be
   * published.
   */
  admit(input: { kbRoot: string; capabilityIds: readonly string[]; runId: string }): void;
  /** Seal the exact candidate set, freezing what the review gate will offer. */
  seal(input: KbSealInput): void;
  /** Persist the review gate, bound to the sealed set and the base generation. */
  persistGate(input: KbGateInput): GateState;
  /** Publish an approved gate. Consumes the bound capability leases. */
  approve(input: { kbRoot: string; runId: string }): KbPublishOutcome;
  /** Deny a pending gate. Publishes nothing and invalidates the leases. */
  deny(input: { kbRoot: string; runId: string }): void;
}

/**
 * Resolve the KB root for one profile.
 *
 * Throws on an invalid profile id rather than normalizing it: an id that fails the
 * opaque-id contract is a refusal, not something to sanitize into a path.
 */
export function resolveKbRoot(projectRoot: string, profileId: string): string {
  if (!isValidProfileId(profileId)) {
    throw new Error(`kb_profile_id '${profileId}' is not a valid opaque profile id`);
  }
  return path.join(projectRoot, ".penny", "kb", profileId);
}

/** The real plane, over the existing KB modules. */
export function defaultKbIngestPlane(): KbIngestPlaneV1 {
  return {
    claim(input) {
      claimCapabilities(input.kbRoot, input.capabilityIds, input.runId);
    },
    admit(input) {
      // Host reads, re-verified against the envelope; the file must still match
      // its mint-time digest or the admit refuses.
      const sources = sourcesFromCapabilities(input.kbRoot, input.capabilityIds);
      for (const src of sources) {
        writeSourceObject(input.kbRoot, sha256Hex(src.content), Buffer.from(src.content, "utf8"));
        writeSourceRecord(input.kbRoot, sourceRecordFor(src, input.runId));
      }
    },
    seal(input) {
      const store = new RunArtifactStore(input.kbRoot, input.runId);
      try {
        store.seal(input.artifactIds);
      } finally {
        store.close();
      }
    },
    persistGate(input) {
      const store = new RunArtifactStore(input.kbRoot, input.runId);
      let handles: Record<string, unknown>[];
      try {
        handles = input.artifactIds.map((id) => {
          const { handle } = store.read(id);
          return handle as unknown as Record<string, unknown>;
        });
      } finally {
        store.close();
      }
      return persistIngestGate(
        input.kbRoot,
        input.profileId,
        input.runId,
        handles,
        input.sourceIds,
        input.capabilityIds
      );
    },
    approve(input) {
      const gate = findGateForRun(input.kbRoot, input.runId);
      if (gate === undefined) {
        throw new Error(`no content-review gate exists for run '${input.runId}'`);
      }
      // Source content is re-resolved from the bound capabilities so the approval
      // path re-verifies digests instead of trusting anything carried in run state.
      const sources = sourcesFromCapabilities(input.kbRoot, gate.source_capability_ids ?? []);
      const { result } = approveGate(input.kbRoot, sources, input.runId);
      const generationId = (result.ids ?? []).find((id) => id.startsWith("gen_")) ?? "";
      return { generationId, counts: result.counts ?? {} };
    },
    deny(input) {
      denyGate(input.kbRoot, input.runId);
    },
  };
}
