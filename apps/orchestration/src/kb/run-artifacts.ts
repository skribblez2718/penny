/**
 * KB run artifacts — §5.7 host-owned artifact content plane.
 *
 * Child bytes enter only through `stage_run_artifact`: the host rejects a
 * duplicate-key or schema-invalid JSON payload, validates the expected
 * producer/kind/media/count/size contract, canonicalizes the payload to JCS,
 * preindexes the exact keys/hash/length, and only then writes bytes. The model
 * receives a path-free handle.
 *
 * Lifecycle: prepared → staged → sealed → consumed. `submit_phase_result`
 * stores body-free metadata and seals its exact same-run/state handles in one
 * SQLite transaction. No assistant prose is an artifact or phase result.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  ReceiptConflictError,
  type Checkpointer,
  type KbArtifactIndexRecord,
  type KbArtifactLifecycle,
  type KbPhaseOperands,
  type KbPhaseOperandsRecord,
  type KbPhaseResultRecord,
} from "../checkpointer.js";
import { strictParseJson } from "./approval-receipts.js";
import {
  ArtifactKindSchema,
  ArtifactMediaTypeSchema,
  ClaimsArtifactSchema,
  ChildVerificationReportSchema,
  ExtractedClaimsArtifactSchema,
  LintReportArtifactSchema,
  PageDraftArtifactSchema,
  PromotionPatchArtifactSchema,
  PromotionPlanArtifactSchema,
  QueryAnswerArtifactSchema,
  VerificationReportArtifactSchema,
  canonicalJson,
  sha256Hex,
  validateKbContract,
  type ArtifactKind,
  type ArtifactMediaType,
  type ArtifactPayload,
  type KbArtifactHandle,
  type Sha256Hex,
} from "./contracts.js";

const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_MAX_ARTIFACTS = 8;
const OPAQUE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PAGE_HEADINGS = [
  "## Synthesis",
  "## Evidence",
  "## Tensions and unknowns",
  "## Related",
] as const;
const FORBIDDEN_RESULT_KEYS = new Set([
  "body",
  "content",
  "content_utf8",
  "markdown",
  "path",
  "relative_path",
  "replacement_utf8",
  "root",
  "locator",
]);

// ── Types (§5.7) ─────────────────────────────────────────────────────────────

/** Path-free artifact handle — the only artifact value a child or parent sees. */
export type ArtifactHandle = KbArtifactHandle;

export type ArtifactLifecycle = KbArtifactLifecycle;

/** Internal control-DB row — host-only and never returned from a public surface. */
export interface ArtifactIndexRecord extends KbArtifactIndexRecord {
  readonly sha256: Sha256Hex;
}

export const StageRunArtifactInputSchema = Type.Object(
  {
    schema_version: Type.Literal(1),
    artifact_kind: ArtifactKindSchema,
    media_type: ArtifactMediaTypeSchema,
    encoding: Type.Literal("utf8"),
    content: Type.String({ minLength: 2, maxLength: DEFAULT_MAX_BYTES }),
  },
  { additionalProperties: false }
);

/** Exact model input to `stage_run_artifact`; no run/state/profile/path field exists. */
export interface StageRunArtifactInput {
  schema_version: 1;
  artifact_kind: ArtifactKind;
  media_type: ArtifactMediaType;
  encoding: "utf8";
  content: string;
}

export interface StageRunArtifactResult {
  schema_version: 1;
  artifact: ArtifactHandle;
}

export class ArtifactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

function assertSegment(value: string, label: string): void {
  if (!OPAQUE_SEGMENT.test(value) || value.includes("..")) {
    throw new ArtifactStoreError(`${label}_invalid`);
  }
}

