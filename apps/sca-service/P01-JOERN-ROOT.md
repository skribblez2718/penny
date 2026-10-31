# P01 Joern root custody

`issueScaP01JoernRootV1` is an explicit host-side issuer exported by sca-service. The build also produces a narrow `dist/p01-joern-root.js` entrypoint for collectors that should not load the wider service/P03 module graph. It measures an **already local, digest-pinned Docker image** and persists two existing P01 contract artifacts. It does not pull, build, save, export, install, run a campaign, select artifacts, qualify P03, or activate anything. There is no service route or broker registration for this operation.

## Caller contract

Supply an already-open, project-bound `ArtifactStore`, an `AbortSignal`, and a private configuration validated by `ScaP01JoernRootInputV1Schema`. The issuer neither provisions nor discovers a store. All host paths, image references, pins, identifiers, image package/launcher paths, container user/group IDs, and resource limits come from the caller. Keep configuration in caller-owned private storage, not tracked files.

Required configuration groups:

- Identity: `schema_id: penny.sca-p01-joern-root-input.v1`, `schema_version: 1`, `project_id`, fresh `run_id`, `operation_id`, `tool_id`, `receipt_id`.
- Host custody: canonical absolute `docker_executable`, `docker_executable_sha256`, local `docker_socket`, and owner-owned `0700` `staging_parent`. The executable must be a non-symlink, single-link, executable regular file owned by root or the invoking user, without group/other write permission. The endpoint must be a real local Unix socket owned by root or the invoking user, without other-write permission. Parent symlinks are refused. Docker-group membership remains privileged host authority.
- Image pins: repository `image_ref` ending in `@sha256:<64 lowercase hex>`, `expected_image_id` (`sha256:<64 lowercase hex>`), `expected_image_closure_sha256`, exact `expected_docker_client_version`, `expected_docker_server_version`, and numeric `expected_joern_version`. Registry ports are allowed; mutable tags, including tag-plus-digest references, are not.
- Image layout: absolute `package_root` and `launcher_path` beneath it. These are paths **inside the image**, not host mounts. GNU-compatible `find`, `stat`, `readlink`, and `sha256sum`, plus `sleep`, must be present in the pinned image. No arbitrary version commands are accepted.
- Confinement: non-root `uid` and `gid`, `memory_bytes`, integer `cpus`, `pids`, `tmpfs_bytes`, `inactivity_ms`, and `max_command_output_bytes`. The closed input schema defines finite bounds. Inactivity is renewable on process progress; it is not a total-runtime deadline. Output caps and a finite command budget apply independently.

The manifest digest in `image_ref` is **not** the Docker image configuration ID. Establish both pins independently in caller-owned preparation. `scaP01JoernImageClosureV1(inspectObject, image_ref)` validates a local image-inspection object and returns the immutable projection. Its canonical JSON SHA-256 is `expected_image_closure_sha256`. This utility performs no Docker commands or issuance. Do not establish a trusted pin by copying an unreviewed tag or relabeling a descriptor as measurement evidence.

Minimal integration, with all inputs supplied by the collector:

```ts
const root = await issueScaP01JoernRootV1({ store, config, signal });
// Add root.tool to the collector's existing toolchain, ordered by tool_id.
// Retain root.executable_ref and root.measurement_receipt_ref exactly.
```

The returned parser entry covers JavaScript, PHP, and TypeScript in canonical language order. The collector remains responsible for its other parser/scanner entries, canonical tool ordering, toolchain persistence under `host:sca-toolchain-authority`, accepted P01 qualification, and campaign admission. The issuer does not infer an analysis profile or fabricate a complete toolchain.

## What is measured

1. Stable Docker executable bytes (bounded, no-follow, streamed twice through the same descriptor), host file/socket custody, and exact client/server versions. Each command uses that executable digest and only a fresh private Docker configuration, explicit local `DOCKER_HOST`, and private `HOME`; it inherits neither credentials nor remote contexts.
2. Image inspection by repository digest **and** exact configuration ID, before and after the probe. Both must match the caller's image ID and closure pin. The closure preserves ordered uncompressed rootfs layer diff IDs, Linux architecture/variant, the configuration-blob digest reported by Docker's image ID, and SHA-256 of the complete canonical `Config` projection. Image-declared volumes are forbidden.
3. One exact `io.joern.joern-cli-<version>.jar`; each frontend has one runtime and one same-version launcher package. PHP and JavaScript frontend versions must equal the CLI version and caller pin. Missing, extra, duplicate, symbolic-link, or mismatched packages fail. Each regular package file and the exact regular launcher are resolved without symlink substitution and SHA-256 measured inside the pinned container.
4. Successful execution of the exact launcher with `--help`, expected Joern help framing, bounded output, and zero exit status. A banner, `--version`, a REPL, nonzero exit, stderr, truncation, or cancellation is not success. The manifest retains only the help digest/byte count, not the banner/body.
5. Actual container inspection before start, after start, and after measurement: no network, privilege, added capabilities, host namespaces, binds, volumes, devices, or published ports; read-only rootfs; dropped capabilities; no-new-privileges; disabled healthcheck; exact non-root user, resource limits, and sole bounded `/tmp` tmpfs. The container uses the measured configuration ID with `--pull=never`, not a mutable name. Its rootfs diff must be empty.
6. Exact random-name container removal, independent absence census, and private-workspace removal. Cleanup uses an independent signal even when the caller cancels or loses the create response. No positive artifact is persisted before cleanup succeeds.

