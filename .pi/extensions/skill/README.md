# Skill Invocation Extension

Drives durable TypeScript playbooks through `@penny/orchestration`.

## Architecture

```text
Penny → skill tool → TypeScript OrchestrationService
  → closed start/recover/respond request
  → Pi SDK worker(s) with exact input refs
  → TypeScript ArtifactStore persists complete output
  → signed owner receipt and routing result
  → checkpointed transition
  → terminal, clarification, or dispatch-pause boundary
```

No Python process, per-skill executable delegate, or legacy checkpoint conversion exists.

## Modes

- **Single:** one registered `ingress:skill` workflow.
- **Parallel:** independent TypeScript runs with bounded concurrency.
- **Chain:** sequential TypeScript runs with exact terminal-artifact handoff.
- **Resume:** reloads the durable owner-only chain checkpoint and resumes the failed step.

## Progress rendering

The shared `OrchestrationRunner` emits content-free phase-start, worker-completion/failure, and
boundary events projected from directives and admitted worker results. The extension converts every
event into a structured Pi partial result, so new registered playbooks inherit progress without
playbook-specific UI code. Single runs show the current state and agent, parallel mode shows one
bounded aggregate across active skills, and chain/resume mode includes the current step. The renderer
also preserves text-only partial updates rather than replacing them with `No result`.

For chain handoff, the owner verifies and forwards the prior terminal artifact ID directly;
cross-run reads require no target-run copy. `{previous}` becomes a bounded instruction
identifying that ID, never payload text. Additional explicit IDs may be supplied for
multi-source fan-in. Schema-v3 chain checkpoints retain exact terminal/handoff refs plus every step's canonical
`sha256(canonicalJson(SkillContractV2))` across restart. Legacy checkpoints without an immutable
contract digest fail closed on resume. A generic failure stops with exact refs and `resumable:true`;
it does not manufacture an approve-retry/skip/diagnose questionnaire. Genuine playbook clarification
still surfaces the registration's `await_user` questions.

## Native clarification UI continuations

The existing `await_user` route can select a compiled provider from `playbook-ui.ts`.
It retains the ordinary orchestration service only for that native interaction;
workflow truth stays in the existing checkpoint. Providers are fixed machine
interfaces, not keyword routers, model tools or skill runtimes. Ordinary waits and
noninteractive/untrusted contexts keep their existing clarification behavior.

The registered video provider handles only the final-playback clarification. It
asks the actual user for closed exact-file/device inputs through `questionnaire`,
then returns a read-only viewer URL and new one-time capability from native tool
completion. The actual review UI signs and submits directly to the retained owner;
a positive complete AV attestation uses the existing playback-capture API. Negative
or cancelled input stays blocked. Original clarification and G5 decisions remain
separate. No Bash subprocess can sign for this Pi realm. See the
[operator procedure](../../../apps/orchestration/VIDEOGEN-HUMAN-REVIEW.md).

Concurrent continuation is refused while the UI owns a run. Completion, cancellation,
expiry, reload and session shutdown release the service/viewer and revoke capabilities.
No retained closure or old event is reconstructed on restart. Same-process trusted
code is not an isolation boundary or proof of human viewing.

## Terminal evidence presentation

For new negative terminals carrying `seal_diagnostics`, the tool displays a bounded deterministic-seal
reason, correction use/limit, the exact diagnostic ID and rejected draft ID. It does not open or copy
the diagnostic body or consult memory. A rejected draft is **not** an accepted product: the legacy
`output_artifact_ref` may still point to that draft, but its label and the structured `output_kind`
identify it as rejected. When the same-run epoch has no prior sealed product, the display says so;
when it does, the epoch anchor is labeled as a prior accepted product. A best partial is not a
successful chain handoff. Semantic `repair_diagnostics` are shown separately, with their feedback
report IDs. Single, parallel, chain, and resumed failures retain their exact terminal refs and
negative status; completed steps alone can feed the next chain step.

Historical terminal records and their bytes are unchanged. Older results without a seal projection
remain labeled as best partials without a new acceptance claim. An incompatible saved registration
cannot be repaired by editing its checkpoint; start a new run from explicit inputs instead.

## Catalog visibility and entrypoints

Pi's native `<available_skills>` system section is the sole model-facing catalog of skill names, YAML descriptions, and locations. The `skill` tool describes orchestration mechanics without repeating those catalog rows. At prompt assembly, this extension replaces Pi's generic read-to-load sentence with a directive to invoke each matching skill's registered entrypoint and reserve `read` for documentation inspection.

