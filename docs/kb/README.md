# Knowledge-base scaffold

This directory is a **generic, default-deny scaffold**. It is not a knowledge base, and a
clean clone of this repository contains no knowledge base, no host configuration, and no
private content.

Five files are tracked here and nothing else:

| File | Purpose |
|---|---|
| `.gitignore` | Default-deny: ignore everything, re-include exactly these five paths |
| `README.md` | This file |
| `manifest.example.json` | Shape reference for a KB `manifest.json` — not a live manifest |
| `templates/page.md` | Shape reference for a published page revision |
| `templates/source.json` | Shape reference for an immutable source provenance record |

## What lives here at runtime — and why you will not see it

A live knowledge base is **operator-private**. Its root is resolved by the host from an
ignored profile registry; the model never supplies or learns a filesystem path. If an
operator chooses to point a profile at this directory, every live path it creates —
`manifest.json`, `index.md`, `.kb/`, `sources/`, `pages/`, `conflicts/`, and `work/` — is
ignored by the `.gitignore` above and must additionally pass runtime admission checks
before any mutation.

**`.gitignore` alone is not the privacy control.** It is one layer. The host separately
proves, before every mutation, that the resolved root is admissible: outside any Git
worktree, or exactly this allowlisted scaffold with every live path untracked and ignored,
no nested repository or worktree, no symlink component, and owner-only permissions. A
force-added live file, a non-ignored live path, or an unexpected root fails closed.

## Authority

Knowledge-base content is **advisory**. It is evidence-linked synthesis, not canonical
current state. Canonical operational knowledge is reached through the `AGENTS.md` index
chain and is verified there. Nothing becomes canonical by being stored, queried, linted,
or proposed for promotion; promotion is a separate, explicitly approved authority
transition.

## Where the real documentation is

The templates here are shape references only. The normative behavior — manifest and record
schemas, workflows, retrieval and lint, privacy and promotion, and evaluation — is
documented under `docs/agents/knowledge-base/`.
