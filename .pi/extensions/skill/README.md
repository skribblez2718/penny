# Skill Invocation Extension

Drives durable skill orchestration. Python remains the default engine; a single `research` invocation can explicitly select the TypeScript v2 pilot.

## Architecture

```
Penny → skill tool → TypeScript loop:
  1. Call Python orchestrate.py → get next action + input_artifacts/output_artifact contracts
  2. Grant only that state's exact input refs and invoke the worker
  3. Persist exact final-output bytes through orchestration.artifact_cli
  4. Parse SUMMARY and sign a receipt bound to the canonical ArtifactRef
  5. Feed result protocol v2 to Python
  6. Repeat until complete or error
  7. Return final result to Penny
```

**Key principle: owner-captured artifacts.** Exact agent output is immutable and verified before model-authored SUMMARY data can influence routing. The driver passes refs, receipts, trusted invocation data, and compact routing summaries without placing full output in Penny's context.

### TypeScript v2 pilot

`skill({ skill_name: "research", goal: "...", engine: "typescript" })` selects the in-process TypeScript service, Node SQLite v2 checkpoint, signed owner receipts, immutable TypeScript manifest, phase-specific result tools, and worker-safe Pi SDK resource loader. It supports single research mode only. Omitted or explicit `engine: "python"` follows the unchanged Python path; parallel, chain, and chain resume remain Python. TypeScript workers load only the search and YouTube extensions plus owner-defined result/artifact tools, so the memory/knowledge-base extension is neither initialized nor exposed. No Python orchestration or artifact child is spawned in TypeScript mode.

## How It Works

1. Penny invokes the `skill` tool with `skill_name` and `goal`
2. The extension calls `python3 orchestrate.py start` to get the first action
3. For each action:
   - `invoke_agent` → calls `ctx.tools.subagent()` with the agent name, task, and optional skillContext
   - `invoke_agents_parallel` → calls `ctx.tools.subagent()` in parallel mode
4. Strictly validates `input_artifacts` against the action run/current state and `output_artifact` against the producer identity
5. Appends concise slot/ref metadata to the task, supplies only those refs through the worker artifact environment, and never injects payload bytes
6. Persists exact final-output bytes with `config.venvPython -m orchestration.artifact_cli put`, verifies the canonical ref, parses SUMMARY, and signs a receipt bound to that real ref
7. Feeds result protocol v2 plus existing exit/error/trusted-invocation/command-receipt evidence to `orchestrate.py step`
8. Handles typed `paused` as non-success/retriable without invoking an agent or calling `step`
9. Loops until `complete` or `error`, failing closed before Python advancement on artifact errors
10. Returns structured result to Penny

## Model Visibility

The extension parses SKILL.md frontmatter with Pi's parser and honors the standard
`disable-model-invocation: true` field as a soft hide. Hidden skills are omitted
from the model-facing tool description and `/skills` listing, but remain in the
execution registry so an operator can explicitly invoke `/skill:<name>`.

## Artifact-First Capture

| What                                 | Where                       | Why                                     |
| ------------------------------------ | --------------------------- | --------------------------------------- |
| Exact finalized agent-output bytes   | Immutable artifact store    | Recoverable owner-observed output       |
| Canonical ref + signed owner receipt | Result protocol v2          | Run/phase/branch/producer binding       |
| SUMMARY blocks (counts, verdict)     | Orchestrator routing input  | Minimal model-authored state            |
| Orchestrator state / selected refs   | Python state machine        | Workflow progression and recovery       |
| Optional reusable knowledge          | MemPalace, by explicit task | Durable recall, never persistence proof |

Penny does not ingest full agent output into its context. Single and parallel workers inherit only the current action's exact refs, each invocation gets a fresh bounded grant and cursor HMAC key, and task text contains slot/ref metadata only. Single and parallel branch outputs are persisted before SUMMARY parsing; any contract, persistence, or ref-verification failure prevents `step`. Model-visible handoff instructions use the shared serialized result budget, and the ref remains authoritative over any preview.

## Forward-Only Dispatch Recovery

