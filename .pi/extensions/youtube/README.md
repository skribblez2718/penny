# YouTube Extension

Provides tools for extracting YouTube video transcripts and metadata.

## Tools

### `youtube_transcript`

Fetch the transcript/captions from a YouTube video along with metadata.

**Parameters:**
| Parameter | Required | Description |
|-----------|----------|-------------|
| `url` | Yes | YouTube video URL or 11-character video ID |
| `format` | No | Output format: `text` (default), `json`, `srt`, `webvtt` |
| `languages` | No | Language codes for caption detection. `['auto']` picks best available |

**Example:**
```typescript
// Get plain text transcript
youtube_transcript({ url: "https://youtube.com/watch?v=ogTLWGBc3cE" })

// Get structured JSON with timing
youtube_transcript({ url: "ogTLWGBc3cE", format: "json" })

// Try French captions, fallback to English
youtube_transcript({ url: "https://youtu.be/ogTLWGBc3cE", languages: ["fr", "en"] })
```

### `youtube_status` (Command)

Check extension health and dependency status.

## Dependencies

- `youtube-transcript-ts` — Native TypeScript YouTube transcript API with proxy support

## Configuration

No configuration required. The extension uses `youtube-transcript-ts` which handles all YouTube API connectivity internally.

For restricted environments, configure proxy via `youtube-transcript-ts` options in `client.ts`.

## Testing

```bash
# Unit tests (no external dependencies required)
npm run test:unit

# Integration tests (requires youtube-transcript-ts installed)
npm run test:integration
```

## Supported URL Formats

- `https://www.youtube.com/watch?v=VIDEO_ID`
- `https://youtu.be/VIDEO_ID`
- `https://www.youtube.com/embed/VIDEO_ID`
- `https://www.youtube.com/shorts/VIDEO_ID`
- Raw 11-character video ID (e.g., `ogTLWGBc3cE`)
