# Capability Registry — typed roster metadata

## What an agent is

> An agent is a **domain-invariant capability contract** whose objective, invariants,
> authority, tool posture, and input→output transformation remain stable when the
> subject matter changes.

An agent is not a cognitive faculty and not a subject-matter specialist. `skribble` holds
write authority and `tabitha` performs operationalization; neither is a psychological
function, and both are legitimate capability contracts. Judging the roster by whether each
member resembles a mental faculty invites deleting good abstractions and inventing useless
ones.

## Single source of truth

`.pi/agents/*.md` frontmatter **is** the registry. There is deliberately no parallel
registry file — a second place to update is the drift vector this registry exists to
eliminate. Unknown frontmatter keys are ignored by discovery (`agents.ts` reads only
`name`, `description`, `tools`, `model`, `provider`, `thinking`), so the metadata is
additive and safe.

Every roster table in every document is generated from it. Hand-maintained roster tables
are prohibited.

## Schema

```yaml
capability: analyze # one word; unique across the roster
family: epistemic # epistemic | deliberative | operational
transformation: "evidence/material → structured understanding"
accepts: evidence, artifact, material
produces: findings, explanatory_model
authority: read # read | inspect | write
tool_profiles: filesystem.observe, shell.unbounded, web.search, browser.observe, artifact
side_effects: none # none | artifacts
gathers: limited # no | limited | yes
evaluates: yes # no | yes | quality | validity | integrative | self_check | limited
selects: no # no | yes | strategy_only
sequences: no # no | yes | dependencies
writes: no # no | yes
requires_standard: no # no | yes | criteria | spec
neighbors: critique, explore, synthesize
```

### `neighbors` — semantic coordinates, not exhaustive exclusion

A description may name only an agent's **nearest confusable neighbours**, at most three.
Maintaining bilateral "do not use me for X" prose across the whole roster is quadratic: at
eight agents it is tolerable, at ten it is ninety potential pairs maintained by hand, in
prose, across ten files. That reproduces — inside the reusable architecture — a smaller
copy of the maintenance problem the architecture exists to prevent.

`neighbors` requires **referential integrity, not symmetry**. Confusability is genuinely
asymmetric: `ideate` is easily mistaken for `decide`, while `decide` is more often confused
with `plan`. Forcing symmetric lists would spend scarce description budget on noise.

### Description budget

The runtime truncates silently, and truncation removes the **tail** — exactly where the
anti-cases that disambiguate routing live.

| Bound            | Value | Behaviour                       |
| ---------------- | ----: | ------------------------------- |
| Hard limit       | 1,024 | Validator fails the build       |
| Soft target      |   600 | Validator warns                 |
| Authoring budget |   400 | Convention for new descriptions |

The ceiling bounds absurdity, not authorship. Every description competes for the same model
attention during agent and skill selection, so shorter routes better.

## The roster

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

## Three families

Family membership is descriptive metadata, **not** a workflow constraint. Roles remain
freely composable: `analyze → decide`, `generate → verify`, and `explore → synthesize` are
all valid without passing through an intermediate family.

<!-- BEGIN GENERATED: families -->

- **Epistemic** — transform information into knowledge or judgment: `analyze`, `critique`, `explore`, `synthesize`, `verify`
- **Deliberative** — determine what should happen: `decide`, `ideate`, `plan`
- **Operational** — convert intent into externalizable work: `generate`, `taskify`

<!-- END GENERATED -->

## Semantic coordinates

A router reasons over these far more reliably than over eight-way negative exclusions. They
also make new-agent design harder in the right way: when someone proposes
`secure-code-reviewer`, the table immediately shows it is `critique` or `verify` plus
Domain Guidance, not a new capability.

<!-- BEGIN GENERATED: coordinates -->

