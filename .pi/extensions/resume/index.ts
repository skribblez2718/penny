/**
 * Resume Extension
 *
 * Tools for managing the canonical resume and accomplishments pool:
 *   - resume_export: Convert canonical resume markdown → .docx
 *   - resume_list_accomplishments: Query the 79-bullet STAR pool
 *   - resume_update_canonical: Add bullets to the canonical resume
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createLogger } from "../../lib/logger/logger.js";

const logger = createLogger("resume");

// ── Helpers ──────────────────────────────────────────────────────────────────

function resultText(obj: unknown) {
  return { content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

function getProjectRoot(): string {
  return process.env.PROJECT_ROOT || process.cwd();
}

function getVenvPython(): string {
  return (
    process.env.PI_VENV_PYTHON ||
    path.join(getProjectRoot(), ".venv", "bin", "python")
  );
}

// ── Canonical path resolvers ─────────────────────────────────────────────────

function canonicalResumePath(): string {
  const projectRoot = getProjectRoot();
  return path.join(projectRoot, ".pi", "skills", "rez", "resources", "resume.md");
}

function accomplishmentsPath(): string {
  const projectRoot = getProjectRoot();
  return path.join(projectRoot, ".pi", "skills", "rez", "resources", "accomplishments.md");
}

function exportScriptPath(): string {
  const projectRoot = getProjectRoot();
  return path.join(projectRoot, ".pi", "extensions", "resume", "export_resume.py");
}

// ── Accomplishments parser ───────────────────────────────────────────────────

interface AccomplishmentBullet {
  section: string;
  text: string;
  year: string;
}

/**
 * Parse accomplishments.md into structured sections and bullets.
 * The file is organized as:
 *   ## N. Section Name
 *   *bullet text* (YYYY)
 */
function parseAccomplishments(): { sections: string[]; bullets: AccomplishmentBullet[] } {
  const filePath = accomplishmentsPath();
  if (!fs.existsSync(filePath)) {
    return { sections: [], bullets: [] };
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  const bullets: AccomplishmentBullet[] = [];
  const sections: string[] = [];
  let currentSection = "";

  for (const line of lines) {
    // Section header: ## N. Section Name
    const sectionMatch = line.match(/^##\s+\d+\.\s+(.+)$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (!sections.includes(currentSection)) {
        sections.push(currentSection);
      }
      continue;
    }

    // Bullet: *text (YYYY)* — italic paragraphs with year suffix
    // Also match: *text (YYYY–YYYY)*, *text (YYYY, YYYY)*
    const bulletMatch = line.match(/^\*\s*(.+?)\s*\((\d{4}[^)]*)\)\*$/);
    if (bulletMatch && currentSection) {
      bullets.push({
        section: currentSection,
        text: bulletMatch[1].trim(),
        year: bulletMatch[2].trim(),
      });
    }
  }

  return { sections, bullets };
}

// ── Export ───────────────────────────────────────────────────────────────────

