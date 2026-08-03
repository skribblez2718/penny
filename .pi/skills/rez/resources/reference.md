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

### The eleven rules

1. **First word is a strong, concrete, past-tense ownership verb.** Present
   tense is acceptable for the current role if the base resume uses it.
2. **Outcome-led, never buried.** The result leads or closes the line. If you
   have to hunt for the payoff, rewrite.
   *Calibration:* no controlled experiment has ever tested intra-bullet clause
   order with content held constant, and the eye-tracking study usually cited
   for it found bullet copy "had little to no impact on the initial decision
   making." The defensible claim is only *don't bury the outcome* — not
   "result-first wins." Do not treat ordering as a scored rule.
3. **One result per bullet.** Split double-barreled bullets.
4. **18–28 words, one to two lines.** Blind-ranked bullets that lost averaged
   either 8 words (no context) or **41 words (buries the lede)**; winners
   averaged 23. Three+ lines get processed as a paragraph and abandoned.
   **Never let a number, framework name, or outcome fall at a line-wrap
   boundary** — wrap position, not importance, decides what gets read.
5. **Quantify only from the sources; be honest about scope.** When the figure
   was a team result, write "Contributed to…", "Owned X within Y…", or
   "1 of N…". A round number with no baseline reads as inflated.
   **Org-level metrics (MTTR, MTTD, breach cost, org-wide risk reduction) are
   not claimable by an individual contributor at all** — they are management
   claims and read as borrowed credit.
6. **Every bullet needs a result. Not every bullet needs a number.** Numerals
   draw the eye *because* they are sparse; saturating every line destroys the
   anchor effect. Concentrate defensible numerals in the top 1–2 bullets and
   let later bullets carry a named non-numeric result (a control retired, a
   standard adopted, a decision defended). No metric → use range, frequency,
   scope, or a before→after state. Never vague filler ("improved security").
7. **Retire these verbs.** Two different reasons, stated honestly because the
   distinction matters when judging borderline cases:
   - *Measured LLM markers* (present in a peer-reviewed 15.1M-abstract corpus
     study): **leveraged, streamlined, utilized, orchestrated, harnessed,
     showcased, delved, elevate, bolster, pinpoint, facilitate, meticulous,
     seamless, comprehensive, transformative, groundbreaking.**
   - *Cliche-saturated, not LLM fingerprints*: **spearheaded, championed.**
     ("Spearheaded" appears in resumes from 2010, twelve years pre-ChatGPT.)
     Avoid them anyway — perception drives rejection — but do not claim they
     are AI markers.
   - Weak openers, always: "Responsible for", "Helped with", "Assisted in",
     "Worked on", "Duties included".
   - **"Architected" is permitted when the candidate actually designed and
     built the system** (infrastructure, platform, or software). It is barred
     only when applied to a system the candidate merely assessed — see the
     verb ladder below.
8. **Prefer concrete verbs:** Built, Shipped, Led, Designed, Developed, Reduced,
   Cut, Eliminated, Automated, Migrated, Standardized, Completed, Earned,
   Discovered, Uncovered, Traced, Exploited, Bypassed, Distilled, Stood up,
   Drove (+ number).
9. **Vary opening verbs and verb shapes across a block.** Readers deliberately
   skip the first words of a line once the same word repeats, after only one or
   two exposures — a block opening "Led… Led… Led…" trains the eye past the
   highest-value position on every subsequent line. This is a reading-behavior
   finding *and* an AI-tell countermeasure; two independent evidence bases
   converge on the same fix.
10. **Vary bullet length deliberately.** Uniform length and perfectly parallel
    structure are the markers recruiters name most often, because they are
    visible without reading. Hold tense and person constant; let length and
    lead-in be uneven.
11. **Personality/voice stays off the resume.** A punchy, scannable line *is*
    the "human" element here.

### Anti-AI-tell audit (run before export)

Recruiters' *measured* ability to detect AI text is near chance (33–50%), but
they act on the belief anyway. What they actually detect is **sameness across a
stack**, not per-document deviance. For a strong senior candidate the failure
mode is not rejection — it is **invisibility**. No ATS runs AI-authorship
detection, and text detectors do not work on resume-length text. **Do not design
to beat a detector; design against comparative sameness.**

