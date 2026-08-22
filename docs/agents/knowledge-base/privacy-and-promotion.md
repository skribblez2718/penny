# Privacy and Promotion

## The authority split

A model may **name** an opaque ID it has been granted. It may never **supply** a filesystem root,
source path or locator, canonical root or target, provider choice, approval decision, or receipt
body. Every one of those is host-owned, resolved out of band, and validated before use.

| Host owns                                                                | Model may reference               |
| ------------------------------------------------------------------------ | --------------------------------- |
| Profile registry mapping profile → KB root                               | `kb_profile_id`                   |
| Source capability envelopes (path, digest, metadata)                     | `source_capability_ids`           |
| Canonical-target capability envelopes (target, authority root, preimage) | `canonical_target_capability_ids` |
| Processing policy, parent/child model allowlists                         | nothing                           |
| Content-review and promotion approval decisions                          | nothing                           |

Complete envelopes, leases, and source-admission metadata live only in the owner-only
`$PROJECT_ROOT/.penny/kb-capabilities/capabilities.sqlite` store, never under a KB root. Source
admission allocates an independent opaque `source_id`, preindexes exact work keys, then performs one
no-follow external open and streams/hash-checks the bytes into
`work/<run_id>/transaction/sources/<source_id>`. Child, refinement, and content-review reads use
that immutable snapshot; source objects and records enter the publication tree only after approval.

### Profiles

The profile registry is an ignored, owner-only host file. Neither its path nor its content is a
model-visible argument. Each profile maps an opaque ID to an absolute root plus a repository
admission mode and a create flag.

A request is admitted only when its profile is **both** granted in the current authenticated host
session **and** present in the registry. Creation additionally requires the profile's create flag.

Profile-session and parent-delivery grants share one ignored owner-only authority at
`$PROJECT_ROOT/.penny/kb-host-grants/grants.sqlite`. It is a WAL database with
`synchronous=FULL`; the directory is exactly `0700`, and the database/WAL/SHM files are exactly
`0600`, regular, single-link, and current-user-owned. Separate indexed tables are one authority,
not fallback stores. Unexpected JSON, temporary files, retired `profile-grants/` directories, or
any other fragment block the authority: the host never scans, adopts, or merges them.

A profile grant binds one exact session/profile and is reusable only while available and
unexpired. At most one available grant may exist for that pair. Every model-visible KB call records
one immutable use bound transactionally to the exact host invocation ID, action, closed-request
digest, and observed policy digest (or exact policy absence for create-init). Exact retries observe
the same use; a competing binding loses. Revocation and expiry are irreversible CAS transitions.
A parent-delivery grant additionally binds the exact request, current policy digest, and runtime
provider/model; it remains exact single-use by one delivered run.

Every action against an existing KB, and every resume, re-resolves the registry, normalizes and
realpaths the root, verifies repository admission, reads the static manifest, and compares the
expected KB identity. **The orchestration database never caches the root** — it stores the profile
ID only. That is what makes a changed working directory, environment, or registry remap unable to
redirect a run: identity is re-derived, not remembered.

### Repository admission is default-deny

A root outside any Git worktree is the normal case. A root _inside_ a worktree is admitted only as
the exact allowlisted scaffold, and only when every live path is untracked and ignored, no
containing or nested repository or worktree changes containment, and no component is a symlink or
special file. Otherwise the operation fails **before** session creation or any filesystem mutation.

`.gitignore` is one layer, not the control. A force-added live file, a non-ignored live path, a
nested repository, or a symlinked component fails admission even though Git would have ignored it.

### Custody is explicit, not ambient

