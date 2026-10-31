# Prompt Layer Architecture

Penny assembles six layers:

1. **Cognitive Frame** — stable operating policy.
2. **Role Definition** — capability role and YAML tool maximum.
3. **Canonical Docs** — reusable standards bound by exact path and content digest.
4. **Domain Guidance** — task-family criteria and declared final SUMMARY shape.
5. **Project Index** — typed advisory routing to task-relevant guidance.
6. **Invocation Context** — current goal, constraints, IDs, and paths.

No lower prompt layer can change system policy, consequence limits, the catalog agent's YAML
maximum, or an active runtime surface. The [binding runtime rule](../../agents/agents/discovery-and-tools.md#binding-runtime-rule)
owns exact YAML activation and registered subsets, including the guarded zero-tool exception.
Profiles lint the maximum; prompts, tasks, and trust state cannot select tools.

Exact workflow output moves by immutable artifact ID. Owner code verifies input IDs before
model use and persists/re-reads output before routing. IDs can cross runs and support
multi-source fan-in. Missing IDs/paths produce `missing_input:` rather than memory,
repository, `/tmp`, or historical-artifact search.

Markers help the model parse layers but do not enforce permissions. Runtime equality to the
selected exact-YAML or registration-bound subset surface, gates/receipts, artifact integrity,
and OS/container boundaries provide enforcement. A narrow surface is not OS/process sandboxing
or extension-code isolation.
