# SSRF and Egress Control

## Applies when

Code resolves, fetches, redirects through, connects to, imports from, or proxies caller-influenced destinations.

## Security properties

- Caller-controlled input cannot grant arbitrary server-side network reachability.
- Network access is independently constrained even if application validation fails.

## Requirements

- Use a canonical URL parser; permit only required schemes, ports, methods, and destinations, preferably explicit allowlists.
- Resolve and validate destinations before connection and after every redirect; account for loopback, link-local, private, reserved, and internal networks according to the explicit product requirement.
- Bound redirects, DNS behavior, bytes, time, concurrency, decompression, and response handling. Do not forward caller credentials or ambient authority by default.
- Apply network-level egress controls that deny destinations a workload does not need, including metadata/control-plane access.

## Failure modes

- Allowing a user URL, redirect, DNS name, proxy target, import source, or webhook callback to decide network reachability.
- Validating only the initial hostname or relying only on application checks.
- Returning internal responses or error details to the caller.

## Verification

- Test unsafe schemes, redirects, rebinding/alternate encodings where feasible, internal addresses, credential forwarding, response limits, and denied egress.
- Inspect deployment network policy and actual resolver/proxy behavior.

## Related guidance

- [Input validation](input-validation.md) owns input structure.
- [Resource limits](resource-limits.md), [API security](api-security.md), and [untrusted execution](untrusted-execution.md) cover related controls.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
- [OWASP Server-Side Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) is a practical companion; confirm network and resolver behavior against the selected platform.
