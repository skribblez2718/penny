/**
 * YouTube Transcript Client
 *
 * Wrapper around youtube-transcript with ordered language selection,
 * deterministic dependency seams, metadata extraction, and caption formatting.
 */

import {
  YoutubeTranscript,
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptVideoUnavailableError,
} from "youtube-transcript";

export const MAX_LANGUAGE_PREFERENCES = 32;
const MAX_LANGUAGE_CODE_LENGTH = 35;
const DEFAULT_LANGUAGES = ["en"] as const;
const MILLISECONDS_PER_SECOND = 1_000;
const MILLISECONDS_PER_MINUTE = 60 * MILLISECONDS_PER_SECOND;
const MILLISECONDS_PER_HOUR = 60 * MILLISECONDS_PER_MINUTE;
const MAX_PROVIDER_DIAGNOSTIC_LENGTH = 300;
const SRV3_TIMING_PATTERN = /<p\s+t="\d+"\s+d="\d+"/;
const CLASSIC_TIMING_PATTERN = /<text\s+start="[^"]+"\s+dur="[^"]+"/;

export interface TranscriptConfig {
  /** Ordered language preferences. 'auto' selects the provider's first available track. */
  languages?: readonly string[];
  /** Output format: 'text', 'json', 'srt', or 'webvtt'. */
  format?: "text" | "json" | "srt" | "webvtt";
}

export interface TranscriptSnippet {
  /** Cue start in seconds. */
  start: number;
  text: string;
  /** Cue duration in seconds. */
  duration: number;
}

interface NormalizedTranscriptSnippet extends TranscriptSnippet {
  language?: string;
}

export interface TranscriptResult {
  /** Full transcript text, or the selected serialized format. */
  transcript: string;
  /** Video metadata. */
  metadata: {
    title: string;
    author: string;
    videoId: string;
  };
  /** Structured format payload when format=json. */
  raw?: Record<string, unknown>;
  /** Transcript language reported by the selected track. */
  language?: string;
  /** End of the latest transcript cue, in seconds. */
  durationSeconds?: number;
  /** Transcript snippets with timing in seconds (format=json only). */
  snippets?: TranscriptSnippet[];
  /** Video publish date (YYYY-MM-DD), or 'unknown' when unavailable. */
  publishDate?: string;
}

export type ProviderTimingUnit = "milliseconds" | "seconds";

export interface ProviderTranscriptResult {
  /** Untrusted youtube-transcript cue array, validated by this client. */
  snippets: unknown;
  /** Unit observed from the provider's caption XML format. */
  timingUnit: ProviderTimingUnit;
}

/**
 * Provider boundary. youtube-transcript 1.3.1 emits milliseconds for srv3 XML
 * and seconds for classic XML, so the adapter must tag the observed source unit.
 */
export interface TranscriptProvider {
  fetchTranscript(videoId: string, language: string | undefined): Promise<ProviderTranscriptResult>;
}

export interface MetadataResponse {
  text(): Promise<string>;
}

export type MetadataFetch = (url: string) => Promise<MetadataResponse>;

export interface TranscriptDependencies {
  provider?: TranscriptProvider;
  metadataFetch?: MetadataFetch;
}

export class TranscriptLanguagesUnavailableError extends Error {
  readonly preferences: readonly string[];

  constructor(preferences: readonly string[], providerDiagnostic: string) {
    const diagnostic = providerDiagnostic.slice(0, MAX_PROVIDER_DIAGNOSTIC_LENGTH);
    super(
      `No caption track matched the requested language preferences (${preferences.join(
        ", "
      )}). Last provider diagnostic: ${diagnostic}`
    );
    this.name = "TranscriptLanguagesUnavailableError";
    this.preferences = [...preferences];
  }
}

export class TranscriptProviderResponseError extends Error {
  constructor(message: string) {
    super(`Transcript provider returned invalid timing data: ${message}`);
    this.name = "TranscriptProviderResponseError";
  }
}

const DEFAULT_METADATA_FETCH: MetadataFetch = async (url) => fetch(url);

// Re-export provider errors used by the registered tool's terminal-error messages and tests.
export {
  YoutubeTranscriptDisabledError as YoutubeTranscriptDisabledErrorClass,
  YoutubeTranscriptNotAvailableLanguageError as YoutubeTranscriptNotAvailableLanguageErrorClass,
  YoutubeTranscriptVideoUnavailableError as YoutubeTranscriptVideoUnavailableErrorClass,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isCaptionTrackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname.endsWith(".youtube.com") && url.pathname.includes("timedtext");
  } catch {
    return false;
  }
}

