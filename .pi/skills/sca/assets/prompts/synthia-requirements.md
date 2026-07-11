# P5 — Requirements (Domain Guidance for `synthia`)

Derive the security requirements the target must satisfy, from the P3 context
and P4 architecture summarized in your task. Emit them as STRUCTURED, stable
`SR-###` records — not prose — so downstream phases consume them by ID: the P6
threat model references the requirement each threat would violate, and the P12
report renders a real per-`SR-###` coverage table directly from your output.

**MemPalace:** write ALL entries for this phase to wing `wing_sca`, room
`<session_id>-p5_requirements`. Search that wing first for the P3_CONTEXT
(actors, assets, PII decision) and P4_ARCHITECTURE (components, flows,
boundaries, entry points) — every requirement must trace to one of those facts.
Emit the structured `SUMMARY:{...}` block inline; longer rationale lives in
mempalace.

---

## 1. `SR-###` numbering convention

Assign every requirement a stable id `SR-NNN`, zero-padded to three digits,
allocated sequentially in the order you record them (`SR-001`, `SR-002`, …).
IDs are **append-only** within a session — never renumber an existing
requirement; if you drop one, retire its id with a one-line note rather than
reusing it. The id conveys identity only; category lives in the fields, not the
digits.

## 2. ASVS citation format

Cite the OWASP ASVS control each requirement maps to as
**`V<chapter>.<section>`** — for example `V8.2` (data protection), `V2.1`
(authentication), `V4.3` (access control). Use exactly this short
chapter.section form; do NOT emit versioned or four-part strings such as
`v5.0.0-8.2.1`, and do NOT invent a chapter number — an unsure mapping is
worse than an honest gap. Pick the most specific control that fits; if none
fits cleanly, record `"none-applicable"` rather than forcing a bad mapping. A
consistent citation format is what lets the P12 report render your requirements
as an auditable coverage table.

## 3. Required fields per requirement

Each `SR-###` record MUST carry:

- **`sr_id`** — the `SR-NNN` identifier.
- **`asvs`** — the `V<chapter>.<section>` citation (or `"none-applicable"`).
- **`text`** — the requirement as a concrete, testable statement of what the
  system MUST do (e.g. "Enforce authorization on every admin API route").
- **`basis`** — the P3/P4 fact that motivates it, referencing the phase and
  element (e.g. `"P4:admin-API↔user-db flow; P3:actor=admin, data=PII"`).

## 4. Ground each requirement; do not pad

Derive requirements from real context and architecture — an actor, asset, flow,
boundary, or entry point that genuinely needs a control. Prioritize the
sensitive/PII flows and the unauthenticated entry points P3/P4 surfaced; those
earn the strongest requirements. Do NOT emit generic checklist items with no
`basis` in this target — a padded ledger dilutes the real requirements and
misleads the P12 coverage table. Where a needed control cannot be tied to a
concrete fact, record it as an **unknown** to resolve rather than asserting a
phantom requirement. This phase depends on P3 and P4: if either is missing or
thin, derive what the available facts support, mark the rest unknown, and set
`needs_clarification: true` in your SUMMARY when critical ambiguity blocks a
sound requirement.

## 5. Mandatory structured output

Write the full requirement set (with rationale) as mempalace entries in the P5
room, then emit the structured summary the orchestrator reads. The
`security_requirements` list is machine-readable and consumed downstream by id:

```
SUMMARY:{"security_requirements":[{"sr_id":"SR-001","asvs":"V8.2","text":"Enforce authorization on every admin API route","basis":"P4:admin-API↔user-db flow; P3:actor=admin"}],"count":<n>,"unknowns":["<one line>"],"needs_clarification":<true|false>,"clarifying_questions":[],"confidence":"CERTAIN|PROBABLE|POSSIBLE|UNCERTAIN","mempalace_drawer":"<id>"}
```

Every requirement gets a stable `SR-###`, a correctly-formatted `V<chapter>.<section>`
ASVS citation, a testable statement, and a real P3/P4 basis — so downstream
phases build on IDs, not prose.
