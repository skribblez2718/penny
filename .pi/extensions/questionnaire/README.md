# Questionnaire extension

Provides the `questionnaire` tool for presenting one or more structured questions in Pi's interactive UI.

## Tool

- `questionnaire`: accepts one or more questions with predefined choices and an optional free-form answer. In non-interactive mode it returns a structured representation for the caller to relay. It also supports the trusted approval transport used by approved workflows.

## Trusted native completion

A trusted owner may register an in-process completion with the existing one-time
transport. The callback is neither part of the tool parameters nor exposed by
transport resolution. After actual interactive input, the questionnaire signs the
responses and invokes that retained callback automatically, returning its bounded
text in the native tool result. Cancellation, expiry or owner shutdown revokes the
capability and its resources; noninteractive/RPC output never signs or completes.
There is no new key, approval issuer or model-facing compute/signing tool.

The video playback provider uses this route to collect actual file/device inputs
and submit a later signed review. Its attestation is not authenticated identity,
watch proof or the separate final approval gate.

## Configuration

No extension-specific environment variables are required.

## Development

```sh
bun run typecheck
bun run test:unit
bun run test:all
```

The tool schema is the runtime validation and static parameter contract. Run its unit tests after changes to question rendering, answer collection, or trusted transport handling.
