# Self-Improving Guidance

The behavioral learning loop — how Penny proposes improvements to her own Domain Guidance based on patterns observed in outcomes, and why this system was designed to never touch the universal Cognitive Frame.

## The Problem: Static Prompts, Dynamic Behavior

In a traditional LLM assistant, the system prompt is static. It's written once and never changes unless a human edits it. But the assistant's behavior evolves through usage — patterns emerge that weren't anticipated: "Penny keeps assuming `uv` when the project uses `pip`," or "Penny's plans are too detailed for this user's preferences."

Without a learning mechanism, these patterns persist indefinitely. The prompt architecture's Domain Guidance layer was designed to be _amendable_ — skill-specific prompts can improve over time. The Self-Improving Guidance system automates the _proposal_ of these improvements while keeping humans in the approval loop.

## The Core Principle

> The most valuable learning lives in the domain layer, not the universal layer.

If Penny learns that "this user prefers concise vacation plans," that doesn't require a new Before Responding step in SYSTEM.md. It requires a preference captured in the plan skill's Domain Guidance or in mempalace. The system was deliberately designed to target only Domain Guidance and user preferences — never the Cognitive Frame.

A proposal to modify SYSTEM.md is classified as `REJECTED_UNIVERSAL` and logged for human review only. It never proceeds automatically.

## How It Works

```
1. MISMATCH signal generated
   (ambient watcher detects high rate of plan-user mismatches)
       ↓
2. Pull relevant outcomes from mempalace
   (query outcome ledger for pattern occurrences)
       ↓
3. Identify recurring patterns
   (≥2 occurrences of the same pattern)
       ↓
4. Classify target layer
   (DOMAIN_GUIDANCE, MEMPALACE_PREF, CONFIG, or REJECTED_UNIVERSAL)
       ↓
5. Generate structured amendment JSON
   (what to change, evidence citations, risk assessment)
       ↓
6. Carren reviews
   (structured checklist: evidence linkage, target correctness, specificity, safety)
       ↓
7. Store in mempalace as PENDING
   (amendment drawer with status, evidence, proposed text)
       ↓
8. Session-start checker surfaces to user
   (next session, Penny presents pending amendments)
       ↓
9. User reviews via questionnaire
   (Approve / Modify / Reject / Defer)
       ↓
10. On APPROVE → git commit
    (amendment applied to .pi/skills/*/assets/prompts/*.md)
```

## Target Layers

The system classifies every proposed change by its target:

| Target Layer | What Gets Changed | Example |
|-------------|-------------------|---------|
| **DOMAIN_GUIDANCE** | Skill prompts (`.pi/skills/*/assets/prompts/*.md`) | Piper learns to check `pyproject.toml` for package manager |
| **MEMPALACE_PREF** | User preferences (`penny/preferences` room) | User prefers concise summaries (≤3 bullet points) |
| **CONFIG** | `.env` or config files | Timeout increased for large codebases |
| **REJECTED_UNIVERSAL** | Logged only — no automated change | Proposal to modify SYSTEM.md's Before Responding steps |

The classifier (`target_classifier.py`) determines the target based on the scope of the proposed change. Universal changes are automatically rejected. Domain-specific changes proceed to Carren review.

## Safety Guarantees

Six layers of safety prevent harmful or premature changes:

### 1. No SYSTEM.md Changes

The target classifier rejects any proposal that touches the Cognitive Frame. This is a hard rule, not a guideline. Universal reasoning rules must be stable — changing "RESTATE the goal" to something else would affect every interaction across every domain. The blast radius is too large for automated proposal.

### 2. Evidence Required

Every amendment must cite specific outcome ledger drawer IDs. "Penny seems to assume uv too often" is insufficient. "In outcomes `drawer_abc123`, `drawer_def456`, and `drawer_ghi789`, the MISMATCH was caused by incorrect package manager assumption" is required. Two occurrences minimum.

### 3. Carren Review

Every proposed amendment is reviewed by the Carren critique agent using a structured checklist:

- **Evidence linkage:** Does this cite specific outcome drawers?
- **Target correctness:** Does this belong in the proposed target layer?
- **Specificity:** Is the proposed text actionable (not vague)?
- **Safety:** Could this cause regressions in other domains?

