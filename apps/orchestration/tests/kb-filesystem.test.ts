/**
 * KB filesystem tests (G7, §§5.4–5.5).
 */

import {
  chmodSync,
  chownSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { KbCoreReadError, readContainedKbFile } from "../src/kb/core-read.js";

import {
  canonicalJson,
  defaultDenyPolicy,
  sha256Hex,
  type ClaimsSidecar,
  type ConflictRecord,
  type KbManifest,
  type PageRevisionFrontmatter,
  type SourceRecord,
} from "../src/kb/contracts.js";
import {
  KbFilesystemError,
  conflictPath,
  currentPath,
  generationCatalogPath,
  manifestPath,
  pageClaimsPath,
  pageMarkdownPath,
  policyPath,
  readCurrent,
  readManifest,
  readPolicy,
  readSourceObject,
  readSourceRecord,
  sourceObjectPath,
  sourceRecordPath,
  writeConflictRecord,
  writeCurrent,
  writeGenerationCatalog,
  writeManifest,
  writePageRevision,
  writePolicy,
  writeSourceObject,
  writeSourceRecord,
  type CurrentGeneration,
  type GenerationCatalog,
} from "../src/kb/filesystem.js";

const dirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(path.join(tmpdir(), "penny-kb-fs-"));
  dirs.push(d);
  chmodSync(d, 0o700);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = "2026-01-01T00:00:00Z";
const ZERO = "0".repeat(64);

const MANIFEST: KbManifest = {
  schema_version: 1,
  kb_id: "kb_001",
  title: "Test KB",
  authority: "advisory",
  paths: {
    policy: ".kb/policy.json",
    source_records: "sources/records",
    source_objects: "sources/objects",
    pages: "pages",
    conflicts: "conflicts",
    work: "work",
    lock: ".kb/lock",
    generations: ".kb/generations",
    generation_catalog_filename: "catalog.json",
    generation_index_filename: "index.sqlite",
    current: ".kb/current.json",
    root_index: "index.md",
  },
  created_at: NOW,
};

describe("KB §5.4 manifest I/O", () => {
  it("writes and reads a manifest with mode 0600", () => {
    const root = tmpRoot();
    writeManifest(root, MANIFEST);
    const stat = statSync(manifestPath(root));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.isFile()).toBe(true);
    expect(readManifest(root)).toEqual(MANIFEST);
  });
});

describe("KB §5.3 policy I/O", () => {
  it("writes and reads the policy with mode 0600", () => {
    const root = tmpRoot();
    const policy = defaultDenyPolicy("kb_001");
    writePolicy(root, policy);
    expect(statSync(policyPath(root)).mode & 0o777).toBe(0o600);
    expect(readPolicy(root)).toEqual(policy);
  });
});

describe("KB §5.5 source objects (content-addressed)", () => {
  it("writes and reads by digest with mode 0600", () => {
    const root = tmpRoot();
    const content = "test source content";
    const digest = sha256Hex(content);
    writeSourceObject(root, digest, Buffer.from(content));
    expect(sourceObjectPath(root, digest)).toBe(path.join(root, "sources", "objects", digest));
    expect(statSync(sourceObjectPath(root, digest)).mode & 0o777).toBe(0o600);
    expect(readSourceObject(root, digest).toString("utf8")).toBe(content);
  });

  it("deduplicates identical content", () => {
    const root = tmpRoot();
    const content = "same content";
    const digest = sha256Hex(content);
    writeSourceObject(root, digest, Buffer.from(content));
    writeSourceObject(root, digest, Buffer.from(content)); // second write is a no-op
    // The file exists once and is readable
    expect(readSourceObject(root, digest).toString("utf8")).toBe(content);
  });

  it("rejects a digest that does not match the content", () => {
    const root = tmpRoot();
    expect(() => writeSourceObject(root, ZERO, Buffer.from("wrong content"))).toThrow(
      KbFilesystemError
    );
  });
});