| Capability   | Gathers | Evaluates   | Selects       | Sequences    | Writes  | Needs standard |
| ------------ | ------- | ----------- | ------------- | ------------ | ------- | -------------- |
| `analyze`    | limited | **yes**     | —             | —            | —       | —              |
| `critique`   | —       | quality     | —             | —            | —       | criteria       |
| `explore`    | **yes** | —           | —             | —            | —       | —              |
| `synthesize` | —       | integrative | —             | —            | —       | —              |
| `verify`     | —       | validity    | —             | —            | —       | **yes**        |
| `decide`     | —       | **yes**     | **yes**       | —            | —       | —              |
| `ideate`     | —       | —           | —             | —            | —       | —              |
| `plan`       | —       | limited     | strategy_only | **yes**      | —       | —              |
| `generate`   | —       | self_check  | —             | —            | **yes** | spec           |
| `taskify`    | —       | —           | —             | dependencies | —       | —              |

<!-- END GENERATED -->

## Transformations and confusable neighbours

<!-- BEGIN GENERATED: transformations -->

| Capability   | Accepts                                         | Produces                                            | Nearest confusable                  |
| ------------ | ----------------------------------------------- | --------------------------------------------------- | ----------------------------------- |
| `analyze`    | evidence, artifact, material                    | findings, explanatory_model                         | `critique`, `explore`, `synthesize` |
| `critique`   | artifact, criteria                              | quality_judgment, improvements                      | `verify`, `analyze`                 |
| `explore`    | question, scope, sources                        | evidence, citations, context                        | `analyze`, `synthesize`             |
| `synthesize` | evidence, findings                              | integrated_understanding                            | `generate`, `analyze`               |
| `verify`     | target, standard                                | verdict, evidence                                   | `critique`                          |
| `decide`     | alternatives, constraints, objectives, evidence | selection, ranking, rationale, decision_sensitivity | `analyze`, `plan`, `critique`       |
| `ideate`     | problem, constraints, evidence                  | candidates, hypotheses, options                     | `decide`, `generate`, `analyze`     |
| `plan`       | goal, current_state, constraints                | strategy                                            | `taskify`, `analyze`                |
| `generate`   | specification                                   | artifact                                            | `synthesize`, `taskify`             |
| `taskify`    | strategy, specification                         | task_graph                                          | `plan`, `generate`                  |

<!-- END GENERATED -->

## Agent admission test

Every proposed agent must pass all six gates, and the rationale is recorded here.

1. **Stable transformation** — expressible as `input → output` with no subject-matter noun.
2. **Cross-domain validity** — three genuinely unrelated domains where the same invariants
   hold.
3. **Independent evaluability** — its own correctness is judgeable without evaluating an
   entire workflow.
4. **Distinct reasoning or authority contract** — merging it into an existing agent would
   blur objectives, create conflicting incentives, change tools, or mix side-effect
   permissions.
5. **No workflow identity** — if it is really `explore → analyze → synthesize`, it is a
   skill, not an agent.
6. **No domain identity** — security, finance, travel, software, and research belong in
   Domain Guidance.

The governing question:

> **Would replacing the subject-matter nouns in this Role Definition change anything
> important?**

If yes, Domain Guidance is leaking into the Role Definition.

### Rejected by this test

| Proposal                                                  | Why it fails                                                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `security-review`, `data-analysis`, travel/finance agents | Gate 6. Domain and function are orthogonal; these are `critique`/`verify`/`analyze` plus Domain Guidance.                                   |
| `research`                                                | Gate 5. Already a composition of generic roles — the architecture's strongest proof.                                                        |
| `route`, `orchestrate`                                    | Gate 4. Owned by the primary runtime and the state-machine layer.                                                                           |
| `learn`                                                   | Gate 4. Owned by the memory architecture.                                                                                                   |
| universal `execute`                                       | Gate 4. Execution authority is domain- and environment-specific; one omnipotent executor would destroy the capability/authority separation. |
| `translate`, `classify`, `extract`, `reformat`            | Gate 3/4. Tool-sized work; the three-tier routing model already handles it.                                                                 |

## Verification

```bash
.venv/bin/python scripts/system/checks/check_capability_registry.py
.venv/bin/python scripts/system/checks/check_capability_registry.py --json
python scripts/system/generate_agent_roster.py --check
```

The validator fails on a missing or empty required field, a value outside its enum, a
duplicate `capability`, a `neighbors` entry that resolves to no capability, an agent listing
itself as its own neighbour, more than three neighbours, a description above the hard limit,
and a `transformation` that is not an `input → output` statement.
