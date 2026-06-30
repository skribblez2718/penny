# Explore Prompt — Caido Extension Type Research

## Mission

Research the Caido SDK to determine the correct extension type and API surface for the user's goal. Do not make changes — gather facts, identify available APIs, and summarize findings for the design phase.

## Mempalace-First Communication

Read prior context from mempalace. Write full findings to mempalace. Return only a minimal SUMMARY to the orchestrator.

## Domain Guide

Focus areas for Caido extension exploration:

1. **Extension Type**: Is this a backend plugin (hooks), frontend plugin (UI), full-stack plugin (both), or workflow? Determine from the user's goal.
2. **Required Hooks**: Does the goal need `onUpstream` (modify requests), `onInterceptRequest` (observe requests), `onInterceptResponse` (observe responses), or none?
3. **Frontend Needs**: Does the goal need a custom page, sidebar item, command palette entry, or no UI?
4. **RPC API**: Does the frontend need to call backend methods? What methods are needed?
5. **Storage**: Does the extension need persistent storage (`sdk.storage`, `sdk.meta.db()`)?
6. **Existing Plugins**: Check `~/projects/caido-plugins/` for existing plugins that may provide patterns or conflict.
7. **Caido Version Constraints**: Check Caido v0.56 limitations (settings slot broken, no upstream SDK).

## Reference Documentation

The skill context includes `resources/reference.md` with constraints and API patterns. Read it before exploring. Key documents:
- Backend SDK types: `@caido/sdk-backend` (npm)
- Frontend SDK types: `@caido/sdk-frontend` (npm)
- [onUpstream guide](https://developer.caido.io/guides/plugin_upstream.html)
- [Creating Pages](https://developer.caido.io/guides/components/page.html)

## Output Format

- **Recommended Extension Type**: backend-only | frontend-only | full-stack | workflow
- **Required APIs**: List of SDK methods needed
- **Constraints**: Which hard constraints from reference.md apply to this extension
- **Unknowns**: What remains unclear about the goal

Mandatory SUMMARY:
```
SUMMARY:{"extension_type":"<type>","apis":["api1","api2"],"constraints_applicable":["c1","c2"],"unknowns_count":<n>,"explore_complete":true|false,"needs_clarification":false,"clarifying_questions":[]}
```
