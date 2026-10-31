# Tool Authority Profiles — the ladder and what it does not cover

## Why profiles exist

Profiles declare and statically check the intended maximum catalog authority. Each agent's
`authority:` and `tool_profiles:` must expand to its YAML `tools:` list exactly. Prose does
not narrow the tool surface or prove that permitted tools cannot cause side effects.

## Rules

1. **Profiles statically lint the YAML maximum.** Their expansion must equal `tools:`.
2. **Runtime selection has a separate owner.** For phase selection or runtime-tool changes,
   apply the [binding runtime rule](discovery-and-tools.md#binding-runtime-rule), including
   the guarded zero-tool exception. Static profile edits only change the YAML maximum;
   phase selection does not mutate profiles or agent metadata.
3. **Rungs are strictly additive.** Each rung contains every tool of the rung below it
   plus a bounded, named increment.
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

| Profile                | Tools                                                                                                                                                                                                                | Count |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: |
| `shell.unbounded`      | `bash`                                                                                                                                                                                                               |     1 |
| `web.search`           | `web_search`, `web_fetch`                                                                                                                                                                                            |     2 |
| `web.transcript`       | `youtube_transcript`                                                                                                                                                                                                 |     1 |
| `docgen`               | `word_generate`, `powerpoint_generate`                                                                                                                                                                               |     2 |
| `artifact`             | `artifact_read`                                                                                                                                                                                                      |     1 |
| `sca.source_query`     | `sca_source_query`                                                                                                                                                                                                   |     1 |
| `sca.graph_query`      | `sca_graph_query`                                                                                                                                                                                                    |     1 |
| `sca.application_test` | `sca_application_test`                                                                                                                                                                                               |     1 |
| `memory.read`          | `memory_search`, `memory_smart_search`, `memory_get_drawer`, `memory_list_drawers`, `memory_get_taxonomy`, `memory_check_duplicate`, `memory_kg_query`, `memory_kg_timeline`, `memory_kg_stats`, `memory_diary_read` |    10 |

<!-- END GENERATED -->

### Why `browser.reveal` is its own rung

Clicking tabs, opening accordions, and hovering can expose content needed for inspection
without granting the dedicated fill/upload/evaluate interfaces. This rung describes intended
use, not a read-only browser guarantee: clicks and keys can also submit forms or mutate
remote state. Inspect the target and obtain any required authorization before acting.

### Why the shell profile is named `shell.unbounded`

There is deliberately no `shell.inspect`. `bash` cannot be honestly described as an
inspection capability — it can write files, delete them, install packages, and reach
the network. Naming the profile `shell.unbounded` keeps the registry truthful and
keeps the gap visible in the metadata instead of disguising it behind a calm label.

## Current maximum assignment

<!-- BEGIN GENERATED: per-agent assignment -->

| Agent      | Authority | Profiles                                                                                                                                                        | Tools |
| ---------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----: |
| `annie`    | `read`    | `filesystem.observe`, `shell.unbounded`, `web.search`, `browser.observe`, `artifact`, `memory.read`, `sca.source_query`, `sca.graph_query`                      |    46 |
| `carren`   | `read`    | `filesystem.observe`, `shell.unbounded`, `artifact`, `memory.read`                                                                                              |    16 |
| `demetri`  | `read`    | `filesystem.observe`, `shell.unbounded`, `web.search`, `artifact`, `memory.read`, `sca.graph_query`, `sca.application_test`                                     |    20 |
| `echo`     | `read`    | `filesystem.observe`, `shell.unbounded`, `web.search`, `web.transcript`, `browser.reveal`, `artifact`, `memory.read`, `sca.source_query`, `sca.graph_query`     |    51 |
| `ida`      | `read`    | `filesystem.observe`, `shell.unbounded`, `web.search`, `artifact`, `memory.read`                                                                                |    18 |
| `piper`    | `read`    | `filesystem.observe`, `shell.unbounded`, `web.search`, `artifact`, `memory.read`, `sca.graph_query`, `sca.application_test`                                     |    20 |
| `rhea`     | `read`    | `filesystem.observe`, `artifact`                                                                                                                                |     5 |
| `skribble` | `write`   | `filesystem.write`, `shell.unbounded`, `web.search`, `docgen`, `artifact`, `memory.read`, `sca.source_query`, `sca.graph_query`                                 |    24 |
| `synthia`  | `read`    | `filesystem.read`, `shell.unbounded`, `artifact`, `memory.read`, `sca.source_query`, `sca.graph_query`                                                          |    15 |
| `tabitha`  | `read`    | `filesystem.observe`, `shell.unbounded`, `artifact`, `memory.read`                                                                                              |    16 |
| `vera`     | `inspect` | `filesystem.observe`, `shell.unbounded`, `web.search`, `web.transcript`, `browser.reveal`, `artifact`, `memory.read`, `sca.graph_query`, `sca.application_test` |    51 |

<!-- END GENERATED -->

`synthia` holds `filesystem.read` rather than `filesystem.observe` because it integrates
material already gathered; it never needed `grep`/`find`/`ls`. Promoting it to `observe`
to make the table tidier would have broadened authority, which is the opposite of the
purpose here.

## What this does NOT guarantee

**An unavailable tool interface is not proof that an action is impossible.**

The `read`/`inspect` browser ceiling excludes dedicated fill, upload, and arbitrary
Playwright/Node execution tools. It does not structurally prevent form submission:
`playwright_click` invokes the selected locator without a submit guard, and keys can trigger
state changes. The role's no-mutation rule and approval requirements still apply.
See `.pi/extensions/playwright/tools/click.ts` for the click implementation.

A role holding `shell.unbounded` remains capable of arbitrary filesystem/process mutation
through `bash`, including writes, deletion, package installation, and network access. Consult
the generated assignments above rather than assuming every role has shell access.

A registration-bound subset omitting `bash` removes that model-visible interface only.
Neither profile linting nor phase selection creates OS/process sandboxing, reduces Pi's host
permissions, or prevents provider extension code from loading. Use external isolation for
untrusted/unattended execution; closing the shell gap is outside the profile ladder.

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
