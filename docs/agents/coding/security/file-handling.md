# File Handling — Safe file operations for generated code

## What

Never generate code with path traversal, unrestricted upload, or insecure file permissions. Validate all file operations.

## Why

File handling bugs lead to path traversal (reading arbitrary files), remote code execution via uploads, and information disclosure via insecure permissions.

## Rules

1. **Validate and sanitize all file paths.** Use `path.resolve()` and verify the result is within the allowed directory.
2. **Validate upload types by content, not extension.** Check MIME type and magic bytes, not the filename.
3. **Restrict upload sizes.** Set a maximum file size before processing.
4. **Use secure file permissions.** `0o600` for sensitive files, `0o644` for public. Never `0o777`.
5. **Never use user input directly in file paths.** `open(user_input)` is path traversal waiting to happen.

## Constraints

- **BLOCKER severity.** Path traversal or unrestricted upload must be fixed.
- **Upload directories must be outside the web root.** Or served with `Content-Disposition: attachment`.

## Verification

- [ ] File paths validated and resolved within allowed directory
- [ ] Upload types validated by content
- [ ] Upload sizes restricted
- [ ] File permissions are minimal
- [ ] No user input in raw file paths

## Files

| File | Purpose |
|------|---------|
| `docs/agents/coding/security/input-validation.md` | Input validation |
