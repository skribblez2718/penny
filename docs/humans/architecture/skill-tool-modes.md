# Skill Tool Modes

The `skill` tool supports single, parallel, chain, and resume under one exact artifact-ID
contract.

- **Single:** one durable run and terminal ID.
- **Parallel:** independent runs, each with its own exact inputs and terminal ID.
- **Chain:** prior terminal ID is verified and forwarded directly across runs; `{previous}`
  is an instruction marker and steps may add explicit fan-in IDs.
- **Resume:** an owner-only checkpoint skips only completed steps whose exact refs, release status,
  and contract digest still verify.

Every stage output is persisted and re-read before continuation. Missing/corrupt inputs,
output persistence failures, and checkpoint/registration mismatches stop the chain explicitly with
exact refs and a resumable marker. Generic failure does not require an approval questionnaire;
only a workflow's genuine clarification gate asks the user. Memory
and inline previews are never continuity authority.
