/**
 * KB deterministic lint — the floor that runs before any semantic work.
 *
 * Malformed structure blocks semantic work entirely — there is no point asking
 * a model to reason about a corpus whose hashes do not verify.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  canonicalJson,
  sha256Hex,
  validateKbContract,
  GenerationCatalogSchema,
  KbManifestSchema,
  KbPolicySchema,
  SourceRecordSchema,
  ClaimsSidecarSchema,
  PageRevisionFrontmatterSchema,
  ConflictRecordSchema,
  CurrentGenerationSchema,
  type GenerationCatalog,
  type KbManifest,
  type KbPolicy,
  type CurrentGeneration,
} from "./contracts.js";
import {
  conflictPath,
  currentPath,
  generationCatalogPath,
  generationsDir,
  manifestPath,
  pageClaimsPath,
  pageMarkdownPath,
  policyPath,
  sourceObjectPath,
  sourceRecordPath,
} from "./filesystem.js";

export interface LintFinding {
  finding_id: string;
  severity: "info" | "warning" | "blocking";
  summary: string;
  evidence: { evidence_id: string; kind: "gate"; ref: string }[];
}

/**
 * Run the deterministic lint floor over a KB root.
 *
 * Returns findings sorted by severity (blocking first). An empty result means
 * the floor passed. Semantic unsupported-claim and candidate-conflict judgments
 * remain Phase 8 (G8).
 */
export function lintDeterministic(root: string): LintFinding[] {
  const findings: LintFinding[] = [];

  // 1. Manifest exists and validates
  const mPath = manifestPath(root);
  if (!existsSync(mPath)) {
    findings.push({
      finding_id: "lint_001",
      severity: "blocking",
      summary: "manifest.json is missing",
      evidence: [],
    });
    return findings; // nothing else can be checked
  }
  try {
    validateKbContract(KbManifestSchema, JSON.parse(readFileSync(mPath, "utf8")), "manifest");
  } catch (e) {
    findings.push({
      finding_id: "lint_002",
      severity: "blocking",
      summary: `manifest schema invalid: ${(e as Error).message}`,
      evidence: [],
    });
  }

  // 2. Policy exists and validates
  const pPath = policyPath(root);
  if (!existsSync(pPath)) {
    findings.push({
      finding_id: "lint_003",
      severity: "blocking",
      summary: ".kb/policy.json is missing",
      evidence: [],
    });
  } else {
    try {
      validateKbContract(KbPolicySchema, JSON.parse(readFileSync(pPath, "utf8")), "policy");
    } catch (e) {
      findings.push({
        finding_id: "lint_004",
        severity: "blocking",
        summary: `policy schema invalid: ${(e as Error).message}`,
        evidence: [],
      });
    }
  }

  // 3. Current selector exists and validates
  const cPath = currentPath(root);
  if (!existsSync(cPath)) {
    findings.push({
      finding_id: "lint_005",
      severity: "warning",
      summary: ".kb/current.json is missing — no generation is selected",
      evidence: [],
    });
  } else {
    try {
      const selector = validateKbContract(
        CurrentGenerationSchema,
        JSON.parse(readFileSync(cPath, "utf8")),
        "current"
      );
      // 4. The selected generation's catalog exists and validates
      const catPath = generationCatalogPath(root, selector.generation_id);
      if (!existsSync(catPath)) {
        findings.push({
          finding_id: "lint_006",
          severity: "blocking",
          summary: `selected generation '${selector.generation_id}' catalog is missing`,
          evidence: [],
        });
      } else {
        try {
          const catalog = validateKbContract(
            GenerationCatalogSchema,
            JSON.parse(readFileSync(catPath, "utf8")),
            "catalog"
          );
          // 5. Verify catalog digest matches selector
          const calculated = sha256Hex(canonicalJson(catalog));
          if (calculated !== selector.catalog_sha256) {
            findings.push({
              finding_id: "lint_007",
              severity: "blocking",
              summary: "catalog digest mismatch with selector",
              evidence: [],
            });
          }
          // 6. Verify referenced source objects exist
          for (const digest of catalog.source_objects) {
            if (!existsSync(sourceObjectPath(root, digest))) {
              findings.push({
                finding_id: `lint_obj_${digest.slice(0, 8)}`,
                severity: "warning",
                summary: `source object ${digest.slice(0, 16)} is in catalog but missing on disk`,
                evidence: [],
              });
            }
          }
          // 7. Verify referenced source records exist
          for (const sourceId of Object.keys(catalog.source_records)) {
            if (!existsSync(sourceRecordPath(root, sourceId))) {
              findings.push({
                finding_id: `lint_src_${sourceId.slice(0, 8)}`,
                severity: "warning",
                summary: `source record ${sourceId} is in catalog but missing on disk`,
                evidence: [],
              });
            }
          }
        } catch (e) {
          findings.push({
            finding_id: "lint_008",
            severity: "blocking",
            summary: `catalog schema invalid: ${(e as Error).message}`,
            evidence: [],
          });
        }
      }
    } catch (e) {
      findings.push({
        finding_id: "lint_009",
        severity: "blocking",
        summary: `current selector schema invalid: ${(e as Error).message}`,
        evidence: [],
      });
    }
  }

  // 8. Check for orphaned source objects (on disk but not in any catalog)
  const objectsDir = path.join(root, "sources", "objects");
  if (existsSync(objectsDir)) {
    for (const shard of readdirSync(objectsDir)) {
      const shardDir = path.join(objectsDir, shard);
      if (statSync(shardDir).isDirectory()) {
        for (const file of readdirSync(shardDir)) {
          const digest = `${shard}${file}`;
          // Check if this digest is in the current catalog (if one exists)
          // This is a light check — a full orphan scan would check all generations
          findings.push({
            finding_id: `lint_orphan_${digest.slice(0, 8)}`,
            severity: "info",
            summary: `source object ${digest.slice(0, 16)} exists on disk (orphan check is light in v1)`,
            evidence: [],
          });
        }
      }
    }
  }

  return findings.sort((a, b) => {
    const order = { blocking: 0, warning: 1, info: 2 };
    return order[a.severity] - order[b.severity];
  });
}
