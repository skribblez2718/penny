/**
 * codeql Extension — GitHub CodeQL static analysis (OPT-IN ONLY)
 *
 * Provides the `codeql_scan` tool. Requires the `codeql` binary on PATH.
 * INVOKES the binary as a separate process only — does not vendor source.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ OPT-IN GATE (enabled_by_default=False in tool_manifest.py — codeql is the │
 * │ ONLY tool with this). execute() checks a REQUIRED `confirm_opt_in`        │
 * │ boolean as the VERY FIRST action — before ANY binary detection, before    │
 * │ ANY subprocess or network call. If it is not explicitly true, execute()   │
 * │ returns a STATIC, informational license notice and does nothing else.     │
 * │                                                                          │
 * │ IMPORTANT: the notice is a STATIC surfacing of the CodeQL CLI license     │
 * │ terms — it is NOT a live GitHub repository-visibility check (per resolved │
 * │ PRD nit N2). This extension performs NO network calls to determine repo   │
 * │ visibility or entitlement.                                               │
 * │                                                                          │
 * │ For the SAME reason, this extension does NOT detect the codeql binary at  │
 * │ module/factory load time — detection only happens INSIDE execute() AFTER  │
 * │ the opt-in gate passes (anti-criterion: no binary detection unless        │
 * │ confirm_opt_in is true).                                                 │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * License: GitHub CodeQL CLI terms (LicenseRef-GitHub-CodeQL-Terms). Free for
 * analysing OPEN-SOURCE code and academic research; static analysis of PRIVATE
 * repositories requires a GitHub Advanced Security / Enterprise entitlement.
 * PROBABLE confidence; upstream terms are the authority.
 *
 * Pinned version (tool_manifest.py): v2.25.6
 * Install: https://docs.github.com/en/code-security/codeql-cli
 *
 * Ships its own bundled config: codeql-config.yml.
 *
 * CONFIDENCE NOTE (Batch F.2 — codeql v2.25.6):
 *   • VERSION-CHECK: REAL-VERIFIED. `codeql version --format=terse` was run
 *     against the installed binary (returns 2.25.6). This is the only path the
 *     unit tests exercise (and only after the opt-in gate).
 *   • FULL SCAN PATH: NOT verified end-to-end. codeql is a two-step tool
 *     (database create → database analyze); a real run is a heavy two-step DB
 *     build and is opt-in / off-by-default (behind the confirm_opt_in gate).
 *     Verification of the scan path is DEFERRED — it is NOT run in the test
 *     suite and is NOT claimed as verified. The flags below are best-effort:
 *       codeql database create <db> --source-root <target> --language=javascript-typescript
 *       codeql database analyze <db> --format=sarifv2.1.0 --output=<sarif> <query-suite>
 *     The countFindings parser (SARIF runs[].results[]) is likewise unverified
 *     against a real codeql SARIF and remains best-effort pending scan-path
 *     verification.
 *
 * Edge case (documented): we trust PATH resolution of the `codeql` binary.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createLogger } from "../../lib/logger/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

const TOOL_NAME = "codeql";
const BINARY = "codeql";
const PINNED_VERSION = "v2.25.6";
const CONFIG_PATH = join(__dir, "codeql-config.yml");

const DEFAULT_TIMEOUT = 600000; // 10 minutes (DB build + analyze can be slow)
const MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_CHARS = 50000;

const INSTALL_HINT =
  "Install codeql (pinned " +
  PINNED_VERSION +
  "):\n  See https://docs.github.com/en/code-security/codeql-cli";

// STATIC (non-live) license notice — returned when opt-in is not given.
const OPT_IN_NOTICE = [
  "codeql is OPT-IN only and did NOT run.",
  "",
  "To run codeql, call this tool again with confirm_opt_in=true.",
  "",
  "LICENSE NOTICE (static — this extension does NOT perform any live GitHub",
  "repository-visibility or entitlement check):",
  "The GitHub CodeQL CLI is free for analysing OPEN-SOURCE code and for academic",
  "research. STATIC analysis of PRIVATE repositories requires a GitHub Advanced",
  "Security / Enterprise entitlement. By setting confirm_opt_in=true you assert",
  "your usage complies with the GitHub CodeQL CLI terms. (PROBABLE — verify the",
  "current terms upstream before relying on this.)",
].join("\n");

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

/**
 * Extract a human-readable error string from a caught value. execSync throws
 * an Error augmented with a `stderr` field (string here, since encoding is utf-8),
 * so prefer that; fall back to the message.
 */
