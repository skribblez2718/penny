/**
 * trufflehog Extension — verified-secret scanner
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ COPYLEFT — INVOKE-ONLY. trufflehog is licensed AGPL-3.0-only.             │
 * │                                                                          │
 * │ This extension contains ZERO vendored/copied source code from            │
 * │ trufflehog. It ONLY invokes an externally-installed `trufflehog` binary  │
 * │ as a separate subprocess. Embedding/committing trufflehog source here    │
 * │ would create AGPL distribution obligations for this repository and is    │
 * │ strictly forbidden (tool_manifest.py: license_tier=copyleft_invoke_only).│
 * │                                                                          │
 * │ License classification is PROBABLE and MUST be re-verified against the   │
 * │ upstream LICENSE at real provisioning time (Carren N3 — a prior research │
 * │ contradiction surfaced on trufflehog's license).                        │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Provides the `trufflehog_scan` tool. Requires the `trufflehog` binary on PATH.
 *
 * Pinned version (tool_manifest.py): v3.95.7
 * Install: https://github.com/trufflesecurity/trufflehog#installation
 *   e.g. `brew install trufflehog`
 *
 * NO BUNDLED CONFIG: per the architecture decision, trufflehog ships no config
 * file (invoke-only). Do not add one.
 *
 * REAL-VERIFIED (trufflehog v3.95.7, Batch F.2): the exact CLI invocation and
 * the parser were run against the installed binary. Flags used:
 *   trufflehog filesystem <target> --json --no-update
 * trufflehog emits newline-delimited JSON (JSONL), one finding per line; the
 * parser matches DetectorName/SourceMetadata/Raw — verified correct against the
 * real output shape.
 *
 * Edge case (documented): we trust PATH resolution of the `trufflehog` binary.
 */

import { execFileSync, spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createLogger } from "../../lib/logger/logger.js";

const TOOL_NAME = "trufflehog";
const BINARY = "trufflehog";
const PINNED_VERSION = "v3.95.7";

const DEFAULT_TIMEOUT = 180000;
const MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_CHARS = 50000;

const INSTALL_HINT =
  "Install trufflehog (pinned " +
  PINNED_VERSION +
  "):\n  brew install trufflehog\n  See https://github.com/trufflesecurity/trufflehog#installation";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Read a subprocess stdout/stderr field as a string. The scan runs with
 * `encoding: "utf-8"`, so these fields are strings when present; anything else
 * (undefined/Buffer) is treated as absent.
 */
function toOutputString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Best-effort finding count from trufflehog JSONL output (one JSON per line). */
function countFindings(jsonlOutput: string): number {
  let total = 0;
  for (const line of jsonlOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && (obj.DetectorName || obj.SourceMetadata || obj.Raw)) total += 1;
    } catch {
      /* non-JSON progress line — ignore */
    }
  }
  return total;
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

export default function trufflehogExtension(pi: ExtensionAPI) {
  const logger = createLogger(TOOL_NAME);
  const version = detectVersion();
  const installed = version !== null;

  pi.registerTool({
    name: "trufflehog_scan",
    label: "TruffleHog Scan",
    description: [
      "Scan a filesystem path for verified secrets/credentials using trufflehog.",
      `trufflehog ${installed ? `v-detected: ${version}` : `NOT INSTALLED — pinned ${PINNED_VERSION}`}.`,
      "Copyleft (AGPL-3.0) invoke-only — no vendored source. Returns normalized JSON findings.",
    ].join(" "),
    parameters: Type.Object({
      target: Type.String({ description: "Filesystem path to scan" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 180000)" })),
    }),
    execute: async (_toolCallId, params) => {
      if (!installed) return notInstalledResponse();

      const target = params.target;
      const timeout = params.timeout || DEFAULT_TIMEOUT;
      // Array-form args ONLY — never a shell string (avoids command injection).
      const args = ["filesystem", target, "--json", "--no-update"];

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
        // trufflehog may exit non-zero when findings are present (e.g. --fail).
        const stdout = isRecord(err) ? toOutputString(err.stdout) : undefined;
        const stderr = isRecord(err) ? toOutputString(err.stderr) : undefined;
        const message = isRecord(err) && typeof err.message === "string" ? err.message : undefined;
        if (stdout) {
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
                    total_findings: countFindings(stdout),
                    note: "trufflehog exited non-zero (secrets found — this is normal)",
                    raw_output: truncateOutput(stdout),
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
                  error: "trufflehog execution failed",
                  stderr: truncateOutput(stderr || message || "Unknown error"),
                  hint: "Check that the target path exists and trufflehog is functional.",
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

  if (installed) logger.info("trufflehog detected", { version });
  else logger.warn("trufflehog NOT installed — tool will return install instructions");
}
