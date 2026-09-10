import { describe, expect, it } from "vitest";

import {
  createYoutubeTranscriptProvider,
  fetchTranscript,
  TranscriptLanguagesUnavailableError,
  TranscriptProviderResponseError,
  transcriptToSRT,
  transcriptToWebVTT,
  type MetadataFetch,
  type ProviderTranscriptResult,
  type TranscriptProvider,
  type TranscriptSnippet,
  YoutubeTranscriptNotAvailableLanguageErrorClass,
  YoutubeTranscriptVideoUnavailableErrorClass,
} from "../../client.js";

const VIDEO_ID = "ogTLWGBc3cE";
const METADATA_HTML =
  'var data={"title":"Unicode \\u2713","ownerChannelName":"Author","publishDate":"2026-09-01T00:00:00Z"};';
const metadataFetch: MetadataFetch = async () => new Response(METADATA_HTML);

function providerFrom(
  implementation: (videoId: string, language: string | undefined) => Promise<unknown>,
  timingUnit: "milliseconds" | "seconds" = "milliseconds"
): TranscriptProvider {
  return {
    async fetchTranscript(videoId, language) {
      return { snippets: await implementation(videoId, language), timingUnit };
    },
  };
}

function cue(text: string, offset: number, duration: number, lang = "en") {
  return { text, offset, duration, lang };
}

