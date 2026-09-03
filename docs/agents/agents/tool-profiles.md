# Tool Authority Profiles — the ladder and what it does not cover

## Why profiles exist

A Role Definition that declares itself read-only in prose while holding form-fill,
file-upload, and arbitrary-execution tools has two different guarantees, and only
the weaker one is real. The frontmatter `tools:` list is the maximum ordinary catalog control plane:
`.pi/agents/*.md` → `agents.ts` → `agent-runner.ts` → `pi --tools <allowlist>`.
Direct/parallel/chain invocation uses that list exactly. Prose does not narrow it.

Tool profiles make the intended maximum authority **declared and machine-checked** instead
of implied. Each agent declares `authority:` and `tool_profiles:`; the expansion of those
profiles must equal its `tools:` list exactly. A fixed TypeScript orchestration phase subset
is registration metadata, not a profile or agent-definition change.

## Rules

1. **Profiles statically lint the YAML maximum.** Their expansion must equal `tools:`.
   Direct/parallel/chain catalog invocation and orchestration phases without a registered
   subset activate that exact list.
2. **The one narrowing exception is registration-bound, not profile-driven.** A TypeScript
   orchestration catalog-worker phase may bind one explicit non-empty duplicate-free strict
   YAML subset into the canonical runtime-registration digest and worker invocation metadata.
   Task text, trust profiles, runtime conditions, inputs, and optional-service state cannot
   select it. It never mutates the role's `authority`, `tool_profiles`, or YAML metadata.
3. **Rungs are strictly additive.** Each rung contains every tool of the rung below it
   plus a bounded, named increment. Restoring one rung is a one-line edit, which is
   what makes the reduction safe to attempt.
4. **`browser.execute` is granted to no agent.** Any future grant requires an explicit,
   dated, recorded exception.
5. **No agent whose `authority` is `read` or `inspect` may hold a browser rung above
   `browser.reveal`.**
6. **Drift fails the build.** `scripts/system/checks/check_tool_profiles.py` is the
   machine source of truth for every expansion below and runs in `make lint`.

## The ladder

<!-- BEGIN GENERATED: check_tool_profiles.py --emit-markdown -->

#### `filesystem.*`

| Rung                 | Adds                 | Cumulative |
| -------------------- | -------------------- | ---------: |
| `filesystem.read`    | `read`               |          1 |
| `filesystem.observe` | `grep`, `find`, `ls` |          4 |
| `filesystem.write`   | `write`, `edit`      |          6 |

#### `browser.*`

