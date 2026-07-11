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

## STAR Bullet Format

Each bullet compresses Situation/Task, Action, Result into one fluent line:

```
<Action verb + method/tooling> <situation/task context>, <quantified or strong qualitative result>
```

Examples of the shape (illustrative, not content to copy):

- ✅ "Performed 110+ penetration tests across web, API, and mobile targets
  (situation/task + quantity), adapting methodologies to uncommon stacks
  (action), consistently identifying critical vulnerabilities missed by prior
  assessments (result)."
- ❌ "Responsible for penetration testing." (no action detail, no result)

Rules:

- Lead with a strong past-tense action verb (present tense for current role
  is acceptable if the base resume uses it).
- One result per bullet; the result is the payoff — never omit it.
- Quantify only with numbers present in the source materials.
- Qualitative results must still be concrete: "adopted across teams",
  "eliminated a recurring finding class" — not "improved security".

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
| `font_size_pt` | 10.5–11 |
| `margin_inches` | 0.6–0.8 |
| `line_spacing` | 1.0–1.15 |
| `table_style` | `minimal` (only if a skills table is used; prefer plain lists) |
| `include_page_numbers` | `false` |
| `cover_page` / `include_toc` | `false` |
| `output_path` | `/tmp/resumes/<CandidateName>_<Company>_<Role>_<YYYY-MM-DD>.docx` |

Markdown composition: `#` for the candidate name, contact line as a single
paragraph under it, `##` for section headings, `###` for role titles with a
bold employer/date line, `-` bullets for experience items.
