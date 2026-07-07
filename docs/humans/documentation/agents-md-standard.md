# AGENTS.md Files

## What They Are

`AGENTS.md` files are navigation indexes for the Penny documentation tree. Each file is a short Markdown list: document title, relative path, and a one-line description. That's it. They do not contain rules, explanations, architecture overviews, or quick-reference summaries. Their only job is to help Penny and agents find the right document for the current task.

## Why They Are Indexes, Not Content

The reason is context conservation. Penny and subagents operate with finite context windows. If an index file were also a comprehensive guide, every agent that opened it would load a wall of text, most of which is irrelevant to the immediate task. A lean index lets the reader identify the one or two documents they actually need, then read only those.

Separating index from content also keeps maintenance clear. When a document moves or a new one is added, only the index changes. When guidance changes, only the target document changes. The boundary between "where things are" and "what they say" stays sharp.

## How They Work With Pi Auto-Discovery

Pi loads `AGENTS.md` files by walking upward from the current working directory toward the filesystem root. This means:

- The root `AGENTS.md` is always loaded because every path leads up to it.
- Nested `AGENTS.md` files inside subdirectories are **not** auto-loaded by Pi. Penny reads them on demand when she needs to navigate a sub-tree.
- The root index is the entry point; nested indexes are local maps.

For example, `docs/agents/agents/AGENTS.md` is read when Penny wants to browse the agents documentation sub-tree. It is not pushed into context automatically.

## What a Good AGENTS.md Entry Looks Like

A good entry is short and precise:

```markdown
- [Agent Overview](overview.md): Architecture, lifecycle, and invocation patterns
```

It uses a relative path from the location of the `AGENTS.md` file and a one-line description. It does not copy the document's content or add editorial commentary.

## The Reading Discipline That Goes With It

Indexes are paired with a reading discipline. The default rule is: read only the files relevant to the current task. Do not greedily follow every link. The exception is system documentation — architecture, standards, protocols — where cross-references are load-bearing and should be followed once a file is in scope.

In short, the index gets you to the door. The document behind the door is what you read.

## Learn More

- [Documentation System Overview](overview.md): How this fits into the larger docs structure.
- Agent-facing reference: [AGENTS.md Standard](../../agents/documentation/agents-md-standard.md)
