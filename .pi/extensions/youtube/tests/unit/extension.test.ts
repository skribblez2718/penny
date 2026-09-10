import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  createTestExtensionApi,
  isRecord,
  parseJson,
  requireArray,
  requireArrayElement,
  requireFunction,
  requireRecord,
  requireString,
} from "../../../../lib/tests/test-narrowers.js";
import {
  type ProviderTranscriptResult,
  type TranscriptProvider,
  YoutubeTranscriptNotAvailableLanguageErrorClass,
} from "../../client.js";
import { createYoutubeExtension, TranscriptParams } from "../../index.js";

const VIDEO_ID = "ogTLWGBc3cE";

interface CapturedTool {
  description: string;
  parameters: unknown;
  execute: (...args: unknown[]) => unknown;
}

function requireTranscriptTool(value: unknown): CapturedTool {
  const tool = requireRecord(value, "YouTube extension registered a non-object tool");
  if (tool.name !== "youtube_transcript") throw new Error("expected youtube_transcript tool");
  return {
    description: requireString(tool.description, "YouTube tool description is missing"),
    parameters: tool.parameters,
    execute: requireFunction(tool.execute, "YouTube tool execute callback is missing"),
  };
}

async function executeTool(
  tool: CapturedTool,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const result = await Promise.resolve(tool.execute("youtube-call", params));
  return requireRecord(result, "YouTube tool returned a non-object result");
}

function resultPayload(result: Record<string, unknown>): Record<string, unknown> {
  const content = requireArray(result.content, "YouTube tool result omitted content");
  const first = requireRecord(
    requireArrayElement(content, 0, "YouTube tool result content is empty"),
    "YouTube tool result content item is invalid"
  );
  return requireRecord(
    parseJson(requireString(first.text, "YouTube tool result text is missing")),
    "YouTube tool result text is not a JSON object"
  );
}

describe("registered youtube_transcript contract", () => {
  it("registers a schema that accepts auto, ordered preferences, and the empty default", async () => {
    const registered: unknown[] = [];
    const provider: TranscriptProvider = {
      async fetchTranscript() {
        return {
          snippets: [{ text: "caption", offset: 0, duration: 500, lang: "en" }],
          timingUnit: "milliseconds",
        };
      },
    };
    const extension = createYoutubeExtension({
      provider,
      metadataFetch: async () => new Response("<title>Fixture - YouTube</title>"),
    });
    await extension(
      createTestExtensionApi({
        onRegisterTool(tool) {
          if (isRecord(tool) && tool.name === "youtube_transcript") registered.push(tool);
        },
      })
    );

    const tool = requireTranscriptTool(
      requireArrayElement(registered, 0, "youtube_transcript was not registered")
    );
    expect(tool.parameters).toBe(TranscriptParams);
    expect(Value.Check(TranscriptParams, { url: VIDEO_ID, languages: ["auto"] })).toBe(true);
    expect(Value.Check(TranscriptParams, { url: VIDEO_ID, languages: ["fr", "en"] })).toBe(true);
    expect(Value.Check(TranscriptParams, { url: VIDEO_ID, languages: [] })).toBe(true);
    expect(tool.description).toMatch(/tried in order/);
    expect(tool.description).toMatch(/never generates captions/);
  });

  it("drives ordered fallback through the registered tool and production client", async () => {
    const calls: Array<string | undefined> = [];
    const provider: TranscriptProvider = {
      async fetchTranscript(videoId, language) {
        calls.push(language);
        if (language === "fr") {
          throw new YoutubeTranscriptNotAvailableLanguageErrorClass("fr", ["en"], videoId);
        }
        return {
          snippets: [{ text: "English ✓", offset: 1_250, duration: 1_500, lang: "en" }],
          timingUnit: "milliseconds",
        };
      },
    };
    const registered: unknown[] = [];
    await createYoutubeExtension({
      provider,
      metadataFetch: async () =>
        new Response(
          'var data={"title":"Fixture","ownerChannelName":"Author","publishDate":"2026-09-01"};'
        ),
    })(
      createTestExtensionApi({
        onRegisterTool(tool) {
          if (isRecord(tool) && tool.name === "youtube_transcript") registered.push(tool);
        },
      })
    );
    const tool = requireTranscriptTool(
      requireArrayElement(registered, 0, "youtube_transcript was not registered")
    );

    const result = await executeTool(tool, {
      url: VIDEO_ID,
      languages: ["fr", "en"],
      format: "srt",
    });
    const payload = resultPayload(result);

    expect(calls).toEqual(["fr", "en"]);
    expect(payload.transcript).toContain("00:00:01,250 --> 00:00:02,750");
    expect(payload.language).toBe("en");
  });

  it("rejects an invalid runtime timingUnit through the registered production path", async () => {
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
        Object.defineProperty(response, "timingUnit", { value: "microseconds" });
        return response;
      },
    };
    const registered: unknown[] = [];
    await createYoutubeExtension({ provider, metadataFetch: async () => new Response("") })(
      createTestExtensionApi({
        onRegisterTool(tool) {
          if (isRecord(tool) && tool.name === "youtube_transcript") registered.push(tool);
        },
      })
    );
    const tool = requireTranscriptTool(
      requireArrayElement(registered, 0, "youtube_transcript was not registered")
    );

    const result = await executeTool(tool, { url: VIDEO_ID });
    const content = requireArray(result.content, "YouTube tool result omitted content");
    const first = requireRecord(requireArrayElement(content, 0), "invalid content item");
    const text = requireString(first.text);

    expect(result.isError).toBe(true);
    expect(text).toContain('timingUnit must be exactly "milliseconds" or "seconds"');
    expect(cueTimingReads).toBe(0);
  });

  it("returns truthful auto guidance when no requested track is available", async () => {
    const provider: TranscriptProvider = {
      async fetchTranscript(videoId, language) {
        throw new YoutubeTranscriptNotAvailableLanguageErrorClass(
          language ?? "auto",
          ["de"],
          videoId
        );
      },
    };
    const registered: unknown[] = [];
    await createYoutubeExtension({
      provider,
      metadataFetch: async () => new Response(""),
    })(
      createTestExtensionApi({
        onRegisterTool(tool) {
          if (isRecord(tool) && tool.name === "youtube_transcript") registered.push(tool);
        },
      })
    );
    const tool = requireTranscriptTool(
      requireArrayElement(registered, 0, "youtube_transcript was not registered")
    );

    const result = await executeTool(tool, { url: VIDEO_ID, languages: ["fr"] });
    const content = requireArray(result.content, "YouTube tool result omitted content");
    const first = requireRecord(requireArrayElement(content, 0), "invalid content item");
    const text = requireString(first.text);

    expect(text).toContain("No caption track matched");
    expect(text).toContain("does not generate captions");
    expect(text).not.toContain("auto-generated captions");
  });
});
