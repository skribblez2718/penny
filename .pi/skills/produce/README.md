# Produce candidate

`produce` is a registered universal orchestration workflow for one durable artifact content product from a closed brief and inline supplied material. It is model-visible through Pi native discovery and Penny's model-facing catalog; explicit `skill` invocation is routed through the sole executable playbook registry and its bound contract. Model visibility grants no authority to bypass host consequence boundaries.

```text
host intake → Ida explores → Demetri selects → Skribble materializes
            → host seals → Carren reviews quality → Vera verifies validity
            → host mints current-product receipts + integrity/envelope → complete
```

## Order rules and prevented failure modes

| Order rule                                               | Failure mode it prevents                                                                                                    |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Canonical intake before approach exploration             | Workers silently reinterpret or omit the caller's exact brief.                                                              |
| Ida explores bounded alternatives without selecting      | The first obvious format wins prematurely, or ideation silently becomes decision authority.                                 |
| Demetri selects before Skribble authors                  | A non-selecting agent is forced to recommend, or Skribble invents a choice while materializing.                             |
| Skribble alone materializes the final draft              | The decision is confused with the finished artifact or several partial drafts compete.                                      |
| Host sealing before reviews                              | Reviewers judge unvalidated framing, stale hashes, or incomplete request coverage.                                          |
| Carren quality review before Vera objective verification | The required product-facing quality pass is skipped or quality evidence is attached after validity to a different revision. |
| Every repair reseals and repeats Carren then Vera        | A changed draft inherits stale review evidence from the prior product.                                                      |
| Host receipts and envelope after both current reviews    | Model verdict text becomes persistence or admission authority.                                                              |

The Carren-before-Vera order is an explicit product requirement for this candidate. Vera remains independent: it recomputes objective checks and does not defer to Carren's judgment.

## Boundaries

- V1 accepts one inline closed brief and no caller artifact inputs.
- Supported kinds are exactly `text`, `markdown`, `json`, `yaml`, `typescript`, `javascript`, `python`, and `shell`.
- Supplied source statements are task material, not independently verified facts.
- Ordinary workflow phases omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML tool list. `artifact_read` is mandatory for exact predecessors and no other channel may replace a missing ref. Other YAML tools are usable only when materially relevant and allowed by caller/task and phase boundaries; Skribble's write-capable YAML surface does not authorize filesystem mutation in Produce.
- Normal-phase external calls are capped at 8 per worker and 64 per run; routing-only repair remains at 0. Those ceilings do not authorize file writes, code execution, compilation, tests, browsing, fetching, deployment, publication, or direct approval.
- Demetri returns a justified selection with sensitivity, or an honest `unresolved` disposition when the brief cannot support a defensible choice; unresolved selection ends non-positive before materialization.
- `not_applicable` can complete when required supplied material is absent or hard constraints make production impossible; it contains no artifact content.
- Missing exact material, malformed products, stale/wrong-run evidence, and exhausted repair remain non-positive.

## Repair routes

- Carren `quality_gap` → Skribble.
- Vera `brief_gap` → Ida → Demetri → Skribble.
- Vera `artifact_product_gap` → Skribble.
- One host-seal framing/schema repair → Skribble; repeated seal failure → `incomplete`.

All revisions return through host sealing, Carren, and Vera. There is no user-response or approval state.

See `resources/reference.md` for the wire contract and `resources/flow.html` for the exact machine mirror.

## Flow diagram

`resources/flow.html` is the strict-JSON visual mirror of `PRODUCE_FLOW`.
Validate it with `tests/produce-flow.test.ts`, the shared drift test, and
`bun .pi/extensions/playwright/scripts/validate-flow-html.ts --skill produce`.
It preserves the Carren-before-Vera ordering and documents omitted uniform
negative seams without adding write, execution, publication, or approval routes.
