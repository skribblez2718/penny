/**
 * eslint-security Extension — ESLint-based JS/TS security linting
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ COMBINED ENTRY — two npm plugins with DIFFERENT licenses:                 │
 * │   • eslint-plugin-security          MIT           (permissive)            │
 * │   • eslint-plugin-no-unsanitized    MPL-2.0       (file-level weak        │
 * │                                                     copyleft) — treated   │
 * │                                                     conservatively as     │
 * │                                                     COPYLEFT INVOKE-ONLY. │
 * │                                                                          │
 * │ This extension contains ZERO vendored source code from EITHER plugin. It │
 * │ only INVOKES an externally-installed `eslint` (with those plugins present │
 * │ in the target project's environment) as a subprocess. The MPL-2.0        │
 * │ no-unsanitized half MUST never have its source committed here            │
 * │ (tool_manifest.py: license_tier=copyleft_invoke_only). Classification is │
 * │ PROBABLE — re-verify MPL-2.0 against upstream LICENSE at provisioning.    │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Provides the `eslint_security_scan` tool. Requires the `eslint` binary on PATH
 * plus eslint-plugin-security and eslint-plugin-no-unsanitized installed in the
 * environment eslint runs in.
 *
 * Pinned version (tool_manifest.py, eslint-plugin-security): v4.0.1
 * Install: `npm install -D eslint eslint-plugin-security eslint-plugin-no-unsanitized`
 *
 * Ships its own bundled flat config: eslint.config.security.mjs (both plugins
 * active), passed via --config.
 *
 * REAL-VERIFIED (eslint, Batch F.2): the exact CLI invocation and the parser
 * were run against the installed binary. Flags:
 *   eslint --config <eslint.config.security.mjs> --format json --no-error-on-unmatched-pattern <target>
 * The parser matches the array-of-{messages} output shape — verified correct.
 * (The bundled security plugins must be resolvable in the environment eslint
 * runs in; PATH resolution of the `eslint` binary is trusted as before.)
 *
 * Edge case (documented): we trust PATH resolution of the `eslint` binary.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createLogger } from "../../lib/logger/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

const TOOL_NAME = "eslint-security";
const BINARY = "eslint";
const PINNED_VERSION = "v4.0.1"; // eslint-plugin-security
const CONFIG_PATH = join(__dir, "eslint.config.security.mjs");

const DEFAULT_TIMEOUT = 120000;
const MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_CHARS = 50000;

const INSTALL_HINT =
  "Install eslint + security plugins (eslint-plugin-security pinned " +
  PINNED_VERSION +
  "):\n  npm install -D eslint eslint-plugin-security eslint-plugin-no-unsanitized";

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

/** Shape of a single file result in eslint's `--format json` output. */
interface EslintFileResult {
  messages?: unknown[];
}

/** Best-effort finding count from eslint JSON output (array of file results). */
function countFindings(jsonOutput: string): number {
  try {
    const data: unknown = JSON.parse(jsonOutput);
    if (!Array.isArray(data)) return 0;
    return (data as EslintFileResult[]).reduce(
      (sum, f) => sum + (Array.isArray(f?.messages) ? f.messages.length : 0),
      0
    );
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
            message: `${TOOL_NAME} (eslint) is not installed (eslint-plugin-security pinned ${PINNED_VERSION}).`,
            install_hint: INSTALL_HINT,
          },
          null,
          2
        ),
      },
    ],
  };
}

export default function eslintSecurityExtension(pi: ExtensionAPI) {
  const logger = createLogger(TOOL_NAME);
  const version = detectVersion();
  const installed = version !== null;

  pi.registerTool({
    name: "eslint_security_scan",
    label: "ESLint Security Scan",
    description: [
      "Lint JS/TS for security issues using eslint-plugin-security + eslint-plugin-no-unsanitized.",
      `eslint ${installed ? `v-detected: ${version}` : `NOT INSTALLED — eslint-plugin-security pinned ${PINNED_VERSION}`}.`,
      "Uses bundled eslint.config.security.mjs (both plugins active). Returns normalized JSON findings.",
    ].join(" "),
    parameters: Type.Object({
      target: Type.String({ description: "File or directory path to lint" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 120000)" })),
    }),
    execute: async (_toolCallId, params) => {
      if (!installed) return notInstalledResponse();

      const target = params.target;
      const timeout = params.timeout || DEFAULT_TIMEOUT;
      // Array-form args ONLY — never a shell string (avoids command injection).
      const args = [
        "--config",
        CONFIG_PATH,
        "--format",
        "json",
        "--no-error-on-unmatched-pattern",
        target,
      ];

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
        // execFileSync throws an Error augmented with the child's captured stdio.
        const execErr = err as { stdout?: string; stderr?: string; message?: string };
        // eslint exits 1 when lint problems (findings) are present — normal.
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
                    note: "eslint exited non-zero (findings found — this is normal)",
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
                  error: "eslint execution failed",
                  stderr: truncateOutput(execErr.stderr || execErr.message || "Unknown error"),
                  hint: "Ensure eslint, eslint-plugin-security, and eslint-plugin-no-unsanitized are installed and the target exists.",
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

  if (installed) logger.info("eslint detected", { version });
  else logger.warn("eslint NOT installed — tool will return install instructions");
}
