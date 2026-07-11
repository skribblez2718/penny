# rez — Resume Tailoring Skill

Tailors the base resume to a target job description and exports a modern,
ATS-friendly `.docx` to `/tmp/resumes/`.

## What it does

1. Accepts a job description as a **URL or plain text** (errors if none given).
2. Loads the base resume from `resources/resume/` and accomplishments from
   `resources/accomplishments/` (read-only; accomplishments optional).
3. Performs a **fresh NIST NICE Framework lookup every run** (no cached data)
   to get current Work Roles and TKS verbiage — the canonical truth for
   cybersecurity concepts.
4. Runs a gap analysis: skill matches, skill misses, transferable skills.
5. Rewrites the strongest matches/transferables as **STAR-format bullets**
   with JD keywords for ATS, quantified where the evidence allows.
6. **Never fabricates or exaggerates** — every bullet must trace to a source
   statement.
7. Exports via the word extension (`word_generate`) to
   `/tmp/resumes/<Name>_<Company>_<Role>_<date>.docx`.

## Architecture

Python-orchestrated skill on the shared engine
(`orchestration.playbooks.rez:RezPlaybook`), five lanes:

| State | Agent | Lane |
|---|---|---|
| analyzing | annie | JD ingest + gap analysis |
| aligning | echo | fresh NIST NICE lookup (every run) |
| tailoring | synthia | STAR/ATS/NICE tailoring |
| validating | vera | anti-fabrication trace + compliance (bounded revise loop) |
| exporting | skribble | .docx render to /tmp/resumes/ via the word extension's `word_generate` tool |

Agents communicate via the mempalace room `skills/rez-{session_id}`.

## Invocation

```
skill({ skill_name: "rez", goal: "<JD url | JD file path | short inline text>" })
```

Long pasted JDs: save to a file first and pass the path (task messages cap
embedded values at ~600 chars).

## Setup

Before first use, add source materials (the skill never modifies them):

- `resources/resume/` — the base resume (markdown preferred)
- `resources/accomplishments/` — accomplishment notes (optional)

## Edge cases

| Condition | Behavior |
|---|---|
| No job description | Error, stop |
| No base resume | Error, stop |
| No accomplishments | Proceed with base resume only |
| NIST NICE unreachable | Proceed unaligned, bullets marked `[UNALIGNED]` |
| word extension missing | Error, stop (no fallback format) |
| Validation budget exhausted | Complete honestly with `met: false` + unresolved issues; **no export** |
