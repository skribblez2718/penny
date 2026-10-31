# Image generation contract reference

## Authority and activation

Image generation is a hidden, exact-name orchestration package. The public repository contains no concrete model asset, endpoint, workflow graph, export root, or operator path. A run is admitted only when the host loads a valid operator-private runtime manifest and its durable activation authority permits the exact request. Missing, disabled, drifted, replayed, or mismatched authority fails closed before generation.

The host—not the caller or a model—resolves the approved profile, backend binding, storage partition, node-class policy, and optional export destination. The backend is restricted to the registered literal-loopback transport. The package does not authorize publication or upload.

## Caller request

The `skill` ingress receives the image goal plus a closed version-1 constraints object. Optional caller fields are:

- `profile_id`: an opaque registered profile identifier;
- `count`: 1–10 candidates;
- `seed`: an unsigned 32-bit integer;
- `max_revision_rounds`: 0–2;
- `raw_prompt`: an exact positive prompt or `null`;
- `dimensions`: a permitted positive width/height pair or `null`; and
- `export`: a registered destination ID and safe directory name, or `null`.

Unknown fields are rejected. When optional profile or seed values are absent, the host resolves and persists them. The admitted canonical request is `penny.imagegen-request.v1`; it binds the goal, resolved profile and seed, candidate count, revision limit, prompt mode, dimensions, and export request.

## Workflow

The state order is:

```text
intake → preflight → framing → composing → preparing_generation
       → generating_candidate → validating_candidates → critiquing_candidates
       → selecting_candidate → sealing_manifest → [optional_export]
       → admitting_product → complete
```

Annie frames the request. Synthia composes the initial prompt plan. Host operations prepare the approved graph and generate one slot at a time. Canonical PNG validation precedes review. Vera and Carren independently review the complete current candidate set through image-capable models. If either review reports a repairable gap and actual operator policy permits another revision, Synthia adjusts the semantic prompt plan and only failed slots are regenerated with stable per-slot seeds. Exhaustion or an unrecoverable failure terminates non-positively.

Framing or composition may request owner-mediated clarification. A worker never resolves its own blocking ambiguity.

## Exact artifacts and lineage

Every cognitive phase receives owner-selected exact artifact references and reads each needed predecessor with `artifact_read`, continuing bounded reads when required. Workers return complete typed phase output for owner capture; prose and memory are not persistence or handoff channels.

The run preserves exact request, profile snapshot, storage reservation, readiness, prompt-plan, candidate-revision, validation, dual-review, selection, slot-ledger, manifest, optional export, and release evidence. Stable slot identities and seeds make repair lineage explicit without claiming pixel reproducibility across backend changes.

## Effects and failure handling

Readiness, generation, and export are registered asynchronous host operations with independent inactivity leases and bounded request/output surfaces. Candidate generation is serial. Ambiguous remote acceptance is quarantined rather than retried. Artifact storage is authoritative; optional export is non-overwriting compatibility output to a host-registered destination.

The workflow does not support editing, inpainting, masking, upscaling, arbitrary caller graphs, caller-selected URLs, or caller-selected filesystem roots. Its controls do not imply an OS or process sandbox.

## Positive completion

Positive completion requires one current `penny.generated-image.v1` artifact of kind `generated-image`, selected from host-validated canonical PNG candidates. The completion gate also requires the current request and profile binding, complete candidate ledger and manifest, current passing Vera and Carren reports over the same candidate set, exact selection evidence, storage/release evidence, and any requested export receipt. No unresolved item may remain.

An incomplete, cancelled, or unadmitted run remains explicit and artifact-only. Provider-free tests and qualification fixtures do not establish live-backend availability, multimodal model quality, deployment readiness, or pixel-level reproducibility.
