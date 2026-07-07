/**
 * Unit tests for getPiInvocation()
 *
 * Validates that pi subprocess invocation is resolved correctly,
 * including the critical self-reference guard that prevents fork bombs
 * when agent-runner is loaded from a non-pi Node script.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";

// Mock external dependencies BEFORE importing agent-runner
vi.mock("@mariozechner/pi-ai", () => ({}));
vi.mock("@mariozechner/pi-coding-agent", () => ({
  withFileMutationQueue: vi.fn(),
}));

// Mock fs.existsSync to control the "does argv[1] exist?" branch
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  default: vi.fn(),
}));

import * as fs from "node:fs";
import { getPiInvocation } from "../../agent-runner.js";

const mockExistsSync = fs.existsSync as unknown as ReturnType<typeof vi.fn>;

// Save original process values so we can restore them after mutation
const originalArgv = [...process.argv];
const originalExecPath = process.execPath;

function restoreProcess() {
  process.argv = [...originalArgv];
  Object.defineProperty(process, "execPath", {
    value: originalExecPath,
    writable: true,
    configurable: true,
  });
}

function setProcessArgv1(argv1: string | undefined) {
  process.argv[1] = argv1 as string;
}

function setProcessExecPath(execPath: string) {
  Object.defineProperty(process, "execPath", {
    value: execPath,
    writable: true,
    configurable: true,
  });
}

describe("getPiInvocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    restoreProcess();
  });

  // ============================================================
  // Happy path: running inside pi (argv[1] = cli.js)
  // ============================================================
  describe("when running inside pi (argv[1] = cli.js)", () => {
    it("returns execPath + argv[1] when argv[1] is pi's cli.js", () => {
      setProcessArgv1("/home/user/nodejs/lib/node_modules/pi/dist/cli.js");
      setProcessExecPath("/home/user/nodejs/bin/node");
      mockExistsSync.mockReturnValue(true);

      const result = getPiInvocation(["--mode", "json", "-p"]);

      expect(result.command).toBe("/home/user/nodejs/bin/node");
      expect(result.args).toEqual([
        "/home/user/nodejs/lib/node_modules/pi/dist/cli.js",
        "--mode",
        "json",
        "-p",
      ]);
    });

    it("works with bare 'cli.js' basename regardless of directory", () => {
      setProcessArgv1("/opt/pi/cli.js");
      setProcessExecPath("/usr/local/bin/node");
      mockExistsSync.mockReturnValue(true);

      const result = getPiInvocation(["--agent", "echo"]);

      expect(result.command).toBe("/usr/local/bin/node");
      expect(result.args[0]).toBe("/opt/pi/cli.js");
    });
  });

  // ============================================================
  // Self-reference guard: argv[1] exists but is NOT cli.js
  // ============================================================
  describe("self-reference guard (fork bomb prevention)", () => {
    it("falls through when argv[1] is a test script (not cli.js)", () => {
      setProcessArgv1("/tmp/test-pi-invocation.js");
      setProcessExecPath("/home/user/nodejs/bin/node");
      mockExistsSync.mockReturnValue(true); // File exists, but it's NOT cli.js

      const result = getPiInvocation(["--mode", "json", "-p"]);

      // Must NOT return { command: "node", args: ["/tmp/test-pi-invocation.js", ...] }
      // That would re-execute the same script → fork bomb
      expect(result.command).toBe("pi");
      expect(result.args).toEqual(["--mode", "json", "-p"]);
    });

    it("falls through when argv[1] is an arbitrary .js file", () => {
      setProcessArgv1("/home/user/project/some-tool.js");
      setProcessExecPath("/home/user/nodejs/bin/node");
      mockExistsSync.mockReturnValue(true);

      const result = getPiInvocation(["--agent", "tabitha"]);

      expect(result.command).toBe("pi");
      expect(result.args).toEqual(["--agent", "tabitha"]);
    });

    it("falls through when argv[1] is a compiled extension index.ts", () => {
      setProcessArgv1("/project/.pi/extensions/subagent/index.ts");
      setProcessExecPath("/usr/bin/node");
      mockExistsSync.mockReturnValue(true);

      const result = getPiInvocation(["--mode", "json"]);

      expect(result.command).toBe("pi");
    });

    it("falls through when argv[1] has cli.js as a substring but isn't exactly cli.js", () => {
      setProcessArgv1("/project/my-cli.js");
      setProcessExecPath("/usr/bin/node");
      mockExistsSync.mockReturnValue(true);

      const result = getPiInvocation(["--mode", "json"]);

      expect(result.command).toBe("pi");
    });
  });

  // ============================================================
  // Generic runtime fallback (node/bun executable)
  // ============================================================
  describe("when running under generic runtime (node) without cli.js", () => {
    it("falls back to 'pi' command when argv[1] is undefined", () => {
      setProcessArgv1(undefined);
      setProcessExecPath("/usr/bin/node");
      mockExistsSync.mockReturnValue(false);

      const result = getPiInvocation(["--mode", "json", "-p"]);

      expect(result.command).toBe("pi");
      expect(result.args).toEqual(["--mode", "json", "-p"]);
    });

    it("falls back to 'pi' command when argv[1] doesn't exist on disk", () => {
      setProcessArgv1("/nonexistent/path/cli.js");
      setProcessExecPath("/usr/bin/node");
      mockExistsSync.mockReturnValue(false);

      const result = getPiInvocation(["--agent", "echo"]);

      expect(result.command).toBe("pi");
    });

    it("falls back to 'pi' command when argv[1] is not cli.js even if file exists", () => {
      setProcessArgv1("/some/random/script.js");
      setProcessExecPath("/usr/bin/node");
      mockExistsSync.mockReturnValue(true);

      const result = getPiInvocation(["--mode", "json"]);

      expect(result.command).toBe("pi");
    });
  });

  // ============================================================
  // Non-generic runtime (pi binary, bun compiled binary)
  // ============================================================
  describe("when running under non-generic runtime", () => {
    it("returns execPath directly when runtime is 'pi' binary", () => {
      setProcessArgv1(undefined);
      setProcessExecPath("/usr/local/bin/pi");
      mockExistsSync.mockReturnValue(false);

      const result = getPiInvocation(["--mode", "json", "-p"]);

      expect(result.command).toBe("/usr/local/bin/pi");
      expect(result.args).toEqual(["--mode", "json", "-p"]);
    });

    it("returns execPath directly for compiled bun binary", () => {
      setProcessArgv1(undefined);
      setProcessExecPath("/opt/pi-bin");
      mockExistsSync.mockReturnValue(false);

      const result = getPiInvocation(["--agent", "reviewer"]);

      expect(result.command).toBe("/opt/pi-bin");
    });

    it("skips cli.js path even if argv[1] points to non-cli.js file", () => {
      setProcessArgv1("/tmp/some-test.js");
      setProcessExecPath("/usr/local/bin/pi");
      mockExistsSync.mockReturnValue(true);

      const result = getPiInvocation(["--mode", "json"]);

      // Non-generic runtime: the execPath IS pi, so it returns execPath directly
      expect(result.command).toBe("/usr/local/bin/pi");
      expect(result.args).toEqual(["--mode", "json"]);
    });
  });

  // ============================================================
  // Bun runtime
  // ============================================================
  describe("when running under bun runtime", () => {
    it("falls back to 'pi' command when execPath is 'bun'", () => {
      setProcessArgv1(undefined);
      setProcessExecPath("/home/user/.bun/bin/bun");
      mockExistsSync.mockReturnValue(false);

      const result = getPiInvocation(["--mode", "json"]);

      expect(result.command).toBe("pi");
    });

    it("falls back to 'pi' command for bun.exe (simulated Windows basename)", () => {
      // On actual Windows, path.basename would correctly extract 'bun.exe'.
      // Here we simulate the resolved basename directly by setting execPath
      // to a path that basename-resolves to 'bun.exe' on this platform.
      setProcessArgv1(undefined);
      setProcessExecPath("/home/user/.bun/bin/bun.exe");
      mockExistsSync.mockReturnValue(false);

      const result = getPiInvocation(["--mode", "json"]);

      expect(result.command).toBe("pi");
    });
  });

  // ============================================================
  // Edge cases
  // ============================================================
  describe("edge cases", () => {
    it("preserves all args passed through", () => {
      // Make execPath a non-generic runtime (not node/bun) to test execPath return path
      setProcessArgv1(undefined);
      setProcessExecPath("/usr/bin/pi");
      mockExistsSync.mockReturnValue(false);

      const args = [
        "--mode",
        "json",
        "-p",
        "--session-dir",
        "/tmp/pi-session-test",
        "--no-extensions",
        "--no-themes",
        "--no-skills",
        "--no-prompt-templates",
        "-e",
        "/mock/path/.pi/extensions/compaction/index.ts",
        "--agent",
        "echo",
        "--task",
        "Find bugs",
        "--model",
        "gpt-4",
      ];

      const result = getPiInvocation(args);

      expect(result.args).toEqual(args);
    });

    it("handles empty args array", () => {
      setProcessArgv1(undefined);
      setProcessExecPath("/usr/bin/node");
      mockExistsSync.mockReturnValue(false);

      const result = getPiInvocation([]);

      expect(result.command).toBe("pi");
      expect(result.args).toEqual([]);
    });
  });
});
