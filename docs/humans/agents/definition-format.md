# Agent Definition Format

Each `.pi/agents/<name>.md` file is one local catalog entry. YAML frontmatter
provides the role name, routing description, model, exact tool list, authority
class, and tool-authority profiles. The body provides Purpose, Working Discipline,
role-specific Non-Negotiables, Output, and the `<agent_boundary>` insertion anchor.

## The important changes

Workers now receive read-only memory tools (the `memory.read` profile: search,
read drawers/list/taxonomy, read KG, read Penny's diary) but no write tools.
Their role files include `artifact_read` because workflows pass exact immutable IDs.
The tool remains visible exactly as YAML declares, even when no inputs are supplied.

Working Discipline now says:

- read every needed `input_artifacts` ID with `artifact_read` and `next_range`;
- repeat with `next_range` until the input is complete;
- do not discover predecessor workflow output through another channel;
- preserve the role's evidence/honesty contract and SUMMARY wire vocabulary.

Output is complete work, not a claim that full content lives in memory. When a
skill defines a SUMMARY, it is appended only as routing data. The execution owner,
not the model, proves persistence and registration.

## Frontmatter fields

| Field               | Purpose                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `name`              | Lowercase alphanumeric plus hyphens; matches filename.                                                |
| `description`       | One-line role, positive triggers, and anti-cases.                                                     |
| `tools`             | Required non-empty duplicate-free exact active list; include `artifact_read`.                         |
| `authority`         | Static intent class (`read`, `write`, or `inspect`) used to lint the exact YAML list.                 |
| `tool_profiles`     | Named rungs that expand exactly to `tools:`. Verified by `check_tool_profiles.py` in `make lint`.     |
| capability metadata | `capability`, `family`, `transformation`, `accepts`, `produces`, and semantic coordinates. See below. |
| `model`             | Runtime-resolvable model name.                                                                        |

## Capability metadata

Frontmatter is also the roster's single source of truth. Each role declares the one-word
capability it owns, its family, its domain-free `input → output` transformation, what it
accepts and produces, and a set of semantic coordinates (does it gather, evaluate, select,
sequence, write; does it need a standard).

There is deliberately **no parallel registry file**. A second place to update is precisely
the drift vector this metadata exists to remove — the repository had already accumulated a
stale four-agent roster table in its prompt docs while the real roster was eight. Every
roster table in the documentation is now generated from frontmatter, and hand-maintained
roster tables are prohibited.

Descriptions name only a role's nearest confusable **neighbours** (at most three) instead of
enumerating everything it is not. See [Capability Registry](capability-registry.md).

`tools:` is the exact runtime surface. A task, prompt body, trust profile, skill,
artifact, or remote service cannot add, remove, or suppress a tool. `authority` and
`tool_profiles` statically lint the intended
authority declared and machine-checked; see [Tool Authority Profiles](tool-profiles.md).

## Why this format matters

The frontmatter is executable catalog metadata; body text cannot add a tool. The
body stays domain-agnostic so the same role can serve many skills through static
Domain Guidance. Remote harness/service presence is intentionally outside this
catalog and belongs to its own registry.

## Learn more

- [Agents](overview.md)
- [Discovery and Tools](discovery-and-tools.md)
- [Tool Authority Profiles](tool-profiles.md)
- [Invocation](invocation.md)
- Agent reference: [Definition Format](../../agents/agents/definition-format.md)