function validatePayload(
  kind: ArtifactKind,
  value: unknown,
  childProducer: boolean
): ArtifactPayload {
  try {
    switch (kind) {
      case "claims":
        validateKbContract(
          childProducer ? ExtractedClaimsArtifactSchema : ClaimsArtifactSchema,
          value,
          "claims artifact"
        );
        break;
      case "page_draft":
        validateKbContract(PageDraftArtifactSchema, value, "page draft artifact");
        break;
      case "query_answer":
        validateKbContract(QueryAnswerArtifactSchema, value, "query answer artifact");
        break;
      case "lint_report":
        validateKbContract(LintReportArtifactSchema, value, "lint report artifact");
        break;
      case "verification_report":
        validateKbContract(
          childProducer ? ChildVerificationReportSchema : VerificationReportArtifactSchema,
          value,
          "verification report artifact"
        );
        break;
      case "promotion_plan":
        validateKbContract(PromotionPlanArtifactSchema, value, "promotion plan artifact");
        break;
      case "promotion_patch":
        validateKbContract(PromotionPatchArtifactSchema, value, "promotion patch artifact");
        break;
    }
  } catch {
    // Validation diagnostics can contain model-authored member names. They stay
    // out of tool/public errors; the caller receives one bounded code.
    throw new ArtifactStoreError("artifact_payload_invalid");
  }

  const payload = value as ArtifactPayload;
  if (payload.artifact_kind !== kind) throw new ArtifactStoreError("artifact_kind_mismatch");

  if (kind === "claims") {
    const claims = value as {
      source_ids: string[];
      claims: Array<{
        claim_id?: string;
        provisional_id?: string;
        evidence: Array<{ source_id: string }>;
      }>;
    };
    unique(
      claims.claims.map((claim) => claim.claim_id ?? claim.provisional_id ?? ""),
      "artifact_claim_ids_duplicate"
    );
    const sources = new Set(claims.source_ids);
    if (
      claims.claims.some((claim) => claim.evidence.some((entry) => !sources.has(entry.source_id)))
    ) {
      throw new ArtifactStoreError("artifact_claim_source_not_admitted");
    }
  }

  if (kind === "page_draft") {
    const draft = value as {
      pages: Array<{
        frontmatter: { page_id: string; revision_id: string };
        markdown: string;
        claims: { page_id: string; revision_id: string; claims: Array<{ claim_id: string }> };
      }>;
    };
    unique(
      draft.pages.map((page) => page.frontmatter.page_id),
      "artifact_page_ids_duplicate"
    );
    for (const page of draft.pages) {
      if (
        page.frontmatter.page_id !== page.claims.page_id ||
        page.frontmatter.revision_id !== page.claims.revision_id
      ) {
        throw new ArtifactStoreError("artifact_page_sidecar_mismatch");
      }
      unique(
        page.claims.claims.map((claim) => claim.claim_id),
        "artifact_claim_ids_duplicate"
      );
      const headings = page.markdown.match(/^## .+$/gmu) ?? [];
      if (
        childProducer &&
        (headings.length !== PAGE_HEADINGS.length ||
          headings.some((heading, index) => heading !== PAGE_HEADINGS[index]))
      ) {
        throw new ArtifactStoreError("artifact_page_headings_invalid");
      }
      if (page.markdown.includes("\r") || page.markdown.normalize("NFC") !== page.markdown) {
        throw new ArtifactStoreError("artifact_page_text_not_canonical");
      }
    }
  }

  if (kind === "lint_report") {
    const report = value as {
      findings: Array<{ finding_id: string }>;
      candidate_conflicts: Array<{ candidate_conflict_id: string }>;
    };
    unique(
      report.findings.map((finding) => finding.finding_id),
      "artifact_finding_ids_duplicate"
    );
    unique(
      report.candidate_conflicts.map((conflict) => conflict.candidate_conflict_id),
      "artifact_conflict_ids_duplicate"
    );
  }

  if (kind === "promotion_patch") {
    const patch = value as { targets: Array<{ target_capability_id: string }> };
    unique(
      patch.targets.map((target) => target.target_capability_id),
      "artifact_target_ids_duplicate"
    );
  }

  return payload;
}

function assertBodyFreeMetadata(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertBodyFreeMetadata(item);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_RESULT_KEYS.has(key)) throw new ArtifactStoreError("phase_result_contains_body");
    assertBodyFreeMetadata(child);
  }
}

