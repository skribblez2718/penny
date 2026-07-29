# Generic — Synthesis Guidance (the fallback pack)

This pack is deliberately **not** a checklist. `web-app/` exists because someone wrote it down;
most goals will not have a pack, and a goal without a pack must not get a worse PRD than one with.

So this file gives you the **method for deriving** the domain's criteria, not the criteria. Derive
them for *this* goal; a pack you were handed is a shortcut, never a ceiling.

## How to derive the domain's non-functional requirements

For the system in the goal, work out which of these actually bite, and ignore the rest:

1. **What is the load-bearing failure?** What breaks first under real use, and what does it cost when
   it does? That failure is your first NFR, and its threshold is a number you can defend.
2. **Who or what is on the other end?** A human waiting on a screen, another service on a timeout, a
   batch job, a regulator. The consumer sets the latency, availability, and auditability bars — not a
   default table.
3. **What is irreversible?** Data loss, money moved, messages sent, credentials issued. Irreversible
   operations need explicit correctness and rollback criteria; reversible ones rarely do.
4. **What is the hostile input?** Every system has one — untrusted user input, a third-party payload,
   a filename, a clock. Name it, and state the control that contains it.
5. **What must remain true a year from now?** That is the maintainability requirement, and it is
   usually about interfaces and observability, not style.

## Sourcing thresholds

A threshold you invent is an adjective wearing a number. Prefer, in order:

1. **A constraint the user stated** — always wins.
2. **A measured property of the existing system** — current P95, current error rate, current bundle
   size. State the measurement, then the target relative to it.
3. **A current published standard for the domain**, retrieved and cited at synthesis time (Core Web
   Vitals, WCAG, ASVS, an RFC, a vendor SLO). Cite the source and the date you read it.
4. **An explicit project default** — allowed, but label it `(project default, unverified)` so the
   reviewer can see it is a choice, not a finding.

Never emit a threshold with no provenance from this list.

## Sections

Follow `../prd-template.md`. Cover the sections the goal warrants and state which ones you covered
and why the others do not apply — a scoped PRD that says what it scoped out is stronger than a
padded one that fills all twelve.

## Verification

Every requirement needs at least one way to be checked, and the check must be nameable by someone
who did not write the requirement. If you cannot say how a criterion would be falsified, it is not a
criterion yet — rewrite it or surface it as a clarifying question.
