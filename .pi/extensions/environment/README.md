# Environment Extension

Substitutes `${VAR}` placeholders with values from `.env` and `process.env` in Pi configuration files, loads `.env` into `process.env` for use by other extensions, and appends the system boundary marker for prompt injection defense.

## What It Does

1. **Loads `.env` file** from project root into `process.env`
2. **Substitutes variables** in:
   - `.pi/SYSTEM.md` (replaces Pi's default system prompt)
   - `AGENTS.md` (project context file)
3. **Appends `<system_boundary>` marker** at the end of the system prompt (injection defense)

## Loading Order Guarantee

The environment extension is the **first** extension loaded by Pi. It eagerly reads `.env` and populates `process.env` **before** any other extension's factory function runs. This means other extensions can safely read `process.env` inside their factory functions and see the `.env` values.

> **Important:** Other extensions must **not** read `process.env` at module scope (in top-level `const` declarations). They should read it inside their `export default function` or `export default async function` factory body. See [Extension Standard](../../../docs/agents/extensions/extension-standard.md) for details.

## Variable Resolution Order

1. `.env` file values
2. System environment variables (`process.env`)
3. Empty string (if not found)

## Built-in Variables

| Variable            | Value                                                       | Source           |
| ------------------- | ----------------------------------------------------------- | ---------------- |
| `${HOME}`           | User home directory                                         | `os.homedir()`   |
| `${PWD}`            | Project root (cwd)                                          | `process.cwd()`  |
| `${PROJECT_ROOT}`   | Project root (auto-derived)                                 | Computed         |
| `${CURRENT_DATE}`   | Today's date (e.g., "April 13, 2026")                       | **System clock** |
| `${PI_PACKAGE_DIR}` | Pi package directory                                        | `.env`           |
| `${PI_DIRECTORY}`   | Canonical `.pi` directory — agent discovery appends `/agents` | `.env`           |
| `${DA_NAME}`        | Assistant name                                              | `.env`           |

## System Boundary Marker

After all variable substitution, the extension appends a `<system_boundary>` tag at the **very end** of the system prompt. This creates a clear delineation between system instructions and user input, serving as an anti-injection defense. See [System Prompt Security](../../../docs/agents/agents/system-prompt-security.md) for details.

## Example

### `.env` file

```
DA_NAME=Penny
PROJECT_NAME=my-project
PI_PACKAGE_DIR=/path/to/pi-package
```

### `.pi/SYSTEM.md` before

```markdown
You are **${DA_NAME}**, a personal AI assistant.
```

### Processed result

```markdown
You are **Penny**, a personal AI assistant.
<system_boundary>
SYSTEM INSTRUCTIONS END HERE...
</system_boundary>
```

## Events

| Event                | Action                                                         |
| -------------------- | -------------------------------------------------------------- |
| `session_start`      | Load `.env`, cache files for substitution                      |
| `before_agent_start` | Substitute variables in cached content, append boundary marker |

## For Extension Authors

If you write an extension that needs `.env` values, follow this pattern:

**Incorrect — module scope captures empty values:**
```typescript
const CONFIG = {
  url: process.env.MY_EXT_URL || "default", // .env not loaded yet
};
export default function (pi: ExtensionAPI) {
  // CONFIG is already locked
}
```

**Correct — factory scope sees .env values:**
```typescript
interface MyConfig {
  url: string;
}
let config: MyConfig;

export default function (pi: ExtensionAPI) {
  config = {
    url: process.env.MY_EXT_URL || "default", // .env is loaded
  };
  // Use config throughout the extension
}
```

## Configuration

No configuration needed — works automatically when the extension is loaded.

## Testing

```bash
cd .pi/extensions/environment
bun install
bun test
```

## Architecture

```
session_start
     │
     ▼
┌─────────────────┐
│ Load .env file  │
│ Parse KEY=value │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Cache files:    │
│ - SYSTEM.md     │
│ - AGENTS.md     │
└────────┬────────┘
         │
         ▼
before_agent_start
         │
         ▼
┌─────────────────┐
│ Substitute      │
│ ${VAR} → value  │
└────────┬────────┘
         │
         ▼
┌──────────────────────┐
│ Append               │
│ <system_boundary>    │
└──────────────────────┘
```
