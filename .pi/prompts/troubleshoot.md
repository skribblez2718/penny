---
description: Diagnose a reported problem, map its full impact, and propose a coherent evidence-backed fix (read-only)
argument-hint: '"<problem-report>" [context...]'
---

# Troubleshoot a Reported Problem

Troubleshoot the following user report about a problem, error, warning, symptom, unexpected message, or unexpected behavior in the current project or system context:

**Problem report:**

$ARGUMENTS

Treat visible line breaks and indentation in the expanded report as significant. To preserve them, the caller must supply a multiline report as one quoted argument; Pi normalizes whitespace between unquoted arguments. Do not infer formatting that is not visible. When exact formatting is decision-relevant and absent, ask for a quoted report or a readable local log path.

If the input is empty or does not describe the observed problem well enough to investigate, ask only for the missing problem description, exact message (if any), reproduction context, or decision-relevant facts. Do not guess. If the reported behavior is intended, expected, or harmless, explain that with evidence rather than inventing a defect or fix.

Produce a response-only diagnosis and an implementation-ready fix proposal. Do not edit files, install dependencies, change state, or perform external actions. You may inspect relevant evidence and run a check only when its side effects are understood and it will not modify the target or external state. Redact credentials, personal data, and other sensitive values from the response and recorded commands.

## Required result

Establish the intended behavior from the most authoritative available project or system evidence, then distinguish it from the reported behavior. Ground material claims in re-checkable evidence such as file paths and symbols, logs, traces, command results, tests, documentation, or current authoritative sources. Separate observed facts from inference, assumptions, and unknowns. Never present a familiar failure pattern as the cause without evidence from this system.

Identify the root cause and its causal path to the reported behavior, including material contributing conditions. State whether the cause is demonstrated or remains the best-supported hypothesis. If the available evidence cannot support a root cause, return an inconclusive diagnosis and propose the smallest, highest-information checks needed to discriminate among the remaining explanations; do not fabricate certainty.

Trace the problem through the system's actual dependency, data, and control relationships. Report every verified component or user-visible surface the problem affects, what happens there, why it is affected, and the supporting evidence. Adapt component boundaries to the system. Distinguish verified impact from plausible blast radius, record material coverage gaps, and claim exhaustive coverage only when the inspected surface supports it.

Propose one integrated fix that addresses the cause rather than only suppressing the symptom. Anchor it to the intended user-visible outcome and authoritative contracts or invariants. Preserve capabilities that already work. For every component the fix would directly or indirectly affect, include the required correction or adjustment, compatibility or migration consequences, meaningful risks, and how that component will remain aligned with the same intended behavior. Do not leave stale implementations, interfaces, configuration, tests, documentation, or operational paths pointing in a conflicting direction when evidence shows they must change.

Define evidence that would prove the diagnosis and fix: reproduction of the original problem, checks of the causal mechanism, acceptance of the corrected behavior, and regression coverage for affected capabilities. Clearly separate checks actually run and their observed results from checks merely proposed. Prefer reversible changes and include rollback or containment when it materially reduces risk.

## Response structure

1. **Bottom line** — what the reported problem means, whether it represents a defect, the root-cause status, and the practical consequence.
2. **Evidence-backed diagnosis** — expected versus observed behavior, causal explanation, material alternatives, and unknowns.
3. **Current impact map** — each affected component or surface, its role, impact, evidence status, and any coverage gap.
4. **Integrated fix proposal** — the behavioral correction plus every component-specific adjustment needed to keep the system coherent, including fix-impact and compatibility risks.
5. **Verification and next action** — what was inspected or run, observed results, the exact proof needed after implementation, rollback/containment if applicable, and any genuinely blocking question.

Completion means the response accounts for the supported causal chain, current blast radius, fix blast radius, cross-component adjustments, capability preservation, and proof plan without claiming unverified investigation or implementation.
