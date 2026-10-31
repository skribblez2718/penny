import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PNG_MEDIA_LIMITS,
  PngMediaError,
  canonicalPngImageContent,
  decodePng,
  encodeCanonicalPng,
  resolvePngMediaLimits,
  sanitizePng,
  validateCanonicalPng,
  type PngMediaLimits,
} from "../dist/png-media.js";

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const payload = Buffer.from(data);
  const output = Buffer.alloc(12 + payload.length);
  output.writeUInt32BE(payload.length, 0);
  typeBytes.copy(output, 4);
  payload.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), 8 + payload.length);
  return output;
}

interface ChunkPart {
  readonly type: string;
  readonly data: Buffer;
}

function parts(bytes: Uint8Array): ChunkPart[] {
  const source = Buffer.from(bytes);
  const output: ChunkPart[] = [];
  let offset = 8;
  while (offset < source.length) {
    const length = source.readUInt32BE(offset);
    output.push({
      type: source.toString("ascii", offset + 4, offset + 8),
      data: Buffer.from(source.subarray(offset + 8, offset + 8 + length)),
    });
    offset += 12 + length;
  }
  return output;
}

function png(partsInput: readonly ChunkPart[]): Buffer {
  return Buffer.concat([SIGNATURE, ...partsInput.map((part) => chunk(part.type, part.data))]);
}

function replacePart(
  bytes: Uint8Array,
  type: string,
  replacement: (part: ChunkPart) => ChunkPart
): Buffer {
  return png(parts(bytes).map((part) => (part.type === type ? replacement(part) : part)));
}

function insertBeforeIdat(bytes: Uint8Array, part: ChunkPart): Buffer {
  const source = parts(bytes);
  const index = source.findIndex((candidate) => candidate.type === "IDAT");
  return png([...source.slice(0, index), part, ...source.slice(index)]);
}

function limits(overrides: Partial<PngMediaLimits>): PngMediaLimits {
  return resolvePngMediaLimits({}, overrides);
}

