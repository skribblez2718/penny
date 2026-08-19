/**
 * KB generations — §5.10 immutable generation publication and crash recovery.
 *
 * A generation is a complete, immutable snapshot. Publication has exactly one
 * commit point: the atomic replacement of `.kb/current.json`. Everything before
 * it is staging that can be discarded; everything after it is finalization.
 *
 * This module implements:
 * - Building and validating a candidate generation catalog
 * - The atomic selector replacement (the single commit point)
 * - Reading the selected generation
 * - Root index rebuild (convenience, never authority)
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  openSync,
} from "node:fs";
import path from "node:path";

import {
  canonicalJson,
  sha256Hex,
  validateKbContract,
  CurrentGenerationSchema,
  GenerationCatalogSchema,
  type CurrentGeneration,
  type GenerationCatalog,
  type KbManifest,
  type KbPolicy,
  type Sha256Hex,
} from "./contracts.js";
import {
  conflictPath,
  currentPath,
  generationsDir,
  generationCatalogPath,
  lockPath,
  manifestPath,
  pageClaimsPath,
  pageMarkdownPath,
  readCurrent,
  readManifest,
  readPolicy,
  rootIndexPath,
  secureWrite,
  sourceObjectPath,
  sourceRecordPath,
  writeCurrent,
  writeRootIndex,
} from "./filesystem.js";

export class GenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationError";
  }
}

/** Generate a new opaque generation ID. */
export function newGenerationId(): string {
  return `gen_${randomUUID().replace(/-/g, "")}`;
}

/**
 * Build a generation catalog from the current KB state.
 *
 * The catalog records the digest of every selected source record, source object,
 * page revision pair, and conflict record, plus the manifest and policy digests.
 */
export function buildCatalog(input: {
  generation_id: string;
  kb_id: string;
  parent_generation_id?: string;
  manifest: KbManifest;
  policy: KbPolicy;
  pages: ReadonlyArray<{
    page_id: string;
    revision_id: string;
    page_sha256: Sha256Hex;
    claims_sha256: Sha256Hex;
  }>;
  source_records: ReadonlyArray<{ source_id: string; record_sha256: Sha256Hex }>;
  source_objects: readonly Sha256Hex[];
  conflicts: ReadonlyArray<{ conflict_id: string; conflict_sha256: Sha256Hex }>;
  index_sha256: Sha256Hex;
}): GenerationCatalog {
  const manifestDigest = sha256Hex(canonicalJson(input.manifest));
  const policyDigest = sha256Hex(canonicalJson(input.policy));

  const pages: Record<
    string,
    { revision_id: string; page_sha256: Sha256Hex; claims_sha256: Sha256Hex }
  > = {};
  for (const p of input.pages) {
    pages[p.page_id] = {
      revision_id: p.revision_id,
      page_sha256: p.page_sha256,
      claims_sha256: p.claims_sha256,
    };
  }

  const sourceRecordsMap: Record<string, Sha256Hex> = {};
  for (const s of input.source_records) {
    sourceRecordsMap[s.source_id] = s.record_sha256;
  }

  const conflictRecordsMap: Record<string, Sha256Hex> = {};
  for (const c of input.conflicts) {
    conflictRecordsMap[c.conflict_id] = c.conflict_sha256;
  }

  const catalog: GenerationCatalog = {
    schema_version: 1,
    generation_id: input.generation_id,
    kb_id: input.kb_id,
    manifest_sha256: manifestDigest,
    policy_sha256: policyDigest,
    pages,
    source_records: sourceRecordsMap,
    source_objects: [...input.source_objects],
    conflict_records: conflictRecordsMap,
    index_sha256: input.index_sha256,
    created_at: new Date().toISOString(),
    ...(input.parent_generation_id ? { parent_generation_id: input.parent_generation_id } : {}),
  };

  return validateKbContract(GenerationCatalogSchema, catalog, "generation catalog");
}