function extractErrorOutput(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const e = err as { stderr?: unknown; message?: unknown };
    if (typeof e.stderr === "string" && e.stderr.length > 0) {
      return e.stderr;
    }
    if (e.stderr instanceof Uint8Array && e.stderr.length > 0) {
      return new TextDecoder().decode(e.stderr);
    }
    if (typeof e.message === "string" && e.message.length > 0) {
      return e.message;
    }
  }
  return "Unknown error";
}

/** Detect the installed version, or null. ONLY called after the opt-in gate. */
function detectVersion(): string | null {
  try {
    const r = spawnSync(BINARY, ["version", "--format=terse"], {
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

/** Best-effort finding count from SARIF v2.1.0 output. */
function countFindings(sarifJson: string): number {
  try {
    const data = JSON.parse(sarifJson);
    let total = 0;
    for (const run of data.runs || []) {
      total += (run.results || []).length;
    }
    return total;
  } catch {
    return 0;
  }
}

export default function codeqlExtension(pi: ExtensionAPI) {
  const logger = createLogger(TOOL_NAME);

  pi.registerTool({
    name: "codeql_scan",
    label: "CodeQL Scan",
    description: [
      "Run GitHub CodeQL static analysis against a source tree. OPT-IN ONLY:",
      "must be called with confirm_opt_in=true, else returns a static license notice.",
      `codeql pinned ${PINNED_VERSION}. Requires a GitHub Advanced Security entitlement for PRIVATE repos.`,
      "Returns normalized JSON findings (from SARIF).",
    ].join(" "),
    parameters: Type.Object({
      confirm_opt_in: Type.Boolean({
        description:
          "REQUIRED. Must be true to run codeql. Asserts your usage complies with the GitHub CodeQL CLI license terms (static acknowledgement, not a live check).",
      }),
      target: Type.String({ description: "Source directory to analyze" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 600000)" })),
    }),
    execute: async (_toolCallId, params) => {
      // ── OPT-IN GATE — VERY FIRST action. No detection/subprocess/network. ──
      if (params.confirm_opt_in !== true) {
        return { content: [{ type: "text" as const, text: OPT_IN_NOTICE }] };
      }

      // Only AFTER the gate do we detect the binary.
      const version = detectVersion();
      if (version === null) {
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

      const target = params.target;
      const timeout = params.timeout || DEFAULT_TIMEOUT;
      const dbPath = join(tmpdir(), `codeql-db-${randomUUID()}`);
      const sarifPath = join(tmpdir(), `codeql-${randomUUID()}.sarif`);

      const cleanup = () => {
        try {
          if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true });
          if (existsSync(sarifPath)) rmSync(sarifPath, { force: true });
        } catch {
          /* ignore */
        }
      };

      try {
        // Step 1: build the database. Array-form args ONLY (no shell string).
        execFileSync(
          BINARY,
          [
            "database",
            "create",
            dbPath,
            "--source-root",
            target,
            "--language=javascript-typescript",
            "--codescanning-config",
            CONFIG_PATH,
            "--overwrite",
          ],
          {
            encoding: "utf-8",
            timeout,
            maxBuffer: 50 * 1024 * 1024,
            stdio: ["pipe", "pipe", "pipe"],
          }
        );

        // Step 2: analyze with the default security query suite.
        execFileSync(
          BINARY,
          [
            "database",
            "analyze",
            dbPath,
            "codeql/javascript-queries",
            "--format=sarifv2.1.0",
            `--output=${sarifPath}`,
          ],
          {
            encoding: "utf-8",
            timeout,
            maxBuffer: 50 * 1024 * 1024,
            stdio: ["pipe", "pipe", "pipe"],
          }
        );

        const sarif = existsSync(sarifPath) ? readFileSync(sarifPath, "utf-8") : "{}";
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
                  total_findings: countFindings(sarif),
                  raw_output: truncateOutput(sarif),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        cleanup();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  tool: TOOL_NAME,
                  error: "codeql execution failed",
                  stderr: truncateOutput(extractErrorOutput(err)),
                  hint: "Check that codeql is installed, the target is a valid source tree, and you have the required entitlement.",
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

  logger.info("codeql extension loaded (opt-in only; no binary detection at load)");
}