function tiny(): Buffer {
  return Buffer.from(
    encodeCanonicalPng({
      width: 2,
      height: 1,
      rgba: Uint8Array.from([255, 0, 0, 255, 0, 128, 255, 64]),
    })
  );
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function expectCode(run: () => unknown, code: PngMediaError["code"]): void {
  try {
    run();
  } catch (error) {
    if (!(error instanceof PngMediaError)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("bounded canonical PNG media", () => {
  it("encodes, fully decodes, and emits the installed Pi image-content contract", () => {
    const bytes = tiny();
    const decoded = decodePng(bytes);
    expect(decoded.info).toMatchObject({
      width: 2,
      height: 1,
      bitDepth: 8,
      colorType: 6,
      channels: 4,
      pixelCount: 2,
      decodedBytes: 8,
    });
    expect([...decoded.rgba]).toEqual([255, 0, 0, 255, 0, 128, 255, 64]);
    expect(validateCanonicalPng(bytes)).toEqual(decoded.info);

    const delivered = canonicalPngImageContent(bytes);
    expect(delivered.content).toEqual({
      type: "image",
      data: bytes.toString("base64"),
      mimeType: "image/png",
    });
  });

  it("strips bounded ancillary metadata by re-encoding without changing pixels", () => {
    const canonical = tiny();
    const metadataBearing = insertBeforeIdat(canonical, {
      type: "tEXt",
      data: Buffer.from("prompt\0private workflow/path/profile material", "latin1"),
    });
    const before = decodePng(metadataBearing);
    expectCode(() => validateCanonicalPng(metadataBearing), "PNG_NOT_CANONICAL");

    const sanitized = sanitizePng(metadataBearing);
    const after = decodePng(sanitized.bytes);
    expect([...after.rgba]).toEqual([...before.rgba]);
    expect(parts(sanitized.bytes).map((part) => part.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(Buffer.from(sanitized.bytes).includes(Buffer.from("private workflow"))).toBe(false);
    expect(validateCanonicalPng(sanitized.bytes)).toEqual(sanitized.info);
  });

  it("accepts the documented grayscale/RGB alpha variants and canonicalizes to RGBA", () => {
    const cases = [
      { colorType: 0, channels: [90], expected: [90, 90, 90, 255] },
      { colorType: 2, channels: [1, 2, 3], expected: [1, 2, 3, 255] },
      { colorType: 4, channels: [90, 7], expected: [90, 90, 90, 7] },
      { colorType: 6, channels: [1, 2, 3, 4], expected: [1, 2, 3, 4] },
    ] as const;
    for (const fixture of cases) {
      const header = Buffer.alloc(13);
      header.writeUInt32BE(1, 0);
      header.writeUInt32BE(1, 4);
      header[8] = 8;
      header[9] = fixture.colorType;
      const source = png([
        { type: "IHDR", data: header },
        { type: "IDAT", data: deflateSync(Buffer.from([0, ...fixture.channels])) },
        { type: "IEND", data: Buffer.alloc(0) },
      ]);
      expect([...decodePng(source).rgba]).toEqual(fixture.expected);
      expect([...decodePng(sanitizePng(source).bytes).rgba]).toEqual(fixture.expected);
    }
  });

  it("rejects malformed signatures, chunks, CRCs, required structure, and trailing bytes", () => {
    const canonical = tiny();
    expectCode(() => decodePng(Buffer.from("not-png")), "PNG_SIGNATURE_INVALID");
    expectCode(
      () => decodePng(canonical.subarray(0, canonical.length - 2)),
      "PNG_STRUCTURE_INVALID"
    );

    const badCrc = Buffer.from(canonical);
    badCrc[badCrc.length - 1] = (badCrc[badCrc.length - 1] ?? 0) ^ 1;
    expectCode(() => decodePng(badCrc), "PNG_CRC_INVALID");

    const malformedHeader = png(
      parts(canonical).map((part) =>
        part.type === "IHDR" ? { ...part, data: part.data.subarray(0, 12) } : part
      )
    );
    expectCode(() => decodePng(malformedHeader), "PNG_STRUCTURE_INVALID");

    const missingEnd = png(parts(canonical).filter((part) => part.type !== "IEND"));
    expectCode(() => decodePng(missingEnd), "PNG_STRUCTURE_INVALID");
    expectCode(
      () => decodePng(Buffer.concat([canonical, Buffer.from([0])])),
      "PNG_STRUCTURE_INVALID"
    );
  });

  it("rejects APNG, duplicate singleton chunks, unknown critical chunks, and split IDAT order", () => {
    const canonical = tiny();
    expectCode(
      () =>
        decodePng(
          insertBeforeIdat(canonical, {
            type: "acTL",
            data: Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]),
          })
        ),
      "PNG_APNG_UNSUPPORTED"
    );
    const gamma = { type: "gAMA", data: Buffer.from([0, 0, 177, 143]) };
    expectCode(
      () => decodePng(insertBeforeIdat(insertBeforeIdat(canonical, gamma), gamma)),
      "PNG_STRUCTURE_INVALID"
    );
    expectCode(
      () => decodePng(insertBeforeIdat(canonical, { type: "ABCD", data: Buffer.alloc(0) })),
      "PNG_UNSUPPORTED"
    );

    const canonicalParts = parts(canonical);
    const idat = canonicalParts.find((part) => part.type === "IDAT");
    if (idat === undefined) throw new Error("fixture IDAT missing");
    const split = png([
      required(canonicalParts[0], "fixture IHDR missing"),
      { type: "IDAT", data: idat.data.subarray(0, 2) },
      { type: "tIME", data: Buffer.alloc(7) },
      { type: "IDAT", data: idat.data.subarray(2) },
      required(canonicalParts.at(-1), "fixture IEND missing"),
    ]);
    expectCode(() => decodePng(split), "PNG_STRUCTURE_INVALID");
  });

  it("rejects invalid DEFLATE, trailing compressed bytes, and invalid scanline filters", () => {
    const canonical = tiny();
    const invalidDeflate = replacePart(canonical, "IDAT", () => ({
      type: "IDAT",
      data: Buffer.from([1, 2, 3]),
    }));
    expectCode(() => decodePng(invalidDeflate), "PNG_DECODE_INVALID");

    const trailingDeflate = replacePart(canonical, "IDAT", (part) => ({
      type: "IDAT",
      data: Buffer.concat([part.data, Buffer.from("trailing")]),
    }));
    expectCode(() => decodePng(trailingDeflate), "PNG_DECODE_INVALID");

    const invalidFilter = replacePart(canonical, "IDAT", () => ({
      type: "IDAT",
      data: deflateSync(Buffer.from([5, 255, 0, 0, 255, 0, 128, 255, 64])),
    }));
    expectCode(() => decodePng(invalidFilter), "PNG_DECODE_INVALID");
  });

  it("enforces source, compressed, ancillary, dimension, decoded-byte, and pixel ceilings", () => {
    const canonical = tiny();
    expectCode(
      () => decodePng(canonical, limits({ maxSourceBytes: canonical.length - 1 })),
      "PNG_SOURCE_TOO_LARGE"
    );
    const compressedBytes = parts(canonical).find((part) => part.type === "IDAT")?.data.length ?? 0;
    expectCode(
      () => decodePng(canonical, limits({ maxCompressedBytes: compressedBytes - 1 })),
      "PNG_COMPRESSED_TOO_LARGE"
    );
    expectCode(
      () =>
        decodePng(
          insertBeforeIdat(canonical, { type: "tEXt", data: Buffer.alloc(9, 65) }),
          limits({ maxAncillaryChunkBytes: 8 })
        ),
      "PNG_ANCILLARY_TOO_LARGE"
    );
    const aggregateAncillary = insertBeforeIdat(
      insertBeforeIdat(canonical, { type: "aaAa", data: Buffer.alloc(6, 65) }),
      { type: "bbBb", data: Buffer.alloc(6, 66) }
    );
    expectCode(
      () => decodePng(aggregateAncillary, limits({ maxAncillaryBytes: 10 })),
      "PNG_ANCILLARY_TOO_LARGE"
    );
    expectCode(() => decodePng(canonical, limits({ maxWidth: 1 })), "PNG_DIMENSIONS_EXCEEDED");
    expectCode(
      () => decodePng(canonical, limits({ maxDecompressedBytes: 8 })),
      "PNG_DECOMPRESSED_TOO_LARGE"
    );
    expectCode(() => decodePng(canonical, limits({ maxPixels: 1 })), "PNG_PIXELS_EXCEEDED");

    const bombHeader = Buffer.from(required(parts(canonical)[0], "fixture IHDR missing").data);
    bombHeader.writeUInt32BE(8_192, 0);
    bombHeader.writeUInt32BE(8_192, 4);
    const pixelBomb = png([{ type: "IHDR", data: bombHeader }, ...parts(canonical).slice(1)]);
    expectCode(() => decodePng(pixelBomb), "PNG_PIXELS_EXCEEDED");
  });

  it("fails closed on malformed limit configuration", () => {
    expectCode(() => resolvePngMediaLimits({ PENNY_PNG_MAX_WIDTH: "0" }), "PNG_CONFIG_INVALID");
    expectCode(
      () =>
        resolvePngMediaLimits({
          PENNY_PNG_MAX_SOURCE_BYTES: String(DEFAULT_PNG_MEDIA_LIMITS.maxSourceBytes),
          PENNY_PNG_MAX_PIXELS: "not-a-number",
        }),
      "PNG_CONFIG_INVALID"
    );
  });
});