| Marker | Rule |
|---|---|
| **Em-dashes** | **Zero in bullets.** In one practitioner test (n=1,072) the em-dash alone drove ~72% of "this is AI" calls; stripping it let the same AI text pass as human 65–68% of the time. Use commas, semicolons, or parentheses. |
| **`**Bolded theme:** description`** | Never. This is the single most-named recruiter tell, because it is visible without reading. |
| **Uniform bullet length / parallel structure** | See rules 9–10. Deliberate asymmetry. |
| **Rule-of-three lists** | Watch for three stacked abstract adjectives before a generic noun. Four or five concrete nouns is fine. |
| **"not X, but Y" antithesis** | Only if the second clause adds information the first did not. Otherwise it performs depth instead of delivering it. |
| **Abstraction replacing specificity** | LLMs regress to the mean, swapping a specific fact for a generic superlative. Named artifacts always beat adjectives. |
| **JD mirroring** | See the ATS section — this is the highest-risk marker and the only one with both recruiter testimony *and* measured rejection association. |
| **First-person pronouns** | None. Implied first person is the convention. |

**Three tests before export:** read each bullet aloud; swap the job title and
see whether the sentence still works (if it does, it is too generic); confirm
the candidate could narrate each bullet for 60–90 seconds cold.

### The voice-marker bullet (highest-value single pattern)

Include **one** bullet per resume built on a **judgment call rather than an
output** — a finding deliberately not filed as critical and why, a control
recommended against, a scope negotiated down, a fix that contradicted a
standing position. Place it at position 3 in the most recent block.

> ✓ *"Refused to ship the recommended ranking model because offline metrics had been gamed by training-test leakage; rebuilt the evaluation set, lost three weeks, and shipped a model that held its lift in production."*

This is un-fabricable, cannot be generated without lived context, and
demonstrates seniority through a defended trade-off rather than an adjective.
The rarest and hardest-to-fake senior signal is documented **judgment**, not
documented output. Source it from `resources/accomplishments/`; never invent it.

### Verb ladder and truthfulness preconditions

Use the **strongest rung that is literally true**:

> reviewed → assessed → threat-modeled → specified security requirements for →
> designed [a control/pattern] → owned the architecture of

A "Penetration Tester" title credibly supports up to *specified security
requirements for*; it supports *designed* only for artifacts the candidate
personally built, and essentially never *owned the architecture of* a system
they assessed.

**"Remediated" requires one of these to be true** — name which:
(a) personally implemented the fix → "implemented"; (b) designed/specified it and
an owner built it → "authored remediation guidance for"; (c) re-tested and
verified closure → "validated closure of N findings by retest"; (d) tracked to
disposition → "drove to disposition". If none apply, stay in identify-and-record
language.

**Four claims with no honest path — never write them under any precondition:**

1. Testing N systems → "secured/protected N systems." Testing does not secure.
2. Finding counts → "prevented N breaches." Counterfactual and unfalsifiable.
3. A report reaching an executive → "advised the CISO." Say "produced the findings presented to…" or, if they personally briefed, "briefed…".
4. Tool familiarity → "engineered detections / built the SIEM."

**Detection-improvement claims** additionally require that the engagement
carried a defensive objective agreed in the rules of engagement *beforehand*.
An unscoped test where nobody happened to catch the tester does not validate
detection.

### Target-lane framing (pivot handling)

When the JD's lane differs from the candidate's title history — offensive title
targeting a defensive/architecture/AI-security role, or the reverse — **pick a
spine; do not splay both equally.** A resume weighting red and blue evenly reads
as a generalist rather than a pivot.

- **Bullet 1 is the destination bullet:** the strongest evidence the candidate
  already does the *target* work, not their most impressive past-lane work.
- **Order bullets by relevance-to-target, not raw impact.** Ranking by impact
  actively hurts a pivoting candidate, because their highest-impact work is by
  construction their past-lane work.
- **Past-lane work is admissible high in the block only as the warrant for a
  target-lane claim**, never as the claim itself.
- **Do not retitle.** Employment verification returns official titles from
  payroll records. Translation operates at the verb and object level inside
  bullets, never at the title level.

**Offensive → defensive translation** (the standards bodies already did this
work; citing them is not spin): NIST CSF 2.0 files penetration testing under
**IDENTIFY → IMPROVEMENT (ID.IM-02)**, and NIST AI RMF **GOVERN 4.1** files
red-teaming as "a risk measurement and management approach."

| Past-lane activity | Target-lane framing | Risk |
|---|---|---|
| Pentest findings | control-gap identification, remediation evidence | HIGH — see "remediated" preconditions |
| Red-team campaign | adversarial evaluation, detection-capability validation | MEDIUM — requires pre-agreed defensive objective |
| Exploit PoC | exploitability validation, risk prioritization | LOWEST — stays inside personally-performed work |
| Report templates | repeatable assessment methodology, consistent reporting | LOW — artifact-owned, highest ROI |
| Secure code review | secure-by-design assurance | HIGHEST — see verb ladder |

### Offensive-lane bullets (when the target IS offensive)

