# P0 — Charter (Domain Guidance for `echo`)

Open the sca (secure-code analysis) engagement by reviewing, confirming, and
enriching the charter draft the orchestrator has ALREADY computed from the
target on disk. That draft (`target_path`, `output_dir`, detected lockfiles,
`workspace_count`, `evidence_standard`, `out_of_scope`) is embedded in your
task — confirm it and spot gaps, do NOT originate scope from scratch. A human
approves the charter at the gate immediately after this phase, so accuracy here
fixes the rules of engagement for every downstream phase.

**MemPalace:** write ALL entries for this phase to wing `wing_sca`, room
`<session_id>-p0_charter`. First search that wing for any prior charter from an
earlier run of this target and reconcile rather than duplicate. Emit only a
compact `SUMMARY:{...}` JSON block inline; the full charter review lives in
mempalace.

---

## 1. Confirm the pre-computed draft

Check each supplied field against the real target tree:

- **target_path / output_dir** — the directory exists and is the intended
  source tree; `output_dir` sits under `/tmp`, never inside the project tree.
- **lockfiles / workspace_count** — the detected lockfiles match what is on
  disk; a monorepo's extra workspaces are not missed.
- **evidence_standard** — carry the `observed → inferred → assumed → unknown`
  tiers forward unchanged; downstream phases classify findings against them.

## 2. Spot gaps the draft cannot see

Flag anything the deterministic draft would miss, each with a one-line reason:

- source directories or workspaces that belong in scope but went undetected;
- paths that SHOULD be out of scope (vendored code, generated output, test
  fixtures, anything holding real secrets or production data);
- a target that looks empty, wrong, or mismatched with the stated goal.

Do not invent scope the user has not asked for — surface candidates and let the
human gate decide.

## 3. Constraints and tradeoffs

- Ground every claim in the actual tree; never assert a file or dependency the
  draft did not detect and you did not see.
- Broader scope raises coverage but dilutes depth — name that tradeoff when you
  recommend a scope change.
- If critical ambiguity blocks a confident charter and cannot be resolved from
  available context, set `needs_clarification: true` with `clarifying_questions`
  in your SUMMARY rather than guessing.

## 4. Output shape

Record your charter review as a mempalace entry in the P0 room: the confirmed
fields, each flagged gap with its reason, and any recommended `out_of_scope`
additions. Then emit a compact inline summary:

```
SUMMARY:{"phase":"P0_CHARTER","charter_confirmed":<true|false>,"lockfiles_ok":<true|false>,"workspace_count":<n>,"scope_gaps":["<one line each>"],"recommended_out_of_scope":["<path>"],"needs_clarification":<true|false>}
```

Confirm what the draft got right, flag what it could not see, and leave the
scope decision to the human gate.
