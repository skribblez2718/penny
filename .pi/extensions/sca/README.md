# SCA Extension

Registers these three Pi tools:

- `sca_source_query`
- `sca_graph_query`
- `sca_application_test`

## Call-time service configuration

Each tool call reads these environment variables:

- `PENNY_SCA_SERVICE_SOCKET_PATH`
- `PENNY_SCA_SERVICE_TOKEN`
- `PENNY_SCA_CLIENT_RESPONSE_TIMEOUT_MS` (backward-compatible name for response inactivity)
- `PENNY_SCA_CLIENT_POLL_INTERVAL_MS`
- `PENNY_SCA_CLIENT_MAX_RESPONSE_BYTES`

`PENNY_SCA_CLIENT_MAX_POLL_ATTEMPTS` is retired and rejected. Current accepted work may poll indefinitely only while validated, job-bound progress sequences advance through broker-owned execution or persisted-output milestones. Repeated `accepted`/`running` snapshots, poll responses, and response bytes do not renew the job inactivity lease. Legacy v1 responses without progress metadata remain readable but receive no renewal, so they expire after the accepted request's `limits.timeout_ms`. Transport inactivity, explicit cancellation, a terminal error, or a finite resource limit also stops polling.

Import and registration perform no service probe and never autostart the service. Missing or invalid call-time configuration and an unavailable service produce a typed `service_unavailable` failure; the extension does not report success.

## Ordinary SCA registration

Use the existing `skill` registry/engine, catalog agents, immutable artifacts and registered host operations for SCA. This extension supplies broker tools, not another SCA entry workflow. Import and registration do not load the native operator/authentication modules, register `/sca-p03-initial` or `/sca-p03-auth`, enroll or log in an operator, or evaluate qualification, activation or private permission prerequisites. `createScaExtensionV1()` has no native-host operand.

The dormant `src/native-operator.ts` and `src/native-local-auth.ts` components and their tests remain for historical inspection. They are not exported or installed by the ordinary entrypoint and must not be restored as SCA prerequisites. There is no replacement install/auth UI.

The three tools retain their existing exact request schemas, operation mapping and provider-registration digest. Source/graph calls require admitted snapshot/configuration/graph references and finite limits. Application tests additionally require exact execution-plan/policy artifacts and the trusted execution boundary; registration grants no target execution or arbitrary shell/network authority. Missing adapters or invalid/failed/partial evidence remain non-success. Service IPC configuration above is transport configuration, not operator enrollment or phase activation.

Normal platform approval belongs at the actual release/publication consequence and binds the exact verified report. It is not a prerequisite to ordinary implementation, local testing or registration. Existing execution, disclosure, resource, custody and recovery controls still apply at the operations they protect.

## Validation

From `$PROJECT_ROOT`, run installed tools directly to avoid build hooks and test caches:

```bash
node node_modules/vitest/vitest.mjs run --root .pi/extensions/sca --config vitest.config.ts --no-cache tests/unit/ordinary-registration.test.ts tests/unit/tool-registration.test.ts
node node_modules/typescript/bin/tsc -p .pi/extensions/sca/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p .pi/extensions/sca/tsconfig.test.json --noEmit
```

The registration regression rejects native/auth/qualification/activation/permission module loading and private command/native-auth hook installation (the shared tool-result error bridge remains) while requiring exactly the three broker tools. Component tests are not evidence of complete scanner/graph/investigation/reporting integration or live fidelity. That complete ordinary skill remains implementation work pending actual evidence.