function handleFromRecord(record: ArtifactIndexRecord): ArtifactHandle {
  return {
    schema_version: 1,
    artifact_id: record.artifact_id,
    artifact_kind: record.artifact_kind,
    sha256: record.sha256,
    media_type: record.media_type,
    byte_length: record.byte_length,
  };
}

const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const GROUP_OR_OTHER_WRITE_MASK = 0o022;
const PERMISSION_MASK = 0o7777;

function currentUid(): number | undefined {
  return typeof process.geteuid === "function" ? process.geteuid() : undefined;
}

function pathExistsNoFollow(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertNoSymlinkAncestors(candidate: string): void {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (pathExistsNoFollow(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new ArtifactStoreError("artifact_directory_symlinked");
    }
  }
}

function assertAdmittedRootDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ArtifactStoreError("artifact_directory_invalid");
  }
  if ((stat.mode & GROUP_OR_OTHER_WRITE_MASK) !== 0) {
    throw new ArtifactStoreError("artifact_root_group_or_other_writable");
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new ArtifactStoreError("artifact_directory_wrong_owner");
  }
}

function assertOwnerDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ArtifactStoreError("artifact_directory_invalid");
  }
  if ((stat.mode & PERMISSION_MASK) !== OWNER_DIRECTORY_MODE) {
    throw new ArtifactStoreError("artifact_directory_not_owner_only");
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new ArtifactStoreError("artifact_directory_wrong_owner");
  }
}

function ensureOwnerDirectory(parent: string, child: string, parentIsAdmittedRoot = false): string {
  if (parentIsAdmittedRoot) assertAdmittedRootDirectory(parent);
  else assertOwnerDirectory(parent);
  const directory = path.join(parent, child);
  if (!pathExistsNoFollow(directory)) {
    mkdirSync(directory, { mode: OWNER_DIRECTORY_MODE });
    const descriptor = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      fchmodSync(descriptor, OWNER_DIRECTORY_MODE);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    fsyncDirectory(parent);
  }
  assertOwnerDirectory(directory);
  return directory;
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function unique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) throw new ArtifactStoreError(code);
}

function readOwnedArtifactFile(
  file: string,
  expected: Pick<ArtifactIndexRecord, "sha256" | "byte_length">
): string {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new ArtifactStoreError("artifact_file_unreadable");
  }
  try {
    const stat = fstatSync(descriptor);
    const uid = currentUid();
    if (!stat.isFile() || stat.nlink !== 1 || (uid !== undefined && stat.uid !== uid)) {
      throw new ArtifactStoreError("artifact_file_invalid");
    }
    if ((stat.mode & PERMISSION_MASK) !== OWNER_FILE_MODE) {
      throw new ArtifactStoreError("artifact_file_not_owner_only");
    }
    const content = readFileSync(descriptor, "utf8");
    if (sha256Hex(content) !== expected.sha256) {
      throw new ArtifactStoreError("artifact_hash_mismatch");
    }
    if (Buffer.byteLength(content, "utf8") !== expected.byte_length) {
      throw new ArtifactStoreError("artifact_length_mismatch");
    }
    return content;
  } finally {
    closeSync(descriptor);
  }
}

export type RunArtifactFaultBoundary =
  | "before_prepared_index"
  | "after_prepared_index"
  | "before_temp_write"
  | "after_temp_write"
  | "before_temp_fsync"
  | "after_temp_fsync"
  | "before_rename"
  | "after_rename"
  | "before_directory_fsync"
  | "after_directory_fsync"
  | "before_stage_cas"
  | "after_stage_cas"
  | "before_seal"
  | "after_seal"
  | "before_discarding_cas"
  | "after_discarding_cas"
  | "before_cleanup"
  | "after_cleanup"
  | "before_cleanup_fsync"
  | "after_cleanup_fsync"
  | "before_discarded_cas"
  | "after_discarded_cas";

