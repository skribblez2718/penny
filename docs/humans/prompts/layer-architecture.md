# Prompt Layer Architecture

Penny assembles five layers:

1. **Cognitive Frame** — stable operating policy.
2. **Role Definition** — capability role and YAML tool maximum.
3. **Domain Guidance** — task-family criteria and final SUMMARY shape.
4. **Project Index** — typed advisory routing to task-relevant guidance.
5. **Invocation Context** — current goal, constraints, IDs, and paths.

No lower prompt layer can change system policy, consequence limits, the catalog agent's YAML
maximum, or a runtime-selected surface. Direct/default paths use YAML exactly. One eligible
TypeScript orchestration phase may use only its fixed canonical-registration-bound strict
YAML subset; profiles continue to lint the maximum, and prompts/tasks/trust state cannot
select the subset.

Exact workflow output moves by immutable artifact ID. Owner code verifies input IDs before
model use and persists/re-reads output before routing. IDs can cross runs and support
multi-source fan-in. Missing IDs/paths produce `missing_input:` rather than memory,
repository, `/tmp`, or historical-artifact search.

Markers help the model parse layers but do not enforce permissions. Runtime equality to the
selected exact-YAML or registration-bound subset surface, gates/receipts, artifact integrity,
and OS/container boundaries provide enforcement. A narrow surface is not OS/process sandboxing
or extension-code isolation.
