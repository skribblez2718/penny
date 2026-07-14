# Accessibility Standards — WCAG 2.2 AA for all generated UI

## What

Every user-facing surface an agent generates — HTML, Lit components, templates, emails, PDFs — must
meet **WCAG 2.2 Level AA**. Accessibility is a build-time requirement, not a later audit. Applies to
all web application work; the frontend UI defaults (Lit + Tailwind, see
[conventions.md](conventions.md#frontend-ui--css-defaults)) inherit this standard.

## Why

Inaccessible UI excludes real users (screen-reader, keyboard-only, low-vision, motor, cognitive),
creates legal exposure, and is usually also a correctness/SEO/robustness defect (bad semantics, no
keyboard path, invisible focus). Building to AA from the first render is far cheaper than retrofitting.

## Rules

1. **Semantic HTML first.** Use the correct native element (`<button>`, `<a href>`, `<nav>`, `<main>`,
   `<h1>`–`<h6>`, `<ul>/<li>`, `<label>`, `<table>`) before reaching for `<div>` + ARIA. A native
   control is keyboard- and AT-accessible for free.
2. **Keyboard-operable, always.** Every interactive control is reachable and operable with the keyboard
   (Tab/Shift-Tab/Enter/Space/Arrows/Esc), in a logical order, with **no keyboard traps** (WCAG 2.1.1,
   2.1.2). If you add a click handler, add a keyboard path.
3. **Visible focus.** Never remove focus outlines without a replacement of equal or greater visibility
   (WCAG 2.4.7). Focus indicators meet 3:1 contrast against adjacent colors (2.4.11/2.4.13).
4. **Color contrast.** Text ≥ **4.5:1** (normal) / **3:1** (large: ≥ 24px, or ≥ 19px bold); UI
   components + graphical objects + focus indicators ≥ **3:1** (WCAG 1.4.3, 1.4.11). Verify in **every
   theme** (light AND dark) — a token that passes in one can fail in the other.
5. **Never convey meaning by color alone** (WCAG 1.4.1). Pair color with text, an icon, a shape, or a
   pattern (e.g. a status dot + its label; a char-count bar + a numeric/`aria` count).
6. **Text alternatives.** Every meaningful image has a descriptive `alt`; decorative images use
   `alt=""` (never a missing `alt`). Icons that are the only label need an accessible name
   (`aria-label`) (WCAG 1.1.1).
7. **Programmatic names + labels.** Every form control has a `<label for>` (or wrapping label);
   name/role/value are exposed to AT (WCAG 1.3.1, 4.1.2). Buttons/links have a discernible name.
8. **Valid document structure.** Exactly one `<h1>` per page/view; no skipped heading levels;
   landmarks (`<header>/<nav>/<main>/<footer>` or roles) so AT users can navigate (WCAG 1.3.1, 2.4.1
   skip-link).
9. **Honor `prefers-reduced-motion`.** Gate non-essential animation/transition behind
   `@media (prefers-reduced-motion: reduce)`; no unavoidable motion, autoplay, or content flashing
   > 3×/s (WCAG 2.3.1, 2.2.2).
10. **Adequate target size.** Interactive targets are **≥ 24×24 CSS px** (or have ≥ 24px spacing) —
    WCAG 2.2 **2.5.8**. Aim for 44px for primary touch targets.

## Perceivable

- **Contrast** per Rule 4; test both themes. Do not disable user zoom; content reflows to **400%**
  without horizontal scrolling (1.4.10) and survives 200% text resize (1.4.4).
- **Images/media:** meaningful `alt`; captions/transcripts for audio/video where applicable.
- **Don't hard-code spatial/sensory cues** ("click the button on the right", "the green one") (1.3.3).
- **Text over images** keeps contrast; avoid text baked into images.

## Operable

- **Full keyboard support** (Rule 2). Custom widgets follow the WAI-ARIA Authoring Practices keyboard
  model (menu, dialog, tabs, combobox, disclosure, etc.).
- **Focus management:** moving focus is intentional — open a dialog → focus it and trap focus within;
  close → return focus to the trigger. Route/view changes move focus to a sensible heading.
- **Focus not obscured** by sticky headers/toolbars — WCAG 2.2 **2.4.11** (a focused element is at
  least partially visible).
- **Dragging alternatives:** any drag interaction has a single-pointer / button alternative — WCAG 2.2
  **2.5.7** (e.g. move up/down buttons alongside drag-to-reorder).
- **Enough time:** no time limits on essential tasks, or they are adjustable (2.2.1).

## Understandable

- **Labels + instructions** on inputs; errors are identified in text, describe how to fix, and are
  programmatically associated (`aria-describedby`, `aria-invalid`) (3.3.1–3.3.3). Announce async
  validation via a polite live region.
- **Consistent navigation + identification** across views (3.2.3/3.2.4); **consistent help** placement
  — WCAG 2.2 **3.2.6**.
- **Redundant entry:** don't force re-entering info already provided in the same process — WCAG 2.2
  **3.3.7**.
- **Accessible authentication:** don't require a cognitive-function test (e.g. transcribing/solving)
  with no alternative; allow paste into OTP/password fields — WCAG 2.2 **3.3.8**.
- **Language** set on the document (`<html lang>`).

## Robust

- **Valid, parseable markup**; unique `id`s; correct nesting.
- **Name, role, value** exposed for all UI (4.1.2); status messages use `role="status"` /
  `aria-live="polite"` (or `alert`/`assertive` for errors) so they're announced without stealing focus
  (4.1.3).

## ARIA — use sparingly, correctly

1. **Prefer native HTML over ARIA.** Only add ARIA when no native element/attribute provides the
   semantics.
2. **Don't change native semantics** (no `role="button"` on a `<button>`; no `role` that fights the
   element).
3. **All ARIA-declared interaction must be keyboard-operable.**
4. **Don't hide focusable elements** with `aria-hidden="true"` (removes them from AT while still
   tabbable — a trap).