The Docker daemon and its content-addressed local image store are the trusted measurement control plane. The component does **not** independently stream/re-hash every multi-gigabyte layer or verify a registry signature. `config_blob_sha256` records Docker's content-addressed image ID; `config_projection_sha256` hashes observed semantic configuration, not raw OCI configuration bytes. The distinct fields avoid equating those representations. A compromised daemon is outside this component's authority. Container isolation still requires separate real-host qualification before production use.

## Artifact semantics and failure handling

The executable-package artifact uses existing kind `sca-p01-tool-executable-package`, producer `host:sca-tool-executable-custody`, `application/octet-stream`, and content schema `penny.sca-p01-tool-executable-package.v1`. Its bytes are canonical JSON conforming to `ScaP01JoernRuntimeClosureV1Schema`, at most **64 KiB**. This is measured runtime-closure evidence, **not a restorable image, archive, or executable transport**. No multi-gigabyte material enters the store.

The matching existing `sca-p01-tool-measurement-receipt` uses producer `host:sca-tool-measurement-authority` and the existing receipt schema. `measurement_method: host-sha256` binds the exact canonical manifest bytes; it does not claim an archive hash. The receipt and returned tool entry share the manifest digest, measured version, exact executable ref, and receipt ref. Receipt metadata cites the executable ref upstream. Artifacts occupy version-1 slots in phase `sca-p01`, with the caller's run and operation IDs. Public bytes contain only image identity, version/package identities, hashes, limits, and verified cleanup; host paths, raw image environment, temporary identities, and command bodies are excluded.

Both slots must be fresh. Existing, conflicting, or partially issued operations are refused, never adopted, rewritten, selected, or relabeled. The issuer validates both planned artifacts before persistence, rechecks conflicts after asynchronous measurement, and verifies stored metadata and exact bytes. ArtifactStore publishes each complete immutable file atomically; the two-file pair is **not a cross-artifact transaction**. A store/I/O failure can leave a package without a receipt. No success result is returned; inspect that operation and choose new caller-owned IDs rather than blindly retrying it. Concurrent collectors must serialize ownership of their issuance slots.

Image/version/config/layer drift, malformed or duplicate-key Docker JSON, confinement drift, cancellation, command failure, package mismatch, cleanup residue, or artifact conflict abort issuance. Diagnostic errors retain causes for host inspection but should not be exposed as public service responses. A residue error requires owner inspection/removal; it is not permission to rerun against an uncertain container census.

## P03 handoff and verification boundary

Only after a campaign accepts the exact P01 toolchain/package/receipt cohort can those refs be supplied to production P03 bootstrap. Preserve full refs and upstream metadata; never wrap, reissue, or substitute historical roots. Existing P03 admission verifies accepted-cohort membership and measured-version agreement. This slice does not add activation or claim that P03 already replays this manifest's image closure at every runtime use. P03's independent Docker pins and host proof remain required; operators must bind them to this measured image, not merely a same-version image.

The P03 implementation source boundary includes the issuer and its regression tests. P01 qualification has caller-supplied source/build bundles rather than a fixed tracked source allowlist; fresh qualification must include the changed implementation and dependencies. Existing sealed qualifications are not updated in place.

Offline regressions exercise real parsing, hashing, confinement checks, cleanup, metadata, exact ArtifactStore persistence, and rejection paths using mocked Docker command observations and disposable stores. They are not live Docker/Joern qualification. Run targeted checks with:

```sh
bun run --cwd "$PROJECT_ROOT/apps/sca-service" test -- tests/p01-joern-root.test.ts tests/p03-toolchain-version.test.ts tests/process.test.ts
bun run --cwd "$PROJECT_ROOT/apps/sca-service" typecheck
bun run --cwd "$PROJECT_ROOT/apps/sca-service" typecheck:tests
bun run --cwd "$PROJECT_ROOT/apps/sca-service" build
```

No durable production issuance, activation, external network call, or campaign run is needed for these checks.
