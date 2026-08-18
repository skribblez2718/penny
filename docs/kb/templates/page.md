---
{"schema_version":1,"page_id":"page_example","revision_id":"rev_example","kind":"synthesis","title":"Example advisory page","summary":"One-sentence advisory summary of what this page concludes.","authority":"advisory","lifecycle":"draft","created_at":"2026-01-01T00:00:00Z","derived_from":[],"related_page_ids":[]}
---

## Synthesis

The advisory conclusion, written so a reader can act on it. Every load-bearing statement
carries a claim ID that resolves in this revision's `claims.json` sidecar. This page is
advisory: it does not state canonical current system behavior, and a reader who needs
current state verifies it through the canonical route.

## Evidence

What supports the synthesis, cited to source records by opaque `source_id`. Evidence is
listed so a later reader can re-derive the conclusion rather than trust it.

## Tensions and unknowns

Where sources disagree, where confidence is low, and what was not established. Contested
claims name the claims they contradict. An honest empty section reads "None identified for
this revision" — it is never omitted.

## Related

Sibling pages by opaque `page_id`, for navigation only. No cross-directory or filesystem
paths appear here.
