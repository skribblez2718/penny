import { Type, type Static } from "typebox";

import { canonicalJson, sha256 } from "../canonical-json.js";
import { validateContract } from "../contracts.js";
import { OpaqueIdSchema, Rfc3339UtcSchema, Sha256Schema } from "../skill-contracts/common.js";
import {
  SCA_MAX_LEDGER_RECORDS,
  ScaDomainRecordV1Schema,
  ScaDomainValidationError,
  compareRfc3339Utc,
  domainRecordIdentity,
  domainRecordTimestamp,
  validateScaDomainRecord,
  validateScaNdjsonRecord,
  type ClaimRecordV1,
  type FindingRecordV1,
  ManifestRecordLocatorV1Schema,
  type ManifestV1,
  type ScaDomainBundleV1,
  type ScaDomainRecordV1,
  type ScaNdjsonRecordV1,
  type TaskRecordV1,
} from "./contracts.js";
import { validateScaDomainBundle } from "./evidence.js";
import {
  transitionClaimRecord,
  transitionFindingRecord,
  transitionTaskRecord,
} from "./lifecycle.js";

const DEFAULT_MAX_BYTES = 64 * 1_048_576;
const DEFAULT_MAX_LINE_BYTES = 2 * 1_048_576;
const DEFAULT_MAX_RECORDS = SCA_MAX_LEDGER_RECORDS + 1;
const HARD_MAX_BYTES = DEFAULT_MAX_BYTES;
const HARD_MAX_LINE_BYTES = DEFAULT_MAX_LINE_BYTES;
const HARD_MAX_RECORDS = DEFAULT_MAX_RECORDS;
const MAX_JSON_DEPTH = 64;

export interface NdjsonReadLimits {
  readonly maxBytes: number;
  readonly maxLineBytes: number;
  readonly maxRecords: number;
}

export const DEFAULT_NDJSON_READ_LIMITS: NdjsonReadLimits = Object.freeze({
  maxBytes: DEFAULT_MAX_BYTES,
  maxLineBytes: DEFAULT_MAX_LINE_BYTES,
  maxRecords: DEFAULT_MAX_RECORDS,
});

export interface CanonicalReplayV1 {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly records: readonly ScaDomainRecordV1[];
  readonly canonical_ndjson: string;
  readonly sha256: string;
}

export const ScaLedgerAppendRequestV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-ledger-append-request.v1"),
    schema_version: Type.Literal(1),
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: OpaqueIdSchema,
    idempotency_key: OpaqueIdSchema,
    prior_ledger_sha256: Sha256Schema,
    record: ScaDomainRecordV1Schema,
  },
  { additionalProperties: false }
);
export type ScaLedgerAppendRequestV1 = Readonly<Static<typeof ScaLedgerAppendRequestV1Schema>>;

export const ScaLedgerAppendEventV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.sca-ledger-append-event.v1"),
    schema_version: Type.Literal(1),
    event_id: OpaqueIdSchema,
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
    phase_id: OpaqueIdSchema,
    idempotency_key: OpaqueIdSchema,
    request_sha256: Sha256Schema,
    prior_ledger_sha256: Sha256Schema,
    ledger_sha256: Sha256Schema,
    record_sha256: Sha256Schema,
    record_json: Type.String({ minLength: 2, maxLength: HARD_MAX_LINE_BYTES }),
    locator: ManifestRecordLocatorV1Schema,
    appended_at: Rfc3339UtcSchema,
  },
  { additionalProperties: false }
);
export type ScaLedgerAppendEventV1 = Readonly<Static<typeof ScaLedgerAppendEventV1Schema>>;

export interface ScaLedgerStateV1 {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly records: readonly ScaDomainRecordV1[];
  readonly events: readonly ScaLedgerAppendEventV1[];
  readonly canonical_ndjson: string;
  readonly ledger_sha256: string;
}

