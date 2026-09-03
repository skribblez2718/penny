# Penny Reference Protocols

- [Artifact Access](artifact-access.md): READ WHEN a delegation returns an artifact reference and exact bytes matter, or when `artifact_read` fails — reference handling and failure codes.
- [Clarification Protocol](clarification-protocol.md): READ WHEN a missing fact materially blocks scope, authorization, or the result — ambiguity and consequence handling.
- [Compaction Resume Protocol](compaction-protocol.md): READ WHEN a `[RESUME-REFS v2]` block appears — continuation recovery from durable references.
- [Routing & Delegation Protocol](routing-protocol.md): READ WHEN choosing direct work, a subagent, or an engine-backed skill — lowest-complexity routing and handoff.
- [Tool Usage](tool-usage.md): READ WHEN tool-reference, file-handling, authorization, or git-gate details are needed — tool and repository operating rules.
