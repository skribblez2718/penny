import { afterEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSpec, getProjectRoot, runGenerator } from "../../index.js";
import {
  contrast_ratio,
  publish_docx_atomically,
  validate_docx,
  type WordGenerationResult,
} from "../../renderer.js";
import { countMatches, openDocx, styleBlock, tinyPngBuffer } from "../helpers/docx.js";
import { requireDefined } from "../../../../lib/tests/test-narrowers.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const directory of cleanup.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penny-word-integration-"));
  cleanup.push(directory);
  return directory;
}

async function generateDoc(
  markdown: string,
  options: Record<string, unknown> = {}
): Promise<{
  output: string;
  result: WordGenerationResult;
  documentXml: string;
  stylesXml: string;
  settingsXml: string;
  relationshipsXml: string;
}> {
  const directory = temporaryDirectory();
  const output = path.join(directory, "integration.docx");
  const spec = buildSpec(
    {
      markdown,
      title_mode: "none",
      output_path: output,
      ...options,
    },
    getProjectRoot()
  );
  const outcome = await runGenerator(spec, undefined);
  if (outcome.cancelled) throw new Error("Generation unexpectedly cancelled");
  const docx = await openDocx(output);
  return {
    output,
    result: requireDefined(outcome.result, "Word generation returned no result"),
    documentXml: await docx.text("word/document.xml"),
    stylesXml: await docx.text("word/styles.xml"),
    settingsXml: await docx.text("word/settings.xml"),
    relationshipsXml: await docx.text("word/_rels/document.xml.rels"),
  };
}

function writeTinyPng(filePath: string): void {
  fs.writeFileSync(filePath, tinyPngBuffer());
}

function documentRelationshipTarget(relationshipsXml: string, typeSuffix: string): string {
  const match = new RegExp(
    `<Relationship\\b(?=[^>]*Type="[^"]*\\/${typeSuffix}")(?=[^>]*Target="([^"]+)")[^>]*/>`
  ).exec(relationshipsXml);
  if (!match?.[1]) {
    throw new Error(`Missing document relationship for type ${typeSuffix}`);
  }
  return match[1].startsWith("/")
    ? match[1].slice(1)
    : path.posix.normalize(path.posix.join("word", match[1]));
}

function replaceDocumentRelationship(
  relationshipsXml: string,
  typeSuffix: string,
  replacer: (relationshipXml: string) => string
): string {
  const pattern = new RegExp(
    `<Relationship\\b(?=[^>]*Type="[^"]*\\/${typeSuffix}")(?=[^>]*/>)[^>]*/>`
  );
  const match = pattern.exec(relationshipsXml);
  if (!match?.[0]) {
    throw new Error(`Missing document relationship for type ${typeSuffix}`);
  }
  return relationshipsXml.replace(match[0], replacer(match[0]));
}

function setRelationshipAttribute(relationshipXml: string, name: string, value: string): string {
  const attribute = new RegExp(`\\s${name}="[^"]*"`);
  if (attribute.test(relationshipXml)) {
    return relationshipXml.replace(attribute, ` ${name}="${value}"`);
  }
  return relationshipXml.replace("/>", ` ${name}="${value}"/>`);
}

function waitForAbort(signal: AbortSignal | undefined, maxMs = 5_000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), maxMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