export type ScaLedgerAppendResultV1 =
  | {
      readonly disposition: "appended";
      readonly state: ScaLedgerStateV1;
      readonly event: ScaLedgerAppendEventV1;
    }
  | {
      readonly disposition: "adopted";
      readonly state: ScaLedgerStateV1;
      readonly event: ScaLedgerAppendEventV1;
    };

export const SCA_EMPTY_LEDGER_SHA256 = sha256("");

export type ReplayComparisonV1 =
  | {
      readonly equivalent: true;
      readonly digest: string;
    }
  | {
      readonly equivalent: false;
      readonly left_digest: string;
      readonly right_digest: string;
      readonly first_divergent_sequence: number | null;
    };

function fail(label: string, issue: string): never {
  throw new ScaDomainValidationError(label, [issue]);
}

function validateLimits(limits: NdjsonReadLimits): NdjsonReadLimits {
  for (const [name, value, maximum] of [
    ["maxBytes", limits.maxBytes, HARD_MAX_BYTES],
    ["maxLineBytes", limits.maxLineBytes, HARD_MAX_LINE_BYTES],
    ["maxRecords", limits.maxRecords, HARD_MAX_RECORDS],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      fail(
        "SCA NDJSON limits",
        `${name} must be a positive safe integer no greater than ${maximum}`
      );
    }
  }
  if (limits.maxLineBytes > limits.maxBytes) {
    fail("SCA NDJSON limits", "maxLineBytes must not exceed maxBytes");
  }
  return limits;
}

class StrictJsonScanner {
  private position = 0;

  constructor(private readonly text: string) {}

  scan(): void {
    this.skipWhitespace();
    this.scanValue(0);
    this.skipWhitespace();
    if (this.position !== this.text.length) this.error("unexpected trailing token");
  }

  private error(issue: string): never {
    throw new Error(`${issue} at character ${this.position + 1}`);
  }

  private skipWhitespace(): void {
    while (this.position < this.text.length) {
      const character = this.text[this.position];
      if (character !== " " && character !== "\t" && character !== "\n" && character !== "\r") {
        return;
      }
      this.position += 1;
    }
  }

  private scanValue(depth: number): void {
    if (depth > MAX_JSON_DEPTH) this.error(`JSON nesting exceeds ${MAX_JSON_DEPTH}`);
    const character = this.text[this.position];
    if (character === "{") {
      this.scanObject(depth + 1);
      return;
    }
    if (character === "[") {
      this.scanArray(depth + 1);
      return;
    }
    if (character === '"') {
      this.scanString();
      return;
    }
    if (character === "t") {
      this.scanLiteral("true");
      return;
    }
    if (character === "f") {
      this.scanLiteral("false");
      return;
    }
    if (character === "n") {
      this.scanLiteral("null");
      return;
    }
    if (character === "-" || (character !== undefined && character >= "0" && character <= "9")) {
      this.scanNumber();
      return;
    }
    this.error("expected a JSON value");
  }