The generic engine workflow entrypoint is `skill`; registrations own their ingress, closed start
admission, liveness/thinking, worker opening/guidance, phase schemas, and model policy. The
knowledge-base profile remains `dedicated_tool` and deliberately exposes its separate typed
`knowledge_base` entrypoint. The extension registers both tools, and unit coverage rejects registration drift.

## Registered skill resolution

`$PROJECT_ROOT/.pi/skills/<name>/` is the only active package root. The extension discovers that root
once and validates model-invocable orchestration packages against the sole `PLAYBOOK_REGISTRY`.
Directory location does not grant execution authority. Pi loads both visibility classes from the
normal package root on startup and `/reload`. Visible packages omit `disable-model-invocation`
and are advertised in Pi's model catalog and Penny's listing for user or model invocation. Hidden
packages declare `disable-model-invocation: true`; they remain loaded for manual
`/skill:<name> <description>` invocation but are omitted from automatic model advertising.
Redundant `false` and other flag values are invalid. No additional resource hook, manual
`--skill` flag, alias, parser or per-skill executor is needed. The native command expands the
manifest; normal parent-model dispatch to its registered entrypoint remains required. Neither
command loading nor visibility grants private activation, start admission or gate approval.

The SCA package is active, model-visible, and bound to its registered playbook. Generic invocation refuses an unregistered package regardless of visibility, and dedicated-tool registrations retain their separate entrypoint. Typed refusals are `SKILL_NOT_REGISTERED`, `SKILL_ENTRYPOINT_MISMATCH`, and `SKILL_PACKAGE_INVALID`.

## Model policy

Production worker models come from `.pi/agents/<agent>.md` frontmatter. `model` is an
optional per-invocation override applied to every worker in that run, primarily for tests.
It does not mutate production frontmatter. A step-level chain/parallel override is scoped
to that step.

## Artifact communication and tool authority

- Inputs are unique exact artifact IDs/refs from any run. Before `RunContext` creation, generic
  composition re-reads each manifest ref, resolves exactly one compatible source/kind/schema/version
  port, enforces cardinality, and runs registered semantic exact-byte validators.
- Exact finalized output bytes are persisted and immediately re-read before routing fields
  are parsed or a successful result is returned.
- A successful terminal `image/png` output is revalidated as canonical and returned as bounded
  identity metadata plus one Pi image block. The structured skill result remains byte-free details;
  no local path or base64 text is exposed.
- Receipts bind run, state, branch, agent, attempt, trust posture, invocation digest,
  output digest, and canonical artifact ref.
- Run context stores selected refs, not payload bytes. Memory is never workflow transport.
- Agent YAML `tools:` is the maximum ordinary catalog authority. Direct/parallel/chain paths
  and orchestration phases without `allowed_tools` activate it exactly. An eligible TypeScript
  phase may use one explicit non-empty duplicate-free strict YAML subset held by the active
  `PlaybookRegistration`; the canonical runtime-registration digest and worker invocation
  metadata bind that exact list. Empty, duplicate, equality-sized, or non-YAML declarations
  fail before session creation; Pi receives the accepted list exactly, and active removal,
  addition, or replacement fails equality before the model prompt. Task, trust profile, input, runtime condition,
  model/liveness policy, and optional-service state cannot select tools.
- The seven ordinary phases (Assess, Decide, Define, Diagnose, Plan, Produce and Research)
  omit `allowed_tools`, so runtime activates each assigned catalog agent's exact YAML list.
  New runs use renewable progress/inactivity leases, not invented step, model-turn, call,
  repair-session or correction-count allowances. Explicit operator policy still applies;
  retained historical policies remain exact replay inputs. Routing-only repair cannot gain
  tool authority from its liveness policy. The generic fixed strict-subset mechanism remains
  covered by synthetic registration tests.
- A phase subset does not mutate agent YAML/profiles and is not OS/process sandboxing or
  extension-code isolation. Every provider extension still loads before session creation.
  Optional-service absence behind a selected registered tool is a typed call error, not
  conditional omission.
- Standard catalog workers return complete assistant output plus their closed `SUMMARY`
  line. Owner code parses routing only from persisted bytes; no injected
  `submit_orchestration_result` tool exists.
- KB's host-tool-matrix session is explicitly anonymous and does not load or claim a
  catalog role. It remains separate from both exact-YAML and registered strict-subset catalog
  sessions.

## Recovery

