# Agent Discovery and Tools

Penny's local agent catalog is `.pi/agents/*.md`. Each file names a reusable capability
role and declares a required YAML `tools:` list.

That list is exact—not a maximum that another runtime may narrow and not a minimum that a
skill may expand. Before any model request, every production runner checks:

```text
active tool names == YAML tool names
```

Missing, empty, duplicate, or unknown names stop the invocation before model usage.
Trust profiles, workflow phases, artifact inputs, and optional-service configuration do
not change the set. Authority profiles are CI lint metadata only.

Penny loads all provider extensions so a declared name can register. If an optional service
is unavailable, the tool remains visible and returns a typed operational error when called.

`artifact_read` is an exact-ID communication primitive. It performs direct immutable
manifest lookup and digest/length verification; it does not use grants, run/consumer
checks, expiry, or a discovery surface.

Tool allowlists are meaningful model/runtime controls but not an OS sandbox. In particular,
`bash` retains filesystem, process, network, and package-install authority.