  private scanObject(depth: number): void {
    this.position += 1;
    this.skipWhitespace();
    const keys = new Set<string>();
    if (this.text[this.position] === "}") {
      this.position += 1;
      return;
    }
    while (this.position < this.text.length) {
      if (this.text[this.position] !== '"') this.error("expected an object key");
      const key = this.scanString();
      if (keys.has(key)) this.error(`duplicate object key '${key}'`);
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.position] !== ":") this.error("expected ':' after object key");
      this.position += 1;
      this.skipWhitespace();
      this.scanValue(depth);
      this.skipWhitespace();
      const separator = this.text[this.position];
      if (separator === "}") {
        this.position += 1;
        return;
      }
      if (separator !== ",") this.error("expected ',' or '}' in object");
      this.position += 1;
      this.skipWhitespace();
    }
    this.error("unterminated object");
  }

  private scanArray(depth: number): void {
    this.position += 1;
    this.skipWhitespace();
    if (this.text[this.position] === "]") {
      this.position += 1;
      return;
    }
    while (this.position < this.text.length) {
      this.scanValue(depth);
      this.skipWhitespace();
      const separator = this.text[this.position];
      if (separator === "]") {
        this.position += 1;
        return;
      }
      if (separator !== ",") this.error("expected ',' or ']' in array");
      this.position += 1;
      this.skipWhitespace();
    }
    this.error("unterminated array");
  }

  private scanString(): string {
    const start = this.position;
    this.position += 1;
    while (this.position < this.text.length) {
      const character = this.text[this.position];
      if (character === '"') {
        this.position += 1;
        const parsed: unknown = JSON.parse(this.text.slice(start, this.position));
        if (typeof parsed !== "string") this.error("object key is not a string");
        return parsed;
      }
      if (character === "\\") {
        this.position += 1;
        const escape = this.text[this.position];
        if (escape === "u") {
          const hexadecimal = this.text.slice(this.position + 1, this.position + 5);
          if (!/^[0-9A-Fa-f]{4}$/u.test(hexadecimal)) this.error("invalid Unicode escape");
          this.position += 5;
          continue;
        }
        if (
          escape !== '"' &&
          escape !== "\\" &&
          escape !== "/" &&
          escape !== "b" &&
          escape !== "f" &&
          escape !== "n" &&
          escape !== "r" &&
          escape !== "t"
        ) {
          this.error("invalid string escape");
        }
        this.position += 1;
        continue;
      }
      if (character === undefined || character.codePointAt(0) === undefined) {
        this.error("unterminated string");
      }
      const codePoint = character.codePointAt(0);
      if (codePoint !== undefined && codePoint <= 0x1f) this.error("unescaped control in string");
      this.position += 1;
    }
    this.error("unterminated string");
  }

  private scanLiteral(literal: "true" | "false" | "null"): void {
    if (!this.text.startsWith(literal, this.position)) this.error(`invalid '${literal}' token`);
    this.position += literal.length;
  }

  private scanNumber(): void {
    const numberPattern = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;
    numberPattern.lastIndex = this.position;
    const match = numberPattern.exec(this.text);
    const token = match?.[0];
    if (token === undefined) this.error("invalid JSON number");
    const number = Number(token);
    if (!Number.isFinite(number)) this.error("JSON number must be finite");
    this.position = numberPattern.lastIndex;
  }
}

function parseStrictJson(text: string): unknown {
  new StrictJsonScanner(text).scan();
  const value: unknown = JSON.parse(text);
  return value;
}

/**
 * Parse one complete, already-buffered NDJSON artifact. This deliberately is not a streaming wire
 * protocol: every byte and every record must pass before any records are returned.
 */
export function readBoundedNdjson(
  bytes: Uint8Array,
  limits: NdjsonReadLimits = DEFAULT_NDJSON_READ_LIMITS
): readonly ScaNdjsonRecordV1[] {
  const acceptedLimits = validateLimits(limits);
  if (bytes.byteLength === 0) fail("SCA NDJSON", "input must not be empty");
  if (bytes.byteLength > acceptedLimits.maxBytes) {
    fail("SCA NDJSON", `input exceeds maxBytes=${acceptedLimits.maxBytes}`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("SCA NDJSON", "input is not valid UTF-8");
  }
  if (text.startsWith("\uFEFF")) fail("SCA NDJSON", "UTF-8 BOM is not permitted");
  const rawLines = text.split("\n");
  if (rawLines[rawLines.length - 1] === "") rawLines.pop();
  if (rawLines.length === 0) fail("SCA NDJSON", "input contains no records");
  if (rawLines.length > acceptedLimits.maxRecords) {
    fail("SCA NDJSON", `record count exceeds maxRecords=${acceptedLimits.maxRecords}`);
  }

  const parsed: ScaNdjsonRecordV1[] = [];
  for (const [index, rawLine] of rawLines.entries()) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const lineBytes = Buffer.byteLength(rawLine, "utf8");
    if (lineBytes > acceptedLimits.maxLineBytes) {
      fail("SCA NDJSON", `line ${index + 1} exceeds maxLineBytes=${acceptedLimits.maxLineBytes}`);
    }
    if (line.length === 0) fail("SCA NDJSON", `line ${index + 1} is empty`);
    try {
      parsed.push(validateScaNdjsonRecord(parseStrictJson(line)));
    } catch (error) {
      const issue = error instanceof Error ? error.message : "record is invalid";
      fail("SCA NDJSON", `line ${index + 1}: ${issue}`);
    }
  }
  return parsed;
}

