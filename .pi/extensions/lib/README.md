# Extension Shared Library

Shared TypeScript utilities used by Penny extensions.

## Tool Result Budget

`tool-result-budget.ts` is an **opt-in per-result presentation ceiling**, not a global Pi reply limiter or an agent/skill cycle budget. Only callers that use it are checked. It neither limits stored artifact bytes nor stops productive work after a number of calls.

### Measurement and effective default

The helper measures `JSON.stringify(result)`: content, metadata, supplied `details` and `isError`, including JSON escaping. It is not an exact measurement of the provider request; Pi/provider framing is separate and `details` is not necessarily model-visible.

All three ceilings must pass:

| Measurement                             | Hard ceiling | Lower-only environment setting     | Minimum |
| --------------------------------------- | -----------: | ---------------------------------- | ------: |
| Serialized UTF-8 bytes                  |       32,768 | `PENNY_TOOL_RESULT_MAX_BYTES`      |     512 |
| Serialized JavaScript UTF-16 code units |       32,768 | `PENNY_TOOL_RESULT_MAX_CHARACTERS` |     512 |
| Estimated tokens                        |        8,192 | `PENNY_TOOL_RESULT_MAX_TOKENS`     |     256 |

Unset or blank settings use the hard ceiling. Invalid or above-ceiling settings throw a configuration error; each consumer decides whether to return that failure or fall back to defaults. The helper accepts no configuration that raises its hard ceilings.

The conservative estimator charges **one estimated token per serialized UTF-8 byte**. It does not use the model's tokenizer or divide bytes by four. Consequently the effective default is **8,192 serialized bytes**, with less space available for the payload after envelope/continuation overhead. For example, `createTextToolResult({content: "a".repeat(8135)})` measures exactly 8,192 bytes; one more `a` exceeds the default. Quotes, backslashes, newlines and multibyte text change the space available.

`enforceToolResultBudget` only measures and throws; it does not persist, paginate or truncate. `fitUtf8ToolResult` measures caller-built envelopes to fit an exact UTF-8-safe prefix. If metadata alone, or metadata plus one code point, cannot fit, it throws. Valid minimum settings therefore do not guarantee every consumer can produce a page.

### Preservation and continuation belong to the consumer

| Consumer                                                          | Current behavior                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Artifact text reads](../artifacts/README.md)                     | Preserved immutable bytes; same exact ID plus returned `next_range` continues byte-for-byte without expiry. PNG image blocks use separate media limits; this helper checks only their text metadata.                                                                                 |
| [Memory](../memory/README.md)                                     | Fitted normalized results with query-bound cursors. Continuation preserves that representation, not all upstream fields; cache expiry, eviction, restart or source changes can prevent continuation.                                                                                 |
| [Web search](../search/README.md) success                         | Fitted complete-line prefix and a path to the **entire provider-returned JSON**, not just its remainder. Owner-only temporary files are capped, only four newest spills survive per session, and shutdown removes them. These are not full underlying webpages or durable artifacts. |
| [Web fetch](../search/README.md)                                  | Does **not** use the shared ceiling. Both normal and GitHub-fallback results clip content at 80,000 UTF-16 code units, without a spill file or continuation. Title/links and error replies are not fitted. The clipped tail is unavailable through this result.                      |
| [Subagent](../subagent/README.md) and [skill](../skill/README.md) | Exact outputs have artifact IDs, but their final reply envelopes are not universally checked here. Subagent input handoff instructions use this helper.                                                                                                                              |
| [Observability](../observability/README.md)                       | Uses Pi's separate 50 KiB/2,000-line truncation, not this helper. Record pagination is not byte continuation within an oversized entry.                                                                                                                                              |
| [Compaction](../compaction/README.md)                             | Fits a synthetic summary envelope, not the whole compaction record. Prose may be truncated; oversized exact-ref sets use an immutable handoff index or yield to Pi default compaction if preservation fails.                                                                         |

Search error replies also bypass shared fitting. Do not assume every retrieval result is capped or losslessly spilled merely because this utility exists.

### Headroom is conditional arithmetic

`assessReleaseHeadroom` assumes 16,384 tokens of available context and checks that a conforming estimated result leaves 8,192. It does **not** inspect live model capacity, current context use, sibling replies or history, nor reserve context itself. Consecutive results/pages accumulate; SDK context estimation and compaction are separate controls. These arithmetic tests are not a live tokenizer/compaction qualification receipt.

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
