/**
 * KB deterministic lint — the floor that runs before any semantic work.
 *
 * Malformed structure blocks semantic work entirely. Every authoritative or
 * content read is descriptor-pinned through the shared core reader.
 */

import { readdirSync } from "node:fs";
import path from "node:path";

import type { GenerationCatalog, KbManifest } from "./contracts.js";
import {
  readConflictRecord,
  readCurrent,
  readGenerationCatalog,
  readManifest,
  readPageRevision,
  readPolicy,
  readSourceObject,
  readSourceRecord,
} from "./filesystem.js";
import { KbCoreReadError, withContainedKbDirectory } from "./core-read.js";
import { verifyGenerationIndex } from "./generations.js";

export interface LintFinding {
  finding_id: string;
  severity: "info" | "warning" | "blocking";
  summary: string;
  evidence: { evidence_id: string; kind: "gate"; ref: string }[];
}

function finding(
  findingId: string,
  severity: LintFinding["severity"],
  summary: string
): LintFinding {
  return { finding_id: findingId, severity, summary, evidence: [] };
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "validation failed";
}

function lintSelectedClosure(
  root: string,
  manifest: KbManifest,
  catalog: GenerationCatalog,
  findings: LintFinding[]
): void {
  try {
    const exactManifest = readManifest(root, catalog.manifest_sha256);
    if (exactManifest.kb_id !== catalog.kb_id || manifest.kb_id !== catalog.kb_id) {
      findings.push(
        finding("lint_010", "blocking", "manifest and selected catalog KB identity differ")
      );
    }
  } catch (error) {
    findings.push(
      finding("lint_011", "blocking", `manifest digest/custody invalid: ${safeMessage(error)}`)
    );
  }

  for (const [pageId, entry] of Object.entries(catalog.pages)) {
    try {
      readPageRevision(root, pageId, entry.revision_id, {
        pageSha256: entry.page_sha256,
        claimsSha256: entry.claims_sha256,
      });
    } catch (error) {
      findings.push(
        finding(
          `lint_page_${pageId.slice(0, 24)}`,
          "blocking",
          `selected page revision failed custody/schema/digest validation: ${safeMessage(error)}`
        )
      );
    }
  }

  for (const digest of catalog.source_objects) {
    try {
      readSourceObject(root, digest);
    } catch (error) {
      findings.push(
        finding(
          `lint_obj_${digest.slice(0, 8)}`,
          "blocking",
          `selected source object failed custody/digest validation: ${safeMessage(error)}`
        )
      );
    }
  }

  for (const [sourceId, recordDigest] of Object.entries(catalog.source_records)) {
    try {
      const record = readSourceRecord(root, sourceId, recordDigest);
      if (!catalog.source_objects.includes(record.sha256)) {
        findings.push(
          finding(
            `lint_src_ref_${sourceId.slice(0, 16)}`,
            "blocking",
            "selected source record object_ref is outside the selected object set"
          )
        );
      }
    } catch (error) {
      findings.push(
        finding(
          `lint_src_${sourceId.slice(0, 16)}`,
          "blocking",
          `selected source record/object_ref failed custody/schema/digest validation: ${safeMessage(error)}`
        )
      );
    }
  }

  for (const [conflictId, conflictDigest] of Object.entries(catalog.conflict_records)) {
    try {
      readConflictRecord(root, conflictId, conflictDigest);
    } catch (error) {
      findings.push(
        finding(
          `lint_conflict_${conflictId.slice(0, 16)}`,
          "blocking",
          `selected conflict failed custody/schema/digest validation: ${safeMessage(error)}`
        )
      );
    }
  }
}

function lintOrphanObjects(
  root: string,
  catalog: GenerationCatalog,
  findings: LintFinding[]
): void {
  const objectsDirectory = path.join(root, "sources", "objects");
  const selectedObjects = new Set<string>(catalog.source_objects);
  try {
    withContainedKbDirectory(
      root,
      objectsDirectory,
      "source objects directory",
      ({ pinnedPath }) => {
        for (const entry of readdirSync(pinnedPath, { withFileTypes: true })) {
          if (!entry.isFile() || !/^[0-9a-f]{64}$/u.test(entry.name)) {
            findings.push(
              finding(
                `lint_object_entry_${entry.name.slice(0, 16)}`,
                "blocking",
                "source objects directory contains a non-canonical or non-regular entry"
              )
            );
            continue;
          }
          if (!selectedObjects.has(entry.name)) {
            findings.push(
              finding(
                `lint_orphan_${entry.name.slice(0, 8)}`,
                "info",
                `source object ${entry.name.slice(0, 16)} is not selected by the current catalog`
              )
            );
          }
        }
      }
    );
  } catch (error) {
    if (error instanceof KbCoreReadError && error.code === "missing") {
      if (catalog.source_objects.length === 0) return;
    }
    findings.push(
      finding(
        "lint_objects_directory",
        "blocking",
        `source objects directory custody invalid: ${safeMessage(error)}`
      )
    );
  }
}

/** Run the deterministic lint floor over one selected immutable generation. */
export function lintDeterministic(root: string): LintFinding[] {
  const findings: LintFinding[] = [];
  let manifest: KbManifest;
  try {
    manifest = readManifest(root);
  } catch (error) {
    findings.push(
      finding("lint_001", "blocking", `manifest missing or invalid: ${safeMessage(error)}`)
    );
    return findings;
  }

  try {
    const policy = readPolicy(root);
    if (policy.kb_id !== manifest.kb_id) {
      findings.push(finding("lint_004", "blocking", "policy and manifest KB identity differ"));
    }
  } catch (error) {
    findings.push(
      finding("lint_003", "blocking", `policy missing or invalid: ${safeMessage(error)}`)
    );
  }

  let selector;
  try {
    selector = readCurrent(root);
  } catch (error) {
    findings.push(
      finding("lint_009", "blocking", `current selector invalid: ${safeMessage(error)}`)
    );
    selector = undefined;
  }
  if (selector === undefined) {
    findings.push(
      finding("lint_005", "warning", ".kb/current.json is missing — no generation is selected")
    );
    return findings.sort(compareFindings);
  }

  let catalog: GenerationCatalog;
  try {
    catalog = readGenerationCatalog(root, selector.generation_id, selector.catalog_sha256);
  } catch (error) {
    findings.push(
      finding("lint_006", "blocking", `selected generation catalog invalid: ${safeMessage(error)}`)
    );
    return findings.sort(compareFindings);
  }

  if (
    selector.kb_id !== manifest.kb_id ||
    catalog.kb_id !== selector.kb_id ||
    catalog.index_sha256 !== selector.index_sha256
  ) {
    findings.push(
      finding("lint_007", "blocking", "selector, manifest, catalog, or index identity differs")
    );
  }

  try {
    verifyGenerationIndex(root, selector.generation_id, selector.index_sha256, selector.kb_id);
  } catch (error) {
    findings.push(
      finding("lint_008", "blocking", `selected generation index invalid: ${safeMessage(error)}`)
    );
  }

  lintSelectedClosure(root, manifest, catalog, findings);
  lintOrphanObjects(root, catalog, findings);
  return findings.sort(compareFindings);
}

function compareFindings(left: LintFinding, right: LintFinding): number {
  const order = { blocking: 0, warning: 1, info: 2 } as const;
  return (
    order[left.severity] - order[right.severity] || left.finding_id.localeCompare(right.finding_id)
  );
}
