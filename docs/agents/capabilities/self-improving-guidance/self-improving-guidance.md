# Self-Improving Guidance — Amendment pipeline for SYSTEM.md and skill prompts

## What

When outcome patterns reveal systemic gaps, the compression loop proposes targeted amendments (skill prompts, config, or preferences). Amendments go through classification → generation → Carren review → **human approval** before any file is modified. Once a human approves an amendment's concrete diff, the applier applies it to **any** target file (Domain Guidance, config, docs, code, or SYSTEM.md) — reviewing-and-approving the exact diff IS the human-in-the-loop. The one exception: the immutable security-directives block is never machine-editable (see Rules).

## Why

Static prompts drift from reality as usage patterns emerge. The amendment pipeline closes this gap without risking un-reviewed changes to system-critical files.

## Rules

1. **Human approval is authorization.** All changes go through amendment → review → apply; once a human approves the concrete diff, the applier applies it verbatim to any target (skill prompts, config, docs, code, or SYSTEM.md). The immutable security-directives block (`<system_directives>` / `<system_boundary>`, and the SECURITY DIRECTIVES / SECURITY REINFORCEMENT sentinels) is the one exception — never machine-editable, even with approval.
2. **Concrete diffs only.** Approve and apply both require a verbatim `old_text`/`new_text`; an empty diff is refused. Apply is drift-safe — if `old_text` no longer matches, the change fails closed rather than splicing blindly.
3. **Every amendment must cite evidence.** Drawer IDs or outcome ledger entries.
4. **Review gate cannot be bypassed.** Applier rejects status != APPROVED.
4. **Net size delta ≤ 0 per cycle.** Add N tokens → remove ≥ N tokens.
5. **Rollback always available.** Previous versions stored in `penny/system_versions`.

## Pipeline

```
Outcome MISMATCHes → compression_loop → target_classifier → amendment_generator
    → mempalace (PENDING) → Carren review → session_start_checker
    → user questionnaire (APPROVE/MODIFY/REJECT) → amendment_applier → git commit
```

## Components

| Component | File | Purpose |
|-----------|------|---------|
| Target Classifier | `target_classifier.py` | Maps learning to target layer via keyword heuristics |
| Amendment Generator | `amendment_generator.py` | Builds structured amendment JSON |
| Amendment Applier | `amendment_applier.py` | Applies APPROVED amendments + git commit |
| Compression Loop | `compression_loop.py` | Orchestrates: outcomes → patterns → classification → generation |
| Session-Start Checker | `session_start_checker.py` | Surfaces pending amendments to user |

## Target Layers

| Layer | Target Files | Classifier Keywords |
|-------|-------------|-------------------|
| DOMAIN_GUIDANCE | `.pi/skills/*/assets/prompts/*.md` | Domain-specific terms |
| MEMPALACE_PREF | Mempalace preference rooms | "prefer", "always", "never" |
| CONFIG | `.env`, config files | "timeout", "limit", "threshold" |
| REJECTED_UNIVERSAL | Not auto-generated | Universal keywords → the auto-loop never *proposes* security-frame edits (a human may still author one, which then applies except the immutable security block) |

## Constraints

- **Approval-gated, target-agnostic apply.** An APPROVED amendment applies to any file. Permission is approval + a concrete diff + the security-block guard — not the target layer.
- **Immutable security block is human-only.** Changes touching `<system_directives>`/`<system_boundary>` (or the SECURITY sentinels) are refused even when approved.
- **Concrete diffs only.** Empty `old_text`/`new_text` is refused at approve and apply; apply is verbatim and drift-safe.
- **Auto-loop stays conservative.** Universal-frame learnings still classify as REJECTED_UNIVERSAL — the compression loop won't auto-*generate* SYSTEM.md/code edits; those are human-authored.
- **Evidence required.** Amendment generator validates non-empty evidence.
- **Mandatory review.** Applier rejects status != APPROVED.
- **Git history.** Every file change gets its own commit.

## Verification

- [ ] Amendments cite specific evidence (drawer IDs)
- [ ] Carren review completes before user sees amendment
- [ ] APPROVED amendments apply cleanly with git commit
- [ ] REJECTED amendments store user reason

## Files

| File | Purpose |
|------|---------|
| `scripts/system/self_improve/compression_loop.py` | Main orchestrator |
| `scripts/system/self_improve/target_classifier.py` | Layer classification |
| `scripts/system/self_improve/amendment_generator.py` | Amendment JSON builder |
| `scripts/system/self_improve/amendment_applier.py` | File writer + git |
| `scripts/system/watchers/session_start_checker.py` | User surfacing |