Private custody does not rely on the process umask. Outside-worktree roots and every live descendant
directory are owner-only `0700`; every live file — manifest, policy, source object and record, page
and claims, conflict, work, temp, preimage, catalog, index, selector, lock, and root index — is a
current-user-owned, regular, no-follow, mode-`0600`, single-link file created with an explicit mode.
The one root exception is the exact already-admitted public scaffold: its descriptor may retain
current-user-owned public read/execute bits such as `0755`, but group/other write is always refused.
All live directories beneath that root remain exactly `0700`. Staging and atomic rename preserve
owner and mode. Every KB read walks contained directories through pinned `O_NOFOLLOW` descriptors,
reads the mode-`0600`, current-user-owned, regular, single-link leaf from its descriptor, and
revalidates stable identity and any known digest before releasing bytes. It never pairs a pathname
`lstat` with a later pathname read. Platforms that cannot provide equivalent guarantees fail closed.

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

Each run and host-grant invocation use binds the digest of the policy it was admitted under. Every
child creation, gate, publish step, status, and resume rechecks exact equality; a mid-run policy
change returns a clear `policy_changed` and requires a new run. It never rewrites or invalidates an
already-selected generation.

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

## Content-review authentication

Ingest/save approval is a host callback, not a generic engine response. The canonical packet and
complete decision receipt live beside the run in the owner-only orchestration control DB, never in
a model request or a KB-root JSON decision file. The local CLI authenticates as the effective OS
user and calls the same host facade an eventual UI would use. Receipt fields are copied from the
stored packet rather than supplied piecemeal by the caller, and duplicate callbacks succeed only
for the exact stored receipt digest.

Callback admission re-resolves the session-granted profile and rechecks KB identity, policy,
selector/generation, candidate handles and digests, source-record map, save query binding, and
conflict allocations. Expiry or drift invalidates before publication. Restart reconciliation uses
the stored receipt; no model-visible `resume` or `respond` can manufacture a decision.

This is separate from promotion approval. Promotion uses its own owner-only approval DB,
signed receipts, apply journal, keyring, and host callback. Content-review receipts cannot be
used as promotion authority.

## Promotion

**Promotion is an authority transition, not a KB write.** The public `promote` action only
prepares: it re-reads current canonical sources, verifies advisory claims, resolves exact target
capabilities, captures current preimages, and returns an `awaiting_user` gate packet. The packet is
not authority.

The prepare flow is two advisory agent phases plus the host's own verification. Piper produces a
`promotion_plan` and Skribble a scoped `promotion_patch`, both over the §5.8 reader posture — they
see claimed targets through a host-closed reader, never a path. Then the **host itself** verifies:
every target capability is re-resolved and required to be a `canonical_target` carrying the
`promote` operation, each target's current bytes are hashed into a **preimage digest**, and every
named page revision must be the one the selected generation actually selects. That finding is
sealed into the packet as the third handle beside the plan and the patch.

A failed check is a bounded finding with `verified: false`, not an error. An honest "this cannot be
promoted as stated" is a legitimate result of preparing, and the packet is still returned — it
still applies nothing.

The machine has **no publishing edge for promote**, and approving a promote gate through the public
path is refused outright: apply requires the host-only signed approval path below.

Everything after that is host-only:

- The **host approval service** — not a model, tool argument, or prompt — obtains the human's exact
  approve, refine, or deny response. There is no public approve or apply action, and ordinary
  `resume` carries no decision.
- The approval UI renders target scope **only** from stored presentation records. Added, removed,
  reordered, relabeled, or remapped targets fail.
- An approval receipt is strict closed UTF-8 JSON canonicalized with RFC 8785/JCS. HMAC-SHA-256
  covers the receipt JCS with only `signature` omitted, and the signature is exactly 43 unpadded
  base64url characters. It is single-use, expiring, and bound to the exact run, session,
  challenge, profile, KB, packet digest, page revisions, ordered target capabilities, canonical
  target presentations, preimages, patch digest, postimages, and verification evidence.
- Apply happens under a host mutex through an **apply journal**: capture and fsync every preimage
  first, reserve all authorities all-or-none immediately before the first mutation, then replace
  each target through the Linux no-clobber protocol below, fsync the parent, and re-open to verify
  both the postimage hash and complete required mode bits.