/**
 * Publish a generation atomically.
 *
 * The commit point is the atomic replacement of `.kb/current.json`. Before that,
 * the catalog is staged in the generations directory. After it, the generation is
 * authoritative and the old generation becomes unreachable (but is never deleted).
 *
 * This function does NOT implement the full §5.10 8-step crash-recovery protocol
 * (that requires the control DB and publication transaction records from G8).
 * For G7, publication writes are staged/off — this function stages the catalog
 * and performs the atomic selector replacement, which is the minimum needed to
 * test the "readers use current.json" invariant.
 */
export function publishGeneration(root: string, catalog: GenerationCatalog): CurrentGeneration {
  // 1. Stage the catalog in the generations directory (immutable after publication)
  const catalogDir = generationsDir(root);
  if (!existsSync(catalogDir)) {
    mkdirSync(catalogDir, { recursive: true, mode: 0o700 });
    chmodSync(catalogDir, 0o700);
  }
  const genDir = path.join(catalogDir, catalog.generation_id);
  if (!existsSync(genDir)) {
    mkdirSync(genDir, { recursive: true, mode: 0o700 });
    chmodSync(genDir, 0o700);
  }
  const catalogP = generationCatalogPath(root, catalog.generation_id);
  if (!existsSync(catalogP)) {
    secureWrite(catalogP, canonicalJson(catalog));
  }

  // 2. Build the selector
  const catalogSha = sha256Hex(canonicalJson(catalog));
  const selector: CurrentGeneration = {
    schema_version: 1,
    kb_id: catalog.kb_id,
    generation_id: catalog.generation_id,
    catalog_sha256: catalogSha,
    index_sha256: catalog.index_sha256,
    published_at: new Date().toISOString(),
  };
  validateKbContract(CurrentGenerationSchema, selector, "current selector");

  // 3. Atomic replacement: write to temp, fsync, rename over current.json
  writeCurrent(root, selector);

  // 4. Rebuild root index as convenience (never authority)
  rebuildRootIndex(root, catalog);

  return selector;
}

/**
 * Read the currently selected generation's catalog.
 *
 * Readers start from one validated selector and use only that generation.
 * They never combine a directory scan with a different generation.
 */
export function readSelectedGeneration(root: string):
  | {
      selector: CurrentGeneration;
      catalog: GenerationCatalog;
    }
  | undefined {
  const selector = readCurrent(root);
  if (selector === undefined) return undefined;
  const catalogP = generationCatalogPath(root, selector.generation_id);
  if (!existsSync(catalogP)) {
    throw new GenerationError(
      `selector points to generation '${selector.generation_id}' but its catalog is missing`
    );
  }
  const raw = readFileSync(catalogP, "utf8");
  const catalog = validateKbContract(
    GenerationCatalogSchema,
    JSON.parse(raw),
    "generation catalog"
  );
  // Verify the catalog digest matches the selector
  const calculated = sha256Hex(canonicalJson(catalog));
  if (calculated !== selector.catalog_sha256) {
    throw new GenerationError(
      `catalog digest mismatch: selector says ${selector.catalog_sha256}, catalog is ${calculated}`
    );
  }
  return { selector, catalog };
}

/**
 * Rebuild the root `index.md` from the selected generation's catalog.
 *
 * This is convenience only — it may lag or be absent after a crash and is
 * rebuilt from the selected catalog. It is never authority.
 */
export function rebuildRootIndex(root: string, catalog: GenerationCatalog): void {
  const lines: string[] = [
    `# ${catalog.kb_id}`,
    "",
    `Generation: ${catalog.generation_id}`,
    `Published: ${new Date().toISOString()}`,
    "",
    "## Pages",
    "",
  ];
  for (const pageId of Object.keys(catalog.pages).sort()) {
    const entry = catalog.pages[pageId]!;
    lines.push(
      `- [${pageId}](pages/${pageId}/revisions/${entry.revision_id}/page.md): revision ${entry.revision_id}`
    );
  }
  lines.push("", "## Sources", "");
  for (const sourceId of Object.keys(catalog.source_records).sort()) {
    lines.push(`- ${sourceId}`);
  }
  if (Object.keys(catalog.conflict_records).length > 0) {
    lines.push("", "## Conflicts", "");
    for (const conflictId of Object.keys(catalog.conflict_records).sort()) {
      lines.push(`- ${conflictId}`);
    }
  }
  writeRootIndex(root, lines.join("\n") + "\n");
}
