# rez Reference

Supporting detail for the rez workflow. **Orientation only** — the NICE
section below describes the framework's *structure* so the fresh lookup knows
what to fetch. It is never a substitute for the live lookup in Step 2 of
SKILL.md.

## NIST NICE Framework Orientation

> ⚠️ Do NOT treat anything in this section as current framework data. Versions,
> work roles, and TKS statements change over time — fetch them live every run.

### What it is

The Workforce Framework for Cybersecurity (NICE Framework), defined by
**NIST SP 800-181 Rev. 1** (November 2020), is the canonical common language
for describing cybersecurity work. The **NICE Framework Components** are
maintained and versioned separately from the publication and are the data the
skill aligns against.

### Component structure (stable concepts, IDs verified as of 2026-07)

| Component | ID scheme | Notes |
|---|---|---|
| Work Role Categories | two-letter prefix (e.g., `OG`, `DD`, `PD`, `IN`, `IO`) | Broad groupings of work roles |
| Work Roles | `XX-WRL-###` (e.g., `PD-WRL-…`) | The primary alignment unit for a resume |
| Competency Areas | `NF-COM-###` | Cross-cutting clusters (e.g., AI Security, Cryptography) |
| Task statements | `T####` | What the work is |
| Knowledge statements | `K####` | What one must know |
| Skill statements | `S####` | What one must be able to do |

Ability statements were deprecated/refactored in Components v1.0.0 (2024).
Components use semantic versioning with periodic major/minor releases (e.g.,
v2.0.0 removed the Cyberspace Effects and Cyberspace Intelligence categories;
v2.2.0 added a C-SCRM work role). Always confirm the current version live.

### Live lookup entry points

| Source | URL | Use for |
|---|---|---|
| Current Versions page (primary) | `https://www.nist.gov/itl/applied-cybersecurity/nice/nice-framework-resource-center/nice-framework-current-versions` | Current components version, JSON/XLSX download links, CPRT + NICCS links |
| NICE Framework Resource Center | `https://www.nist.gov/itl/applied-cybersecurity/nice/nice-framework-resource-center` | Fallback landing page if the Current Versions URL moves |
| Change Logs | `https://www.nist.gov/itl/applied-cybersecurity/nice/nice-framework-resource-center/current-version/change-logs` | Confirm version dates |
| NICCS NICE Framework online (CISA-hosted) | linked from Current Versions page (`niccs.cisa.gov`) | Browsable per-work-role TKS statements |
| NIST CPRT | linked from Current Versions page (`csrc.nist.gov`) | Searchable components, streamlined JSON |

Lookup strategy: fetch the Current Versions page first, record the version,
then follow its links (or targeted `web_search`) to pull the TKS statements
for only the 1–3 work roles relevant to the JD — the full components dataset
is large and unnecessary.

## Bullet Craft (canonical — applies to every run)

> This is the single source of truth for how rez writes and validates resume
> bullets. synthia writes to it; vera enforces it. Keep the base resume and
> every tailored output in this style — do **not** regress to dense, narrative,
> multi-clause prose. (This spec was hardened 2026-07 after a base-resume review
> found the bullets had drifted into long STAR-narrative form.)

### Format: XYZ / achievement-focused (not STAR prose)

Resume bullets are **XYZ**, the format popularized by Google (Laszlo Bock):

```
Accomplished [X] [, as measured by Z,] by doing [Y]
```

Lead with the **outcome or a concrete action verb**; land the payoff **at the
front or the end of the line — never buried mid-sentence between em-dash asides**.
XYZ is denser and more scannable than STAR: recruiters scan a resume in ~6–7
seconds and only the first 2–3 words of each line are guaranteed to be read.
(STAR is the *interview* cousin — keep a STAR-shaped version of the 3 strongest
bullets ready for interview prep, but the resume itself is XYZ.)

### The nine rules

1. **First word is a strong, concrete, past-tense ownership verb.** Present
   tense is acceptable for the current role if the base resume uses it.
2. **Outcome-led, never buried.** The result leads or closes the line — it is
   never sandwiched inside em-dash asides. If you have to hunt for the payoff,
   rewrite.
3. **One result per bullet.** Split double-barreled bullets — two achievements
   crammed into one line become two tighter lines.
4. **15–30 words, one to two lines.** Three+ lines get skipped on the skim.
5. **Quantify only from the sources; be honest about scope.** Use numbers that
   appear in `resources/`. When the figure was a team result, write
   "Contributed to…", "Owned X within Y…", or "1 of N…" rather than claiming
   the whole. A round number with no baseline or scope reads as inflated —
   anchor it.
