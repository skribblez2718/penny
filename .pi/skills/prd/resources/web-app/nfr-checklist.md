# Web App — Deriving Non-Functional Requirements

This is **not** a table of defaults to copy. It is the derivation method from
`../generic/guidance.md`, specialised for browser-facing systems, plus a set of **dated
starting points** you may use only when you tag their provenance.

Why the change: a frozen threshold table is a snapshot of a moving world. Core Web
Vitals themselves changed (INP replaced FID in March 2024), WCAG and ASVS revise, and
"last 2 browser versions" means something different every six weeks. A number copied
from a file nobody is paid to update looks authoritative and quietly goes stale.

## Derive first

For the system in the goal, work out which of these actually bite. Ignore the rest —
an NFR that doesn't apply is noise that hides the ones that do.

1. **What is the load-bearing failure?** For a browser-facing system this is usually
   perceived slowness, a broken critical path on a real device, or an auth/session
   defect. Name it, then set a number you can defend.
2. **Who is on the other end?** A human waiting on a screen sets a latency bar. A
   background job, a partner API, or a crawler sets a completely different one. Derive
   the bar from the consumer, not from a table.
3. **What is irreversible?** Payments, deletions, emails sent, credentials issued.
   These need explicit correctness and rollback criteria; reversible UI state does not.
4. **What is the hostile input?** For web systems: user-supplied markup, URLs, file
   uploads, headers (`X-Forwarded-For`, `Origin`, `Referer`), and anything crossing a
   trust boundary. Name it and state the control that contains it.
5. **What must remain true in a year?** Usually interfaces and observability, not style.

## Sourcing a threshold (required)

Every number you emit carries provenance, in this order of preference:

1. **A constraint the user stated** — always wins.
2. **A measured property of the existing system** — current P95, current bundle size,
   current error rate. State the measurement, then the target relative to it.
3. **A current published standard, retrieved and cited at synthesis time** — Core Web
   Vitals thresholds, the WCAG level the project must conform to, an ASVS level, a
   vendor SLO. Cite the source and the date you read it. **Fetch it; do not recall it.**
4. **An explicit project default** — permitted, but label it `(project default,
   unverified)` so a reviewer can see it is a choice, not a finding.

A threshold with no provenance from this list does not belong in the PRD.

## Dated starting points — 2025 era, verify before use

Use these to know *what to look up*, not as answers. Each is a starting point whose
current value must be confirmed (rule 3) or explicitly labelled (rule 4).

| Dimension | Starting point (2025) | Confirm because |
|---|---|---|
| Core Web Vitals | LCP, INP, CLS are the current triad | The triad itself changes — INP replaced FID in 2024 |
| Accessibility | WCAG 2.x AA is the common contractual bar | The required level is a legal/contractual fact about *this* project |
| Security baseline | OWASP ASVS; CSP, CSRF defences, security headers | Level and header guidance both revise |
| Availability | An uptime target expressed with its measurement window | "99.9%" is meaningless without the window and what counts as down |
| Browser support | Derive from the project's own analytics | "Last 2 versions" is a policy, not a fact |
| Coverage | Derive from the project's current coverage | A number with no baseline is theatre |

## Applicability

If the goal has **no browser-facing surface** — an API-only service, a worker, a CLI —
say so and do not import browser criteria. Declaring that a dimension is inapplicable,
with the reason, is a stronger PRD than silently padding it.
