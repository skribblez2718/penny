import JSZip from "jszip";
import * as fs from "node:fs";

export async function openDocx(docxPath: string): Promise<{
  buffer: Buffer;
  names: string[];
  text: (member: string) => Promise<string>;
}> {
  const buffer = fs.readFileSync(docxPath);
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  return {
    buffer,
    names: Object.keys(zip.files).filter((name) => !zip.files[name]?.dir),
    text: async (member: string) => {
      const file = zip.file(member);
      if (!file) throw new Error(`Missing DOCX member: ${member}`);
      return file.async("string");
    },
  };
}

export function countMatches(input: string, pattern: RegExp): number {
  return [...input.matchAll(pattern)].length;
}

export function styleBlock(stylesXml: string, styleId: string): string {
  const match = new RegExp(
    `<w:style[^>]*w:styleId="${escapeRegExp(styleId)}"[\\s\\S]*?<\\/w:style>`
  ).exec(stylesXml);
  if (!match) throw new Error(`Missing style ${styleId}`);
  return match[0];
}

export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function tinyPngBuffer(): Buffer {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p7x8AAAAASUVORK5CYII=",
    "base64"
  );
}
