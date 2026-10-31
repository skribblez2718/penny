import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256, type ArtifactRef, type Directive } from "../dist/index.js";
import { evaluateResearchLatestCoreDod } from "../dist/playbooks/research.js";
import {
  ContentFixtureOwner,
  acceptedContentProduct,
  nonbindingContext,
} from "./helpers/universal-content-fixtures.js";
import { assertReaderBrief } from "./helpers/universal-content-oracle.js";
import {
  requireRecord,
  requireSqlite,
  requireString,
  requireStringArray,
  requireValue,
} from "./helpers/narrowing.js";

// Mock cognition only: both variants use real engines, SQLite stores, signed worker
// receipts, Research projection/review/rendering and contextual completion replay.
function terminal(directive: Directive) {
  acceptedContentProduct(directive);
  if (directive.action !== "complete") throw new Error("expected successful terminal");
  return directive;
}

function currentDod(host: ContentFixtureOwner, source: ArtifactRef): boolean {
  const context = requireValue(host.checkpointer.loadRunById(source.run_id), "source run");
  const admission = requireValue(
    host.checkpointer.completionAdmission(source.run_id),
    "source admission"
  );
  return evaluateResearchLatestCoreDod({
    checkpointer: host.checkpointer,
    context,
    terminal: terminal(requireValue(context.terminalDirective, "source terminal")),
    originState: admission.origin_state,
    latestProduct: admission.latest_product,
    artifactReader: host.artifacts,
    projectRoot: host.root,
  }).passed;
}

interface ExactRunBytes {
  readonly control: Readonly<Record<string, Buffer>>;
  readonly artifacts: Readonly<Record<string, Buffer>>;
  readonly files: Readonly<Record<string, Buffer>>;
}

function snapshot(host: ContentFixtureOwner, source: ArtifactRef): ExactRunBytes {
  const { DatabaseSync } = requireSqlite(process.getBuiltinModule("node:sqlite"));
  const db = new DatabaseSync(path.join(host.root, "orchestration.db"), { readOnly: true });
  const manifest = new DatabaseSync(path.join(host.root, "artifacts", "manifest.db"), {
    readOnly: true,
  });
  try {
    const context = requireValue(host.checkpointer.loadRunById(source.run_id), "source run");
    const result = terminal(requireValue(context.terminalDirective, "source terminal")).result;
    const control: Record<string, Buffer> = {};
    for (const [label, sql] of [
      [
        "run",
        "SELECT run_id AS id, CAST(context_json AS BLOB) AS bytes FROM runs WHERE run_id = ?",
      ],
      [
        "receipt",
        "SELECT receipt_id AS id, CAST(result_json AS BLOB) AS bytes FROM receipts WHERE run_id = ? ORDER BY receipt_id",
      ],
      [
        "event",
        "SELECT CAST(sequence AS TEXT) AS id, CAST(payload_json AS BLOB) AS bytes FROM events WHERE run_id = ? ORDER BY sequence",
      ],
    ]) {
      for (const row of db.prepare(requireValue(sql, "snapshot query")).all(source.run_id)) {
        const id = requireString(row["id"], "snapshot row identity");
        const bytes = row["bytes"];
        if (!(bytes instanceof Uint8Array)) throw new Error("snapshot bytes are not a BLOB");
        control[`${label}/${id}`] = Buffer.from(bytes);
      }
    }
    const artifacts: Record<string, Buffer> = {};
    for (const row of manifest
      .prepare(
        "SELECT artifact_id, ref_json, metadata_json FROM artifacts WHERE run_id = ? ORDER BY artifact_id"
      )
      .all(source.run_id)) {
      const id = requireString(row["artifact_id"], "artifact identity");
      artifacts[`${id}/ref`] = Buffer.from(requireString(row["ref_json"], "exact manifest ref"));
      artifacts[`${id}/metadata`] = Buffer.from(
        requireString(row["metadata_json"], "exact artifact metadata")
      );
      artifacts[`${id}/content`] = host.artifacts.readById(id);
    }
    const files = Object.fromEntries(
      requireStringArray(result["report_files"], "render files").map((file) => [
        path.relative(host.root, file),
        readFileSync(file),
      ])
    );
    return { control, artifacts, files };
  } finally {
    manifest.close();
    db.close();
  }
}

