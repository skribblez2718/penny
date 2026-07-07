/**
 * YouTube Extension
 *
 * Provides tools for extracting YouTube video transcripts and metadata:
 * - youtube_transcript: Fetch transcript from a YouTube video URL or video ID
 * - youtube_status: Check extension health and configuration status
 *
 * Powered by youtube-transcript-ts — native TypeScript implementation with
 * proxy support, Invidious fallback, and multiple language/caption formats.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { createLogger } from "../../lib/logger/logger.js";
import { fetchTranscript, extractVideoId } from "./client.js";
import {
  YoutubeTranscriptDisabledErrorClass,
  YoutubeTranscriptNotAvailableLanguageErrorClass,
  YoutubeTranscriptVideoUnavailableErrorClass,
} from "./client.js";

const logger = createLogger("youtube");

// Format type for TypeBox
const FORMAT_OPTIONS = ["text", "json", "srt", "webvtt"] as const;
const SUPPORTED_LANGUAGES = [
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
];

const TranscriptParams = Type.Object({
  url: Type.String({
    description:
      "YouTube video URL or video ID. Examples: https://youtube.com/watch?v=VIDEO_ID, https://youtu.be/VIDEO_ID, VIDEO_ID",
  }),
  format: Type.Optional(
    Type.Union(
      FORMAT_OPTIONS.map((f) => Type.Literal(f)),
      {
        description:
          "Output format: text (plain transcript), json (structured with timing), srt, or webvtt",
      }
    )
  ),
  languages: Type.Optional(
    Type.Array(
      Type.Union(
        SUPPORTED_LANGUAGES.map((l) => Type.Literal(l)),
        { description: "Language codes for caption detection. ['auto'] picks best available." }
      ),
      { description: "Preferenced language codes, highest priority first" }
    )
  ),
});

type TranscriptParams = Static<typeof TranscriptParams>;

export default async function youtubeExtension(pi: ExtensionAPI) {
  // ==========================
  // TOOL: youtube_transcript
  // ==========================
  pi.registerTool({
    name: "youtube_transcript",
    label: "YouTube Transcript",
    description:
      "Fetch the transcript/captions from a YouTube video along with metadata (title, author, video ID). " +
      "Returns the full transcript text or structured JSON with timing. Supports multiple format options " +
      "(text, json, srt, webvtt) and language fallback for automatic caption detection.",
    promptSnippet: "youtube_transcript with { url, format, languages }",
    promptGuidelines: [
      "Use youtube_transcript when the user asks for a video transcript, summary, or key points.",
      "Accept YouTube URLs (youtube.com/watch, youtu.be, embed, shorts) or raw 11-character video IDs.",
      "For technical analysis, prefer format='json' for structured data with timing info.",
      "For readable summaries, use format='text' (default).",
      "If captions are in another language, set languages=['auto'] or specific language codes.",
      "Handle videoUnavailable errors gracefully — some videos have no captions or are region-locked.",
    ],
    parameters: TranscriptParams,
    async execute(_toolCallId: string, params: TranscriptParams) {
      try {
        const { url, format, languages } = params;

        if (!url) {
          return {
            content: [{ type: "text" as const, text: "Error: url parameter is required." }],
            isError: true,
          };
        }

        logger.info("fetching transcript", { url, format, languages });

        const result = await fetchTranscript(url, {
          format,
          languages,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // Better error messages for common cases
        let userMessage = msg;
        if (err instanceof YoutubeTranscriptVideoUnavailableErrorClass) {
          userMessage =
            "Video not found or unavailable. Check the URL and verify the video is public.";
        } else if (err instanceof YoutubeTranscriptNotAvailableLanguageErrorClass) {
          userMessage =
            "No captions available for this video. Use languages=['auto'] to try auto-generated captions.";
        } else if (err instanceof YoutubeTranscriptDisabledErrorClass) {
          userMessage = "Captions are disabled for this video.";
        } else if (msg.includes("extract video ID")) {
          userMessage = `Invalid YouTube URL: ${msg}`;
        }

        logger.error("youtube_transcript failed", { error: msg });
        return {
          content: [{ type: "text" as const, text: `Error: ${userMessage}` }],
          isError: true,
        };
      }
    },
  });

  // ==========================
  // COMMAND: youtube-status
  // ==========================
  pi.registerCommand("youtube-status", {
    description: "Check YouTube extension health and dependency status",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        // Quick test — try extracting from a known test URL
        const testVideoId = extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        ctx.ui.notify(`YouTube Extension: ✅ Ready (tested video ID: ${testVideoId})`, "info");
      } catch (err) {
        ctx.ui.notify(
          `YouTube Extension: ❌ Error — ${err instanceof Error ? err.message : String(err)}`,
          "error"
        );
      }
    },
  });
}
