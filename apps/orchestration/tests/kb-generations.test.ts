/**
 * KB generations tests (G7, §5.10).
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  defaultDenyPolicy,
  sha256Hex,
  type KbManifest,
  type KbPolicy,
  type Sha256Hex,
} from "../src/kb/contracts.js";
import {
  writeManifest,
  writePolicy,
  writeSourceObject,
  writeSourceRecord,
  writePageRevision,
  writeConflictRecord,
  type GenerationCatalog,
} from "../src/kb/filesystem.js";
import {
  buildCatalog,
  newGenerationId,
  publishGeneration,
  readSelectedGeneration,
  rebuildRootIndex,
  GenerationError,
} from "../src/kb/generations.js";

const dirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(path.join(tmpdir(), "penny-kb-gen-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = "2026-01-01T00:00:00Z";
const ZERO = "0".repeat(64);

function seedKb(root: string): { manifest: KbManifest; policy: KbPolicy } {
  const manifest: KbManifest = {
    schema_version: 1,
    kb_id: "kb_001",
    title: "Test",
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
  writeManifest(root, manifest);
  const policy = defaultDenyPolicy("kb_001");
  writePolicy(root, policy);
  return { manifest, policy };
}

describe("KB §5.10 generation publication", () => {
  it("publishes a generation and reads it back through the selector", () => {
    const root = tmpRoot();
    const { manifest, policy } = seedKb(root);
    const genId = newGenerationId();

    const catalog = buildCatalog({
      generation_id: genId,
      kb_id: "kb_001",
      manifest,
      policy,
      pages: [],
      source_records: [],
      source_objects: [],
      conflicts: [],
      index_sha256: ZERO,
    });

    const selector = publishGeneration(root, catalog);
    expect(selector.generation_id).toBe(genId);
    expect(selector.kb_id).toBe("kb_001");

    const selected = readSelectedGeneration(root);
    expect(selected).toBeDefined();
    expect(selected!.selector.generation_id).toBe(genId);
    expect(selected!.catalog.generation_id).toBe(genId);
  });

  it("returns undefined when no generation has been published", () => {
    const root = tmpRoot();
    expect(readSelectedGeneration(root)).toBeUndefined();
  });

  it("rebuilds the root index as convenience after publication", () => {
    const root = tmpRoot();
    const { manifest, policy } = seedKb(root);
    const catalog = buildCatalog({
      generation_id: newGenerationId(),
      kb_id: "kb_001",
      manifest,
      policy,
      pages: [],
      source_records: [],
      source_objects: [],
      conflicts: [],
      index_sha256: ZERO,
    });
    publishGeneration(root, catalog);
    const indexPath = path.join(root, "index.md");
    expect(statSync(indexPath).isFile()).toBe(true);
    const content = require("node:fs").readFileSync(indexPath, "utf8");
    expect(content).toContain("kb_001");
    expect(content).toContain("Generation:");
  });

  it("publishing a second generation atomically replaces the selector", () => {
    const root = tmpRoot();
    const { manifest, policy } = seedKb(root);

    const gen1 = buildCatalog({
      generation_id: newGenerationId(),
      kb_id: "kb_001",
      manifest,
      policy,
      pages: [],
      source_records: [],
      source_objects: [],
      conflicts: [],
      index_sha256: ZERO,
    });
    publishGeneration(root, gen1);

    const gen2 = buildCatalog({
      generation_id: newGenerationId(),
      kb_id: "kb_001",
      parent_generation_id: gen1.generation_id,
      manifest,
      policy,
      pages: [],
      source_records: [],
      source_objects: [],
      conflicts: [],
      index_sha256: ZERO,
    });
    publishGeneration(root, gen2);

    const selected = readSelectedGeneration(root);
    expect(selected!.selector.generation_id).toBe(gen2.generation_id);
    expect(selected!.catalog.parent_generation_id).toBe(gen1.generation_id);
  });

  it("the catalog digest in the selector matches the catalog", () => {
    const root = tmpRoot();
    const { manifest, policy } = seedKb(root);
    const catalog = buildCatalog({
      generation_id: newGenerationId(),
      kb_id: "kb_001",
      manifest,
      policy,
      pages: [],
      source_records: [],
      source_objects: [],
      conflicts: [],
      index_sha256: ZERO,
    });
    publishGeneration(root, catalog);
    const selected = readSelectedGeneration(root);
    expect(selected!.selector.catalog_sha256).toBe(sha256Hex(canonicalJson(catalog)));
  });
});
