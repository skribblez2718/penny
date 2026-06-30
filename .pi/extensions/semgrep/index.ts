/**
 * Semgrep Extension — SAST scanner for JavaScript security analysis
 *
 * Provides semgrep_scan and semgrep_list_rules tools.
 * Requires semgrep CLI installed (pip install semgrep).
 *
 * Latest version as of 2026-05: 1.165.0
 * Install: pip install semgrep  OR  brew install semgrep  OR  uv tool install semgrep
 *
 * Registry rulesets used by jsa:
 *   p/javascript, p/typescript, p/xss, p/owasp-top-ten, p/cwe-top-25, p/secrets, p/security-audit
 */

import { execSync, execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createLogger } from "../../lib/logger/logger.js";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
import { writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ── Check if semgrep is installed ──

function findSemgrepPath(): string | null {
  // 1. Check project venv first (our convention)
  const venvPath = join(process.cwd(), ".venv", "bin", "semgrep");
  if (existsSync(venvPath)) return venvPath;

  // 2. Check VIRTUAL_ENV if set
  const virtualEnv = process.env.VIRTUAL_ENV;
  if (virtualEnv) {
    const envPath = join(virtualEnv, "bin", "semgrep");
    if (existsSync(envPath)) return envPath;
  }

  // 3. Check the parent project's venv (when this extension is loaded
  //    from a different cwd, e.g. a skill tool running with a user-supplied
  //    project_root as cwd — the actual Python venv is still in the
  //    parent project's .venv). The PENNY_PROJECT_ROOT env var, when set,
  //    points to the parent project; otherwise we fall back to the
  //    conventional location one level up from the current cwd.
  const projectRoot =
    process.env.PENNY_PROJECT_ROOT ||
    process.env.PI_PROJECT_ROOT ||
    join(process.cwd(), "..");
  const parentVenvPath = join(projectRoot, ".venv", "bin", "semgrep");
  if (existsSync(parentVenvPath)) return parentVenvPath;

  // 4. Walk up the cwd tree looking for a .venv/bin/semgrep. This handles
  //    edge cases where the cwd is several levels deep relative to the
  //    project root.
  let cursor = process.cwd();
  for (let i = 0; i < 6; i++) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    const candidate = join(parent, ".venv", "bin", "semgrep");
    if (existsSync(candidate)) return candidate;
    cursor = parent;
  }

  // 5. Fall back to PATH (will only work if semgrep is globally installed)
  return "semgrep";
}

let semgrepPath: string | null = null;
let semgrepUpdateAvailable = false;

