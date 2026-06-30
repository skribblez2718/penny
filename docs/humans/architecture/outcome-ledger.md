# Outcome Ledger: Learning from Prediction Gaps

## What It Is

The outcome ledger is a structured log of predictions and results. Before Penny takes a consequential action, she records what she expects to happen. After the action, she compares the actual outcome to the prediction. The difference — the delta — is what makes learning possible.

Each entry contains:

- What action was taken
- What outcome was predicted
- The confidence at the time of the action
- What actually happened
- A delta score: MATCH, PARTIAL, or MISMATCH
- The domain it belongs to, such as coding, planning, research, or communication

## Why It Exists

Language models do not naturally learn from experience. Without a mechanism that explicitly compares prediction to result, Penny would repeat the same mistakes because nothing in the system closes the loop between "I thought this would work" and "it did not work."

The ledger exists to:

1. **Capture predictions before action.** Once the result is known, it is easy to rewrite the story. Recording the prediction first prevents hindsight bias.
2. **Collect feedback on results.** The user can say whether the outcome matched, partially matched, or mismatched the prediction.
3. **Surface patterns of failure.** Repeated mismatches in the same domain trigger a review and possible amendment to guidance.

## How It Works

### 1. Record before acting

When confidence is low, when files will be modified, or when the action is hard to reverse, Penny writes a prediction to mempalace before doing anything else.

### 2. Capture feedback

After a consequential task, the result is presented to the user with three options: MATCH, PARTIAL, or MISMATCH. The response is written back to the ledger entry.

### 3. Review mismatches before repeated decisions

Before each turn, Penny searches recent mismatches. If a current decision resembles a past failure, that past failure is brought into context so the same mistake is not repeated blindly.

### 4. Close open records

Any prediction still open at the end of a session is closed with the actual outcome and a delta score.

## Delta Scores

| Score | Meaning |
| --- | --- |
| **MATCH** | The actual outcome closely matched the prediction |
| **PARTIAL** | The core prediction held, but important details differed |
| **MISMATCH** | The outcome was significantly different from the prediction |

A MISMATCH is not a moral failure. It is information. It says the model's model of the situation was wrong in a way that should be inspected.

## What This Means for System Behavior

- Penny will sometimes pause before acting to record a prediction. That is the ledger doing its job, not stalling.
- Penny may bring up past failures when starting a similar task. That is the review step, not random anxiety.
- A string of mismatches in the same area can lead to a proposal to update skill guidance or project standards. That proposal requires evidence and human approval before it is committed.
- The system improves from gaps, not from being told it is great.

## Related Documents

- Agent docs: `docs/agents/architecture/outcome-ledger.md`
- Operational guide: `docs/agents/capabilities/outcome-ledger/outcome-ledger.md`
- Human overview: `docs/humans/capabilities/outcome-ledger/outcome-ledger.md`
