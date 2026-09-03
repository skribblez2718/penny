# Injection Prevention

## Applies when

Untrusted data reaches query, command, template, expression, interpreter, header, URL, path, or protocol construction.

## Security properties

- Data remains data; it cannot alter interpreter syntax, control flow, transport framing, or resource selection.
- Construction uses context-aware safe APIs, parameterization, structural allowlists, and encoding.

## Requirements

- Use parameterized/bound query APIs, argument-vector process APIs, typed protocol builders, and structured template/query APIs.
- Allowlist tokens when a parameterized API cannot represent identifiers or grammar; never escape a general language as if it were a value.
- Treat templates, expressions, headers, URLs, paths, shell commands, query languages, and protocol serialization as distinct contexts.

## Failure modes

- Concatenating untrusted strings into SQL, shell, templates, headers, URLs, paths, or protocol messages.
- Treating output encoding as a replacement for safe query/command construction.
- Replacing a known unsafe API with an equivalent dynamic evaluator.

## Verification

- Review all affected sinks and construction paths; test representative delimiter, metacharacter, encoding, and parser-confusion payloads.
- Use static analysis where available and verify process calls never activate a shell for untrusted input.

## Related guidance

- [Input validation](input-validation.md) constrains external data.
- [XSS](xss.md), [SSRF and egress](ssrf-egress.md), and [untrusted execution](untrusted-execution.md) own adjacent contexts.

## Current external references

- [OWASP Application Security Verification Standard (ASVS) 5.0.0](https://owasp.org/www-project-application-security-verification-standard/) is a coverage spine, not a substitute for task-specific design and evidence.
- Reconfirm version-sensitive protocol, browser, and library guidance from primary sources before choosing concrete settings or APIs.