6. **No metric? Use a concrete substitute:** range, frequency, scope, or a
   before→after state ("cut intake from 4 months to 6 weeks"). Never vague
   filler ("improved security", "drove impact").
7. **Retire the 2026 AI-tell verbs** (they now read as machine-written):
   Spearheaded, Orchestrated, Leveraged (as a verb), Showcased, Synergized,
   Delved; Architected unless literally software architecture; Drove *unless*
   paired with a number. Also kill weak openers: "Responsible for", "Helped
   with", "Assisted in", "Worked on", "Duties included".
8. **Prefer concrete verbs:** Built, Shipped, Led, Designed, Developed, Reduced,
   Cut, Eliminated, Automated, Migrated, Standardized, Completed, Earned,
   Discovered, Uncovered, Exploited, Bypassed, Drove (+ number).
9. **Personality/voice stays off the resume.** A punchy, scannable line *is* the
   "human" element here; save the narrative headline voice for LinkedIn.

### Offensive-security / pentester bullets — attack narrative

A senior practitioner reads the resume after the recruiter, and they want
**exploitation and impact, not scanning**. Shape offensive bullets as an attack
narrative and lead with the finding class + impact:

```
entry point → vulnerability → exploitation → impact [→ remediation]
```

- Show manual exploitation and **chaining**, not automated scan output.
- Name the **CVE or critical finding early** — it is the strongest credibility
  signal on the page.
- "Bypassed authentication via flawed session validation, achieving account
  takeover" beats "Tested authentication mechanisms."

### Worked example (from this base resume)

- ❌ *Performed 110+ authorized penetration tests over 6 years across web, API,
  mobile, cloud, and microservice targets — including large-scale API/GraphQL
  tests that uncovered authorization gaps exposing PII and cut cross-team
  remediation from months to days — repeatedly finding critical vulnerabilities
  missed by internal, third-party, and code-review assessments.*
  (58 words; result buried mid-sentence; two achievements in one line)
- ✅ **Completed 110+ authorized penetration tests** across web, API, mobile,
  cloud, and microservice targets, repeatedly surfacing critical vulnerabilities
  that internal, third-party, and code-review assessments had missed.
- ✅ **Uncovered broken authorization in large-scale API/GraphQL testing** that
  exposed PII across downstream applications; drove cross-team remediation from
  months to days.

### Bullets per role

- Most recent / senior role: 6–8 (offensive roles can run to ~9 when each line
  is a distinct, tight achievement).
- Prior roles: 3–4. Roles 5+ years old: 2–3. Oldest: 1–2 or a one-line summary.

## ATS Guidance

- Single column, no text boxes, no tables for layout, no images, standard
  section headings ("Professional Experience", "Technical Skills",
  "Certifications", "Education").
- Mirror the JD's exact phrasing for skills the evidence supports; include
  acronym + expansion pairs on first use.
- Standard fonts (theme default), no headers/footers carrying content, dates
  in a consistent `Month YYYY – Month YYYY` format.
- Filename: `<CandidateName>_<Company>_<Role>_<YYYY-MM-DD>.docx` — recruiters
  and ATS both handle underscores cleanly.

## .docx Export Spec (word_generate)

| Parameter | Value |
|---|---|
| `theme` | `modern` |
| `font_size_pt` | 11 (drop to 10.5 if a page spills) |
| `margin_inches` | 0.7–0.8 (tighten toward 0.6 if a page spills) |
| `line_spacing` | **1.0** (max 1.05) — the base resume renders to exactly 2 pages at 1.0; 1.1+ orphans the trailing section onto a 3rd page |
| `table_style` | `minimal` (only if a skills table is used; prefer plain lists) |
| `include_page_numbers` | `false` |
| `cover_page` / `include_toc` | `false` |
| `output_path` | `/tmp/resumes/<CandidateName>_<Company>_<Role>_<YYYY-MM-DD>.docx` |

Markdown composition: `#` for the candidate name, contact line as a single
paragraph under it, `##` for section headings, `###` for role titles with a
bold employer/date line, `-` bullets for experience items.

**Page-limit rule (hard):** the exported `.docx` MUST be ≤ 2 pages. The base
resume is tuned to fit 2 pages at `line_spacing: 1.0`, `font_size_pt: 11`,
`margin_inches: 0.7–0.8` (modern theme). After export, verify page count
(e.g., `soffice --headless --convert-to pdf <file>.docx` then `pdfinfo`); if it
spills to 3 pages, recover in this order before cutting substance: (1) set
`line_spacing: 1.0`, (2) `margin_inches: 0.6`, (3) `font_size_pt: 10.5`,
(4) trim the weakest JD-irrelevant bullet. Do not exceed 2 pages.
