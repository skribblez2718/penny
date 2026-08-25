# Prompt Layer Architecture

Penny assembles five layers:

1. **Cognitive Frame** — stable operating policy.
2. **Role Definition** — capability role and exact YAML tools.
3. **Domain Guidance** — task-family criteria and final SUMMARY shape.
4. **Project Index** — navigation.
5. **Invocation Context** — current goal, constraints, IDs, and paths.

No lower layer can change system policy, consequence limits, or a catalog agent's tool set.
YAML `tools:` is exact; profiles only lint it.

Exact workflow output moves by immutable artifact ID. Owner code verifies input IDs before
model use and persists/re-reads output before routing. IDs can cross runs and support
multi-source fan-in. Missing IDs/paths produce `missing_input:` rather than memory,
repository, `/tmp`, or historical-artifact search.

Markers help the model parse layers but do not enforce permissions. Runtime tool equality,
gates/receipts, artifact integrity, and OS/container boundaries provide enforcement.