describe("in-process Word generation", () => {
  it("creates a structurally validated DOCX with required parts, CRC integrity, and UTF-8 text", async () => {
    const outputDir = temporaryDirectory();
    const output = path.join(outputDir, "minimal.docx");
    const spec = buildSpec(
      {
        markdown: "# Hello\n\nA **bold** paragraph with café and 東京.",
        title_mode: "none",
        output_path: output,
      },
      getProjectRoot()
    );

    const outcome = await runGenerator(spec, undefined);
    expect(outcome.cancelled).toBe(false);

    const result = requireDefined(outcome.result, "Word generation returned no result");
    expect(result.path).toBe(path.resolve(output));
    expect(result.validation).toMatchObject({ package_valid: true, reopen_valid: true });
    expect(fs.readFileSync(output).subarray(0, 2).toString("ascii")).toBe("PK");

    const docx = await openDocx(output);
    expect(docx.names).toEqual(
      expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "word/document.xml"])
    );
    const documentXml = await docx.text("word/document.xml");
    expect(documentXml).toContain("café");
    expect(documentXml).toContain("東京");
  });

  it("validates malformed packages and preserves atomic publication boundaries", async () => {
    const directory = temporaryDirectory();

    const invalidZip = path.join(directory, "invalid.docx");
    fs.writeFileSync(invalidZip, "not a zip", "utf-8");
    await expect(validate_docx(invalidZip)).rejects.toThrow(
      /invalid generated DOCX|central directory/i
    );

    const missingPart = path.join(directory, "missing.docx");
    const missingPartZip = new JSZip();
    missingPartZip.file("word/document.xml", "<root/>");
    fs.writeFileSync(missingPart, await missingPartZip.generateAsync({ type: "nodebuffer" }));
    await expect(validate_docx(missingPart)).rejects.toThrow(/missing required parts/i);

    const malformed = path.join(directory, "malformed.docx");
    const malformedZip = new JSZip();
    malformedZip.file("[Content_Types].xml", "<Types>");
    malformedZip.file("_rels/.rels", "<Relationships/>");
    malformedZip.file("word/document.xml", "<document/>");
    fs.writeFileSync(malformed, await malformedZip.generateAsync({ type: "nodebuffer" }));
    await expect(validate_docx(malformed)).rejects.toThrow(/invalid generated DOCX/i);

    const traversal = path.join(directory, "traversal.docx");
    const traversalZip = new JSZip();
    traversalZip.file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
    );
    traversalZip.file(
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="urn:test" Target="../word/document.xml"/></Relationships>'
    );
    traversalZip.file("word/document.xml", "<document/>");
    fs.writeFileSync(traversal, await traversalZip.generateAsync({ type: "nodebuffer" }));
    await expect(validate_docx(traversal)).rejects.toThrow(/traversal escapes the package/i);

    const disguisedExternal = path.join(directory, "disguised-external.docx");
    const disguisedExternalZip = new JSZip();
    disguisedExternalZip.file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
    );
    disguisedExternalZip.file(
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="urn:test" Target="https://example.test/not-inside.docx"/></Relationships>'
    );
    disguisedExternalZip.file("word/document.xml", "<document/>");
    fs.writeFileSync(
      disguisedExternal,
      await disguisedExternalZip.generateAsync({ type: "nodebuffer" })
    );
    await expect(validate_docx(disguisedExternal)).rejects.toThrow(/must stay inside the package/i);

    const existing = path.join(directory, "existing.docx");
    const original = Buffer.from("known-good-prior-file");
    fs.writeFileSync(existing, original);
    await expect(publish_docx_atomically(Buffer.from("not a zip"), existing)).rejects.toThrow();
    expect(fs.readFileSync(existing)).toEqual(original);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp.docx"))).toEqual([]);

    const absent = path.join(directory, "absent.docx");
    await expect(publish_docx_atomically(Buffer.from("not a zip"), absent)).rejects.toThrow();
    expect(fs.existsSync(absent)).toBe(false);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp.docx"))).toEqual([]);
  });

  it("respects cancellation and timeout without publishing a target", async () => {
    const cancelledDir = temporaryDirectory();
    const cancelledOutput = path.join(cancelledDir, "cancelled.docx");
    const cancelledSpec = buildSpec(
      { markdown: "# Slow", title_mode: "none", output_path: cancelledOutput },
      getProjectRoot()
    );
    const controller = new AbortController();
    const pendingCancel = runGenerator(cancelledSpec, controller.signal, {
      hooks: { before_render: (signal) => waitForAbort(signal) },
      timeoutMs: 5_000,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(pendingCancel).resolves.toEqual({ cancelled: true });
    expect(fs.existsSync(cancelledOutput)).toBe(false);
    expect(fs.readdirSync(cancelledDir).filter((name) => name.endsWith(".tmp.docx"))).toEqual([]);

    const timeoutDir = temporaryDirectory();
    const timeoutOutput = path.join(timeoutDir, "timeout.docx");
    const timeoutSpec = buildSpec(
      { markdown: "# Slow", title_mode: "none", output_path: timeoutOutput },
      getProjectRoot()
    );
    await expect(
      runGenerator(timeoutSpec, undefined, {
        hooks: { before_render: (signal) => waitForAbort(signal) },
        timeoutMs: 50,
      })
    ).rejects.toThrow(/timed out after 50ms/);
    expect(fs.existsSync(timeoutOutput)).toBe(false);
    expect(fs.readdirSync(timeoutDir).filter((name) => name.endsWith(".tmp.docx"))).toEqual([]);
  });

  it("implements soft-break, hard-break, HTML br, and hyperlink break semantics", async () => {
    const preserve = await generateDoc("Alpha\nBeta", { line_break_mode: "preserve" });
    expect(preserve.documentXml).toMatch(/Alpha[\s\S]*<w:br\/>[\s\S]*Beta/);

    const commonmark = await generateDoc("Alpha\nBeta", { line_break_mode: "commonmark" });
    expect(commonmark.documentXml).toMatch(
      /Alpha[\s\S]*<w:t xml:space="preserve"> <\/w:t>[\s\S]*Beta/
    );
    expect(commonmark.documentXml).not.toContain("<w:br/>");

    const blankLine = await generateDoc("Alpha\n\nBeta", { line_break_mode: "commonmark" });
    expect(countMatches(blankLine.documentXml, /<w:p>/g)).toBeGreaterThanOrEqual(2);
    expect(blankLine.documentXml).toContain("Alpha");
    expect(blankLine.documentXml).toContain("Beta");

    const hardBreak = await generateDoc("Alpha  \nBeta", { line_break_mode: "commonmark" });
    expect(hardBreak.documentXml).toMatch(/Alpha[\s\S]*<w:br\/>[\s\S]*Beta/);

    const htmlBreak = await generateDoc("Alpha<BR>Beta", { line_break_mode: "commonmark" });
    expect(htmlBreak.documentXml).toMatch(/Alpha[\s\S]*<w:br\/>[\s\S]*Beta/);

    const hyperlinkBreak = await generateDoc("[Alpha\nBeta](https://example.test)", {
      line_break_mode: "preserve",
    });
    expect(hyperlinkBreak.documentXml).toMatch(
      /<w:hyperlink[^>]*>[\s\S]*Alpha[\s\S]*<w:br\/>[\s\S]*Beta[\s\S]*<\/w:hyperlink>/
    );
  });

  it("preserves list continuation semantics and restart-safe ordered markers", async () => {
    const continuation = await generateDoc(
      "1. First paragraph\n\n   Continuation paragraph\n2. Second item"
    );
    expect(continuation.documentXml).toMatch(/1\.\t/);
    expect(continuation.documentXml).toMatch(/2\.\t/);
    expect(continuation.documentXml).toContain("Continuation paragraph");
    expect(continuation.documentXml).toContain(`w:val="PennyListContinue"`);

    const restart = await generateDoc("1. Alpha\n2. Beta\n\nParagraph.\n\n1. Gamma");
    expect(countMatches(restart.documentXml, /1\.\t/g)).toBe(2);
    expect(countMatches(restart.documentXml, /2\.\t/g)).toBe(1);
  });

  it("renders content-aware and equal-width tables with alignment and row policies", async () => {
    const contentAware = await generateDoc(
      "| Status | Description |\n| --- | --- |\n| OK | This is a substantially longer explanatory value for the second column. |"
    );
    const contentWidths = [...contentAware.documentXml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map(
      (m) => Number(m[1])
    );
    expect(contentWidths[1]).toBeGreaterThan(contentWidths[0]);

    const equal = await generateDoc(
      "| Status | Description |\n| --- | --- |\n| OK | A much longer value. |",
      { table_layout: "equal" }
    );
    const equalWidths = [...equal.documentXml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) =>
      Number(m[1])
    );
    expect(equalWidths[0]).toBe(equalWidths[1]);

    const aligned = await generateDoc(
      "| Left | Center | Right |\n| :--- | :---: | ---: |\n| A | B | C |"
    );
    expect(aligned.documentXml).toContain('<w:jc w:val="left"/>');
    expect(aligned.documentXml).toContain('<w:jc w:val="center"/>');
    expect(aligned.documentXml).toContain('<w:jc w:val="right"/>');
    expect(countMatches(aligned.documentXml, /<w:cantSplit\/>/g)).toBeGreaterThanOrEqual(2);
    expect(aligned.documentXml).toContain("<w:tblHeader/>");
    expect(aligned.documentXml).toContain('<w:spacing w:before="0" w:after="0"');
  });

  it("warns for missing images, keeps block captions, and preserves inline-image placement plus alt text", async () => {
    const missing = await generateDoc("![missing image](not-present.png)");
    expect(missing.result.warnings).toEqual(["image not found: not-present.png"]);
    expect(missing.documentXml).toContain("[image unavailable: missing image]");

    const directory = temporaryDirectory();
    const figure = path.join(directory, "figure.png");
    writeTinyPng(figure);

    const block = await generateDoc(`![Figure caption](${figure})`);
    expect(block.documentXml).toContain('descr="Figure caption"');
    expect(block.documentXml).toMatch(/<w:pPr>[\s\S]*<w:keepNext\/>/);
    expect(block.documentXml).toContain("Figure caption");

    const inline = await generateDoc(`Before ![status dot](${figure}) after.`);
    expect(countMatches(inline.documentXml, /<w:drawing>/g)).toBe(1);
    expect(inline.documentXml).toContain('descr="status dot"');
    expect(inline.documentXml).toMatch(/Before[\s\S]*<w:drawing>[\s\S]*after\./);
  });

  it("rejects DOCX packages whose internal image relationship target is missing", async () => {
    const directory = temporaryDirectory();
    const figure = path.join(directory, "tampered-image.png");
    writeTinyPng(figure);

    const generated = await generateDoc(`![Tampered image](${figure})`);
    const mediaTarget = documentRelationshipTarget(generated.relationshipsXml, "image");
    expect(mediaTarget).toMatch(/^word\/media\/.*\.png$/);

    const zip = await JSZip.loadAsync(fs.readFileSync(generated.output), { checkCRC32: true });
    expect(zip.file(mediaTarget)).toBeTruthy();
    zip.remove(mediaTarget);
    const tamperedBuffer = await zip.generateAsync({ type: "nodebuffer" });

    const tamperedPath = path.join(directory, "tampered.docx");
    fs.writeFileSync(tamperedPath, tamperedBuffer);
    await expect(validate_docx(tamperedPath)).rejects.toThrow(/missing relationship target/i);

    const republishPath = path.join(directory, "republish.docx");
    await expect(publish_docx_atomically(tamperedBuffer, republishPath)).rejects.toThrow(
      /missing relationship target/i
    );
    expect(fs.existsSync(republishPath)).toBe(false);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp.docx"))).toEqual([]);
  });

  it("rejects DOCX packages whose image relationship is altered to an external target", async () => {
    const directory = temporaryDirectory();
    const figure = path.join(directory, "externalized-image.png");
    writeTinyPng(figure);

    const generated = await generateDoc(`![Externalized image](${figure})`);
    const mediaTarget = documentRelationshipTarget(generated.relationshipsXml, "image");
    expect(mediaTarget).toMatch(/^word\/media\/.*\.png$/);

    const zip = await JSZip.loadAsync(fs.readFileSync(generated.output), { checkCRC32: true });
    expect(zip.file(mediaTarget)).toBeTruthy();
    zip.remove(mediaTarget);
    zip.file(
      "word/_rels/document.xml.rels",
      replaceDocumentRelationship(generated.relationshipsXml, "image", (relationshipXml) =>
        setRelationshipAttribute(
          setRelationshipAttribute(
            relationshipXml,
            "Target",
            "https://example.test/externalized-image.png"
          ),
          "TargetMode",
          "External"
        )
      )
    );
    const tamperedBuffer = await zip.generateAsync({ type: "nodebuffer" });

    const tamperedPath = path.join(directory, "tampered-external-image.docx");
    fs.writeFileSync(tamperedPath, tamperedBuffer);
    await expect(validate_docx(tamperedPath)).rejects.toThrow(
      /unsupported external relationship type/i
    );

    const republishPath = path.join(directory, "republish-external-image.docx");
    await expect(publish_docx_atomically(tamperedBuffer, republishPath)).rejects.toThrow(
      /unsupported external relationship type/i
    );
    expect(fs.existsSync(republishPath)).toBe(false);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp.docx"))).toEqual([]);
  });

  it("rejects DOCX packages whose external hyperlink target uses javascript:", async () => {
    const directory = temporaryDirectory();
    const generated = await generateDoc("[Unsafe link](https://example.test)");

    const zip = await JSZip.loadAsync(fs.readFileSync(generated.output), { checkCRC32: true });
    zip.file(
      "word/_rels/document.xml.rels",
      replaceDocumentRelationship(generated.relationshipsXml, "hyperlink", (relationshipXml) =>
        setRelationshipAttribute(relationshipXml, "Target", "javascript:alert(1)")
      )
    );
    const tamperedBuffer = await zip.generateAsync({ type: "nodebuffer" });

    const tamperedPath = path.join(directory, "tampered-javascript-hyperlink.docx");
    fs.writeFileSync(tamperedPath, tamperedBuffer);
    await expect(validate_docx(tamperedPath)).rejects.toThrow(
      /unsupported external hyperlink target scheme/i
    );

    const republishPath = path.join(directory, "republish-javascript-hyperlink.docx");
    await expect(publish_docx_atomically(tamperedBuffer, republishPath)).rejects.toThrow(
      /unsupported external hyperlink target scheme/i
    );
    expect(fs.existsSync(republishPath)).toBe(false);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp.docx"))).toEqual([]);
  });

  it("continues to validate generated DOCX packages with Markdown HTTPS hyperlinks", async () => {
    const generated = await generateDoc("[Safe link](https://example.test/path)");
    expect(generated.result.validation).toMatchObject({ package_valid: true, reopen_valid: true });
    expect(generated.relationshipsXml).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"'
    );
    expect(generated.relationshipsXml).toContain('TargetMode="External"');
    expect(generated.relationshipsXml).toContain('Target="https://example.test/path"');
    await expect(validate_docx(generated.output)).resolves.toMatchObject({
      package_valid: true,
      reopen_valid: true,
    });
  });

  it("renders documented blockquotes, horizontal rules, and bulleted lists", async () => {
    const rendered = await generateDoc(
      "> First quoted line\n>\n> Second quoted line\n\n---\n\n- Top bullet\n  - Nested bullet\n- Final bullet"
    );
    expect(countMatches(rendered.documentXml, /w:pStyle w:val="PennyQuote"/g)).toBe(2);
    expect(rendered.documentXml).toContain("First quoted line");
    expect(rendered.documentXml).toContain("Second quoted line");
    expect(rendered.documentXml).toMatch(/<w:pBdr>[\s\S]*<w:left w:val="single"/);
    expect(rendered.documentXml).toMatch(/<w:pBdr>[\s\S]*<w:bottom w:val="single"/);
    expect(rendered.documentXml).toContain("Top bullet");
    expect(rendered.documentXml).toContain("Nested bullet");
    expect(rendered.documentXml).toContain("Final bullet");
    expect(countMatches(rendered.documentXml, /<w:numPr>/g)).toBeGreaterThanOrEqual(3);
    expect(rendered.documentXml).toContain('<w:ilvl w:val="0"/>');
    expect(rendered.documentXml).toContain('<w:ilvl w:val="1"/>');
  });

  it("renders code blocks, cover sections, and TOC update requests", async () => {
    const code = await generateDoc("```python\nfirst = 1\nsecond = 2\n```");
    expect(code.documentXml).toContain('w:val="PennyCodeBlock"');
    expect(countMatches(code.documentXml, /<w:br\/>/g)).toBe(1);
    expect(countMatches(code.documentXml, /<w:p>/g)).toBe(1);

    const cover = await generateDoc("# Report\n\n## Body\n\nContent.", {
      title_mode: "cover",
      footer_text: "Confidential",
      include_page_numbers: true,
    });
    expect(countMatches(cover.documentXml, /<w:sectPr>/g)).toBeGreaterThanOrEqual(1);
    expect(cover.documentXml).toContain('<w:footerReference w:type="default"');
    expect(cover.documentXml).toContain('<w:pgNumType w:start="1"/>');

    const toc = await generateDoc("# Report\n\n## Body\n\nContent.", { include_toc: true });
    expect(toc.settingsXml).toContain("<w:updateFields/>");
    expect(toc.documentXml).toContain("TOC \\h \\o &quot;1-3&quot; \\u \\z");
    expect(toc.result.toc_field_update_requested).toBe(true);
    expect((toc.result.warnings as string[]).some((warning) => warning.includes("TOC field"))).toBe(
      true
    );
  });

  it("preserves inline semantics, contextual hyperlink styles, and inherited body typography", async () => {
    const semantics = await generateDoc(
      "Ordinary body text.\n\n**bold** *italic* ~~strike~~ `code` [link](https://example.test)"
    );
    expect(semantics.documentXml).toMatch(
      /<w:p>[\s\S]*<w:pStyle w:val="PennyBody"\/>[\s\S]*<w:r><w:t xml:space="preserve">Ordinary body text\.<\/w:t><\/w:r>/
    );
    expect(semantics.documentXml).toContain("<w:b/>");
    expect(semantics.documentXml).toContain("<w:i/>");
    expect(semantics.documentXml).toContain("<w:strike/>");
    expect(semantics.documentXml).toContain('w:rStyle w:val="PennyInlineCode"');
    expect(semantics.documentXml).toContain("<w:hyperlink");
    expect(semantics.relationshipsXml).toContain("https://example.test");

    const contextual = await generateDoc(
      "# [Linked Heading](https://example.test)\n\n| [Header](https://example.test) |\n| --- |\n| Value |",
      { table_style: "minimal", font_size_pt: 14 }
    );
    expect(contextual.documentXml).toContain('w:pStyle w:val="Heading1"');
    expect(contextual.documentXml).toContain('w:pStyle w:val="PennyTableHeader"');
    expect(contextual.documentXml).toContain('w:rStyle w:val="PennyHyperlink"');
    const hyperlinkStyle = styleBlock(contextual.stylesXml, "PennyHyperlink");
    expect(hyperlinkStyle).not.toContain("<w:rFonts");
    expect(hyperlinkStyle).not.toContain("<w:sz ");
  });

  it("emits the expected style font slots and on-accent hyperlink styling", async () => {
    const styled = await generateDoc("| [Header](https://example.test) |\n| --- |\n| Value |", {
      accent_color: "FDE047",
    });
    expect(styled.documentXml).toContain('w:rStyle w:val="PennyHyperlinkOnAccent"');

    for (const styleId of ["PennyBody", "Heading1", "PennyTableBody", "PennyInlineCode"]) {
      const block = styleBlock(styled.stylesXml, styleId);
      expect(block).toMatch(/w:rFonts[^>]*w:ascii="[^"]+"/);
      expect(block).toMatch(/w:rFonts[^>]*w:hAnsi="[^"]+"/);
      expect(block).toMatch(/w:rFonts[^>]*w:eastAsia="[^"]+"/);
      expect(block).toMatch(/w:rFonts[^>]*w:cs="[^"]+"/);
    }

    const inlineCodeStyle = styleBlock(styled.stylesXml, "PennyInlineCode");
    expect(inlineCodeStyle).toContain("Consolas");
    expect(inlineCodeStyle).not.toContain("<w:sz ");

    const palette = styled.result.resolved_palette;
    expect(contrast_ratio(palette.link_on_accent, palette.accent)).toBeGreaterThanOrEqual(4.5);
  });
});
