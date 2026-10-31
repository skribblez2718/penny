# Pi Platform Documentation

## Applies when

Explaining, configuring, extending, or troubleshooting Pi itself: extensions, themes,
skills, prompt templates, terminal UI (TUI), keybindings, SDK integrations, providers,
models, or packages. Merely using a Pi feature to perform another task does not require
loading its implementation documentation.

This guide supplements Penny-specific guidance. For example, changing a Penny extension
also requires the applicable Extensions and Coding routes in the agent documentation
index; upstream Pi documentation does not replace those standards.

## Locate the installed documentation

Resolve `PI_PACKAGE_DIR` from the active environment before opening upstream files.
A shell command such as `printf '%s\n' "$PI_PACKAGE_DIR"` retrieves only that setting.
If it is missing or does not identify the installed Pi package, report the missing or
invalid configuration rather than guessing an installation path. Do not dump `.env`
or unrelated environment values to find it.

The environment extension substitutes `${PI_PACKAGE_DIR}` in the prompt-loaded root
`AGENTS.md` and `.pi/SYSTEM.md`; an ordinary document read does not expand it. Use the
resolved concrete path with the read tool. Keep installation paths symbolic in tracked
files.

All upstream paths below are relative to the resolved `PI_PACKAGE_DIR`, **not** to
Penny's repository root:

- `README.md`: upstream overview and documentation navigation.
- `docs/`: feature documentation.
- `examples/`: upstream implementation examples.

Use the documentation shipped with the installed runtime. This guide is a map to
upstream sources, not a copied or independently maintained account of their APIs.

## Topic map

| Working on       | Read                       |
| ---------------- | -------------------------- |
| Extensions       | `docs/extensions.md`       |
| Themes           | `docs/themes.md`           |
| Skills           | `docs/skills.md`           |
| Prompt templates | `docs/prompt-templates.md` |
| TUI components   | `docs/tui.md`              |
| Keybindings      | `docs/keybindings.md`      |
| SDK integrations | `docs/sdk.md`              |
| Custom providers | `docs/custom-provider.md`  |
| Adding models    | `docs/models.md`           |
| Pi packages      | `docs/packages.md`         |

Consult available examples before implementing Pi-specific behavior, including
`examples/extensions/` for extensions and `examples/sdk/` for SDK integrations.
Provider examples are also under `examples/`; use the selected guide to locate them.
For TUI work, follow the guide's references to `docs/themes.md` and `docs/extensions.md`.

Apply the root's documentation-reading discipline to selected sources, including their
load-bearing Markdown cross-references. A topic is a starting point, not a reason to
skip another guide required by the task.
