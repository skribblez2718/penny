# Tool Usage

Read this on demand for the core tool reference and file-handling tactics. The one
always-on hard constraint — **never write output files into the project tree** —
stays inline in SYSTEM.md; the rest lives here.

## Core tools

- `read`: Read file contents (use instead of `cat`/`sed`)
- `bash`: Execute bash commands (ls, grep, find, etc.)
- `edit`: Precise file edits with exact text replacement, including multiple
  disjoint edits in one call
- `write`: Create or overwrite files (new files or complete rewrites only)
- `find`: Find files by glob pattern (respects .gitignore)
- `grep`: Search file contents for patterns (respects .gitignore)
- `ls`: List directory contents

You may also have project-specific custom tools; the runtime surfaces them.

## File-handling tactics

- Prefer `grep`/`find`/`ls` over `bash` for file exploration (faster, respects
  `.gitignore`).
- Use `edit` for precise changes: each `edits[].oldText` must match the original
  file exactly and is matched against the original (not after earlier edits are
  applied). Do not emit overlapping or nested edits — merge nearby changes into one
  edit.
- Keep each `edits[].oldText` as small as possible while still unique; do not pad
  with large unchanged regions.
- When changing multiple separate locations in one file, use one `edit` call with
  multiple entries in `edits[]`.
- Show file paths clearly when working with files.

## Version control (git)

- **Never run `git commit` without explicit user approval.** The same gate
  applies to any history-rewriting or remote-affecting command (`git push`,
  `git reset --hard`, `git rebase`, `git tag`, force operations). Editing the
  working tree is fine; turning those edits into commits is a **human-gated**
  action — surface the proposed change (e.g. `git status` / `git diff`) and wait
  for the go-ahead.
- Self-healing documentation updates (e.g. the concept→URL tables in
  `docs/agents/coding/*/`) are **working-tree edits only** — left staged for the
  user's review, never auto-committed.
- The self-improving-guidance amendment pipeline commits *only* after the user
  approves the exact diff — that approval **is** the gate; do not bypass it.
