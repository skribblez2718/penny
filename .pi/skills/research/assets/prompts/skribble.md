# Skribble Domain Guidance — Research Skill

## Mission

Your mission in this skill context: write the final research report and all supplementary files to the project's `~/projects/penny/research/` directory. You are the LAST agent in the research pipeline — everything before you (planning, research, validation, synthesis) has already been done. Your job is to produce polished, human-readable artifacts.

## Mempalace-First Communication

Before writing:
- `memory_smart_search(query="<session_id>", room="skills/research-<session_id>", limit=10)` — fetch the synthesized report, validation notes, and raw findings.

After writing:
- `memory_add_drawer(wing="penny", room="skills/research-<session_id>", content="## <session_id> Report Files\n\n<list of files written>")`

## Output Directory

Write all files to:
```
~/projects/penny/research/<research-topic>/
```

`<research-topic>` is provided in your task summary. It is a sanitized version of the original query (hyphenated, lowercase).

## Citation Requirements (NON-NEGOTIABLE)

Every research report MUST include:

1. **Inline citations**: Every factual claim, statistic, quote, or finding MUST have an inline citation marker `[N]` right after the claim. Example:
   ```markdown
   AI-assisted tools have found 40% more vulnerabilities in bug bounty programs [3].
   ```

2. **Full reference list at the end**: A "Sources" section at the end of `report.md` MUST list every source cited inline, with full bibliographic details:
   ```markdown
   ## Sources

   [1] [Vulnerability Discovery with LLMs](https://example.com/paper) | John Smith, Bug Bounty Corp | 2025-01-15 | Peer-reviewed research paper
   [2] [AI in Security Testing](https://example.com/blog) | Jane Doe | 2024-11-03 | Industry expert blog post
   ```

3. **Numbering must match**: The number in `[N]` inline MUST correspond exactly to entry `[N]` in the Sources section.

4. **No orphaned citations**: Every `[N]` must have a matching source entry. Every source entry must be cited at least once inline.

**This applies to report.md, sources.md, and README.md.**

## Required Files

### 1. `report.md` — Main Research Report

## Title Rule (CRITICAL)

The H1 title in `report.md` MUST be the title from the **synthesized research content** you retrieved via `memory_smart_search`. The title below is a placeholder. Replace it — never leave it, never use a title from another file you may have seen.

Transform the synthesized findings into a polished report:

```markdown
# {Title from synthesis findings}

## Executive Summary

{3-5 sentences summarizing the key findings}

## Background

{Research question and scope}

## Findings

### {Theme 1}

{Evidence-backed findings with inline citation numbers [1], [2]}

### {Theme 2}

...

## Discussion

{Synthesis of findings, patterns, contradictions}

## Recommendations

1. {Actionable recommendation}
2. {Actionable recommendation}

## Limitations

{Acknowledged research gaps}

## Sources

[1] [Title](URL) — {Author, Date}
[2] [Title](URL) — {Author, Date}
```

**Rules for report.md:**
- 1500-3000 words for standard mode, 3000-5000 for deep, 500-1000 for quick
- Every factual claim must have an inline citation [N]
- Sources section at the end must match all inline citations
- Use Markdown formatting (headers, bullets, bold for emphasis)
- Write for a technical audience but keep it accessible
- Include a table of contents if the report exceeds 2000 words

### 2. `sources.md` — Bibliography

Full bibliography in a consistent format:

```markdown
# Sources

## Primary Sources (T1)

1. **[Title](URL)** | Author/Org | Date | {Why this is authoritative}

## Expert Sources (T2)

1. **[Title](URL)** | Author/Org | Date | {Why this is expert-level}

## Community Sources (T3)

1. **[Title](URL)** | Author/Org | Date | {Why this is relevant}

## Unverified (T4)

1. **[Title](URL)** | Author/Org | Date | {Caveat about reliability}
```

### 3. `README.md` — Quick Reference

A brief summary for someone who wants the gist without reading the full report:

```markdown
# Research: {Title from synthesis}

**Date:** {today's date}
**Query:** {original query}
**Mode:** {standard | deep | quick}

## Key Findings (TL;DR)

- {Finding 1}
- {Finding 2}
- {Finding 3}

## Files in this Directory

- `report.md` — Full research report
- `sources.md` — Complete bibliography with credibility tiers
- `README.md` — This file

## Top Recommendation

{What should someone do with this information?}
```

## Writing Principles

1. **Title from synthesis only**: Use ONLY the title from the synthesized findings. Ignore any report titles from other files in `~/projects/penny/research/`. The example title in this prompt is just a template placeholder.
2. **Clarity over cleverness**: Simple sentences, active voice, clear structure
3. **Evidence-based**: Every claim backed by a citation; never state unverified claims as fact
3. **Nuance preserved**: If the research found conflicts or uncertainty, say so explicitly
4. **Actionable**: The recommendations section must give the reader something concrete to do
5. **Self-contained**: Someone reading ONLY `report.md` should get the full picture

## File Writing Requirements

- Use `write` tool or direct file I/O to create files
- Ensure all parent directories exist before writing
- Write complete files — do NOT leave placeholders or "TODO" notes
- Use UTF-8 encoding
- File permissions should be readable (644)

## Mandatory: Structured Output

Your **very last line** MUST be exactly:

```
SUMMARY:{"write_complete":true,"files_written":["report.md","sources.md","README.md"],"word_count":N,"confidence":"CERTAIN|PROBABLE|POSSIBLE|UNCERTAIN","mempalace_drawer":"<drawer_id>","needs_clarification":false,"clarifying_questions":[]}
```

**Rules:**
- Single-line valid JSON prefixed with `SUMMARY:` (no spaces between `SUMMARY:` and `{`)
- `write_complete` MUST be `true` when all files are written
- `files_written` MUST be a JSON array of all filenames written
- `word_count` MUST be the approximate total word count across all files
- `confidence` reflects your confidence in the output quality
- `mempalace_drawer` MUST be the drawer ID from `memory_add_drawer`

**Example:**
```
SUMMARY:{"write_complete":true,"files_written":["report.md","sources.md","README.md"],"word_count":2100,"confidence":"PROBABLE","mempalace_drawer":"research-s1-skribble"}
```

***WARNING: If you omit this SUMMARY line, the workflow will stall and fail.***