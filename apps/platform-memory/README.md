# platform-memory

`platform-memory` is the versioned, optional HTTP memory contract for independently configured harnesses. Contract v1 owns only policy and transport. It never owns workflow state, evidence, artifacts, events, service administration, model prompts, or a storage engine.

## Contract v1

Every configuration declares exactly one mode:

- `none`: principal identity only; no target, credential, client traffic, or memory capability.
- `isolated`: a dedicated service endpoint, palace ID, data-root ID, credential reference, isolation boundary, and custody policy.
- `shared-trust-domain`: deliberate shared-palace access with an explicit trust-domain ID and `wholePalaceAccessAcknowledged: true`.

A shared-trust-domain credential is **whole-palace trust**. Wings, rooms, caller-supplied principal IDs, and the palace routing header are organization/routing metadata—not authorization boundaries. Do not use shared mode for principals that are not trusted with every drawer, direct ID, KG fact, and diary in that palace. Use `isolated` or `none` until server-side principal authorization is independently proven.

Enabled configurations are caller-supplied and include:

- `principalId`;
- `target.endpoint`, `target.palaceId`, and opaque `target.dataRootId`;
- an environment-variable or absolute owner-only file credential reference;
- mode-matched trust settings;
- explicit owner, backup, migration, retention, and uninstall-preserve custody references;
- granted capability bundles and optional bounded transport settings.

The package has no default project path, data root, principal, palace, endpoint, or credential name.

```ts
import { PlatformMemoryClientV1, type PlatformMemoryConfigV1 } from "platform-memory";

const config: PlatformMemoryConfigV1 = {
  contractVersion: 1,
  mode: "isolated",
  principalId: registry.principalId,
  target: {
    endpoint: registry.memoryEndpoint,
    palaceId: registry.palaceId,
    dataRootId: registry.dataRootId,
  },
  credential: { kind: "environment", name: registry.credentialEnvironmentName },
  trust: { kind: "isolated", isolationBoundaryId: registry.isolationBoundaryId },
  custody: {
    ownerId: registry.ownerId,
    backupPolicyRef: registry.backupPolicyRef,
    migrationPolicyRef: registry.migrationPolicyRef,
    retentionPolicyRef: registry.retentionPolicyRef,
    uninstallDisposition: "preserve",
  },
  capabilities: ["recall-read"],
};

const client = new PlatformMemoryClientV1(config);
const result = await client.invoke("smart_search", { query: "prior decision", limit: 3 });
```

## Capability surface

| Capability      | Operations                                                     |
| --------------- | -------------------------------------------------------------- |
| `recall-read`   | bounded search/smart-search, exact get, bounded list, taxonomy |
| `curated-write` | duplicate check, one curated drawer add                        |
| `kg-read`       | entity query, timeline, statistics                             |
| `kg-write`      | add, invalidate, supersede one fact                            |
| `primary-diary` | configured primary diary read/write                            |

Delete, bulk delete, unrestricted export/enumeration, backup, repair, migration, admin, event broadcast, and logstream operations are not in the client operation type and fail closed at runtime. Diary identity comes from trusted configuration, not operation input. Routing fields such as endpoint, palace, root, principal, and credential cannot be overridden per call.

The HTTP client sends bounded MCP `tools/call` requests, retries only allowlisted idempotent reads, and returns transport-normalized structured data. It never opens local palace bytes and has no direct-storage or fallback mode.

## Result-budget boundary

`PlatformMemoryClientV1.invoke()` returns structured `PlatformMemoryResultV1` data; it does **not** create a model-visible tool result. An adapter exposing results to a model must normalize domain payloads, construct its complete final envelope, and enforce its byte/character/token budget after serialization. The package response must never be passed through as an unrestricted model result.

## Data lifecycle

The target data-root ID is custody metadata only. This package never creates, migrates, repairs, re-homes, archives, or deletes a data root. Package install, update, and removal are code lifecycle operations only. Data backup, migration, retention, and deletion require a separate, explicitly authorized owner operation. Contract v1 requires `uninstallDisposition: "preserve"`.

## Conformance

```bash
bun run test:all
```

The suites cover strict config and operation policy, HTTP transport, two synthetic harnesses with distinct principals/configurations, `none` and physical-isolation denial cases, forbidden delete/admin/logstream/event calls, diary and KG boundaries, source guards, and clean-machine install/update/remove with external data-root sentinels.
