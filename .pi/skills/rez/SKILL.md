---
name: rez
description: Tailors the base resume to a specific job description — gap analysis (matches, misses, transferables), STAR-format bullet rewriting, ATS keyword optimization, fresh NIST NICE Framework alignment every run, and modern .docx export to /tmp/resumes/. Use when the user provides a job description (URL or pasted text) and wants a tailored resume — signals like "tailor my resume", "resume for this job", "apply to this posting", "rez this JD". Do not use when the deliverable is a cover letter, when editing the base resume itself, or when no job description is provided.
license: MIT
compatibility: Requires the shared orchestration engine, the word extension's word_generate tool (invoked by skribble) for .docx export, and web access for URL job descriptions and the NIST NICE lookup.
metadata:
  version: "2.0.0"
  penny:
    engine: orchestration
    mempalace: true
    subagents:
      - annie
      - echo
      - synthia
      - vera
      - skribble
---

## When to Use

- User provides a job posting (URL or text) and wants the resume tailored to it
- "Tailor my resume for…", "apply to this", "rez this JD"

## When Not to Use

- Cover letters or other application documents (skribble directly)
- Editing/updating the base resume itself (edit `resources/resume/` directly)
- No job description available (the skill errors by design)

## Invocation

Invoke via the `skill` tool. The skill extension handles orchestration — agents
communicate via mempalace, Penny receives structured summaries.

```
skill({
  skill_name: "rez",
  goal: "<job posting URL | absolute path to a JD text file | short inline JD text>",
  project_root: "/path/to/project"
})
```

**Goal contents:** task messages cap embedded values at ~600 chars, so pass a
**URL** or a **file path** for long postings. If the user pastes a long JD,
save it first (e.g. `/tmp/resumes/jd-<session>.txt`) and pass that path as the
goal. Short pasted text may be passed inline.

### Parameters

| Parameter      | Required | Description                                          |
| -------------- | -------- | ---------------------------------------------------- |
| `skill_name`   | Yes      | Must be `"rez"`                                      |
| `goal`         | Yes      | The job description: URL, file path, or inline text  |
| `session_id`   | No       | Unique session ID (auto-generated if omitted)        |
| `project_root` | No       | Project root directory (defaults to cwd)             |
| `constraints`  | No       | JSON object (e.g. `{ "max_iterations": 2 }`)         |

**No job description → error.** An empty goal fails at start; a goal that
yields no usable JD content aborts the run with
`ERROR: No job description provided…`. Never invent or reuse a previous JD.

## Pipeline (what the engine runs)

| State | Agent | Does |
|---|---|---|
| `analyzing` | annie | Ingest JD (fetch/read/inline), load `resources/resume/` + `resources/accomplishments/` read-only, gap analysis: matches / misses / transferables |
| `aligning` | echo | **Fresh NIST NICE lookup every run** — current components version from the NICE Current Versions page + TKS verbiage for the 1–3 JD-relevant work roles. Never cached data |
| `tailoring` | synthia | STAR bullets, ATS keywords, NICE canonical verbiage, zero fabrication; full resume markdown → mempalace |
| `validating` | vera | Anti-fabrication trace of every bullet against sources + STAR/ATS/NICE compliance; bounded revise loop (default budget 3) |
| `exporting` | skribble | Render validated markdown → `.docx` in `/tmp/resumes/` via the word extension's `word_generate` tool; verify on disk |

Hard guarantees enforced by the playbook
(`orchestration.playbooks.rez:RezPlaybook`):

- Source materials under `resources/` are read-only for every lane.
- No base resume → run aborts with an error.
- No accomplishments → proceeds with base resume only (noted in the result).
- NIST/NICCS unreachable → proceeds **unaligned**, every bullet prefixed
  `[UNALIGNED]`, skip reported in the result. Remembered framework data is
  never substituted.
- A resume that fails the anti-fabrication check is revised or the run
  completes honestly with `met: false` — it is **never exported**.
- word extension missing or export failure → error, no fallback format.

## Post-Completion

After the skill completes, present the result — do not silently re-edit the
resume.

### Procedure

1. Read `result.rez_summary`: report the `output_path`, NICE version and
   work roles (or the alignment-skipped reason), match/miss/transferable
   counts, and whether accomplishments were used.
2. Fetch the gap analysis and validation report for the user's review:
   ```
   memory_smart_search(query="<session_id> Gap Analysis", room="skills/rez-<session_id>", limit=3, include_full=true)
   memory_smart_search(query="<session_id> Validation", room="skills/rez-<session_id>", limit=3, include_full=true)
   ```
3. Be candid about **misses** — they are interview-prep signal, not failures.
4. If `result.exhausted` is true: the resume did NOT export. Present
   `result.unresolved_issues` and ask whether to re-run with guidance or fix
   the source materials.

### Constraints

- Do not modify `resources/resume/` or `resources/accomplishments/` — ever.
- Do not edit the exported .docx content by hand; re-run the skill with
  refined input instead.
- Do not soften the miss list or the unresolved-issues report.

## Human-in-the-Loop Pauses

Any lane can escalate (`awaiting_clarification`) when an agent reports
UNCERTAIN confidence or requests clarification, and a stalled revise loop
escalates rather than exporting an unverified resume. Escalations surface
`escalation` data with `questions`.

### Procedure

1. Check `if (result.escalation) { ... }`.
2. Present the questions via `questionnaire` using
   `result.escalation.questions`.
3. Resume by re-issuing the step as the `user` agent — the engine rehydrates
   by `run_id` from the durable checkpointer:
   ```typescript
   skill({
     skill_name: "rez",
     run_id: result.run_id,
     user_response: questionnaire_result,
   });
   ```
   A clarify-resume re-enters at `analyzing` and re-runs the pipeline (the
   NICE lookup is required to be fresh anyway, so the re-run is correct by
   construction).

## Post-Completion Storage

The engine records the run outcome automatically — do **not** write session
drawers or knowledge-graph edges by hand. All artifacts live in the mempalace
room `skills/rez-{session_id}` (wing `penny`): gap analysis, NICE alignment
digest, tailored resume markdown, validation report, export record.

## Resilience

The engine validates every agent SUMMARY against the state's contract before
advancing the FSM. `fabrication_free` is a **required** field of the
validation contract — it can never be silently defaulted. A stalled revision
loop escalates instead of force-approving; budget exhaustion completes with
`met: false` and the unresolved issues reported (and no export). Run state is
durable in the `run_id`-keyed checkpointer, so a killed run is resumable via
`recover`.

## Resources

- [resources/reference.md](resources/reference.md) — NICE orientation
  (structure + lookup entry points only, never a data source), STAR/ATS
  guidance, .docx export spec
- `resources/resume/` — base resume (source of truth, read-only)
- `resources/accomplishments/` — accomplishment evidence (optional, read-only)