5. **Every interactive element needs an accessible name.**
   Misused ARIA is worse than none — an empty/incorrect `aria-*` actively breaks AT.

## Framework notes

- **Lit / shadow DOM:** each component owns its semantics — real `<button>`/`<label>`/roles inside the
  component; move focus explicitly across shadow boundaries; ensure `id`-based associations
  (`for`/`aria-*`) resolve within the same root. `delegatesFocus` where appropriate.
- **Tailwind:** never ship `outline-none` without a visible `:focus-visible` replacement; drive colors
  from theme tokens and verify token contrast in both themes; use `sr-only` for visually-hidden
  accessible text and a skip-link (`sr-only focus:not-sr-only`).
- **Rendered Markdown / rich text:** containers must adapt to theme (e.g. `prose dark:prose-invert`),
  never a fixed dark/light color that inverts to invisible.

## Severity

| Severity | Meaning | Action |
|----------|---------|--------|
| **BLOCKER** | A perceivable/operable barrier: keyboard trap or unreachable control, missing focus indicator, missing form label/name, an axe AA violation, or contrast below the AA threshold. | Fix before delivery. |
| **CRITICAL** | Meaning by color alone, missing/incorrect `alt`, skipped headings / no landmarks, misused ARIA, reduced-motion not honored, target < 24px. | Fix or document a justified exception. |
| **WARN** | AAA-level niceties or polish beyond AA (e.g. 7:1 contrast, 44px targets everywhere). | Improve when practical. |

## Constraints

- **WCAG 2.2 Level AA is the floor for all generated UI.** No merge with a known AA violation.
- **Verify in both light and dark themes** — half the checks are theme-dependent.
- **Automated tools catch ~30–40%.** An axe pass is necessary, not sufficient — keyboard + screen-
  reader checks are mandatory for interactive UI.

## Verification

- [ ] **axe** (or equivalent) run against the rendered UI — **zero** WCAG 2.2 A/AA violations, in
      **both** themes.
- [ ] **Keyboard-only** walkthrough: every control reachable/operable, logical order, no trap, focus
      always visible.
- [ ] **Screen-reader** smoke (VoiceOver/NVDA/Orca): names, roles, states, and live-region
      announcements are correct for interactive components.
- [ ] Exactly one `<h1>`; no skipped heading levels; landmarks present; skip-link works.
- [ ] Every form control has an associated label; errors are announced and described.
- [ ] Contrast (text 4.5:1 / large 3:1 / UI + focus 3:1) verified in both themes.
- [ ] `prefers-reduced-motion` honored; targets ≥ 24px; no color-only signaling.
