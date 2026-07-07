# Verification

## What It Is

Verification is how the orchestration engine keeps a "verify" step honest. When a
skill reaches a VERIFY state, the agent must report a verdict (PASS / FAIL) backed
by real evidence — captured test output, a scan result, an executed proof. The
engine checks that report against a contract before the run is allowed to move on.
A verify that fails at the end completes honestly with `met=False`; it never
claims success it didn't earn.

## Why It Exists

An agent that self-reports "everything passed" with nothing to show is a false
positive waiting to happen. Verification pushes the burden of proof onto the
verifier:

- **Fail-loud validation** — an empty or malformed SUMMARY is rejected. The run
  does not advance on a fabricated default.
- **Evidence grounding** — a verify state can require named fields (e.g. captured
  command output) to be present *and non-empty*. A bare `passed: true` with an
  empty evidence list is rejected.
- **Honest exhaustion** — when the retry budget runs out, the run finishes with
  `met=False` rather than pretending the goal was met.

## How It Works

1. A playbook declares a verify state with a SUMMARY contract — required fields,
   their types, and (optionally) which fields count as evidence.
2. The agent runs the checks and reports the SUMMARY.
3. The engine validates it. If a required field is missing, mis-typed, or an
   evidence field is empty, the SUMMARY is rejected and the run stalls loudly
   instead of advancing.
4. On a genuine PASS, the run proceeds (or completes). On a FAIL, it loops back
   to fix the gap, up to the iteration budget.

## Concrete Example — the code skill

The code skill's verify step (`CODE_VERIFY`) requires `passed`, `confidence`, and
a non-empty `evidence` list. The agent is told to "run every configured
verification tier and report pass/fail per tier honestly with the captured
command output as evidence." Because `evidence` is declared as a required
non-empty field, the agent cannot pass verification without attaching the actual
tier results.

If the final verification fails, the run loops back to learning/implementing to
fix regressions. If the iteration budget is spent, the run completes with
`met=False` — an honest "not done," not a false green.

## When a Loop Won't Settle

If retries keep repeating the same failed strategy, or the same gaps persist with
no measurable progress, the engine **escalates** instead of burning the budget:
the run pauses and asks you how the approach should differ. Answering resumes the
same run.

## Not To Be Confused With — Approval Gates

Verification is about *proof that work is correct*. It is separate from a
**planned gate** — the human sign-off some skills request before high-stakes work
(e.g. the code skill's plan-approval and criteria-refinement gates). Those are a
different engine feature; verification does not ask for your confirmation, it
demands evidence from the agent.

## Durability

Verification results (the verdict, the gaps, the iteration history) are held in
run state and saved to a durable checkpoint keyed by run id. If a run is
interrupted mid-verify, it resumes and re-issues that step automatically. There
are no temp state files and no state passed on the command line.

## Files

- Agent notes: `docs/agents/capabilities/verification-state/verification-state.md`
- Engine gatekeeper: `apps/orchestration/src/orchestration/contracts.py` (`validate_summary_contract`)
- Concrete example: `apps/orchestration/src/orchestration/playbooks/code.py` (`CODE_VERIFY`)
