# Private compute gate package

This is a reviewable, source-pinned Comfy gate and a catalog-connected owner relay. It is **not production-qualified, installed or enabled by importing Penny**. It adds no public grant endpoint, database, service manager action, GPU PID exception or model download.

## Installation boundary

The caller supplies the backend source root, a new output directory, service identity and private IPC configuration. Build a reviewable bundle without modifying the backend:

```sh
PYTHONPATH="$PROJECT_ROOT/scripts/system" python -m penny_compute_gate.bundle \
  --source-root "$BACKEND_SOURCE_ROOT" --output "$PRIVATE_BUNDLE_DIRECTORY"
```

An independently authorized backend owner must review/apply `backend.patch`, copy this Python package onto the service's import path, and place `build.json` at a pinned location. No pip dependency is needed. Rebuilding a bundle after any Python package change changes its identity. The generated files compile before publication. Unsupported startup anchors refuse.

The managed source build requires **custom nodes, API nodes and manager disabled**, including an empty custom-node whitelist. Built-in extra nodes still work. This intentionally excludes unreviewed startup scripts and arbitrary Python plugins; the package is not a sandbox for hostile same-process code. Do not drop these startup restrictions to make an installation pass. Direct raw Torch access or monkey-patching by trusted Python code is outside its enforcement boundary.

Service-owner-private configuration, selected by `PENNY_COMPUTE_GATE_CONFIG`:

```json
{
  "source_root": "<caller backend root>",
  "build_file": "<caller installed build.json>",
  "socket_path": "<caller private AF_UNIX path>",
  "socket_fd": null,
  "permitted_uid": 12345,
  "worker_id": "<caller catalog worker>"
}
```

The numeric UID above is illustrative, not a deployment default. A same-UID socket needs an existing owner-private directory. For cross-UID access, supply an administrator-provisioned listening AF_UNIX FD and an explicit permitted UID. The package does not create ACLs, change permissions or remove existing sockets. Kernel `SO_PEERCRED` is checked on both sides. The owner must also be able to validate the native process/executable/cwd pins; a denied `/proc` read is a blocker, not permission to trust a claimed PID. State, grants and counters remain owner-private on Penny's side.

## What the source bundle guards

`build.json` enumerates exact symbols and original/patched digests:

- Synchronous and asynchronous `PromptExecutor` entry, node execution, list dispatch and custom validation.
- Actual queue `put` and `get`; pre-existing manual entries park during managed ownership.
- Model-management loads, selected model-patcher load/clone paths, SD loaders/CLIP/VAE entrypoints, samplers, noise preparation, and model-prefetch CUDA capture/replay entrypoints.
- Legacy node `FUNCTION` methods and built-in V3 node `execute` methods, including alternate direct calls.
- Public mutations and WebSocket ingress during managed ownership; public client IDs never grant admission.

Normal unmanaged manual execution remains available within this restricted source build. It is never exported as native CLOSED. Closing blocks new roots first, lets existing manual calls unwind, drains owned asynchronous tasks, and synchronizes every visible CUDA device. Other accelerator types refuse qualification. Uncertain synchronization never becomes CLOSED. Direct definitions carry decorators, so ordinary early-import aliases do not bypass the guard.

No universal all-Python/all-CUDA containment claim follows from this symbol list. Installation, pinned code trust, imported dependencies, physical device exclusion and all resident services require independent qualification.

## Owner integration and wire protocol

`ManagedComputeRelay` is a host-only counterpart to `ManagedLeaseClient`. It takes the **existing concrete global capacity authority**, not a catalog filename or a new private database. Its small Python child is a peer-authenticated transport, not another authority. The caller supplies the exact `peer_transport.py` path, pins every sibling Python source through `helper.package_sha256`, and pins the interpreter. Isolated Python (`-I`) loads that explicit package path, not a package selected by `PYTHONPATH` or the working directory. The service-side package still needs an administrator-approved import-path installation.

The protocol identifier is `penny.compute-gate.v1`. Bounded newline-JSON frames carry:

1. Service `hello`: fresh connection challenge, actual process epoch and build digest.
2. Owner `claim`: echoes that challenge and supplies a fresh owner challenge; `claimed` echoes it.
3. Serialized `command`: `close`, `open`, `submit`, `status`, `cancel`, `finish`, `manual`.
4. Service `check`: fresh ID and immutable grant digest. Only the catalog-connected owner answers `current`; there is no cached PASS. Checks occur at guarded calls and a renewable active-window watchdog. Transport inactivity is not a fixed job deadline.

