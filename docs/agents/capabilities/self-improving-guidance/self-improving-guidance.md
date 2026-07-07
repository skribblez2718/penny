# Self-Improving Guidance — Amendment pipeline for SYSTEM.md and skill prompts

## What

When outcome patterns reveal systemic gaps, the compression loop proposes targeted amendments to SYSTEM.md or skill prompts. Amendments go through classification → generation → Carren review → user approval before any file is modified.

## Why

Static prompts drift from reality as usage patterns emerge. The amendment pipeline closes this gap without risking un-reviewed changes to system-critical files.

## Rules

1. **Penny never writes SYSTEM.md directly.** All changes go through amendment → review → apply.
2. **Every amendment must cite evidence.** Drawer IDs or outcome ledger entries.
3. **Review gate cannot be bypassed.** Even in auto mode, user must acknowledge.
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
| REJECTED_UNIVERSAL | (blocked) | Universal keywords → must not modify SYSTEM.md |

## Constraints

- **No SYSTEM.md writes.** Universal keywords → REJECTED_UNIVERSAL.
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
