import { deflateSync, inflateSync } from "node:zlib";

/** Static PNG subset shared by artifact delivery and host-side image admission. */
export interface PngMediaLimits {
  readonly maxSourceBytes: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxPixels: number;
  readonly maxCompressedBytes: number;
  readonly maxDecompressedBytes: number;
  readonly maxAncillaryChunkBytes: number;
  readonly maxAncillaryBytes: number;
}

export const PNG_MEDIA_LIMIT_ENV = {
  maxSourceBytes: "PENNY_PNG_MAX_SOURCE_BYTES",
  maxWidth: "PENNY_PNG_MAX_WIDTH",
  maxHeight: "PENNY_PNG_MAX_HEIGHT",
  maxPixels: "PENNY_PNG_MAX_PIXELS",
  maxCompressedBytes: "PENNY_PNG_MAX_COMPRESSED_BYTES",
  maxDecompressedBytes: "PENNY_PNG_MAX_DECOMPRESSED_BYTES",
  maxAncillaryChunkBytes: "PENNY_PNG_MAX_ANCILLARY_CHUNK_BYTES",
  maxAncillaryBytes: "PENNY_PNG_MAX_ANCILLARY_BYTES",
} as const satisfies Record<keyof PngMediaLimits, string>;

/** Defaults keep one provider image block bounded while admitting common 2K outputs. */
export const DEFAULT_PNG_MEDIA_LIMITS: PngMediaLimits = Object.freeze({
  maxSourceBytes: 16 * 1024 * 1024,
  maxWidth: 8_192,
  maxHeight: 8_192,
  maxPixels: 4_194_304,
  maxCompressedBytes: 16 * 1024 * 1024,
  maxDecompressedBytes: 20 * 1024 * 1024,
  maxAncillaryChunkBytes: 256 * 1024,
  maxAncillaryBytes: 1024 * 1024,
});

/** Callers may lower defaults but cannot exceed these process-safety maxima. */
export const HARD_PNG_MEDIA_LIMITS: PngMediaLimits = Object.freeze({
  maxSourceBytes: 64 * 1024 * 1024,
  maxWidth: 16_384,
  maxHeight: 16_384,
  maxPixels: 16_777_216,
  maxCompressedBytes: 64 * 1024 * 1024,
  maxDecompressedBytes: 68 * 1024 * 1024,
  maxAncillaryChunkBytes: 1024 * 1024,
  maxAncillaryBytes: 4 * 1024 * 1024,
});

export type PngMediaErrorCode =
  | "PNG_CONFIG_INVALID"
  | "PNG_SOURCE_TOO_LARGE"
  | "PNG_SIGNATURE_INVALID"
  | "PNG_STRUCTURE_INVALID"
  | "PNG_CRC_INVALID"
  | "PNG_UNSUPPORTED"
  | "PNG_APNG_UNSUPPORTED"
  | "PNG_ANCILLARY_TOO_LARGE"
  | "PNG_DIMENSIONS_EXCEEDED"
  | "PNG_PIXELS_EXCEEDED"
  | "PNG_COMPRESSED_TOO_LARGE"
  | "PNG_DECOMPRESSED_TOO_LARGE"
  | "PNG_DECODE_INVALID"
  | "PNG_NOT_CANONICAL";

export class PngMediaError extends Error {
  constructor(
    readonly code: PngMediaErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PngMediaError";
  }
}

export interface PngImageInfo {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: 8;
  readonly colorType: 6;
  readonly channels: 4;
  readonly pixelCount: number;
  readonly decodedBytes: number;
  readonly compressedBytes: number;
}

export interface DecodedPng {
  readonly info: PngImageInfo;
  readonly rgba: Uint8Array;
}

export interface SanitizedPng {
  readonly bytes: Uint8Array;
  readonly info: PngImageInfo;
}

/** Structural image content contract used by the installed Pi SDK. */
export interface PngImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: "image/png";
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const APNG_CHUNKS = new Set(["acTL", "fcTL", "fdAT"]);
const KNOWN_CRITICAL_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
const SINGLETON_ANCILLARY_CHUNKS = new Set([
  "cHRM",
  "gAMA",
  "iCCP",
  "sBIT",
  "sRGB",
  "bKGD",
  "hIST",
  "tRNS",
  "pHYs",
  "tIME",
  "eXIf",
]);
const BEFORE_IDAT_ANCILLARY_CHUNKS = new Set([
  "cHRM",
  "gAMA",
  "iCCP",
  "sBIT",
  "sRGB",
  "bKGD",
  "hIST",
  "tRNS",
  "pHYs",
]);

