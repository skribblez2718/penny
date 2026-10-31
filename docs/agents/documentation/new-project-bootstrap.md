# New Project Documentation Bootstrap

## Requirement

Every durable project repository created outside Penny MUST be bootstrapped with audience-separated documentation and an `AGENTS.md` routing tree before the project bootstrap is considered complete. This requirement applies to new standalone repositories and projects, not temporary workspaces, generated output, vendored source, or examples that are not maintained as projects.

Use this minimum shape:

```text
<project-root>/
├── AGENTS.md
└── docs/
    ├── agents/
    │   ├── AGENTS.md
    │   └── <project-specific agent guidance>.md
    └── humans/
        ├── index.md
        └── <project-specific human documentation>.md
```

Add nested directories under `docs/agents/` only when the project has enough guidance to justify another routing level. Each such directory MUST own an `AGENTS.md` that routes its direct children.

## Audience split

`docs/humans/` contains human-facing explanation and navigation: the project's purpose, supported use, setup, conceptual architecture, operating guidance, and decisions that matter to maintainers or users. Human navigation is prose-based. `docs/humans/` MUST NOT contain an `AGENTS.md`.

`docs/agents/` contains the exact guidance an agent needs to change the project safely and verify its work: repository structure, supported toolchain and commands, architecture boundaries, implementation conventions, test and validation requirements, security or data constraints, deployment rules, and domain workflows when they apply.

Do not duplicate the same material for both audiences. Put the canonical detail with the audience that uses it, then cross-link from ordinary documentation when the other audience needs context.

## Root bootstrap file

The repository-root `AGENTS.md` is the only bootstrap exception to the nested-index format. It MUST:

- state only concise, repository-wide invariants that apply to every task;
- explain how to traverse the documentation tree;
- link to `docs/agents/AGENTS.md` as a next-level index using a relative path;
- link only to next-level `AGENTS.md` indexes, never directly to deeper guidance; and
- remain a bootstrap and routing file rather than becoming a second system prompt or a store for conditional procedures.

Project-specific paths, tools, and rules belong in the new project's own documentation. Do not copy Penny-specific implementation details into another repository.

## Agent routing tree

Every `AGENTS.md` below the repository root MUST follow the [AGENTS.md Standard](agents-md-standard.md): one H1 followed by one complete, one-line routing entry for each tracked direct-child Markdown document and each direct-child directory that owns an `AGENTS.md`.

Routes MUST use a concrete `MUST READ FOR`, `READ WHEN`, or `CONSULT WHEN` trigger, link only one level down, and describe what the target supplies. Substantive rules and procedures belong in the routed documents, not in nested indexes.

The routing tree MUST stay complete as documentation changes. Adding, moving, or removing a routed document requires updating its parent `AGENTS.md` in the same change.

## Selecting bootstrap documentation

Inspect the project's actual source, configuration, toolchain, delivery model, and trust boundaries before writing its documentation. Bootstrap the guidance that is relevant now; do not create empty topic files, speculative rules, or a copied taxonomy merely to resemble Penny.

At minimum, the documentation set must let a new maintainer or agent determine:

- what the project is for and what is in or out of scope;
- how to set it up, run it, and verify a change;
- where its important components and architectural boundaries are;
- which repository-wide implementation, security, data, and operational constraints apply; and
- where to find deeper guidance for any specialized area already present in the project.

A topic may be omitted when it does not apply. A material project-specific constraint may not be omitted merely because the minimum directory structure exists.

## Completion evidence

Before reporting a new project bootstrap complete, verify that:

- the root `AGENTS.md`, `docs/agents/`, and `docs/humans/` exist;
- both documentation trees contain relevant, non-placeholder content;
- every agent-facing document is reachable through the root-to-leaf `AGENTS.md` route without skipped levels;
- every nested index covers all and only its tracked direct children;
- every routing and ordinary documentation link resolves;
- `docs/humans/` contains no `AGENTS.md`; and
- documented commands, paths, and project facts match the repository as created.

Use the project's documentation and link checks when available. Otherwise, inspect the tree and links directly and report that limitation instead of claiming automated verification.
