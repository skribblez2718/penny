# Diagnosis and Performance

## Applies when

Investigating a defect, unexplained behavior, intermittent failure, latency, throughput or resource-cost problem, or proposing an optimization.

## Diagnose from observations

State the symptom, expected contract, environment and available evidence. Reproduce with a controlled case when possible; preserve the smallest input and state that still exhibit the failure. Collect actual outputs, logs or traces before treating an explanation as fact. Separate observations from hypotheses and unknowns.

Use a debugger, tracing, differential run or targeted instrumentation to isolate where reality first differs from the contract. Choose a check that discriminates competing explanations. Change one relevant condition when that makes the comparison interpretable. Do not blame a compiler, library, operating system or network merely because it is unfamiliar.

Investigate the causal chain, not only the final exception. A queue timeout may originate in saturation elsewhere; a parsing error may follow an earlier schema mismatch. An absent error message is not evidence of success. Preserve useful diagnostic context while keeping secrets and unnecessary sensitive data out of logs and reports.

Fix the root cause within the authorized boundary where practical. A local containment may be safer when a broader correction needs separate scope; state the remaining cause and limitation. Add a regression oracle that would detect the observed defect. Re-run the reproducer and applicable surrounding checks, not just the newly added test.

For intermittent failures, examine schedules, shared state, timing, cleanup and environmental assumptions. Vary relevant concurrency or platform conditions when feasible. Do not dismiss a spurious failure without an explanation or represent a clean rerun as proof that a race is absent.

## Optimize a demonstrated problem

Define the workload and target before tuning: representative inputs, request rate, data size, access pattern, latency distribution, throughput, memory or downstream cost. A count of machines or a small average latency does not identify a bottleneck. Include tail latency, contention, saturation and growth behavior where they matter.

Measure a baseline with an appropriate profiler or experiment. Distinguish algorithmic growth from constant costs, I/O from computation and cold from warm state. State the measurement environment and uncertainty. Optimize the constrained path rather than rewriting everything that looks inefficient.

Compare before and after under comparable conditions, including correctness and important edge cases. Preserve semantic guarantees such as ordering, evaluation count, durability and acceptable staleness. Hide justified optimization details behind a stable interface instead of burdening all callers with a fast path's internals.

Do not trade maintainability for an unmeasured benefit. Conversely, do not reject a necessary optimization solely because it is less elegant: name the measured tradeoff and retain tests and an explanation of the constraint. Avoid making a benchmark pass by changing its workload or weakening its oracle.

## Verification limits

A local benchmark establishes behavior under its stated workload, not general scalability or production reliability. A static warning, hypothesis or another model's diagnosis is not causal proof. If reproduction or measurement is unavailable, report the supported partial finding and a discriminating next check rather than inventing a result.
