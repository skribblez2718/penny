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

Tools are granted through **named authority profiles**, not tool-by-tool. An agent
declares `authority:` and `tool_profiles:`; the expansion of those profiles must equal
its `tools:` list exactly, and drift fails `make lint`. Full ladder and per-agent
assignment: [Tool Authority Profiles](tool-profiles.md).

| Category       | Profiles                                                                      | Purpose                                                        |
| -------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Exact artifact | `artifact`                                                                    | Read one granted immutable input with typed continuation.      |
| Filesystem     | `filesystem.read` ⊂ `filesystem.observe` ⊂ `filesystem.write`                 | Read, search, then create or change in-scope files by role.    |
| Shell          | `shell.unbounded`                                                             | `bash`. Named honestly — it is not bounded by anything.        |
| Web            | `web.search`, `web.transcript`                                                | Gather external evidence.                                      |
| Browser        | `browser.observe` ⊂ `browser.reveal` ⊂ `browser.interact` ⊂ `browser.execute` | Observe, disclose, mutate, or execute against a rendered page. |
| Generation     | `docgen`                                                                      | Create requested document products.                            |

The browser rungs are the reason the ladder exists. Observing a page, clicking a tab
to reveal state that is already present, submitting a form, and executing arbitrary
code are four different authorities that a single `playwright_*` grant conflates.
`browser.execute` is granted to **no** agent; a future grant requires an explicit,
dated, recorded exception.

### What the profiles do and do not guarantee

**Browser authority is structural. Filesystem and shell authority are not.**

Every agent holds `bash` via `shell.unbounded`. A role declaring `authority: read` is
structurally prevented from browser form submission, file upload, and arbitrary
Playwright/Node execution — and is **still able to mutate the filesystem, install
packages, and reach the network through `bash`**. No document may state or imply that
read-only is fully enforced; at the filesystem and process layer it remains advisory.

Tool visibility is not artifact authorization. `artifact_read` independently
validates the exact ref, run, consumer, digest, expiry, and continuation cursor;
it has no list, search, guess, or self-grant surface.

## Verification

- [ ] Local agent names and descriptions come from `.pi/agents` only.
- [ ] No `memory_*` tool appears in worker frontmatter.
- [ ] `artifact_read` is present in every worker definition.
- [ ] `authority` and `tool_profiles` are declared and pass `check_tool_profiles.py`.
- [ ] No remote-presence claim is inferred from the local catalog.
- [ ] Catalog changes require reload before execution.

## Files

| File                                      | Purpose                            |
| ----------------------------------------- | ---------------------------------- |
| `docs/agents/agents/definition-format.md` | Catalog entry format               |
| `docs/agents/agents/tool-profiles.md`     | Tool authority profiles            |
| `.pi/extensions/subagent/agents.ts`       | Discovery and catalog snapshot     |
| `.pi/extensions/subagent/agent-runner.ts` | Tool exposure and worker process   |
| `.pi/extensions/artifacts/README.md`      | Exact artifact grant/read contract |