function appendVersion<T extends { readonly version: number }>(
  histories: Map<string, T[]>,
  id: string,
  record: T
): void {
  const history = histories.get(id);
  if (history === undefined) histories.set(id, [record]);
  else history.push(record);
}

function validateTaskHistories(histories: ReadonlyMap<string, readonly TaskRecordV1[]>): void {
  for (const [taskId, unsorted] of histories) {
    const history = [...unsorted].sort((left, right) => left.version - right.version);
    const first = history[0];
    if (first === undefined || first.version !== 1 || first.status !== "pending") {
      fail("SCA replay", `task '${taskId}' history must start pending at version 1`);
    }
    for (let index = 1; index < history.length; index += 1) {
      const previous = history[index - 1];
      const next = history[index];
      if (previous === undefined || next === undefined)
        fail("SCA replay", "task history is sparse");
      transitionTaskRecord(previous, next);
    }
  }
}

function validateClaimHistories(histories: ReadonlyMap<string, readonly ClaimRecordV1[]>): void {
  for (const [claimId, unsorted] of histories) {
    const history = [...unsorted].sort((left, right) => left.version - right.version);
    const first = history[0];
    if (first === undefined || first.version !== 1 || first.status !== "draft") {
      fail("SCA replay", `claim '${claimId}' history must start draft at version 1`);
    }
    for (let index = 1; index < history.length; index += 1) {
      const previous = history[index - 1];
      const next = history[index];
      if (previous === undefined || next === undefined)
        fail("SCA replay", "claim history is sparse");
      transitionClaimRecord(previous, next);
    }
  }
}

function validateFindingHistories(
  histories: ReadonlyMap<string, readonly FindingRecordV1[]>
): void {
  for (const [findingId, unsorted] of histories) {
    const history = [...unsorted].sort((left, right) => left.version - right.version);
    const first = history[0];
    if (first === undefined || first.version !== 1 || first.status !== "candidate") {
      fail("SCA replay", `finding '${findingId}' history must start candidate at version 1`);
    }
    for (let index = 1; index < history.length; index += 1) {
      const previous = history[index - 1];
      const next = history[index];
      if (previous === undefined || next === undefined) {
        fail("SCA replay", "finding history is sparse");
      }
      transitionFindingRecord(previous, next);
    }
  }
}

function recordBundle(record: ScaDomainRecordV1): readonly [string, string, string] {
  return [record.tenant_id, record.project_id, record.run_id];
}