Carren can return APPROVE, NEEDS_REVISION, or BLOCKED. BLOCKED amendments are discarded with a log entry.

### 4. Mandatory Human Review

No amendment auto-applies. Even LOW-risk proposals require user confirmation. The session-start checker (`session_start_checker.py`) surfaces pending amendments at the beginning of each session:

```
## 📝 Pending Amendments
The following self-improvement proposals await your review:

- **amend_2026-04-12_001** → `piper.md` (Risk: HIGH)
  Trigger: Penny assumes uv without checking
  Rationale: 3 of last 5 coding MISMATCHes involved incorrect
            package manager assumptions

[Approve] [Modify] [Reject] [Defer]
```

### 5. Git History

Every approved Domain Guidance change is committed to git with the amendment ID in the commit message. This provides full audit trail and rollback capability.

### 6. Deduplication

The same pattern won't be proposed twice. The amendment generator checks existing PENDING and APPLIED amendments before creating a new one.

## Trigger Conditions

The system can activate on three triggers:

| Trigger | When |
|---------|------|
| **MISMATCH signal** | Ambient watcher detects high mismatch rate between plan output and user expectations |
| **Explicit request** | User says "review my behavior" or "learn from this" |
| **Opportunistic** | Configurable (default: off) — runs when no pending amendments exist |

The MISMATCH signal is the primary trigger. Ambient watchers (`mismatch_rate_watcher.py`) monitor the outcome ledger for patterns where the user rejected or significantly modified Penny's output. When the rate exceeds a threshold, the compression loop activates.

## Rollback

Every change is reversible:

| Layer | Rollback Mechanism |
|-------|-------------------|
| Domain Guidance | `git revert <commit>` — reverts the specific amendment commit |
| Mempalace pref | Delete or update the preference drawer in mempalace |
| Config | Restore from `.env.example` or git history |
| Pending amendment | Delete the amendment drawer (cancel before applying) |

## The Files

| File | Purpose |
|------|---------|
| `scripts/system/self_improve/target_classifier.py` | Classifies proposals by target layer |
| `scripts/system/self_improve/amendment_generator.py` | Builds structured amendment JSON with evidence |
| `scripts/system/self_improve/amendment_applier.py` | Applies approved amendments + git commit |
| `scripts/system/self_improve/compression_loop.py` | Main loop: outcomes → patterns → amendments |
| `scripts/system/watchers/mismatch_rate_watcher.py` | Generates MISMATCH signal |
| `scripts/system/watchers/session_start_checker.py` | Surfaces pending amendments at session start |

## Relationship to the Prompt Architecture

Self-Improving Guidance was designed as part of the AI gap response (gap #2: "no stake in outcomes" and gap #6: "cannot be held accountable"). It depends on the Outcome Ledger (gap #2) and the Ambient Watchers (gap #3), both of which were built as part of the same April 2026 architecture sprint.

The system is intentionally constrained to Domain Guidance. The Cognitive Frame (SYSTEM.md) is off-limits. This reflects the architecture's design philosophy: the universal layer is stable; the domain layer evolves. The learning system respects this boundary.

## What the System Has Learned (So Far)

The self-improving guidance system has been designed and partially implemented. Key design decisions from the April 2026 session include:

- **Target scope:** Domain Guidance only — universal changes are classified as REJECTED_UNIVERSAL
- **Evidence threshold:** ≥2 outcome drawer citations required
- **Review gate:** Carren critique agent reviews every proposal before user sees it
- **Deduplication:** Same pattern won't be proposed twice
- **Trigger cadence:** MISMATCH signal is primary; explicit request and opportunistic are secondary

The system is integrated with the ambient watchers and outcome ledger, completing the behavioral learning loop envisioned in the AI gap analysis.

## Related Documents

- [Layer Architecture](layer-architecture.md) — Why Domain Guidance is separate from Cognitive Frame
- [Design Principles](design-principles.md) — Domain-agnostic agents concept
- [Overview](overview.md) — The AI gaps this system addresses
