# Behavioral-Regression Ratchet

## What It Is

A floor under Penny's quality. The eval suite already catches numbers getting worse; this catches *behavior* getting worse — the system quietly producing weaker plans, sloppier answers, or missing a step that Oracle-era Penny handled. It's the safety rail that makes change safe: change is how Penny improves and how she drifts, and this is the asymmetry that keeps improvements and blocks drift.

## How It Works

Oracle authored a handful of representative tasks, each with a reference answer and a "pass bar" — what a non-regressed answer must still do. `make trajectory` replays those tasks through the current system and has the verifier score each replay against its pass bar (on quality, not exact wording). The result is ratcheted: the system is allowed to be where it is today, but never worse.

## The Honest Part

The fixtures encode *Oracle's* quality, and the current driver models are weaker — so some fixtures fail on day one. That's a known gap, not drift. The ratchet is smart about this: it locks in the *current* baseline and alarms only when things get worse than that. Today 6 of 7 fixtures pass; the one gap is a planning task where the open model drops a detail Oracle included. A catastrophic floor still catches a total collapse regardless.

## Keeping It Honest

Never delete a failing fixture to make the bar green — a failing fixture is the eval doing its job. Add a fixture whenever you notice Penny got worse at something; it becomes a permanent guard.

## Learn More

- Operational detail: `docs/agents/capabilities/behavioral-ratchet/behavioral-ratchet.md`
- The program it's part of: `plans/self-sustaining-quality/02-behavioral-regression-ratchet.md`
