/**
 * retire.js Extension — scanner for known-vulnerable JavaScript libraries
 *
 * Provides the `retire_js_scan` tool. Requires the `retire` binary on PATH
 * (npm package `retire`). INVOKES the binary as a separate process only — does
 * not vendor source.
 *
 * License: Apache-2.0 (permissive_embed per tool_manifest.py) — PROBABLE
 * confidence; upstream LICENSE is the authority.
 *
 * Pinned version (tool_manifest.py): v5.4.3
 * Install: `npm install -g retire@5.4.3`
 *
 * NO BUNDLED CONFIG: per the architecture decision, retire-js ships no config
 * file (invoke-only, relies on retire.js's built-in advisory repository). This
 * is intentional — do not add a config file to this extension.
 *
 * REAL-VERIFIED (retire.js v5.4.3, Batch F.2): the exact CLI invocation and the
 * parser were run against the installed binary. Flags used:
 *   retire --path <target> --outputformat json --outputpath <stdout>
 * The parser matches {data}[].results[].vulnerabilities — verified correct
 * against the real output shape.
 *
 * Edge case (documented): we trust PATH resolution of the `retire` binary.
 */

import { execFileSync, spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createLogger } from "../../lib/logger/logger.js";

const TOOL_NAME = "retire.js";
const BINARY = "retire";
const PINNED_VERSION = "v5.4.3";

const DEFAULT_TIMEOUT = 120000;
const MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_CHARS = 50000;

const INSTALL_HINT =
  "Install retire.js (pinned " + PINNED_VERSION + "):\n  npm install -g retire@5.4.3";

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

function countFindings(jsonOutput: string): number {
  try {
    const data = JSON.parse(jsonOutput);
    const rows = data.data || (Array.isArray(data) ? data : []);
    let total = 0;
    for (const row of rows) {
      for (const result of row.results || []) {
        total += (result.vulnerabilities || []).length;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Shape of the exception thrown by execFileSync. When a child process exits
 * non-zero (or fails), Node throws an Error augmented with the captured stdio.
 * With `encoding: "utf-8"`, stdout/stderr are strings rather than Buffers.
 */
interface ExecFileError {
  stdout?: string;
  stderr?: string;
  message?: string;
}

function asExecFileError(err: unknown): ExecFileError {
  if (typeof err !== "object" || err === null) return {};
  const e = err as Record<string, unknown>;
  return {
    stdout: typeof e.stdout === "string" ? e.stdout : undefined,
    stderr: typeof e.stderr === "string" ? e.stderr : undefined,
    message: typeof e.message === "string" ? e.message : undefined,
  };
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

export default function retireJsExtension(pi: ExtensionAPI) {
  const logger = createLogger("retire-js");
  const version = detectVersion();
  const installed = version !== null;

  pi.registerTool({
    name: "retire_js_scan",
    label: "retire.js Scan",
    description: [
      "Scan a JavaScript/Node project for known-vulnerable library versions.",
      `retire.js ${installed ? `v-detected: ${version}` : `NOT INSTALLED — pinned ${PINNED_VERSION}`}.`,
      "No bundled config (uses retire.js's built-in advisory repository). Returns normalized JSON findings.",
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
      const args = ["--path", target, "--outputformat", "json"];

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
        // retire.js exits non-zero (13) when vulnerabilities are found — normal.
        const execErr = asExecFileError(err);
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
                    note: "retire.js exited non-zero (vulnerabilities found — this is normal)",
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
                  error: "retire.js execution failed",
                  stderr: truncateOutput(execErr.stderr || execErr.message || "Unknown error"),
                  hint: "Check that the target path exists and retire is functional.",
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

  if (installed) logger.info("retire.js detected", { version });
  else logger.warn("retire.js NOT installed — tool will return install instructions");
}
