# Behavioral Tests and Change Evidence

## Applies when

Designing, changing or reviewing tests, choosing verification for a code change, or establishing a safety net for poorly understood behavior.

## Give the test an oracle

Identify the observable contract: result, state transition, output, failure, ordering or lifecycle property. Assertions must distinguish the intended behavior from a plausible defect or a reverted implementation. A test that only asserts successful construction, a mocked return value or the implementation's own answer may have no useful oracle.

Test through a supported public boundary where possible. Keep fixtures small and expressive, names specific, setup readable and assertions focused on a coherent behavior. Several assertions can describe one contract; one assertion per test is not a quota. Share helpers only when they expose rather than hide the test's vocabulary.

Keep tests self-checking, deterministic, isolated and order-independent. Control clocks, randomness and external responses where appropriate. A fake should preserve the boundary contract it stands in for; do not make the fake conveniently ignore a constraint that matters in production. Test code needs the same readable structure and maintenance as other code.

## Select evidence for the changed boundary

Use focused unit tests for policy and transformations. Adapter tests check translation and failure behavior. Integration tests exercise real collaborators or seams; lifecycle tests exercise affected startup, recovery, cancellation, custody and delivery paths. Fast isolated checks shorten feedback but do not replace integration or lifecycle evidence required by the owning contract.

Choose normal, boundary, invalid-input and negative cases from the affected risks. Include resource exhaustion, failure/recovery, concurrency, compatibility, usability or performance where those properties change. Coverage reports can reveal blind spots; high coverage does not establish meaningful assertions. Test the tests by checking a relevant defect, mutation or reverted behavior would fail, without damaging unrelated work.

Prefer a failing regression test before a bug fix when the failure can be reproduced. Test-driven development is one useful feedback method, not a required sequence for every task. Do not write speculative production behavior merely to anticipate future tests.

## Weak tests and structural change

When current behavior is unclear, characterize it before risky movement. Capture externally visible behavior, including meaningful failure and state effects. A characterization may reveal a bug; preserve it for structural comparison and isolate any intended fix rather than silently blessing the bug as the desired contract.

Separate changes to expected behavior from changes to test structure. Tests can legitimately be renamed, deduplicated, moved or lifted to a stable interface during behavior-preserving refactoring. Do not delete a failing oracle or weaken assertions to conceal a regression. If a test depended on an irrelevant private detail, replace it with equivalent behavioral coverage and explain the relationship.

Missing tests are a risk, not permission for a broad rewrite. Narrow the change, add an appropriate observation or create a test seam before larger surgery. Manual checks can provide bounded evidence when automation is unavailable, but must not be described as executable regression coverage.

## Run and report honestly

Run the checks applicable to the changed contracts. Investigate flaky, ignored or skipped tests instead of counting them as passes. Keep expensive environment-dependent checks distinguishable from fast feedback, without silently skipping an applicable delivery gate. A configured command, test source or reviewer agreement is not an observed execution.

Report exact commands, results, failures and boundaries not exercised. Distinguish a fixture's engine conformance from live-provider behavior and deployment qualification. See [Coding Conventions](../conventions.md) for task modes and required evidence and [Project Standards](../../architecture/project-standards.md#task-completion-protocol) for completion gates.
