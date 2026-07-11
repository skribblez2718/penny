# Outcome Capture

## What It Is

Outcome Capture gives Penny's learning ledger a source that matches how she actually works. Every improvement mechanism — mistakes not repeating, confidence meaning something, eventually running unattended — learns from the outcome ledger: a record of what Penny did, what she expected, and whether it matched. That ledger was empty. This capability fills it, with your quick ratings as the highest-signal input.

## Why It Was Empty (the diagnosis)

The ledger had exactly one wired source: the orchestration engine writing an outcome when a *skill* runs to completion. But in practice Penny does most work through direct agent calls that never drive the engine to a finish — so that source almost never fired. The evidence was stark: zero engine runs recorded, against hundreds of agent invocations, and the nightly self-improvement job producing zero proposals night after night. The capture code itself was correct and switched on; it was just connected to a pipe with nothing flowing through it. (The watcher setup was also fine — `make setup` does install the crons; that was not the problem.)

## How It Works Now

Two sources, sharing dedup so nothing is double-counted:

- **`make auto-capture`** (also runs automatically in the twice-daily cron) uses the *calibrated verifier* — the same MiniMax model that reproduces Oracle's judgment at 93% agreement — to judge recent tasks and record outcomes without you. It pairs each session's opening request with the answer to *that* request (not a later, unrelated task in the same session), so the labels stay honest.
- **`make rate`** is the human layer: it lists recent sessions, skips the ones already captured, and lets you mark each MATCH / PARTIAL / MISMATCH in a single keystroke with an optional one-line reason. Use it for the tasks the judge couldn't confidently score, or to record your own verdict where it matters.
- The reason on a non-MATCH is the most valuable part: it's what lets the system cluster "this *kind* of thing keeps going wrong" instead of just "something went wrong once."
- At the start of a session, the brief nudges you when work is waiting to be rated, so it stays a lightweight habit rather than a chore.

The two sources are complementary: the judge fills the ledger continuously and cheaply; you provide the high-signal corrections where the judge is uncertain or wrong. And because the judge's accuracy is itself measured (its false-pass rate is a tracked metric), you always know how much to trust the automatic labels.

## Why the Reason Matters

A MATCH/MISMATCH alone tells the system *that* something worked or didn't. The one-line reason tells it *what kind* of thing — "assumed uv when the project uses pip," "missed the auth edge case." The self-improvement loop groups outcomes by that reason; without it, recurring mistakes can't be detected, and the loop has nothing to propose. Two minutes of rating with honest reasons is what turns the whole flywheel.

## Learn More

- Operational rules and the shared writer API: `docs/agents/capabilities/outcome-capture/outcome-capture.md`
- The full flywheel program: `plans/self-sustaining-quality/01-flywheel-closure.md`
- The verifier that will eventually pre-fill your ratings: `docs/humans/capabilities/judgment-calibration/judgment-calibration.md`
