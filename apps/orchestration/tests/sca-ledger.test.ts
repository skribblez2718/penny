import { describe, expect, it } from "vitest";

import {
  SCA_MAX_LEDGER_RECORDS,
  domainRecordIdentity,
  type ManifestV1,
  type ScaDomainRecordV1,
  type TaskRecordV1,
} from "../src/sca/contracts.js";
import {
  SCA_EMPTY_LEDGER_SHA256,
  appendScaLedgerRecord,
  assertCanonicalReplayEquivalent,
  canonicalReplayDigest,
  compareCanonicalReplays,
  createCanonicalReplay,
  createEmptyScaLedger,
  readBoundedNdjson,
  readCompleteScaLedger,
  replayScaLedgerEvents,
  type ScaLedgerAppendRequestV1,
} from "../src/sca/ledger.js";
import { requireValue } from "./helpers/narrowing.js";
import {
  SCA_PROJECT_ID,
  SCA_RUN_ID,
  SCA_TENANT_ID,
  createValidScaDomainFixture,
} from "./helpers/sca-domain-fixtures.js";

function ndjson(values: readonly unknown[]): Uint8Array {
  return Buffer.from(`${values.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
}

function deterministicMutation(seed: number, text: string): string {
  let state = seed + 1;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return `${text} mutation-${state >>> 0}`;
}

function appendRequest(input: {
  readonly key: string;
  readonly prior: string;
  readonly record: ScaDomainRecordV1;
}): ScaLedgerAppendRequestV1 {
  return {
    schema_id: "penny.sca-ledger-append-request.v1",
    schema_version: 1,
    tenant_id: input.record.tenant_id,
    project_id: input.record.project_id,
    run_id: input.record.run_id,
    phase_id: input.record.phase_id,
    idempotency_key: input.key,
    prior_ledger_sha256: input.prior,
    record: input.record,
  };
}

describe("S-01 bounded complete ledger, append boundary, and deterministic replay", () => {
  it("reads bounded NDJSON and one complete final-manifest ledger", () => {
    using fixture = createValidScaDomainFixture();
    const values = [...fixture.records, fixture.bundle.manifest];
    expect(readBoundedNdjson(ndjson(values))).toHaveLength(values.length);
    expect(readCompleteScaLedger(ndjson(values))).toEqual(fixture.bundle);
    expect(
      readBoundedNdjson(
        Buffer.from(values.map((value) => JSON.stringify(value)).join("\n"), "utf8")
      )
    ).toHaveLength(values.length);
  });

  it("rejects missing, double, nonfinal, digest-invalid, and reference-invalid manifests", () => {
    using fixture = createValidScaDomainFixture();
    const manifest = fixture.bundle.manifest;
    expect(() => readCompleteScaLedger(ndjson(fixture.records))).toThrow(/exactly one manifest/u);
    expect(() => readCompleteScaLedger(ndjson([...fixture.records, manifest, manifest]))).toThrow(
      /exactly one manifest/u
    );
    expect(() =>
      readCompleteScaLedger(
        ndjson([requireValue(fixture.records[0], "record"), manifest, ...fixture.records.slice(1)])
      )
    ).toThrow(/final ledger record|exactly one manifest/u);
    expect(() =>
      readCompleteScaLedger(
        ndjson([...fixture.records, { ...manifest, ledger_sha256: "f".repeat(64) }])
      )
    ).toThrow(/ledger_sha256/u);

    const finding = requireValue(fixture.bundle.findings[0], "finding");
    const changedRecords = fixture.records.map((record) =>
      record.schema_id === "penny.sca-finding-record.v1"
        ? { ...record, claim_ids: ["claim-missing"] }
        : record
    );
    const replay = createCanonicalReplay(changedRecords);
    const referenceInvalid: ManifestV1 = {
      ...manifest,
      records: replay.records.map((record) => domainRecordIdentity(record)),
      ledger_sha256: replay.sha256,
    };
    expect(finding.claim_ids).toContain("claim-source-fact");
    expect(() => readCompleteScaLedger(ndjson([...changedRecords, referenceInvalid]))).toThrow(
      /does not exist/u
    );
  });

  it("admits the lowered contract maximum plus its manifest under default limits", () => {
    using fixture = createValidScaDomainFixture();
    const template = requireValue(fixture.bundle.tasks[0], "task template");
    const tasks: TaskRecordV1[] = Array.from({ length: SCA_MAX_LEDGER_RECORDS }, (_, index) => ({
      ...template,
      task_id: `task-boundary-${String(index + 1).padStart(3, "0")}`,
      sequence: index + 1,
      created_at: "2026-09-16T01:00:00.000000001Z",
      updated_at: "2026-09-16T01:00:00.000000001Z",
    }));
    const replay = createCanonicalReplay(tasks);
    const manifest: ManifestV1 = {
      ...fixture.bundle.manifest,
      manifest_id: "manifest-max-boundary",
      records: replay.records.map((record) => domainRecordIdentity(record)),
      record_count: replay.records.length,
      first_sequence: 1,
      last_sequence: SCA_MAX_LEDGER_RECORDS,
      ledger_sha256: replay.sha256,
      created_at: "2026-09-16T01:00:00.000000001Z",
    };
    const read = readCompleteScaLedger(ndjson([...tasks, manifest]));
    expect(read.tasks).toHaveLength(SCA_MAX_LEDGER_RECORDS);
  });

  it("fails the whole bounded read on malformed, duplicate-key, blank, unknown, or oversized input", () => {
    using fixture = createValidScaDomainFixture();
    const valid = JSON.stringify(requireValue(fixture.records[0], "first record"));

    for (const bytes of [
      Buffer.from("{not-json}\n", "utf8"),
      Buffer.from('{"schema_id":"penny.sca-task-record.v1","schema_id":"duplicate"}\n', "utf8"),
      Buffer.from(`${valid}\n\n`, "utf8"),
      Buffer.from('{"schema_id":"penny.sca-unknown.v1"}\n', "utf8"),
      Buffer.from(`${valid}\n{broken}\n`, "utf8"),
      Uint8Array.from([0xff, 0xfe]),
    ]) {
      expect(() => readBoundedNdjson(bytes)).toThrow();
    }

    const one = ndjson([requireValue(fixture.records[0], "first")]);
    expect(() =>
      readBoundedNdjson(one, {
        maxBytes: one.byteLength - 1,
        maxLineBytes: one.byteLength - 1,
        maxRecords: 1,
      })
    ).toThrow(/maxBytes/u);
    expect(() =>
      readBoundedNdjson(one, {
        maxBytes: one.byteLength,
        maxLineBytes: 16,
        maxRecords: 1,
      })
    ).toThrow(/maxLineBytes/u);
    expect(() =>
      readBoundedNdjson(one, {
        maxBytes: Number.POSITIVE_INFINITY,
        maxLineBytes: one.byteLength,
        maxRecords: 1,
      })
    ).toThrow(/positive safe integer/u);
  });

  it("appends atomically, adopts exact duplicates, and rejects key conflicts and stale writers", () => {
    using fixture = createValidScaDomainFixture();
    const taskV1 = requireValue(fixture.bundle.tasks[0], "task v1");
    const taskV2 = requireValue(fixture.bundle.tasks[1], "task v2");
    const empty = createEmptyScaLedger({
      tenant_id: SCA_TENANT_ID,
      project_id: SCA_PROJECT_ID,
      run_id: SCA_RUN_ID,
    });
    expect(empty.ledger_sha256).toBe(SCA_EMPTY_LEDGER_SHA256);

    const firstRequest = appendRequest({
      key: "append-task-v1",
      prior: empty.ledger_sha256,
      record: taskV1,
    });
    const first = appendScaLedgerRecord(empty, firstRequest);
    expect(first.disposition).toBe("appended");
    expect(Object.isFrozen(first.event)).toBe(true);
    expect(Object.isFrozen(first.event.locator)).toBe(true);
    expect(Object.isFrozen(first.state.events)).toBe(true);
    expect(Object.isFrozen(first.state.records)).toBe(true);
    expect(Object.isFrozen(requireValue(first.state.records[0], "stored record"))).toBe(true);
    const frozenRecord = requireValue(first.state.records[0], "stored record");
    expect(Reflect.set(frozenRecord, "title", "mutated")).toBe(false);
    expect(frozenRecord).toEqual(taskV1);

    const adopted = appendScaLedgerRecord(first.state, firstRequest);
    expect(adopted.disposition).toBe("adopted");
    expect(adopted.state).toBe(first.state);
    expect(() =>
      appendScaLedgerRecord(first.state, {
        ...firstRequest,
        record: { ...taskV1, title: "Conflicting immutable title" },
      })
    ).toThrow(/idempotency key conflicts/u);
    expect(() =>
      appendScaLedgerRecord(
        first.state,
        appendRequest({ key: "append-task-v2-stale", prior: empty.ledger_sha256, record: taskV2 })
      )
    ).toThrow(/stale prior-ledger digest/u);

    const second = appendScaLedgerRecord(
      first.state,
      appendRequest({ key: "append-task-v2", prior: first.state.ledger_sha256, record: taskV2 })
    );
    expect(second.disposition).toBe("appended");
    const lateAdoption = appendScaLedgerRecord(second.state, firstRequest);
    expect(lateAdoption.disposition).toBe("adopted");
    expect(lateAdoption.state).toBe(second.state);
  });

  it("replays immutable append events deterministically and rejects cross-project appends", () => {
    using fixture = createValidScaDomainFixture();
    const taskV1 = requireValue(fixture.bundle.tasks[0], "task v1");
    const empty = createEmptyScaLedger({
      tenant_id: SCA_TENANT_ID,
      project_id: SCA_PROJECT_ID,
      run_id: SCA_RUN_ID,
    });
    const appended = appendScaLedgerRecord(
      empty,
      appendRequest({ key: "append-replay", prior: empty.ledger_sha256, record: taskV1 })
    );
    const replayed = replayScaLedgerEvents(appended.state.events, {
      tenant_id: SCA_TENANT_ID,
      project_id: SCA_PROJECT_ID,
      run_id: SCA_RUN_ID,
    });
    expect(replayed).toEqual(appended.state);
    expect(() =>
      appendScaLedgerRecord(empty, {
        ...appendRequest({ key: "append-foreign", prior: empty.ledger_sha256, record: taskV1 }),
        project_id: `prj_${"9".repeat(32)}`,
      })
    ).toThrow(/another tenant\/project\/run bundle|must match/u);
  });

  it("canonicalizes ordering and detects deterministic mutation fuzz", () => {
    using fixture = createValidScaDomainFixture();
    const reversed = [...fixture.records].reverse();
    const replay = createCanonicalReplay(fixture.records);
    const reversedReplay = createCanonicalReplay(reversed);

    expect(replay.sha256).toBe(reversedReplay.sha256);
    expect(replay.canonical_ndjson).toBe(reversedReplay.canonical_ndjson);
    expect(canonicalReplayDigest(fixture.records)).toBe(replay.sha256);
    expect(compareCanonicalReplays(fixture.records, reversed)).toEqual({
      equivalent: true,
      digest: replay.sha256,
    });
    expect(() => assertCanonicalReplayEquivalent(fixture.records, reversed)).not.toThrow();

    for (let seed = 0; seed < 64; seed += 1) {
      const mutated = fixture.records.map((record) =>
        record.schema_id === "penny.sca-evidence-ref.v1"
          ? { ...record, summary: deterministicMutation(seed, record.summary) }
          : record
      );
      const comparison = compareCanonicalReplays(fixture.records, mutated);
      expect(comparison.equivalent).toBe(false);
      if (!comparison.equivalent) expect(comparison.first_divergent_sequence).toBe(3);
    }
  });

  it("detects exact nanosecond-order reversal that millisecond parsing would erase", () => {
    using fixture = createValidScaDomainFixture();
    const template = requireValue(fixture.bundle.tasks[0], "task template");
    const first: TaskRecordV1 = {
      ...template,
      task_id: "task-nanos-first",
      sequence: 1,
      created_at: "2026-09-16T00:00:00.000000002Z",
      updated_at: "2026-09-16T00:00:00.000000002Z",
    };
    const second: TaskRecordV1 = {
      ...template,
      task_id: "task-nanos-second",
      sequence: 2,
      created_at: "2026-09-16T00:00:00.000000001Z",
      updated_at: "2026-09-16T00:00:00.000000001Z",
    };
    expect(() => createCanonicalReplay([first, second])).toThrow(/non-decreasing/u);
  });

  it("rejects duplicate sequences and mutation after terminal replay", () => {
    using fixture = createValidScaDomainFixture();
    const second = requireValue(fixture.records[1], "second record");
    expect(() =>
      createCanonicalReplay([...fixture.records.slice(0, 1), { ...second, sequence: 1 }])
    ).toThrow(/sequences must be unique/u);

    const terminalTask = requireValue(fixture.bundle.tasks[2], "terminal task");
    expect(() =>
      createCanonicalReplay([
        ...fixture.records,
        {
          ...terminalTask,
          status: "rejected",
          version: 4,
          sequence: 15,
          updated_at: "2026-09-16T00:00:15Z",
        },
      ])
    ).toThrow(/terminal/u);
  });
});