async function runExportScript(markdownPath: string, outputPath: string): Promise<string> {
  const python = getVenvPython();
  const script = exportScriptPath();

  return new Promise((resolve, reject) => {
    const proc = spawn(python, [script, markdownPath, outputPath], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim() || outputPath);
      } else {
        reject(new Error(stderr.trim() || `Export failed with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

// ── Registration ─────────────────────────────────────────────────────────────

export default function resumeExtension(pi: ExtensionAPI): void {
  // --- resume_export ---
  pi.registerTool({
    name: "resume_export",
    label: "Export Resume to .docx",
    description:
      "Convert the canonical markdown resume (or any markdown file) to a .docx file " +
      "using the project's word_doc_gen.py library. Outputs a professional .docx " +
      "suitable for job applications.",
    promptSnippet: "Export resume to .docx format",
    parameters: Type.Object({
      markdown_path: Type.Optional(
        Type.String({
          description:
            "Path to a markdown resume file. Defaults to the canonical resume at .pi/skills/rez/resources/resume.md",
        })
      ),
      output_path: Type.Optional(
        Type.String({
          description:
            "Desired output .docx path. Defaults to .pi/skills/rez/output/Kristoffer_Sketch_Resume.docx",
        })
      ),
    }),
    handler: async (params, _signal) => {
      const markdownPath = params.markdown_path || canonicalResumePath();
      const outputPath =
        params.output_path ||
        path.join(getProjectRoot(), ".pi", "skills", "resume", "output", "Kristoffer_Sketch_Resume.docx");

      if (!fs.existsSync(markdownPath)) {
        return errorResult(`Markdown file not found: ${markdownPath}`);
      }

      // Ensure output directory exists
      const outputDir = path.dirname(outputPath);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      try {
        const result = await runExportScript(markdownPath, outputPath);
        logger.info("Resume exported", { from: markdownPath, to: outputPath });
        return resultText({ exported: outputPath, detail: result });
      } catch (err: any) {
        logger.error("Export failed", { error: err.message });
        return errorResult(`Export failed: ${err.message}`);
      }
    },
  });

  // --- resume_list_accomplishments ---
  pi.registerTool({
    name: "resume_list_accomplishments",
    label: "List Resume Accomplishments",
    description:
      "Query the 79-bullet STAR accomplishments pool (sourced from 21 performance evaluations, 2019–2025). " +
      "Filter by section name or keyword search. Returns structured bullet data with traceable source sections.",
    promptSnippet: "List resume accomplishments from the STAR bullet pool",
    parameters: Type.Object({
      section: Type.Optional(
        Type.String({
          description:
            "Filter by section name. Partial match supported. " +
            "Sections: Penetration Testing, AI/ML Security, Tool Development, " +
            "Process Improvement, Mentorship, Cloud/Infrastructure, Red Team, Cross-Functional",
        })
      ),
      keyword: Type.Optional(
        Type.String({
          description:
            "Search bullet text for a keyword or phrase. Case-insensitive partial match.",
        })
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Max bullets to return (default: 20, max: 50)",
          minimum: 1,
          maximum: 50,
          default: 20,
        })
      ),
    }),
    handler: async (params, _signal) => {
      const { bullets, sections } = parseAccomplishments();

      if (bullets.length === 0) {
        return errorResult("No accomplishments found. Check that accomplishments.md exists.");
      }

      let filtered = bullets;

      if (params.section) {
        const sectionLower = params.section.toLowerCase();
        filtered = filtered.filter((b) => b.section.toLowerCase().includes(sectionLower));
      }

      if (params.keyword) {
        const keywordLower = params.keyword.toLowerCase();
        filtered = filtered.filter((b) => b.text.toLowerCase().includes(keywordLower));
      }

      const limit = params.limit ?? 20;
      const limited = filtered.slice(0, limit);

      return resultText({
        total: bullets.length,
        filtered: filtered.length,
        returned: limited.length,
        available_sections: sections,
        bullets: limited.map((b) => ({
          section: b.section,
          year: b.year,
          text: b.text,
        })),
      });
    },
  });

  // --- resume_update_canonical ---
  pi.registerTool({
    name: "resume_update_canonical",
    label: "Update Resume or Accomplishments",
    description:
      "Add or replace a bullet in the canonical markdown resume, or add a bullet " +
      "to the accomplishments pool. Used to keep both files in sync with new achievements. " +
      "Appends bullets to the specified role section (canonical) or competency section (accomplishments).",
    promptSnippet: "Update the canonical resume or accomplishments pool with new bullets",
    parameters: Type.Object({
      bullet: Type.String({
        description:
          "The new bullet text to add. Should be STAR format. Include year in parentheses at end: '(2025)'.",
      }),
      target: Type.Optional(
        Type.String({
          description:
            "Which file to update: 'canonical' (resources/resume.md) or 'accomplishments' (the STAR pool).",
          enum: ["canonical", "accomplishments"],
          default: "canonical",
        })
      ),
      role_section: Type.Optional(
        Type.String({
          description:
            "For canonical: which Professional Experience section. Default: 'Application Penetration Tester 4'. " +
            "For accomplishments: which competency section (e.g., 'AI/ML Security & Innovation').",
          default: "Application Penetration Tester 4",
        })
      ),
      action: Type.Optional(
        Type.String({
          description: "'append' to add to end, 'replace_last' to replace the last bullet",
          enum: ["append", "replace_last"],
          default: "append",
        })
      ),
    }),
    handler: async (params, _signal) => {
      const target = params.target || "canonical";
      let filePath: string;
      let sectionHeader: string;
      let roleSection: string;

      if (target === "accomplishments") {
        filePath = accomplishmentsPath();
        roleSection = params.role_section || "Cross-Functional Collaboration & Business Impact";
        // Accomplishments uses ## N. Section Name headers
        sectionHeader = `## `;  // partial match — we look for section name in any ## header
      } else {
        filePath = canonicalResumePath();
        roleSection = params.role_section || "Application Penetration Tester 4";
        sectionHeader = `### ${roleSection}`;
      }

      if (!fs.existsSync(filePath)) {
        return errorResult(`File not found: ${filePath}`);
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      // Find the section
      let roleStart = -1;
      let roleEnd = -1;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (target === "accomplishments") {
          // Match ## N. Section Name or ## Section Name containing the role_section text
          if (line.startsWith("## ") && line.includes(roleSection)) {
            roleStart = i;
            continue;
          }
          if (roleStart !== -1 && line.startsWith("## ") && i > roleStart + 1) {
            roleEnd = i;
            break;
          }
        } else {
          if (line === sectionHeader) {
            roleStart = i;
            continue;
          }
          if (roleStart !== -1 && (line.startsWith("### ") || (line.startsWith("## ") && !line.startsWith("### ")))) {
            roleEnd = i;
            break;
          }
        }
      }

      if (roleStart === -1) {
        return errorResult(`Section not found: ${roleSection}`);
      }

      if (roleEnd === -1) {
        roleEnd = lines.length;
      }

      // Find existing bullets in section
      const bulletIndices: number[] = [];
      for (let i = roleStart + 1; i < roleEnd; i++) {
        const line = lines[i].trim();
        if (target === "accomplishments") {
          if (line.startsWith("*") && line.endsWith("*")) {
            bulletIndices.push(i);
          }
        } else {
          if (line.startsWith("- ")) {
            bulletIndices.push(i);
          }
        }
      }

      const action = params.action || "append";
      const newBullet = target === "accomplishments"
        ? `*${params.bullet}*`
        : `- ${params.bullet}`;

      if (action === "replace_last" && bulletIndices.length > 0) {
        const lastIdx = bulletIndices[bulletIndices.length - 1];
        lines[lastIdx] = newBullet;
      } else {
        const insertAt = bulletIndices.length > 0 ? bulletIndices[bulletIndices.length - 1] + 1 : roleStart + 1;
        lines.splice(insertAt, 0, newBullet);
      }

      fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
      logger.info("Resume file updated", { target, section: roleSection, action });

      return resultText({
        updated: filePath,
        target,
        section: roleSection,
        action,
        bullet: params.bullet,
      });
    },
  });

  logger.info("Resume extension registered (resume_export, resume_list_accomplishments, resume_update_canonical)");
}
