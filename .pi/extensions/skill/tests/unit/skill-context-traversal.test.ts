/**
 * Skill Extension resolveSkillContextPath — path-traversal containment tests
 *
 * Regression guard for the BLOCKING path-traversal vulnerability Carren found:
 * `resolveSkillContextPath` did `path.join(skillPath, explicitContext.trim())`
 * with NO containment check, then trusted `existsSync`. Carren proved that
 *   explicitContext = "../".repeat(9) + "etc/passwd"
 * normalizes to `/etc/passwd`, which existsSync confirms, so the function
 * returned that out-of-bounds path — later readFileSync'd and fed into an
 * agent's prompt as real file content.
 *
 * These tests exercise the exported `resolveSkillContextPath` directly against
 * a REAL temp skill directory (no fs mocking) so the containment logic is
 * proven end-to-end against the real filesystem — including the fact that
 * `/etc/passwd` really does exist on disk.
 *
 * Containment boundary decision (documented):
 *   An explicit context is trusted ONLY if its fully-resolved path is the skill
 *   root itself OR lives strictly beneath it:
 *     resolved === root  ||  resolved.startsWith(root + path.sep)
 *   `path.join`/`path.resolve` already normalize embedded `..`, so a relative
 *   path like `assets/prompts/../prompts/foo.md` (which normalizes to a path
 *   still inside the root) is ACCEPTED, while `../../etc/passwd` (which escapes)
 *   is REJECTED and degrades gracefully to the legacy bare `{agent}.md` guess —
 *   the exact same graceful-degradation discipline already used for a
 *   missing/empty/whitespace explicit context.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

// index.ts pulls in these external packages at module load; the traversal test
// only needs the exported pure function, so stub them (mirrors the sibling
// preference test). fs is deliberately NOT mocked — we use real files.
vi.mock("@mariozechner/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn((_p: string, fn: () => any) => fn()),
  parseFrontmatter: (content: string) => ({ frontmatter: {}, body: content }),
}));
vi.mock("@mariozechner/pi-tui", () => ({
  Container: class {
    addChild() {}
  },
  Markdown: class {},
  Text: class {},
  Spacer: class {},
}));

let resolveSkillContextPath: (
  skillPath: string,
  agent: string,
  explicitContext: string | undefined
) => string | undefined;

let skillRoot: string;
let barePath: string;
let explicitPath: string;
let nestedPath: string;

beforeAll(async () => {
  const mod = await import("../../index.js");
  resolveSkillContextPath = mod.resolveSkillContextPath;

  skillRoot = mkdtempSync(path.join(tmpdir(), "skill-traversal-"));
  const promptsDir = path.join(skillRoot, "assets", "prompts");
  const subDir = path.join(promptsDir, "subdir");
  fs.mkdirSync(subDir, { recursive: true });

  barePath = path.join(promptsDir, "echo.md");
  explicitPath = path.join(promptsDir, "echo-threat-model.md");
  nestedPath = path.join(subDir, "foo.md");
  fs.writeFileSync(barePath, "BARE");
  fs.writeFileSync(explicitPath, "EXPLICIT");
  fs.writeFileSync(nestedPath, "NESTED");
});

afterAll(() => {
  if (skillRoot) rmSync(skillRoot, { recursive: true, force: true });
});

describe("resolveSkillContextPath path-traversal containment", () => {
  it("REJECTS Carren's exact traversal string and degrades to the bare guess", () => {
    // Sanity: the escape target genuinely resolves to a real, existing file.
    const escaped = path.resolve(skillRoot, "../".repeat(9) + "etc/passwd");
    expect(escaped).toBe("/etc/passwd");
    expect(fs.existsSync(escaped)).toBe(true);

    const result = resolveSkillContextPath(skillRoot, "echo", "../".repeat(9) + "etc/passwd");

    // MUST NOT return the out-of-bounds path.
    expect(result).not.toBe("/etc/passwd");
    expect(result).not.toContain("etc/passwd");
    // Falls through to the legacy bare {agent}.md guess (which exists here).
    expect(result).toBe(barePath);
    // Whatever it returns must be within the skill root.
    expect(result && (result === skillRoot || result.startsWith(skillRoot + path.sep))).toBe(true);
  });

  it("REJECTS traversal and returns undefined when no bare guess exists either", () => {
    // agent "ghost" has no assets/prompts/ghost.md, so after rejecting the
    // out-of-bounds explicit path there is nothing valid to fall back to.
    const result = resolveSkillContextPath(skillRoot, "ghost", "../".repeat(9) + "etc/passwd");
    expect(result).toBeUndefined();
  });

  it("ACCEPTS a legitimate explicit context inside the skill root", () => {
    const result = resolveSkillContextPath(
      skillRoot,
      "echo",
      "assets/prompts/echo-threat-model.md"
    );
    expect(result).toBe(explicitPath);
  });

  it("ACCEPTS a legitimate nested subdirectory path inside the skill root", () => {
    const result = resolveSkillContextPath(skillRoot, "echo", "assets/prompts/subdir/foo.md");
    expect(result).toBe(nestedPath);
  });

  it("ACCEPTS a relative path with embedded `..` that normalizes back inside bounds", () => {
    // assets/prompts/../prompts/echo-threat-model.md → still inside skill root.
    const result = resolveSkillContextPath(
      skillRoot,
      "echo",
      "assets/prompts/../prompts/echo-threat-model.md"
    );
    expect(result).toBe(explicitPath);
  });
});
