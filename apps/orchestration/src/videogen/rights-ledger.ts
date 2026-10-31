import { Type, type Static } from "typebox";
import type { ArtifactStore } from "../artifact-store.js";
import { ArtifactRefSchema, type ArtifactRef } from "../contracts.js";
import type { RunContext } from "../context.js";
import {
  OpaqueIdSchema as Id,
  Rfc3339UtcSchema,
  assertRfc3339Utc,
  assertUnique,
} from "../skill-contracts/common.js";
import {
  exactRef,
  readExact,
  readSemantic,
  sameRef,
  validateFoundation,
  type FoundationLimitsV1,
} from "./bounds.js";
const closed = { additionalProperties: false } as const;
const refs = Type.Array(ArtifactRefSchema, { uniqueItems: true });
export const RightsUseSchema = Type.Union([
  Type.Literal("source"),
  Type.Literal("preview"),
  Type.Literal("motion"),
  Type.Literal("edit"),
  Type.Literal("deliver"),
]);
export type RightsUse = Static<typeof RightsUseSchema>;
/** Host-internal closure omitted from the external proposal. Evidence is not a model verdict. */
export const RightsBindingV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-rights-binding.v1"),
    schema_version: Type.Literal(1),
    subject_ref: ArtifactRefSchema,
    subject_kind: Type.Union([
      Type.Literal("image"),
      Type.Literal("video"),
      Type.Literal("voice"),
      Type.Literal("performer"),
      Type.Literal("model"),
      Type.Literal("text"),
      Type.Literal("control"),
    ]),
    revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    provenance_ref: ArtifactRefSchema,
    // Exact inherited grants, not a replacement legal authorization. Use-time checks recurse
    // through the current selections so revoking any ancestor revokes its derivatives.
    derived_from_rights_refs: Type.Optional(
      Type.Array(ArtifactRefSchema, { minItems: 1, maxItems: 128, uniqueItems: true })
    ),
    license_ref: ArtifactRefSchema,
    consent_refs: refs,
    allowed_uses: Type.Array(RightsUseSchema, { minItems: 1, uniqueItems: true }),
    territories: Type.Array(Id, { minItems: 1, uniqueItems: true }),
    credits: Type.Array(Type.String({ minLength: 1 })),
    valid_from_utc: Rfc3339UtcSchema,
    expires_at_utc: Rfc3339UtcSchema,
  },
  closed
);
export type RightsBindingV1 = Static<typeof RightsBindingV1Schema>;
export const ProvenanceBindingV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-provenance-binding.v1"),
    schema_version: Type.Literal(1),
    subject_ref: ArtifactRefSchema,
    source_refs: refs,
    producer_receipt_ref: ArtifactRefSchema,
  },
  closed
);
export type ProvenanceBindingV1 = Static<typeof ProvenanceBindingV1Schema>;
export const CrossRunEdgeV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-cross-run-edge.v1"),
    schema_version: Type.Literal(1),
    project_id: Id,
    consumer_run_id: Id,
    source_ref: ArtifactRefSchema,
    rights_ref: ArtifactRefSchema,
    provenance_ref: ArtifactRefSchema,
    authorization_ref: ArtifactRefSchema,
  },
  closed
);
export type CrossRunEdgeV1 = Static<typeof CrossRunEdgeV1Schema>;
/** Current host authority, not caller metadata. Rechecked at every use even when bytes are unchanged. */
export const CurrentRightsV1Schema = Type.Object(
  {
    subject_ref: ArtifactRefSchema,
    rights_ref: ArtifactRefSchema,
    revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    status: Type.Union([Type.Literal("cleared"), Type.Literal("revoked")]),
  },
  closed
);
export type CurrentRightsV1 = Static<typeof CurrentRightsV1Schema>;
export interface RightsHostV1 {
  readonly store: ArtifactStore;
  readonly project_id: string;
  readonly run_id: string;
  readonly limits: FoundationLimitsV1;
  readonly now_utc: string;
  readonly territory: string;
  readonly current_rights: readonly CurrentRightsV1[];
  readonly cross_run_edges: readonly CrossRunEdgeV1[];
}
export function validateRightsBinding(value: unknown, limits: FoundationLimitsV1): RightsBindingV1 {
  const v = validateFoundation(RightsBindingV1Schema, value, limits);
  assertRfc3339Utc(v.valid_from_utc, "rights start");
  assertRfc3339Utc(v.expires_at_utc, "rights expiry");
  if (
    Date.parse(v.expires_at_utc) <= Date.parse(v.valid_from_utc) ||
    (["voice", "performer"].includes(v.subject_kind) && v.consent_refs.length === 0)
  )
    throw new Error("rights lifetime/consent missing");
  assertUnique(
    v.consent_refs.map((x) => x.artifact_id),
    "consent refs"
  );
  return v;
}
export function assertAuthorizedOrigin(
  host: RightsHostV1,
  ref: ArtifactRef,
  rightsRef: ArtifactRef,
  provenanceRef: ArtifactRef
): void {
  if (ref.run_id === host.run_id) return;
  const edges = host.cross_run_edges.map((x) =>
    validateFoundation(CrossRunEdgeV1Schema, x, host.limits)
  );
  assertUnique(
    edges.map((x) => x.source_ref.artifact_id),
    "cross-run source edges"
  );
  const edge = edges.find(
    (x) =>
      x.project_id === host.project_id &&
      x.consumer_run_id === host.run_id &&
      sameRef(x.source_ref, ref) &&
      sameRef(x.rights_ref, rightsRef) &&
      sameRef(x.provenance_ref, provenanceRef)
  );
  if (edge === undefined) throw new Error("explicit authorized cross-run edge required");
  readExact(host.store, host.project_id, edge.authorization_ref, host.limits.max_json_bytes);
}
export function checkRights(
  host: RightsHostV1,
  subject: ArtifactRef,
  rightsRef: ArtifactRef,
  use: RightsUse,
  ancestors: ReadonlySet<string> = new Set()
): RightsBindingV1 {
  if (ancestors.has(rightsRef.artifact_id) || ancestors.size >= host.limits.max_depth)
    throw new Error("cyclic or excessive rights derivation");
  const visited = new Set([...ancestors, rightsRef.artifact_id]);
  assertRfc3339Utc(host.now_utc, "host clock");
  exactRef(subject);
  exactRef(rightsRef);
  const current = host.current_rights.map((x) =>
    validateFoundation(CurrentRightsV1Schema, x, host.limits)
  );
  assertUnique(
    current.map((x) => x.subject_ref.artifact_id),
    "current rights subjects"
  );
  const selected = current.find((x) => sameRef(x.subject_ref, subject));
  if (
    selected === undefined ||
    selected.status !== "cleared" ||
    !sameRef(selected.rights_ref, rightsRef)
  )
    throw new Error("rights missing, stale or revoked");
  const rights = validateRightsBinding(
    readSemantic({
      store: host.store,
      project_id: host.project_id,
      ref: rightsRef,
      schema: RightsBindingV1Schema,
      schema_id: "penny.videogen-rights-binding.v1",
      limits: host.limits,
    }),
    host.limits
  );
  if (
    !sameRef(rights.subject_ref, subject) ||
    rights.revision !== selected.revision ||
    !rights.allowed_uses.includes(use) ||
    !rights.territories.includes(host.territory) ||
    Date.parse(host.now_utc) < Date.parse(rights.valid_from_utc) ||
    Date.parse(host.now_utc) >= Date.parse(rights.expires_at_utc)
  )
    throw new Error("rights subject/revision/use/territory/time mismatch");
  const provenance = readSemantic({
    store: host.store,
    project_id: host.project_id,
    ref: rights.provenance_ref,
    schema: ProvenanceBindingV1Schema,
    schema_id: "penny.videogen-provenance-binding.v1",
    limits: host.limits,
  });
  if (!sameRef(provenance.subject_ref, subject)) throw new Error("provenance subject mismatch");
  if (rights.derived_from_rights_refs !== undefined) {
    const inherited = rights.derived_from_rights_refs.map((ref) => {
      const row = current.find((r) => sameRef(r.rights_ref, ref));
      if (
        row === undefined ||
        !provenance.source_refs.some((source) => sameRef(source, row.subject_ref))
      )
        throw new Error("derived rights lack exact current source grant");
      return checkRights(host, row.subject_ref, ref, use, visited);
    });
    if (
      inherited.length !== provenance.source_refs.length ||
      inherited.some(
        (parent) =>
          !sameRef(parent.license_ref, rights.license_ref) ||
          rights.allowed_uses.some((allowed) => !parent.allowed_uses.includes(allowed)) ||
          rights.territories.some((territory) => !parent.territories.includes(territory)) ||
          parent.consent_refs.some((ref) => !rights.consent_refs.some((r) => sameRef(r, ref))) ||
          parent.credits.some((credit) => !rights.credits.includes(credit)) ||
          Date.parse(rights.valid_from_utc) < Date.parse(parent.valid_from_utc) ||
          Date.parse(rights.expires_at_utc) > Date.parse(parent.expires_at_utc)
      )
    )
      throw new Error("derived rights cannot widen inherited grants");
  }
  for (const ref of [
    subject,
    rights.license_ref,
    ...rights.consent_refs,
    ...provenance.source_refs,
    provenance.producer_receipt_ref,
  ])
    readExact(host.store, host.project_id, ref, host.limits.max_integer);
  assertAuthorizedOrigin(host, subject, rightsRef, rights.provenance_ref);
  return rights;
}
const RoleSchema = Type.Union([
  Type.Literal("request"),
  Type.Literal("story"),
  Type.Literal("script"),
  Type.Literal("look"),
  Type.Literal("reference"),
  Type.Literal("rights"),
  Type.Literal("voice"),
  Type.Literal("performance"),
  Type.Literal("timing"),
  Type.Literal("board"),
  Type.Literal("route"),
  Type.Literal("draft"),
  Type.Literal("final"),
  Type.Literal("edit"),
  Type.Literal("grade"),
  Type.Literal("mix"),
  Type.Literal("encode"),
  Type.Literal("master"),
  Type.Literal("package"),
  Type.Literal("approval"),
  Type.Literal("review"),
  Type.Literal("child"),
  Type.Literal("effect"),
]);
const ReasonSchema = Type.Union([
  Type.Literal("canon"),
  Type.Literal("reference"),
  Type.Literal("rights"),
  Type.Literal("performance"),
  Type.Literal("timing"),
  Type.Literal("source"),
  Type.Literal("edit"),
  Type.Literal("review"),
  Type.Literal("approval"),
  Type.Literal("parent_child"),
]);
export const DependencyLedgerV1Schema = Type.Object(
  {
    schema_id: Type.Literal("penny.videogen-dependency-ledger.v1"),
    schema_version: Type.Literal(1),
    nodes: Type.Array(
      Type.Object(
        {
          stable_id: Id,
          role: RoleSchema,
          ref: ArtifactRefSchema,
          revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
          approval_ref: Type.Optional(ArtifactRefSchema),
          rights_ref: Type.Optional(ArtifactRefSchema),
          status: Type.Union([
            Type.Literal("current"),
            Type.Literal("stale"),
            Type.Literal("blocked"),
          ]),
        },
        closed
      )
    ),
    edges: Type.Array(Type.Object({ from: Id, to: Id, reason: ReasonSchema }, closed)),
    review_epochs: Type.Array(Type.Object({ target_id: Id, evidence_refs: refs }, closed)),
    invalidations: Type.Array(
      Type.Object(
        {
          reason: Type.String({ minLength: 1 }),
          earliest_producer: Id,
          affected_ids: Type.Array(Id, { minItems: 1, uniqueItems: true }),
        },
        closed
      )
    ),
  },
  closed
);
export type DependencyLedgerV1 = Static<typeof DependencyLedgerV1Schema>;
export function validateDependencyLedger(
  value: unknown,
  limits: FoundationLimitsV1
): DependencyLedgerV1 {
  const v = validateFoundation(DependencyLedgerV1Schema, value, limits);
  assertUnique(
    v.nodes.map((x) => x.stable_id),
    "ledger IDs"
  );
  assertUnique(
    v.nodes.map((x) => x.ref.artifact_id),
    "ledger refs"
  );
  assertUnique(
    v.edges.map((x) => `${x.from}/${x.to}/${x.reason}`),
    "ledger edges"
  );
  assertUnique(
    v.review_epochs.map((x) => x.target_id),
    "review epochs"
  );
  const nodes = new Map(v.nodes.map((x) => [x.stable_id, x]));
  const outgoing = new Map<string, string[]>();
  for (const node of v.nodes) {
    exactRef(node.ref);
    if (node.approval_ref !== undefined) exactRef(node.approval_ref);
    if (node.rights_ref !== undefined) exactRef(node.rights_ref);
  }
  for (const e of v.edges) {
    const from = nodes.get(e.from);
    const to = nodes.get(e.to);
    if (from === undefined || to === undefined || e.from === e.to)
      throw new Error("dangling or self ledger edge");
    if (
      (e.reason === "rights" && from.role !== "rights") ||
      (e.reason === "reference" && !["reference", "look"].includes(from.role)) ||
      (e.reason === "performance" && !["voice", "performance"].includes(from.role)) ||
      (e.reason === "timing" && from.role !== "timing") ||
      (e.reason === "review" && to.role !== "review") ||
      (e.reason === "approval" && to.role !== "approval") ||
      (e.reason === "parent_child" && from.role !== "child" && to.role !== "child")
    )
      throw new Error("invalid typed dependency edge");
    const next = outgoing.get(e.from) ?? [];
    next.push(e.to);
    outgoing.set(e.from, next);
  }
  const indegree = new Map(v.nodes.map((x) => [x.stable_id, 0]));
  for (const e of v.edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  const queue = v.nodes.filter((x) => indegree.get(x.stable_id) === 0).map((x) => x.stable_id);
  let visited = 0;
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (id === undefined) throw new Error("ledger queue corrupt");
    visited++;
    for (const next of outgoing.get(id) ?? []) {
      const n = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, n);
      if (n === 0) queue.push(next);
    }
  }
  if (visited !== v.nodes.length) throw new Error("cyclic ledger");
  for (const epoch of v.review_epochs)
    if (!nodes.has(epoch.target_id) || epoch.evidence_refs.length === 0)
      throw new Error("invalid review epoch");
  for (const invalidation of v.invalidations)
    if (invalidation.affected_ids.some((id) => !nodes.has(id)))
      throw new Error("invalid invalidation IDs");
  return v;
}
export const CurrentDependencyIndexV1Schema = Type.Array(
  Type.Object(
    {
      stable_id: Id,
      ref: ArtifactRefSchema,
      revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    },
    closed
  )
);
export type CurrentDependencyIndexV1 = Static<typeof CurrentDependencyIndexV1Schema>;
/** Pure revision projection. Existing owner persists this and atomically selects its ref later. */
export function invalidateDependencies(input: {
  ledger: unknown;
  current: CurrentDependencyIndexV1;
  revoked_ids: readonly string[];
  reason: string;
  earliest_producer: string;
  limits: FoundationLimitsV1;
}): DependencyLedgerV1 {
  const v = validateDependencyLedger(input.ledger, input.limits);
  const current = validateFoundation(CurrentDependencyIndexV1Schema, input.current, input.limits);
  assertUnique(
    current.map((x) => x.stable_id),
    "current dependency IDs"
  );
  if (
    current.length !== v.nodes.length ||
    current.some((x) => !v.nodes.some((n) => n.stable_id === x.stable_id)) ||
    input.revoked_ids.some((id) => !v.nodes.some((n) => n.stable_id === id))
  )
    throw new Error("current dependency index mismatch");
  const index = new Map(current.map((x) => [x.stable_id, x]));
  const affected = new Set(input.revoked_ids);
  for (const node of v.nodes) {
    const next = index.get(node.stable_id);
    if (next === undefined) throw new Error("missing current revision");
    exactRef(next.ref);
    if (!sameRef(node.ref, next.ref) || node.revision !== next.revision) {
      if (next.revision <= node.revision || sameRef(node.ref, next.ref))
        throw new Error("revision must increase with changed exact identity");
      affected.add(node.stable_id);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of v.edges)
      if (affected.has(e.from) && !affected.has(e.to)) {
        affected.add(e.to);
        changed = true;
      }
  }
  if (affected.size === 0) return v;
  const revokedRefs = new Set(
    v.nodes
      .filter((x) => affected.has(x.stable_id))
      .flatMap((x) => [
        x.ref.artifact_id,
        ...(x.approval_ref === undefined ? [] : [x.approval_ref.artifact_id]),
      ])
  );
  return validateDependencyLedger(
    {
      ...v,
      nodes: v.nodes.map((node) => {
        const next = index.get(node.stable_id);
        if (next === undefined) throw new Error("missing revision");
        if (!affected.has(node.stable_id)) return node;
        const { approval_ref: _revoked, ...rest } = node;
        return {
          ...rest,
          ref: next.ref,
          revision: next.revision,
          status: input.revoked_ids.includes(node.stable_id) ? "blocked" : "stale",
        };
      }),
      review_epochs: v.review_epochs.filter(
        (x) =>
          !affected.has(x.target_id) &&
          !x.evidence_refs.some((ref) => revokedRefs.has(ref.artifact_id))
      ),
      invalidations: [
        ...v.invalidations,
        {
          reason: input.reason,
          earliest_producer: input.earliest_producer,
          affected_ids: v.nodes.filter((x) => affected.has(x.stable_id)).map((x) => x.stable_id),
        },
      ],
    },
    input.limits
  );
}
export function checkLedgerCurrent(
  host: RightsHostV1,
  value: unknown,
  current: CurrentDependencyIndexV1,
  use: RightsUse
): DependencyLedgerV1 {
  const ledger = validateDependencyLedger(value, host.limits);
  const index = validateFoundation(CurrentDependencyIndexV1Schema, current, host.limits);
  assertUnique(
    index.map((x) => x.stable_id),
    "current dependency index"
  );
  if (index.length !== ledger.nodes.length) throw new Error("current index coverage");
  for (const node of ledger.nodes) {
    const selected = index.find((x) => x.stable_id === node.stable_id);
    if (
      node.status !== "current" ||
      selected === undefined ||
      selected.revision !== node.revision ||
      !sameRef(selected.ref, node.ref)
    )
      throw new Error("stale dependency identity/revision");
    readExact(host.store, host.project_id, node.ref, host.limits.max_integer);
    if (node.rights_ref !== undefined) checkRights(host, node.ref, node.rights_ref, use);
    else if (
      ["look", "reference", "voice", "performance", "draft", "final", "master", "package"].includes(
        node.role
      )
    )
      throw new Error("current rights required for used media");
    if (node.approval_ref !== undefined)
      readExact(host.store, host.project_id, node.approval_ref, host.limits.max_json_bytes);
  }
  for (const epoch of ledger.review_epochs)
    for (const ref of epoch.evidence_refs)
      readExact(host.store, host.project_id, ref, host.limits.max_integer);
  return ledger;
}
/** Checkpoint refs only. This is selection bookkeeping, not a persistence or transaction owner. */
export function selectDependencyLedger(context: RunContext, ref: ArtifactRef): void {
  exactRef(ref);
  if (
    ref.run_id !== context.identity.run_id ||
    ref.content_schema?.schema_id !== "penny.videogen-dependency-ledger.v1" ||
    ref.content_schema.schema_version !== 1
  )
    throw new Error("ledger checkpoint ref mismatch");
  context.selectedArtifacts = [
    ...context.selectedArtifacts.filter(
      (x) => x.content_schema?.schema_id !== ref.content_schema?.schema_id
    ),
    ref,
  ];
}
