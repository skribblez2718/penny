import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import JSZip from "jszip";
import extension, { buildSpec, getProjectRoot, runGenerator } from "../../index.js";
import {
  _contrast_ratio,
  generate,
  type PowerpointGenerationResult,
  publish_pptx_atomically,
  validate_pptx,
} from "../../renderer.js";
import {
  createExtensionApiHarness,
  requireDefined,
  requireNumber,
  requirePowerpointTool,
  requirePowerpointToolResult,
  requireRecord,
  requireString,
} from "../helpers/contracts.js";
import {
  countBulletParagraphs,
  countLineBreaks,
  countParagraphs,
  extractShapeNames,
  joinedText,
  notesPart,
  openPptx,
  slidePart,
  slideRelsPart,
  slideTextBodiesContaining,
  tableCellsContaining,
  writeGradientImage,
  writeSolidImage,
} from "../helpers/pptx.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const target of cleanup.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "penny-powerpoint-integration-"));
  cleanup.push(directory);
  return directory;
}

async function generateDeck(payload: Record<string, unknown>): Promise<{
  output: string;
  result: PowerpointGenerationResult;
  pptx: Awaited<ReturnType<typeof openPptx>>;
}> {
  const directory = temporaryDirectory();
  const output =
    typeof payload.output_path === "string"
      ? payload.output_path
      : path.join(directory, "deck.pptx");
  const outcome = await runGenerator(
    { output_path: output, project_root: directory, ...payload },
    undefined
  );
  if (outcome.cancelled || !outcome.result) {
    throw new Error("Generation unexpectedly cancelled");
  }
  return { output, result: outcome.result, pptx: await openPptx(output) };
}

function waitForAbort(signal: AbortSignal | undefined, maxMs = 5_000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, maxMs);
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

function writeHeaderOnlyPng(filePath: string, width: number, height: number): void {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  fs.writeFileSync(filePath, header);
}

function duplicateCentralDirectoryEntry(buffer: Buffer, targetName: string): Buffer {
  const eocdSignature = 0x06054b50;
  const cdSignature = 0x02014b50;
  let eocdOffset = -1;
  for (
    let offset = buffer.length - 22;
    offset >= Math.max(0, buffer.length - 0xffff - 22);
    offset -= 1
  ) {
    if (buffer.readUInt32LE(offset) !== eocdSignature) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("EOCD not found");

  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  let offset = centralDirectoryOffset;
  let duplicate: Buffer | null = null;

  while (offset < centralDirectoryEnd) {
    if (buffer.readUInt32LE(offset) !== cdSignature) throw new Error("central directory missing");
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === targetName) {
      duplicate = Buffer.from(buffer.subarray(offset, offset + recordLength));
      break;
    }
    offset += recordLength;
  }
  if (!duplicate) throw new Error(`central directory entry not found: ${targetName}`);

  const patched = Buffer.concat([
    buffer.subarray(0, centralDirectoryEnd),
    duplicate,
    buffer.subarray(centralDirectoryEnd),
  ]);
  patched.writeUInt16LE(buffer.readUInt16LE(eocdOffset + 8) + 1, eocdOffset + duplicate.length + 8);
  patched.writeUInt16LE(
    buffer.readUInt16LE(eocdOffset + 10) + 1,
    eocdOffset + duplicate.length + 10
  );
  patched.writeUInt32LE(
    buffer.readUInt32LE(eocdOffset + 12) + duplicate.length,
    eocdOffset + duplicate.length + 12
  );
  return patched;
}

