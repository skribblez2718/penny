# Agent Discovery and Maximum Tool Authority

## Local catalog

Discovery reads the nearest project `.pi/agents/*.md` catalog only. Pi `/reload`
re-registers the provider-visible enum and snapshot. Drift between registration and
execution returns `SUBAGENT_RELOAD_REQUIRED` instead of running stale metadata.

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
- A TypeScript orchestration `PlaybookRegistrationV1` phase may declare exactly one explicit
  non-empty, duplicate-free strict subset of that phase agent's YAML list. It is the only
  ordinary catalog narrowing exception.
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

`authority:` and `tool_profiles:` express and statically lint the YAML maximum. Their
expansion must equal `tools:` in CI. A phase subset neither changes that lint nor mutates
agent metadata or profile assignment.

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
- [ ] A phase subset is accepted only from the active registration, is strict/non-empty/unique,
      is included in its canonical registration digest and invocation metadata, and is passed
      exactly to Pi.
- [ ] Added, injected, replaced, unavailable, empty, duplicate, equality-sized, task-selected,
      trust-selected, or runtime-selected subset surfaces fail before session creation.
- [ ] Ordinary candidate phases omit `allowed_tools` and assert exact YAML activation; synthetic
      or evaluation-only strict-subset sessions remain separately covered without claiming
      OS/process sandboxing or extension-code isolation.
- [ ] Host-private isolated tool matrices remain anonymous, separate, and unchanged.
