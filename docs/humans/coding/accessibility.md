# Penny Accessibility Standards

Accessibility is the shared rule that every user-facing surface Penny builds — web pages, admin
panels, components, even generated documents — works for **everyone**, including people who navigate
by keyboard, use a screen reader, have low vision, or have motor or cognitive differences. The
standard Penny holds itself to is **WCAG 2.2 Level AA**, applied at build time rather than bolted on
in a later audit.

## Why Accessibility Matters

It is easy to build an interface that works for the person building it and quietly excludes a large
share of everyone else. Roughly one in five people has a disability, and far more benefit from
accessible design in some context — a bright screen outdoors, a broken trackpad, a noisy room.

The benefits are cumulative, and they overlap with quality:

- **Inclusion** — the interface works for the people who most need software to meet them halfway,
  instead of shutting them out.
- **Legal safety** — WCAG 2.x AA is the reference standard behind most accessibility law and
  procurement requirements. Meeting it is the difference between a compliant product and a liability.
- **Better engineering** — most accessibility failures are also plain defects: no keyboard path,
  invisible focus, broken heading structure, meaning encoded only in color. Fixing them makes the code
  more correct, more robust, and easier to test.
- **SEO and reach** — the same semantic structure that screen readers rely on is what search engines
  read. Accessible pages are more discoverable pages.
- **Cheaper by far** — retrofitting accessibility onto a finished UI is expensive and fragile.
  Building to the standard from the first render costs almost nothing.

## The Standard: WCAG 2.2 Level AA

The Web Content Accessibility Guidelines organize accessibility around four principles — every
interface must be **POUR**:

| Principle          | What it means                                              | Examples of what Penny enforces                                                                                                                     |
| ------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Perceivable**    | Users can perceive the content with the sense they have.   | Sufficient color contrast (in every theme), text alternatives for images, never conveying meaning by color alone, content that reflows and resizes. |
| **Operable**       | Users can operate the interface however they navigate.     | Full keyboard operability with no traps, always-visible focus, adequate target sizes, honoring reduced-motion, alternatives to drag gestures.       |
| **Understandable** | Users can understand the content and how it behaves.       | Labeled inputs, clear error messages that are announced, consistent navigation and help, not forcing people to re-enter information.                |
| **Robust**         | It keeps working across browsers and assistive technology. | Valid semantic markup, correct name/role/value for every control, status messages announced without stealing focus.                                 |

**Level AA** is the middle conformance tier and the one nearly everyone means by "accessible." **WCAG
2.2** adds several criteria Penny specifically watches for: interactive targets
at least 24×24 pixels, focus that isn't hidden behind sticky headers, single-pointer alternatives to
dragging, consistent placement of help, not re-asking for information already given, and not gating
login behind a puzzle with no alternative.

## How Penny Builds and Verifies It

Accessibility is treated like any other quality gate — it must pass before work is considered done.

1. **Semantic HTML first.** The right native element (`button`, `a`, `nav`, `main`, headings, `label`)
   is accessible for free; custom `div`-based widgets are only used when nothing native fits, and then
   they get full keyboard and ARIA support.
2. **Two-theme discipline.** Contrast is verified in **both** light and dark themes, plus any
   additional supported themes. This is a stricter project policy, not a WCAG requirement to
   implement dark mode. A missing theme, single-theme constraint, or fixed-medium output needs an
   explicit project-owner applicability decision, not silent omission of checks.
3. **Automated + manual verification.** An automated pass (axe or equivalent) is necessary but does
   not establish conformance. Interactive work also gets a **keyboard-only** walkthrough and a
   **screen-reader** smoke test before it ships.

Automated tools are necessary but never sufficient: a page can pass axe and still be unusable with a
keyboard. That is why the manual checks are part of the standard, not an optional extra.

## WCAG and project policy

W3C distinguishes [2.4.7 Focus Visible, AA](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)
from [2.4.11 Focus Not Obscured (Minimum), AA](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html).
[1.4.11 Non-text Contrast, AA](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
addresses adjacent-color contrast for required component/state information and meaningful graphics.
[2.4.13 Focus Appearance, AAA](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html)
adds indicator area and focused/unfocused same-pixel contrast requirements; it is not the AA floor.

Penny also requires exactly one H1 per page/view and no skipped heading levels; these are stricter
project structure policies, not literal WCAG requirements. No merge with a known A/AA violation,
regardless of severity label. An agent cannot approve its own exception. Only beyond-AA project
rules can receive an explicitly approved deviation, with the rule, rationale, residual risk,
compensating control, verification gap, accountable approving owner, and removal condition recorded.
Review/diagnosis reports available evidence and gaps; planning identifies required checks without
claiming they ran.

## Where the Details Live

This page is the WHAT and WHY. The precise, enforceable rules — the exact contrast ratios, the ARIA
do's and don'ts, the framework-specific patterns for Lit and Tailwind, and the verification checklist
— live in the agent-facing standard at
[`docs/agents/coding/accessibility.md`](../../agents/coding/accessibility.md). Like the
[Python](python.md) and [TypeScript](typescript.md) guides, it builds on the universal
[coding conventions](conventions.md); accessibility is the cross-cutting standard for every interface
Penny renders.
