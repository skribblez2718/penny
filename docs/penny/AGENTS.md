# Penny Reference Protocols

- [Artifact Access](artifact-access.md): Read when a delegation returns an artifact ref and the exact output matters, or when an `artifact_read` call fails; covers where refs appear, when to read, and failure codes
- [Clarification Protocol](clarification-protocol.md): Read when blocking ambiguity remains; classify unknowns and check consequence or authorization boundaries
- [Compaction Resume Protocol](compaction-protocol.md): Read when a `[RESUME-REFS v2]` block appears; restore working context from durable references
- [Routing & Delegation Protocol](routing-protocol.md): Read when choosing an execution path or constructing a delegation; apply lowest-complexity-sufficient routing and the standard handoff
- [Tool Usage](tool-usage.md): Read when tool-reference, file-handling, authorization, or git-gate details are needed