/** TEST-ONLY crash signal used to leave an exact recoverable boundary state. */
export class RunArtifactSimulatedCrash extends Error {
  constructor(readonly boundary: RunArtifactFaultBoundary) {
    super(`simulated KB artifact crash at '${boundary}'`);
    this.name = "RunArtifactSimulatedCrash";
  }
}

export interface RunArtifactStoreTestOptions {
  /** TEST-ONLY crash/ordering probe invoked after `prepared` commit and before artifact bytes. */
  readonly testOnlyBeforeArtifactWrite?: (record: ArtifactIndexRecord) => void;
  /** TEST-ONLY fault hook. Throw RunArtifactSimulatedCrash at the selected boundary. */
  readonly testOnlyFault?: (
    boundary: RunArtifactFaultBoundary,
    record?: ArtifactIndexRecord
  ) => void;
}

/** The indexed `work/<run_id>/artifacts/<state_id>/` content-plane owner. */
export class RunArtifactStore implements Disposable {
  readonly root: string;
  private readonly runId: string;
  private closed = false;

  constructor(
    kbRoot: string,
    runId: string,
    private readonly checkpointer: Checkpointer,
    private readonly testOptions: RunArtifactStoreTestOptions = {}
  ) {
    assertSegment(runId, "run_id");
    this.runId = runId;
    const resolvedKbRoot = path.resolve(kbRoot);
    assertNoSymlinkAncestors(resolvedKbRoot);
    assertAdmittedRootDirectory(resolvedKbRoot);
    const work = ensureOwnerDirectory(resolvedKbRoot, "work", true);
    this.root = ensureOwnerDirectory(work, runId);
    ensureOwnerDirectory(this.root, "artifacts");
    if (pathExistsNoFollow(path.join(this.root, "artifacts.db"))) {
      throw new ArtifactStoreError("legacy_artifact_index_present");
    }
    this.recover();
  }

  /** Host staging API used by deterministic host artifacts. */
  stage(input: {
    state_id: string;
    kb_profile_id: string;
    artifact_kind: ArtifactKind;
    content: string;
    max_bytes?: number;
    max_artifacts?: number;
  }): ArtifactHandle {
    return this.stageCanonical({
      ...input,
      media_type: "application/json",
      child_producer: false,
    });
  }

  /** Exact `stage_run_artifact` boundary. */
  stageFromTool(input: {
    state_id: string;
    kb_profile_id: string;
    producer: string;
    expected_producer: string;
    expected_kind: ArtifactKind;
    expected_media_type: ArtifactMediaType;
    max_bytes: number;
    max_artifacts: number;
    tool_input: unknown;
  }): ArtifactHandle {
    if (!Value.Check(StageRunArtifactInputSchema, input.tool_input)) {
      throw new ArtifactStoreError("stage_run_artifact_input_invalid");
    }
    const toolInput = input.tool_input as StageRunArtifactInput;
    if (input.producer !== input.expected_producer) {
      throw new ArtifactStoreError("artifact_producer_mismatch");
    }
    if (toolInput.artifact_kind !== input.expected_kind) {
      throw new ArtifactStoreError("artifact_kind_mismatch");
    }
    if (toolInput.media_type !== input.expected_media_type) {
      throw new ArtifactStoreError("artifact_media_type_mismatch");
    }
    if (toolInput.encoding !== "utf8") throw new ArtifactStoreError("artifact_encoding_invalid");
    if (this.phaseResult(input.state_id) !== undefined) {
      throw new ArtifactStoreError("artifact_phase_already_terminated");
    }
    return this.stageCanonical({
      state_id: input.state_id,
      kb_profile_id: input.kb_profile_id,
      artifact_kind: toolInput.artifact_kind,
      media_type: toolInput.media_type,
      content: toolInput.content,
      max_bytes: input.max_bytes,
      max_artifacts: input.max_artifacts,
      child_producer: true,
    });
  }

