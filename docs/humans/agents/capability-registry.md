# Capability Registry

## What an agent actually is

> An agent is a **domain-invariant capability contract** whose objective, invariants,
> authority, tool posture, and input→output transformation remain stable when the subject
> matter changes.

For a long time the roster was described as a set of universal _mental faculties_. That
description was wrong about its own membership, and the wrongness had consequences.

Echo, Annie and Synthia do resemble epistemic functions. But Skribble is a _production
authority_ — it holds write access and turns specifications into files. Tabitha is
_operationalization_ — it converts an approved strategy into executable units. Neither is a
psychological faculty, and under a strict cognitive reading both look like category errors
and become deletion candidates. They are not mistakes; they are two of the better
abstractions in the system.

The same framing invited the opposite error. "Complete the cognitive taxonomy" is an
invitation to invent `learn`, `remember`, `attend` and `route` agents that earn nothing.

The capability-contract definition explains all ten roles cleanly, justifies exactly the two
that were added, and rejects the domain-agent sprawl the architecture exists to prevent.

## Three families

The roster is not one flat set. Recognising three families removes the pressure to force
every role into a single ontology:

- **Epistemic** — turn information into knowledge or judgment: explore, analyze,
  synthesize, critique, verify.
- **Deliberative** — determine what should happen: ideate, decide, plan.
- **Operational** — convert intent into externalizable work: taskify, generate.

Family membership is descriptive metadata, **not** a workflow constraint. Nothing has to
pass through an intermediate family: `analyze → decide`, `generate → verify` and
`explore → synthesize` are all ordinary.

## Why routing metadata replaced prose

Every agent's description used to carry bilateral "do not use me for X" clauses about its
neighbours. At eight agents that was tolerable. At ten it becomes ninety potential pairs,
maintained by hand, in prose, across ten files — which recreates, _inside_ the reusable
architecture, a smaller copy of the maintenance problem the architecture was built to
escape.

The repository had already proved the point. A four-agent roster enumeration survived in
the prompt-layer docs long after the roster reached eight. Hand-maintained lists drift; the
only question is how long before anyone notices.

So each role now declares structured metadata — what it accepts, what it produces, whether
it gathers, evaluates, selects, sequences or writes, and which capabilities it is most
easily confused with. Every roster table in every document is generated from that metadata.
Hand-maintained roster tables are prohibited.

### Nearest neighbours, not exhaustive exclusion

A description names at most three **nearest confusable neighbours** rather than every other
role.

Confusability is asymmetric, so the lists are deliberately not symmetric: `ideate` is easily
mistaken for `decide`, while `decide` is more often confused with `plan`. Forcing symmetry
would spend scarce description budget on noise. The registry validates that every named
neighbour actually exists; it does not require reciprocity.

### The truncation trap

The runtime bounds how much of each description the model sees, and when a description
exceeds that bound it is **silently truncated** — no error, no warning.

Truncation removes the _tail_, which is exactly where the disambiguating anti-cases live.
The failure mode is therefore invisible and lands precisely on the content that makes
routing work. The ceiling was raised, and a build-failing assertion added, so it can never
again happen quietly. Descriptions currently run 227–365 characters against a hard limit of
1,024.

## Admission: making the roster hard to grow

Adding an agent is easy and usually wrong. Every proposal must pass all six gates:

1. **Stable transformation** — expressible as `input → output` with no subject-matter noun.
2. **Cross-domain validity** — three genuinely unrelated domains where the invariants hold.
3. **Independent evaluability** — its correctness is judgeable on its own, without
   evaluating a whole workflow.
4. **Distinct reasoning or authority contract** — merging it into an existing agent would
   blur objectives, create conflicting incentives, change tools, or mix side effects.
5. **No workflow identity** — if it is really `explore → analyze → synthesize`, it is a
   skill.
6. **No domain identity** — security, finance, travel, software and research belong in
   Domain Guidance.

The governing question:

> **Would replacing the subject-matter nouns in this Role Definition change anything
> important?**

If yes, Domain Guidance is leaking into the Role Definition.

### What the test rejects

`security-review` and `data-analysis` fail gate 6 — they are `critique`, `verify` or
`analyze` plus Domain Guidance. `research` fails gate 5; it is already a composition of
generic roles, and it is the architecture's strongest proof rather than a gap in it.
`route` and `orchestrate` fail gate 4 — routing is owned by Penny and the state-machine
layer. `learn` fails gate 4; that is the memory architecture's job. A universal `execute`
agent fails gate 4 most severely of all: execution authority is domain- and
environment-specific, and one omnipotent executor would dissolve the separation between
capability and authority that the rest of this design depends on.

## Where the details live

Schema, allowed values, semantic coordinates, and the generated roster tables are in the
agent-facing twin:
[`docs/agents/agents/capability-registry.md`](../../agents/agents/capability-registry.md).

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
