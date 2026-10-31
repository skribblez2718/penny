# Public Repository Boundary

## Applies when

Creating, changing, or reviewing tracked Penny content, including source, tests,
configuration, prompts, and documentation. Penny is a public, generic toolset; tracked content must
not reference the operator's filesystem or any specific downstream project.

## Paths and downstream ownership

- Skills and agents receive source, reference, and output paths from the caller as
  invocation constraints. Do not assume a downstream layout or hardcode its paths.
- The downstream project owns its directory layout, source corpus or manifest,
  build/upload steps, and domain methodology. Those specifics do not belong in
  tracked Penny files.
- Penny's own root is `PROJECT_ROOT`, configured through `.env`. In code use
  `ctx.project_root`; in documentation and prompts write `$PROJECT_ROOT`, never an
  operator-specific absolute path.
- Installation paths supplied by configuration stay symbolic in tracked guidance.
  Resolve their configured values when needed; do not copy an operator's resolved
  paths into public files.

## Private inputs and staging

Operator-private inputs, such as source corpora and personal records, must remain
ignored and must never be committed.

`plans/`, `ideas/`, and `research/` are ignored work-in-progress staging directories.
They may hold operator or downstream specifics; tracked content may not. An ignored
location does not authorize disclosure of its contents into a public file.

Before delivery, inspect the scoped diff for private paths, inputs, and downstream
specifics, and confirm private inputs and staging remain ignored.
