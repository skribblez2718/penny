# Tool Description Standard — provider-visible routing and operation contracts

## Model-visible channels

Penny uses a custom `.pi/SYSTEM.md`. Pi still sends every active tool's `name`,
`description`, parameter schema, and parameter descriptions through the provider-native
tool channel. Pi's custom-prompt branch does not render `promptGuidelines` or
`promptSnippet` into the system prompt.

Required tool guidance therefore lives in one of these channels:

1. `description` for routing, operation, result, consequence, and tool relationships;
2. parameter descriptions for argument meaning, bounds, and defaults;
3. `.pi/SYSTEM.md` for universal cross-tool policy.

`promptGuidelines` is prohibited in Penny runtime extension source. `promptSnippet` may
remain as optional default-Pi compatibility metadata, but Penny must not depend on it.

## Description classes

### Gateway, overlapping, costly, or consequential tools

Use the semantic routing shape:

> `[Capability and result]. Use when [positive triggers]. Do not use for [nearest anti-cases].`

Add side effects, approval requirements, or the preferred neighbouring tool when those
facts affect selection. Examples include workflow dispatch, delegation, clarification,
external discovery, durable writes, and unsafe execution.

### Narrow primitive tools

State:

> `[Operation and result]. [Important discriminator, constraint, or safety condition].`

Do not add tautological use/anti-use clauses. Add an anti-case only when another tool is a
credible alternative, the operation is consequential, or the name does not establish its
scope.

## Catalog descriptions

Agent and skill YAML descriptions are routing catalog entries, not tool operation manuals.
Each has:

- a hard limit of 1,024 characters;
- a preferred target of approximately 500 characters;
- permission to exceed the preferred target when the extra text materially improves routing.

Aggregate tool descriptions that carry a catalog use a separate total budget and must not
silently truncate an individual entry below its hard limit. Prefer one catalog serialization
per model request; do not repeat the same skill descriptions in both the system prompt and a
tool description.

## Active-tool surface

Registered and active are separate. Only active tool definitions are sent to the model.
Large families may keep a small primary-runtime core active and load groups additively.
Catalog workers are the exception: their active definitions must equal YAML `tools:` exactly,
and loaders may neither narrow nor broaden that surface.

## Verification

- [ ] Required guidance is in `description`, parameter schemas, or `.pi/SYSTEM.md`.
- [ ] No runtime extension source defines `promptGuidelines`.
- [ ] Gateway and consequential tools include positive routing and nearest anti-cases.
- [ ] Primitive descriptions avoid tautological routing prose.
- [ ] Descriptions accurately match implementation outputs and side effects.
- [ ] A catalog description is serialized once per model request.
- [ ] Dynamic activation does not broaden worker authority.

Run:

```bash
python scripts/system/checks/check_tool_descriptions.py
```
