/**
 * YouTube Transcript Client
 *
 * Wrapper around youtube-transcript package that provides helper functions for:
 * - Extracting video IDs from URLs
 * - Fetching transcripts with metadata (title, author)
 * - Configurable language fallback
 * - Format options (text, json, srt, webvtt)
 */

import {
  YoutubeTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptVideoUnavailableError,
} from "youtube-transcript";

export interface TranscriptConfig {
  /** Preferred language code (e.g. 'en', 'es') or 'auto' */
  languages?: string[];
  /** Output format: 'text', 'json', 'srt', 'webvtt' */
  format?: "text" | "json" | "srt" | "webvtt";
}

export interface TranscriptResult {
  /** Full transcript text (if format=text) */
  transcript: string;
  /** Video metadata */
  metadata: {
    title: string;
    author: string;
    videoId: string;
  };
  /** Raw response if format=json */
  raw?: Record<string, unknown>;
  /** Transcript language detected */
  language?: string;
  /** Total duration in seconds */
  durationSeconds?: number;
  /** Transcript snippets with timing (format=json only) */
  snippets?: Array<{ start: number; text: string; duration: number }>;
  /** Video publish date (YYYY-MM-DD) */
  publishDate?: string;
}

// Re-export error classes for use in index.ts
export {
  YoutubeTranscriptDisabledError as YoutubeTranscriptDisabledErrorClass,
  YoutubeTranscriptNotAvailableLanguageError as YoutubeTranscriptNotAvailableLanguageErrorClass,
  YoutubeTranscriptVideoUnavailableError as YoutubeTranscriptVideoUnavailableErrorClass,
};

/**
 * Extract video metadata from a YouTube watch page HTML string.
 * Returns null if no metadata found.
 */
async function extractVideoMetadata(
  html: string,
  videoId: string,
): Promise<{ title: string; author: string; publishDate: string } | null> {
  // Title
  let title = videoId;
  const titleMatch = html.match(/"title":"([^"]+)"/);
  if (titleMatch) {
    title = titleMatch[1]
      .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\n/g, "")
      .replace(/\\"/g, '"');
  } else {
    const h1Match = html.match(/<title>(.+?) - YouTube<\/title>/i);
    if (h1Match) title = h1Match[1].trim();
  }

  // Author
  let author = "unknown";
  const authorMatch = html.match(/"ownerChannelName":"([^"]+)"/);
  if (authorMatch) {
    author = authorMatch[1]
      .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\n/g, "");
  } else {
    const authorH1Match = html.match(/"author":"([^"]+)"/);
    if (authorH1Match) author = authorH1Match[1];
  }

  // Publish date
  let publishDate = "unknown";
  const dateMatch = html.match(/"publishDate"\s*:\s*"([^"]+)"/);
  if (dateMatch) {
    publishDate = dateMatch[1].substring(0, 10);
  }

  return { title, author, publishDate };
}

/**
 * Extract video ID from YouTube URLs or return as-is if already a video ID.
 * Preserves the case of the captured video ID from the original URL.
 */
export function extractVideoId(url: string): string {
  if (!url) throw new Error("URL or video ID is required");

  const trimmed = url.trim();

  // If it's exactly 11 characters (standard YouTube video ID), treat as raw ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  const lower = trimmed.toLowerCase();

  // Direct video ID URL: youtu.be/VIDEO_ID
  let match = lower.match(/^(?:https?:\/\/)?youtu\.be\/([a-z0-9_-]+)(?:[#?].*)?$/);
  if (match) {
    const origMatch = trimmed.match(/^(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]+)(?:[#?].*)?$/i);
    if (origMatch) return origMatch[1];
  }

  // Standard URL: youtube.com/watch?v=VIDEO_ID (case-insensitive domain)
  match = lower.match(/^https?:\/\/(?:www\.)?youtube\.com\/watch\?.*v=([a-z0-9_-]+)/);
  if (match) {
    const origMatch = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]+)/i);
    if (origMatch) return origMatch[1];
  }

  // Embed URL: youtube.com/embed/VIDEO_ID or youtube.com/v/VIDEO_ID
  match = lower.match(/^https?:\/\/(?:www\.)?youtube\.com\/(?:embed|v)\/([a-z0-9_-]+)/);
  if (match) {
    const origMatch = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?youtube\.com\/(?:embed|v)\/([a-zA-Z0-9_-]+)/i);
    if (origMatch) return origMatch[1];
  }

  // Shorts URL: youtube.com/shorts/VIDEO_ID
  match = lower.match(/^https?:\/\/(?:www\.)?youtube\.com\/shorts\/([a-z0-9_-]+)/);
  if (match) {
    const origMatch = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/i);
    if (origMatch) return origMatch[1];
  }

  throw new Error(`Could not extract video ID from URL: ${url}`);
}

