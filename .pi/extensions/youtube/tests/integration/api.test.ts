/**
 * Integration tests for YouTube extension — real API calls for transcript fetching.
 *
 * Requires youtube-transcript package installed.
 * Run with: npm run test:integration
 */

import { describe, expect, it } from "vitest";
import { fetchTranscript as ytTranscript } from "youtube-transcript";

// The public YouTube caption service is mutable and can disable a fixture video
// without notice. Network coverage remains explicit rather than destabilizing
// offline contract gates.
const networkDescribe = process.env.PENNY_YOUTUBE_NETWORK_TESTS === "1" ? describe : describe.skip;

networkDescribe("youtube_transcript integration", () => {
  it("fetches transcript from test video ogTLWGBc3cE", async () => {
    const snippets = await ytTranscript("ogTLWGBc3cE", {
      lang: "en",
    });

    expect(snippets).toBeDefined();
    expect(Array.isArray(snippets)).toBe(true);
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets[0]).toHaveProperty("text");
    expect(snippets[0]).toHaveProperty("offset");
    expect(snippets[0]).toHaveProperty("duration");
    expect(snippets[0].text.length).toBeGreaterThan(0);
  }, 30_000);

  it("fetches transcript and joins text correctly", async () => {
    const snippets = await ytTranscript("ogTLWGBc3cE", {
      lang: "en",
    });

    const transcript = snippets.map((s: { text: string }) => s.text).join(" ");
    expect(transcript).toBeDefined();
    expect(typeof transcript).toBe("string");
    expect(transcript.length).toBeGreaterThan(10);
  }, 30_000);
});