function parseTimestamp(value: string, separator: "," | "."): number {
  const escapedSeparator = separator === "." ? "\\." : separator;
  const match = value.match(
    new RegExp(`^(\\d{2,}):([0-5]\\d):([0-5]\\d)${escapedSeparator}(\\d{3})$`)
  );
  if (match === null) throw new Error(`invalid caption timestamp: ${value}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds;
}

function parseTimingLine(line: string, separator: "," | "."): [number, number] {
  const pieces = line.split(" --> ");
  if (pieces.length !== 2) throw new Error(`invalid cue timing line: ${line}`);
  const start = parseTimestamp(pieces[0], separator);
  const end = parseTimestamp(pieces[1], separator);
  if (end < start) throw new Error(`cue ends before it starts: ${line}`);
  return [start, end];
}

function parseSrtTimings(srt: string): Array<[number, number]> {
  const blocks = srt.trim().split("\n\n");
  return blocks.map((block, index) => {
    const lines = block.split("\n");
    if (lines.length < 3 || lines[0] !== String(index + 1)) {
      throw new Error(`invalid SRT cue ${index + 1}`);
    }
    return parseTimingLine(lines[1], ",");
  });
}

function parseWebVttTimings(vtt: string): Array<[number, number]> {
  const blocks = vtt.trim().split("\n\n");
  if (blocks[0] !== "WEBVTT") throw new Error("missing WebVTT header");
  return blocks.slice(1).map((block) => {
    const lines = block.split("\n");
    if (lines.length < 2) throw new Error("invalid WebVTT cue");
    return parseTimingLine(lines[0], ".");
  });
}

describe("language selection and provider boundary", () => {
  it.each([
    {
      name: "srv3 integer milliseconds",
      xml: '<transcript><p t="1250" d="1500"><s>Alpha</s></p></transcript>',
    },
    {
      name: "classic decimal seconds",
      xml: '<transcript><text start="1.25" dur="1.5">Alpha</text></transcript>',
    },
  ])("normalizes $name from the installed provider path", async ({ xml }) => {
    const networkCalls: string[] = [];
    const fakeFetch: typeof globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      networkCalls.push(url);
      if (url.includes("/youtubei/v1/player")) {
        return new Response(
          JSON.stringify({
            captions: {
              playerCaptionsTracklistRenderer: {
                captionTracks: [
                  {
                    languageCode: "en",
                    baseUrl: "https://www.youtube.com/api/timedtext?fixture=1",
                  },
                ],
              },
            },
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/api/timedtext")) return new Response(xml);
      throw new Error(`unexpected fake provider request: ${url}`);
    };

    const result = await fetchTranscript(
      VIDEO_ID,
      { format: "srt" },
      { provider: createYoutubeTranscriptProvider(fakeFetch), metadataFetch }
    );

    expect(networkCalls).toEqual([
      "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
      "https://www.youtube.com/api/timedtext?fixture=1",
    ]);
    expect(result.transcript).toContain("00:00:01,250 --> 00:00:02,750");
  });

  it("uses the first language when it is available and preserves text and metadata", async () => {
    const calls: Array<string | undefined> = [];
    const provider = providerFrom(async (_videoId, language) => {
      calls.push(language);
      return [cue("Héllo 世界", 1_250, 1_500, "en")];
    });

    const result = await fetchTranscript(
      VIDEO_ID,
      { languages: ["en", "fr"], format: "text" },
      { provider, metadataFetch }
    );

    expect(calls).toEqual(["en"]);
    expect(result.transcript).toBe("Héllo 世界");
    expect(result.language).toBe("en");
    expect(result.durationSeconds).toBe(2.75);
    expect(result.metadata).toEqual({
      title: "Unicode ✓",
      author: "Author",
      videoId: VIDEO_ID,
    });
    expect(result.publishDate).toBe("2026-09-01");
  });

  it("retries only unavailable tracks in declared preference order", async () => {
    const calls: Array<string | undefined> = [];
    const provider = providerFrom(async (videoId, language) => {
      calls.push(language);
      if (language === "fr") {
        throw new YoutubeTranscriptNotAvailableLanguageErrorClass("fr", ["en"], videoId);
      }
      return [cue("English", 0, 500, "en")];
    });

    const result = await fetchTranscript(
      VIDEO_ID,
      { languages: ["fr", "en"] },
      { provider, metadataFetch }
    );

    expect(calls).toEqual(["fr", "en"]);
    expect(result.transcript).toBe("English");
  });

  it("implements auto by omitting a requested language instead of promising generation", async () => {
    const calls: Array<string | undefined> = [];
    const provider = providerFrom(async (_videoId, language) => {
      calls.push(language);
      return [cue("Disponible", 0, 750, "es")];
    });

    const result = await fetchTranscript(
      VIDEO_ID,
      { languages: ["auto"] },
      { provider, metadataFetch }
    );

    expect(calls).toEqual([undefined]);
    expect(result.language).toBe("es");
  });

  it("treats omitted and empty preference lists as the documented English default", async () => {
    const calls: Array<string | undefined> = [];
    const provider = providerFrom(async (_videoId, language) => {
      calls.push(language);
      return [cue("English", 0, 500)];
    });

    await fetchTranscript(VIDEO_ID, {}, { provider, metadataFetch });
    await fetchTranscript(VIDEO_ID, { languages: [] }, { provider, metadataFetch });

    expect(calls).toEqual(["en", "en"]);
  });

  it("reports all-unavailable preferences after trying each one", async () => {
    const calls: Array<string | undefined> = [];
    const provider = providerFrom(async (videoId, language) => {
      calls.push(language);
      throw new YoutubeTranscriptNotAvailableLanguageErrorClass(
        language ?? "auto",
        ["de"],
        videoId
      );
    });

    await expect(
      fetchTranscript(VIDEO_ID, { languages: ["fr", "en"] }, { provider, metadataFetch })
    ).rejects.toBeInstanceOf(TranscriptLanguagesUnavailableError);
    expect(calls).toEqual(["fr", "en"]);
  });

  it("does not retry terminal video failures", async () => {
    const calls: Array<string | undefined> = [];
    const terminal = new YoutubeTranscriptVideoUnavailableErrorClass(VIDEO_ID);
    const provider = providerFrom(async (_videoId, language) => {
      calls.push(language);
      throw terminal;
    });

    await expect(
      fetchTranscript(VIDEO_ID, { languages: ["fr", "en", "auto"] }, { provider, metadataFetch })
    ).rejects.toBe(terminal);
    expect(calls).toEqual(["fr"]);
  });

  it("stops fallback when a later provider attempt fails terminally", async () => {
    const calls: Array<string | undefined> = [];
    const terminal = new Error("provider rate limit");
    const provider = providerFrom(async (videoId, language) => {
      calls.push(language);
      if (language === "fr") {
        throw new YoutubeTranscriptNotAvailableLanguageErrorClass("fr", ["en"], videoId);
      }
      throw terminal;
    });

    await expect(
      fetchTranscript(VIDEO_ID, { languages: ["fr", "en", "auto"] }, { provider, metadataFetch })
    ).rejects.toBe(terminal);
    expect(calls).toEqual(["fr", "en"]);
  });

  it.each([
    ["unknown string", "microseconds"],
    ["empty string", ""],
    ["non-string", null],
  ])("rejects an %s timingUnit before reading cue timing", async (_case, runtimeUnit) => {
    let cueTimingReads = 0;
    const provider: TranscriptProvider = {
      async fetchTranscript() {
        const response: ProviderTranscriptResult = {
          snippets: [
            {
              text: "must not convert",
              get offset() {
                cueTimingReads += 1;
                return 1;
              },
              get duration() {
                cueTimingReads += 1;
                return 1;
              },
            },
          ],
          timingUnit: "seconds",
        };
        Object.defineProperty(response, "timingUnit", { value: runtimeUnit });
        return response;
      },
    };

    await expect(fetchTranscript(VIDEO_ID, {}, { provider, metadataFetch })).rejects.toThrow(
      'timingUnit must be exactly "milliseconds" or "seconds"'
    );
    expect(cueTimingReads).toBe(0);
  });

  it("rejects missing, nonfinite, fractional, and negative provider millisecond timing", async () => {
    const invalidResponses: unknown[] = [
      [{ text: "missing duration", offset: 0, lang: "en" }],
      [cue("nonfinite", Number.POSITIVE_INFINITY, 10)],
      [cue("fractional milliseconds", 1.25, 10)],
      [cue("negative", 0, -1)],
    ];

    for (const response of invalidResponses) {
      const provider = providerFrom(async () => response);
      await expect(
        fetchTranscript(VIDEO_ID, {}, { provider, metadataFetch })
      ).rejects.toBeInstanceOf(TranscriptProviderResponseError);
    }
  });

  it("preserves JSON cue seconds and computes duration from the latest cue end", async () => {
    const provider = providerFrom(async () => [
      cue("Alpha", 1_250, 1_500),
      cue("Beta ✓", 10_005, 500),
    ]);

    const result = await fetchTranscript(VIDEO_ID, { format: "json" }, { provider, metadataFetch });

    const expectedSnippets = [
      { start: 1.25, text: "Alpha", duration: 1.5 },
      { start: 10.005, text: "Beta ✓", duration: 0.5 },
    ];
    expect(result.snippets).toEqual(expectedSnippets);
    expect(result.raw).toEqual({ snippets: expectedSnippets });
    expect(JSON.parse(result.transcript)).toEqual(expectedSnippets);
    expect(result.durationSeconds).toBe(10.505);
  });
});

describe("caption formatting", () => {
  const timingCases: TranscriptSnippet[] = [
    { start: 1.25, duration: 1.5, text: "Alpha" },
    { start: 10.005, duration: 0.5, text: "Gap" },
    { start: 10.4, duration: 1, text: "Overlap" },
    { start: 59.9996, duration: 0.0006, text: "Carry" },
    { start: 3_661.25, duration: 2.75, text: "Long ✓" },
  ];
  const expectedTimings: Array<[number, number]> = [
    [1_250, 2_750],
    [10_005, 10_505],
    [10_400, 11_400],
    [60_000, 60_001],
    [3_661_250, 3_664_000],
  ];

  it("formats SRT with duration-derived, integer-millisecond cue endpoints", () => {
    const srt = transcriptToSRT(timingCases);

    expect(srt).toContain("00:00:01,250 --> 00:00:02,750");
    expect(srt).toContain("00:01:00,000 --> 00:01:00,001");
    expect(srt).toContain("01:01:01,250 --> 01:01:04,000");
    expect(srt).toContain("Long ✓");
    expect(parseSrtTimings(srt)).toEqual(expectedTimings);
  });

  it("formats WebVTT with the same duration-derived integer-millisecond arithmetic", () => {
    const webvtt = transcriptToWebVTT(timingCases);

    expect(webvtt).toContain("00:00:01.250 --> 00:00:02.750");
    expect(webvtt).toContain("00:01:00.000 --> 00:01:00.001");
    expect(webvtt).toContain("01:01:01.250 --> 01:01:04.000");
    expect(parseWebVttTimings(webvtt)).toEqual(expectedTimings);
  });

  it("rejects malformed second-based timing instead of guessing", () => {
    expect(() => transcriptToSRT([{ start: Number.NaN, duration: 1, text: "bad" }])).toThrow(
      /finite non-negative/
    );
    expect(() =>
      transcriptToWebVTT([{ start: 0, duration: Number.POSITIVE_INFINITY, text: "bad" }])
    ).toThrow(/finite non-negative/);
    expect(() => transcriptToSRT([{ start: 0, duration: -1, text: "bad" }])).toThrow(
      /finite non-negative/
    );
  });
});
