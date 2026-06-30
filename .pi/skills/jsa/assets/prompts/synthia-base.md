# Synthia Protocol — Merge & Dedup

> Injected as `skillContext` for synthia in the jsa MERGE/DEDUP phase.

## Mission

Consolidate raw findings from all chunk workers into a deduplicated, confidence-promoted, ranked set of merged findings. Resolve cross-chunk patterns. Stitch partial findings into complete vulnerability reports.

## Protocol

### 1. Collect Raw Findings
Query all findings from the feed room:
```
memory_search(wing="wing_jsa", room="{session_id}-findings", limit=500)
```

### 2. Group by (file, vuln_class)
All findings for the same vulnerability class in the same file form a comparison group.

### 3. Compute Similarity Matrix
For each group, compare every pair of findings. Two findings are "the same" if:
- **Source matches** (same or compatible source — e.g., both are URL-based)
- **Sink matches** (same or compatible sink)
- **Line proximity** (within 5 lines → likely same finding; within 20 → possibly same)
- **Code overlap** (token Jaccard > 0.5)
- **Description similarity** (MemPalace semantic search score > 0.85)

Weighted score: 25% source + 25% sink + 20% proximity + 15% code + 15% semantic.

### 4. Cluster Similar Findings
Agglomerative clustering with merge threshold 0.6. Higher-confidence findings serve as cluster anchors.

### 5. Merge Each Cluster
For each cluster of similar findings:
- **Keep the best** description, code snippet, and data flow trace
- **Set line range** to min start → max end across merged findings
- **Track sources**: which chunks contributed, which scanners agreed
- **Promote confidence**:
  - 2+ chunks independently found same pattern: possible → probable
  - 3+ chunks + 2+ scanners: probable → confirmed
  - All findings from same chunk: no promotion

### 6. Stitch Cross-Chunk Patterns
Check the mesh feed for cross-chunk hints:
```
memory_search(wing="wing_jsa", room="{session_id}-feed", query="cross_chunk_hint")
```

If a tainted source in chunk-N flows to a sink in chunk-M, merge those partial findings into one complete source-to-sink finding spanning both chunks.

### 7. Cross-File Dedup
Use MemPalace semantic search to find the same vulnerability pattern across different files (e.g., same React `dangerouslySetInnerHTML` pattern in 5 components). Merge into one finding with multiple file references.

### 8. Score & Rank
Score each merged finding 0-100:
- **Confidence** (40%): confirmed=40, probable=25, possible=10
- **Severity by vuln class** (30%): DOM XSS=30, prototype pollution=28, open redirect=15, etc.
- **Pervasiveness** (15%): more chunks/files = higher score
- **Scanner consensus** (15%): more independent scanners agreeing = higher reliability

Sort by score descending.

### 9. Store Merged Results
```
memory_add_drawer(wing="wing_jsa", room="{session_id}-merged", content={
  findings: [...],
  stats: {
    total_raw: N,
    total_merged: M,
    duplication_rate: 1 - M/N,
    clusters_formed: C,
    cross_file_merges: X,
    confidence_promotions: Y
  }
})
```

## Rules
- Never drop a finding — if ambiguous, keep it and flag for manual review
- Cross-chunk findings take priority (they're harder to detect, more valuable)
- If two clusters are borderline (similarity ~0.55-0.65), keep them separate but cross-reference
- Track provenance: every merged finding must list its source chunks and scanners
