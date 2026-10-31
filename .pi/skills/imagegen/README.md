# Imagegen skill package

This package contains only model guidance and a flow diagram. The executable state machine, readiness/generation/export host-operation declarations, graph preparation, review routing, and completion admission live in `apps/orchestration`.

Pi loads the package normally. Its `disable-model-invocation: true` flag omits it from automatic model advertising while preserving manual `/skill:imagegen <description>` invocation. The production registry accepts only exact-name skill ingress, and a durable host activation authority admits the run only when private qualification has completed. Missing, disabled, drifted, consumed-canary, or replayed authority fails closed.

No concrete profile, endpoint, model asset, graph file, export root, or operator path belongs here. A deployment must inject approved private registries and the matching readiness, generation, and optional export adapters.

## Private runtime configuration

The ordinary skill ingress loads that authority only when the host sets
`PENNY_IMAGEGEN_RUNTIME_MANIFEST_FILE` to an operator-owned, non-symlink JSON file that is not
group/world writable. Absence is fail-closed. The closed version-1 manifest contains:

- `profiles`, `approved_profile_sha256_by_id`, `node_class_policies`, and optional
  `default_profile_id`;
- `storage: { ceiling_bytes, warning_threshold_bytes }`;
- `activation`, with closed `disabled`, one-shot digest-bound `canary`, or `enabled` mode; and
- `export_destinations`, each with an opaque ID, approved absolute root, file ceiling, and byte
  ceiling.

Concrete values remain private and gitignored. The project state root owns the durable storage
reservation database. The loader supplies only the three registration-bound adapters declared by
the playbook; the manifest cannot add operation kinds or broaden tools.

## Controlled reference revisions (explicit host construction)

A trusted host may additionally bind a concrete current asset authority, independently approved revision capability and physical-worker mapping, and the registered input-upload adapter with a durable result cache. This is not enabled by the ordinary private manifest loader and does not make imagegen an authorized generic child.

A G1-bound asset call produces one PNG with no export. Whole-image source-aware img2img makes semantic preserve/change commitments, not unchanged-pixel promises. Selected-area inpainting takes a same-canvas opaque binary white-edit/black-keep mask or one source-pixel rectangle. The host replaces and verifies outside pixels from the exact source before either critic sees the final PNG. Both critics must cover the exact allowed-change and preserve criteria; missing or uncertain assessments cannot pass.

Source/mask custody and current rights/consent, exact G1 call/run/profile/render/spend bounds, separate upload/render journals and original-locator readback under the physical-worker lease are mandatory. Accepted work is not resubmitted after restart. Raw output remains non-deliverable binary evidence; final output, source/mask, upload receipts, transformation and current reviews retain distinct lineage. Supplied references use read-only admission, not a fabricated child generation. No deployed node/model, live rendering or visual-quality qualification is claimed by offline fixtures.