  private stageCanonical(input: {
    state_id: string;
    kb_profile_id: string;
    artifact_kind: ArtifactKind;
    media_type: ArtifactMediaType;
    content: string;
    max_bytes?: number;
    max_artifacts?: number;
    child_producer: boolean;
  }): ArtifactHandle {
    this.assertOpen();
    assertSegment(input.state_id, "state_id");
    assertSegment(input.kb_profile_id, "kb_profile_id");
    const maxBytes = input.max_bytes ?? DEFAULT_MAX_BYTES;
    const maxArtifacts = input.max_artifacts ?? DEFAULT_MAX_ARTIFACTS;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) {
      throw new ArtifactStoreError("artifact_byte_limit_invalid");
    }
    if (!Number.isSafeInteger(maxArtifacts) || maxArtifacts < 1 || maxArtifacts > 8) {
      throw new ArtifactStoreError("artifact_count_limit_invalid");
    }
    if (Buffer.byteLength(input.content, "utf8") > maxBytes) {
      throw new ArtifactStoreError("artifact_too_large");
    }

    let decoded: unknown;
    try {
      decoded = strictParseJson(input.content);
    } catch {
      throw new ArtifactStoreError("artifact_json_invalid");
    }
    const payload = validatePayload(input.artifact_kind, decoded, input.child_producer);
    const canonical = canonicalJson(payload);
    const bytes = Buffer.from(canonical, "utf8");
    if (bytes.length > maxBytes) throw new ArtifactStoreError("artifact_too_large");

    this.recover();
    const artifactId = `art_${randomUUID().replace(/-/g, "")}`;
    const timestamp = new Date().toISOString();
    const storageKey = path.posix.join("artifacts", input.state_id, artifactId);
    const temporaryKey = path.posix.join("artifacts", input.state_id, `.${artifactId}.tmp`);
    const digest = sha256Hex(canonical);
    const directory = ensureOwnerDirectory(path.join(this.root, "artifacts"), input.state_id);
    const prepared: ArtifactIndexRecord & {
      lifecycle: "prepared";
      temporary_storage_key: string;
    } = {
      schema_version: 1,
      artifact_id: artifactId,
      run_id: this.runId,
      state_id: input.state_id,
      kb_profile_id: input.kb_profile_id,
      artifact_kind: input.artifact_kind,
      media_type: input.media_type,
      sha256: digest,
      byte_length: bytes.length,
      storage_key: storageKey,
      temporary_storage_key: temporaryKey,
      lifecycle: "prepared",
      created_at: timestamp,
      updated_at: timestamp,
    };

    this.hit("before_prepared_index", prepared);
    let reservation: { kind: "created" | "existing"; record: KbArtifactIndexRecord };
    try {
      reservation = this.checkpointer.prepareKbArtifact(prepared, maxArtifacts);
    } catch (error) {
      if (error instanceof ReceiptConflictError) {
        throw new ArtifactStoreError(
          error.message.includes("count exceeded")
            ? "artifact_count_exceeded"
            : "artifact_duplicate_conflict"
        );
      }
      throw error;
    }
    const record = reservation.record as ArtifactIndexRecord;
    this.hit("after_prepared_index", record);
    this.testOptions.testOnlyBeforeArtifactWrite?.(record);

    if (record.lifecycle === "staged") {
      readOwnedArtifactFile(path.join(this.root, record.storage_key), record);
      return handleFromRecord(record);
    }
    if (record.lifecycle !== "prepared" || record.temporary_storage_key === undefined) {
      throw new ArtifactStoreError("artifact_prepared_state_invalid");
    }
    if (reservation.kind === "existing") {
      this.recoverPrepared(record);
      const recovered = this.getIndexRecord(record.artifact_id);
      if (recovered.lifecycle !== "staged") {
        throw new ArtifactStoreError("artifact_recovery_did_not_stage");
      }
      return handleFromRecord(recovered);
    }