export function createCanonicalReplay(values: readonly unknown[]): CanonicalReplayV1 {
  if (values.length === 0) fail("SCA replay", "at least one domain record is required");
  const records = values.map((value) => validateScaDomainRecord(value));
  records.sort((left, right) => left.sequence - right.sequence);
  const first = records[0];
  if (first === undefined) fail("SCA replay", "at least one domain record is required");
  if (records.length > SCA_MAX_LEDGER_RECORDS) {
    fail("SCA replay", `record count exceeds ${SCA_MAX_LEDGER_RECORDS}`);
  }
  const [tenantId, projectId, runId] = recordBundle(first);
  const locatorKeys = new Set<string>();
  const sequences = new Set<number>();
  let priorTimestamp: string | null = null;
  const tasks = new Map<string, TaskRecordV1[]>();
  const claims = new Map<string, ClaimRecordV1[]>();
  const findings = new Map<string, FindingRecordV1[]>();
  const immutableIds = new Set<string>();

  for (const record of records) {
    if (
      record.tenant_id !== tenantId ||
      record.project_id !== projectId ||
      record.run_id !== runId
    ) {
      fail("SCA replay", "all records must share one tenant_id, project_id, and run_id");
    }
    if (sequences.has(record.sequence)) fail("SCA replay", "record sequences must be unique");
    sequences.add(record.sequence);
    const timestamp = domainRecordTimestamp(record);
    if (priorTimestamp !== null && compareRfc3339Utc(timestamp, priorTimestamp) < 0) {
      fail("SCA replay", "record time must be non-decreasing with sequence");
    }
    priorTimestamp = timestamp;
    const identity = domainRecordIdentity(record);
    const locatorKey = `${identity.record_type}:${identity.record_id}:${identity.record_version}`;
    if (locatorKeys.has(locatorKey)) fail("SCA replay", `duplicate record '${locatorKey}'`);
    locatorKeys.add(locatorKey);
    switch (record.schema_id) {
      case "penny.sca-task-record.v1":
        appendVersion(tasks, record.task_id, record);
        break;
      case "penny.sca-claim-record.v1":
        appendVersion(claims, record.claim_id, record);
        break;
      case "penny.sca-finding-record.v1":
        appendVersion(findings, record.finding_id, record);
        break;
      case "penny.sca-evidence-ref.v1":
      case "penny.sca-decision-record.v1":
      case "penny.sca-gate-result.v1": {
        const immutableKey = `${identity.record_type}:${identity.record_id}`;
        if (immutableIds.has(immutableKey)) {
          fail("SCA replay", `immutable record '${immutableKey}' appears more than once`);
        }
        immutableIds.add(immutableKey);
        break;
      }
    }
  }

  validateTaskHistories(tasks);
  validateClaimHistories(claims);
  validateFindingHistories(findings);
  const canonicalNdjson = `${records.map((record) => canonicalJson(record)).join("\n")}\n`;
  return {
    tenant_id: tenantId,
    project_id: projectId,
    run_id: runId,
    records,
    canonical_ndjson: canonicalNdjson,
    sha256: sha256(canonicalNdjson),
  };
}

export function canonicalReplayDigest(values: readonly unknown[]): string {
  return createCanonicalReplay(values).sha256;
}

export function compareCanonicalReplays(
  leftValues: readonly unknown[],
  rightValues: readonly unknown[]
): ReplayComparisonV1 {
  const left = createCanonicalReplay(leftValues);
  const right = createCanonicalReplay(rightValues);
  if (left.sha256 === right.sha256 && left.canonical_ndjson === right.canonical_ndjson) {
    return { equivalent: true, digest: left.sha256 };
  }
  const maximum = Math.max(left.records.length, right.records.length);
  let firstDivergentSequence: number | null = null;
  for (let index = 0; index < maximum; index += 1) {
    const leftRecord = left.records[index];
    const rightRecord = right.records[index];
    if (
      leftRecord === undefined ||
      rightRecord === undefined ||
      canonicalJson(leftRecord) !== canonicalJson(rightRecord)
    ) {
      firstDivergentSequence = leftRecord?.sequence ?? rightRecord?.sequence ?? null;
      break;
    }
  }
  return {
    equivalent: false,
    left_digest: left.sha256,
    right_digest: right.sha256,
    first_divergent_sequence: firstDivergentSequence,
  };
}

export function assertCanonicalReplayEquivalent(
  leftValues: readonly unknown[],
  rightValues: readonly unknown[]
): void {
  const comparison = compareCanonicalReplays(leftValues, rightValues);
  if (!comparison.equivalent) {
    fail(
      "SCA replay equivalence",
      `replays diverge at sequence ${comparison.first_divergent_sequence ?? "unknown"}`
    );
  }
}

const ScaLedgerIdentityV1Schema = Type.Object(
  {
    tenant_id: OpaqueIdSchema,
    project_id: OpaqueIdSchema,
    run_id: OpaqueIdSchema,
  },
  { additionalProperties: false }
);
export type ScaLedgerIdentityV1 = Readonly<Static<typeof ScaLedgerIdentityV1Schema>>;