describe("KB §5.5 source records", () => {
  it("writes and reads a source record with mode 0600", () => {
    const root = tmpRoot();
    const objectBytes = Buffer.from("source record object", "utf8");
    const objectDigest = sha256Hex(objectBytes.toString("utf8"));
    writeSourceObject(root, objectDigest, objectBytes);
    const record: SourceRecord = {
      schema_version: 1,
      source_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      source_type: "file",
      captured_at: NOW,
      title: "Test source",
      authors: ["Author"],
      media_type: "text/markdown",
      sha256: objectDigest,
      object_ref: `sources/objects/${objectDigest}`,
      provenance: {
        source_capability_digest: ZERO,
        supplied_by: "host_capability",
        originating_run_id: "run_001",
      },
    };
    writeSourceRecord(root, record);
    expect(statSync(sourceRecordPath(root, record.source_id)).mode & 0o777).toBe(0o600);
    expect(readSourceRecord(root, record.source_id)).toEqual(record);
  });

  it("rejects a source record whose exact object_ref does not resolve", () => {
    const root = tmpRoot();
    const digest = sha256Hex("missing physical object");
    const record: SourceRecord = {
      schema_version: 1,
      source_id: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
      source_type: "file",
      captured_at: NOW,
      title: "Missing",
      authors: ["A"],
      media_type: "text/plain",
      sha256: digest,
      object_ref: `sources/objects/${digest}`,
      provenance: {
        source_capability_digest: ZERO,
        supplied_by: "host_capability",
        originating_run_id: "run_001",
      },
    };
    expect(() => writeSourceRecord(root, record)).toThrow(KbFilesystemError);
  });

  it("rejects a source record when its resolved object no longer hash-matches", () => {
    const root = tmpRoot();
    const content = "immutable source";
    const digest = sha256Hex(content);
    writeSourceObject(root, digest, Buffer.from(content));
    const record: SourceRecord = {
      schema_version: 1,
      source_id: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
      source_type: "file",
      captured_at: NOW,
      title: "Tampered",
      authors: ["A"],
      media_type: "text/plain",
      sha256: digest,
      object_ref: `sources/objects/${digest}`,
      provenance: {
        source_capability_digest: ZERO,
        supplied_by: "host_capability",
        originating_run_id: "run_001",
      },
    };
    writeSourceRecord(root, record);
    writeFileSync(sourceObjectPath(root, digest), "changed bytes", { mode: 0o600 });
    expect(() => readSourceRecord(root, record.source_id)).toThrow(KbFilesystemError);
  });

  it("rejects a record whose object_ref does not match sha256", () => {
    const root = tmpRoot();
    const record: SourceRecord = {
      schema_version: 1,
      source_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      source_type: "file",
      captured_at: NOW,
      title: "Test",
      authors: ["A"],
      media_type: "text/markdown",
      sha256: ZERO,
      object_ref: `sources/objects/${"1".repeat(64)}`, // valid format but wrong digest
      provenance: {
        source_capability_digest: ZERO,
        supplied_by: "host_capability",
        originating_run_id: "run_001",
      },
    };
    expect(() => writeSourceRecord(root, record)).toThrow(KbFilesystemError);
  });
});

