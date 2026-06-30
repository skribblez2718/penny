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

function findJsluicePath(): string | null {
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
  return existsSync(jsluicePath!);
}

// ── Constants ──

const DEFAULT_TIMEOUT = 30000; // 30 seconds
const INSTALL_INSTRUCTIONS =
  "jsluice is not installed.\n\nInstall with:\n  go install github.com/BishopFox/jsluice/cmd/jsluice@latest\n  export PATH=\"$PATH:$(go env GOPATH)/bin\"\n\nRequires Go 1.21+.";

// ── Helpers ──

function parseJsonl(output: string): any[] {
  return output
    .trim()
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try { return JSON.parse(line); } catch { return { parse_error: true, raw: line.slice(0, 200) }; }
    });
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

      try {
        const args = ["urls", "--concurrency", "1", params.target];
        const result = execFileSync(jsluicePath!, args, {
          encoding: "utf-8",
          timeout: params.timeout || DEFAULT_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
        });

        const parsed = parseJsonl(result);
        const urls = parsed.filter((r) => !r.parse_error);
        const endpoints = [...new Set(urls.map((u: any) => u.url).filter(Boolean))];

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              target: params.target,
              total_urls: urls.length,
              unique_endpoints: endpoints.length,
              endpoints: endpoints.slice(0, 200), // cap at 200
              raw_count: urls.length,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "jsluice urls failed",
              stderr: (err.stderr || err.message || "").slice(0, 500),
            }, null, 2),
          }],
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

      try {
        const args = ["secrets", "--concurrency", "1", params.target];
        const result = execFileSync(jsluicePath!, args, {
          encoding: "utf-8",
          timeout: params.timeout || DEFAULT_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
        });

        const parsed = parseJsonl(result);
        const secrets = parsed.filter((r) => !r.parse_error);

        const byKind: Record<string, number> = {};
        for (const s of secrets) {
          byKind[s.kind] = (byKind[s.kind] || 0) + 1;
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              target: params.target,
              total_secrets: secrets.length,
              by_kind: byKind,
              secrets: secrets.map((s: any) => ({
                kind: s.kind,
                severity: s.severity || "low",
                filename: s.filename,
                // Redact the actual key — show only first 4 + last 4 chars
                key_preview: s.data?.key
                  ? s.data.key.slice(0, 4) + "..." + s.data.key.slice(-4)
                  : "(redacted)",
              })),
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "jsluice secrets failed",
              stderr: (err.stderr || err.message || "").slice(0, 500),
            }, null, 2),
          }],
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
