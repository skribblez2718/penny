# Agent Discovery and Tools — Catalog and runtime exposure

## Local catalog

The project's `.pi/agents/*.md` frontmatter is the sole local agent catalog.
Discovery parses `name`, `description`, `tools`, and model settings from those
files. Pi `/reload` re-registers the model-visible enum and catalog snapshot.
Catalog drift between registration and execution fails with a typed reload
requirement rather than running against stale metadata.

Discovery never queries durable memory, scans `PATH`, or treats prior execution
as proof that an agent exists. Remote harness/service availability belongs to a
separate harness/service registry.

## Tool rules

1. `tools:` frontmatter is the only local declaration.
2. Grant the minimum role tools.
3. Workers declare no `memory_*` tools. Durable recall, curated writes, primary
   diary, and governed temporal KG operations are primary-runtime capabilities.
4. Workers declare `artifact_read` for exact current-run input. The runner
   excludes it when no owner artifact invocation exists and exposes it only with
   the trusted grant environment.
5. Tool names are case-sensitive and must match registered extension tools.

## Categories

| Category       | Examples                                              | Purpose                                                   |
| -------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| Exact artifact | `artifact_read`                                       | Read one granted immutable input with typed continuation. |
| Filesystem     | `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` | Inspect or change in-scope files according to role.       |
| Web            | `web_search`, `web_fetch`, `youtube_transcript`       | Gather external evidence.                                 |
| Browser        | `playwright_*`                                        | Interact with browser-rendered sources or applications.   |
| Generation     | `word_generate`, `powerpoint_generate`                | Create requested document products.                       |

Tool visibility is not artifact authorization. `artifact_read` independently
validates the exact ref, run, consumer, digest, expiry, and continuation cursor;
it has no list, search, guess, or self-grant surface.

## Verification

- [ ] Local agent names and descriptions come from `.pi/agents` only.
- [ ] No `memory_*` tool appears in worker frontmatter.
- [ ] `artifact_read` is present in every worker definition.
- [ ] No remote-presence claim is inferred from the local catalog.
- [ ] Catalog changes require reload before execution.

## Files

| File                                      | Purpose                            |
| ----------------------------------------- | ---------------------------------- |
| `docs/agents/agents/definition-format.md` | Catalog entry format               |
| `.pi/extensions/subagent/agents.ts`       | Discovery and catalog snapshot     |
| `.pi/extensions/subagent/agent-runner.ts` | Tool exposure and worker process   |
| `.pi/extensions/artifacts/README.md`      | Exact artifact grant/read contract |
