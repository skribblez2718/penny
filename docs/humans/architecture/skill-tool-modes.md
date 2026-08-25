# Skill Tool Modes

The `skill` tool supports single, parallel, chain, and resume under one exact artifact-ID
contract.

- **Single:** one durable run and terminal ID.
- **Parallel:** independent runs, each with its own exact inputs and terminal ID.
- **Chain:** prior terminal ID is verified and forwarded directly across runs; `{previous}`
  is an instruction marker and steps may add explicit fan-in IDs.
- **Resume:** an owner-only checkpoint skips only completed steps whose exact refs still
  verify.

Every stage output is persisted and re-read before continuation. Missing/corrupt inputs,
output persistence failures, and checkpoint mismatches stop the chain explicitly. Memory
and inline previews are never continuity authority.
