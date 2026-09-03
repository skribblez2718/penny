# Skill Flow Diagrams — descriptor-backed visual mirrors

Every engine-backed skill ships one self-contained
`.pi/skills/<skill>/resources/flow.html`. The TypeScript playbook descriptor is
machine authority: a flow diagram must draw every descriptor state and edge,
and it must not invent routes to terminals, approval, execution, or error
states.

## Required document contract

A diagram is a complete HTML document with:

- `<!doctype html>`, `lang="en"`, UTF-8 and viewport metadata, one `<h1>`, and
  `<meta name="penny-flow-template" content="1">`.
- Inline CSS and an inline renderer only. No external scripts, styles, fonts,
  images, imports, fetches, sockets, or network dependencies.
- A header/descriptor summary, authority or ordering callout, visible legend,
  named scrollable graph region, SVG arrow layer, visible route labels,
  assistive edge list, and explanatory footer.
- A responsive graph canvas. It uses available wide-screen width up to the
  documented maximum; a narrow screen scrolls only inside the named graph
  viewport, never by clipping the document body.

Start from `scripts/tools/templates/skill-flow.html`. The template is a
copyable source, not a topology authority. Its placeholders must be replaced
before a diagram ships. `scripts/tools/scaffold-skill.py` is the only standard
scaffolder and emits this frame for new packages.

## Data contract

`const N = …` and `const E = …` are strict JSON literals. They are parsed
without executing the page and must have no duplicate JSON keys.

`N` is an object keyed by stable descriptor state ID. Every node requires:

- `title`, `desc`, `cls`, `lane` (`left`, `center`, or `right`), and finite
  non-negative `y` layout position;
- `who` for every cognitive state;
- a textual badge for host/gate states and `TERM` for terminal states.

`E` is an array of unique objects. Every edge requires `from`, `to`, `kind`,
and a non-empty visible `label`. Endpoints must exist in `N`. Allowed kinds are
`fwd`, `gate`, `loop`, `exit`, `abort`, and `esc`. Layout metadata may be
added only when it cannot change the descriptor topology.

Use safe DOM creation and `textContent` for all node and edge data. Do not
interpolate `N` or `E` values through `innerHTML`. The decorative SVG is hidden
from assistive technology; the complete generated edge list remains available
to it. Names, labels, badges, and line styles supplement color.

## Semantics and layout

- Name the owner on cognitive cards. Distinguish host, gate, positive terminal,
  non-positive terminal, forward, repair, exit, abort, and escalation meanings
  in the legend.
- Reserve lanes and vertical space for every branch and repair before placing
  cards. Labels must remain readable, in bounds, and disjoint from cards and
  other labels at all validation viewports.
- A uniform cancel/abort/error seam may be omitted only when the footer says
  what is omitted and where it terminates. Omission is never permission to add
  a plausible edge.
- Document ordering and authority invariants in the callout/footer. Preserve
  skill-specific order: for example, Produce keeps Carren-before-Vera, while
  other flows may use Vera-before-Carren.

## Verification

The ordinary orchestration test discovers every skill flow and checks strict
JSON, template regions, safe self-containment, required node/edge fields, and
bidirectional topology drift:

```bash
bun run --cwd apps/orchestration test -- tests/flow-diagrams.test.ts
```

Run the browser-backed structural, geometry, accessibility-oriented, and
network-denial check at all standard viewports:

```bash
bun .pi/extensions/playwright/scripts/validate-flow-html.ts
bun .pi/extensions/playwright/scripts/validate-flow-html.ts --skill research
```

It writes screenshots only for failures below `/tmp/penny-flow-html-validation/`.
The validator is read-only. It does not replace the skill-specific descriptor
tests, which remain responsible for workflow-specific topology and prohibited
state assertions.

Also run:

```bash
python scripts/system/checks/check_skill_structure.py
```

## Files

| File                                                      | Purpose                                               |
| --------------------------------------------------------- | ----------------------------------------------------- |
| `scripts/tools/templates/skill-flow.html`                 | Canonical self-contained frame and safe renderer      |
| `scripts/tools/scaffold-skill.py`                         | Narrow scaffolder integration                         |
| `.pi/skills/<skill>/resources/flow.html`                  | Skill-specific strict-JSON visual mirror              |
| `apps/orchestration/tests/flow-diagrams.test.ts`          | All-skill static and descriptor drift guard           |
| `.pi/extensions/playwright/scripts/validate-flow-html.ts` | Browser geometry and accessibility-oriented validator |
