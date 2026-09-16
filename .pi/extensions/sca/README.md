# SCA Extension

Registers these three Pi tools:

- `sca_source_query`
- `sca_graph_query`
- `sca_application_test`

## Call-time service configuration

Each tool call reads these environment variables:

- `PENNY_SCA_SERVICE_SOCKET_PATH`
- `PENNY_SCA_SERVICE_TOKEN`
- `PENNY_SCA_CLIENT_RESPONSE_TIMEOUT_MS`
- `PENNY_SCA_CLIENT_POLL_INTERVAL_MS`
- `PENNY_SCA_CLIENT_MAX_POLL_ATTEMPTS`
- `PENNY_SCA_CLIENT_MAX_RESPONSE_BYTES`

Import and registration perform no service probe and never autostart the service. Missing or invalid call-time configuration and an unavailable service produce a typed `service_unavailable` failure; the extension does not report success.

## Validation

Run from this directory:

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test:unit
bun run test:integration
bun run build
```

## Deferred

YAML catalog wiring, an SCA skill, and the SCA backend are deferred and are not provided by this package.