    const temporaryPath = path.join(this.root, record.temporary_storage_key);
    const finalPath = path.join(this.root, record.storage_key);
    let descriptor: number | undefined;
    try {
      this.hit("before_temp_write", record);
      descriptor = openSync(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        OWNER_FILE_MODE
      );
      fchmodSync(descriptor, OWNER_FILE_MODE);
      writeFileSync(descriptor, bytes);
      this.hit("after_temp_write", record);
      this.hit("before_temp_fsync", record);
      fsyncSync(descriptor);
      this.hit("after_temp_fsync", record);
      closeSync(descriptor);
      descriptor = undefined;
      readOwnedArtifactFile(temporaryPath, record);
      if (pathExistsNoFollow(finalPath)) {
        throw new ArtifactStoreError("artifact_final_key_occupied");
      }
      this.hit("before_rename", record);
      renameSync(temporaryPath, finalPath);
      this.hit("after_rename", record);
      readOwnedArtifactFile(finalPath, record);
      this.hit("before_directory_fsync", record);
      fsyncDirectory(directory);
      this.hit("after_directory_fsync", record);
      this.hit("before_stage_cas", record);
      const staged = this.checkpointer.kbArtifactMarkStaged(record.artifact_id, this.runId);
      this.hit("after_stage_cas", staged as ArtifactIndexRecord);
      return handleFromRecord(staged as ArtifactIndexRecord);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error instanceof ArtifactStoreError || error instanceof RunArtifactSimulatedCrash) {
        throw error;
      }
      throw new ArtifactStoreError("artifact_stage_io_failed");
    }
  }

  getIndexRecord(artifactId: string): ArtifactIndexRecord {
    this.assertOpen();
    const record = this.checkpointer.kbArtifact(artifactId);
    if (record === undefined) throw new ArtifactStoreError("artifact_not_found");
    if (record.run_id !== this.runId) throw new ArtifactStoreError("artifact_cross_run");
    return record as ArtifactIndexRecord;
  }

  /** Read indexed bytes and revalidate lifecycle, ownership, mode, length, and hash. */
  read(
    artifactId: string,
    binding: {
      expected_state_id?: string;
      expected_profile_id?: string;
      expected_handle?: ArtifactHandle;
      required_lifecycle?: ArtifactLifecycle;
    } = {}
  ): { handle: ArtifactHandle; content: string } {
    const record = this.getIndexRecord(artifactId);
    if (binding.expected_state_id !== undefined && record.state_id !== binding.expected_state_id) {
      throw new ArtifactStoreError("artifact_cross_state");
    }
    if (
      binding.expected_profile_id !== undefined &&
      record.kb_profile_id !== binding.expected_profile_id
    ) {
      throw new ArtifactStoreError("artifact_cross_profile");
    }
    if (binding.required_lifecycle !== undefined) {
      if (record.lifecycle !== binding.required_lifecycle) {
        throw new ArtifactStoreError("artifact_lifecycle_invalid");
      }
    } else if (!(["staged", "sealed", "consumed"] as const).includes(record.lifecycle as never)) {
      throw new ArtifactStoreError("artifact_lifecycle_invalid");
    }

    const handle = handleFromRecord(record);
    if (
      binding.expected_handle !== undefined &&
      canonicalJson(binding.expected_handle) !== canonicalJson(handle)
    ) {
      throw new ArtifactStoreError("artifact_handle_mismatch");
    }
    return {
      handle,
      content: readOwnedArtifactFile(path.join(this.root, record.storage_key), record),
    };
  }

  /** Atomically persist one body-free typed phase result and seal its exact handles. */
  sealWithPhaseResult(input: {
    state_id: string;
    kb_profile_id: string;
    result: unknown;
    handles: readonly ArtifactHandle[];
  }): void {
    assertSegment(input.state_id, "state_id");
    assertSegment(input.kb_profile_id, "kb_profile_id");
    if (
      input.handles.length === 0 ||
      new Set(input.handles.map((handle) => handle.artifact_id)).size !== input.handles.length
    ) {
      throw new ArtifactStoreError("phase_result_handles_invalid");
    }
    assertBodyFreeMetadata(input.result);
    const resultJcs = canonicalJson(input.result);
    if (Buffer.byteLength(resultJcs, "utf8") > 65_536) {
      throw new ArtifactStoreError("phase_result_too_large");
    }
    for (const handle of input.handles) {
      this.read(handle.artifact_id, {
        expected_state_id: input.state_id,
        expected_profile_id: input.kb_profile_id,
        expected_handle: handle,
        required_lifecycle: "staged",
      });
    }
    this.hit("before_seal");
    try {
      this.checkpointer.sealKbArtifactsWithPhaseResult({
        run_id: this.runId,
        state_id: input.state_id,
        kb_profile_id: input.kb_profile_id,
        result_jcs: resultJcs,
        handles: input.handles,
      });
    } catch (error) {
      if (error instanceof ReceiptConflictError) {
        throw new ArtifactStoreError("phase_result_rejected");
      }
      throw error;
    }
    this.hit("after_seal");
  }

  phaseResult(stateId: string): KbPhaseResultRecord | undefined {
    assertSegment(stateId, "state_id");
    return this.checkpointer.kbPhaseResult(this.runId, stateId);
  }

  phaseOperands(stateId: string): KbPhaseOperands | undefined {
    assertSegment(stateId, "state_id");
    return this.checkpointer.kbPhaseOperands(this.runId, stateId);
  }

  phaseOperandsRecord(stateId: string): KbPhaseOperandsRecord | undefined {
    assertSegment(stateId, "state_id");
    return this.checkpointer.kbPhaseOperandsRecord(this.runId, stateId);
  }

  requireOpenPhaseOperands(stateId: string): KbPhaseOperands {
    assertSegment(stateId, "state_id");
    try {
      return this.checkpointer.requireOpenKbPhaseOperands(this.runId, stateId);
    } catch (error) {
      if (error instanceof ReceiptConflictError) {
        throw new ArtifactStoreError("phase_operands_closed");
      }
      throw error;
    }
  }

  bindPhaseOperands(input: KbPhaseOperands): KbPhaseOperands {
    if (input.run_id !== this.runId) throw new ArtifactStoreError("phase_operands_cross_run");
    try {
      return this.checkpointer.bindKbPhaseOperands(input);
    } catch (error) {
      if (error instanceof ReceiptConflictError) {
        throw new ArtifactStoreError("phase_operands_changed");
      }
      throw error;
    }
  }

  /** Host-only idempotent seal for deterministic artifacts. */
  seal(artifactIds: readonly string[]): void {
    this.transitionAll(artifactIds, "staged", "sealed");
  }

  consume(artifactIds: readonly string[]): void {
    this.transitionAll(artifactIds, "sealed", "consumed");
  }

  private transitionAll(
    artifactIds: readonly string[],
    from: ArtifactLifecycle,
    to: ArtifactLifecycle
  ): void {
    if (new Set(artifactIds).size !== artifactIds.length) {
      throw new ArtifactStoreError("artifact_ids_duplicate");
    }
    try {
      this.checkpointer.transitionKbArtifacts({
        run_id: this.runId,
        artifact_ids: artifactIds,
        from,
        to,
        allow_already_to: true,
      });
    } catch (error) {
      if (error instanceof ReceiptConflictError) {
        throw new ArtifactStoreError("artifact_lifecycle_transition_invalid");
      }
      throw error;
    }
  }

  listByState(stateId: string, lifecycle?: ArtifactLifecycle): ArtifactHandle[] {
    assertSegment(stateId, "state_id");
    const states = lifecycle ? [lifecycle] : (["staged", "sealed"] as ArtifactLifecycle[]);
    return this.checkpointer
      .kbArtifacts({ run_id: this.runId, state_id: stateId, lifecycles: states })
      .map((record) => handleFromRecord(record as ArtifactIndexRecord));
  }

  /** Deterministically settle every prepared/discarding row from exact indexed keys. */
  recover(): void {
    this.assertOpen();
    const rows = this.checkpointer.kbArtifacts({
      run_id: this.runId,
      lifecycles: ["prepared", "discarding"],
    });
    for (const row of rows) {
      const record = row as ArtifactIndexRecord;
      if (record.lifecycle === "discarding") this.cleanupDiscarding(record);
      else this.recoverPrepared(record);
    }
  }

  private recoverPrepared(record: ArtifactIndexRecord): void {
    if (record.temporary_storage_key === undefined) {
      throw new ArtifactStoreError("artifact_prepared_temp_key_missing");
    }
    const temporaryPath = path.join(this.root, record.temporary_storage_key);
    const finalPath = path.join(this.root, record.storage_key);
    const tempExists = pathExistsNoFollow(temporaryPath);
    const finalExists = pathExistsNoFollow(finalPath);
    if (!tempExists && !finalExists) {
      this.discardPrepared(record);
      return;
    }
    if (tempExists && finalExists) {
      this.discardPrepared(record);
      throw new ArtifactStoreError("artifact_recovery_ambiguous_keys");
    }
    try {
      const directory = ensureOwnerDirectory(path.join(this.root, "artifacts"), record.state_id);
      if (finalExists) {
        readOwnedArtifactFile(finalPath, record);
      } else {
        readOwnedArtifactFile(temporaryPath, record);
        const descriptor = openSync(temporaryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          this.hit("before_temp_fsync", record);
          fsyncSync(descriptor);
          this.hit("after_temp_fsync", record);
        } finally {
          closeSync(descriptor);
        }
        if (pathExistsNoFollow(finalPath)) {
          throw new ArtifactStoreError("artifact_final_key_occupied");
        }
        this.hit("before_rename", record);
        renameSync(temporaryPath, finalPath);
        this.hit("after_rename", record);
        readOwnedArtifactFile(finalPath, record);
      }
      this.hit("before_directory_fsync", record);
      fsyncDirectory(directory);
      this.hit("after_directory_fsync", record);
      this.hit("before_stage_cas", record);
      const staged = this.checkpointer.kbArtifactMarkStaged(record.artifact_id, this.runId);
      this.hit("after_stage_cas", staged as ArtifactIndexRecord);
    } catch (error) {
      if (error instanceof RunArtifactSimulatedCrash) throw error;
      this.discardPrepared(record);
      if (error instanceof ArtifactStoreError) throw error;
      throw new ArtifactStoreError("artifact_recovery_failed");
    }
  }

  private discardPrepared(record: ArtifactIndexRecord): void {
    this.hit("before_discarding_cas", record);
    const discarding = this.checkpointer.kbArtifactBeginDiscarding(record.artifact_id, this.runId);
    this.hit("after_discarding_cas", discarding as ArtifactIndexRecord);
    if (discarding.lifecycle !== "discarded") {
      this.cleanupDiscarding(discarding as ArtifactIndexRecord);
    }
  }

  private cleanupDiscarding(record: ArtifactIndexRecord): void {
    const keys = [record.temporary_storage_key, record.storage_key].filter(
      (key): key is string => key !== undefined
    );
    this.hit("before_cleanup", record);
    for (const key of keys) {
      const exact = path.join(this.root, key);
      if (!pathExistsNoFollow(exact)) continue;
      const stat = lstatSync(exact);
      if (stat.isDirectory()) {
        throw new ArtifactStoreError("artifact_cleanup_key_is_directory");
      }
      unlinkSync(exact);
    }
    this.hit("after_cleanup", record);
    const directory = path.join(this.root, "artifacts", record.state_id);
    if (pathExistsNoFollow(directory)) {
      assertOwnerDirectory(directory);
      this.hit("before_cleanup_fsync", record);
      fsyncDirectory(directory);
      this.hit("after_cleanup_fsync", record);
    }
    this.hit("before_discarded_cas", record);
    const discarded = this.checkpointer.kbArtifactFinishDiscarded(record.artifact_id, this.runId);
    this.hit("after_discarded_cas", discarded as ArtifactIndexRecord);
  }

  private hit(boundary: RunArtifactFaultBoundary, record?: ArtifactIndexRecord): void {
    this.testOptions.testOnlyFault?.(boundary, record);
  }

  private assertOpen(): void {
    if (this.closed) throw new ArtifactStoreError("artifact_store_closed");
  }

  close(): void {
    this.closed = true;
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
