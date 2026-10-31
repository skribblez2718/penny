---
name: imagegen
description: Generate and visually review PNG candidates through a host-approved private image profile. Use when the user explicitly asks to create a fresh text-to-image illustration and accepts local compute use. Do not use for editing, inpainting, upscaling, arbitrary graphs, caller-selected backends, or automatic publication.
disable-model-invocation: true
metadata:
  version: "1.0.0"
  penny:
    engine: orchestration
    subagents:
      - annie
      - synthia
      - vera
      - carren
---

# Image Generation

Use the `imagegen` orchestration playbook only after the host completes live qualification and enables it through the durable activation authority. The playbook is production-registered but fails closed unless an operator-private runtime manifest provides approved profiles and an `enabled` activation policy. The caller supplies a goal and a closed constraints object; the host supplies all private profile, backend, storage, and optional export authority.

## Liveness

Derive values from actual operator policy, not test constants or model guesses. Do not invent finite step, agent-call, phase-cycle, semantic-repair or correction-attempt caps.

Ordinary permitted work has no fixed wall-clock deadline at any layer. Productive execution may continue indefinitely while trusted activity or durable convergence renews its inactivity lease. A stall ends on inactivity expiry; explicit cancellation, errors, actual operator limits, and independent input/output/resource/containment limits remain enforceable.

## When to Use

Use this skill only for an explicit request to create a new PNG from text through an already configured private image profile. The caller should accept that the run can consume substantial local GPU time and artifact storage.

## When Not to Use

Do not use the ordinary invocation above for image editing, inpainting, masking, upscaling, compositing, arbitrary caller graphs or node mutations, caller-selected hosts or filesystem roots, publication, or upload. The ordinary runtime-manifest loader remains fresh-text-to-image only. Do not start when the operator-private runtime manifest, approved profile, storage partition, image-capable critics, or loopback backend is unavailable.

A separate trusted-host construction supports controlled-reference revision only with exact current G1-bound asset/call/spend authority, canonical source and optional binary mask or rectangle, current rights/consent, and an independently approved revision profile. It preserves source pixels outside a selected edit area through host composition and verification; whole-image revision has semantic preservation criteria instead. Callers cannot enable this path through ordinary constraints. It is not generic-child enabled, and its offline tests do not qualify a deployment.

## Invocation

Invoke the exact hidden package through the orchestration ingress:

```typescript
skill({
  skill_name: "imagegen",
  goal: "A wordless scientific illustration of two entangled qubits",
  constraints: {
    schema_version: 1,
    count: 1,
    seed: 424242,
    max_revision_rounds: 0,
    raw_prompt: null,
    dimensions: null,
    export: null,
  },
});
```

The package is model-invisible, so it is never selected from the model-facing skill catalog. Exact-name invocation enters the production registry, then fails closed when runtime authority is absent, disabled, canary-bound to another request, or drifted. Qualification harnesses exercise the same registration with disposable host authority.

## Request

```json
{
  "schema_version": 1,
  "count": 3,
  "max_revision_rounds": 1,
  "raw_prompt": null,
  "dimensions": null,
  "export": null
}
```

Optional fields:

- `profile_id`: an opaque host-registered profile ID. Omit it to use the host default.
- `seed`: an unsigned 32-bit integer. Omit it for one host-generated, persisted seed.
- `count`: candidate count from 1 to 10.
- `max_revision_rounds`: 0 to 2 semantic prompt-repair rounds.
- `raw_prompt`: an exact positive prompt that must be preserved byte-for-byte.
- `dimensions`: `{ "width": integer, "height": integer }`, accepted only when the profile permits it.
- `export`: `{ "destination_id": string, "directory_name": string }` for a host-registered destination. It never accepts a filesystem root.

Unknown fields and unsafe values are rejected before model or backend work.

## Behavior

The TypeScript playbook first proves backend and approved-inventory readiness through a registered asynchronous operation. It then frames the request, composes a wordless-image prompt plan, builds an approved graph structurally, generates candidates serially, validates canonical PNGs, and sends the complete current image set to Vera and Carren in parallel. Both critic calls require positive image-input capability evidence from Pi model metadata before prompting. Only critic-failed slots are regenerated, with stable per-slot seeds.

A positive result returns one exact selected `generated-image` artifact plus manifest, ledger, review, selection, storage, and optional export evidence. Incomplete results remain artifact-only and are never exported.

## Consequences and limits

- Invocation may consume substantial local CPU/GPU, storage, and time.
- The backend is a host-registered literal-loopback service; callers and models cannot select URLs.
- Ambiguous remote acceptance is quarantined rather than retried.
- Artifact storage is authoritative. Export is an optional registered asynchronous, non-overwriting compatibility output.
- No live backend, multimodal model, deployment, or pixel-reproducibility guarantee is implied by provider-free qualification.