function getSemgrepVersion(): string | null {
  if (!semgrepPath) semgrepPath = findSemgrepPath();
  try {
    // Use spawnSync so we can capture stderr separately and SILENCE it.
    // semgrep prints "A new version of Semgrep is available…" to stderr on
    // every --version call; we must not leak that to the user's TTY on load.
    // findSemgrepPath() is called above and always returns a non-null string
    // (it falls back to "semgrep" on PATH), so the assertion is safe here.
    const r = spawnSync(semgrepPath!, ["--version"], {
      encoding: "utf-8",
      timeout: 10000,
      // ignore stdin, pipe+collect stdout, pipe+collect stderr (then discard)
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.error || r.status !== 0) {
      semgrepPath = null;
      return null;
    }
    if (r.stderr && /new version of Semgrep is available/i.test(r.stderr)) {
      semgrepUpdateAvailable = true;
    }
    return (r.stdout ?? "").trim();
  } catch {
    semgrepPath = null;
    return null;
  }
}

/**
 * Query PyPI for the latest semgrep version. Returns null on any failure
 * (no network, rate limit, parse error) — we never block startup on this.
 */
function getLatestSemgrepVersion(): string | null {
  try {
    const r = spawnSync("curl", [
      "-sS",
      "--max-time",
      "5",
      "https://pypi.org/pypi/semgrep/json",
    ], { encoding: "utf-8", timeout: 6000, stdio: ["ignore", "pipe", "ignore"] });
    if (r.error || r.status !== 0 || !r.stdout) return null;
    const match = r.stdout.match(/"version"\s*:\s*"([^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function isSemgrepInstalled(): boolean {
  return getSemgrepVersion() !== null;
}

// ── Known registry rulesets ──

const REGISTRY_RULESETS: Record<string, { description: string; category: string }> = {
  "p/javascript":     { description: "JavaScript security rules (~200+ rules)", category: "language" },
  "p/typescript":     { description: "TypeScript security rules (74 rules)", category: "language" },
  "p/xss":            { description: "Cross-Site Scripting detection (~50+ rules)", category: "vuln_class" },
  "p/owasp-top-ten":  { description: "OWASP Top 10 vulnerability patterns (~200+ rules)", category: "framework" },
  "p/cwe-top-25":     { description: "CWE Top 25 most dangerous software errors (~200+ rules)", category: "framework" },
  "p/secrets":        { description: "Secret and credential detection (51 rules)", category: "vuln_class" },
  "p/security-audit": { description: "General security audit patterns (~200+ rules)", category: "framework" },
  "p/sql-injection":  { description: "SQL injection detection patterns", category: "vuln_class" },
  "p/r2c-security-audit": { description: "R2C security audit rules", category: "framework" },
  "p/command-injection":  { description: "Command injection detection", category: "vuln_class" },
  "p/jwt":            { description: "JWT security rules", category: "vuln_class" },
  "p/dockerfile":     { description: "Dockerfile security rules", category: "language" },
  "p/terraform":      { description: "Terraform security rules", category: "language" },
};

// ── Local rule directories (bundled with extension) ──

const RULES_DIR = join(__dir, "rules");

const LOCAL_RULESETS: Record<string, { description: string; path: string }> = {
  "js-browser":      { description: "Browser security: DOM XSS, eval, innerHTML, postMessage", path: "javascript-browser/security" },
  "js-express":      { description: "Express.js: auth, CORS, JWT, templates, data exfil", path: "javascript-express/security" },
  "js-react":        { description: "React: dangerouslySetInnerHTML, href, hooks", path: "javascript-react" },
  "js-vue":          { description: "Vue.js: v-html, XSS templates", path: "javascript-vue/security" },
  "js-angular":      { description: "Angular: bypassSecurity, innerHTML, sanitizer", path: "javascript-angular/security" },
  "js-jquery":       { description: "jQuery: html(), globalEval, unsafe selectors", path: "javascript-jquery/security" },
  "js-lang":         { description: "JavaScript language: eval, proto pollution, crypto", path: "javascript-lang/security" },
  "js-audit":        { description: "JavaScript audit: dangerous patterns, injections", path: "javascript-audit" },
  "ts-react":        { description: "TypeScript React: dangerouslySetInnerHTML, JWT, href", path: "typescript-react/security" },
  "ts-angular":      { description: "TypeScript Angular: bypassSecurity, innerHTML", path: "typescript-angular/security" },
  "ts-lang":         { description: "TypeScript language: eval, secrets, prototype", path: "typescript-lang/security" },
  "html-security":   { description: "HTML: plaintext HTTP links, insecure patterns", path: "html/security" },
  "html-templates":  { description: "HTML templates: template injection patterns", path: "generic-html-templates/security" },
  "generic-secrets": { description: "Generic secrets: API keys, tokens, passwords (225 rules)", path: "generic-secrets" },
};

// ── JSA Preset: combines registry + local rules for comprehensive JS security scanning ──

const JSA_PRESET_CONFIGS = [
  // Registry rulesets
  "p/javascript", "p/typescript", "p/xss", "p/owasp-top-ten", "p/cwe-top-25",
  "p/secrets", "p/security-audit", "p/sql-injection", "p/command-injection", "p/jwt",
  // Local rules
  "js-browser", "js-express", "js-react", "js-vue", "js-angular", "js-jquery",
  "js-lang", "js-audit", "ts-react", "ts-angular", "ts-lang", "html-security",
  "html-templates", "generic-secrets",
];

// ── Constants ──

const DEFAULT_TIMEOUT = 120000; // 2 minutes
const MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_CHARS = 50000;

// ── Helpers ──

function countRulesInDir(dir: string): number {
  try {
    const result = execSync(`find ${dir} -name '*.yaml' -o -name '*.yml' | wc -l`, { encoding: "utf-8" });
    return parseInt(result.trim()) || 0;
  } catch {
    return 0;
  }
}

function truncateOutput(text: string): string {
  const lines = text.split("\n");
  const truncated = lines.slice(0, MAX_OUTPUT_LINES);
  let result = truncated.join("\n");
  if (lines.length > MAX_OUTPUT_LINES) {
    result += `\n\n[Truncated — ${lines.length - MAX_OUTPUT_LINES} more lines]`;
  }
  if (result.length > MAX_OUTPUT_CHARS) {
    result = result.slice(0, MAX_OUTPUT_CHARS) + `\n\n[Truncated — output exceeded ${MAX_OUTPUT_CHARS} chars]`;
  }
  return result;
}

function countFindings(jsonOutput: string): { total: number; by_severity: Record<string, number> } {
  try {
    const data = JSON.parse(jsonOutput);
    const results = data.results || [];
    const by_severity: Record<string, number> = {};
    for (const r of results) {
      const sev = (r.extra?.severity || "INFO").toUpperCase();
      by_severity[sev] = (by_severity[sev] || 0) + 1;
    }
    return { total: results.length, by_severity };
  } catch {
    return { total: 0, by_severity: {} };
  }
}

// ── Extension ──

export default function semgrepExtension(pi: ExtensionAPI) {
  const version = getSemgrepVersion();
  const installed = version !== null;

  // ── semgrep_scan ──

  pi.registerTool({
    name: "semgrep_scan",
    label: "Semgrep Scan",
    description: [
      "Run semgrep SAST scan against a file or directory. Supports registry rulesets (p/javascript), local rule sets (js-browser, js-react), and the jsa preset (all JS/TS/HTML rules).",
      `Semgrep ${installed ? `v${version} at ${semgrepPath}` : "NOT INSTALLED — run: uv pip install semgrep"}.`,
      `Local rules (${Object.keys(LOCAL_RULESETS).length} sets): ${Object.keys(LOCAL_RULESETS).join(", ")}.`,
      "Use config: 'jsa' for comprehensive JS/TS security scanning (10 registry + 14 local rule sets).",
      "Returns JSON findings with rule ID, severity, line number, message, and code snippet.",
      "Use --config=auto for automatic ruleset detection based on project language.",
    ].join(" "),
    parameters: Type.Object({
      target: Type.String({ description: "File or directory path to scan" }),
      config: Type.String({
        description: "Ruleset ID (p/javascript) or comma-separated list (p/xss,p/javascript) or path to custom rule YAML",
      }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 120000)" })),
      json_only: Type.Optional(Type.Boolean({ description: "Return only JSON findings summary (default true)", default: true })),
      include_findings: Type.Optional(Type.Boolean({ description: "Include individual finding details in output (default false)", default: false })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      if (!installed) {
        return {
          content: [{
            type: "text",
            text: "semgrep is not installed.\n\nInstall into project venv:\n  uv pip install semgrep\n\nOr globally:\n  uv tool install semgrep\n  brew install semgrep\n\nRequires Python 3.10+.",
          }],
        };
      }

      const target = params.target;
      const configs: string[] = [];
      for (const c of params.config.split(",").map((s: string) => s.trim())) {
        if (c === "jsa") {
          // Expand jsa preset to all its configs
          for (const presetConfig of JSA_PRESET_CONFIGS) {
            if (LOCAL_RULESETS[presetConfig]) {
              configs.push(join(RULES_DIR, LOCAL_RULESETS[presetConfig].path));
            } else {
              configs.push(presetConfig);
            }
          }
        } else if (LOCAL_RULESETS[c]) {
          // Local rule set
          configs.push(join(RULES_DIR, LOCAL_RULESETS[c].path));
        } else {
          // Registry ruleset
          configs.push(c);
        }
      }
      const timeout = params.timeout || DEFAULT_TIMEOUT;

      // Build semgrep command
      const args: string[] = ["scan", "--json", "--no-git-ignore"];
      for (const c of configs) {
        args.push("--config", c);
      }
      args.push(target);

      try {
        // stdio: pipe stdin/stdout/stderr so the upgrade nag and any other
        // stderr noise does not leak to the user's TTY during a scan.
        const result = execFileSync(semgrepPath || "semgrep", args, {
          encoding: "utf-8",
          timeout,
          maxBuffer: 50 * 1024 * 1024, // 50MB
          stdio: ["pipe", "pipe", "pipe"],
        });

        const counts = countFindings(result);

        let output = "";
        if (params.json_only && !params.include_findings) {
          output = JSON.stringify({
            success: true,
            target,
            configs,
            total_findings: counts.total,
            by_severity: counts.by_severity,
            semgrep_version: version,
          }, null, 2);
        } else if (params.include_findings) {
          const data = JSON.parse(result);
          output = JSON.stringify({
            success: true,
            target,
            configs,
            total_findings: counts.total,
            by_severity: counts.by_severity,
            findings: (data.results || []).map((r: any) => ({
              check_id: r.check_id,
              severity: r.extra?.severity || "INFO",
              path: r.path,
              start: { line: r.start?.line, col: r.start?.col },
              end: { line: r.end?.line, col: r.end?.col },
              message: r.extra?.message || "",
              lines: r.extra?.lines || "",
              metadata: r.extra?.metadata || {},
            })),
            semgrep_version: version,
          }, null, 2);
        } else {
          output = JSON.stringify({ success: true, target, configs, raw_output: truncateOutput(result) }, null, 2);
        }

        return { content: [{ type: "text", text: output }] };
      } catch (err: any) {
        // semgrep exits with non-zero when findings are found — that's expected
        if (err.stdout) {
          const counts = countFindings(err.stdout);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                target,
                configs,
                total_findings: counts.total,
                by_severity: counts.by_severity,
                note: "semgrep exited non-zero (findings found — this is normal)",
                semgrep_version: version,
              }, null, 2),
            }],
          };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "semgrep execution failed",
              stderr: truncateOutput(err.stderr || err.message || "Unknown error"),
              hint: "Check that semgrep is installed and the target path exists.",
            }, null, 2),
          }],
        };
      }
    },
  });

  // ── semgrep_list_rules ──

  pi.registerTool({
    name: "semgrep_list_rules",
    label: "Semgrep List Rules",
        description: "List available semgrep rulesets: registry (p/*) and local (js-*, ts-*, html-*). Includes the jsa preset.",
    parameters: Type.Object({
      category: Type.Optional(Type.String({ description: "Filter by category: language, vuln_class, framework" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      const regEntries = Object.entries(REGISTRY_RULESETS)
        .filter(([_, info]) => !params.category || info.category === params.category)
        .map(([id, info]) => `  ${id.padEnd(22)} ${info.description.padEnd(50)} [registry:${info.category}]`);

      const locEntries = Object.entries(LOCAL_RULESETS)
        .map(([id, info]) => `  ${id.padEnd(22)} ${info.description.padEnd(50)} [local]`);

      let output = `semgrep ${version || "NOT INSTALLED"}\n\n`;
      output += `=== Registry Rulesets (${regEntries.length}) ===\n\n`;
      output += regEntries.join("\n");
      output += `\n\n=== Local Rule Sets (${locEntries.length}, ${Object.values(LOCAL_RULESETS).reduce((sum, lr) => sum + countRulesInDir(join(RULES_DIR, lr.path)), 0)} YAML rules) ===\n\n`;
      output += locEntries.join("\n");
      output += `\n\n=== jsa Preset ===`;
      output += `\n  Combines 10 registry + 14 local rule sets for comprehensive JS/TS security analysis.`;
      output += `\n  Usage: semgrep_scan({ target: "<file>", config: "jsa" })`;
      output += `\n\nTotal: ${regEntries.length + locEntries.length} rulesets + 1 preset.`;

      return { content: [{ type: "text", text: output }] };
    },
  });

  const logger = createLogger("semgrep");
  if (installed) {
    logger.info("semgrep detected", { version });
    // If semgrep itself told us a new version is available (stderr nag we now
    // suppress), resolve the latest from PyPI and surface a single upgrade
    // hint via the extension logger. Auto-upgrade is intentionally NOT done
    // here — it would mutate the user's environment without consent.
    if (semgrepUpdateAvailable) {
      const latest = getLatestSemgrepVersion();
      if (latest && latest !== version) {
        logger.warn(
          `semgrep ${version} is outdated — latest is ${latest}. ` +
            `Upgrade with: uv pip install --upgrade semgrep`,
        );
      }
    }
  } else {
    logger.warn("semgrep NOT installed — tools will return install instructions");
  }
}
