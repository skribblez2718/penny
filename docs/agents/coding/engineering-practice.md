# Engineering Practice

## Applies when

Clarifying requirements, selecting an incremental delivery or learning approach, negotiating quality/scope tradeoffs, or improving repetitive engineering work and feedback.

## Work toward a real outcome

Separate the user's durable need from a proposed implementation or the current system's shape. Resolve uncertainties that can materially change correctness, scope, authority or risk; infer low-risk details rather than making every decision another approval gate. State consequential assumptions and tradeoffs. More specification is useful only when it reduces uncertainty or enables a better check.

Be accountable for what the delivered change actually does. Do not blame a tool or inherited style for a defect that remains in scope to fix. Be equally honest about limits: an observed pass, a plausible design, a prototype and a production-qualified path establish different things. Quality is fitted to actual users, risks and governing requirements, not unlimited polishing or schedule-driven concealment of missing controls.

Choose a learning approach that answers the unresolved question. A thin end-to-end implementation can reveal integration assumptions that an isolated experiment cannot; an isolated prototype can answer a specific uncertainty more cheaply. State what each demonstrates and what it omits. Discard or deliberately harden experimental shortcuts before relying on them for delivery. Neither approach grants permission to mutate production or skip required acceptance evidence. As partial work develops, bring composing changes together or exercise their shared boundary early enough to expose mismatches before assumptions diverge. Choose useful integration points from dependencies and risk, not a fixed cadence or an unsafe compulsory merge.

Preserve useful options around uncertain, expensive-to-reverse decisions. A small experiment, concrete example or reversible change may answer more than another architecture document. If hesitation reflects a missing fact, identify that fact rather than hiding disagreement behind apparent progress. Do not keep a prototype, generated scaffold, formal model or diagram as authority merely because it already exists.

## Feedback, tools and communication

Use source control, repeatable checks and inspectable artifacts. Keep builds, tests and other authorized automation aligned with the project's toolchain. Automate repeated error-prone transformations when doing so is simpler than maintaining the manual process; do not build a new workflow system for a one-off task. Simplify or automate recurring build/test setup and invocation when manual steps impede reliable feedback, using the existing toolchain rather than adding ceremony.

Prefer plain text or an open, explicit format for long-lived configuration, scripts and interchange when diffability, recovery and interoperability matter. Binary formats are appropriate when their capabilities justify them. Generated output should have a clear authoritative input and a reproducible update path; inspect and understand generated behavior before relying on it.

Use an editor, shell, debugger, profiler or generator to obtain evidence or reduce repetitive effort, not to certify its own answer. Retrieve current authoritative information when a tool, dependency or environment assumption could change the decision. Test the resulting behavior rather than preserving an inherited recipe.

Introduce a domain language, generated code or runtime coordination only when it makes the actual rules easier to express and verify than a simpler implementation. Coordination around shared evolving facts can help when contributions arrive in an uncertain order, several information sources must combine, or work becomes possible as new facts appear. Compare it with direct calls or a simpler explicit sequence, and make concurrency, progress and failure behavior understandable. Understand interpretation, hidden control flow, shared state and the relevant trust boundary. The existence of a named technique is not evidence that the task needs it.

Communicate decisions through precise names, tests, comments, documentation and the final handoff. Explain the changed contract, evidence, residual risk and next needed action. Keep estimates revisable and disclose uncertainty rather than representing hidden work as progress. Clear communication matters for a personal project without introducing teams, ownership matrices or recurring governance.

Keep learning from failures and revisit stale assumptions. Record reusable knowledge when it helps future work, not a ceremonial activity log. Watch gradual degradation and fragile temporary workarounds, but repair only what the authorized change needs; report other debt rather than importing a cleanup quota. Shortcuts, missing tests, weak boundaries, stale explanations or isolated work can compound future change cost. Identify the actual pressure or missing feedback behind the friction and prioritize by current correctness, change effort and understanding, not a catalog of imperfections.

## Related task guidance

Knowledge-level DRY and orthogonality are defined in [Modularity](design/modularity.md). Use [Behavioral Tests](testing/behavior.md) when selecting evidence and [Diagnosis and Performance](testing/diagnosis-and-performance.md) when investigating a failure or optimization. [Bounded Work](../agents/bounded-work.md) governs substantial assignment sufficiency and dependencies; this guide adds no scheduler, fixed task count or automatic approval authority.
