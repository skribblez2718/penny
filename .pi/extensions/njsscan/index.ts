/**
 * njsscan Extension — SAST scanner for Node.js applications
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ COPYLEFT — INVOKE-ONLY. njsscan is licensed LGPL-3.0-only.                │
 * │                                                                          │
 * │ This extension contains ZERO vendored/copied source code from njsscan.   │
 * │ It ONLY invokes an externally-installed `njsscan` binary as a separate   │
 * │ subprocess. Embedding/committing njsscan source here is forbidden        │
 * │ (tool_manifest.py: license_tier=copyleft_invoke_only).                   │
 * │                                                                          │
 * │ NOTE: the bundled `.njsscan` config in THIS directory is AUTHORED BY US  │
 * │ (a small, tuned default) — it is NOT njsscan's upstream default config   │
 * │ file and contains none of njsscan's source.                             │
 * │                                                                          │
 * │ License classification is PROBABLE and MUST be re-verified against the   │
 * │ upstream LICENSE at real provisioning time (Carren N3).                  │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Provides the `njsscan_scan` tool. Requires the `njsscan` binary on PATH.
 *
 * Pinned version (tool_manifest.py): v0.4.3
 * Install: `pip install njsscan==0.4.3`
 *
 * REAL-VERIFIED (njsscan v0.4.3, Batch F.2): the exact CLI invocation and the
 * parser were run against the installed binary. Flags used:
 *   njsscan --json <target>
 * The parser matches {nodejs,templates}[key].files — verified correct against
 * the real output shape.
 * njsscan auto-discovers a `.njsscan` config from the scan root. Wiring our
 * bundled `.njsscan` into an arbitrary target dir is intentionally deferred
 * (we do not mutate the target); the shipped config documents our tuned default.
 *
 * Edge case (documented): we trust PATH resolution of the `njsscan` binary.
 */

import { execFileSync, spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createLogger } from "../../lib/logger/logger.js";

const TOOL_NAME = "njsscan";
const BINARY = "njsscan";
const PINNED_VERSION = "v0.4.3";

const DEFAULT_TIMEOUT = 120000;
const MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_CHARS = 50000;

const INSTALL_HINT =
  "Install njsscan (pinned " + PINNED_VERSION + "):\n  pip install njsscan==0.4.3";

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

/** Best-effort finding count from njsscan JSON output. */
function countFindings(jsonOutput: string): number {
  try {
    const data = JSON.parse(jsonOutput);
    let total = 0;
    for (const section of ["nodejs", "templates"]) {
      const rules = data[section] || {};
      for (const key of Object.keys(rules)) {
        total += (rules[key]?.files || []).length;
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

export default function njsscanExtension(pi: ExtensionAPI) {
  const logger = createLogger(TOOL_NAME);
  const version = detectVersion();
  const installed = version !== null;

  pi.registerTool({
    name: "njsscan_scan",
    label: "njsscan Scan",
    description: [
      "Run njsscan SAST against a Node.js project for insecure code patterns.",
      `njsscan ${installed ? `v-detected: ${version}` : `NOT INSTALLED — pinned ${PINNED_VERSION}`}.`,
      "Copyleft (LGPL-3.0) invoke-only — no vendored source. Returns normalized JSON findings.",
    ].join(" "),
    parameters: Type.Object({
      target: Type.String({ description: "Directory path to scan" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 120000)" })),
    }),
    execute: async (_toolCallId, params) => {
      if (!installed) return notInstalledResponse();

      const target = params.target;
      const timeout = params.timeout || DEFAULT_TIMEOUT;
      // Array-form args ONLY — never a shell string (avoids command injection).
      const args = ["--json", target];

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
        // execFileSync throws an Error augmented with the child's stdout/stderr
        // (strings here, since encoding is utf-8) plus the usual `message`.
        const execErr = err as {
          stdout?: string;
          stderr?: string;
          message?: string;
        };
        // njsscan may exit non-zero when findings are present.
        if (execErr.stdout) {
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
                    note: "njsscan exited non-zero (findings found — this is normal)",
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
                  error: "njsscan execution failed",
                  stderr: truncateOutput(execErr.stderr || execErr.message || "Unknown error"),
                  hint: "Check that the target path exists and njsscan is functional.",
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

  if (installed) logger.info("njsscan detected", { version });
  else logger.warn("njsscan NOT installed — tool will return install instructions");
}
