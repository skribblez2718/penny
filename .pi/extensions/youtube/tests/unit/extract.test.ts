import { describe, expect, it } from "vitest";

import { extractVideoId } from "../../client.js";

const TEST_VIDEO_ID = "ogTLWGBc3cE";
const STANDARD_ID = "dQw4w9WgXcQ";

describe("extractVideoId", () => {
  it("returns raw 11-character video IDs unchanged", () => {
    expect(extractVideoId(TEST_VIDEO_ID)).toBe(TEST_VIDEO_ID);
    expect(extractVideoId(STANDARD_ID)).toBe(STANDARD_ID);
  });

  it("extracts standard, short, embed, and shorts URLs", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=ogTLWGBc3cE")).toBe(TEST_VIDEO_ID);
    expect(extractVideoId("https://youtube.com/watch?v=dQw4w9WgXcQ")).toBe(STANDARD_ID);
    expect(extractVideoId("https://youtu.be/ogTLWGBc3cE")).toBe(TEST_VIDEO_ID);
    expect(extractVideoId("youtu.be/dQw4w9WgXcQ")).toBe(STANDARD_ID);
    expect(extractVideoId("https://www.youtube.com/embed/ogTLWGBc3cE")).toBe(TEST_VIDEO_ID);
    expect(extractVideoId("https://www.youtube.com/shorts/ogTLWGBc3cE")).toBe(TEST_VIDEO_ID);
  });

  it("extracts IDs when query parameters or fragments follow them", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=ogTLWGBc3cE&feature=share")).toBe(
      TEST_VIDEO_ID
    );
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=123")).toBe(STANDARD_ID);
    expect(extractVideoId("https://www.youtube.com/watch?v=ogTLWGBc3cE#t=10")).toBe(TEST_VIDEO_ID);
  });

  it("rejects missing and non-YouTube inputs", () => {
    expect(() => extractVideoId("")).toThrow(/URL or video ID is required/);
    expect(() => extractVideoId("not-a-video-id")).toThrow(/Could not extract/);
    expect(() => extractVideoId("https://non-youtube.com/watch?v=ogTLWGBc3cE")).toThrow(
      /Could not extract/
    );
  });

  it("preserves captured ID case", () => {
    expect(extractVideoId("https://WWW.YOUTUBE.COM/watch?v=ogTLWGBc3cE")).toBe(TEST_VIDEO_ID);
    expect(extractVideoId("https://YOUTU.BE/OGTLWGBc3cE")).toBe("OGTLWGBc3cE");
  });

  it("trims surrounding whitespace", () => {
    expect(extractVideoId("  https://youtu.be/ogTLWGBc3cE  ")).toBe(TEST_VIDEO_ID);
    expect(extractVideoId("  ogTLWGBc3cE  ")).toBe(TEST_VIDEO_ID);
  });
});
