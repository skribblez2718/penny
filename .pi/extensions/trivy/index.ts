/**
 * trivy Extension — vulnerability / misconfiguration / secret scanner
 *
 * Provides the `trivy_scan` tool. Requires the `trivy` binary on PATH.
 * INVOKES the binary as a separate process only — does not vendor source.
 *
 * License: Apache-2.0 (permissive_embed per tool_manifest.py) — PROBABLE
 * confidence; upstream LICENSE is the authority.
 *
 * Pinned version (tool_manifest.py): v0.72.0
 * Install: https://trivy.dev/latest/getting-started/installation/
 *   e.g. `brew install trivy`
 *
 * Ships its own bundled config: trivy.yaml (+ trivy-secret.yaml for the secret
 * scanner). The secret ruleset is passed as an EXPLICIT absolute
 * `--secret-config <abs path>` CLI arg (Phase 6b, Carren's Phase 4a nit):
 * relying on trivy.yaml's internal relative `secret.config: trivy-secret.yaml`
 * reference resolving against an unpredictable runtime cwd risked a silent,
 * hard-to-diagnose secret-scanning coverage gap. Both --config and
 * --secret-config are resolved via this extension's own __dirname.
 *
 * REAL-VERIFIED (trivy v0.72.0, Batch F.2): the exact CLI invocation and the
 * JSON parser were run against the installed binary. Flags used:
 *   trivy fs --config <trivy.yaml> --secret-config <trivy-secret.yaml>
 *            --format json <target>
 * CONFIG FIX: trivy-secret.yaml originally carried an invalid
 * `enable-builtin-rules: true` field, which is NOT part of trivy 0.72.0's
 * secret-config schema and caused a FATAL "cannot unmarshal !!bool `true` into
 * []string" — a total scan failure. Removing it (builtin secret detectors are
 * on by default) makes real trivy 0.72.0 exit rc=0 with a clean JSON scan
 * (verified: rc=1 FATAL before the fix vs. rc=0 clean after). The parser
 * (Results[].Vulnerabilities/Misconfigurations/Secrets) is verified correct
 * against the real output shape.
 *
 * EXIT-CODE CONVENTION: trivy returns the value of `--exit-code` (which our
 * trivy.yaml pins to 0) when security issues are found, so a successful scan —
 * findings OR clean — exits 0 and is handled by the success path (REAL-VERIFIED:
 * a clean scan exits 0). Operational errors exit non-zero (documented as 1).
 * Therefore any non-zero status reaching the catch block is a REAL failure, not
 * findings. This replaces the looser generic `if (err.stdout)` truthy heuristic
 * inherited from the semgrep reference (see classifyTrivyExit), mirroring
 * gitleaks' tool-specific err.status handling.
 *
 * Edge case (documented): we trust PATH resolution of the `trivy` binary.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createLogger } from "../../lib/logger/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);

const TOOL_NAME = "trivy";
const BINARY = "trivy";
const PINNED_VERSION = "v0.72.0";
const CONFIG_PATH = join(__dir, "trivy.yaml");
const SECRET_CONFIG_PATH = join(__dir, "trivy-secret.yaml");

const DEFAULT_TIMEOUT = 180000; // 3 minutes (DB pulls can be slow)
const MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_CHARS = 50000;

const INSTALL_HINT =
  "Install trivy (pinned " +
  PINNED_VERSION +
  "):\n  brew install trivy\n  See https://trivy.dev/latest/getting-started/installation/";

/**
 * Build the trivy CLI arg vector (array-form ONLY — never a shell string, to
 * avoid command injection). The secret ruleset is passed as an EXPLICIT
 * absolute --secret-config path so it is resolved deterministically regardless
 * of the runtime cwd (Phase 6b fix). Exported for unit testing.
 */
export function buildTrivyArgs(target: string): string[] {
  return [
    "fs",
    "--config",
    CONFIG_PATH,
    "--secret-config",
    SECRET_CONFIG_PATH,
    "--format",
    "json",
    target,
  ];
}

/**
 * Classify a caught trivy exit status. Under our pinned `exit-code: 0`, a
 * successful scan (findings or clean) exits 0 (handled by the success path);
 * any non-zero exit reaching the catch block is a real operational error.
 * REAL-VERIFIED against trivy 0.72.0 (a clean scan exits 0). Exported for
 * unit testing.
 */
export function classifyTrivyExit(status: number | null | undefined): "findings" | "error" {
  return status === 0 ? "findings" : "error";
}

/**
 * Shape of the error thrown by `execFileSync` on a non-zero exit. With
 * `encoding: "utf-8"`, `stdout`/`stderr` are strings. All fields are optional
 * because the thrown value is only structurally typed at the catch site.
 */
interface ExecFileError {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  message?: string;
}

/** Narrow an unknown caught value to the fields we read off an exec error. */
function asExecFileError(err: unknown): ExecFileError {
  return typeof err === "object" && err !== null ? (err as ExecFileError) : {};
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
    let total = 0;
    for (const res of data.Results || []) {
      total += (res.Vulnerabilities || []).length;
      total += (res.Misconfigurations || []).length;
      total += (res.Secrets || []).length;
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

export default function trivyExtension(pi: ExtensionAPI) {
  const logger = createLogger(TOOL_NAME);
  const version = detectVersion();
  const installed = version !== null;

  pi.registerTool({
    name: "trivy_scan",
    label: "Trivy Scan",
    description: [
      "Scan a filesystem path for vulnerabilities, misconfigurations, and secrets.",
      `trivy ${installed ? `v-detected: ${version}` : `NOT INSTALLED — pinned ${PINNED_VERSION}`}.`,
      "Uses bundled trivy.yaml (+ trivy-secret.yaml). Returns normalized JSON findings.",
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
      // Includes an explicit absolute --secret-config path (Phase 6b fix).
      const args = buildTrivyArgs(target);

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
        const execErr = asExecFileError(err);
        // Tool-specific exit-code handling (Phase 6b): under our pinned
        // `exit-code: 0`, trivy signals findings via exit 0 (the success path
        // above). The only way to reach here with a "findings" classification
        // is a runtime override setting --exit-code to 0, which cannot produce
        // a non-zero status — so in practice any caught status is an error. We
        // still branch defensively to keep the convention explicit and salvage
        // parseable findings if a future config change makes 0 reachable here.
        if (classifyTrivyExit(execErr.status) === "findings" && execErr.stdout) {
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
                    note: "trivy exited with the configured findings code (normal)",
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
                  error: "trivy execution failed",
                  stderr: truncateOutput(execErr.stderr || execErr.message || "Unknown error"),
                  hint: "Check that the target path exists and trivy is functional.",
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

  if (installed) logger.info("trivy detected", { version });
  else logger.warn("trivy NOT installed — tool will return install instructions");
}