function detectProviderTimingUnit(xml: string): ProviderTimingUnit | undefined {
  if (SRV3_TIMING_PATTERN.test(xml)) return "milliseconds";
  if (CLASSIC_TIMING_PATTERN.test(xml)) return "seconds";
  return undefined;
}

function responseWithBody(response: Response, body: string): Response {
  return new Response(response.status === 204 ? null : body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Create the production youtube-transcript adapter with an injectable network seam. */
export function createYoutubeTranscriptProvider(
  fetchImpl: typeof globalThis.fetch
): TranscriptProvider {
  return {
    async fetchTranscript(videoId, language) {
      let timingUnit: ProviderTimingUnit | undefined;
      const timingAwareFetch: typeof globalThis.fetch = async (input, init) => {
        const response = await fetchImpl(input, init);
        if (!response.ok || !isCaptionTrackUrl(requestUrl(input))) return response;

        const body = await response.text();
        timingUnit = detectProviderTimingUnit(body);
        return responseWithBody(response, body);
      };
      const snippets = await YoutubeTranscript.fetchTranscript(videoId, {
        ...(language === undefined ? {} : { lang: language }),
        fetch: timingAwareFetch,
      });
      if (timingUnit === undefined) {
        throw new TranscriptProviderResponseError(
          "caption XML did not declare a supported srv3 or classic timing format"
        );
      }
      return { snippets, timingUnit };
    },
  };
}

function requireProviderTimingUnit(value: unknown): ProviderTimingUnit {
  if (value !== "milliseconds" && value !== "seconds") {
    throw new TranscriptProviderResponseError(
      'timingUnit must be exactly "milliseconds" or "seconds"'
    );
  }
  return value;
}

function providerTimeToMilliseconds(
  value: unknown,
  unit: ProviderTimingUnit,
  field: string,
  index: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TranscriptProviderResponseError(
      `cue ${index + 1} ${field} must be a finite non-negative number of ${unit}`
    );
  }
  const milliseconds =
    unit === "milliseconds" ? value : Math.round(value * MILLISECONDS_PER_SECOND);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new TranscriptProviderResponseError(
      `cue ${index + 1} ${field} must resolve to safe integer milliseconds`
    );
  }
  return milliseconds;
}

function parseProviderSnippets(result: ProviderTranscriptResult): NormalizedTranscriptSnippet[] {
  const timingUnit = requireProviderTimingUnit(result.timingUnit);
  const value = result.snippets;
  if (!Array.isArray(value)) {
    throw new TranscriptProviderResponseError("response must be an array of cues");
  }
  if (value.length === 0) {
    throw new TranscriptProviderResponseError("response contained no cues");
  }

  return value.map((candidate: unknown, index): NormalizedTranscriptSnippet => {
    if (!isRecord(candidate)) {
      throw new TranscriptProviderResponseError(`cue ${index + 1} must be an object`);
    }
    if (typeof candidate.text !== "string") {
      throw new TranscriptProviderResponseError(`cue ${index + 1} text must be a string`);
    }
    if (candidate.lang !== undefined && typeof candidate.lang !== "string") {
      throw new TranscriptProviderResponseError(`cue ${index + 1} lang must be a string`);
    }

    const offsetMilliseconds = providerTimeToMilliseconds(
      candidate.offset,
      timingUnit,
      "offset",
      index
    );
    const durationMilliseconds = providerTimeToMilliseconds(
      candidate.duration,
      timingUnit,
      "duration",
      index
    );
    return {
      start: offsetMilliseconds / MILLISECONDS_PER_SECOND,
      text: candidate.text,
      duration: durationMilliseconds / MILLISECONDS_PER_SECOND,
      language: candidate.lang,
    };
  });
}

function normalizeLanguagePreferences(languages: readonly string[] | undefined): string[] {
  if (languages === undefined || languages.length === 0) return [...DEFAULT_LANGUAGES];
  if (languages.length > MAX_LANGUAGE_PREFERENCES) {
    throw new Error(`At most ${MAX_LANGUAGE_PREFERENCES} language preferences are supported`);
  }
  return languages.map((language, index) => {
    if (
      language.length === 0 ||
      language.length > MAX_LANGUAGE_CODE_LENGTH ||
      language.trim() !== language
    ) {
      throw new Error(`Language preference ${index + 1} is invalid`);
    }
    return language;
  });
}

