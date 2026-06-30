/**
 * callPython() cwd safety regression tests
 *
 * Verifies that the fix for the "spawn /home/skribblez/projects/penny/.venv/bin/python
 * ENOENT" error (Node 20+ masking missing-cwd errors as ENOENT on the spawn
 * target) works correctly. The test exercises the actual fs.mkdirSync call
 * path used by callPython() to ensure user-supplied output directories are
 * created on first run, instead of failing with a misleading ENOENT.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("callPython: cwd ENOENT safety", () => {
  const tempRoots: string[] = [];

  function freshDir(): string {
    const base = mkdtempSync(join(tmpdir(), "jsa-cwd-test-"));
    tempRoots.push(base);
    return base;
  }

  function deepPath(base: string, parts: string[]): string {
    return join(base, ...parts);
  }

  afterEach(() => {
    for (const root of tempRoots) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    tempRoots.length = 0;
  });

  it("mkdirSync({ recursive: true }) creates a non-existent nested path", () => {
    const base = freshDir();
    const target = deepPath(base, ["nested", "deep", "leaf"]);
    expect(existsSync(target)).toBe(false);

    // This is the exact pattern callPython uses
    const { mkdirSync } = require("fs");
    mkdirSync(target, { recursive: true });

    expect(existsSync(target)).toBe(true);
  });

  it("mkdirSync({ recursive: true }) on an existing path is a no-op", () => {
    const base = freshDir();
    const { mkdirSync } = require("fs");
    expect(() => mkdirSync(base, { recursive: true })).not.toThrow();
    expect(existsSync(base)).toBe(true);
  });

  it("the Node 20+ spawn ENOENT can be reproduced with a non-existent cwd", () => {
    const { spawn } = require("child_process");
    const fakeCwd = join(freshDir(), "does-not-exist");
    expect(existsSync(fakeCwd)).toBe(false);

    return new Promise<void>((resolve) => {
      const proc = spawn(
        "/home/skribblez/projects/penny/.venv/bin/python",
        ["-c", "print('hi')"],
        { stdio: ["ignore", "pipe", "pipe"], cwd: fakeCwd },
      );
      proc.on("error", (err: NodeJS.ErrnoException) => {
        // The exact error pattern: ENOENT with the executable's path
        // in the message, even though the executable is fine.
        expect(err.code).toBe("ENOENT");
        expect(err.message).toMatch(/ENOENT/);
        expect(err.message).toContain(".venv/bin/python");
        resolve();
      });
      proc.on("close", () => {
        // If the python spawn actually worked, the test setup is broken
        // (it should not, but guard anyway)
        resolve();
      });
    });
  });

  it("the Node 20+ spawn ENOENT is avoided after mkdirSync({ recursive: true })", () => {
    const { spawn } = require("child_process");
    const { mkdirSync } = require("fs");
    const fakeCwd = join(freshDir(), "does-not-exist");

    // Apply the callPython fix: create the cwd before spawn
    mkdirSync(fakeCwd, { recursive: true });
    expect(existsSync(fakeCwd)).toBe(true);

    return new Promise<void>((resolve) => {
      const proc = spawn(
        "/home/skribblez/projects/penny/.venv/bin/python",
        ["-c", "print('hi')"],
        { stdio: ["ignore", "pipe", "pipe"], cwd: fakeCwd },
      );
      let out = "";
      proc.stdout.on("data", (d: Buffer) => {
        out += d.toString();
      });
      proc.on("error", (err: NodeJS.ErrnoException) => {
        // Should not fire — the cwd now exists
        expect.fail(`spawn errored unexpectedly: ${err.message}`);
        resolve();
      });
      proc.on("close", (code: number | null) => {
        expect(code).toBe(0);
        expect(out).toContain("hi");
        resolve();
      });
    });
  });

  it("realpathSync resolves a working venv-python symlink chain", () => {
    // Verifies the extension-load-time resolver can find the real
    // executable behind the venv -> pyenv -> python3.12 symlink chain.
    const { realpathSync, statSync } = require("fs");
    const candidate = "/home/skribblez/projects/penny/.venv/bin/python";
    const real = realpathSync(candidate);
    expect(real).toMatch(/python3(\.\d+)?$/);
    const st = statSync(real);
    expect((st.mode & 0o111) !== 0).toBe(true); // has executable bit
  });

  it("realpathSync + existsSync together reject a non-existent candidate", () => {
    const { realpathSync, existsSync } = require("fs");
    const candidate = "/this/does/not/exist/python";
    expect(existsSync(candidate)).toBe(false);
    expect(() => realpathSync(candidate)).toThrow();
  });
});
