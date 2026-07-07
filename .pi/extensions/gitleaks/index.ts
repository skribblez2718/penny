/**
 * gitleaks Extension — secret scanner for git repos and filesystems
 *
 * Provides the `gitleaks_scan` tool. Requires the `gitleaks` binary on PATH.
 * INVOKES the binary as a separate process only — does not vendor source.
 *
 * License: MIT (permissive_embed per tool_manifest.py) — PROBABLE confidence;
 * upstream LICENSE is the authority.
 *
 * Pinned version (tool_manifest.py): v8.30.1
 * Install: https://github.com/gitleaks/gitleaks#installing
 *   e.g. `brew install gitleaks`
 *
 * Ships its own bundled config: .gitleaks.toml (passed via --config).
 *
 * REAL-VERIFIED (gitleaks v8.30.1, Batch F.2): the exact CLI invocation and the
 * JSON report parser were run against the installed binary. Flags used:
 *   gitleaks detect --source <target> --no-git --no-banner --config <toml>
 *            --report-format json --report-path <tmpfile>
 * CRITICAL: --no-git is REQUIRED. Without it, `detect` treats the target as a
 * git repository and scans its history — on a plain non-git directory (the
 * common case for sca's cloned-source targets) this scanned ~0 bytes and
 * reported "no leaks found": a silent secret-scan coverage hole. With --no-git,
 * gitleaks scans the files on disk (verified: 0 bytes / 0 findings without the
 * flag vs. a real byte-scan finding a planted private key with it). gitleaks
 * writes its JSON report to a file, so we use a temp path and read it back
 * rather than parsing stdout. The parser (top-level JSON array of findings) is
 * verified correct against the real output shape.
 *
 * Edge case (documented): we trust PATH resolution of the `gitleaks` binary.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createLogger } from "../../lib/logger/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

const TOOL_NAME = "gitleaks";
const BINARY = "gitleaks";
const PINNED_VERSION = "v8.30.1";
const CONFIG_PATH = join(__dir, ".gitleaks.toml");

const DEFAULT_TIMEOUT = 120000;
const MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_CHARS = 50000;

const INSTALL_HINT =
  "Install gitleaks (pinned " +
  PINNED_VERSION +
  "):\n  brew install gitleaks\n  See https://github.com/gitleaks/gitleaks#installing";

function truncateOutput(text: string): string {
  const lines = text.split("\n");
  const truncated = lines.slice(0, MAX_OUTPUT_LINES);
  let result = truncated.join("\n");
  if (lines.length > MAX_OUTPUT_LINES) {
    result += `\n\n[Truncated — ${lines.length - MAX_OUTPUT_LINES} more lines]`;
  }
  if (result.length > MAX_OUTPUT_CHARS) {
    result =
      result.slice(0, MAX_OUTPUT_CHARS) +
      `\n\n[Truncated — output exceeded ${MAX_OUTPUT_CHARS} chars]`;
  }
  return result;
}

function detectVersion(): string | null {
  try {
    const r = spawnSync(BINARY, ["version"], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.error || r.status !== 0) return null;
    return ((r.stdout ?? "") + (r.stderr ?? "")).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Build the gitleaks CLI arg vector (array-form ONLY — never a shell string, to
 * avoid command injection). --no-git is REQUIRED so gitleaks scans the files on
 * disk instead of an (often absent/empty) git history on a plain directory
 * (Batch F.2 REAL-VERIFIED fix — gitleaks v8.30.1). Exported for unit testing.
 */
export function buildGitleaksArgs(target: string, reportPath: string): string[] {
  return [
    "detect",
    "--source",
    target,
    "--no-git",
    "--no-banner",
    "--config",
    CONFIG_PATH,
    "--report-format",
    "json",
    "--report-path",
    reportPath,
  ];
}

/**
 * Shape of the error thrown by execFileSync on a non-zero exit / spawn failure.
 * `status` is the child's exit code (null if it was killed by a signal),
 * `stderr` is its captured stderr, `message` is the JS error message. All are
 * optional because the thrown value is not statically typed by Node.
 */
interface ExecError {
  status?: number | null;
  stderr?: string;
  message?: string;
}

function isExecError(err: unknown): err is ExecError {
  return typeof err === "object" && err !== null;
}

function countFindings(reportJson: string): number {
  try {
    const data = JSON.parse(reportJson);
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

function notInstalledResponse() {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: false,
            tool: TOOL_NAME,
            installed: false,
            pinned_version: PINNED_VERSION,
            message: `${TOOL_NAME} is not installed (pinned version ${PINNED_VERSION}).`,
            install_hint: INSTALL_HINT,
          },
          null,
          2
        ),
      },
    ],
  };
}

export default function gitleaksExtension(pi: ExtensionAPI) {
  const logger = createLogger(TOOL_NAME);
  const version = detectVersion();
  const installed = version !== null;

  pi.registerTool({
    name: "gitleaks_scan",
    label: "Gitleaks Scan",
    description: [
      "Scan a directory or git repository for hardcoded secrets and credentials.",
      `gitleaks ${installed ? `v-detected: ${version}` : `NOT INSTALLED — pinned ${PINNED_VERSION}`}.`,
      "Uses the bundled .gitleaks.toml config. Returns normalized JSON findings.",
    ].join(" "),
    parameters: Type.Object({
      target: Type.String({ description: "Directory or repository path to scan" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 120000)" })),
    }),
    execute: async (_toolCallId, params) => {
      if (!installed) return notInstalledResponse();

      const target = params.target;
      const timeout = params.timeout || DEFAULT_TIMEOUT;
      const reportPath = join(tmpdir(), `gitleaks-${randomUUID()}.json`);
      // Array-form args ONLY — never a shell string (avoids command injection).
      // Includes the REQUIRED --no-git flag (Batch F.2 fix; see buildGitleaksArgs).
      const args = buildGitleaksArgs(target, reportPath);

      const readReport = (): string => {
        try {
          if (existsSync(reportPath)) return readFileSync(reportPath, "utf-8");
        } catch {
          /* ignore */
        }
        return "[]";
      };
      const cleanup = () => {
        try {
          if (existsSync(reportPath)) unlinkSync(reportPath);
        } catch {
          /* ignore */
        }
      };

      try {
        execFileSync(BINARY, args, {
          encoding: "utf-8",
          timeout,
          maxBuffer: 50 * 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const report = readReport();
        cleanup();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  tool: TOOL_NAME,
                  version,
                  target,
                  total_findings: countFindings(report),
                  raw_output: truncateOutput(report),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        // gitleaks exits with code 1 when leaks are found — that is normal,
        // not a hard failure. Any other non-zero status is a real error.
        const report = readReport();
        cleanup();
        const execErr: ExecError = isExecError(err) ? err : {};
        if (execErr.status === 1) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    success: true,
                    tool: TOOL_NAME,
                    version,
                    target,
                    total_findings: countFindings(report),
                    note: "gitleaks exited non-zero (secrets found — this is normal)",
                    raw_output: truncateOutput(report),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  tool: TOOL_NAME,
                  error: "gitleaks execution failed",
                  stderr: truncateOutput(execErr.stderr || execErr.message || "Unknown error"),
                  hint: "Check that the target path exists and gitleaks is functional.",
                },
                null,
                2
              ),
            },
          ],
        };
      }
    },
  });

  if (installed) logger.info("gitleaks detected", { version });
  else logger.warn("gitleaks NOT installed — tool will return install instructions");
}
