import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { validateMp4Video } from "../dist/mp4-media.js";

const FIXTURE = readFileSync(new URL("./fixtures/videogen/tiny-h264.mp4", import.meta.url));
const EXPECTED = { width: 64, height: 64, frame_count: 3, fps: 3, max_bytes: 1_048_576 };

describe("bounded MP4 media admission", () => {
  it("admits the exact bounded H.264 fixture and reports structural metadata", () => {
    expect(validateMp4Video(FIXTURE, EXPECTED)).toEqual({
      status: "valid",
      metadata: {
        container: "iso-bmff",
        codec: "h264",
        width: 64,
        height: 64,
        frame_count: 3,
        fps: 3,
        duration_seconds: 1,
        major_brand: "isom",
        compatible_brands: ["isom", "iso2", "avc1", "mp41"],
        byte_length: 1674,
        sha256: "641aa40725b6249d134c52d7d04f4199d575f4c76a7154281a8c6457026c1c9a",
      },
    });
  });

  it("rejects request-metadata mismatches", () => {
    expect(validateMp4Video(FIXTURE, { ...EXPECTED, width: 128 })).toMatchObject({
      status: "invalid",
      reason_code: "dimensions_mismatch",
    });
    expect(validateMp4Video(FIXTURE, { ...EXPECTED, frame_count: 4 })).toMatchObject({
      status: "invalid",
      reason_code: "frame_count_mismatch",
    });
    expect(validateMp4Video(FIXTURE, { ...EXPECTED, fps: 24 })).toMatchObject({
      status: "invalid",
      reason_code: "frame_rate_mismatch",
    });
  });

  it("rejects incoherent time-to-sample and sample-size tables", () => {
    const incoherent = Buffer.from(FIXTURE);
    const sttsTypeOffset = incoherent.indexOf("stts", 0, "latin1");
    expect(sttsTypeOffset).toBeGreaterThan(4);
    const sampleCountOffset = sttsTypeOffset + 12;
    const sampleDeltaOffset = sttsTypeOffset + 16;
    expect(incoherent.readUInt32BE(sampleCountOffset)).toBe(3);
    expect(incoherent.readUInt32BE(sampleDeltaOffset)).toBe(4096);
    incoherent.writeUInt32BE(1, sampleCountOffset);
    incoherent.writeUInt32BE(12_288, sampleDeltaOffset);
    expect(validateMp4Video(incoherent, EXPECTED)).toMatchObject({
      status: "invalid",
      reason_code: "malformed_iso_bmff",
      detail: "time-to-sample and sample-size tables disagree on frame count",
    });
  });

  it("rejects non-MP4, truncated, oversized, and corrupted sample payloads", () => {
    expect(validateMp4Video(Buffer.from("not an mp4"), EXPECTED)).toMatchObject({
      status: "invalid",
      reason_code: "malformed_iso_bmff",
    });
    expect(validateMp4Video(FIXTURE.subarray(0, 100), EXPECTED)).toMatchObject({
      status: "invalid",
      reason_code: "malformed_iso_bmff",
    });
    expect(validateMp4Video(FIXTURE, { ...EXPECTED, max_bytes: 100 })).toMatchObject({
      status: "invalid",
      reason_code: "media_too_large",
    });
    const corrupted = Buffer.from(FIXTURE);
    corrupted.fill(0, corrupted.byteLength - 16);
    expect(validateMp4Video(corrupted, EXPECTED)).toMatchObject({
      status: "invalid",
      reason_code: "malformed_iso_bmff",
    });
  });
});