async function fetchPreferredTranscript(
  provider: TranscriptProvider,
  videoId: string,
  preferences: readonly string[]
): Promise<NormalizedTranscriptSnippet[]> {
  let lastUnavailable: YoutubeTranscriptNotAvailableLanguageError | undefined;

  for (const preference of preferences) {
    try {
      const providerResult = await provider.fetchTranscript(
        videoId,
        preference === "auto" ? undefined : preference
      );
      return parseProviderSnippets(providerResult);
    } catch (error: unknown) {
      if (error instanceof YoutubeTranscriptNotAvailableLanguageError) {
        lastUnavailable = error;
        continue;
      }
      throw error;
    }
  }

  if (lastUnavailable === undefined) {
    throw new Error("Transcript language selection ended without a provider result");
  }
  throw new TranscriptLanguagesUnavailableError(preferences, lastUnavailable.message);
}

/**
 * Extract video metadata from a YouTube watch page HTML string.
 * Returns null if no metadata was found.
 */
function extractVideoMetadata(
  html: string,
  videoId: string
): { title: string; author: string; publishDate: string } | null {
  let title = videoId;
  const titleMatch = html.match(/"title":"([^"]+)"/);
  if (titleMatch) {
    title = titleMatch[1]
      .replace(/\\u([0-9a-f]{4})/gi, (_match: string, hex: string) =>
        String.fromCharCode(parseInt(hex, 16))
      )
      .replace(/\\n/g, "")
      .replace(/\\"/g, '"');
  } else {
    const h1Match = html.match(/<title>(.+?) - YouTube<\/title>/i);
    if (h1Match) title = h1Match[1].trim();
  }

  let author = "unknown";
  const authorMatch = html.match(/"ownerChannelName":"([^"]+)"/);
  if (authorMatch) {
    author = authorMatch[1]
      .replace(/\\u([0-9a-f]{4})/gi, (_match: string, hex: string) =>
        String.fromCharCode(parseInt(hex, 16))
      )
      .replace(/\\n/g, "");
  } else {
    const authorH1Match = html.match(/"author":"([^"]+)"/);
    if (authorH1Match) author = authorH1Match[1];
  }

  let publishDate = "unknown";
  const dateMatch = html.match(/"publishDate"\s*:\s*"([^"]+)"/);
  if (dateMatch) publishDate = dateMatch[1].substring(0, 10);

  return { title, author, publishDate };
}