Applies only when the JD's spine is offensive. A senior practitioner reads the
resume after the recruiter and wants **exploitation and impact, not scanning**:

```
entry point → vulnerability → exploitation → impact [→ remediation]
```

Show manual exploitation and chaining, not scan output. Name the CVE or critical
finding early. "Bypassed authentication via flawed session validation, achieving
account takeover" beats "Tested authentication mechanisms."

**If the target lane is defensive, do not apply this section** — it will
reinforce the identity the candidate is moving away from.

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

### Worked examples

**Length and buried payload:**

- ❌ *Performed 110+ authorized penetration tests over 6 years across web, API,
  mobile, cloud, and microservice targets — including large-scale API/GraphQL
  tests that uncovered authorization gaps exposing PII and cut cross-team
  remediation from months to days — repeatedly finding critical vulnerabilities
  missed by internal, third-party, and code-review assessments.*
  (58 words; two achievements; em-dash asides; payload buried mid-sentence)
- ✅ *Tested hardened enterprise web, mobile, API, and AI applications across
  diverse languages and architectures, finding critical vulnerabilities prior
  internal and third-party assessments had missed, including CVE-2022-41402.*
  (26 words; one claim; CVE lands late where it closes the line)

**Abstraction vs. named artifact:**

- ❌ *Drove secure-by-design architecture across the product portfolio.*
- ✅ *Traced an insecure infrastructure-as-code default resulting in EKS
  privilege escalation across many AWS accounts; worked with the owning team to
  correct the issue at its source so every affected deployment inherited the
  correction.*

**Force multiplication stated vs. shown:**

- ❌ *Focused on force multiplier solutions that empower others and increase
  efficiency to scale the business.* (three abstractions, zero anchors)
- ✅ *Distilled prompt-engineering research into two meta-assistants, one
  writing finished system prompts and one rewriting rough goals into
  AI-actionable ones, enabling teams across the enterprise to build their own
  effective AI workflows unaided.*

### Bullets per role

The domain-closest evidence (a cyber-specific recruiter who has read 1,000+
security resumes, independently corroborated by an eye-tracking checklist) puts
the ceiling far lower than general-market resume advice does:

> "The most you get for any role is two to four bullets, because any more than
> that it really feels like you're just trying to prove a point that you're
> good — but the more you try to prove the point that you're good, the harder
> it feels."

- **Most recent / most JD-relevant role: 2–4 bullets; 5 absolute maximum.**
- Prior roles: 2–3. Roles 5+ years old: 1–2. Oldest: 1 or a one-line summary.
- **Exception, use deliberately:** a low-volume senior/specialist req (typically
  under 200 applicants, vetted more deeply) or a referral can support up to 7
  on the most recent role, because the 6–7-second triage model is calibrated on
  high-volume junior funnels and may not apply. Do not use this exception for a
  cold application to a public posting.
- **Uneven depth is correct.** Equal bullet counts and equal detail across roles
  regardless of recency is itself a named AI tell; most real estate belongs on
  the recent and relevant.

**Cutting criteria**, in order: (1) does this bullet document the direction the
candidate is going, or only make the past job legible? (2) do two bullets differ
only in the tool named — if so they are one bullet with a list; (3) is the only
defensible claim an org-level metric the candidate did not own; (4) does the
opener duplicate the bullet above it.

## ATS Guidance

- Single column, no text boxes, no tables for layout, no images, standard
  section headings ("Professional Experience", "Technical Skills",
  "Certifications", "Education").
- Mirror the JD's phrasing for **discrete skills, tools, and certifications**
  the evidence supports; include acronym + expansion pairs on first use.
- ⚠̊ **Guardrail — do not mirror JD *sentences* or framing language.**
  Over-mirroring is the single AI-generation marker with both first-person
  recruiter testimony and a measured association with rejection: *"They're
  taking AI and using it to actually rewrite to match the job description… it
  looks too close to the job description."* A resume that returns a hiring
  manager's own mandate vocabulary to him, unaccompanied by artifacts, is the
  document that quote describes.
- **Collateralization rule:** every abstract phrase borrowed from the JD
  ("control effectiveness", "measurable evidence", "secure-by-design",
  "risk-aligned", "scalable operating models") must carry a **named artifact in
  the same bullet** — a specific system, a control identifier, a tool the
  candidate built, a finding count, or a date range. No bullet carries more than
  one abstract noun without a proper noun or number attached to it.
- Keyword placement matters more for **recruiter Boolean sourcing** than for
  screening an incoming application. No major ATS autonomously rejects on
  content; knockout questions do. Do not let the "75% of resumes are rejected by
  ATS" myth (traced to a 2012 vendor sales pitch, no methodology ever published)
  drive formatting decisions.
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
