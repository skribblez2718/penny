import JSZip from "jszip";
import * as fs from "node:fs";
import * as path from "node:path";
import sharp from "sharp";
import { requireDefined } from "./contracts.js";

export interface OpenPptx {
  zip: JSZip;
  names: string[];
  text: (name: string) => Promise<string>;
  bytes: (name: string) => Promise<Buffer>;
}

export async function openPptx(filePath: string): Promise<OpenPptx> {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath), { checkCRC32: true });
  const names = Object.keys(zip.files)
    .filter(
      (name) => !requireDefined(zip.files[name], `ZIP entry disappeared while opening: ${name}`).dir
    )
    .sort();
  return {
    zip,
    names,
    async text(name: string) {
      const file = zip.file(name);
      if (!file) throw new Error(`Missing PPTX part: ${name}`);
      return file.async("string");
    },
    async bytes(name: string) {
      const file = zip.file(name);
      if (!file) throw new Error(`Missing PPTX part: ${name}`);
      return Buffer.from(await file.async("nodebuffer"));
    },
  };
}

export function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

export function extractTextBodies(xml: string): string[] {
  return [...xml.matchAll(/<p:txBody>[\s\S]*?<\/p:txBody>/g)].map((match) =>
    requireDefined(match[0], "text-body match omitted its full value")
  );
}

export function extractTableCells(xml: string): string[] {
  return [...xml.matchAll(/<a:tc>[\s\S]*?<\/a:tc>/g)].map((match) =>
    requireDefined(match[0], "table-cell match omitted its full value")
  );
}

export function countParagraphs(xml: string): number {
  return countMatches(xml, /<a:p>/g);
}

export function countLineBreaks(xml: string): number {
  return countMatches(xml, /<a:br\/>/g);
}

export function countBulletParagraphs(xml: string): number {
  return countMatches(xml, /<a:pPr\b[\s\S]*?<a:bu(?:Char|AutoNum|Blip)\b/g);
}

export function slideTextBodiesContaining(xml: string, text: string): string[] {
  return extractTextBodies(xml).filter((fragment) => joinedText(fragment).includes(text));
}

export function tableCellsContaining(xml: string, text: string): string[] {
  return extractTableCells(xml).filter((fragment) => joinedText(fragment).includes(text));
}

export function slidePart(index: number): string {
  return `ppt/slides/slide${index}.xml`;
}

export function slideRelsPart(index: number): string {
  return `ppt/slides/_rels/slide${index}.xml.rels`;
}

export function notesPart(index: number): string {
  return `ppt/notesSlides/notesSlide${index}.xml`;
}

export function extractShapeNames(xml: string): string[] {
  return [...xml.matchAll(/<p:cNvPr\b[^>]*name="([^"]+)"/g)].map((match) =>
    requireDefined(match[1], "shape-name match omitted its capture")
  );
}

export function extractText(xml: string): string[] {
  return [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) =>
    decodeXml(requireDefined(match[1], "text match omitted its capture"))
  );
}

export function joinedText(xml: string): string {
  return extractText(xml).join("\n");
}

export function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export async function writeSolidImage(
  filePath: string,
  options: { width: number; height: number; color: string; format?: "png" | "jpeg" }
): Promise<void> {
  const format =
    options.format ?? (path.extname(filePath).toLowerCase() === ".png" ? "png" : "jpeg");
  const pipeline = sharp({
    create: {
      width: options.width,
      height: options.height,
      channels: 3,
      background: options.color,
    },
  });
  const buffer =
    format === "png"
      ? await pipeline.png().toBuffer()
      : await pipeline.jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
  fs.writeFileSync(filePath, buffer);
}

export async function writeGradientImage(
  filePath: string,
  width: number,
  height: number
): Promise<void> {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      data[index] = Math.round((x / Math.max(1, width - 1)) * 255);
      data[index + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
      data[index + 2] = 80;
    }
  }
  fs.writeFileSync(
    filePath,
    await sharp(data, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer()
  );
}
