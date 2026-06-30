/**
 * PDF-to-Markdown Extension
 *
 * Provides a custom tool and slash command to convert PDF files to Markdown:
 * - pdf_to_markdown: LLM-callable tool that converts a PDF to a .md file
 * - /pdf2markdown: User-facing slash command with the same behavior
 *
 * Powered by @opendocsg/pdf2md — a pure JS/TS PDF text extractor that preserves
 * paragraph structure and emits Markdown.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { createLogger, setSessionId } from "../../lib/logger/logger.js";

const logger = createLogger("pdf2markdown");

// Import CJS module safely under ESM + jiti
import pdf2mdModule from "@opendocsg/pdf2md";
const pdf2md = ((pdf2mdModule as any).default ?? pdf2mdModule) as (
  source: string | ArrayBuffer | Uint8Array,
  callbacks?: Record<string, unknown>,
) => Promise<string>;

interface ConvertResult {
  pdfPath: string;
  outputPath: string;
  pages: number;
  markdown: string;
}

/**
 * Convert a PDF file to Markdown and write the result to disk.
 *
 * @param pdfPath Absolute or relative path to the source PDF.
 * @param outputPath Optional absolute or relative path for the output Markdown.
 *                   Defaults to the source path with `.pdf` replaced by `.md`.
 * @param cwd Current working directory for relative path resolution.
 * @returns Conversion result including both the markdown text and metadata.
 */
async function convertPdfToMarkdown(
  pdfPath: string,
  outputPath: string | undefined,
  cwd: string,
): Promise<ConvertResult> {
  const resolvedPdfPath = isAbsolute(pdfPath) ? pdfPath : join(cwd, pdfPath);
  const resolvedOutputPath = outputPath
    ? isAbsolute(outputPath)
      ? outputPath
      : join(cwd, outputPath)
    : resolvedPdfPath.replace(/\.pdf$/i, ".md");

  logger.info("reading pdf", { pdfPath: resolvedPdfPath });
  const buffer = await readFile(resolvedPdfPath);

  logger.info("converting pdf to markdown", {
    pdfPath: resolvedPdfPath,
    bytes: buffer.length,
  });

  // Track parsed page count via the library's pageParsed callback
  let pages = 0;
  const markdown = await pdf2md(buffer, {
    pageParsed: (pageBatch: Array<{ index: number }>) => {
      pages = Math.max(pages, ...pageBatch.map((p) => p.index + 1));
    },
  });

  logger.info("writing markdown", {
    pdfPath: resolvedPdfPath,
    outputPath: resolvedOutputPath,
    pages,
    chars: markdown.length,
  });

  await writeFile(resolvedOutputPath, markdown, "utf-8");

  return {
    pdfPath: resolvedPdfPath,
    outputPath: resolvedOutputPath,
    pages,
    markdown,
  };
}

export default function pdf2markdownExtension(pi: ExtensionAPI) {
  // Keep the shared logger's session id in sync
  pi.on("session_start", async (_event: unknown, ctx: { sessionManager: { getSessionId: () => string } }) => {
    setSessionId(ctx.sessionManager.getSessionId());
  });

  // ==========================
  // TOOL: pdf_to_markdown
  // ==========================
  pi.registerTool({
    name: "pdf_to_markdown",
    label: "PDF to Markdown",
    description:
      "Convert a PDF file to a Markdown file. " +
      "The source PDF path is required; if no output path is provided, the result is written " +
      "next to the PDF with the `.pdf` extension replaced by `.md`. " +
      "Returns the Markdown text and the path to the written file.",
    promptSnippet: "pdf_to_markdown with { pdfPath, outputPath? }",
    promptGuidelines: [
      "Use pdf_to_markdown when the user asks to extract text from a PDF or convert it to Markdown.",
      "Accepts relative paths resolved against the current working directory or absolute paths.",
      "When outputPath is omitted, the markdown file is written next to the source PDF.",
      "Large PDFs may produce long markdown output; consider writing to disk and summarizing afterward.",
    ],
    parameters: Type.Object({
      pdfPath: Type.String({
        description: "Path to the PDF file to convert. Relative paths are resolved from the current working directory.",
      }),
      outputPath: Type.Optional(
        Type.String({
          description:
            "Optional path for the output Markdown file. " +
            "If omitted, the output is written next to the PDF with extension `.md`.",
        })
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { pdfPath: string; outputPath?: string },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      try {
        const { pdfPath, outputPath } = params;

        if (!pdfPath?.trim()) {
          return {
            content: [{ type: "text" as const, text: "Error: pdfPath parameter is required." }],
            isError: true,
          };
        }

        const result = await convertPdfToMarkdown(pdfPath, outputPath, ctx.cwd);

        const summary = `Converted ${basename(result.pdfPath)} (${result.pages} page${result.pages === 1 ? "" : "s"}) to ${result.outputPath}`;

        return {
          content: [
            { type: "text" as const, text: summary },
            { type: "text" as const, text: result.markdown },
          ],
          details: {
            pdfPath: result.pdfPath,
            outputPath: result.outputPath,
            pages: result.pages,
            chars: result.markdown.length,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("pdf_to_markdown failed", { error: msg }, err instanceof Error ? err : undefined);
        return {
          content: [{ type: "text" as const, text: `Error converting PDF: ${msg}` }],
          isError: true,
        };
      }
    },
  });

  // ==========================
  // COMMAND: /pdf2markdown
  // ==========================
  pi.registerCommand("pdf2markdown", {
    description: "Convert a PDF file to Markdown (usage: /pdf2markdown <pdfPath> [outputPath])",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const [pdfPath, outputPath] = tokens;

      if (!pdfPath) {
        ctx.ui.notify("Usage: /pdf2markdown <pdfPath> [outputPath]", "error");
        return;
      }

      try {
        const result = await convertPdfToMarkdown(pdfPath, outputPath, ctx.cwd);
        ctx.ui.notify(
          `Converted ${basename(result.pdfPath)} → ${basename(result.outputPath)} (${result.pages} page${
            result.pages === 1 ? "" : "s"
          })`,
          "info"
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("/pdf2markdown failed", { error: msg }, err instanceof Error ? err : undefined);
        ctx.ui.notify(`PDF conversion failed: ${msg}`, "error");
      }
    },
  });
}
