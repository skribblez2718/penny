---
name: caido
description: Create any Caido extension — backend plugins, frontend pages, full-stack plugins, and passive/active workflows. Use for Caido plugin development, workflow creation, extension scaffolding, or Caido SDK integration. Do not use for querying a running Caido instance (use caido_* tools) or non-Caido development.
license: MIT
metadata:
  version: "1.0.0"
  penny:
    state_machine: true
    mempalace: true
    subagents:
      - echo
      - piper
      - skribble
---

## When to Use

- Building a Caido plugin — backend-only, frontend-only, or full-stack
- Creating a Caido workflow (passive or active)
- Adding onUpstream request modification, onInterceptRequest/Response hooks
- Adding a custom page or sidebar item to Caido's UI
- Setting up RPC communication between frontend and backend plugins
- Debugging a Caido extension that isn't working
- The user mentions "Caido plugin", "Caido workflow", "Caido extension", or Caido SDK APIs

## When Not to Use

- Querying a running Caido instance (use the `caido_*` tools directly)
- Tasks unrelated to Caido development
- Editing a single file in an existing Caido project (direct edit is faster)

## Invocation

Invoke via the `skill` tool. The skill extension handles orchestration — agents communicate via mempalace, Penny receives structured summaries.

The `skill` extension handles the entire orchestration loop: Python orchestrator → subagent invocation → summary extraction → state advancement → repeat until complete. Penny's context stays clean — agents communicate via mempalace, and Penny only sees structured summaries.

```
skill({{
  skill_name: "caido",
  goal: "Your goal here",
  project_root: "/path/to/project"
}})
```



## Workflow

### Phase 1: EXPLORE (Echo)
Determine the extension type and required APIs:
- Backend-only: hooks (`onUpstream`, `onInterceptRequest`), RPC endpoints
- Frontend-only: page type (navigation vs command palette), UI components
- Full-stack: backend + frontend with RPC bridge
- Workflow: passive (intercept-driven) or active (trigger-driven), node graph

**Agent**: `echo` — research Caido docs and reference implementations
**Output**: Extension type recommendation with API surface summary

### Phase 2: DESIGN (Piper)
Design architecture:
- `caido.config.ts` plugin array
- Backend: hook registrations, API definitions (`DefineAPI`), storage strategy
- Frontend: component tree, page registration, SDK usage
- Workflow: node layout, JS script logic, I/O connections
- Data flow: frontend → backend RPC path

**Agent**: `piper` — produce architecture design
**Output**: File list, data flow, component tree

### Phase 3: SCAFFOLD (Codee)
Create project at `~/projects/caido-plugins/<plugin-name>`:
- `package.json` with `@caido-community/dev`, `vitest`, `eslint`, `typescript`
- `caido.config.ts` with correct plugin definitions per extension type
- Backend skeleton: `backend/src/index.ts` with `init(sdk)` export
- Frontend skeleton: `frontend/src/index.ts` (if applicable)
- Workflow definition: `workflow/definition.json` (if applicable)
- Test infrastructure: `vitest.config.ts`, `eslint.config.mjs`, `tsconfig.json`
- `README.md` with install instructions following root README format
- `requirements.txt` for Python orchestrator deps

**Agent**: `skribble` — scaffold following `resources/reference.md` constraints
**Output**: Runnable (but empty) project at `~/projects/caido-plugins/<plugin-name>`

### Phase 4: IMPLEMENT (Codee)
Implement the extension logic:
- RPC endpoints via `sdk.api.register(name, callback)` — NOT property assignment
- Event hooks: `sdk.events.onUpstream()`, `sdk.events.onInterceptRequest()`
- Frontend: `defineComponent` with `h()` render functions — NOT `.vue` SFCs
- Frontend pages: `navigation.addPage` + `sidebar.registerItem` — NOT `settings.addToSlot`
- CSS: explicit dark-mode colors — NOT Caido variables, NOT Tailwind
- Workflows: JS nodes with `sdk.requests.send()` for resend patterns

**Agent**: `skribble` — implement per design and constraints in `resources/reference.md`
**Constraints**: All 10 hard constraints enforced via skillContext injection

### Phase 5: TEST (Codee)
Set up and run TDD pipeline:
- Mock `caido:plugin` and `caido:utils` with `vi.mock()`
- Export pure functions with `_` prefix for test access
- Avoid jsdom — use `environment: "node"` + document mock
- Test: RPC registration, hook callbacks, logic functions, component structure
- Run: lint → typecheck → unit tests → build

**Agent**: `skribble` — write tests using patterns from `resources/reference.md`
**Constraint**: All code paths tested before build

### Phase 6: BUILD (Codee)
Build and verify:
- `npx caido-dev build` — must pass manifest validation
- Verify ZIP: `manifest.json` at root, `<plugin-id>/index.js` present
- Run full pipeline: lint + test + build (all green)
- Present install instructions and post-install configuration steps

**Agent**: `skribble` — build, verify, report
**Output**: Ready-to-install `dist/plugin_package.zip` or importable workflow JSON

## Extension Types Covered

| Type | Phases Used | Key APIs |
|------|------------|----------|
| Backend-only plugin | EXPLORE → DESIGN → SCAFFOLD → IMPLEMENT → TEST → BUILD | `onUpstream`, `onInterceptRequest`, `sdk.api.register` |
| Frontend-only plugin | EXPLORE → DESIGN → SCAFFOLD → IMPLEMENT → TEST → BUILD | `navigation.addPage`, `sidebar.registerItem`, `storage` |
| Full-stack plugin | All 6 phases | Both backend + frontend APIs, RPC bridge |
| Passive workflow | EXPLORE → DESIGN → SCAFFOLD → IMPLEMENT → BUILD | `on-intercept-request`, JS node, `sdk.requests.send` |
| Active workflow | EXPLORE → DESIGN → SCAFFOLD → IMPLEMENT → BUILD | Trigger nodes, JS node, `sdk.requests.send` |

## Hard Constraints

Injected into every agent via `skillContext`. Violating any of these causes known failures:

1. All plugins live at `~/projects/caido-plugins/<plugin-name>` — scaffold there, never elsewhere
2. Never hand-write `manifest.json` — `caido.config.ts` + `caido-dev build` only
2. `sdk.api.register("name", callback)` — never property assignment
3. RPC callbacks: `fn(sdk: SDK, ...args)` — sdk is first parameter
4. Pages: `navigation.addPage` + `sidebar.registerItem` — never `settings.addToSlot`
5. Components: `.ts` with `defineComponent` + `h()` — never `.vue` SFCs
6. CSS: explicit dark colors — never Caido CSS variables or Tailwind
7. `onUpstream` requires Settings → Network → Upstream Plugins rules (document for user)
8. TDD: lint + typecheck + unit tests before build
9. Mock `caido:plugin`/`caido:utils` in tests — avoid jsdom
10. HTTP History shows original requests, not onUpstream-modified — verify via httpbin.org

## Storing Learnings

After the skill completes, store session results in mempalace:

```python
memory_add_drawer(
    wing="penny",
    room="skills",
    content="## Caido Skill Session\n\n**Plugin:** {plugin_name}\n**Type:** {extension_type}\n**Files Created:** {file_count}\n**Output:** {output_dir}"
)
memory_kg_add(f"SkillSession:{session_id}", "completed", f"Skill:caido:{plugin_name}")
```
