/**
 * KB contracts — schema validation tests (G7).
 *
 * Every schema is closed (rejects unknown keys), validates its reference instance,
 * and fails on representative mutations. These tests are the first G7 gate slice:
 * if the data model is wrong, everything built on it is wrong.
 */

import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  ClaimsSidecarSchema,
  ConflictRecordSchema,
  CurrentGenerationSchema,
  defaultDenyPolicy,
  GenerationCatalogSchema,
  KbManifestSchema,
  KbPolicySchema,
  KbProfileRegistrySchema,
  KbProfileSchema,
  PageRevisionFrontmatterSchema,
  sha256Hex,
  SourceRecordSchema,
  validateKbContract,
  type KbManifest,
  type KbPolicy,
  type KbProfile,
  type SourceRecord,
} from "../src/kb/contracts.js";

const ZERO = "0".repeat(64) as never;
const NOW = "2026-01-01T00:00:00Z";

// ── Reference instances ─────────────────────────────────────────────────────

const profile: KbProfile = {
  schema_version: 1,
  kb_profile_id: "kbp_demo",
  kb_root: "/tmp/kb",
  allow_create: true,
  repository_admission: { mode: "outside_worktree" },
};

const manifest: KbManifest = {
  schema_version: 1,
  kb_id: "kb_001",
  title: "Demo",
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

const sourceRecord: SourceRecord = {
  schema_version: 1,
  source_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  source_type: "file",
  captured_at: NOW,
  title: "Example",
  authors: ["Author"],
  media_type: "text/markdown",
  sha256: ZERO,
  object_ref: `sources/objects/${ZERO}`,
  provenance: {
    source_capability_digest: ZERO,
    supplied_by: "host_capability",
    originating_run_id: "run_001",
  },
};

describe("KB §5.1 profile registry", () => {
  it("validates a correct profile", () => {
    expect(() => validateKbContract(KbProfileSchema, profile, "profile")).not.toThrow();
  });

  it("rejects an unknown key", () => {
    expect(() =>
      validateKbContract(KbProfileSchema, { ...profile, rogue: true }, "profile")
    ).toThrow();
  });

  it("validates a registry containing profiles", () => {
    expect(() =>
      validateKbContract(
        KbProfileRegistrySchema,
        { schema_version: 1, profiles: [profile] },
        "registry"
      )
    ).not.toThrow();
  });

  it("rejects an inside_allowlisted_scaffold admission missing scaffold_root", () => {
    const bad = { ...profile, repository_admission: { mode: "inside_allowlisted_scaffold" } };
    expect(() => validateKbContract(KbProfileSchema, bad, "profile")).toThrow();
  });
});

describe("KB §5.3 policy", () => {
  it("validates the default-deny policy", () => {
    const policy = defaultDenyPolicy("kb_001");
    expect(() => validateKbContract(KbPolicySchema, policy, "policy")).not.toThrow();
    expect(policy.processing_mode).toBe("local_only");
    expect(policy.allowed_parent_models).toEqual([]);
    expect(policy.parent_result.derived_query_answer).toBe("deny");
  });

  it("rejects an unknown key", () => {
    const policy = { ...defaultDenyPolicy("kb_001"), rogue: true };
    expect(() => validateKbContract(KbPolicySchema, policy, "policy")).toThrow();
  });

  it("rejects a max_utf8_bytes out of range", () => {
    const policy = defaultDenyPolicy("kb_001");
    (policy.parent_result as { max_utf8_bytes: number }).max_utf8_bytes = 0;
    expect(() => validateKbContract(KbPolicySchema, policy, "policy")).toThrow();
  });
});

describe("KB §5.4 manifest", () => {
  it("validates a correct manifest", () => {
    expect(() => validateKbContract(KbManifestSchema, manifest, "manifest")).not.toThrow();
  });

  it("rejects a non-advisory authority", () => {
    expect(() =>
      validateKbContract(KbManifestSchema, { ...manifest, authority: "canonical" }, "manifest")
    ).toThrow();
  });

  it("rejects a modified path value", () => {
    const bad = { ...manifest, paths: { ...manifest.paths, policy: ".kb/other.json" } };
    expect(() => validateKbContract(KbManifestSchema, bad, "manifest")).toThrow();
  });
});

describe("KB §5.5 source record", () => {
  it("validates a correct record", () => {
    expect(() => validateKbContract(SourceRecordSchema, sourceRecord, "source")).not.toThrow();
  });

  it("rejects an object_ref that does not match the sha256", () => {
    const bad = { ...sourceRecord, object_ref: "sources/objects/abc" };
    expect(() => validateKbContract(SourceRecordSchema, bad, "source")).toThrow();
  });

  it("rejects an empty authors array", () => {
    const bad = { ...sourceRecord, authors: [] };
    expect(() => validateKbContract(SourceRecordSchema, bad, "source")).toThrow();
  });
});

describe("KB §5.5 page revision frontmatter", () => {
  it("validates a correct frontmatter", () => {
    const fm = {
      schema_version: 1,
      page_id: "page_01",
      revision_id: "rev_01",
      kind: "synthesis",
      title: "Test page",
      summary: "A test",
      authority: "advisory",
      lifecycle: "draft",
      created_at: NOW,
      derived_from: [],
      related_page_ids: [],
    };
    expect(() =>
      validateKbContract(PageRevisionFrontmatterSchema, fm, "frontmatter")
    ).not.toThrow();
  });

  it("rejects an unknown page kind", () => {
    const fm = {
      schema_version: 1,
      page_id: "page_01",
      revision_id: "rev_01",
      kind: "random",
      title: "Test",
      summary: "A test",
      authority: "advisory",
      lifecycle: "draft",
      created_at: NOW,
      derived_from: [],
      related_page_ids: [],
    };
    expect(() => validateKbContract(PageRevisionFrontmatterSchema, fm, "frontmatter")).toThrow();
  });
});

describe("KB §5.5 claims sidecar", () => {
  it("validates a correct sidecar", () => {
    const sidecar = {
      schema_version: 1,
      page_id: "page_01",
      revision_id: "rev_01",
      claims: [
        {
          claim_id: "clm_01",
          text: "The sky is blue",
          kind: "fact",
          state: "supported",
          confidence: "CERTAIN",
          evidence: [{ source_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
          contradicts_claim_ids: [],
          canonical_verification_refs: [],
        },
      ],
    };
    expect(() => validateKbContract(ClaimsSidecarSchema, sidecar, "claims")).not.toThrow();
  });
});

describe("KB §5.5 conflict record", () => {
  it("validates a correct conflict", () => {
    const conflict = {
      schema_version: 1,
      conflict_record_id: "cfl_01",
      claim_refs: [{ page_id: "p", revision_id: "r", claim_id: "c" }],
      state: "open",
      summary: "Sources disagree",
      evidence_refs: [],
      created_at: NOW,
    };
    expect(() => validateKbContract(ConflictRecordSchema, conflict, "conflict")).not.toThrow();
  });
});

describe("KB §5.5 generation catalog + current selector", () => {
  it("validates a correct catalog", () => {
    const catalog = {
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
    expect(() => validateKbContract(GenerationCatalogSchema, catalog, "catalog")).not.toThrow();
  });

  it("validates a correct current selector", () => {
    const current = {
      schema_version: 1,
      kb_id: "kb_001",
      generation_id: "gen_01",
      catalog_sha256: ZERO,
      index_sha256: ZERO,
      published_at: NOW,
    };
    expect(() => validateKbContract(CurrentGenerationSchema, current, "current")).not.toThrow();
  });
});

describe("KB canonical JSON + digest", () => {
  it("produces sorted, whitespace-free JSON", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("produces a stable SHA-256", () => {
    const digest = sha256Hex(canonicalJson({ a: 1 }));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(canonicalJson({ a: 1 }))).toBe(digest);
    expect(sha256Hex(canonicalJson({ a: 2 }))).not.toBe(digest);
  });
});