`PENNY_ARTIFACT_DISPATCH_MODE` accepts exactly `active|paused` and defaults to `active`; unknown values fail closed. The Python engine checks it before agent, deterministic-tool, and fan-out dispatch, and the TypeScript driver independently refuses stale invoke directives. A pause returns a typed `dispatch_pause`/`recovery` result with `success: false` and `retriable: true`. It does not mark the run complete/error or modify selected artifacts. Status and exact artifact reads remain available. After the owner restores `active`, a fresh `recover` reissues the same pending state/input refs/output metadata (or the next explicit compatible revision). No semantic room, memory service, or payload injection is a fallback.

“Exact finalized output” has one canonical definition shared with the subagent runner: concatenate every `text` part in the final assistant message in content-array order, with no inserted separator. Preserve each part's whitespace and exclude thinking/reasoning and tool-call parts. The returned ordinary string, persisted UTF-8 bytes, artifact `byte_length`, and SHA-256 digest therefore describe the same sequence; a textless final assistant message is empty rather than silently falling back to an earlier turn.

## Parameters

| Parameter      | Type   | Description                                                             |
| -------------- | ------ | ----------------------------------------------------------------------- |
| `skill_name`   | string | Name of the skill to invoke (currently `research`)                      |
| `goal`         | string | The goal or objective                                                   |
| `session_id`   | string | Optional unique session ID (auto-generated)                             |
| `project_root` | string | Optional project root directory                                         |
| `constraints`  | object | Optional additional constraints                                         |
| `engine`       | string | Single research only: `python` (default) or explicit `typescript` pilot |

## Agent Invocation

The skill extension delegates to the **subagent extension** for all agent invocation:

- Uses `ctx.tools.subagent()` — same proven code path as manual subagent calls
- Passes `skillContext` pointing to the skill's agent prompt file
- Sets `agentScope: "project"` — agents are discovered from `.pi/agents/`

This means:

- Agent invocation gets all subagent features: streaming, TUI rendering, error handling, agent_end grace period
- Subagents run with `--session-dir` so the Penny compaction extension fires on context limits
- No duplicated agent spawning code
- Consistent behavior between manual and skill-driven invocations

## Subagent Tool vs. Previous invokeAgent()

The skill extension previously had its own `invokeAgent()` function that duplicated the subagent extension's logic. This has been replaced with `ctx.tools.subagent()`:

| Aspect             | Old (invokeAgent)                     | New (ctx.tools.subagent)                              |
| ------------------ | ------------------------------------- | ----------------------------------------------------- |
| Code path          | Duplicated spawn logic                | Single proven code path                               |
| Agent discovery    | `loadAgentSystemPrompt()` from file   | `discoverAgents()` from subagent extension            |
| Streaming          | No TUI rendering                      | Full TUI rendering, progress updates                  |
| Skill context      | Separate `--append-system-prompt` arg | `skillContext` parameter (subagent handles injection) |
| Error handling     | Custom ad-hoc                         | Proven (agent_end grace, timeout, abort)              |
| Tool filtering     | Custom BUILTIN_TOOLS set              | Subagent extension's built-in filter                  |
| Maintenance burden | High (duplicate code)                 | Low (single source of truth)                          |

## Skill-Chain Handoff and Restart

A successful skill exposes its engine-selected terminal `output_artifact_ref`. Chain mode reads and verifies those exact bytes, registers an immutable chain-run handoff ref for the next skill, and gives the first fresh worker only that grant plus `artifact_read` instructions. The former 2,000-character `{previous}` summary is at most a display preview and is never handoff authority.

Chain checkpoints live under caller-supplied `PENNY_SKILL_CHAIN_STATE_ROOT`, `$XDG_STATE_HOME/penny/skill-chains`, or the platform home state directory. Directories are `0700`, files are atomically replaced at `0600`, and checkpoints retain exact terminal/handoff refs across process restart. The former temporary checkpoint directory and memory rooms are not chain authority. Missing, corrupt, wrong-run, or ungranted refs fail before the next skill advances.

## Testing

The suite is written for **Vitest** (`vi.mocked`, module mocks). Do **not** run
`bun test` — bun's mock API differs and produces false failures. Use the
package.json scripts (which invoke `bunx vitest run --config ...`):

```bash
cd .pi/extensions/skill
bun install
bun run test              # unit    → tests/vitest.config.ts
bun run test:integration  # integration
bun run test:e2e          # e2e (must run from the project root — uses process.cwd())
```