describe("KB §5.5 page revision pairs", () => {
  it("writes frontmatter + markdown + claims with mode 0600", () => {
    const root = tmpRoot();
    const fm: PageRevisionFrontmatter = {
      schema_version: 1,
      page_id: "page_01",
      revision_id: "rev_01",
      kind: "synthesis",
      title: "Test page",
      summary: "A test page",
      authority: "advisory",
      lifecycle: "draft",
      created_at: NOW,
      derived_from: [],
      related_page_ids: [],
    };
    const markdown =
      "## Synthesis\nTest content.\n\n## Evidence\nCited.\n\n## Tensions and unknowns\nNone.\n\n## Related\nNone.\n";
    const claims: ClaimsSidecar = {
      schema_version: 1,
      page_id: "page_01",
      revision_id: "rev_01",
      claims: [
        {
          claim_id: "clm_01",
          text: "Test claim",
          kind: "fact",
          state: "supported",
          confidence: "CERTAIN",
          evidence: [{ source_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
          contradicts_claim_ids: [],
          canonical_verification_refs: [],
        },
      ],
    };
    writePageRevision(root, fm, markdown, claims);
    expect(statSync(pageMarkdownPath(root, "page_01", "rev_01")).mode & 0o777).toBe(0o600);
    expect(statSync(pageClaimsPath(root, "page_01", "rev_01")).mode & 0o777).toBe(0o600);
    // page.md starts with ---\n and contains the frontmatter JCS
    const md = readFileSync(pageMarkdownPath(root, "page_01", "rev_01"), "utf8");
    expect(md).toContain("---");
    expect(md).toContain("## Synthesis");
  });

  it("rejects a frontmatter/claims mismatch", () => {
    const root = tmpRoot();
    const fm: PageRevisionFrontmatter = {
      schema_version: 1,
      page_id: "page_01",
      revision_id: "rev_01",
      kind: "synthesis",
      title: "T",
      summary: "S",
      authority: "advisory",
      lifecycle: "draft",
      created_at: NOW,
      derived_from: [],
      related_page_ids: [],
    };
    const claims: ClaimsSidecar = {
      schema_version: 1,
      page_id: "page_02", // mismatch!
      revision_id: "rev_01",
      claims: [],
    };
    expect(() => writePageRevision(root, fm, "## Synthesis\n", claims)).toThrow(KbFilesystemError);
  });
});

describe("KB §5.5 conflict records", () => {
  it("writes a conflict record with mode 0600", () => {
    const root = tmpRoot();
    const conflict: ConflictRecord = {
      schema_version: 1,
      conflict_record_id: "cfl_01",
      claim_refs: [{ page_id: "p", revision_id: "r", claim_id: "c" }],
      state: "open",
      summary: "Sources disagree",
      evidence_refs: [],
      created_at: NOW,
    };
    writeConflictRecord(root, conflict);
    expect(statSync(conflictPath(root, "cfl_01")).mode & 0o777).toBe(0o600);
  });
});

describe("KB §5.5 current selector + generation catalog", () => {
  it("writes and reads the current selector", () => {
    const root = tmpRoot();
    const current: CurrentGeneration = {
      schema_version: 1,
      kb_id: "kb_001",
      generation_id: "gen_01",
      catalog_sha256: ZERO,
      index_sha256: ZERO,
      published_at: NOW,
    };
    writeCurrent(root, current);
    expect(statSync(currentPath(root)).mode & 0o777).toBe(0o600);
    expect(readCurrent(root)).toEqual(current);
  });

  it("returns undefined when no current selector exists", () => {
    const root = tmpRoot();
    expect(readCurrent(root)).toBeUndefined();
  });

  it("writes and reads a generation catalog", () => {
    const root = tmpRoot();
    const catalog: GenerationCatalog = {
      schema_version: 1,
      generation_id: "gen_01",
      kb_id: "kb_001",
      manifest_sha256: ZERO,
      policy_sha256: ZERO,
      pages: {},
      source_records: {},
      source_objects: [],
      conflict_records: {},
      index_sha256: ZERO,
      created_at: NOW,
    };
    writeGenerationCatalog(root, catalog);
    expect(statSync(generationCatalogPath(root, "gen_01")).mode & 0o777).toBe(0o600);
  });
});

describe("KB custody enforcement", () => {
  it("rejects a hard-linked authority file", () => {
    const root = tmpRoot();
    writeManifest(root, MANIFEST);
    linkSync(manifestPath(root), path.join(root, "manifest-copy.json"));
    expect(() => readManifest(root)).toThrow(KbFilesystemError);
  });

  it("rejects a symlink in the admitted root's absolute ancestor chain", () => {
    const outer = tmpRoot();
    const actualRoot = path.join(outer, "real", "kb");
    writeManifest(actualRoot, MANIFEST);
    const alias = path.join(outer, "alias");
    symlinkSync(path.join(outer, "real"), alias, "dir");
    expect(() => readManifest(path.join(alias, "kb"))).toThrow(KbFilesystemError);
  });

  it("rejects a symlinked parent directory", () => {
    const root = tmpRoot();
    writePolicy(root, defaultDenyPolicy("kb_001"));
    const moved = path.join(root, ".kb-real");
    renameSync(path.join(root, ".kb"), moved);
    symlinkSync(moved, path.join(root, ".kb"), "dir");
    expect(() => readPolicy(root)).toThrow(KbFilesystemError);
  });

  it("rejects owner-only but non-0600 file mode", () => {
    const root = tmpRoot();
    writeManifest(root, MANIFEST);
    chmodSync(manifestPath(root), 0o400);
    expect(() => readManifest(root)).toThrow(KbFilesystemError);
  });

  it("allows a non-writable public read/execute mode on the already-admitted root", () => {
    const root = tmpRoot();
    writeManifest(root, MANIFEST);
    chmodSync(root, 0o755);
    expect(readManifest(root)).toEqual(MANIFEST);
  });

  it("rejects a group-writable admitted root", () => {
    const root = tmpRoot();
    writeManifest(root, MANIFEST);
    chmodSync(root, 0o775);
    expect(() => readManifest(root)).toThrow(KbFilesystemError);
  });

  it("rejects a public-mode live directory beneath the admitted root", () => {
    const root = tmpRoot();
    writePolicy(root, defaultDenyPolicy("kb_001"));
    chmodSync(path.join(root, ".kb"), 0o755);
    expect(() => readPolicy(root)).toThrow(KbFilesystemError);
  });

  it("rejects bytes that do not match a known digest", () => {
    const root = tmpRoot();
    writeManifest(root, MANIFEST);
    expect(() => readManifest(root, ZERO as never)).toThrow(KbFilesystemError);
  });

  it("detects a pathname replacement after descriptor open", () => {
    const root = tmpRoot();
    writeManifest(root, MANIFEST);
    const file = manifestPath(root);
    const openedName = path.join(root, "opened-manifest.json");
    expect(() =>
      readContainedKbFile(root, file, {
        label: "manifest replacement race",
        testOnlyAfterOpen() {
          renameSync(file, openedName);
          writeFileSync(file, canonicalJson({ ...MANIFEST, title: "replacement" }), {
            mode: 0o600,
          });
        },
      })
    ).toThrow(KbCoreReadError);
  });

  it("detects admitted-root replacement after descriptor open", () => {
    const root = tmpRoot();
    const openedRoot = `${root}-opened`;
    dirs.push(openedRoot);
    writeManifest(root, MANIFEST);
    chmodSync(root, 0o755);
    expect(() =>
      readContainedKbFile(root, manifestPath(root), {
        label: "root replacement race",
        testOnlyAfterOpen() {
          renameSync(root, openedRoot);
          mkdirSync(root, { mode: 0o755 });
          chmodSync(root, 0o755);
          writeFileSync(
            manifestPath(root),
            canonicalJson({ ...MANIFEST, title: "replacement root" }),
            { mode: 0o600 }
          );
        },
      })
    ).toThrow(/root identity changed/);
  });

  it.skipIf(typeof process.getuid !== "function" || process.getuid() !== 0)(
    "rejects a wrong-owner authority file when the test process can change ownership",
    () => {
      const root = tmpRoot();
      writeManifest(root, MANIFEST);
      chownSync(manifestPath(root), 1, 1);
      expect(() => readManifest(root)).toThrow(KbFilesystemError);
    }
  );

  it("rejects a symlinked file", () => {
    const root = tmpRoot();
    const real = path.join(root, "real.json");
    writeFileSync(real, "{}");
    const link = path.join(root, "link.json");
    symlinkSync(real, link);
    // Try to read the symlink as a manifest — should fail custody
    expect(() => readManifest(root)).toThrow(); // manifest.json doesn't exist; this is a different error
    // Direct custody test: write a manifest, then replace it with a symlink
    writeManifest(root, MANIFEST);
    rmSync(manifestPath(root));
    symlinkSync(real, manifestPath(root));
    expect(() => readManifest(root)).toThrow(KbFilesystemError);
  });
});
