# Privacy and Promotion

## The authority split

A model may **name** an opaque ID it has been granted. It may never **supply** a filesystem root,
source path or locator, canonical root or target, provider choice, approval decision, or receipt
body. Every one of those is host-owned, resolved out of band, and validated before use.

| Host owns | Model may reference |
|---|---|
| Profile registry mapping profile → KB root | `kb_profile_id` |
| Source capability envelopes (path, digest, metadata) | `source_capability_ids` |
| Canonical-target capability envelopes (target, authority root, preimage) | `canonical_target_capability_ids` |
| Processing policy, parent/child model allowlists | nothing |
| Content-review and promotion approval decisions | nothing |

### Profiles

The profile registry is an ignored, owner-only host file. Neither its path nor its content is a
model-visible argument. Each profile maps an opaque ID to an absolute root plus a repository
admission mode and a create flag.

A request is admitted only when its profile is **both** granted in the current authenticated host
session **and** present in the registry. Creation additionally requires the profile's create flag.

Every action against an existing KB, and every resume, re-resolves the registry, normalizes and
realpaths the root, verifies repository admission, reads the static manifest, and compares the
expected KB identity. **The orchestration database never caches the root** — it stores the profile
ID only. That is what makes a changed working directory, environment, or registry remap unable to
redirect a run: identity is re-derived, not remembered.

### Repository admission is default-deny

A root outside any Git worktree is the normal case. A root *inside* a worktree is admitted only as
the exact allowlisted scaffold, and only when every live path is untracked and ignored, no
containing or nested repository or worktree changes containment, and no component is a symlink or
special file. Otherwise the operation fails **before** session creation or any filesystem mutation.

`.gitignore` is one layer, not the control. A force-added live file, a non-ignored live path, a
nested repository, or a symlinked component fails admission even though Git would have ignored it.

### Custody is explicit, not ambient

Private custody does not rely on the process umask. Live directories are owner-only `0700`; every
live file — manifest, policy, source object and record, page and claims, conflict, work, temp,
preimage, catalog, index, selector, lock, and root index — is a current-user-owned, regular,
no-follow, mode-`0600` file created with an explicit mode. Staging and atomic rename preserve owner
and mode, and **every open revalidates** owner, type, mode, and containment rather than trusting the
check made when the file was created. Platforms that cannot provide equivalent guarantees fail
closed.

## Policy and the deny-before-session rule

The ignored static policy fixes the processing mode, the allowed parent and child models, parent
result limits, artifact limits, and reader limits. The generated default is **fully closed**:
local-only, both model lists empty, parent delivery denied. Empty lists deny, so a freshly created
KB cannot process private content until an operator edits the ignored file out of band.

Enforcement is **ordered**, and the order is the guarantee:

```text
resolve host session and profile grant
  → validate root and repository admission
    → read and validate only manifest/policy metadata
      → verify the current parent provider/model tuple
        → select and verify every child provider/model tuple
          → only then read any private body or create any child session
```

A denial therefore happens before a body is read and before a session exists. Tests assert that
session creation and private-body reads have call count **zero** on the denial paths — a check that
would be meaningless if the guard ran after the read.

Provider and model identity is the exact normalized tuple reported by the runtime. It is never
inferred from a model name.

Each run binds the digest of the policy it was admitted under. Every child creation, gate, publish
step, status, and resume rechecks exact equality; a mid-run policy change returns a clear
`policy_changed` and requires a new run. It never rewrites or invalidates an already-selected
generation.

## Copy surfaces

Git ignore is not a general privacy control, because a private body can escape through paths Git
never sees. These surfaces are **independent**, and a pass on one proves nothing about another:

1. Git tracked tree and archive
2. Package dry-run contents
3. Adapter and app logs and errors
4. Observability and parent tool details
5. Orchestration SQLite
6. Child sessions, JSONL, and snapshots
7. MemPalace transport and skill rooms
8. Test snapshots and failure output
9. Temporary retrieval, promotion, and evaluation artifacts
10. Profile, capability, grant, input, receipt, review, approval, and plan-gate stores
11. Persisted parent tool results

Every success **and failure** path is seeded independently with unique sentinels. Failure paths
matter most: error text and test output are where private content most often escapes.

## Promotion

**Promotion is an authority transition, not a KB write.** The public `promote` action only
prepares: it re-reads current canonical sources, verifies advisory claims, resolves exact target
capabilities, captures current preimages, and returns an `awaiting_user` gate packet. The packet is
not authority.

Everything after that is host-only:

- The **host approval service** — not a model, tool argument, or prompt — obtains the human's exact
  approve, refine, or deny response. There is no public approve or apply action, and ordinary
  `resume` carries no decision.
- The approval UI renders target scope **only** from stored presentation records. Added, removed,
  reordered, relabeled, or remapped targets fail.
- An approval receipt is canonicalized, MAC-signed with a host key, single-use, expiring, and bound
  to the exact run, session, challenge, profile, KB, packet digest, page revisions, targets,
  preimages, patch digest, and verification evidence.
- Apply happens under a host mutex through an **apply journal**: capture and fsync every preimage
  first, reserve all authorities all-or-none immediately before the first mutation, then for each
  target write a mode-preserving temporary file, fsync, atomically rename, fsync the parent, and
  re-open to hash-verify.
- On failure, targets are restored in reverse order and every restored preimage is re-opened and
  hash-verified before the run is reported failed.
- On restart, the journal owner classifies each target by **current bytes**: equal to preimage means
  unwritten, equal to postimage means written, and any third value is external drift — which is
  never overwritten and terminally invalidates the claim.

Apply never creates or deletes a target, and **never commits or pushes**. Success means verified
postimages; failure means exact owned preimages restored, or a safe block. It cannot report success
until every postimage and the verification pass agree.
