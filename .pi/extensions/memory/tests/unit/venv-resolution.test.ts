/**
 * F3 — memory bridge interpreter resolution.
 *
 * The bridge caches the venv python ONCE at startup and spawns it for every
 * call; a stale/misconfigured PI_VENV_PYTHON used to fail with an opaque
 * per-call ENOENT. resolveVenvPython now VALIDATES the interpreter and falls
 * back through PROJECT_ROOT/.venv → cwd/.venv, never throwing.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { resolveVenvPython } from "../../index.js";

const ORIG_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIG_ENV };
});

function makeFakeVenv(root: string): string {
  const bin = join(root, ".venv", "bin");
  mkdirSync(bin, { recursive: true });
  const py = join(bin, "python");
  writeFileSync(py, "#!/bin/sh\nexit 0\n");
  chmodSync(py, 0o755);
  return py;
}

describe("resolveVenvPython (F3)", () => {
  it("honors a valid PI_VENV_PYTHON that exists and is executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "memvenv-"));
    const py = makeFakeVenv(dir);
    process.env.PI_VENV_PYTHON = py;
    expect(resolveVenvPython()).toBe(py);
  });

  it("falls back to PROJECT_ROOT/.venv when PI_VENV_PYTHON is bogus", () => {
    const proj = mkdtempSync(join(tmpdir(), "memproj-"));
    const py = makeFakeVenv(proj);
    process.env.PI_VENV_PYTHON = "/nonexistent/does/not/exist/python";
    process.env.PROJECT_ROOT = proj;
    expect(resolveVenvPython()).toBe(py);
  });

  it("never throws when nothing resolves; returns a concrete fallback path", () => {
    process.env.PI_VENV_PYTHON = "/nope/python";
    process.env.PROJECT_ROOT = "/also/definitely/nope";
    const r = resolveVenvPython();
    expect(typeof r).toBe("string");
    expect(r.length).toBeGreaterThan(0);
  });
});