describe("in-process PowerPoint generation", () => {
  it("creates a structurally validated PPTX with Unicode text and notes", async () => {
    const { output, result, pptx } = await generateDeck({
      slides: [
        { layout: "title", title: "Validated", subtitle: "café 東京" },
        { layout: "content", title: "Body", body: "Alpha", notes: "Speaker note" },
      ],
    });

    expect(result.path).toBe(path.resolve(output));
    expect(result.validation).toMatchObject({
      package_valid: true,
      reopen_valid: true,
      slide_count: 2,
    });
    expect(pptx.names).toEqual(
      expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"])
    );
    expect(joinedText(await pptx.text(slidePart(1)))).toContain("Validated");
    expect(joinedText(await pptx.text(slidePart(1)))).toContain("東京");
    expect(await pptx.text(notesPart(2))).toContain("Speaker note");
  });

  it("validates malformed packages, missing parts, and unsafe relationships", async () => {
    const directory = temporaryDirectory();

    const invalidZip = path.join(directory, "invalid.pptx");
    fs.writeFileSync(invalidZip, "not a zip", "utf8");
    await expect(validate_pptx(invalidZip)).rejects.toThrow(
      /invalid generated PPTX|central directory/i
    );

    const missingPart = path.join(directory, "missing.pptx");
    const missingZip = new JSZip();
    missingZip.file("ppt/presentation.xml", "<p:presentation xmlns:p='x'/>");
    fs.writeFileSync(missingPart, await missingZip.generateAsync({ type: "nodebuffer" }));
    await expect(validate_pptx(missingPart)).rejects.toThrow(/missing required parts/i);

    const traversal = path.join(directory, "traversal.pptx");
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
    );
    zip.file(
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="urn:test" Target="../ppt/presentation.xml"/></Relationships>'
    );
    zip.file("docProps/core.xml", "<cp:coreProperties xmlns:cp='x'/>");
    zip.file("docProps/app.xml", "<Properties xmlns='x'/>");
    zip.file("ppt/presentation.xml", "<p:presentation xmlns:p='x'/>");
    zip.file(
      "ppt/_rels/presentation.xml.rels",
      "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'/>"
    );
    fs.writeFileSync(traversal, await zip.generateAsync({ type: "nodebuffer" }));
    await expect(validate_pptx(traversal)).rejects.toThrow(/traversal escapes the package/i);

    const external = path.join(directory, "external.pptx");
    const zip2 = new JSZip();
    zip2.file(
      "[Content_Types].xml",
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
    );
    zip2.file(
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>'
    );
    zip2.file("docProps/core.xml", "<cp:coreProperties xmlns:cp='x'/>");
    zip2.file("docProps/app.xml", "<Properties xmlns='x'/>");
    zip2.file("ppt/presentation.xml", "<p:presentation xmlns:p='x'/>");
    zip2.file(
      "ppt/_rels/presentation.xml.rels",
      "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'/>"
    );
    fs.writeFileSync(external, await zip2.generateAsync({ type: "nodebuffer" }));
    await expect(validate_pptx(external)).rejects.toThrow(
      /unsupported external hyperlink target scheme/i
    );
  });

  it("rejects duplicate central-directory part names before JSZip can collapse them", async () => {
    const directory = temporaryDirectory();
    const source = path.join(directory, "valid.pptx");
    await generate({
      output_path: source,
      project_root: directory,
      slides: [{ layout: "title", title: "Duplicate Entry" }],
    });

    const duplicate = path.join(directory, "duplicate-entry.pptx");
    fs.writeFileSync(
      duplicate,
      duplicateCentralDirectoryEntry(fs.readFileSync(source), "[Content_Types].xml")
    );
    await expect(validate_pptx(duplicate)).rejects.toThrow(
      /duplicate part names: \["\[Content_Types\]\.xml"\]/i
    );
  });

  it("rejects entity and DOCTYPE XML in otherwise complete packages", async () => {
    const directory = temporaryDirectory();
    const source = path.join(directory, "valid-doctype-source.pptx");
    await generate({
      output_path: source,
      project_root: directory,
      slides: [{ layout: "title", title: "DOCTYPE" }],
    });

    const zip = await JSZip.loadAsync(fs.readFileSync(source), { checkCRC32: true });
    zip.file(
      "ppt/presentation.xml",
      '<?xml version="1.0"?><!DOCTYPE p [<!ENTITY boom \'x\'>]><p:presentation xmlns:p="x"/>'
    );
    const mutated = path.join(directory, "doctype.pptx");
    fs.writeFileSync(mutated, await zip.generateAsync({ type: "nodebuffer" }));
    await expect(validate_pptx(mutated)).rejects.toThrow(/disallowed XML construct/i);
  });

  it("preserves atomic publication boundaries on validation failure", async () => {
    const directory = temporaryDirectory();
    const existing = path.join(directory, "existing.pptx");
    const baseline = Buffer.from("known-good-prior-file");
    fs.writeFileSync(existing, baseline);
    await expect(publish_pptx_atomically(Buffer.from("not a zip"), existing)).rejects.toThrow();
    expect(fs.readFileSync(existing)).toEqual(baseline);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp.pptx"))).toEqual([]);
  });

  it("respects cancellation and timeout without publishing a target", async () => {
    const cancelDir = temporaryDirectory();
    const cancelOutput = path.join(cancelDir, "cancelled.pptx");
    const cancelSpec = buildSpec(
      { slides: [{ layout: "title", title: "Slow" }], output_path: cancelOutput },
      getProjectRoot()
    );
    const controller = new AbortController();
    const pendingCancel = runGenerator(cancelSpec, controller.signal, {
      hooks: { before_render: (signal) => waitForAbort(signal) },
      timeoutMs: 5_000,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(pendingCancel).resolves.toEqual({ cancelled: true });
    expect(fs.existsSync(cancelOutput)).toBe(false);

    const timeoutDir = temporaryDirectory();
    const timeoutOutput = path.join(timeoutDir, "timeout.pptx");
    const timeoutSpec = buildSpec(
      { slides: [{ layout: "title", title: "Slow" }], output_path: timeoutOutput },
      getProjectRoot()
    );
    await expect(
      runGenerator(timeoutSpec, undefined, {
        hooks: { before_render: (signal) => waitForAbort(signal) },
        timeoutMs: 50,
      })
    ).rejects.toThrow(/timed out after 50ms/);
    expect(fs.existsSync(timeoutOutput)).toBe(false);
  });

  it("renders documented layouts, markdown classification, hyperlinks, and line breaks as editable OOXML", async () => {
    const imageDir = temporaryDirectory();
    const imagePath = path.join(imageDir, "image.png");
    await writeSolidImage(imagePath, { width: 200, height: 100, color: "purple", format: "png" });
    const { result, pptx } = await generateDeck({
      markdown:
        "# Deck\n\nSubtitle\n\n## Body\n\nSoft A\nSoft B\n\nHard A  \nHard B\n\nA [linked **phrase**](https://example.com/path).\n\n```text\nCODE-1\nCODE-2\n```\n\n## Table\n\n| A |\n|---|\n| B |\n\n---\n## Quote\n\n> Quote text\n> \u2014 Person\n\n## Image\n\n![diagram](" +
        imagePath +
        ")",
    });

    expect(result.layouts_used.title).toBe(1);
    expect(result.layouts_used.content).toBeGreaterThanOrEqual(1);
    expect(result.layouts_used.table).toBe(1);
    expect(result.layouts_used.section).toBe(1);
    expect(result.layouts_used.quote).toBe(1);
    expect(result.layouts_used.image).toBe(1);

    const firstSlideXml = await pptx.text(slidePart(2));
    expect(joinedText(firstSlideXml)).toContain("Soft A");
    expect(firstSlideXml).toContain("<a:br/>");
    expect(await pptx.text(slideRelsPart(2))).toContain("https://example.com/path");
  });

  it("keeps preserve-mode breaks inside one body paragraph, bullet item, and table cell", async () => {
    const { pptx } = await generateDeck({
      line_break_mode: "preserve",
      slides: [
        {
          layout: "content",
          title: "Preserve",
          body: "Body soft A\nBody soft B\n\nBody hard A  \nBody hard B",
          bullets: [
            { text: "Bullet soft A\nBullet soft B" },
            { text: "Bullet hard A  \nBullet hard B" },
          ],
        },
        {
          layout: "table",
          title: "Preserve Table",
          table: {
            headers: ["Soft", "Hard"],
            rows: [["Cell soft A\nCell soft B", "Cell hard A  \nCell hard B"]],
          },
        },
      ],
    });

    const contentXml = await pptx.text(slidePart(1));
    const bodyXml = requireDefined(
      slideTextBodiesContaining(contentXml, "Body soft A")[0],
      "preserve-mode body text was not rendered"
    );
    expect(countParagraphs(bodyXml)).toBe(2);
    expect(countLineBreaks(bodyXml)).toBe(2);

    const bulletXml = slideTextBodiesContaining(contentXml, "Bullet ").join("");
    expect(countParagraphs(bulletXml)).toBe(2);
    expect(countBulletParagraphs(bulletXml)).toBe(2);
    expect(countLineBreaks(bulletXml)).toBe(2);

    const tableXml = await pptx.text(slidePart(2));
    const softCell = requireDefined(
      tableCellsContaining(tableXml, "Cell soft A")[0],
      "preserve-mode soft-break cell was not rendered"
    );
    const hardCell = requireDefined(
      tableCellsContaining(tableXml, "Cell hard A")[0],
      "preserve-mode hard-break cell was not rendered"
    );
    expect(countParagraphs(softCell)).toBe(1);
    expect(countLineBreaks(softCell)).toBe(1);
    expect(countParagraphs(hardCell)).toBe(1);
    expect(countLineBreaks(hardCell)).toBe(1);
  });

  it("folds only soft breaks in commonmark mode while retaining hard breaks", async () => {
    const { pptx } = await generateDeck({
      line_break_mode: "commonmark",
      slides: [
        {
          layout: "content",
          title: "CommonMark",
          body: "Body soft A\nBody soft B\n\nBody hard A  \nBody hard B",
          bullets: [
            { text: "Bullet soft A\nBullet soft B" },
            { text: "Bullet hard A  \nBullet hard B" },
          ],
        },
        {
          layout: "table",
          title: "CommonMark Table",
          table: {
            headers: ["Soft", "Hard"],
            rows: [["Cell soft A\nCell soft B", "Cell hard A  \nCell hard B"]],
          },
        },
      ],
    });

    const contentXml = await pptx.text(slidePart(1));
    const bodyXml = requireDefined(
      slideTextBodiesContaining(contentXml, "Body soft A")[0],
      "commonmark body text was not rendered"
    );
    expect(countParagraphs(bodyXml)).toBe(2);
    expect(countLineBreaks(bodyXml)).toBe(1);

    const bulletXml = slideTextBodiesContaining(contentXml, "Bullet ").join("");
    expect(countParagraphs(bulletXml)).toBe(2);
    expect(countBulletParagraphs(bulletXml)).toBe(2);
    expect(countLineBreaks(bulletXml)).toBe(1);

    const tableXml = await pptx.text(slidePart(2));
    const softCell = requireDefined(
      tableCellsContaining(tableXml, "Cell soft A")[0],
      "commonmark soft-break cell was not rendered"
    );
    const hardCell = requireDefined(
      tableCellsContaining(tableXml, "Cell hard A")[0],
      "commonmark hard-break cell was not rendered"
    );
    expect(countParagraphs(softCell)).toBe(1);
    expect(countLineBreaks(softCell)).toBe(0);
    expect(countParagraphs(hardCell)).toBe(1);
    expect(countLineBreaks(hardCell)).toBe(1);
  });

  it("keeps markdown-mode preserve breaks inside one bullet paragraph per item", async () => {
    const { pptx } = await generateDeck({
      line_break_mode: "preserve",
      markdown:
        "# Deck\n\n## Breaks\n\n- Bullet soft A\n  Bullet soft B\n- Bullet hard A  \n  Bullet hard B",
    });

    const contentXml = await pptx.text(slidePart(2));
    const softBulletXml = requireDefined(
      slideTextBodiesContaining(contentXml, "Bullet soft A")[0],
      "preserve-mode soft-break bullet was not rendered"
    );
    const hardBulletXml = requireDefined(
      slideTextBodiesContaining(contentXml, "Bullet hard A")[0],
      "preserve-mode hard-break bullet was not rendered"
    );
    const bulletXml = slideTextBodiesContaining(contentXml, "Bullet ").join("");
    expect(countParagraphs(bulletXml)).toBe(2);
    expect(countBulletParagraphs(bulletXml)).toBe(2);
    expect(countParagraphs(softBulletXml)).toBe(1);
    expect(countBulletParagraphs(softBulletXml)).toBe(1);
    expect(countLineBreaks(softBulletXml)).toBe(1);
    expect(countParagraphs(hardBulletXml)).toBe(1);
    expect(countBulletParagraphs(hardBulletXml)).toBe(1);
    expect(countLineBreaks(hardBulletXml)).toBe(1);
  });

  it("folds markdown-mode bullet soft breaks only in commonmark while retaining hard breaks", async () => {
    const { pptx } = await generateDeck({
      line_break_mode: "commonmark",
      markdown:
        "# Deck\n\n## Breaks\n\n- Bullet soft A\n  Bullet soft B\n- Bullet hard A  \n  Bullet hard B",
    });

    const contentXml = await pptx.text(slidePart(2));
    const softBulletXml = requireDefined(
      slideTextBodiesContaining(contentXml, "Bullet soft A")[0],
      "commonmark soft-break bullet was not rendered"
    );
    const hardBulletXml = requireDefined(
      slideTextBodiesContaining(contentXml, "Bullet hard A")[0],
      "commonmark hard-break bullet was not rendered"
    );
    const bulletXml = slideTextBodiesContaining(contentXml, "Bullet ").join("");
    expect(countParagraphs(bulletXml)).toBe(2);
    expect(countBulletParagraphs(bulletXml)).toBe(2);
    expect(countParagraphs(softBulletXml)).toBe(1);
    expect(countBulletParagraphs(softBulletXml)).toBe(1);
    expect(countLineBreaks(softBulletXml)).toBe(0);
    expect(countParagraphs(hardBulletXml)).toBe(1);
    expect(countBulletParagraphs(hardBulletXml)).toBe(1);
    expect(countLineBreaks(hardBulletXml)).toBe(1);
  });

  it("paginates long body, bullets, code, and tables without silently truncating content", async () => {
    const bullets = Array.from(
      { length: 7 },
      (_, index) => `BULLET-${index} ` + "detail ".repeat(42)
    );
    const paragraphs = Array.from(
      { length: 12 },
      (_, index) => `[PARA-${index}] ` + "word ".repeat(36)
    );
    const code = Array.from({ length: 24 }, (_, index) => `CODE-LINE-${index} = ${index}`).join(
      "\n"
    );
    const rows = Array.from({ length: 24 }, (_, index) => [
      String(index),
      `ROW-${index}`,
      "value ".repeat(12),
    ]);
    const { result, pptx } = await generateDeck({
      slides: [
        { layout: "content", title: "Long", body: paragraphs.join("\n\n"), bullets, code: [code] },
        { layout: "table", title: "Rows", table: { headers: ["N", "Marker", "Value"], rows } },
      ],
    });

    expect(result.slide_count).toBeGreaterThan(2);
    const rendered = (
      await Promise.all(
        Array.from({ length: result.slide_count }, (_, index) => pptx.text(slidePart(index + 1)))
      )
    )
      .map(joinedText)
      .join("\n");
    expect(rendered).toContain("BULLET-0");
    expect(rendered).toContain("BULLET-6");
    expect(rendered).toContain("[PARA-0]");
    expect(rendered).toContain("[PARA-11]");
    expect(rendered).toContain("CODE-LINE-0 = 0");
    expect(rendered).toContain("CODE-LINE-23 = 23");
    expect(rendered).toContain("ROW-0");
    expect(rendered).toContain("ROW-23");
    expect(result.warnings.some((warning) => /truncat|clamp/i.test(warning))).toBe(false);
  });

  it("projects custom design, contrast-safe telemetry, and path-free resolved design", async () => {
    const directory = temporaryDirectory();
    const background = path.join(directory, "background.jpg");
    const media = path.join(directory, "media.png");
    const mark = path.join(directory, "mark.png");
    await writeSolidImage(background, {
      width: 1600,
      height: 900,
      color: "#11223A",
      format: "jpeg",
    });
    await writeSolidImage(media, { width: 1200, height: 600, color: "#2D78B4", format: "png" });
    await writeSolidImage(mark, { width: 240, height: 120, color: "#38BDF8", format: "png" });

    const { result, pptx } = await generateDeck({
      output_path: path.join(directory, "custom.pptx"),
      project_root: directory,
      allowed_image_roots: [directory],
      design: {
        palette: {
          canvas: "080B12",
          surface: "101827",
          accent: "FDE047",
          text: "111111",
          muted_text: "222222",
        },
        background: { path: background, fit: "crop", overlay: { color: "000000", opacity: 0.4 } },
        mark: { path: mark, x: 0.9, y: 0.05, width: 0.06, height: 0.06 },
      },
      slides: [
        { layout: "content", title: "Readable", body: "Body", code: ["print('x')"] },
        {
          layout: "image_left",
          title: "Composed",
          body: "Editable",
          bullets: ["Bullet"],
          media: { path: media },
        },
      ],
    });

    const telemetry = JSON.stringify(result.resolved_design);
    expect(telemetry).not.toContain(directory);
    expect(telemetry).not.toContain(path.basename(background));
    const deckDefault = requireRecord(
      result.resolved_design.deck_default,
      "resolved deck-default design telemetry is missing"
    );
    const palette = requireRecord(
      deckDefault.palette,
      "resolved deck-default palette telemetry is missing"
    );
    expect(palette.surface).toBe("101827");
    const slideTelemetry = result.resolved_design.slides;
    if (!Array.isArray(slideTelemetry)) {
      throw new Error("resolved slide design telemetry is missing");
    }
    for (const [slideIndex, value] of slideTelemetry.entries()) {
      const record = requireRecord(value, `slide ${slideIndex} telemetry is not an object`);
      const contrastRoles = requireRecord(
        record.contrast_roles,
        `slide ${slideIndex} contrast telemetry is missing`
      );
      for (const [roleName, roleValue] of Object.entries(contrastRoles)) {
        const role = requireRecord(
          roleValue,
          `slide ${slideIndex} contrast role ${roleName} is missing`
        );
        expect(
          requireNumber(
            role.ratio,
            `slide ${slideIndex} contrast role ${roleName} has no numeric ratio`
          )
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
    const slide1Xml = await pptx.text(slidePart(1));
    expect(extractShapeNames(slide1Xml)).toContain("Penny Canvas");
    expect(extractShapeNames(await pptx.text(slidePart(2)))).toContain("Penny Media");
  });

  it("fails closed for unsafe or unsupported custom-design assets", async () => {
    const directory = temporaryDirectory();
    const safe = path.join(directory, "safe.png");
    await writeSolidImage(safe, { width: 200, height: 100, color: "#4477AA", format: "png" });

    await expect(
      generate({
        output_path: path.join(directory, "bad.pptx"),
        project_root: directory,
        slides: [{ layout: "title", title: "Asset" }],
        design: { background: { path: "https://example.com/a.png" } },
      })
    ).rejects.toThrow(/local path|URI/i);

    await expect(
      generate({
        output_path: path.join(directory, "bad2.pptx"),
        project_root: directory,
        slides: [{ layout: "title", title: "Asset" }],
        design: { background: { path: path.join(directory, "missing.png") } },
      })
    ).rejects.toThrow(/missing|unreadable/i);

    await expect(
      generate({
        output_path: path.join(directory, "bad3.pptx"),
        project_root: directory,
        slides: [
          {
            layout: "image_left",
            title: "Composed",
            media: { path: safe },
            table: { headers: [], rows: [] },
          },
        ],
      })
    ).rejects.toThrow(/incompatible|unknown/i);
  });

  it("enforces allowed image roots for new design assets", async () => {
    const projectRoot = temporaryDirectory();
    const assetRoot = temporaryDirectory();
    const outsideAsset = path.join(assetRoot, "outside.png");
    await writeSolidImage(outsideAsset, {
      width: 200,
      height: 100,
      color: "#3355AA",
      format: "png",
    });

    await expect(
      generate({
        output_path: path.join(projectRoot, "blocked.pptx"),
        project_root: projectRoot,
        slides: [{ layout: "image_right", title: "Blocked", media: { path: outsideAsset } }],
      })
    ).rejects.toThrow(/allowed image roots/i);
  });

  it("rejects traversal, URI, and Windows-drive-like asset paths", async () => {
    const directory = temporaryDirectory();
    const driveLikePath =
      process.platform === "win32" ? "C:relative\\escape.png" : "C:\\escape.png";

    await expect(
      generate({
        output_path: path.join(directory, "traversal.pptx"),
        project_root: directory,
        slides: [{ layout: "title", title: "Traversal" }],
        design: { background: { path: "../escape.png" } },
      })
    ).rejects.toThrow(/path traversal/i);

    await expect(
      generate({
        output_path: path.join(directory, "uri.pptx"),
        project_root: directory,
        slides: [{ layout: "title", title: "URI" }],
        design: { background: { path: "data:image/png;base64,AAAA" } },
      })
    ).rejects.toThrow(/local path|URI/i);

    await expect(
      generate({
        output_path: path.join(directory, "drive-like.pptx"),
        project_root: directory,
        slides: [{ layout: "title", title: "Drive" }],
        design: { background: { path: driveLikePath } },
      })
    ).rejects.toThrow(/local path|drive path|URI/i);
  });

  it("rejects symlink escapes outside the allowed image roots", async () => {
    const projectRoot = temporaryDirectory();
    const outsideRoot = temporaryDirectory();
    const outsideAsset = path.join(outsideRoot, "outside.png");
    await writeSolidImage(outsideAsset, {
      width: 180,
      height: 90,
      color: "#8844AA",
      format: "png",
    });

    const linkedDir = path.join(projectRoot, "linked-assets");
    fs.symlinkSync(outsideRoot, linkedDir, process.platform === "win32" ? "junction" : "dir");

    await expect(
      generate({
        output_path: path.join(projectRoot, "symlink-escape.pptx"),
        project_root: projectRoot,
        slides: [
          { layout: "image_left", title: "Symlink", media: { path: "linked-assets/outside.png" } },
        ],
      })
    ).rejects.toThrow(/allowed image roots/i);
  });

  it("rejects oversized and unsupported custom-design assets", async () => {
    const directory = temporaryDirectory();
    const oversized = path.join(directory, "too-big.png");
    fs.writeFileSync(oversized, Buffer.alloc(26 * 1024 * 1024, 0));
    await expect(
      generate({
        output_path: path.join(directory, "too-big.pptx"),
        project_root: directory,
        slides: [{ layout: "title", title: "Big" }],
        design: { background: { path: oversized } },
      })
    ).rejects.toThrow(/25 MiB source limit/i);

    const pixelOversized = path.join(directory, "too-many-pixels.png");
    writeHeaderOnlyPng(pixelOversized, 20_001, 2_000);
    expect(fs.statSync(pixelOversized).size).toBeLessThan(128);
    await expect(
      generate({
        output_path: path.join(directory, "too-many-pixels.pptx"),
        project_root: directory,
        slides: [{ layout: "title", title: "Pixels" }],
        design: { background: { path: pixelOversized } },
      })
    ).rejects.toThrow("deck background asset exceeds the 40,000,000 pixel limit");

    const unsupported = path.join(directory, "unsupported.bmp");
    fs.writeFileSync(unsupported, Buffer.from("BMnot-a-supported-bitmap", "utf8"));
    await expect(
      generate({
        output_path: path.join(directory, "unsupported.pptx"),
        project_root: directory,
        slides: [{ layout: "title", title: "Unsupported" }],
        design: { background: { path: unsupported } },
      })
    ).rejects.toThrow(/\.png, \.jpg, or \.jpeg extension|static PNG or JPEG/i);
  });

  it("embeds the snapshotted asset even if the source changes after preflight", async () => {
    const directory = temporaryDirectory();
    const media = path.join(directory, "snapshot-source.png");
    await writeSolidImage(media, { width: 240, height: 120, color: "#CC2222", format: "png" });

    const outcome = await runGenerator(
      {
        output_path: path.join(directory, "snapshot-stable.pptx"),
        project_root: directory,
        slides: [{ layout: "image_right", title: "Snapshot", media: { path: media } }],
      },
      undefined,
      {
        hooks: {
          before_render: async () => {
            await writeSolidImage(media, {
              width: 240,
              height: 120,
              color: "#22CC22",
              format: "png",
            });
          },
        },
      }
    );
    if (outcome.cancelled || !outcome.result) {
      throw new Error("Generation unexpectedly cancelled");
    }

    const pptx = await openPptx(outcome.result.path);
    const mediaPart = requireDefined(
      pptx.names.find((name) => name.startsWith("ppt/media/")),
      "snapshotted media part was not embedded"
    );
    const stats = await (await import("sharp")).default(await pptx.bytes(mediaPart)).stats();
    const red = requireDefined(stats.channels[0], "embedded snapshot has no red channel").mean;
    const green = requireDefined(stats.channels[1], "embedded snapshot has no green channel").mean;
    expect(red).toBeGreaterThan(green + 80);
  });

  it("runs end-to-end through the registered powerpoint_generate tool", async () => {
    const projectRoot = temporaryDirectory();
    const previousProjectRoot = process.env.PROJECT_ROOT;
    process.env.PROJECT_ROOT = projectRoot;
    const harness = createExtensionApiHarness();

    try {
      extension(harness.api);
      const tool = requirePowerpointTool(harness.registeredTools[0]);
      const response = requirePowerpointToolResult(
        await tool.execute("call-1", {
          slides: [{ layout: "title", title: "Tool Path" }],
          output_path: "tool-output/deck.pptx",
        })
      );
      const deckPath = requireString(response.details.path, "tool result omitted the deck path");
      expect(deckPath).toBe(path.join(projectRoot, "tool-output", "deck.pptx"));
      expect(fs.existsSync(deckPath)).toBe(true);
      const pptx = await openPptx(deckPath);
      expect(joinedText(await pptx.text(slidePart(1)))).toContain("Tool Path");
    } finally {
      if (previousProjectRoot === undefined) delete process.env.PROJECT_ROOT;
      else process.env.PROJECT_ROOT = previousProjectRoot;
    }
  });

  it("re-encodes embedded custom-design media without leaking metadata and keeps relationships internal", async () => {
    const directory = temporaryDirectory();
    const media = path.join(directory, "gradient.png");
    await writeGradientImage(media, 600, 300);
    const { result, pptx } = await generateDeck({
      output_path: path.join(directory, "media.pptx"),
      project_root: directory,
      slides: [{ layout: "image_right", title: "Media", media: { path: media } }],
    });
    const mediaPart = requireDefined(
      pptx.names.find((name) => name.startsWith("ppt/media/")),
      "re-encoded media part was not embedded"
    );
    const embedded = await pptx.bytes(mediaPart);
    expect(embedded.includes(Buffer.from(directory))).toBe(false);
    expect(await pptx.text(slideRelsPart(1))).not.toContain('TargetMode="External"');
    expect(await pptx.text(slideRelsPart(1))).toContain("../media/");
    expect(result.validation.slide_count).toBe(1);
  });

  it("preserves focal-crop intent for full-bleed media", async () => {
    const directory = temporaryDirectory();
    const media = path.join(directory, "gradient.png");
    await writeGradientImage(media, 1200, 600);
    const { pptx } = await generateDeck({
      output_path: path.join(directory, "focal.pptx"),
      project_root: directory,
      slides: [
        {
          layout: "full_bleed",
          title: "Full",
          media: { path: media, focal_point: { x: 0.9, y: 0.5 }, overlay: { opacity: 0.35 } },
        },
      ],
    });
    const mediaPart = requireDefined(
      pptx.names.find((name) => name.startsWith("ppt/media/")),
      "focal-cropped media part was not embedded"
    );
    const stats = await (await import("sharp")).default(await pptx.bytes(mediaPart)).stats();
    const red = requireDefined(stats.channels[0], "focal crop has no red channel").mean;
    expect(red).toBeGreaterThan(140);
    expect(await pptx.text(slidePart(1))).toContain("Penny Full Bleed Text Panel");
    expect(await pptx.text(slidePart(1))).toContain("35000");
  });

  it("rejects over-tall fixed-layout and table content before publication", async () => {
    const directory = temporaryDirectory();
    await expect(
      generate({
        output_path: path.join(directory, "too-long.pptx"),
        project_root: directory,
        slides: [{ layout: "title", title: "unbroken".repeat(1200) }],
      })
    ).rejects.toThrow(/does not fit|overflow/i);
    await expect(
      generate({
        output_path: path.join(directory, "too-tall-row.pptx"),
        project_root: directory,
        slides: [{ layout: "table", table: { headers: ["A"], rows: [["word ".repeat(4000)]] } }],
      })
    ).rejects.toThrow(/single table row/i);
    expect(fs.existsSync(path.join(directory, "too-long.pptx"))).toBe(false);
  });
});