interface ParsedPng {
  readonly width: number;
  readonly height: number;
  readonly colorType: 0 | 2 | 4 | 6;
  readonly channels: 1 | 2 | 3 | 4;
  readonly expectedInflatedBytes: number;
  readonly idat: Buffer;
  readonly idatChunkCount: number;
  readonly chunkTypes: readonly string[];
  readonly ancillaryChunkCount: number;
  readonly transparency?: Buffer;
}

function checkedPositiveInteger(name: string, value: number, hardMaximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > hardMaximum) {
    throw new PngMediaError(
      "PNG_CONFIG_INVALID",
      `${name} must be a positive safe integer no greater than ${hardMaximum}`
    );
  }
  return value;
}

/** Resolve optional lower deployment ceilings without permitting a runtime cap increase. */
function validatedPngMediaLimits(limits: PngMediaLimits): PngMediaLimits {
  checkedPositiveInteger(
    "maxSourceBytes",
    limits.maxSourceBytes,
    HARD_PNG_MEDIA_LIMITS.maxSourceBytes
  );
  checkedPositiveInteger("maxWidth", limits.maxWidth, HARD_PNG_MEDIA_LIMITS.maxWidth);
  checkedPositiveInteger("maxHeight", limits.maxHeight, HARD_PNG_MEDIA_LIMITS.maxHeight);
  checkedPositiveInteger("maxPixels", limits.maxPixels, HARD_PNG_MEDIA_LIMITS.maxPixels);
  checkedPositiveInteger(
    "maxCompressedBytes",
    limits.maxCompressedBytes,
    HARD_PNG_MEDIA_LIMITS.maxCompressedBytes
  );
  checkedPositiveInteger(
    "maxDecompressedBytes",
    limits.maxDecompressedBytes,
    HARD_PNG_MEDIA_LIMITS.maxDecompressedBytes
  );
  checkedPositiveInteger(
    "maxAncillaryChunkBytes",
    limits.maxAncillaryChunkBytes,
    HARD_PNG_MEDIA_LIMITS.maxAncillaryChunkBytes
  );
  checkedPositiveInteger(
    "maxAncillaryBytes",
    limits.maxAncillaryBytes,
    HARD_PNG_MEDIA_LIMITS.maxAncillaryBytes
  );
  return limits;
}

function configuredLimit(
  key: keyof PngMediaLimits,
  env: Readonly<Record<string, string | undefined>>,
  overrides: Partial<PngMediaLimits>
): number {
  const override = overrides[key];
  const configured = env[PNG_MEDIA_LIMIT_ENV[key]];
  let value: number;
  if (override !== undefined) {
    value = override;
  } else if (configured !== undefined) {
    if (!/^[1-9][0-9]*$/u.test(configured)) {
      throw new PngMediaError(
        "PNG_CONFIG_INVALID",
        `${PNG_MEDIA_LIMIT_ENV[key]} must be a positive base-10 integer`
      );
    }
    value = Number(configured);
  } else {
    value = DEFAULT_PNG_MEDIA_LIMITS[key];
  }
  return checkedPositiveInteger(key, value, HARD_PNG_MEDIA_LIMITS[key]);
}

