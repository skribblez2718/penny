# Pruning Levels

## Compression Rules by Phase Age

Context retention is determined by downstream consumption needs. Apply these compression rules based on how far back a phase is from the current work.

---

## Current Phase (N)

**Compression:** No pruning - full detail retained for active work

The phase currently being executed retains all detail. Agents need full context to do their work.

---

## Immediate Predecessor (N-1)

**Compression:** Moderate compression

| Action | Detail |
|--------|--------|
| **Preserve** | Decisions and key findings |
| **Compress** | Process descriptions |
| **Remove** | Verbose explanations |
| **Retention** | 40-50% of original detail |

The immediate predecessor contains context the current phase directly depends on. Keep decisions but compress explanations.

---

## Two Phases Back (N-2)

**Compression:** Aggressive compression

| Action | Detail |
|--------|--------|
| **Compress to** | Johari summary only (1,200 tokens max) |
| **Remove** | All process descriptions |
| **Preserve** | Only decisions and critical discoveries |
| **Retention** | 15-20% of original detail |

At N-2, the detailed "how" is no longer needed - only the "what was decided" matters.

---

## Three+ Phases Back (N-3+)

**Compression:** Archive-level compression

| Action | Detail |
|--------|--------|
| **Compress to** | Executive summary (300-500 tokens) |
| **Preserve** | Only decisions that affect system architecture |
| **Archive** | Full detail to separate archive file |
| **Retention** | 5-10% of original detail |

For phases 3+ back, only architectural decisions that ripple through the entire workflow need retention. Full detail goes to archives if needed for reference.

---

## Summary Table

| Phase Age | Compression Level | Retention | Token Target |
|-----------|------------------|-----------|--------------|
| N (current) | None | 100% | Full detail |
| N-1 | Moderate | 40-50% | Key decisions + findings |
| N-2 | Aggressive | 15-20% | 1,200 tokens (Johari) |
| N-3+ | Archive | 5-10% | 300-500 tokens |

---

## Application Rules

1. **After each phase completes**, apply compression to previous phases
2. **Shift all phases down one level** (N-1 becomes N-2, etc.)
3. **Never prune current phase** - wait until it completes
4. **Archive N-3+ content** if full detail might be needed later
