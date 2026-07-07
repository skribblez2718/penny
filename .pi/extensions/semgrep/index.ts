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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ── Semgrep JSON output shape (subset we consume) ──

interface SemgrepFinding {
  check_id?: string;
  path?: string;
  start?: { line?: number; col?: number };
  end?: { line?: number; col?: number };
  extra?: {
    severity?: string;
    message?: string;
    lines?: string;
    metadata?: Record<string, unknown>;
  };
}

interface SemgrepOutput {
  results?: SemgrepFinding[];
}

/** Node's execFileSync throws an Error augmented with captured stdio. */
interface ExecErrorFields {
  stdout?: string;
  stderr?: string;
  message?: string;
}

function readExecError(err: unknown): ExecErrorFields {
  if (err && typeof err === "object") {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : undefined,
      stderr: typeof e.stderr === "string" ? e.stderr : undefined,
      message: typeof e.message === "string" ? e.message : undefined,
    };
  }
  return {};
}

// ── Check if semgrep is installed ──

function findSemgrepPath(): string {
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
    process.env.PENNY_PROJECT_ROOT || process.env.PI_PROJECT_ROOT || join(process.cwd(), "..");
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
  const resolvedPath = semgrepPath;
  try {
    // Use spawnSync so we can capture stderr separately and SILENCE it.
    // semgrep prints "A new version of Semgrep is available…" to stderr on
    // every --version call; we must not leak that to the user's TTY on load.
    const r = spawnSync(resolvedPath, ["--version"], {
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
    const r = spawnSync("curl", ["-sS", "--max-time", "5", "https://pypi.org/pypi/semgrep/json"], {
      encoding: "utf-8",
      timeout: 6000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.error || r.status !== 0 || !r.stdout) return null;
    const match = r.stdout.match(/"version"\s*:\s*"([^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ── Known registry rulesets ──

const REGISTRY_RULESETS: Record<string, { description: string; category: string }> = {
  "p/javascript": { description: "JavaScript security rules (~200+ rules)", category: "language" },
  "p/typescript": { description: "TypeScript security rules (74 rules)", category: "language" },
  "p/xss": { description: "Cross-Site Scripting detection (~50+ rules)", category: "vuln_class" },
  "p/owasp-top-ten": {
    description: "OWASP Top 10 vulnerability patterns (~200+ rules)",
    category: "framework",
  },
  "p/cwe-top-25": {
    description: "CWE Top 25 most dangerous software errors (~200+ rules)",
    category: "framework",
  },
  "p/secrets": {
    description: "Secret and credential detection (51 rules)",
    category: "vuln_class",
  },
  "p/security-audit": {
    description: "General security audit patterns (~200+ rules)",
    category: "framework",
  },
  "p/sql-injection": { description: "SQL injection detection patterns", category: "vuln_class" },
  "p/r2c-security-audit": { description: "R2C security audit rules", category: "framework" },
  "p/command-injection": { description: "Command injection detection", category: "vuln_class" },
  "p/jwt": { description: "JWT security rules", category: "vuln_class" },
  "p/dockerfile": { description: "Dockerfile security rules", category: "language" },
  "p/terraform": { description: "Terraform security rules", category: "language" },
};

// ── Local rule directories (bundled with extension) ──

const RULES_DIR = join(__dir, "rules");

const LOCAL_RULESETS: Record<string, { description: string; path: string }> = {
  "js-browser": {
    description: "Browser security: DOM XSS, eval, innerHTML, postMessage",
    path: "javascript-browser/security",
  },
  "js-express": {
    description: "Express.js: auth, CORS, JWT, templates, data exfil",
    path: "javascript-express/security",
  },
  "js-react": {
    description: "React: dangerouslySetInnerHTML, href, hooks",
    path: "javascript-react",
  },
  "js-vue": { description: "Vue.js: v-html, XSS templates", path: "javascript-vue/security" },
  "js-angular": {
    description: "Angular: bypassSecurity, innerHTML, sanitizer",
    path: "javascript-angular/security",
  },
  "js-jquery": {
    description: "jQuery: html(), globalEval, unsafe selectors",
    path: "javascript-jquery/security",
  },
  "js-lang": {
    description: "JavaScript language: eval, proto pollution, crypto",
    path: "javascript-lang/security",
  },
  "js-audit": {
    description: "JavaScript audit: dangerous patterns, injections",
    path: "javascript-audit",
  },
  "ts-react": {
    description: "TypeScript React: dangerouslySetInnerHTML, JWT, href",
    path: "typescript-react/security",
  },
  "ts-angular": {
    description: "TypeScript Angular: bypassSecurity, innerHTML",
    path: "typescript-angular/security",
  },
  "ts-lang": {
    description: "TypeScript language: eval, secrets, prototype",
    path: "typescript-lang/security",
  },
  "html-security": {
    description: "HTML: plaintext HTTP links, insecure patterns",
    path: "html/security",
  },
  "html-templates": {
    description: "HTML templates: template injection patterns",
    path: "generic-html-templates/security",
  },
  "generic-secrets": {
    description: "Generic secrets: API keys, tokens, passwords (225 rules)",
    path: "generic-secrets",
  },
  // ── Vendored upstream rulesets (semgrep-rules, pinned commit — see rules/vendor/NOTICE) ──
  // Granularity choice: ONE ruleset entry per vendored library. This mirrors the
  // existing single-`path`-per-entry structure exactly (each maps to one directory
  // scanned recursively by semgrep), keeps the JWT libraries independently
  // selectable, and avoids inventing a multi-path grouping the expansion logic
  // doesn't otherwise support. The four JWT-related libraries are all present in
  // the sca preset below, so grouping buys nothing operationally.
  "vendor-jose": {
    description: "Vendored: jose JWT (none-alg, hardcoded key, exposed data)",
    path: "vendor/jose",
  },
  "vendor-jsonwebtoken": {
    description: "Vendored: jsonwebtoken (none-alg, hardcode, decode-without-verify)",
    path: "vendor/jsonwebtoken",
  },
  "vendor-jwt-simple": {
    description: "Vendored: jwt-simple (noVerify signature bypass)",
    path: "vendor/jwt-simple",
  },
  "vendor-passport-jwt": {
    description: "Vendored: passport-jwt (hardcoded secret)",
    path: "vendor/passport-jwt",
  },
  "vendor-sequelize": {
    description: "Vendored: Sequelize (raw-query SQLi, TLS misconfig)",
    path: "vendor/sequelize",
  },
  "vendor-serialize-javascript": {
    description: "Vendored: serialize-javascript (unsafe XSS serialization)",
    path: "vendor/serialize-javascript",
  },
  "vendor-shelljs": {
    description: "Vendored: shelljs (exec command injection)",
    path: "vendor/shelljs",
  },
  "vendor-node-crypto": {
    description: "Vendored: node crypto (missing IV, GCM tag length, AEAD final)",
    path: "vendor/node-crypto",
  },
  "vendor-vm2": {
    description: "Vendored: vm2 (sandbox code/context injection)",
    path: "vendor/vm2",
  },
  // ── Original custom Tier-2 rules authored for sca (not vendored) ──
  custom: {
    description:
      "Custom Tier-2 rules: IDOR (CWE-639), SSRF allowlist (CWE-918), JWT claims (CWE-347)",
    path: "custom",
  },
  // ── Self-improving SAST: rules authored by a skill's REFLECT/augment phase on
  //    prior runs (validated before persisting). Loaded ONLY when the dir exists
  //    — see the existsSync guard in the preset expansion. ──
  "learned-jsa": {
    description: "Learned rules authored by the jsa reflect phase (self-improving SAST)",
    path: "learned/jsa",
  },
  "learned-sca": {
    description: "Learned rules authored by the sca augment phase (self-improving SAST)",
    path: "learned/sca",
  },
};

// ── JSA Preset: combines registry + local rules for comprehensive JS security scanning ──

const JSA_PRESET_CONFIGS = [
  // Registry rulesets
  "p/javascript",
  "p/typescript",
  "p/xss",
  "p/owasp-top-ten",
  "p/cwe-top-25",
  "p/secrets",
  "p/security-audit",
  "p/sql-injection",
  "p/command-injection",
  "p/jwt",
  // Local rules
  "js-browser",
  "js-express",
  "js-react",
  "js-vue",
  "js-angular",
  "js-jquery",
  "js-lang",
  "js-audit",
  "ts-react",
  "ts-angular",
  "ts-lang",
  "html-security",
  "html-templates",
  "generic-secrets",
  // Self-improving SAST: reflect-authored rules from prior runs (loaded if present).
  "learned-jsa",
];

// ── SCA Preset: vendored library rules + original custom Tier-2 rules + a
//    sensible subset of the existing local rulesets. Referenced via config:'sca'
//    by later sca phases. Mirrors JSA_PRESET_CONFIGS structure/expansion exactly. ──

const SCA_PRESET_CONFIGS = [
  // Vendored upstream library rules (pinned to a real commit — see rules/vendor/NOTICE)
  "vendor-jose",
  "vendor-jsonwebtoken",
  "vendor-jwt-simple",
  "vendor-passport-jwt",
  "vendor-sequelize",
  "vendor-serialize-javascript",
  "vendor-shelljs",
  "vendor-node-crypto",
  "vendor-vm2",
  // Original custom Tier-2 rules (IDOR, SSRF-allowlist, JWT-claims)
  "custom",
  // Sensible subset of existing local rulesets
  "js-audit",
  "js-lang",
  "generic-secrets",
  // Self-improving SAST: augment-authored rules from prior runs (loaded if present).
  "learned-sca",
];

// ── Constants ──

const DEFAULT_TIMEOUT = 120000; // 2 minutes
const MAX_OUTPUT_LINES = 500;
const MAX_OUTPUT_CHARS = 50000;

// ── Helpers ──

function countRulesInDir(dir: string): number {
  // A local ruleset dir may not exist yet (e.g. an empty learned/<skill> before
  // its first rule) — return 0 without spawning find (avoids stderr noise).
  if (!existsSync(dir)) return 0;
  try {
    const result = execSync(`find ${dir} -name '*.yaml' -o -name '*.yml' | wc -l`, {
      encoding: "utf-8",
    });
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
    result =
      result.slice(0, MAX_OUTPUT_CHARS) +
      `\n\n[Truncated — output exceeded ${MAX_OUTPUT_CHARS} chars]`;
  }
  return result;
}

function countFindings(jsonOutput: string): { total: number; by_severity: Record<string, number> } {
  try {
    const data = JSON.parse(jsonOutput) as SemgrepOutput;
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
      "Use config: 'sca' for software-composition security scanning (9 vendored library rule sets + 3 custom Tier-2 rules + js-audit, js-lang, generic-secrets).",
      "Returns JSON findings with rule ID, severity, line number, message, and code snippet.",
      "Use --config=auto for automatic ruleset detection based on project language.",
    ].join(" "),
    parameters: Type.Object({
      target: Type.String({ description: "File or directory path to scan" }),
      config: Type.String({
        description:
          "Ruleset ID (p/javascript) or comma-separated list (p/xss,p/javascript) or path to custom rule YAML",
      }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default 120000)" })),
      json_only: Type.Optional(
        Type.Boolean({
          description: "Return only JSON findings summary (default true)",
          default: true,
        })
      ),
      include_findings: Type.Optional(
        Type.Boolean({
          description: "Include individual finding details in output (default false)",
          default: false,
        })
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      if (!installed) {
        return {
          content: [
            {
              type: "text",
              text: "semgrep is not installed.\n\nInstall into project venv:\n  uv pip install semgrep\n\nOr globally:\n  uv tool install semgrep\n  brew install semgrep\n\nRequires Python 3.10+.",
            },
          ],
        };
      }

      const target = params.target;
      const configs: string[] = [];
      for (const c of params.config.split(",").map((s: string) => s.trim())) {
        if (c === "jsa") {
          // Expand jsa preset to all its configs
          for (const presetConfig of JSA_PRESET_CONFIGS) {
            if (LOCAL_RULESETS[presetConfig]) {
              // Skip a local ruleset dir that doesn't exist yet (e.g. an empty
              // learned/<skill> before its first rule) so semgrep never errors on it.
              const localPath = join(RULES_DIR, LOCAL_RULESETS[presetConfig].path);
              if (existsSync(localPath)) configs.push(localPath);
            } else {
              configs.push(presetConfig);
            }
          }
        } else if (c === "sca") {
          // Expand sca preset to all its configs (mirrors the jsa expansion)
          for (const presetConfig of SCA_PRESET_CONFIGS) {
            if (LOCAL_RULESETS[presetConfig]) {
              // Skip a local ruleset dir that doesn't exist yet (e.g. an empty
              // learned/<skill> before its first rule) so semgrep never errors on it.
              const localPath = join(RULES_DIR, LOCAL_RULESETS[presetConfig].path);
              if (existsSync(localPath)) configs.push(localPath);
            } else {
              configs.push(presetConfig);
            }
          }
        } else if (LOCAL_RULESETS[c]) {
          // Local rule set (skip if its dir doesn't exist yet — e.g. empty learned/*)
          const localPath = join(RULES_DIR, LOCAL_RULESETS[c].path);
          if (existsSync(localPath)) configs.push(localPath);
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
          output = JSON.stringify(
            {
              success: true,
              target,
              configs,
              total_findings: counts.total,
              by_severity: counts.by_severity,
              semgrep_version: version,
            },
            null,
            2
          );
        } else if (params.include_findings) {
          const data = JSON.parse(result) as SemgrepOutput;
          output = JSON.stringify(
            {
              success: true,
              target,
              configs,
              total_findings: counts.total,
              by_severity: counts.by_severity,
              findings: (data.results || []).map((r: SemgrepFinding) => ({
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
            },
            null,
            2
          );
        } else {
          output = JSON.stringify(
            { success: true, target, configs, raw_output: truncateOutput(result) },
            null,
            2
          );
        }

        return { content: [{ type: "text", text: output }] };
      } catch (err: unknown) {
        // semgrep exits with non-zero when findings are found — that's expected
        const execErr = readExecError(err);
        if (execErr.stdout) {
          const counts = countFindings(execErr.stdout);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                    target,
                    configs,
                    total_findings: counts.total,
                    by_severity: counts.by_severity,
                    note: "semgrep exited non-zero (findings found — this is normal)",
                    semgrep_version: version,
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
              type: "text",
              text: JSON.stringify(
                {
                  success: false,
                  error: "semgrep execution failed",
                  stderr: truncateOutput(execErr.stderr || execErr.message || "Unknown error"),
                  hint: "Check that semgrep is installed and the target path exists.",
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

  // ── semgrep_list_rules ──

  pi.registerTool({
    name: "semgrep_list_rules",
    label: "Semgrep List Rules",
    description:
      "List available semgrep rulesets: registry (p/*) and local (js-*, ts-*, html-*, vendor-*, custom). Includes the jsa and sca presets.",
    parameters: Type.Object({
      category: Type.Optional(
        Type.String({ description: "Filter by category: language, vuln_class, framework" })
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate) => {
      const regEntries = Object.entries(REGISTRY_RULESETS)
        .filter(([_, info]) => !params.category || info.category === params.category)
        .map(
          ([id, info]) =>
            `  ${id.padEnd(22)} ${info.description.padEnd(50)} [registry:${info.category}]`
        );

      const locEntries = Object.entries(LOCAL_RULESETS).map(
        ([id, info]) => `  ${id.padEnd(22)} ${info.description.padEnd(50)} [local]`
      );

      let output = `semgrep ${version || "NOT INSTALLED"}\n\n`;
      output += `=== Registry Rulesets (${regEntries.length}) ===\n\n`;
      output += regEntries.join("\n");
      output += `\n\n=== Local Rule Sets (${locEntries.length}, ${Object.values(LOCAL_RULESETS).reduce((sum, lr) => sum + countRulesInDir(join(RULES_DIR, lr.path)), 0)} YAML rules) ===\n\n`;
      output += locEntries.join("\n");
      output += `\n\n=== jsa Preset ===`;
      output += `\n  Combines 10 registry + 14 local rule sets for comprehensive JS/TS security analysis.`;
      output += `\n  Usage: semgrep_scan({ target: "<file>", config: "jsa" })`;
      output += `\n\n=== sca Preset ===`;
      output += `\n  Combines ${SCA_PRESET_CONFIGS.length} local rule sets: 9 vendored library rulesets (vendor-*), the custom Tier-2 rules (custom), and js-audit + js-lang + generic-secrets.`;
      output += `\n  Usage: semgrep_scan({ target: "<file>", config: "sca" })`;
      output += `\n\nTotal: ${regEntries.length + locEntries.length} rulesets + 2 presets.`;

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
            `Upgrade with: uv pip install --upgrade semgrep`
        );
      }
    }
  } else {
    logger.warn("semgrep NOT installed — tools will return install instructions");
  }
}