/**
 * Fetch transcript with metadata and formatting
 */
export async function fetchTranscript(
  videoIdOrUrl: string,
  config: TranscriptConfig = {}
): Promise<TranscriptResult> {
  const videoId = extractVideoId(videoIdOrUrl);
  const languages = config.languages || ["en"];
  const format = config.format || "text" as const;

  // Fetch transcript (array of { text, duration, offset })
  const ytSnippets = await YoutubeTranscript.fetchTranscript(videoId, { lang: languages[0] });

  // Fetch video metadata from watch page
  const pageHtml = await (
    await fetch(`https://www.youtube.com/watch?v=${videoId}`)
  ).text();
  const metadata = await extractVideoMetadata(pageHtml, videoId);

  const title = metadata?.title || videoId;
  const author = metadata?.author || "unknown";
  const publishDate = metadata?.publishDate || "unknown";

  // Build transcript content based on format
  let transcript = "";
  let raw: Record<string, unknown> | undefined;
  let transcriptSnippets: Array<{ start: number; text: string; duration: number }> | undefined;

  switch (format) {
    case "text":
      transcript = ytSnippets.map((s) => s.text).join(" ");
      break;
    case "json":
      transcriptSnippets = ytSnippets.map((s) => ({
        start: s.offset,
        text: s.text,
        duration: s.duration,
      }));
      raw = { snippets: transcriptSnippets };
      transcript = JSON.stringify(transcriptSnippets, null, 2);
      break;
    case "srt":
      transcript = await transcriptToSRT(
        ytSnippets.map((s) => ({ start: s.offset, text: s.text, duration: s.duration })),
      );
      break;
    case "webvtt":
      transcript = await transcriptToWebVTT(
        ytSnippets.map((s) => ({ start: s.offset, text: s.text, duration: s.duration })),
      );
      break;
    default:
      transcript = ytSnippets.map((s) => s.text).join(" ");
  }

  // Detect language from first snippet that has lang
  const detectedLang = ytSnippets.find((s) => s.lang)?.lang;

  return {
    transcript,
    metadata: {
      title,
      author,
      videoId,
    },
    language: detectedLang,
    durationSeconds: ytSnippets.reduce((acc, s) => acc + s.duration, 0),
    raw,
    snippets: transcriptSnippets,
    publishDate,
  };
}

async function transcriptToSRT(
  snippets: Array<{ start: number; text: string; duration: number }>,
): Promise<string> {
  let srt = "";
  for (let i = 0; i < snippets.length; i++) {
    const { start, text } = snippets[i];
    const startMins = Math.floor(start / 60);
    const startSecs = Math.floor(start % 60);
    const startMs = Math.round((start % 1) * 1000);

    const endSnippet = snippets[i + 1];
    const endTime = endSnippet ? endSnippet.start : start + 10;
    const endMins = Math.floor(endTime / 60);
    const endSecs = Math.floor(endTime % 60);
    const endMs = Math.round((endTime % 1) * 1000);

    srt += `${i + 1}\n`;
    srt += `${String(startMins).padStart(2, "0")}:${String(startSecs).padStart(2, "0")}:${String(startMs).padStart(3, "0")},000 --> `;
    srt += `${String(endMins).padStart(2, "0")}:${String(endSecs).padStart(2, "0")}:${String(endMs).padStart(3, "0")},000\n`;
    srt += `${text}\n\n`;
  }
  return srt;
}

async function transcriptToWebVTT(
  snippets: Array<{ start: number; text: string; duration: number }>,
): Promise<string> {
  let vtt = "WEBVTT\n\n";
  for (let i = 0; i < snippets.length; i++) {
    const { start, text } = snippets[i];
    const startFormatted = formatVTTTime(start);

    const endSnippet = snippets[i + 1];
    const endTime = endSnippet ? endSnippet.start : start + 10;
    const endFormatted = formatVTTTime(endTime);

    vtt += `${startFormatted} --> ${endFormatted}\n${text}\n\n`;
  }
  return vtt;
}

function formatVTTTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}