- On failure, targets are restored in reverse order. A saved preimage is re-opened no-follow and
  custody/hash-checked immediately before use; every restored target is then re-opened and its
  preimage hash and mode are verified before the run is reported failed.
- On restart, the journal owner classifies each target by **current bytes**: equal to preimage means
  unwritten, equal to postimage means written, and any third value is external drift — which is
  never overwritten and terminally invalidates the claim.

Apply never creates a previously absent logical target, leaves no target deleted at settlement,
and **never commits or pushes**. Success means verified postimages; failure means exact owned
preimages restored, or a safe block. It cannot report success until every postimage and the
verification pass agree.

#### Linux/Node atomic-primitive limit

Node exposes neither `openat2(RESOLVE_NO_SYMLINKS)` nor
`renameat2(RENAME_NOREPLACE)`/an inode-conditioned rename compare-and-swap. Live promotion
therefore fails closed off Linux and resolves every parent component relative to pinned
`/proc/self/fd` directory descriptors with `O_NOFOLLOW`. Replacement does **not** use ordinary
rename-over-target, because that could overwrite drift arriving after the last check. Instead it
moves the current name into a fresh owner-only same-filesystem staging directory, verifies the
bytes and complete mode that were actually moved, then installs the staged inode with no-clobber
`link(2)` and immediately drops the staging link. If another process recreates the target name,
installation fails without overwriting it.

This is the safest primitive available through Linux Node, but it is honestly **not one atomic
replacement syscall**: the canonical name can be briefly absent, and the installed inode has a
second hard link for the short interval between `link` and staging unlink. The journal/hash recovery
protocol handles process crashes around the operation; deployments requiring a linearizable
single-syscall compare-and-swap need a native `renameat2`/filesystem transaction boundary that Node
does not currently expose.

### Approval custody and host commands

The packet is committed to ignored `$PROJECT_ROOT/.penny/kb-approval/receipts.sqlite` **before**
the orchestration control DB may expose `awaiting_user`. Only packet digests and safe IDs cross into
control state; target presentations, intent, receipt bytes, and journal bytes remain in the approval
DB. Approve, refine, and deny each begin with one durable exact decision-intent JCS. Only approve
creates a signed receipt. A callback retry is idempotent only for the same intent digest.

The `.penny` ancestor and approval directory are current-user-owned mode `0700`; every absolute
ancestor is opened one component at a time and may not be a symlink. SQLite/WAL/SHM, mutex, and key
files are current-user-owned, regular, single-link, mode `0600`, opened no-follow, and their pinned
identity/custody is rechecked throughout the store lifetime. Each key file is exactly 32 raw CSPRNG
bytes. Exactly one key is active for signing; rotation first creates and fsyncs a new key, then
marks prior keys verification-only. Existing receipts are never re-signed, and verification-only
keys remain available for nonterminal work.

`penny-kb-gate promotion-list`, `promotion-key-rotate`, `promotion-approve`,
`promotion-refine`, `promotion-deny`, and `promotion-apply` are authenticated local-host commands.
They are not `knowledge_base` actions. `promotion-apply` accepts a run ID, not caller-supplied
receipt fields; it reads the exact stored signed receipt and invokes the private internal resume.

The signed receipt must byte/value-match every field derived from the durable approve intent:
deterministic receipt ID, reviewer identity, nonce, issuance, expiry, challenge/packet digest, and
the complete packet scope. A valid HMAC cannot legitimize a changed value. Before canonical
mutation, the approval store also requires the orchestration control DB's exact approved
intent/receipt ID/digest binding.

Receipt reservation, the complete target-capability reservation, and journal transition occur
under the owner-only host apply mutex. Journal and receipt terminalize in one approval-DB
transaction. Cross-store order is fixed: approval DB terminal first, capability-store
consume/invalidate second, orchestration terminal last. Recovery repairs exact transaction-owned
splits at every boundary, including expiry/drift terminalized before any journal exists. A restart
with an already terminal journal is finalize-only for that transaction; it never repeats a target
write.
