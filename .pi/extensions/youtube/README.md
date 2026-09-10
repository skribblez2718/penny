# YouTube Extension

Provides a tool for retrieving available YouTube caption tracks and video metadata.

## Tools

### `youtube_transcript`

Fetch an available caption track and return it as text, structured JSON, SRT, or WebVTT.

| Parameter   | Required | Description                                                                                                                                                   |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`       | Yes      | YouTube video URL or 11-character video ID                                                                                                                    |
| `format`    | No       | `text` (default), `json`, `srt`, or `webvtt`                                                                                                                  |
| `languages` | No       | Ordered caption-track preferences. Omitted or `[]` defaults to `["en"]`; `"auto"` selects the provider's first available track and does not generate captions |

Preferences are attempted from first to last only when a requested language track is unavailable. Invalid videos, disabled captions, rate limits, authentication failures, and other provider failures are terminal and are not retried as another language.

JSON cue `start` and `duration` values are seconds. SRT and WebVTT cue ends are calculated from each cue's own start and duration, preserving gaps and overlaps.

```typescript
// Default English plain text
youtube_transcript({ url: "https://youtube.com/watch?v=ogTLWGBc3cE" });

// Structured timing in seconds
youtube_transcript({ url: "ogTLWGBc3cE", format: "json" });

// Try French, then English
youtube_transcript({ url: "https://youtu.be/ogTLWGBc3cE", languages: ["fr", "en"] });

// Select the provider's first available caption track
youtube_transcript({ url: "ogTLWGBc3cE", languages: ["auto"] });
```

### `youtube-status` command

Runs an offline installation and URL-parser check. It does not contact YouTube or claim that provider access is healthy.

## Dependency and connectivity

The extension uses `youtube-transcript` 1.3.x, an unofficial YouTube transcript client. Provider behavior and caption availability can change independently of Penny.

No extension configuration is required. Calls to `youtube_transcript` contact YouTube; tests keep live network coverage behind `PENNY_YOUTUBE_NETWORK_TESTS=1`.

## Testing

From this directory:

```bash
bun run test:unit
bun run test:integration # live cases remain skipped unless explicitly enabled
bun run test:all
```

## Supported URL formats

- `https://www.youtube.com/watch?v=VIDEO_ID`
- `https://youtu.be/VIDEO_ID`
- `https://www.youtube.com/embed/VIDEO_ID`
- `https://www.youtube.com/shorts/VIDEO_ID`
- Raw 11-character video ID (for example, `ogTLWGBc3cE`)
