# Agent Discovery and Exact Tool Surfaces

## Local catalog

Discovery reads the nearest project `.pi/agents/*.md` catalog only. Pi `/reload`
re-registers the provider-visible enum and snapshot. Drift between registration and
execution returns `SUBAGENT_RELOAD_REQUIRED` instead of running stale metadata.

Discovery never queries memory, scans `PATH`, or treats prior execution as presence.

## Binding runtime rule

```text
active model-visible tools == that agent file's YAML tools list
```

- `tools:` is required, non-empty, duplicate-free, case-sensitive, and provider-known.
- Unknown or unregistered names fail before model invocation.
- The runner passes the exact list to Pi.
- Trust profiles, phases, skills, service configuration, and input presence never change
  the set.
- Runtime-injected tools absent from YAML are forbidden.
- All provider extensions load before session creation; unavailable services return typed
  call errors without hiding tools.

`authority:` and `tool_profiles:` express and statically lint the intended list. Their
expansion must equal `tools:` in CI, but they have no runtime narrowing power.

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

Tool visibility is the complete model action surface. Artifact IDs themselves are not
permissions; `artifact_read` performs direct exact manifest lookup, byte verification, and
bounded UTF-8 reads without run/consumer/expiry checks.

## Verification

- [ ] Missing/empty/duplicate/unknown tools fail before spawn.
- [ ] Direct, parallel, chain, SDK-skill, trust-profile, optional-service, and applicable
      private paths assert exact set equality.
- [ ] No `--exclude-tools`, injected result tool, trust strip set, or phase replacement
      matrix applies to a catalog role.