function digestRecord(bytes: Readonly<Record<string, Buffer>>) {
  return Object.fromEntries(Object.entries(bytes).map(([key, value]) => [key, sha256(value)]));
}

async function consume(
  host: ContentFixtureOwner,
  source: ArtifactRef,
  runId: string,
  scenario: "base" | "counterfactual"
) {
  const { terminal: output, client } = await host.execute("produce", runId, "base", {
    producer: "research",
    source,
    scenario,
    wording: "direct",
  });
  const product = acceptedContentProduct(output);
  assertReaderBrief(host.readProduct(product), { producer: "research", source, scenario });
  expect(
    client.invocations.every((invocation) =>
      invocation.inputArtifacts.some((ref) => canonicalJson(ref) === canonicalJson(source))
    )
  ).toBe(true);
  console.info("RESEARCH_REPLAY_CONSUMED", runId, source.artifact_id);
  return product;
}

describe("Research contextual replay across independent runs in one owner", () => {
  it("keeps the first exact accepted product and materialized graph usable after a second same-question variant", async () => {
    using host = new ContentFixtureOwner();
    const first = acceptedContentProduct(
      (await host.execute("research", "research-replay-seven")).terminal
    );
    await consume(host, first, "research-replay-before", "base");
    const before = snapshot(host, first);
    const dodBefore = currentDod(host, first);
    expect(dodBefore).toBe(true);
    const second = acceptedContentProduct(
      (await host.execute("research", "research-replay-fourteen", "counterfactual")).terminal
    );
    const after = snapshot(host, first);
    const dodAfter = currentDod(host, first);
    expect(first.run_id).not.toBe(second.run_id);
    expect(first.artifact_id).not.toBe(second.artifact_id);
    expect(first.content_digest).not.toBe(second.content_digest);
    expect(host.artifacts.refById(first.artifact_id)).toEqual(first);
    expect(after.control).toEqual(before.control);
    expect(after.artifacts).toEqual(before.artifacts);
    console.info(
      "RESEARCH_REPLAY_EXACT_BYTES",
      canonicalJson({
        first,
        second,
        dod_before: dodBefore,
        dod_after: dodAfter,
        control_before: digestRecord(before.control),
        control_after: digestRecord(after.control),
        artifacts_before: digestRecord(before.artifacts),
        artifacts_after: digestRecord(after.artifacts),
        files_before: digestRecord(before.files),
        files_after: digestRecord(after.files),
      })
    );
    // A soft assertion preserves evidence that the second context still works,
    // then the first exact ref hits the real shared admission path again.
    expect.soft(after.files).toEqual(before.files);
    expect.soft(dodAfter).toBe(true);
    await consume(host, second, "research-replay-second", "counterfactual");
    await consume(host, first, "research-replay-after", "base");
    expect(snapshot(host, first)).toEqual(before);
  });

  it.each(["missing", "changed", "symlink", "nonregular"] as const)(
    "still refuses %s materialized first-run renders before consumer creation",
    async (fault) => {
      using host = new ContentFixtureOwner();
      const source = acceptedContentProduct(
        (await host.execute("research", `research-replay-drift-${fault}`)).terminal
      );
      const context = requireValue(host.checkpointer.loadRunById(source.run_id), "source context");
      const result = terminal(requireValue(context.terminalDirective, "source terminal")).result;
      const files = requireStringArray(result["report_files"], "render files");
      const report = requireValue(files[0], "report file");
      const bytes = readFileSync(report);
      // Corrupt disposable fixture files only; never repair/reconstruct owner state.
      unlinkSync(report);
      if (fault === "changed") writeFileSync(report, "changed render bytes");
      if (fault === "nonregular") mkdirSync(report);
      if (fault === "symlink") {
        const other = path.join(host.root, "other-render.md");
        writeFileSync(other, bytes);
        symlinkSync(other, report);
      }
      expect(currentDod(host, source)).toBe(false);
      const request = host.start(
        "produce",
        `research-replay-drift-reader-${fault}`,
        nonbindingContext(source)
      );
      expect(() => host.engine("produce").handle(request)).toThrow(
        /COMPOSITION_CONTEXT_UNACCEPTED/u
      );
      expect(host.checkpointer.runExists(request.identity.run_id)).toBe(false);
      expect(requireRecord(host.readProduct(source), "core")["schema_id"]).toBe(
        "penny.grounded-synthesis.v1"
      );
    }
  );
});