function deepFreezeJson<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function immutableJsonClone<Value>(value: Value): Value {
  return deepFreezeJson(structuredClone(value));
}

function frozenState(input: {
  readonly tenant_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly records: readonly ScaDomainRecordV1[];
  readonly events: readonly ScaLedgerAppendEventV1[];
  readonly canonical_ndjson: string;
  readonly ledger_sha256: string;
}): ScaLedgerStateV1 {
  return Object.freeze({
    tenant_id: input.tenant_id,
    project_id: input.project_id,
    run_id: input.run_id,
    records: Object.freeze(input.records.map((record) => immutableJsonClone(record))),
    events: Object.freeze(input.events.map((event) => immutableJsonClone(event))),
    canonical_ndjson: input.canonical_ndjson,
    ledger_sha256: input.ledger_sha256,
  });
}

function immutableAppendEvent(value: ScaLedgerAppendEventV1): ScaLedgerAppendEventV1 {
  return immutableJsonClone(value);
}

export function createEmptyScaLedger(identityValue: unknown): ScaLedgerStateV1 {
  const identity = validateContract(
    ScaLedgerIdentityV1Schema,
    identityValue,
    "SCA ledger identity"
  );
  return frozenState({
    ...identity,
    records: [],
    events: [],
    canonical_ndjson: "",
    ledger_sha256: SCA_EMPTY_LEDGER_SHA256,
  });
}

function appendRequestDigest(request: ScaLedgerAppendRequestV1): string {
  return sha256(canonicalJson(request));
}

function assertAppendRecordBinding(
  request: ScaLedgerAppendRequestV1,
  record: ScaDomainRecordV1
): void {
  if (
    record.tenant_id !== request.tenant_id ||
    record.project_id !== request.project_id ||
    record.run_id !== request.run_id ||
    record.phase_id !== request.phase_id
  ) {
    fail(
      "SCA ledger append",
      "record tenant_id/project_id/run_id/phase_id must match the append request"
    );
  }
}

function eventRequest(
  event: ScaLedgerAppendEventV1,
  record: ScaDomainRecordV1
): ScaLedgerAppendRequestV1 {
  return {
    schema_id: "penny.sca-ledger-append-request.v1",
    schema_version: 1,
    tenant_id: event.tenant_id,
    project_id: event.project_id,
    run_id: event.run_id,
    phase_id: event.phase_id,
    idempotency_key: event.idempotency_key,
    prior_ledger_sha256: event.prior_ledger_sha256,
    record,
  };
}

function locatorMatchesRecord(
  locator: ScaLedgerAppendEventV1["locator"],
  record: ScaDomainRecordV1
): boolean {
  const expected = domainRecordIdentity(record);
  return canonicalJson(locator) === canonicalJson(expected);
}

