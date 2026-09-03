# Cross-Site Scripting Prevention

## Applies when

Untrusted data can reach browser markup, script, style, URL, rich-text, template, Markdown, or unsafe rendering APIs.

## Security properties

- Untrusted content cannot execute script or alter browser authority in its rendering context.
- Dangerous sinks are centralized, justified, and protected by context-aware encoding and defense in depth.

## Requirements

- Prefer framework escaping and safe DOM APIs; encode for the actual HTML, attribute, URL, CSS, or JavaScript context.
- Treat rich text and Markdown conversion as a privileged sanitization boundary with explicit sanitizer ownership, configuration, and tests.
- In Lit, `unsafeHTML`, `unsafeSVG`, `unsafeStatic`, `.innerHTML`, and related raw rendering APIs are privileged sinks: never pass untrusted values without an explicit, reviewed sanitizer boundary.
- Deploy CSP as defense in depth; use report-only rollout and consider Trusted Types where browser support and architecture justify it.

## Failure modes

- Passing data through a sanitizer without defining permitted content or testing its configuration.
- Using `innerHTML`, raw template helpers, URL, or style contexts because a framework normally escapes text.
- Treating CSP or Trusted Types as a replacement for safe rendering.

## Verification

- Test context-specific payloads, rich-text/Markdown sanitization, dangerous-sink call sites, CSP reporting/enforcement, and Trusted Types rollout where used.
- Review browser support and fallback behavior before making a Trusted Types requirement.

## Related guidance

- [Browser security](browser-security.md) owns general browser policy.
- [Input validation](input-validation.md) constrains inputs; [PWA service workers](pwa-service-worker.md) covers cached browser execution.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