export function resolvePngMediaLimits(
  env: Readonly<Record<string, string | undefined>> = {},
  overrides: Partial<PngMediaLimits> = {}
): PngMediaLimits {
  return Object.freeze({
    maxSourceBytes: configuredLimit("maxSourceBytes", env, overrides),
    maxWidth: configuredLimit("maxWidth", env, overrides),
    maxHeight: configuredLimit("maxHeight", env, overrides),
    maxPixels: configuredLimit("maxPixels", env, overrides),
    maxCompressedBytes: configuredLimit("maxCompressedBytes", env, overrides),
    maxDecompressedBytes: configuredLimit("maxDecompressedBytes", env, overrides),
    maxAncillaryChunkBytes: configuredLimit("maxAncillaryChunkBytes", env, overrides),
    maxAncillaryBytes: configuredLimit("maxAncillaryBytes", env, overrides),
  });
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function colorMode(value: number | undefined):
  | {
      readonly colorType: ParsedPng["colorType"];
      readonly channels: ParsedPng["channels"];
    }
  | undefined {
  if (value === 0) return { colorType: 0, channels: 1 };
  if (value === 2) return { colorType: 2, channels: 3 };
  if (value === 4) return { colorType: 4, channels: 2 };
  if (value === 6) return { colorType: 6, channels: 4 };
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInflateResult(value: unknown): value is {
  readonly buffer: Uint8Array;
  readonly engine: { readonly bytesWritten: number };
} {
  return (
    isRecord(value) &&
    value.buffer instanceof Uint8Array &&
    isRecord(value.engine) &&
    typeof value.engine.bytesWritten === "number"
  );
}

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

function crc32(parts: readonly Uint8Array[]): number {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (const byte of part) {
      crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safeProduct(left: number, right: number, errorCode: PngMediaErrorCode): number {
  const product = left * right;
  if (!Number.isSafeInteger(product)) {
    throw new PngMediaError(errorCode, "PNG dimensions exceed safe integer arithmetic");
  }
  return product;
}

function parsePng(bytes: Uint8Array, limits: PngMediaLimits): ParsedPng {
  const source = asBuffer(bytes);
  if (source.length > limits.maxSourceBytes) {
    throw new PngMediaError("PNG_SOURCE_TOO_LARGE", "PNG source exceeds the configured byte limit");
  }
  if (source.length < PNG_SIGNATURE.length || !source.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new PngMediaError("PNG_SIGNATURE_INVALID", "PNG signature is invalid");
  }

  let offset = PNG_SIGNATURE.length;
  let width: number | undefined;
  let height: number | undefined;
  let colorType: ParsedPng["colorType"] | undefined;
  let channels: ParsedPng["channels"] | undefined;
  let expectedInflatedBytes: number | undefined;
  let seenHeader = false;
  let seenIdat = false;
  let idatEnded = false;
  let seenEnd = false;
  let idatBytes = 0;
  let ancillaryBytes = 0;
  let ancillaryChunkCount = 0;
  let transparency: Buffer | undefined;
  const idatParts: Buffer[] = [];
  const chunkTypes: string[] = [];
  const singletonAncillary = new Set<string>();

  while (offset < source.length) {
    if (seenEnd) {
      throw new PngMediaError("PNG_STRUCTURE_INVALID", "PNG contains trailing data after IEND");
    }
    if (source.length - offset < 12) {
      throw new PngMediaError("PNG_STRUCTURE_INVALID", "PNG chunk header is truncated");
    }
    const length = source.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > source.length) {
      throw new PngMediaError("PNG_STRUCTURE_INVALID", "PNG chunk data is truncated");
    }
    const typeBytes = source.subarray(offset + 4, offset + 8);
    if (
      !isAsciiLetter(typeBytes[0] ?? 0) ||
      !isAsciiLetter(typeBytes[1] ?? 0) ||
      !isAsciiLetter(typeBytes[2] ?? 0) ||
      !isAsciiLetter(typeBytes[3] ?? 0) ||
      ((typeBytes[2] ?? 0) & 0x20) !== 0
    ) {
      throw new PngMediaError("PNG_STRUCTURE_INVALID", "PNG chunk type is invalid");
    }
    const type = typeBytes.toString("ascii");
    const data = source.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = source.readUInt32BE(offset + 8 + length);
    if (crc32([typeBytes, data]) !== expectedCrc) {
      throw new PngMediaError("PNG_CRC_INVALID", `PNG ${type} chunk CRC is invalid`);
    }
    chunkTypes.push(type);

    const ancillary = ((typeBytes[0] ?? 0) & 0x20) !== 0;
    if (!ancillary && !KNOWN_CRITICAL_CHUNKS.has(type)) {
      throw new PngMediaError("PNG_UNSUPPORTED", `PNG critical chunk ${type} is unsupported`);
    }
    if (APNG_CHUNKS.has(type)) {
      throw new PngMediaError("PNG_APNG_UNSUPPORTED", "Animated PNG is unsupported");
    }

    if (ancillary) {
      ancillaryChunkCount += 1;
      if (length > limits.maxAncillaryChunkBytes) {
        throw new PngMediaError(
          "PNG_ANCILLARY_TOO_LARGE",
          `PNG ancillary chunk ${type} exceeds the per-chunk limit`
        );
      }
      ancillaryBytes += length;
      if (ancillaryBytes > limits.maxAncillaryBytes) {
        throw new PngMediaError(
          "PNG_ANCILLARY_TOO_LARGE",
          "PNG ancillary chunks exceed the aggregate limit"
        );
      }
      if (SINGLETON_ANCILLARY_CHUNKS.has(type)) {
        if (singletonAncillary.has(type)) {
          throw new PngMediaError(
            "PNG_STRUCTURE_INVALID",
            `PNG singleton ancillary chunk ${type} is duplicated`
          );
        }
        singletonAncillary.add(type);
      }
      if (seenIdat && BEFORE_IDAT_ANCILLARY_CHUNKS.has(type)) {
        throw new PngMediaError(
          "PNG_STRUCTURE_INVALID",
          `PNG ancillary chunk ${type} appears after IDAT`
        );
      }
    }

    if (type !== "IDAT" && seenIdat) idatEnded = true;
    switch (type) {
      case "IHDR": {
        if (seenHeader || offset !== PNG_SIGNATURE.length || length !== 13) {
          throw new PngMediaError(
            "PNG_STRUCTURE_INVALID",
            "PNG must contain one 13-byte IHDR as its first chunk"
          );
        }
        seenHeader = true;
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        const bitDepth = data[8];
        const mode = colorMode(data[9]);
        if (width < 1 || height < 1) {
          throw new PngMediaError("PNG_STRUCTURE_INVALID", "PNG dimensions must be positive");
        }
        if (width > limits.maxWidth || height > limits.maxHeight) {
          throw new PngMediaError(
            "PNG_DIMENSIONS_EXCEEDED",
            "PNG dimensions exceed the configured width or height limit"
          );
        }
        const pixelCount = safeProduct(width, height, "PNG_PIXELS_EXCEEDED");
        if (pixelCount > limits.maxPixels) {
          throw new PngMediaError(
            "PNG_PIXELS_EXCEEDED",
            "PNG pixel count exceeds the configured limit"
          );
        }
        if (bitDepth !== 8 || mode === undefined) {
          throw new PngMediaError(
            "PNG_UNSUPPORTED",
            "PNG must use 8-bit grayscale, RGB, grayscale-alpha, or RGBA pixels"
          );
        }
        if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
          throw new PngMediaError(
            "PNG_UNSUPPORTED",
            "PNG compression, filter, and interlace methods must be zero"
          );
        }
        colorType = mode.colorType;
        channels = mode.channels;
        const rowBytes = safeProduct(width, channels, "PNG_DECOMPRESSED_TOO_LARGE");
        expectedInflatedBytes = safeProduct(height, rowBytes + 1, "PNG_DECOMPRESSED_TOO_LARGE");
        if (expectedInflatedBytes > limits.maxDecompressedBytes) {
          throw new PngMediaError(
            "PNG_DECOMPRESSED_TOO_LARGE",
            "PNG decoded scanlines exceed the configured byte limit"
          );
        }
        break;
      }
      case "PLTE":
        throw new PngMediaError("PNG_UNSUPPORTED", "Palette PNG is outside the supported subset");
      case "IDAT": {
        if (!seenHeader || seenEnd || idatEnded) {
          throw new PngMediaError("PNG_STRUCTURE_INVALID", "PNG IDAT chunks are out of order");
        }
        seenIdat = true;
        idatBytes += length;
        if (idatBytes > limits.maxCompressedBytes) {
          throw new PngMediaError(
            "PNG_COMPRESSED_TOO_LARGE",
            "PNG compressed pixels exceed the configured byte limit"
          );
        }
        idatParts.push(data);
        break;
      }
      case "IEND": {
        if (!seenHeader || !seenIdat || seenEnd || length !== 0) {
          throw new PngMediaError("PNG_STRUCTURE_INVALID", "PNG IEND is missing or malformed");
        }
        seenEnd = true;
        if (chunkEnd !== source.length) {
          throw new PngMediaError("PNG_STRUCTURE_INVALID", "PNG contains trailing data after IEND");
        }
        break;
      }
      case "tRNS": {
        if (!seenHeader || colorType === undefined || seenIdat) {
          throw new PngMediaError("PNG_STRUCTURE_INVALID", "PNG tRNS is out of order");
        }
        if ((colorType === 0 && length !== 2) || (colorType === 2 && length !== 6)) {
          throw new PngMediaError("PNG_UNSUPPORTED", "PNG tRNS is invalid for its color type");
        }
        if (colorType === 4 || colorType === 6) {
          throw new PngMediaError("PNG_UNSUPPORTED", "PNG alpha color types cannot contain tRNS");
        }
        transparency = Buffer.from(data);
        break;
      }
      default:
        if (!seenHeader) {
          throw new PngMediaError("PNG_STRUCTURE_INVALID", "PNG IHDR must be the first chunk");
        }
        break;
    }
    offset = chunkEnd;
  }

  if (
    !seenHeader ||
    !seenIdat ||
    !seenEnd ||
    width === undefined ||
    height === undefined ||
    colorType === undefined ||
    channels === undefined ||
    expectedInflatedBytes === undefined
  ) {
    throw new PngMediaError("PNG_STRUCTURE_INVALID", "PNG is missing required chunks");
  }

  return {
    width,
    height,
    colorType,
    channels,
    expectedInflatedBytes,
    idat: Buffer.concat(idatParts, idatBytes),
    idatChunkCount: idatParts.length,
    chunkTypes,
    ancillaryChunkCount,
    ...(transparency === undefined ? {} : { transparency }),
  };
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function sample8From16(data: Buffer, offset: number): number {
  const value = data.readUInt16BE(offset);
  if (value > 255) {
    throw new PngMediaError("PNG_UNSUPPORTED", "PNG tRNS sample exceeds the 8-bit color range");
  }
  return value;
}

function rgbaPixels(parsed: ParsedPng, raw: Buffer): Buffer {
  const pixels = parsed.width * parsed.height;
  const rgba = Buffer.allocUnsafe(pixels * 4);
  let sourceOffset = 0;
  let targetOffset = 0;
  let transparentGray: number | undefined;
  let transparentRgb: readonly [number, number, number] | undefined;
  if (parsed.transparency !== undefined) {
    if (parsed.colorType === 0) {
      transparentGray = sample8From16(parsed.transparency, 0);
    } else if (parsed.colorType === 2) {
      transparentRgb = [
        sample8From16(parsed.transparency, 0),
        sample8From16(parsed.transparency, 2),
        sample8From16(parsed.transparency, 4),
      ];
    }
  }
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    if (parsed.colorType === 0) {
      const gray = raw[sourceOffset] ?? 0;
      rgba[targetOffset] = gray;
      rgba[targetOffset + 1] = gray;
      rgba[targetOffset + 2] = gray;
      rgba[targetOffset + 3] = gray === transparentGray ? 0 : 255;
    } else if (parsed.colorType === 2) {
      const red = raw[sourceOffset] ?? 0;
      const green = raw[sourceOffset + 1] ?? 0;
      const blue = raw[sourceOffset + 2] ?? 0;
      rgba[targetOffset] = red;
      rgba[targetOffset + 1] = green;
      rgba[targetOffset + 2] = blue;
      rgba[targetOffset + 3] =
        transparentRgb !== undefined &&
        red === transparentRgb[0] &&
        green === transparentRgb[1] &&
        blue === transparentRgb[2]
          ? 0
          : 255;
    } else if (parsed.colorType === 4) {
      const gray = raw[sourceOffset] ?? 0;
      rgba[targetOffset] = gray;
      rgba[targetOffset + 1] = gray;
      rgba[targetOffset + 2] = gray;
      rgba[targetOffset + 3] = raw[sourceOffset + 1] ?? 0;
    } else {
      rgba[targetOffset] = raw[sourceOffset] ?? 0;
      rgba[targetOffset + 1] = raw[sourceOffset + 1] ?? 0;
      rgba[targetOffset + 2] = raw[sourceOffset + 2] ?? 0;
      rgba[targetOffset + 3] = raw[sourceOffset + 3] ?? 0;
    }
    sourceOffset += parsed.channels;
    targetOffset += 4;
  }
  return rgba;
}

function decodeWithParsed(
  bytes: Uint8Array,
  limits: PngMediaLimits
): {
  readonly parsed: ParsedPng;
  readonly decoded: DecodedPng;
  readonly filters: readonly number[];
} {
  const parsed = parsePng(bytes, limits);
  const inflated = (() => {
    // Keep the filter bytes for canonical checks while using the same bounded decode path.
    let value: Buffer;
    let consumed: number;
    try {
      const result: unknown = inflateSync(parsed.idat, {
        info: true,
        maxOutputLength: parsed.expectedInflatedBytes + 1,
      });
      if (!isInflateResult(result)) {
        throw new PngMediaError(
          "PNG_DECODE_INVALID",
          "PNG inflater did not return decode metadata"
        );
      }
      value = Buffer.from(result.buffer);
      consumed = result.engine.bytesWritten;
    } catch {
      throw new PngMediaError("PNG_DECODE_INVALID", "PNG DEFLATE stream is invalid or oversized");
    }
    if (consumed !== parsed.idat.length) {
      throw new PngMediaError("PNG_DECODE_INVALID", "PNG DEFLATE stream contains trailing data");
    }
    if (value.length !== parsed.expectedInflatedBytes) {
      throw new PngMediaError("PNG_DECODE_INVALID", "PNG decoded scanline length is invalid");
    }
    return value;
  })();
  const rowBytes = parsed.width * parsed.channels;
  const filters = Array.from(
    { length: parsed.height },
    (_, row) => inflated[row * (rowBytes + 1)] ?? -1
  );
  // The second inflate is intentionally avoided: unfilter this already bounded byte stream inline.
  const raw = Buffer.allocUnsafe(rowBytes * parsed.height);
  for (let row = 0; row < parsed.height; row += 1) {
    const sourceOffset = row * (rowBytes + 1);
    const filter = inflated[sourceOffset];
    if (filter === undefined || filter > 4) {
      throw new PngMediaError("PNG_DECODE_INVALID", "PNG scanline filter is invalid");
    }
    const rowOffset = row * rowBytes;
    for (let column = 0; column < rowBytes; column += 1) {
      const encoded = inflated[sourceOffset + 1 + column];
      if (encoded === undefined) {
        throw new PngMediaError("PNG_DECODE_INVALID", "PNG scanline data is truncated");
      }
      const left = column >= parsed.channels ? (raw[rowOffset + column - parsed.channels] ?? 0) : 0;
      const above = row > 0 ? (raw[rowOffset + column - rowBytes] ?? 0) : 0;
      const upperLeft =
        row > 0 && column >= parsed.channels
          ? (raw[rowOffset + column - rowBytes - parsed.channels] ?? 0)
          : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paeth(left, above, upperLeft);
      raw[rowOffset + column] = (encoded + predictor) & 0xff;
    }
  }
  const rgba = rgbaPixels(parsed, raw);
  return {
    parsed,
    decoded: {
      info: {
        width: parsed.width,
        height: parsed.height,
        bitDepth: 8,
        colorType: 6,
        channels: 4,
        pixelCount: parsed.width * parsed.height,
        decodedBytes: rgba.length,
        compressedBytes: parsed.idat.length,
      },
      rgba,
    },
    filters,
  };
}

/** Fully decode the supported static subset into RGBA under all configured limits. */
export function decodePng(
  bytes: Uint8Array,
  limits: PngMediaLimits = DEFAULT_PNG_MEDIA_LIMITS
): DecodedPng {
  return decodeWithParsed(bytes, validatedPngMediaLimits(limits)).decoded;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const payload = asBuffer(data);
  const output = Buffer.allocUnsafe(12 + payload.length);
  output.writeUInt32BE(payload.length, 0);
  typeBytes.copy(output, 4);
  payload.copy(output, 8);
  output.writeUInt32BE(crc32([typeBytes, payload]), 8 + payload.length);
  return output;
}

/** Encode exact RGBA pixels as the canonical metadata-free static PNG shape. */
export function encodeCanonicalPng(input: {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  readonly limits?: PngMediaLimits;
}): Uint8Array {
  const limits = validatedPngMediaLimits(input.limits ?? DEFAULT_PNG_MEDIA_LIMITS);
  if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height)) {
    throw new PngMediaError("PNG_STRUCTURE_INVALID", "PNG dimensions must be safe integers");
  }
  if (input.width < 1 || input.height < 1) {
    throw new PngMediaError("PNG_STRUCTURE_INVALID", "PNG dimensions must be positive");
  }
  if (input.width > limits.maxWidth || input.height > limits.maxHeight) {
    throw new PngMediaError(
      "PNG_DIMENSIONS_EXCEEDED",
      "PNG dimensions exceed the configured width or height limit"
    );
  }
  const pixelCount = safeProduct(input.width, input.height, "PNG_PIXELS_EXCEEDED");
  if (pixelCount > limits.maxPixels) {
    throw new PngMediaError("PNG_PIXELS_EXCEEDED", "PNG pixel count exceeds the configured limit");
  }
  const rgbaLength = safeProduct(pixelCount, 4, "PNG_DECOMPRESSED_TOO_LARGE");
  if (input.rgba.byteLength !== rgbaLength) {
    throw new PngMediaError("PNG_STRUCTURE_INVALID", "RGBA byte length does not match dimensions");
  }
  const scanlineBytes = safeProduct(
    input.height,
    input.width * 4 + 1,
    "PNG_DECOMPRESSED_TOO_LARGE"
  );
  if (scanlineBytes > limits.maxDecompressedBytes) {
    throw new PngMediaError(
      "PNG_DECOMPRESSED_TOO_LARGE",
      "PNG encoded scanlines exceed the configured byte limit"
    );
  }
  const scanlines = Buffer.allocUnsafe(scanlineBytes);
  const rgba = asBuffer(input.rgba);
  const rowBytes = input.width * 4;
  for (let row = 0; row < input.height; row += 1) {
    const target = row * (rowBytes + 1);
    scanlines[target] = 0;
    rgba.copy(scanlines, target + 1, row * rowBytes, (row + 1) * rowBytes);
  }
  const compressed = deflateSync(scanlines, { level: 9 });
  if (compressed.length > limits.maxCompressedBytes) {
    throw new PngMediaError(
      "PNG_COMPRESSED_TOO_LARGE",
      "Canonical PNG compressed pixels exceed the configured byte limit"
    );
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(input.width, 0);
  header.writeUInt32BE(input.height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const encoded = Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  if (encoded.length > limits.maxSourceBytes) {
    throw new PngMediaError(
      "PNG_SOURCE_TOO_LARGE",
      "Canonical PNG exceeds the configured byte limit"
    );
  }
  return encoded;
}

/**
 * Canonical artifacts are metadata-free RGBA PNGs with one IDAT and filter-zero rows.
 * Compression bytes may vary across compatible zlib releases without invalidating old artifacts.
 */
export function validateCanonicalPng(
  bytes: Uint8Array,
  limits: PngMediaLimits = DEFAULT_PNG_MEDIA_LIMITS
): PngImageInfo {
  const { parsed, decoded, filters } = decodeWithParsed(bytes, validatedPngMediaLimits(limits));
  if (
    parsed.ancillaryChunkCount !== 0 ||
    parsed.colorType !== 6 ||
    parsed.idatChunkCount !== 1 ||
    parsed.chunkTypes.length !== 3 ||
    parsed.chunkTypes[0] !== "IHDR" ||
    parsed.chunkTypes[1] !== "IDAT" ||
    parsed.chunkTypes[2] !== "IEND" ||
    filters.some((filter) => filter !== 0)
  ) {
    throw new PngMediaError(
      "PNG_NOT_CANONICAL",
      "PNG artifact is not in the canonical metadata-free RGBA form"
    );
  }
  return decoded.info;
}

/** Fully decode untrusted PNG bytes and re-encode only their visual RGBA pixels. */
export function sanitizePng(
  bytes: Uint8Array,
  limits: PngMediaLimits = DEFAULT_PNG_MEDIA_LIMITS
): SanitizedPng {
  const source = decodePng(bytes, limits);
  const canonical = encodeCanonicalPng({
    width: source.info.width,
    height: source.info.height,
    rgba: source.rgba,
    limits,
  });
  const validated = decodePng(canonical, limits);
  validateCanonicalPng(canonical, limits);
  if (!asBuffer(validated.rgba).equals(asBuffer(source.rgba))) {
    throw new PngMediaError("PNG_DECODE_INVALID", "Canonical PNG did not preserve decoded pixels");
  }
  return { bytes: canonical, info: validated.info };
}

/** Validate once, then place base64 only in Pi's provider-native image field. */
export function canonicalPngImageContent(
  bytes: Uint8Array,
  limits: PngMediaLimits = DEFAULT_PNG_MEDIA_LIMITS
): { readonly info: PngImageInfo; readonly content: PngImageContent } {
  const info = validateCanonicalPng(bytes, limits);
  return {
    info,
    content: {
      type: "image",
      data: asBuffer(bytes).toString("base64"),
      mimeType: "image/png",
    },
  };
}
