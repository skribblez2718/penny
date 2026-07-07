# Escalation: when Penny doesn't know what to do

## What it is

Every Penny skill runs on one shared orchestration engine. When an agent can't make a confident call — or a retry loop is spinning without progress — the engine **pauses the run and asks you for direction** instead of pressing on with unsupported assumptions. You answer in plain language, and the same run picks up where it left off.

## Why it exists

Without an escape hatch, the system would fall through to raw LLM behavior in exactly the situations where that is most dangerous: missing information, contradictory constraints, or a loop that keeps failing the same way. Escalation makes Penny **halt and ask** rather than improvise.

## When it triggers

| Condition | Example |
| --- | --- |
| An agent reports **UNCERTAIN** confidence | Echo can't find files relevant to the goal |
| A retry loop **stalls or repeats a failed approach** | Two implement→verify cycles show the same unresolved gaps |

Only the weakest confidence level (**UNCERTAIN**) escalates. **CERTAIN / PROBABLE / POSSIBLE** proceed normally. Each skill decides which of its own steps are allowed to escalate.

## What you see

When the run pauses, Penny shows you:

1. **Why it paused** — the reason from the agent or the loop-progress check (e.g. "No relevant files found", or "the next iteration repeats the previous strategy with no change").
2. **A single open question** — "How should the run proceed?" You reply in your own words; there is no fixed multiple-choice menu.

## What happens after you answer

Your answer is handed back to the **same run** (matched by its run id). The engine records what you said, resumes at the working step the skill designates for clarifications, and injects your guidance into that step's next attempt. So your words actually steer the retry — they aren't just logged.

Each skill controls where a clarified run resumes. For the code skill, for instance, a clarification restarts from exploration with your guidance in hand.

## Planned check-ins are different

This escalation path is only for **UNCERTAIN / stalled** situations. Some skills also have **planned gates** — deliberate approval points (e.g. "approve this plan?") with specific options. Those are a separate, expected checkpoint, not a sign that Penny got stuck.

## Nothing to configure

Escalation is automatic. Every step's confidence is checked, and loops are watched for repetition and stalls, without any setup on your part.

## Under the hood (durability)

The pause is fully recoverable. What Penny was doing, why it paused, and your eventual answer are all saved to a durable store keyed by the run id — so if the process is interrupted mid-pause, the same question is re-presented and the run continues once you reply. There are no scratch session files to manage.

## Learn more

- Implementation notes: `docs/agents/capabilities/unknown-state/unknown-state.md`
- Engine: `apps/orchestration/src/orchestration/engine.py` (`_escalate`, `_resume`, `progress_check`)
