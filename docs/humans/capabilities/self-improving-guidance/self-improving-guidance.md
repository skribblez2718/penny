# Self-Improving Domain Guidance

## What It Is

A behavioral learning system that allows Penny to **propose improvements to her own skill prompts** based on patterns in the outcome ledger. The system never touches the universal Cognitive Frame (.pi/SYSTEM.md). Instead, it targets Domain Guidance (skill-specific prompts) and user preferences in mempalace.

## Key Principle

> The most valuable learning lives in the domain layer, not the universal layer.

A plan skill that learns "this user prefers concise summaries" doesn't need a new Before Responding step in SYSTEM.md. It needs that preference captured in the skill prompt or mempalace.

## How It Works

```
MISMATCH signal generated
    ↓
Pull relevant outcomes from mempalace
    ↓
Identify recurring patterns (≥2 occurrences)
    ↓
Classify target layer
    ↓
Generate structured amendment JSON
    ↓
Carren reviews (structured checklist)
    ↓
Store in mempalace as PENDING
    ↓
Session-start checker surfaces to user
    ↓
User reviews via questionnaire
    ↓
On APPROVE → git commit to Domain Guidance file
```

## Target Layers

| Layer                  | What Gets Changed                                | Example                                |
| ---------------------- | ------------------------------------------------ | -------------------------------------- |
| **DOMAIN_GUIDANCE**    | Skill prompts (.pi/skills/_/assets/prompts/_.md) | Piper learns to check package managers |
| **MEMPALACE_PREF**     | User preferences (penny/preferences room)        | User prefers concise summaries         |
| **CONFIG**             | .env or config files                             | Timeout increased for large codebases  |
| **REJECTED_UNIVERSAL** | Logged only — no automated change                | Proposal to modify SYSTEM.md           |

## Safety Guarantees

1. **No SYSTEM.md changes** — Classification step rejects any proposal that touches universal reasoning rules. Logged in mempalace for human review.
2. **Evidence required** — Every amendment must cite specific outcome ledger drawer IDs.
3. **Carren review** — Every amendment is reviewed before user presentation.
4. **Mandatory human review** — No auto-apply. Even "LOW" risk amendments require user confirmation.
5. **Git history** — Every approved Domain Guidance change is committed to git.
6. **Deduplication** — Same pattern won't be proposed twice.

## User Interaction

At session start, if pending amendments exist, Penny presents them:

```
## 📝 Pending Amendments
The following self-improvement proposals await your review:

- **amend_2026-04-12_001** → `piper.md` (Risk: HIGH)
  Trigger: Penny assumes uv without checking
  Rationale: 3 of last 5 coding MISMATCHes involved incorrect package manager assumptions

[Approve] [Modify] [Reject] [Defer]
```

## Trigger Conditions

| Trigger          | When                                                               |
| ---------------- | ------------------------------------------------------------------ |
| MISMATCH signal  | When Step 5 signal generators detect high MISMATCH rate            |
| Explicit request | User says "review my behavior" or "learn from this"                |
| Opportunistic    | Configurable (default: off) — run when no pending amendments exist |

## Rollback

| Layer             | How                                        |
| ----------------- | ------------------------------------------ |
| Domain Guidance   | `git revert <commit>`                      |
| Mempalace pref    | Delete or update the preference drawer     |
| Config            | Restore from `.env.example` or git history |
| Pending amendment | Delete the amendment drawer from mempalace |

## Files

| File                                                 | Description                                  |
| ---------------------------------------------------- | -------------------------------------------- |
| `scripts/system/self_improve/target_classifier.py`   | Classifies learnings by target layer         |
| `scripts/system/self_improve/amendment_generator.py` | Builds amendment JSON                        |
| `scripts/system/self_improve/amendment_applier.py`   | Applies approved amendments + git commit     |
| `scripts/system/self_improve/compression_loop.py`    | Main loop: outcomes → amendments             |
| `scripts/system/watchers/session_start_checker.py`   | Surfaces pending amendments at session start |
