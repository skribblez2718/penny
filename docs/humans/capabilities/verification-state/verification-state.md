# Verification State

## What It Is

A confirmation gate that pauses the plan skill before high-stakes actions. When the FSM enters `verifying`, Penny presents the proposed action, confidence level, alternatives, and counter-arguments — then asks the user to confirm, reject, or escalate.

## Why It Exists

Confidence levels (CERTAIN / PROBABLE / POSSIBLE / UNCERTAIN) are declared in the cognitive frame, but nothing enforces them. The verification state ensures **POSSIBLE confidence + high stakes** can't proceed without explicit user confirmation.

## When It Triggers

| Condition                                    | Example                                   |
| -------------------------------------------- | ----------------------------------------- |
| `confidence: POSSIBLE` + high stakes         | Refactoring core authentication logic     |
| `confidence: POSSIBLE` + irreversible action | Deleting production data                  |
| `confidence: UNCERTAIN`                      | Always → UNKNOWN_STATE (not verification) |
| Strict mode                                  | Any POSSIBLE action, regardless of stakes |

## User Experience

When verification triggers, Penny presents a structured questionnaire:

1. **Proposed Action** — what will be done
2. **Confidence** — current confidence level
3. **Counter-argument** — why this might go wrong (from Carren critique)
4. **Alternative** — another approach (from Piper plan)

> **Options:**
>
> - ✅ Proceed — confidence is acceptable
> - 🔄 Reject — try alternative
> - ❓ Escalate — I don't know

## Verification Modes

| Mode               | Behavior                        | Use When                 |
| ------------------ | ------------------------------- | ------------------------ |
| `default` (normal) | POSSIBLE + high stakes → verify | Standard operation       |
| `strict`           | Any POSSIBLE → verify           | High-risk environment    |
| `relaxed`          | Only UNCERTAIN → UNKNOWN_STATE  | Low-risk environment     |
| `off`              | Never verify                    | Automated pipelines only |

Set via constraints:

```python
skill({
    skill_name: "plan",
    goal: "...",
    constraints: {"verification_mode": "strict", "stakes": "high"}
})
```

## Relationship to UNKNOWN_STATE

| State           | Meaning                           | Trigger                        |
| --------------- | --------------------------------- | ------------------------------ |
| `VERIFYING`     | "I can act but want confirmation" | `POSSIBLE` + high stakes       |
| `UNKNOWN_STATE` | "I don't know what to do"         | `UNCERTAIN` or novel situation |

POSSIBLE + low stakes skips verification and proceeds directly to critiquing.

## Configuration

- `stakes`: `"high"`, `"medium"`, `"low"` — drives verification threshold
- `verification_mode`: `"default"`, `"strict"`, `"relaxed"`, `"off"`
- Piper plan can override via `stakes` field in `SUMMARY`

## Files

- Agent docs: `docs/agents/verification-state.md`
- Design: `plans/ai-gaps-resolution/02-designs/06-verification-state.md`
- Implementation: `.pi/skills/plan/scripts/orchestrate.py` — `needs_verification()`, `process_verification_result()`, `PlanWorkflow.verify_*`
