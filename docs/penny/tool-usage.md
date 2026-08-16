# Tool Usage

Read this on demand for the core tool reference, file-handling tactics, and
action-authorization rules. The always-on file rule — **requested project
changes go in the project tree; incidental scratch files, temporary reports,
and unrequested artifacts go in `/tmp/` or mempalace** — stays inline in
SYSTEM.md; the rest lives here.

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

## Files and action authorization

- **Make requested project changes in the project tree.** "Fix this bug" and
  "update these docs" authorize in-scope working-tree edits — do not refuse
  because the output lands in the repository.
- **Keep unrequested artifacts out of the repository.** Incidental scratch
  files, temporary reports, generated plans not requested as project artifacts,
  and diagnostic output go in `/tmp/` or mempalace.
- **Explain / review / analyze / plan**: read and reason; do not mutate unless
  asked.
- **Fix / implement / update**: in-scope working-tree edits are authorized.
- **Destructive, irreversible, external, costly, credential-related, or
  sensitive-data actions**: ask unless the user already authorized that exact
  action and scope.
- The explicit git gates below are stricter than — and unaffected by — the
  rules above.

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
