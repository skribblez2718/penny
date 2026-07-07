/**
 * osv-scanner Extension — dependency/SBOM vulnerability scanner (OSV database)
 *
 * Provides the `osv_scanner_scan` tool. Requires the `osv-scanner` binary on
 * PATH (Google OSV-Scanner). This extension INVOKES the binary as a separate
 * process only — it does not vendor osv-scanner's source.
 *
 * License: Apache-2.0 (permissive_embed per tool_manifest.py) — PROBABLE
 * confidence; upstream LICENSE is the authority.
 *
 * Pinned version (tool_manifest.py): v2.4.0
 * Install: https://google.github.io/osv-scanner/installation/
 *   e.g. `brew install osv-scanner` or `go install github.com/google/osv-scanner/v2/cmd/osv-scanner@v2.4.0`
 *
 * Ships its own bundled config: osv-scanner.toml (passed via --config).
 *
 * REAL-VERIFIED (osv-scanner v2.4.0, Batch F.2): the exact CLI invocation and
 * the parser were run against the installed binary. Flags used:
 *   osv-scanner scan source --config <toml> --format json <target>
 * The parser walks results[].packages[].vulnerabilities[] — verified correct
 * against the real output shape. (rc=1 on a target with vulnerabilities works.)
 *
 * EXIT-CODE CONVENTION (REAL-VERIFIED — osv-scanner v2.4.0): OSV-Scanner
 * documents exit code 0 = no vulnerabilities, 1 = vulnerabilities found (a
 * normal outcome, not a crash), and other non-zero codes (e.g. 127/128) =
 * operational error. Phase 6b hardens the catch handler to key on this specific
 * convention (see classifyOsvExit), mirroring gitleaks' `err.status === 1`
 * check, rather than the looser generic `if (err.stdout)` truthy heuristic
 * inherited from the semgrep reference (which would mis-classify a crash that
 * happened to emit stdout as a successful findings run).
 *
 * Edge case (documented, not over-engineered): we trust PATH resolution of the
 * `osv-scanner` binary. If a future environment has a different program by that
 * name, that is an accepted v1 risk (mirrors semgrep's own approach).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createLogger } from "../../lib/logger/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

const TOOL_NAME = "osv-scanner";
const BINARY = "osv-scanner";
const PINNED_VERSION = "v2.4.0";
const CONFIG_PATH = join(__dir, "osv-scanner.toml");

const DEFAULT_TIMEOUT = 120000; // 2 minutes
const MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_CHARS = 50000;

const INSTALL_HINT =
  "Install osv-scanner (pinned " +
  PINNED_VERSION +
  "):\n  brew install osv-scanner\n  OR  go install github.com/google/osv-scanner/v2/cmd/osv-scanner@" +
  PINNED_VERSION +
  "\n  See https://google.github.io/osv-scanner/installation/";

/**
 * Classify a caught osv-scanner exit status per its documented convention:
 * exit 1 = vulnerabilities found (normal), any other non-zero = operational
 * error. PROBABLE confidence — osv-scanner is not installed here to verify.
 * Exported for unit testing.
 */
export function classifyOsvExit(status: number | null | undefined): "findings" | "error" {
  return status === 1 ? "findings" : "error";
}

/**
 * Normalized shape of the error thrown by `execFileSync` when the child
 * process fails. `status` is the exit code (null if the process was
 * terminated by a signal); `stdout`/`stderr` are captured because we pass
 * `encoding: "utf-8"`, so they are strings rather than Buffers.
 */
interface OsvExecError {
  status: number | null;
  stdout: string;
  stderr: string;
  message: string;
}

/** Narrow an unknown caught value into the fields we read off an exec error. */
function toOsvExecError(err: unknown): OsvExecError {
  const e: Record<string, unknown> =
    typeof err === "object" && err !== null ? (err as Record<string, unknown>) : {};
  return {
    status: typeof e.status === "number" ? e.status : null,
    stdout: typeof e.stdout === "string" ? e.stdout : "",
    stderr: typeof e.stderr === "string" ? e.stderr : "",
    message: err instanceof Error ? err.message : typeof e.message === "string" ? e.message : "",
  };
}

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

/** Detect the installed version, or null if the binary is not on PATH. */
function detectVersion(): string | null {
  try {
    const r = spawnSync(BINARY, ["--version"], {
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

/** Best-effort finding count from osv-scanner JSON output. */
function countFindings(jsonOutput: string): number {
  try {
    const data = JSON.parse(jsonOutput);
    let total = 0;
    for (const res of data.results || []) {
      for (const pkg of res.packages || []) {
        total += (pkg.vulnerabilities || []).length;
      }
    }
    return total;
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

export default function osvScannerExtension(pi: ExtensionAPI) {
  const logger = createLogger(TOOL_NAME);
  const version = detectVersion();
  const installed = version !== null;

  pi.registerTool({
    name: "osv_scanner_scan",
    label: "OSV-Scanner Scan",
    description: [
      "Scan a directory, lockfile, or SBOM for known-vulnerable dependencies using the OSV database.",
      `osv-scanner ${installed ? `v-detected: ${version}` : `NOT INSTALLED — pinned ${PINNED_VERSION}`}.`,
      "Uses the bundled osv-scanner.toml config. Returns normalized JSON findings.",
    ].join(" "),
    parameters: Type.Object({
      target: Type.String({
        description: "File or directory path to scan (project dir, lockfile, or SBOM)",
      }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 120000)" })),
    }),
    execute: async (_toolCallId, params) => {
      if (!installed) return notInstalledResponse();

      const target = params.target;
      const timeout = params.timeout || DEFAULT_TIMEOUT;
      // Array-form args ONLY — never a shell string (avoids command injection).
      const args = ["scan", "source", "--config", CONFIG_PATH, "--format", "json", target];

      try {
        const out = execFileSync(BINARY, args, {
          encoding: "utf-8",
          timeout,
          maxBuffer: 50 * 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe"],
        });
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
                  total_findings: countFindings(out),
                  raw_output: truncateOutput(out),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        // Tool-specific exit-code handling (Phase 6b): osv-scanner exits with
        // status 1 when vulnerabilities are found (normal); any other non-zero
        // status is a real operational error. This replaces the looser generic
        // `if (err.stdout)` truthy check.
        const execErr = toOsvExecError(err);
        if (classifyOsvExit(execErr.status) === "findings") {
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
                    total_findings: countFindings(execErr.stdout),
                    note: "osv-scanner exited non-zero (vulnerabilities found — this is normal)",
                    raw_output: truncateOutput(execErr.stdout),
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
                  error: "osv-scanner execution failed",
                  stderr: truncateOutput(execErr.stderr || execErr.message || "Unknown error"),
                  hint: "Check that the target path exists and osv-scanner is functional.",
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

  if (installed) logger.info("osv-scanner detected", { version });
  else logger.warn("osv-scanner NOT installed — tool will return install instructions");
}