`PENNY_ARTIFACT_DISPATCH_MODE` is parsed once by the TypeScript execution owner. Unset and
exact `active` permit dispatch; only exact `paused` pauses it. Blank, padded, case-varied,
and unknown values are invalid and fail closed as paused. While paused or invalid, the
engine does not dispatch workers, tools, child workflows, or parallel branches; `status`
and `cancel` remain available.

Current-engine pause results carry versioned facts for the exact run, session, state,
dispatch setting, observed checkpoint existence, and resumability. Recovery is intentionally
three-way: activate then recover only a current-storage-validated resumable checkpoint;
activate then retry a start that has no resumable checkpoint (whether or not an admission row
exists); or use status/cancel for a saved-but-ineligible checkpoint. Historical pause records
are compatibility-only: their immutable `checkpoint_preserved` value remains an explicitly
unverified legacy claim, never current checkpoint existence or resumability, and the renderer
provides status/cancel guidance only. `LEGACY_UNMETERED` remains a typed ineligibility reason
because adding liveness authority retroactively is forbidden.

The TypeScript database is the current opaque project partition's unversioned
`orchestration/orchestration.db` below `${PENNY_STATE_ROOT:-<Pi getAgentDir()>/penny}`.
Existing runs remain owner-sticky by `run_id`; retired Python checkpoints are archived
outside the runtime and are never a fallback. Chain checkpoints use the same project
partition and include its opaque project ID.

## KB host-grant authority

Profile-session and parent-delivery grants share one owner-only WAL/FULL database in the current
opaque project's catalog-bound `kb/host-grants` partition. There is no project-local, JSON, or
secondary-directory fallback. Unexpected legacy fragments block the authority rather than being
scanned or adopted.

`penny-kb-gate profile-grant-mint|list|revoke|expire` manages reusable, expiring exact
session/profile grants. Each adapter call consumes an immutable use bound to Pi's exact tool-call
ID, action, request digest, and observed policy digest. Parent delivery additionally uses
`parent-grant-mint|list|revoke|expire`; mint requires the exact invocation ID, provider, model, and
query request, and the resulting grant remains exact single-use by one delivered run.

## Parameters

| Parameter            | Scope       | Description                                                                                                                                                                                                                           |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skill_name`, `goal` | single      | Registered skill and objective                                                                                                                                                                                                        |
| `session_id`         | single      | Optional stable run identity                                                                                                                                                                                                          |
| `constraints`        | all         | Registered invocation; Define/Plan V2 requires explicit `specification_assurance` in `{schema_version:2,request:<native V1 constraints>,specification_assurance:"reviewed_definition"\|"semantic_only"}`. Legacy V1 is semantic-only. |
| `input_artifacts`    | single/step | Unique exact IDs from any run; verified before start                                                                                                                                                                                  |
| `model`              | single/step | Test/caller worker-model override                                                                                                                                                                                                     |
| `skills`             | parallel    | Up to three independent skill steps                                                                                                                                                                                                   |
| `chain`              | chain       | Up to ten sequential steps                                                                                                                                                                                                            |
| `resume_chain`       | resume      | Durable chain checkpoint ID                                                                                                                                                                                                           |
| `step_overrides`     | resume      | Goal/constraint changes for the failed step only; V2 policy is retained unless explicitly changed, in which case a started run refuses changed operands.                                                                              |

A Plan step can consume `{previous}` only as the prior terminal's exact `SpecificationV1` artifact ID. Explicit `input_artifacts` can add other exact inputs. Neither the slot name, chain order, nor producer string upgrades V1 to reviewed assurance. A strict V2 invocation verifies the Define producer's completed review graph before a consumer run; refusal cannot retry as semantic-only. Results show the _input_ assurance mode and its exact record ID, not certification of the strategy, revised specification, or any ancestor beyond the verified immediate revision closure.

## Testing

```bash
bun run --cwd .pi/extensions/skill test:unit
bun run --cwd .pi/extensions/skill test:integration
bun run --cwd .pi/extensions/skill test:e2e
bun run --cwd apps/orchestration test
```

The unit suite proves every skill mode is TypeScript-only, forwards structured progress in single,
parallel, chain, and resume modes, and never falls back to a Python child. Shared-runner tests verify
phase/worker/boundary events independently of the UI. Integration tests verify discovery through
`SKILL.md` plus the TypeScript playbook registry, including the installed default extension
loader, duplicate discovery and reload without skill-path flags. The videogen native-command
E2E retains the real parent AgentSession prompt/tool loop with provider-free scripted cognition
and the real engine through durable G1, private-manifest refusal and same-run reopen. It is
command-path conformance, not live-model, film or all-route qualification. The disposable project
uses ordinary worker resource composition, not an alternate tool executor or skill-path override.

## NONBINDING exact context

All seven ordinary skills can consume any current accepted terminal product from those skills
as **context**, separately from their native request and typed artifact inputs. Supply exact IDs;
do not copy the product body into the goal or retype it into another product.

| Tool field                                              | Meaning                                                                                                                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `input_artifacts: string[]`                             | Existing native typed-input path. Its port, cardinality, semantic and assurance rules are unchanged. It does not by itself verify source claims or grant action authority.                                                     |
| `context_artifacts: string[]`                           | Exact accepted current terminal products used only as NONBINDING context. Available in single mode and on each parallel/chain step.                                                                                            |
| `previous_artifact_designation: "context" \| "binding"` | Chain-step designation for the automatic predecessor. Omission means the existing native `binding` path. Select `context` explicitly for arbitrary contextual chains, including Plan → Produce. No type-based fallback occurs. |

Each consumer still needs its own complete native request. A Strategy is not a Produce brief;
a contextual Specification cannot become Define's revision subject, a Plan source index, verified
evidence, reviewed-definition assurance, approval, or permission to use tools or perform effects.
The same ID cannot be selected as both native input and context. Parallel branches receive only
their own explicit inputs; sibling results are never imported automatically.

For example, with caller-supplied native constraints and an exact accepted `strategyId`:

```javascript
skill({
  skill_name: "produce",
  goal: "Create the requested artifact, considering the earlier strategy.",
  constraints: produceConstraints,
  context_artifacts: [strategyId],
});

