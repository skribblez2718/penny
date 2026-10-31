# Safe Image Generation

Penny's image-generation foundation separates creative planning from privileged host effects. A model can help frame an image, write prompts, review candidates, and recommend revisions. It cannot choose a network endpoint, load an arbitrary graph, select an unapproved model asset, write to an arbitrary path, or submit work directly.

## What the host decides

A deployment privately provides approved profiles through an operator-owned runtime manifest named by `PENNY_IMAGEGEN_RUNTIME_MANIFEST_FILE`. A profile fixes the source graph, safe node inputs, endpoint, dimensions, required backend inventory, limits, and any allowed fallback. The manifest also binds storage ceilings and optional export destinations. Penny contains no built-in production profile or service address, and a missing or unsafe manifest fails closed.

Before a run starts, Penny resolves the selected profile and optional export destination, calculates worst-case storage, and reserves that capacity durably. It then runs a registered asynchronous readiness check before Annie or Synthia is invoked, recording whether the primary inventory or an explicitly approved fallback is usable. If a registry is missing, the profile has changed, readiness fails, or storage is unavailable, the run does not continue.

## How one candidate is produced

Penny creates a submitted graph from the approved graph by changing only registered fields: prompts, seed, dimensions, batch size, and filename prefix. The graph is stored before submission, so the exact request is auditable.

The host adapter then:

1. checks the registered local service and its exact inventory;
2. submits one graph for one candidate;
3. records the remote job ID;
4. polls only that job;
5. accepts exactly one image from the expected output node; and
6. validates and rewrites the PNG into Penny's canonical format before storage.

The HTTP client is deliberately narrow. It talks only to a literal loopback address, uses fixed routes, follows no redirects, sends no credentials, uses no proxy, and enforces byte and inactivity limits.

Those limits have separate meanings. Waiting for backend ownership ends at the queue-inactivity limit. Once work owns the backend fence, observed adapter activity can renew the operation-inactivity lease, so productive generation has no total elapsed cutoff. Socket connect/read inactivity catches a stalled transport; lease heartbeats preserve ownership but do not prove work; and cancellation uses its own bounded cleanup grace.

## Why retries are conservative

A retry is safe only when the service explicitly proves that it rejected the prompt before acceptance. A lost connection or server error may have happened after the service accepted the job. Penny treats that state as unknown and quarantines the shared backend instead of risking a duplicate submission.

After a restart, a recorded remote job ID is polled directly. Penny does not send the graph again.

## Candidates, revisions, and review

Each candidate has a stable slot number and a seed derived from the run's base seed. A semantic revision keeps the slot and seed but advances the revision number. The slot ledger permits only defined state transitions and distinguishes ordinary failure, terminal remote failure, and an unknown remote outcome.

Review operates on one complete current set. Vera checks visual validity and hard requirements while Carren checks quality and ranks every current candidate. Both reviewers must use a model that Pi positively identifies as accepting image input before any prompt is sent. Both reports must refer to the same review epoch before a candidate can be accepted or revised. This prevents an old report from approving a newer image.

If either reviewer reports a blocking issue, Synthia adjusts the prompt under actual operator repair policy, without an invented finite allowance. A Vera hard failure takes deterministic `validation_gap` precedence; a Carren-only failure becomes `product_gap`. Penny regenerates only failed slots and retains their per-slot seeds. When all current candidates pass both reviews, the host selects Carren's highest-ranked candidate from the dual-approved intersection; models do not perform the final selection or export.

## Storage and export

Storage is reserved before work begins and committed incrementally for durable artifacts. The reservation survives process restart and cannot be exceeded.

Export is optional and separate. The host registers an asynchronous export adapter, destination root, and limits; the request names only that destination and a safe directory name. Export never overwrites an existing run directory and verifies every source artifact before publication.

## Availability and consequences

The TypeScript playbook is production-registered for exact-name invocation but remains hidden from native model discovery. A durable activation authority controls whether starts are disabled, limited to one digest-bound canary, or enabled. Registration alone grants no backend authority: missing private configuration, a disabled or consumed canary, request or profile drift, and replay all fail closed.

A qualified deployment must provide a private approved profile, storage capacity, an enabled activation policy, and—when requested—an export destination. The host loader constructs only the three fixed registration-bound adapters after verifying manifest custody and exact profile approvals. Missing dependencies fail closed. Penny does not ship a production endpoint, port, model asset, source graph, or export directory.

Image generation can consume substantial local compute, storage, and time. A remotely ambiguous job quarantines the shared backend rather than risking a duplicate. Provider-free qualification proves the orchestration and evidence contracts without claiming that a live backend or multimodal reviewer is installed, that backend versions produce identical pixels, or that the result is aesthetically good.

A successful result is one exact selected PNG plus a ledger, both current review reports, a selection receipt, a provenance manifest, a product envelope, storage evidence, and an export receipt when export was requested. Failures retain valid partial artifacts but do not export or claim completion.
