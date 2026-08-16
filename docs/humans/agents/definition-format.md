# Agent Definition Format

Each `.pi/agents/<name>.md` file is one local catalog entry. YAML frontmatter
provides the role name, routing description, model, and exact tool list. The body
provides Purpose, Working Discipline, role-specific Non-Negotiables, Output, and
the `<agent_boundary>` insertion anchor.

## The important changes

Workers no longer receive durable-memory tools or instructions. Their role files
include `artifact_read` because workflows may grant exact current-run inputs; the
runner hides that tool when no trusted grant exists.

Working Discipline now says:

- read every granted `input_artifacts` ref with `artifact_read`;
- follow typed continuation until the input is complete;
- do not discover predecessor workflow output through another channel;
- preserve the role's evidence/honesty contract and SUMMARY wire vocabulary.

Output is complete work, not a claim that full content lives in memory. When a
skill defines a SUMMARY, it is appended only as routing data. The execution owner,
not the model, proves persistence and registration.

## Why this format matters

The frontmatter is executable catalog metadata; body text cannot add a tool. The
body stays domain-agnostic so the same role can serve many skills through static
Domain Guidance. Remote harness/service presence is intentionally outside this
catalog and belongs to its own registry.

## Learn more

- [Agents](overview.md)
- [Discovery and Tools](discovery-and-tools.md)
- [Invocation](invocation.md)
- Agent reference: [Definition Format](../../agents/agents/definition-format.md)
