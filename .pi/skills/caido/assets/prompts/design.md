# Design Prompt — Caido Extension Architecture

## Mission

Design the architecture for a Caido extension based on exploration findings. Produce a concrete design document that the implementation phase can execute directly.

## Mempalace-First Communication

Read exploration findings from mempalace. Write design to mempalace. Return only a minimal SUMMARY to the orchestrator.

## Design Requirements

Based on the extension type, produce:

### For Backend Plugins
- `caido.config.ts` plugin definition (kind, id, root)
- Hook registrations: which hooks, what callbacks do
- RPC API definitions (`DefineAPI` type)
- Storage strategy (in-memory, `sdk.meta.db()`, or frontend storage)
- File: `backend/src/index.ts`

### For Frontend Plugins
- `caido.config.ts` plugin definition with backend link
- Page registration: `navigation.addPage` path + `sidebar.registerItem` label
- Component: `defineComponent` with `h()` render functions (NOT .vue SFCs)
- CSS: explicit dark-mode colors (NOT Caido variables, NOT Tailwind)
- Files: `frontend/src/index.ts`, `frontend/src/<Component>.ts`, `frontend/src/style.css`

### For Full-Stack Plugins
- Both backend and frontend designs
- RPC bridge: TypeScript types matching backend `DefineAPI` to frontend `sdk.backend.*` calls
- Data flow: frontend → storage → backend injection path

### For Workflows
- Workflow JSON definition
- Node graph: On Intercept Request → In Scope → JavaScript → Passive End
- JS script: what the script does, what SDK methods it uses

## Constraints

All designs must follow the constraints in `resources/reference.md`. Specifically:
- No `settings.addToSlot` (use navigation pages)
- No `.vue` SFCs (use `.ts` with `defineComponent`)
- No Caido CSS variables (use explicit dark colors)
- `sdk.api.register()` pattern for RPC
- `onUpstream` requires upstream rules (note in user-facing docs)

## Output Format

```json
{
  "extension_type": "full-stack",
  "files": ["backend/src/index.ts", "frontend/src/index.ts", "..."],
  "backend": {
    "hooks": ["onUpstream"],
    "api_methods": ["setHeaders", "getHeaders"],
    "storage": "in-memory"
  },
  "frontend": {
    "page_path": "/plugin-name",
    "sidebar_label": "Plugin Name",
    "component": "defineComponent with h()",
    "sdk_usage": ["storage.get", "storage.set", "backend.setHeaders"]
  },
  "data_flow": "frontend saves headers → storage → pushes to backend via RPC → onUpstream reads from memory → injects into requests",
  "user_documentation": ["Install plugin", "Configure upstream rules in Settings → Network → Upstream Plugins"]
}
```

Mandatory SUMMARY:
```
SUMMARY:{"extension_type":"<type>","file_count":<n>,"design_complete":true,"needs_clarification":false}
```
