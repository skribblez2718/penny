/**
 * jsluice Extension — URL and secret extraction from JavaScript
 *
 * Provides jsluice_urls and jsluice_secrets tools.
 * Requires jsluice CLI installed (go install github.com/BishopFox/jsluice/cmd/jsluice@latest).
 *
 * jsluice outputs JSONL (one JSON object per line).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createLogger } from "../../lib/logger/logger.js";

// ── Check if jsluice is installed ──

function findJsluicePath(): string {
  // Check common locations
  const paths = [
    `${process.env.HOME}/go/bin/jsluice`,
    "/usr/local/bin/jsluice",
    "/usr/bin/jsluice",
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  // Fall back to PATH
  return "jsluice";
}

let jsluicePath: string | null = null;

function isJsluiceInstalled(): boolean {
  if (!jsluicePath) jsluicePath = findJsluicePath();
  // Only check binary existence — avoid invoking --help which prints to stderr.
  // The execFileSync in tool handlers will surface any runtime failures.
  // `jsluicePath` is narrowed to `string` by the assignment above.
  return existsSync(jsluicePath);
}

// ── Constants ──

const DEFAULT_TIMEOUT = 30000; // 30 seconds
const INSTALL_INSTRUCTIONS =
  'jsluice is not installed.\n\nInstall with:\n  go install github.com/BishopFox/jsluice/cmd/jsluice@latest\n  export PATH="$PATH:$(go env GOPATH)/bin"\n\nRequires Go 1.21+.';

// ── jsluice output shapes ──

/** A single URL record emitted by `jsluice urls` (one JSON object per line). */
interface JsluiceUrl {
  url?: string;
  queryParams?: string[];
  bodyParams?: string[];
  method?: string;
  type?: string;
  filename?: string;
}

/** A single secret record emitted by `jsluice secrets` (one JSON object per line). */
interface JsluiceSecret {
  kind?: string;
  data?: { key?: string } & Record<string, unknown>;
  filename?: string;
  severity?: string;
  context?: unknown;
}

/** Sentinel returned by {@link parseJsonl} for a line that failed to parse. */
interface ParseError {
  parse_error: true;
  raw: string;
}

function isParseError(record: unknown): record is ParseError {
  return (
    typeof record === "object" &&
    record !== null &&
    (record as { parse_error?: unknown }).parse_error === true
  );
}

// ── Helpers ──

function parseJsonl<T>(output: string): (T | ParseError)[] {
  return output
    .trim()
    .split("\n")
    .filter((line) => line.trim())
    .map((line): T | ParseError => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return { parse_error: true, raw: line.slice(0, 200) };
      }
    });
}

/** Extract a short, printable error message from an unknown thrown value. */
function errorText(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const e = err as { stderr?: unknown; message?: unknown };
    const source = e.stderr ?? e.message ?? "";
    // `execFileSync` is called with `encoding: "utf-8"`, so `stderr` is a
    // string; fall back to `String(...)` for any other thrown shape.
    const text = typeof source === "string" ? source : String(source);
    return text.slice(0, 500);
  }
  return "";
}

// ── Extension ──

export default function jsluiceExtension(pi: ExtensionAPI) {
  const installed = isJsluiceInstalled();

  // ── jsluice_urls ──

  pi.registerTool({
    name: "jsluice_urls",
    label: "jsluice URLs",
    description: [
      "Extract URLs, paths, and endpoints from JavaScript files using jsluice.",
      "Returns JSONL: each line is a JSON object with url, queryParams, bodyParams, method, type, filename.",
      `jsluice ${installed ? `detected at ${jsluicePath}` : "NOT INSTALLED"}.`,
      "Feed output from stdin or pass file paths as arguments.",
    ].join(" "),
    parameters: Type.Object({
      target: Type.String({ description: "JavaScript file path or '-' for stdin" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 30000)" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      if (!installed) {
        return { content: [{ type: "text", text: INSTALL_INSTRUCTIONS }] };
      }

      if (!jsluicePath) {
        return { content: [{ type: "text", text: INSTALL_INSTRUCTIONS }] };
      }

      try {
        const args = ["urls", "--concurrency", "1", params.target];
        const result = execFileSync(jsluicePath, args, {
          encoding: "utf-8",
          timeout: params.timeout || DEFAULT_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
        });

        const parsed = parseJsonl<JsluiceUrl>(result);
        const urls = parsed.filter((r): r is JsluiceUrl => !isParseError(r));
        const endpoints = [...new Set(urls.map((u) => u.url).filter(Boolean))];

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  target: params.target,
                  total_urls: urls.length,
                  unique_endpoints: endpoints.length,
                  endpoints: endpoints.slice(0, 200), // cap at 200
                  raw_count: urls.length,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: "jsluice urls failed",
                  stderr: errorText(err),
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

  // ── jsluice_secrets ──

  pi.registerTool({
    name: "jsluice_secrets",
    label: "jsluice Secrets",
    description: [
      "Extract secrets, API keys, tokens, and credentials from JavaScript files using jsluice.",
      "Detects: AWS keys, GCP keys, GitHub tokens, Stripe keys, JWT secrets, generic high-entropy strings.",
      "Returns JSONL with kind, data, filename, severity, and context.",
      `jsluice ${installed ? `detected at ${jsluicePath}` : "NOT INSTALLED"}.`,
    ].join(" "),
    parameters: Type.Object({
      target: Type.String({ description: "JavaScript file path or '-' for stdin" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 30000)" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      if (!installed) {
        return { content: [{ type: "text", text: INSTALL_INSTRUCTIONS }] };
      }

      if (!jsluicePath) {
        return { content: [{ type: "text", text: INSTALL_INSTRUCTIONS }] };
      }

      try {
        const args = ["secrets", "--concurrency", "1", params.target];
        const result = execFileSync(jsluicePath, args, {
          encoding: "utf-8",
          timeout: params.timeout || DEFAULT_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
        });

        const parsed = parseJsonl<JsluiceSecret>(result);
        const secrets = parsed.filter((r): r is JsluiceSecret => !isParseError(r));

        const byKind: Record<string, number> = {};
        for (const s of secrets) {
          const kind = s.kind ?? "unknown";
          byKind[kind] = (byKind[kind] || 0) + 1;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  target: params.target,
                  total_secrets: secrets.length,
                  by_kind: byKind,
                  secrets: secrets.map((s) => ({
                    kind: s.kind,
                    severity: s.severity || "low",
                    filename: s.filename,
                    // Redact the actual key — show only first 4 + last 4 chars
                    key_preview:
                      typeof s.data?.key === "string"
                        ? s.data.key.slice(0, 4) + "..." + s.data.key.slice(-4)
                        : "(redacted)",
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: "jsluice secrets failed",
                  stderr: errorText(err),
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

  const logger = createLogger("jsluice");
  if (installed) {
    logger.info("jsluice detected", { path: jsluicePath });
  } else {
    logger.warn("jsluice NOT installed — tools will return install instructions");
  }
}
