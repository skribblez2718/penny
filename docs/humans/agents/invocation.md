# Agent Invocation and Exact Handoff

A delegated agent starts with fresh model context. Penny supplies the goal, constraints,
optional static domain guidance, and exact artifact IDs or file paths.

When prior work is needed, Penny passes its immutable `art_…` ID through
`input_artifacts`. IDs can come from different agents, runs, sessions, or parallel
branches. The owner verifies each ID before spawn; the worker reads it with
`artifact_read`, repeating with `next_range` until complete.

- **Single:** exact inputs → one persisted output ID.
- **Parallel:** branch-specific inputs → one labeled persisted ID per branch.
- **Chain:** prior step ID is automatic; each step may add explicit IDs; every step ID is
  returned.
- **Fan-in:** several cross-run outputs can be given to one synthesis/review agent.

Payload bytes are not substituted into `{previous}`. Memory, `/tmp`, repository search, and
name-only references are not handoff channels. A missing required ID/path produces
`missing_input:`.

Penny automatically persists and re-reads the complete final assistant response before
returning success or parsing workflow routing. Results print the exact ID; previews are not
the authoritative output.