/** Rebuild one ledger solely from immutable append events and verify every digest link. */
export function replayScaLedgerEvents(
  eventValues: readonly unknown[],
  identityValue: unknown
): ScaLedgerStateV1 {
  const identity = validateContract(
    ScaLedgerIdentityV1Schema,
    identityValue,
    "SCA ledger identity"
  );
  if (eventValues.length === 0) return createEmptyScaLedger(identity);
  if (eventValues.length > SCA_MAX_LEDGER_RECORDS) {
    fail("SCA ledger events", `event count exceeds ${SCA_MAX_LEDGER_RECORDS}`);
  }
  const records: ScaDomainRecordV1[] = [];
  const events: ScaLedgerAppendEventV1[] = [];
  const idempotencyKeys = new Set<string>();
  let digest = SCA_EMPTY_LEDGER_SHA256;
  for (const eventValue of eventValues) {
    const validated = validateContract(
      ScaLedgerAppendEventV1Schema,
      eventValue,
      "SCA ledger append event"
    );
    const event = immutableAppendEvent(validated);
    if (
      event.tenant_id !== identity.tenant_id ||
      event.project_id !== identity.project_id ||
      event.run_id !== identity.run_id
    ) {
      fail("SCA ledger events", "event belongs to another tenant/project/run bundle");
    }
    if (idempotencyKeys.has(event.idempotency_key)) {
      fail("SCA ledger events", `duplicate idempotency key '${event.idempotency_key}'`);
    }
    idempotencyKeys.add(event.idempotency_key);
    if (event.prior_ledger_sha256 !== digest) {
      fail("SCA ledger events", "append event has a stale prior-ledger digest");
    }
    let parsed: unknown;
    try {
      parsed = parseStrictJson(event.record_json);
    } catch (error) {
      fail(
        "SCA ledger events",
        error instanceof Error ? error.message : "event record_json is malformed"
      );
    }
    const record = validateScaDomainRecord(parsed);
    const priorRecord = records[records.length - 1];
    if (priorRecord !== undefined && record.sequence <= priorRecord.sequence) {
      fail("SCA ledger events", "append events must preserve increasing record sequence");
    }
    const request = eventRequest(event, record);
    assertAppendRecordBinding(request, record);
    if (event.record_json !== canonicalJson(record)) {
      fail("SCA ledger events", "event record_json is not canonical");
    }
    if (event.record_sha256 !== sha256(event.record_json)) {
      fail("SCA ledger events", "event record digest does not match record_json");
    }
    const requestSha256 = appendRequestDigest(request);
    if (event.request_sha256 !== requestSha256 || event.event_id !== `scaevt_${requestSha256}`) {
      fail("SCA ledger events", "event identity does not match its append request");
    }
    if (!locatorMatchesRecord(event.locator, record)) {
      fail("SCA ledger events", "event locator does not match its record");
    }
    if (event.appended_at !== domainRecordTimestamp(record)) {
      fail("SCA ledger events", "event appended_at must equal the record timestamp");
    }
    records.push(record);
    const replay = createCanonicalReplay(records);
    if (event.ledger_sha256 !== replay.sha256) {
      fail("SCA ledger events", "event ledger digest does not match deterministic replay");
    }
    digest = replay.sha256;
    events.push(event);
  }
  const replay = createCanonicalReplay(records);
  return frozenState({
    ...identity,
    records: replay.records,
    events,
    canonical_ndjson: replay.canonical_ndjson,
    ledger_sha256: replay.sha256,
  });
}

function assertCurrentLedgerState(state: ScaLedgerStateV1): void {
  const replayed = replayScaLedgerEvents(state.events, {
    tenant_id: state.tenant_id,
    project_id: state.project_id,
    run_id: state.run_id,
  });
  if (
    replayed.ledger_sha256 !== state.ledger_sha256 ||
    replayed.canonical_ndjson !== state.canonical_ndjson ||
    canonicalJson(replayed.records) !== canonicalJson(state.records)
  ) {
    fail("SCA ledger state", "state does not match its immutable append events");
  }
}

