# Synthia Protocol — Merge & Dedup

> Injected as `skillContext` for synthia in the jsa MERGE phase.

## Mission

Consolidate the raw findings that annie posted across all investigation waves into
a deduplicated, confidence-promoted, ranked set of merged findings. Stitch partial
or cross-file findings into complete vulnerability reports.

Findings come from annie's waves and from the deterministic SAST pass — the
provenance unit is the **(source, sink, scanner)** that corroborated each one.

## Protocol

### 1. Collect Raw Findings
```
memory_search(wing="wing_jsa", room="{session_id}-findings", limit=500)
```

### 2. Group by (file, vuln_class)
All findings for the same vulnerability class in the same file form a comparison
group.

### 3. Compute Similarity
For each group, compare every pair of findings. Two findings are "the same" if:
- **Source matches** (same or compatible source — e.g., both URL-based)
- **Sink matches** (same or compatible sink)
- **Line proximity** (within 5 lines → likely same; within 20 → possibly same)
- **Code overlap** (token Jaccard > 0.5)
- **Description similarity** (MemPalace semantic search score > 0.85)

Weighted score: 25% source + 25% sink + 20% proximity + 15% code + 15% semantic.

### 4. Cluster Similar Findings
Agglomerative clustering with merge threshold 0.6. Higher-confidence findings
serve as cluster anchors.

### 5. Merge Each Cluster
For each cluster of similar findings:
- **Keep the best** description, code snippet, and data-flow trace.
- **Set line range** to min start → max end across merged findings.
- **Track corroboration**: which scanners/sources agreed (semgrep, jsluice,
  annie's AST trace, a browser-verified result).
- **Promote confidence** on independent corroboration:
  - 2+ independent sources/scanners found the same pattern: possible → probable
  - a browser-verified (`exploitability: verified`) result, or 2+ scanners plus a
    trace: probable → confirmed
  - a single unsupported finding: no promotion

### 6. Cross-File Dedup
Use MemPalace semantic search to find the same vulnerability pattern across
different files (e.g., the same `dangerouslySetInnerHTML` pattern in 5 React
components). Merge into one finding with multiple file references.

### 7. Stitch Cross-File Flows
When a tainted source in one file flows to a sink in another (visible from the
finding's `data_flow` or the analysis store's flow cards), merge those partial
findings into one complete source-to-sink finding spanning both files.

### 8. Score & Rank
Score each merged finding 0-100:
- **Confidence** (40%): confirmed=40, probable=25, possible=10
- **Severity by vuln class** (30%): DOM XSS=30, prototype pollution=28, open redirect=15, etc.
- **Corroboration breadth** (15%): more independent scanners/sources agreeing = higher
- **Exploitability** (15%): browser-verified > theoretical

Sort by score descending.

### 9. Store Merged Results
```
memory_add_drawer(wing="wing_jsa", room="{session_id}-merged", content={
  findings: [...],
  stats: { total_raw: N, total_merged: M, duplication_rate: 1 - M/N,
           clusters_formed: C, cross_file_merges: X, confidence_promotions: Y }
})
```

## Rules
- Never drop a finding — if ambiguous, keep it and flag for manual review.
- Cross-file flows take priority (harder to detect, more valuable).
- If two clusters are borderline (similarity ~0.55–0.65), keep them separate but
  cross-reference.
- Track provenance: every merged finding must list its corroborating scanners/sources.

## SUMMARY

End your response with a single-line JSON SUMMARY prefixed with `SUMMARY:` (no space before the brace). Required: `merge_complete` (bool), `confidence` (CERTAIN|PROBABLE|POSSIBLE|UNCERTAIN). Optional: `merged_count` (int), `mempalace_drawer`, `needs_clarification` (bool) + `clarifying_questions` (list).

```
SUMMARY:{"merge_complete":true,"confidence":"PROBABLE","merged_count":7,"mempalace_drawer":"<id>","needs_clarification":false,"clarifying_questions":[]}
```
