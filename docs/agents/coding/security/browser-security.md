# Browser Security

## Applies when

Changing browser storage, messaging, DOM APIs, cross-origin behavior, CSP, Trusted Types, client trust, or security headers.

## Security properties

- The browser is an untrusted client and origin boundaries are explicit.
- Script execution, framing, storage, messaging, external connections, and response security policy are least-privilege.

## Requirements

- Use explicit origin checks for messages and redirects; validate all client-provided data again at the server.
- Choose storage based on sensitivity and threat model; never make local state authoritative.
- Set and verify CSP, framing, MIME, referrer, and transport-related headers appropriate to the actual application; allow each origin and capability deliberately.
- Use CORS as an explicit browser-read policy, never as server authorization.

## Failure modes

- Using wildcard origins with credentials or trusting `postMessage` origin/source implicitly.
- Treating a browser-side role, feature flag, hidden field, or storage value as a server permission.
- Copying a CSP template without testing actual resource and reporting behavior.

## Verification

- Test cross-origin messaging, CORS, framing, response headers, storage tampering, and allowed external connections.
- Inspect headers and origin behavior on the deployed path.

## Related guidance

- [XSS](xss.md) owns unsafe rendering sinks.
- [PWA service workers](pwa-service-worker.md) owns persistent worker/cache behavior; [configuration](configuration.md) owns server runtime policy.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
- [Content Security Policy Level 3](https://www.w3.org/TR/CSP3/) describes CSP as defense in depth and its reporting/enforcement model.
- [Trusted Types](https://www.w3.org/TR/trusted-types/) describes typed enforcement for DOM XSS sinks and its deployment limitations.