/** Host-owned append boundary with adopt-or-conflict idempotency and optimistic digest fencing. */
export function appendScaLedgerRecord(
  state: ScaLedgerStateV1,
  requestValue: unknown
): ScaLedgerAppendResultV1 {
  assertCurrentLedgerState(state);
  const shaped = validateContract(
    ScaLedgerAppendRequestV1Schema,
    requestValue,
    "SCA ledger append request"
  );
  const record = validateScaDomainRecord(shaped.record);
  const request: ScaLedgerAppendRequestV1 = { ...shaped, record };
  if (
    request.tenant_id !== state.tenant_id ||
    request.project_id !== state.project_id ||
    request.run_id !== state.run_id
  ) {
    fail("SCA ledger append", "append request belongs to another tenant/project/run bundle");
  }
  assertAppendRecordBinding(request, record);
  const requestSha256 = appendRequestDigest(request);
  const existing = state.events.find((event) => event.idempotency_key === request.idempotency_key);
  if (existing !== undefined) {
    if (existing.request_sha256 !== requestSha256) {
      fail("SCA ledger append", "idempotency key conflicts with different immutable operands");
    }
    return { disposition: "adopted", state, event: existing };
  }
  if (request.prior_ledger_sha256 !== state.ledger_sha256) {
    fail("SCA ledger append", "stale prior-ledger digest");
  }
  if (state.records.length >= SCA_MAX_LEDGER_RECORDS) {
    fail("SCA ledger append", `record count exceeds ${SCA_MAX_LEDGER_RECORDS}`);
  }
  const priorRecord = state.records[state.records.length - 1];
  if (priorRecord !== undefined && record.sequence <= priorRecord.sequence) {
    fail("SCA ledger append", "record sequence must increase at the append boundary");
  }
  const replay = createCanonicalReplay([...state.records, record]);
  const recordJson = canonicalJson(record);
  const event = immutableAppendEvent({
    schema_id: "penny.sca-ledger-append-event.v1",
    schema_version: 1,
    event_id: `scaevt_${requestSha256}`,
    tenant_id: request.tenant_id,
    project_id: request.project_id,
    run_id: request.run_id,
    phase_id: request.phase_id,
    idempotency_key: request.idempotency_key,
    request_sha256: requestSha256,
    prior_ledger_sha256: request.prior_ledger_sha256,
    ledger_sha256: replay.sha256,
    record_sha256: sha256(recordJson),
    record_json: recordJson,
    locator: domainRecordIdentity(record),
    appended_at: domainRecordTimestamp(record),
  });
  const next = replayScaLedgerEvents([...state.events, event], {
    tenant_id: state.tenant_id,
    project_id: state.project_id,
    run_id: state.run_id,
  });
  return { disposition: "appended", state: next, event };
}

function completeBundleFrom(
  records: readonly ScaDomainRecordV1[],
  manifest: ManifestV1
): ScaDomainBundleV1 {
  return {
    manifest,
    tasks: records.filter((record) => record.schema_id === "penny.sca-task-record.v1"),
    claims: records.filter((record) => record.schema_id === "penny.sca-claim-record.v1"),
    evidence: records.filter((record) => record.schema_id === "penny.sca-evidence-ref.v1"),
    findings: records.filter((record) => record.schema_id === "penny.sca-finding-record.v1"),
    decisions: records.filter((record) => record.schema_id === "penny.sca-decision-record.v1"),
    gates: records.filter((record) => record.schema_id === "penny.sca-gate-result.v1"),
  };
}

/** Read exactly one complete ledger whose sole manifest is the final NDJSON record. */
export function readCompleteScaLedger(
  bytes: Uint8Array,
  limits: NdjsonReadLimits = DEFAULT_NDJSON_READ_LIMITS
): ScaDomainBundleV1 {
  const values = readBoundedNdjson(bytes, limits);
  const manifestIndexes: number[] = [];
  for (const [index, value] of values.entries()) {
    if (value.schema_id === "penny.sca-manifest.v1") manifestIndexes.push(index);
  }
  if (manifestIndexes.length !== 1) {
    fail("SCA complete ledger", "ledger must contain exactly one manifest");
  }
  const manifestIndex = manifestIndexes[0];
  if (manifestIndex !== values.length - 1) {
    fail("SCA complete ledger", "manifest must be the final ledger record");
  }
  const manifestValue = values[manifestIndex];
  if (manifestValue === undefined || manifestValue.schema_id !== "penny.sca-manifest.v1") {
    fail("SCA complete ledger", "final manifest is missing");
  }
  const records: ScaDomainRecordV1[] = [];
  for (let index = 0; index < manifestIndex; index += 1) {
    const value = values[index];
    if (value === undefined || value.schema_id === "penny.sca-manifest.v1") {
      fail("SCA complete ledger", "manifest may appear only as the final record");
    }
    records.push(value);
  }
  if (records.length === 0) fail("SCA complete ledger", "ledger contains no domain records");
  return validateScaDomainBundle(completeBundleFrom(records, manifestValue));
}
