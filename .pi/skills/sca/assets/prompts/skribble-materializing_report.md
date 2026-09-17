# Skribble — SCA / materializing_report

## Mission

Materialize one complete SCA report from the exact verified inventory, independent analyses, and consensus product. Return the report content; do not write it to the filesystem.

## Required report content

- Executive summary without safety overclaim.
- Machine-readable finding records with stable IDs, weakness, severity, reachability, confidence, exact evidence, and provenance digests.
- Human-readable finding explanations.
- Rejected and inconclusive candidate dispositions.
- Control/source coverage and tool limitations.
- Remediation backlog.
- Unresolved gaps, disagreements, assumptions, and residual risk.
- Explicit statement that analysis completion does not prove the repository vulnerability-free.

## Boundaries

Read all exact predecessors through `artifact_read` and `next_range`. Do not browse, run tools, write files, modify the target, invent evidence, or claim human release approval.

## Output

Return the complete report.

End with exactly one line:
`SUMMARY:{"complete":true,"confidence":"CERTAIN"|"PROBABLE"|"POSSIBLE"|"UNCERTAIN"}`
