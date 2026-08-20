# Knowledge Base Overview

The knowledge base (KB) is a **private, advisory, evidence-linked synthesis store**. It sits
beside the `AGENTS.md` documentation tree; it does not replace, flatten, or compete with it.

Two routes coexist deliberately:

| Route                   | Answers                                                                       | Authority                                                                           |
| ----------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `AGENTS.md` index chain | "What is the current, canonical behavior?"                                    | **Canonical.** Deterministic navigation to verified current documentation           |
| Knowledge base          | "What do the sources say, where do they disagree, and what is still unknown?" | **Advisory.** Cited synthesis that must be verified before it is treated as current |

Nothing becomes canonical by being stored, queried, linted, or proposed. Promotion into a
canonical document is a separate, explicitly approved authority transition, never an automatic
consequence of KB work.

## The eight public actions

The model-visible surface is exactly eight actions on one typed `knowledge_base` tool. There is
no ninth action, and in particular there is **no public approve or apply action**.

| Action    | Behavior                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`    | Validate an already-granted profile and, when host policy permits, create or validate the KB. Cannot register a root, choose a path, or change policy         |
| `ingest`  | Consume host-minted source capabilities; capture immutable evidence; extract, compose, check, review; publish only after an explicit content-review approval  |
| `query`   | Read one selected immutable generation and return an advisory, cited, bounded result. Returns an artifact reference by default; never a raw body              |
| `save`    | Turn an explicit prior query run into a proposed advisory revision, through the same review gate                                                              |
| `lint`    | Deterministic validation first; bounded semantic review only after that floor passes. Reports findings and candidate conflicts; repairs and publishes nothing |
| `promote` | Prepare and verify a candidate only. Never applies a canonical change through the public tool                                                                 |
| `status`  | Safe projection of a run after profile and identity revalidation. Cannot reveal roots or bodies                                                               |
| `resume`  | Continue a compatible run after profile re-resolution and guard checks. Cannot carry an approval                                                              |

`init`, `ingest`, `query`, `save`, `lint`, and `promote` are **start actions**; each creates a run
with durable idempotency bound to the host session and invocation. `status` and `resume` operate on
an existing run in the same session and profile.

## Authority order

1. **System and runtime constraints, and explicit human authorization.** Outrank everything else.
2. **Current code, tests, and canonical `AGENTS.md`-routed documents.** Decide current-state claims.
3. **Captured sources.** Evidence only.
4. **KB pages, claims, lint output, conflict candidates, query syntheses, promotion candidates.** Advisory.
5. **Model output and tool arguments.** Requests, never authority grants.

A model may name an opaque profile or capability ID it has been granted. It may never supply a
filesystem root, source path or locator, canonical target, provider choice, approval decision, or
receipt body. Those are host-owned; see [Privacy and Promotion](privacy-and-promotion.md).

## What the KB is not

- **Not a replacement for `AGENTS.md` navigation.** Canonical current-state lookup does not go here.
- **Not an automatic sink for research.** Ignored `$PROJECT_ROOT/research/` is human-directed,
  point-in-time material. It is not a live data plane and never triggers automatic ingest.
- **Not a general file reader.** It accepts no arbitrary path, URL, root, target, or provider.
- **Not a raw-body service.** No action returns a raw source, page, claim, report, or patch body.
- **Not self-promoting.** A useful query does not authorize a save; a clean lint does not authorize
  a publish; a prepared promotion does not authorize an apply.

## Advisory claim model

Every load-bearing statement on a page is a claim with a stable ID, a kind (`fact`, `inference`,
`speculation`, `unknown`), a state (`supported`, `contested`, `superseded`, `unverified_current`),
a confidence, and evidence cited to source records. Disagreement is preserved rather than resolved
away: contradictions become explicit conflict records, and uncertainty is stated instead of
smoothed over. A synthesis with no supported citation completes as _unmet_ with the evidence gap
named — it does not fabricate an answer.

## Where the exact contracts live

This documentation set describes the design so it can be operated and maintained. The exact,
normative schemas, path layouts, state machines, and cryptographic contracts are frozen in the
implementation plan's Section 5, and contract tests consume those definitions directly rather than
any prose restatement here.
