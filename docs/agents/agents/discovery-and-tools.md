# Agent Discovery and Maximum Tool Authority

## Local catalog

Direct subagent invocation reads the current nearest project `.pi/agents/*.md` catalog
once per tool call. Names use a non-empty string schema and must exist in that fresh catalog;
there is no registration-time enum or whole-catalog drift refusal. Prompt, model, thinking,
and tool changes apply to the next invocation, as do additions and removals. The provider-visible
routing description is a registration-time snapshot; `/reload` refreshes that description but
is not required to execute catalog edits. An already dispatched worker keeps its captured
configuration. Missing names and unavailable YAML tools still refuse before dispatch.

This direct-invocation behavior does not relax orchestration's registration/digest-bound
phase, guidance, tool, or recovery checks. Extension-code changes and compiled orchestration
generations still require their own reload/restart procedure.

Discovery never queries memory, scans `PATH`, or treats prior execution as presence.

## Binding runtime rule

Agent YAML declares the maximum ordinary catalog authority. Runtime selection has only two
forms:

```text
direct / parallel / chain catalog invocation:
  active model-visible tools == agent YAML tools

TypeScript orchestration catalog-worker phase:
  phase allowed_tools absent  => active model-visible tools == agent YAML tools
  phase allowed_tools present => active model-visible tools == that registered strict subset
```

- YAML `tools:` is required, non-empty, duplicate-free, case-sensitive, and provider-known.
- Direct, parallel, and chain invocation always passes the exact YAML list to Pi.
- A TypeScript orchestration `PlaybookRegistration` phase may declare exactly one explicit
  non-empty, duplicate-free strict subset of that phase agent's YAML list. The only empty-subset
  exception is a registration-bound guarded zero-tool provider-opening-guard phase that also
  fixes the exact required model, carries one host-admitted inline payload/disclosure, exposes
  zero tools, and reauthorizes
  the complete serialized opening immediately before provider dispatch. It cannot be selected by
  task, trust, or runtime content.
- The canonical runtime-registration digest includes each phase's subset or explicit absence.
  The worker projects the same value into active invocation metadata. Before session creation,
  the model client re-reads YAML and rejects an empty list, duplicate, non-YAML or unavailable
  name, equality-sized list, addition, replacement, or other non-strict subset; it then passes
  exactly the accepted list to Pi and checks active equality before the model prompt.
- Omission preserves YAML equality. No task content, trust profile, runtime condition, input,
  model, liveness policy, optional service, or other metadata may choose or alter a subset.
- Runtime-injected tools absent from the selected surface are forbidden.
- All provider extensions load before session creation. A backing service that is unavailable
  behind a successfully registered YAML tool returns a typed call error; it does not hide or
  replace the tool.
- Anonymous host-private isolated sessions use their separate typed tool matrices. They are not
  catalog-agent invocations and this exception does not change them.

[Tool Authority Profiles](tool-profiles.md#rules) owns static `authority:` / `tool_profiles:`
expansion and linting of the YAML maximum. A phase subset neither changes that lint nor mutates
agent metadata or profile assignment.

A selected surface limits model-visible calls, not the effects of those calls. Neither exact
YAML nor a subset creates OS/process sandboxing, reduces host permissions, or prevents provider
extension code from loading. Anonymous host-private tool matrices remain a separate path.

## Categories

| Category       | Profiles                                  | Purpose                                                   |
| -------------- | ----------------------------------------- | --------------------------------------------------------- |
| Exact artifact | `artifact`                                | Read any supplied exact immutable ID with bounded ranges. |
| Filesystem     | `filesystem.read/observe/write`           | Read, search, or mutate according to role.                |
| Shell          | `shell.unbounded`                         | Full `bash`; not a sandbox.                               |
| Web            | `web.search`, `web.transcript`            | External evidence.                                        |
| Browser        | `browser.observe/reveal/interact/execute` | Increasing rendered-page authority.                       |
| Generation     | `docgen`                                  | Requested Word/PowerPoint outputs.                        |
| Recall         | `memory.read`                             | Advisory durable recall; never artifact handoff.          |

Tool visibility is the complete model action surface for that session. Artifact IDs themselves
are not permissions; `artifact_read` performs direct exact manifest lookup, byte verification,
and bounded UTF-8 reads without run/consumer/expiry checks.

## Verification

- [ ] Missing, empty, duplicate, or unknown YAML tools fail before spawn.
- [ ] Direct, parallel, and chain paths assert exact YAML set equality.
- [ ] Orchestration phases without `allowed_tools` assert exact YAML equality.
- [ ] An ordinary phase subset is accepted only from the active registration, is
      strict/non-empty/unique, is included in its canonical registration digest and invocation
      metadata, and is passed exactly to Pi; the guarded zero-tool exception additionally proves
      exact required-model, inline-payload/disclosure, and final-opening authorization before dispatch.
- [ ] Added, injected, replaced, unavailable, unguarded-empty, duplicate, equality-sized,
      task-selected, trust-selected, or runtime-selected subset surfaces fail before session creation.
- [ ] Subset-absent registered phases assert exact YAML activation; strict-subset and guarded
      zero-tool paths have separate coverage without claiming OS/process sandboxing or
      extension-code isolation.
- [ ] Host-private isolated tool matrices remain anonymous, separate, and unchanged.