| Rung               | Adds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Cumulative |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------: |
| `browser.observe`  | `playwright_navigate`, `playwright_navigate_back`, `playwright_navigate_forward`, `playwright_reload`, `playwright_get_current_url`, `playwright_get_title`, `playwright_snapshot`, `playwright_screenshot`, `playwright_close`, `playwright_resize`, `playwright_new_page`, `playwright_close_page`, `playwright_switch_tab`, `playwright_list_tabs`, `playwright_wait_for`, `playwright_console_messages`, `playwright_network_requests`, `playwright_network_request`, `playwright_pdf`, `playwright_verify_element_visible`, `playwright_verify_text_visible`, `playwright_verify_value`, `playwright_highlight`, `playwright_hide_highlight`, `playwright_mouse_move_xy`, `playwright_mouse_wheel` |         26 |
| `browser.reveal`   | `playwright_click`, `playwright_double_click`, `playwright_hover`, `playwright_press_key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |         30 |
| `browser.interact` | `playwright_type`, `playwright_fill`, `playwright_fill_form`, `playwright_select_option`, `playwright_check`, `playwright_uncheck`, `playwright_drag`, `playwright_drop`, `playwright_file_upload`, `playwright_mouse_click_xy`, `playwright_mouse_drag_xy`, `playwright_handle_dialog`, `playwright_route`, `playwright_unroute`, `playwright_cookies`, `playwright_local_storage`, `playwright_session_storage`                                                                                                                                                                                                                                                                                       |         47 |
| `browser.execute`  | `playwright_evaluate`, `playwright_run_code_unsafe`, `playwright_start_tracing`, `playwright_stop_tracing`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |         51 |

#### Flat profiles

| Profile           | Tools                                                                                                                                                                                                                | Count |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: |
| `shell.unbounded` | `bash`                                                                                                                                                                                                               |     1 |
| `web.search`      | `web_search`, `web_fetch`                                                                                                                                                                                            |     2 |
| `web.transcript`  | `youtube_transcript`                                                                                                                                                                                                 |     1 |
| `docgen`          | `word_generate`, `powerpoint_generate`                                                                                                                                                                               |     2 |
| `artifact`        | `artifact_read`                                                                                                                                                                                                      |     1 |
| `memory.read`     | `memory_search`, `memory_smart_search`, `memory_get_drawer`, `memory_list_drawers`, `memory_get_taxonomy`, `memory_check_duplicate`, `memory_kg_query`, `memory_kg_timeline`, `memory_kg_stats`, `memory_diary_read` |    10 |

<!-- END GENERATED -->

### Why `browser.reveal` is its own rung

Clicking a tab, opening an accordion, or hovering to expose a menu is required to
_observe_ state that is present but not yet rendered. That is categorically different
from submitting a form or uploading a file. Collapsing `reveal` into `observe` would
break read-only inspection of real applications; collapsing it into `interact` would
hand mutation authority to every role that needs to read a tabbed page.

### Why the shell profile is named `shell.unbounded`

There is deliberately no `shell.inspect`. `bash` cannot be honestly described as an
inspection capability — it can write files, delete them, install packages, and reach
the network. Naming the profile `shell.unbounded` keeps the registry truthful and
keeps the gap visible in the metadata instead of disguising it behind a calm label.

## Current maximum assignment

<!-- BEGIN GENERATED: per-agent assignment -->

| Agent      | Authority | Profiles                                                                                                             | Tools |
| ---------- | --------- | -------------------------------------------------------------------------------------------------------------------- | ----: |
| `annie`    | `read`    | `filesystem.observe`, `shell.unbounded`, `web.search`, `browser.observe`, `artifact`, `memory.read`                  |    44 |
| `carren`   | `read`    | `filesystem.observe`, `shell.unbounded`, `artifact`, `memory.read`                                                   |    16 |
| `demetri`  | `read`    | `filesystem.observe`, `shell.unbounded`, `web.search`, `artifact`, `memory.read`                                     |    18 |
| `echo`     | `read`    | `filesystem.observe`, `shell.unbounded`, `web.search`, `web.transcript`, `browser.reveal`, `artifact`, `memory.read` |    49 |
| `ida`      | `read`    | `filesystem.observe`, `shell.unbounded`, `web.search`, `artifact`, `memory.read`                                     |    18 |
| `piper`    | `read`    | `filesystem.observe`, `shell.unbounded`, `web.search`, `artifact`, `memory.read`                                     |    18 |
| `skribble` | `write`   | `filesystem.write`, `shell.unbounded`, `web.search`, `docgen`, `artifact`, `memory.read`                             |    22 |
| `synthia`  | `read`    | `filesystem.read`, `shell.unbounded`, `artifact`, `memory.read`                                                      |    13 |
| `tabitha`  | `read`    | `filesystem.observe`, `shell.unbounded`, `artifact`, `memory.read`                                                   |    16 |
| `vera`     | `inspect` | `filesystem.observe`, `shell.unbounded`, `web.search`, `web.transcript`, `browser.reveal`, `artifact`, `memory.read` |    49 |

<!-- END GENERATED -->

`synthia` holds `filesystem.read` rather than `filesystem.observe` because it integrates
material already gathered; it never needed `grep`/`find`/`ls`. Promoting it to `observe`
to make the table tidier would have broadened authority, which is the opposite of the
purpose here.

## What this does NOT guarantee

**Browser authority is structural. Filesystem and shell authority are not.**

All ten YAML maxima include `bash`. Under an ordinary exact-YAML invocation, a role declaring
`authority: read` is:

- structurally prevented from browser-based form submission, file upload, and arbitrary
  Playwright/Node execution;
- **still capable of arbitrary filesystem and process mutation through `bash`**, including
  writing files, deleting them, installing packages, and reaching the network.

A registration-bound phase subset that omits `bash` removes it from that session's
model-visible call surface. It does **not** create OS/process sandboxing, reduce the Pi process's
host permissions, or stop provider extension code from loading. No document may turn either
profile linting or a phase subset into a broader isolation claim. Closing the ordinary `bash`
gap is tracked separately and is out of scope for the profile ladder; candidate approaches are
a command-allowlisted shell wrapper, dropping `bash` from roles that only need
`read`/`grep`/`find`/`ls`, or container isolation.

## Verification

```bash
.venv/bin/python scripts/system/checks/check_tool_profiles.py
.venv/bin/python scripts/system/checks/check_tool_profiles.py --agent echo
.venv/bin/python scripts/system/checks/check_tool_profiles.py --emit-markdown
```

The check runs in `make lint`. It evaluates YAML and profiles only; orchestration subsets do
not participate. It fails on: a tool held but not granted by any declared profile, a tool
granted but missing from `tools:`, an unknown profile name, a forbidden tool, a
non-modifying role exceeding the browser ceiling, and a ladder rung that is not a superset
of the rung below it.
