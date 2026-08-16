# Extension Shared Library

Shared TypeScript utilities used by Penny extensions.

## Tool Result Budget

`tool-result-budget.ts` enforces hard and owner-supplied lower limits against the final serialized Pi text-tool result. It provides deterministic measurement, conservative token estimation, UTF-8 boundary checks, and multibyte-safe fitting for typed continuation results.

Hard ceilings remain 32,768 UTF-8 bytes, 32,768 serialized characters, and 8,192 estimated tokens. Configuration cannot raise them. The estimator charges exactly one estimated token for every byte in the complete serialized UTF-8 envelope, with no tokenizer dependency or byte discount. The estimated-token ceiling therefore limits a default result to at most 8,192 serialized bytes; byte and character caps are still checked independently and owner-supplied lower caps still win.

The release minimum context headroom is 16,384 tokens (twice the hard estimated-result cap). A conforming result consumes no more than half of that minimum and leaves at least 8,192 tokens reserved after the result. These are code/evidence-test invariants, not evidence that a live supported-model compaction trial ran; that operational correlation requires a separate receipt.

## Testing

```bash
bun run --cwd .pi/extensions/lib test:all
# Individual gates:
bun run --cwd .pi/extensions/lib lint
bun run --cwd .pi/extensions/lib format:check
bun run --cwd .pi/extensions/lib typecheck
bun run --cwd .pi/extensions/lib test:unit
bun run --cwd .pi/extensions/lib test:integration
```
