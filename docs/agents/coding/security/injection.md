# Injection Prevention — SQL, command, and code injection rules

## What

Never generate code that constructs executable strings from user input. Use parameterized interfaces for all database queries, subprocess calls, and dynamic evaluation.

## Why

Injection is the #1 vulnerability class in generated code. String concatenation with user input is the root cause. Parameterization eliminates the attack surface.

## Rules

1. **SQL: use parameterized queries.** `cursor.execute("SELECT * FROM users WHERE id = ?", [user_id])`. Never f-strings or concatenation.
2. **Command: avoid shell=True.** Use argument arrays: `subprocess.run(["git", "log"], shell=False)`. Never `os.system(user_input)`.
3. **Code: never eval().** No `eval()`, `Function()`, `exec()`, or equivalent in any language.
4. **LDAP/OS/XML: use the safe API.** Every injection surface has a parameterized equivalent. Find it.

## Constraints

- **BLOCKER severity.** Any injection vector in generated code must be fixed before delivery.
- **Applies to all languages.** Python, TypeScript, Bash, SQL — the pattern is universal.

## Verification

- [ ] No string-concatenated SQL
- [ ] No `shell=True` with user input
- [ ] No `eval()` or dynamic code execution
- [ ] All subprocess calls use argument arrays

## Files

| File | Purpose |
|------|---------|
| `docs/agents/coding/security/conventions.md` | Universal security rules |