skill({
  chain: [
    { skill_name: "plan", goal: "Develop the strategy.", constraints: planConstraints },
    {
      skill_name: "produce",
      goal: "Consider {previous} while fulfilling this independent artifact brief.",
      constraints: produceConstraints,
      previous_artifact_designation: "context",
    },
  ],
});
```

Explicit cross-run fan-in uses several `context_artifacts` IDs. For parallel mode, put the field
inside the relevant `skills[]` entry, not at the top level. `resume_chain` reuses checkpointed IDs
and designations; it does not accept replacement contextual inputs. A single-run recovery must
repeat the original input IDs and their native/context choices. The owner restores its original
slot labels after comparing exact refs and designations. Contextual clarification continuations
carry those IDs explicitly.

### Runtime interface and custody

The engine's schema-v2 `InputArtifacts.artifacts[]` adds optional
`designation: "binding" | "context"`; omission preserves native semantics. Context support is an
explicit registration capability (`contextual_inputs: "accepted_terminal_products_v1"`), included
in the runtime-registration digest. Other registrations remain default-deny.

Admission verifies the exact manifest ref, complete bytes, canonical semantic validator, current
producer registration, accepted terminal identity and current owner completion predicates/envelope.
A canonical but unaccepted product, draft, envelope substitution, missing owner proof, corrupt bytes
or unsupported registration refuses before consumer creation. Native `semantic_only` and strict
`reviewed_definition` admission retain their existing distinct guarantees; context never supplies or
downgrades either.

`RunContext.admitted_input_artifacts` retains compact original bindings, never payload bodies.
Native selectors and materializers receive only native inputs. The shared checkpoint boundary
attaches context refs and NONBINDING/full-read instructions to every worker assignment, including
routing correction and parallel branches. These exact instructions and designated inputs are
covered by signed invocation custody and remain available after restart. Native output/review
upstreams stay separate: context does not change the reviewed subject or native source lineage.
Needed context must be read completely with `artifact_read` through every `next_range`; absent refs
require `missing_input:`, not discovery through memory, temporary files or historical sessions.
These labels do not create a sandbox or change the registered/catalog tool surface.

This is an additive wire field but changes ordinary runtime-registration digests. Old checkpoints
bound to the previous runtime may refuse; no retained-state migration or deletion is performed.
Build with stopped workers and start a fresh process before using the shipping interface.

### Evidence boundary

`universal-context.test.ts` covers all 49 ordered pairs using products accepted through actual
native engine owners, plus refusal, full-phase delivery and recovery cases.
`universal-context.integration.test.ts` exercises the public tool's contextual Plan → Produce,
single/parallel fan-in and interrupted chain-resume paths with scripted cognition. These are
provider-free admission/custody/lifecycle checks, **not** 49 substantive content-use or live-model
qualification results. Production-model use, adversarial instruction-following and repeatability
remain separate evidence obligations. No live baseline is implied.
