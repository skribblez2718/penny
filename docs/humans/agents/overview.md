# Agents

## What they are

Agents are project-local worker roles that run in fresh Pi subprocesses. Each
role has a definition, a scoped tool set, and a capability contract — a stable
input→output transformation that stays the same when the subject matter changes.
Penny uses a worker when separate context, specialization, parallel work, or
independent judgment earns the handoff; otherwise she works directly.

## The roster

Ten capabilities in three families. Family is descriptive, not a pipeline — nothing has to
pass through an intermediate family.

<!-- BEGIN GENERATED: families -->

- **Epistemic** — transform information into knowledge or judgment: `analyze`, `critique`, `explore`, `synthesize`, `verify`
- **Deliberative** — determine what should happen: `decide`, `ideate`, `plan`
- **Operational** — convert intent into externalizable work: `generate`, `taskify`

<!-- END GENERATED -->

<!-- BEGIN GENERATED: roster -->

| Capability   | Agent      | Family       | Authority | Transformation                                                           |
| ------------ | ---------- | ------------ | --------- | ------------------------------------------------------------------------ |
| `analyze`    | `annie`    | epistemic    | `read`    | evidence/material → structured understanding                             |
| `critique`   | `carren`   | epistemic    | `read`    | work product + quality criteria → improvement judgment                   |
| `explore`    | `echo`     | epistemic    | `read`    | unknown area → relevant evidence/context                                 |
| `synthesize` | `synthia`  | epistemic    | `read`    | multiple evidence sets → integrated understanding                        |
| `verify`     | `vera`     | epistemic    | `inspect` | target + standard → evidence-backed validity verdict                     |
| `decide`     | `demetri`  | deliberative | `read`    | alternatives + objectives + uncertainty → justified choice + sensitivity |
| `ideate`     | `ida`      | deliberative | `read`    | problem + constraints → diverse candidate possibilities                  |
| `plan`       | `piper`    | deliberative | `read`    | goal + state + constraints → strategy                                    |
| `generate`   | `skribble` | operational  | `write`   | specification → materialized artifact                                    |
| `taskify`    | `tabitha`  | operational  | `read`    | strategy/specification → executable task graph                           |

<!-- END GENERATED -->

Why these ten and not others, and why adding an eleventh is deliberately hard:
[Capability Registry](capability-registry.md).

## Catalog and remote presence

`.pi/agents/*.md` frontmatter is the local project catalog. Pi snapshots it when
registering the subagent tool and requires reload if the catalog changes. The
catalog does not query memory or prove that a remote service exists.

Remote harness and service availability belongs to a separate harness/service
registry. Local roles and remote service presence are different concepts.

## How handoff works

Workers do not share Penny's conversation. The owner supplies the goal, constraints,
and exact immutable artifact IDs/paths. The worker reads needed IDs with `artifact_read`
and `next_range`, then returns complete work. YAML-declared read-only memory tools may
support advisory recall but never workflow transport.

The owner persists and re-reads exact response bytes before parsing the small routing
SUMMARY or returning success. Every result prints the exact ID; memory search and
model-authored pointers are never persistence proof.

## Durable memory boundary

The unmarked primary Penny runtime still has value-triggered durable recall,
curated writes, a primary diary, and governed temporal knowledge-graph tools.
Those capabilities support cross-session continuity. Write-capable memory remains
primary-only, and no memory operation is active workflow transport.

## Isolation

Workers have separate model context and tool allowlists, not a filesystem
sandbox. They run with the invoking user's OS permissions, while approval and
receipt secrets are stripped. Use an external container or VM for untrusted or
unattended work.

## Learn more

- [Definition Format](definition-format.md)
- [Discovery and Tools](discovery-and-tools.md)
- [Tool Authority Profiles](tool-profiles.md)
- [Invocation](invocation.md)
- [System Prompt Security](system-prompt-security.md)