`open` transmits the exact canonical grant, approved graph bytes and a privately minted job ID. The owner API accepts a canonical video operation request and its exact prepared-graph artifact, verifies their digest/ref/identity binding, and does not add arbitrary graphs to `ComfyHttpClient`. Existing domain profile/rights/use-time checks still belong in the registered adapter before this call. The private submit closure rechecks the actual validated graph and rejects normalization that changes it. Queue IDs, graph digest and actual active calls appear in observations.

Close **every overlapping service gate before native baseline/admission**, using the caller's existing global catalog runtime. An adapter-only close after baseline is too late. After the durable submission guard creates a grant, open/submit the exact prepared graph; use the strict HTTP client for bounded readback with its optional `ComfySocketMeter` attached to the relay. Finish only after all HTTP sockets, executor calls, asynchronous tasks, exact owned queue/running entries and device synchronization drain. `leave()` and CLOSED publication follow actual service acknowledgement. Invalidating state before open/manual prevents a stale CLOSED file from authorizing manual computation.

The default private videogen manifest now wires this relay through the fixed compiled
`video_render` and `reference_upload` factories. Managed bindings supply the exact
worker/process/build, socket/peer UID, pinned interpreter/helper package, state/grant
files, operation counter template and a pinned private object-info inventory file.
Source and prepared graphs are checked against that inventory; current selected
node contracts must match before submission. Without managed binding, the separate
HTTP path requires explicit `legacy_http: true` and supplies no managed exclusion.

The native collector registers fixed Comfy/Voice service bindings only before binding
the existing global authority. The canonical owner closes every overlapping registered
service before adapter preparation and native GPU observation. Missing closure sources
refuse. It then initializes the exact held-operation transport window, captures the
native baseline, durably guards submission and issues the grant. No second catalog,
health-only permit or inactive-PID exception is created. Other service protocols are
not implicitly compatible; they must close through their own actual admission owner.

Video input names may contain up to eight safe identifier segments separated by dots,
within 64 ASCII characters. These are literal JSON keys, not paths. Prototype segments,
non-plain JSON and excessive representations refuse. Dynamic-combo requirements and
enums come from actual object-info; required nested inputs are never omitted or filled
from defaults. Existing image profile input syntax is unchanged.

## Cancellation, metering and recovery

Cancellation marks only the private owned window. It can remove only that exact pending job; it does not call global interrupt or clear any queue. Running work must reach checks/unwind and synchronize. An uncooperative task keeps the gate draining, not closed. A lost owner connection cancels owned admission and leaves the service managed/closed to new manual work.

IPC counters count exact newline-framed AF_UNIX stream bytes; final results include their own frame length. The HTTP meter observes actual one-use socket `bytesWritten`/`bytesRead`, including HTTP headers and body. Neither includes IP/TCP overhead or retransmissions. Transfer exports sum both directions once at the service boundary and bind exact operation/request/capacity/fence identities. They are not activity evidence. Missing or changed authority fails rather than exporting zero.

A bridge crash does not reconstruct a live client sequence or assert an executing service is idle. `drainOwned()` can cancel and obtain actual terminal/closed proof even after compute authority expires, but first removes the old counter: it does not claim final accounting or authorize hold release. Reconnection after an adopted window, final accounting after expiry, cross-UID native observation and deployed lifecycle behavior still need caller-owned recovery work/qualification. Holds must remain blocked/quarantined on uncertain acceptance or missing final counter proof.

## Verification

Portable tests use fake compute only. To additionally compile and test the caller's actual source classes without importing Torch:

```sh
PENNY_COMFY_SOURCE_TEST_ROOT="$BACKEND_SOURCE_ROOT" \
  "$PROJECT_ROOT/.venv/bin/python" -m pytest \
  "$PROJECT_ROOT/scripts/system/penny_compute_gate/tests"
```

No production endpoint is contacted by those tests. The TypeScript relay test uses a temporary CPU-only Python process, real AF_UNIX credentials, and real isolated Penny catalog/journal stores. It is not GPU or live deployment qualification.