/** Extract a video ID from supported YouTube URLs, or return a raw 11-character ID. */
export function extractVideoId(url: string): string {
  if (!url) throw new Error("URL or video ID is required");

  const trimmed = url.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;

  const lower = trimmed.toLowerCase();

  let match = lower.match(/^(?:https?:\/\/)?youtu\.be\/([a-z0-9_-]+)(?:[#?].*)?$/);
  if (match) {
    const original = trimmed.match(/^(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]+)(?:[#?].*)?$/i);
    if (original) return original[1];
  }

  match = lower.match(/^https?:\/\/(?:www\.)?youtube\.com\/watch\?.*v=([a-z0-9_-]+)/);
  if (match) {
    const original = trimmed.match(
      /^(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?.*v=([a-zA-Z0-9_-]+)/i
    );
    if (original) return original[1];
  }

  match = lower.match(/^https?:\/\/(?:www\.)?youtube\.com\/(?:embed|v)\/([a-z0-9_-]+)/);
  if (match) {
    const original = trimmed.match(
      /^(?:https?:\/\/)?(?:www\.)?youtube\.com\/(?:embed|v)\/([a-zA-Z0-9_-]+)/i
    );
    if (original) return original[1];
  }

  match = lower.match(/^https?:\/\/(?:www\.)?youtube\.com\/shorts\/([a-z0-9_-]+)/);
  if (match) {
    const original = trimmed.match(
      /^(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/i
    );
    if (original) return original[1];
  }

  throw new Error(`Could not extract video ID from URL: ${url}`);
}

function secondsToMilliseconds(seconds: number, field: string, cueIndex: number): number {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Cue ${cueIndex + 1} ${field} must be a finite non-negative number of seconds`);
  }
  const milliseconds = Math.round(seconds * MILLISECONDS_PER_SECOND);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error(`Cue ${cueIndex + 1} ${field} exceeds the supported timestamp range`);
  }
  return milliseconds;
}

function cueMilliseconds(
  snippet: TranscriptSnippet,
  index: number
): { start: number; end: number } {
  const start = secondsToMilliseconds(snippet.start, "start", index);
  const duration = secondsToMilliseconds(snippet.duration, "duration", index);
  if (duration > Number.MAX_SAFE_INTEGER - start) {
    throw new Error(`Cue ${index + 1} end exceeds the supported timestamp range`);
  }
  return { start, end: start + duration };
}

function formatTimestamp(milliseconds: number, millisecondSeparator: "," | "."): string {
  const hours = Math.floor(milliseconds / MILLISECONDS_PER_HOUR);
  const afterHours = milliseconds % MILLISECONDS_PER_HOUR;
  const minutes = Math.floor(afterHours / MILLISECONDS_PER_MINUTE);
  const afterMinutes = afterHours % MILLISECONDS_PER_MINUTE;
  const seconds = Math.floor(afterMinutes / MILLISECONDS_PER_SECOND);
  const millis = afterMinutes % MILLISECONDS_PER_SECOND;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
    seconds
  ).padStart(2, "0")}${millisecondSeparator}${String(millis).padStart(3, "0")}`;
}

/** Format second-based transcript cues as standards-compliant SubRip. */
export function transcriptToSRT(snippets: readonly TranscriptSnippet[]): string {
  let srt = "";
  for (const [index, snippet] of snippets.entries()) {
    const timing = cueMilliseconds(snippet, index);
    srt += `${index + 1}\n`;
    srt += `${formatTimestamp(timing.start, ",")} --> ${formatTimestamp(timing.end, ",")}\n`;
    srt += `${snippet.text}\n\n`;
  }
  return srt;
}

/** Format second-based transcript cues as standards-compliant WebVTT. */
export function transcriptToWebVTT(snippets: readonly TranscriptSnippet[]): string {
  let vtt = "WEBVTT\n\n";
  for (const [index, snippet] of snippets.entries()) {
    const timing = cueMilliseconds(snippet, index);
    vtt += `${formatTimestamp(timing.start, ".")} --> ${formatTimestamp(timing.end, ".")}\n`;
    vtt += `${snippet.text}\n\n`;
  }
  return vtt;
}

function latestCueEndSeconds(snippets: readonly TranscriptSnippet[]): number {
  let latestEndMilliseconds = 0;
  for (const [index, snippet] of snippets.entries()) {
    const timing = cueMilliseconds(snippet, index);
    latestEndMilliseconds = Math.max(latestEndMilliseconds, timing.end);
  }
  return latestEndMilliseconds / MILLISECONDS_PER_SECOND;
}

/** Fetch a transcript with ordered language preferences, metadata, and formatting. */
export async function fetchTranscript(
  videoIdOrUrl: string,
  config: TranscriptConfig = {},
  dependencies: TranscriptDependencies = {}
): Promise<TranscriptResult> {
  const videoId = extractVideoId(videoIdOrUrl);
  const preferences = normalizeLanguagePreferences(config.languages);
  const format = config.format ?? "text";
  const provider = dependencies.provider ?? createYoutubeTranscriptProvider(globalThis.fetch);
  const metadataFetch = dependencies.metadataFetch ?? DEFAULT_METADATA_FETCH;

  const normalizedSnippets = await fetchPreferredTranscript(provider, videoId, preferences);
  const pageHtml = await (await metadataFetch(`https://www.youtube.com/watch?v=${videoId}`)).text();
  const metadata = extractVideoMetadata(pageHtml, videoId);

  const title = metadata?.title ?? videoId;
  const author = metadata?.author ?? "unknown";
  const publishDate = metadata?.publishDate ?? "unknown";
  const publicSnippets: TranscriptSnippet[] = normalizedSnippets.map(
    ({ start, text, duration }) => ({
      start,
      text,
      duration,
    })
  );

  let transcript: string;
  let raw: Record<string, unknown> | undefined;
  let transcriptSnippets: TranscriptSnippet[] | undefined;

  switch (format) {
    case "json":
      transcriptSnippets = publicSnippets;
      raw = { snippets: transcriptSnippets };
      transcript = JSON.stringify(transcriptSnippets, null, 2);
      break;
    case "srt":
      transcript = transcriptToSRT(publicSnippets);
      break;
    case "webvtt":
      transcript = transcriptToWebVTT(publicSnippets);
      break;
    case "text":
      transcript = normalizedSnippets.map((snippet) => snippet.text).join(" ");
      break;
  }

  const detectedLanguage = normalizedSnippets.find(
    (snippet) => snippet.language !== undefined
  )?.language;

  return {
    transcript,
    metadata: { title, author, videoId },
    language: detectedLanguage,
    durationSeconds: latestCueEndSeconds(publicSnippets),
    raw,
    snippets: transcriptSnippets,
    publishDate,
  };
}
