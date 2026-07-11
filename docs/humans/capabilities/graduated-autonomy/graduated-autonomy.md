# Graduated Autonomy

## What It Is

The mechanism behind "almost autonomous." Penny shouldn't need you to approve renaming a variable, but she absolutely should ask before deleting a database. This decides, per action, whether she can act alone or must ask — based on two things: whether the action is reversible, and whether she's earned trust in that kind of work.

## How It Decides

1. **Is it irreversible or destructive?** (deploy, send, delete, overwrite) → always ask. No amount of earned trust overrides this. It's the permanent human floor.
2. **Otherwise, has she earned trust in this domain?** Trust is computed from the outcome ledger: recent successes raise it, a recent failure drops it hard, and it can never exceed how reliably the verifier catches mistakes. Only reversible work in a domain with high, evidence-backed trust runs unattended.
3. **Everything else asks** — routed to you without blocking (you answer at your next session).

## Why "almost"

The human never fully leaves the loop, by design: irreversible actions always ask, brand-new kinds of work always ask (trust is earned, never assumed), and every autonomous action still records an outcome you can rate — which is what keeps the trust honest. Trust is slow to earn and fast to lose: one recent failure in a domain pulls it back to asking.

## The Safety Coupling

Trust is capped by the verifier's reliability. Penny can't be more confident acting alone than she is at catching herself being wrong. As the verifier improves (via the calibration loop), the ceiling rises — autonomy and self-checking grow together, never apart.

## Right Now

`make trust` shows the current picture. With a thin outcome ledger, every domain reads zero trust and everything asks — the correct, safe starting state. As you rate outcomes and the auto-capture judge fills the ledger, reversible domains with a good track record graduate to acting on their own.

The decision is wired into the orchestration engine (the `code` workflow's action step consults it before writing code), but it's **off by default** — it only engages when you set `PENNY_AUTONOMY_GATE=1`. Turn it on once the ledger has enough history for domains to earn trust; until then, leaving it off keeps today's behavior unchanged. When on, an untrusted or irreversible action pauses the run and asks you, exactly like any other clarification.

## Learn More

- Operational detail: `docs/agents/capabilities/graduated-autonomy/graduated-autonomy.md`
- The program it's part of: `plans/self-sustaining-quality/03-graduated-autonomy.md`
