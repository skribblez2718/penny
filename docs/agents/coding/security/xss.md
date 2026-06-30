# XSS Prevention — Cross-site scripting rules for generated code

## What

Never render user-controlled data as HTML without context-appropriate escaping. Use framework-level protections; never bypass them.

## Why

XSS is the most common web vulnerability. Generated frontend code is especially prone because agents may not understand the rendering context.

## Rules

1. **Use framework escaping.** React: JSX auto-escapes. Vue: `{{ }}` auto-escapes. Never use `dangerouslySetInnerHTML` or `v-html` with user data.
2. **If you must render raw HTML, sanitize it.** Use `DOMPurify` or equivalent. Never trust user-provided HTML.
3. **Escape for the correct context.** HTML context ≠ attribute context ≠ JavaScript context ≠ CSS context. Use the right escaper.
4. **Set Content-Security-Policy headers.** `Content-Security-Policy: default-src 'self'` as a minimum.

## Constraints

- **BLOCKER severity.** Any XSS vector must be fixed before delivery.
- **`dangerouslySetInnerHTML` requires explicit justification** in a code comment.

## Verification

- [ ] No `dangerouslySetInnerHTML` or `v-html` with user data
- [ ] User data rendered through framework escaping
- [ ] Raw HTML sanitized with DOMPurify
- [ ] CSP headers set

## Files

| File | Purpose |
|------|---------|
| `docs/agents/coding/security/conventions.md` | Universal security rules |
