import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { createLogger } from "../../lib/logger/logger.js";
import { registerTool } from "../../lib/pi-tool-registration.js";
import {
  extractVideoId,
  fetchTranscript,
  MAX_LANGUAGE_PREFERENCES,
  TranscriptLanguagesUnavailableError,
  type TranscriptDependencies,
  YoutubeTranscriptDisabledErrorClass,
  YoutubeTranscriptVideoUnavailableErrorClass,
} from "./client.js";

const logger = createLogger("youtube");

const FORMAT_OPTIONS = ["text", "json", "srt", "webvtt"] as const;
const LANGUAGE_OPTIONS = [
  "auto",
  "en",
  "en-GB",
  "en-US",
  "en-AU",
  "en-CA",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "nl",
  "ko",
  "ja",
  "zh",
  "ru",
  "ar",
  "hi",
  "th",
  "vi",
  "id",
  "ms",
  "tr",
  "pl",
  "sv",
  "da",
  "no",
  "fi",
] as const;

export const TranscriptParams = Type.Object({
  url: Type.String({
    description:
      "YouTube video URL or video ID. Examples: https://youtube.com/watch?v=VIDEO_ID, https://youtu.be/VIDEO_ID, VIDEO_ID",
  }),
  format: Type.Optional(
    Type.Union(
      FORMAT_OPTIONS.map((format) => Type.Literal(format)),
      {
        description:
          "Output format: text (plain transcript, default), json (structured seconds), srt, or webvtt",
      }
    )
  ),
  languages: Type.Optional(
    Type.Array(Type.Union(LANGUAGE_OPTIONS.map((language) => Type.Literal(language))), {
      description:
        "Ordered caption-track preferences, highest priority first. 'auto' selects the provider's first available track; it does not generate captions. Omitted or empty defaults to ['en'].",
      maxItems: MAX_LANGUAGE_PREFERENCES,
    })
  ),
});

type TranscriptParams = Static<typeof TranscriptParams>;

export function createYoutubeExtension(dependencies: TranscriptDependencies = {}) {
  return async function youtubeExtension(pi: ExtensionAPI): Promise<void> {
    registerTool(pi, {
      name: "youtube_transcript",
      label: "YouTube Transcript",
      description:
        "Fetch a YouTube video's available caption track with title, author, and video ID metadata. " +
        "Use for transcript retrieval, summaries, key-point extraction, or timing-aware analysis; do not use when the task does not require video captions. " +
        "Returns text, JSON with second-based cue timing, SRT, or WebVTT. Language preferences are tried in order; 'auto' selects an available track but never generates captions. Videos can have no captions or be unavailable.",
      promptSnippet: "youtube_transcript with { url, format, languages }",
      parameters: TranscriptParams,
      async execute(_toolCallId, params: TranscriptParams) {
        try {
          const { url, format, languages } = params;

          if (!url) {
            return {
              content: [{ type: "text" as const, text: "Error: url parameter is required." }],
              isError: true,
            };
          }

          logger.info("fetching transcript", { url, format, languages });
          const result = await fetchTranscript(url, { format, languages }, dependencies);

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            details: result,
          };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);

          let userMessage = message;
          if (error instanceof YoutubeTranscriptVideoUnavailableErrorClass) {
            userMessage =
              "Video not found or unavailable. Check the URL and verify the video is public.";
          } else if (error instanceof TranscriptLanguagesUnavailableError) {
            userMessage = `${message} Add 'auto' only if selecting the first available caption track is acceptable; 'auto' does not generate captions.`;
          } else if (error instanceof YoutubeTranscriptDisabledErrorClass) {
            userMessage = "Captions are disabled or unavailable for this video.";
          } else if (message.includes("extract video ID")) {
            userMessage = `Invalid YouTube URL: ${message}`;
          }

          logger.error("youtube_transcript failed", { error: message });
          return {
            content: [{ type: "text" as const, text: `Error: ${userMessage}` }],
            isError: true,
          };
        }
      },
    });

    pi.registerCommand("youtube-status", {
      description: "Check YouTube extension installation without contacting YouTube",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        try {
          const testVideoId = extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
          ctx.ui.notify(
            `YouTube Extension: ✅ Installed (offline URL parser check: ${testVideoId}; provider not contacted)`,
            "info"
          );
        } catch (error: unknown) {
          ctx.ui.notify(
            `YouTube Extension: ❌ Error — ${error instanceof Error ? error.message : String(error)}`,
            "error"
          );
        }
      },
    });
  };
}

export default createYoutubeExtension();
