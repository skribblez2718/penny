/**
 * KB end-to-end tests (G8).
 *
 * Exercises the operational KB workflows — init, query, lint, status — against
 * a temporary KB root, proving the full pipeline works: manifest creation,
 * default-deny policy, first empty generation, deterministic retrieval, lint
 * floor, and safe status projection.
 *
 * The live E2E (with ollama/qwen3.8:latest) is run separately through the
 * knowledge_base tool; these are the deterministic tests that pin the behavior.
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex, type KbPolicy } from "../src/kb/contracts.js";
import { readPolicy, writePolicy } from "../src/kb/filesystem.js";
import { PolicyRefusal } from "../src/kb/policy.js";
import {
  admitKbRun,
  initKb,
  lintKb,
  queryKb,
  recheckAdmittedPolicy,
  statusKb,
  type KbWorkflowContext,
} from "../src/kb/workflows.js";
import { closeKbArtifactControls, kbArtifactControl } from "./fixtures/kb-artifact-control.js";

const dirs: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(path.join(tmpdir(), "penny-kb-e2e-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  closeKbArtifactControls();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ctx(root: string, runId = `kb-e2e-${Date.now()}`): KbWorkflowContext {
  return {
    kbRoot: root,
    profileId: "kbp_test",
    runId,
    checkpointer: kbArtifactControl({ root, runId, profileId: "kbp_test" }),
  };
}

describe("validated policy digest boundary", () => {
  const parentIdentity = { provider: "ollama", model: "qwen327b:latest" };

  it("hashes the validated policy bytes and preserves policy-change refusal", () => {
    const root = tmpRoot();
    initKb(ctx(root), "Policy Boundary KB");
    const initial = readPolicy(root);
    const admittedPolicy = {
      ...initial,
      allowed_parent_models: [{ ...parentIdentity, locality: "local" }],
    } satisfies KbPolicy;
    writePolicy(root, admittedPolicy);

    const admission = admitKbRun({ kbRoot: root, parentIdentity });
    expect(admission.policy).toEqual(admittedPolicy);
    expect(admission.policy_sha256).toBe(sha256Hex(canonicalJson(admittedPolicy)));
    expect(
      recheckAdmittedPolicy({
        kbRoot: root,
        admittedPolicySha256: admission.policy_sha256,
      })
    ).toEqual(admittedPolicy);

    writePolicy(root, {
      ...admittedPolicy,
      reader_limits: {
        ...admittedPolicy.reader_limits,
        max_calls_per_phase: admittedPolicy.reader_limits.max_calls_per_phase + 1,
      },
    });
    let caught: unknown;
    try {
      recheckAdmittedPolicy({
        kbRoot: root,
        admittedPolicySha256: admission.policy_sha256,
      });
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof PolicyRefusal)) {
      throw new Error("changed policy did not raise PolicyRefusal");
    }
    expect(caught.code).toBe("policy_changed");
    expect(caught.message).toBe(
      "the KB policy changed mid-run; this run is invalid and a new run is required"
    );
  });

  it("rejects an extra policy property at the filesystem boundary", () => {
    const root = tmpRoot();
    initKb(ctx(root), "Policy Extra Property KB");
    const policy = readPolicy(root);
    writeFileSync(
      path.join(root, ".kb", "policy.json"),
      canonicalJson({ ...policy, unexpected_policy_field: true }),
      { mode: 0o600 }
    );

    expect(() => admitKbRun({ kbRoot: root, parentIdentity })).toThrow(
      "policy failed schema validation"
    );
  });
});

describe("KB E2E: init → query → lint → status", () => {
  it("init creates a KB with manifest, policy, and first generation", () => {
    const root = tmpRoot();
    const result = initKb(ctx(root), "Test KB");

    expect(result.status).toBe("complete");
    expect(result.met).toBe(true);
    expect(result.kb_id).toBeDefined();
    expect(result.counts.generations).toBe(1);

    // Manifest exists with mode 0600
    const manifestPath = path.join(root, "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);

    // Policy exists with mode 0600
    const policyPath = path.join(root, ".kb", "policy.json");
    expect(existsSync(policyPath)).toBe(true);
    expect(statSync(policyPath).mode & 0o777).toBe(0o600);

    // Current selector exists
    const currentPath = path.join(root, ".kb", "current.json");
    expect(existsSync(currentPath)).toBe(true);

    // Root index was rebuilt
    expect(existsSync(path.join(root, "index.md"))).toBe(true);
  });

  it("init preserves a non-writable public mode on an already-admitted root", () => {
    const root = tmpRoot();
    chmodSync(root, 0o755);

    expect(initKb(ctx(root), "Public scaffold KB").status).toBe("complete");
    expect(statSync(root).mode & 0o777).toBe(0o755);
  });

  it("init is idempotent — second call validates existing state", () => {
    const root = tmpRoot();
    const c = ctx(root);

    const first = initKb(c, "Test KB");
    expect(first.status).toBe("complete");
    const kbId = first.kb_id;

    const second = initKb(c, "Test KB");
    expect(second.status).toBe("complete");
    expect(second.kb_id).toBe(kbId);
    expect(second.warnings).toContain("KB already initialized; validated existing state");
  });

  it("query on an empty KB returns met:false with no candidates", () => {
    const root = tmpRoot();
    initKb(ctx(root), "Test KB");

    const result = queryKb(ctx(root, "kb-query-1"), "anything");
    expect(result.status).toBe("complete");
    expect(result.met).toBe(false);
    expect(result.counts.candidates).toBe(0);
    expect(result.warnings).toContain("No supported matching claims found");
    // An answer artifact was still produced (work plane only, no publication)
    expect(result.artifacts.length).toBe(1);
    const answerArtifact = result.artifacts[0];
    if (answerArtifact === undefined) throw new Error("query produced no answer artifact");
    expect(answerArtifact.artifact_kind).toBe("query_answer");
  });

  it("query on an uninitialized KB is refused", () => {
    const root = tmpRoot();
    const result = queryKb(ctx(root), "anything");
    expect(result.status).toBe("refused");
    expect(result.met).toBe(false);
    expect(result.warnings).toContain("No KB is initialized at this profile");
  });

  it("lint on a well-formed KB passes with zero blocking findings", () => {
    const root = tmpRoot();
    initKb(ctx(root), "Test KB");

    const result = lintKb(ctx(root, "kb-lint-1"));
    expect(result.status).toBe("complete");
    expect(result.met).toBe(true);
    expect(result.counts.blocking).toBe(0);
    // A lint-report artifact was produced
    expect(result.artifacts.length).toBe(1);
    const lintArtifact = result.artifacts[0];
    if (lintArtifact === undefined) throw new Error("lint produced no report artifact");
    expect(lintArtifact.artifact_kind).toBe("lint_report");
  });

  it("lint on an uninitialized KB reports blocking findings", () => {
    const root = tmpRoot();
    const result = lintKb(ctx(root, "kb-lint-1"));
    expect(result.status).toBe("refused");
    expect(result.counts.blocking).toBeGreaterThan(0);
  });

  it("status returns a safe projection with counts but no paths", () => {
    const root = tmpRoot();
    initKb(ctx(root), "Test KB");

    const result = statusKb(ctx(root, "kb-status-1"));
    expect(result.status).toBe("complete");
    expect(result.met).toBe(true);
    expect(result.kb_id).toBeDefined();
    expect(result.counts.pages).toBe(0);
    expect(result.counts.sources).toBe(0);
    // No paths in the result
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain("/tmp/");
  });

  it("status on an uninitialized KB returns met:false", () => {
    const root = tmpRoot();
    const result = statusKb(ctx(root, "kb-status-1"));
    expect(result.status).toBe("complete");
    expect(result.met).toBe(false);
  });
});

describe("KB E2E: publication plane is unchanged by query and lint", () => {
  it("query does not create any publication-plane files", () => {
    const root = tmpRoot();
    initKb(ctx(root), "Test KB");

    // Snapshot the publication plane before
    const before = snapshotPublicationPlane(root);

    queryKb(ctx(root, "kb-query-1"), "test query");

    // Snapshot after — must be identical
    const after = snapshotPublicationPlane(root);
    expect(after).toEqual(before);
  });

  it("lint does not create any publication-plane files", () => {
    const root = tmpRoot();
    initKb(ctx(root), "Test KB");

    const before = snapshotPublicationPlane(root);

    lintKb(ctx(root, "kb-lint-1"));

    const after = snapshotPublicationPlane(root);
    expect(after).toEqual(before);
  });
});

/**
 * Snapshot the publication plane: sources/objects, sources/records, pages,
 * conflicts, .kb/generations, .kb/current.json, index.md.
 *
 * This is the §5.6 no-write oracle: query and lint must not change any of these.
 */
function snapshotPublicationPlane(root: string): string {
  const paths: string[] = [];
  const planeDirs = ["sources/objects", "sources/records", "pages", "conflicts", ".kb/generations"];
  const planeFiles = [".kb/current.json", "index.md", "manifest.json", ".kb/policy.json"];

  for (const dir of planeDirs) {
    const full = path.join(root, dir);
    if (existsSync(full)) {
      walk(full, root, paths);
    }
  }
  for (const file of planeFiles) {
    const full = path.join(root, file);
    if (existsSync(full)) {
      paths.push(file);
    }
  }

  paths.sort();
  return paths
    .map((p) => {
      const full = path.join(root, p);
      const stat = statSync(full);
      if (stat.isFile()) {
        const content = readFileSync(full, "utf8");
        return `${p}:${content.length}`;
      }
      return `${p}:dir`;
    })
    .join("|");
}

function walk(dir: string, root: string, paths: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(root, full);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      paths.push(rel);
      walk(full, root, paths);
    } else {
      paths.push(rel);
    }
  }
}
