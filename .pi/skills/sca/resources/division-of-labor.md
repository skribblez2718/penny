<!--
════════════════════════════════════════════════════════════════════════════
MIGRATION NOTE (sca Phase 11) — reconciled against the ACTUALLY-BUILT skill.

This file was migrated from the original `code-analysis` bundle
(reference/division-of-labor.md). The bundle described a BASH-SCRIPT design.
The sca skill was actually built as a resumable **Python FSM** (orchestrate.py +
fsm.py). The DIVISION-OF-LABOR PHILOSOPHY below (tools do recall; AI does
judgment and reach; the augmentation loop) carried over faithfully and is
authoritative. The concrete mappings below are reconciled against the real
PHASE_AGENT table (orchestrate.py) and the real tool_manifest.py:

  Real per-phase agents (orchestrate.py PHASE_AGENT):
    P0_CHARTER, P1_CENSUS        -> echo
    P2_BASELINE_SCAN             -> annie
    P3_CONTEXT, P4_ARCHITECTURE, P5_REQUIREMENTS -> synthia
    P6_THREAT_MODEL              -> tabitha
    P7_TARGETED_SCAN, P8_TRIAGE, P9_DEEP_DIVE -> annie
    P10_VERIFICATION, P11_FIX_VERIFICATION    -> vera
    P12_REPORT                   -> skribble
    (report review) carren

  Real augmentation loop: P9_DEEP_DIVE -> P7_TARGETED_SCAN, with an ENFORCED
    cap of 3 rounds (not an open-ended "runs every time" loop).

  Real human gates (6): AFTER P0, P3, P6, P8; BEFORE P10; AT P12. Note the
    bundle text below lists only 5 (P0/P6/P8/P10/P12) and omits P3_CONTEXT.

  Real tool registry (tool_manifest.py): npm audit is DELIBERATELY and
    PERMANENTLY EXCLUDED (subsumed by osv-scanner) — see the inline callout
    below where the bundle lists it.
════════════════════════════════════════════════════════════════════════════
-->

# Division of Labor & the Augmentation Cycle

This is the spine of `code-analysis`. The goal is **AI augmenting humans and
deterministic tools — never replacing either.** Use each component only for what
it is actually good at.

## The core asymmetry

**Deterministic tools (SAST/SCA/secrets/IaC)** are reliable, repeatable, and scale
to huge codebases — but they are confined to a *fixed, static rule set*. They have
high recall on the patterns they know and **zero** ability to reason about anything
they don't.

**AI** has effectively unbounded detection scope and can reason about context,
intent, and business logic — but it is *unreliable at scale* (finite context, can
miss instances, can hallucinate) and is **not** a dependable way to exhaustively
sweep a large codebase.

So: **let tools do recall; let AI do judgment and reach.** If you want to know
*whether* a class of bug exists or *why* a candidate is real, ask the AI. If you
want to know *everywhere* it exists, have the AI write a rule and run a tool.

## Who owns what

| Task | Primary owner | Why |
|---|---|---|
| Find every instance of a known-bad pattern | Tools (Semgrep, njsscan, CodeQL) | Exhaustive, deterministic, repeatable |
| Breadth across dependencies | SCA (osv-scanner, Trivy, retire.js) | Nobody reads `node_modules` by hand |
| Secrets across full git history | gitleaks, trufflehog | Regex + entropy + live verification |
| Decide if a tool finding is a true/false positive | AI (read surrounding code) + tests | Needs context the tool lacks |
| Trace a specific source→sink path, judge reachability | AI (Semgrep/CodeQL taint to confirm) | Reasoning over a candidate, not a sweep |
| Novel logic flaws (IDOR, authz, business abuse, races) | AI + human | Tools are nearly blind here |
| Turn a discovered pattern into recall | AI authors a rule; tool runs it | AI gains recall by *writing checks*, not re-reading |
| Prioritize by business impact | AI + human (from context) | "Which of 400 findings matter to *this* business?" |
| Final risk acceptance | Human | Accountability does not delegate |

> **[sca divergence]** The bundle's original row listed **`npm audit`** among the
> SCA tools. The built skill's `tool_manifest.py` **deliberately and permanently
> excludes npm audit** — its advisory coverage is subsumed by `osv-scanner`, and
> no code path in the skill invokes it (rationale recorded in `NOTICE`). The row
> above has been corrected to drop it.

## The augmentation cycle (the closed loop)

This is the mechanism by which tools and AI improve each other.

> **[sca divergence]** The bundle described this as running "every time through
> Phases 2 → 6/7 → 8 → 9 and back." The built FSM implements a narrower,
> **bounded** loop: **`P9_DEEP_DIVE → P7_TARGETED_SCAN`** (re-run authored rules
> against newly discovered targets), with an **enforced cap of 3 rounds** of
> security hardening. P2's scanning infrastructure is reused by P7 (a re-entrant
> custom-rules hook), so the "author a rule, re-run tools" step below is real —
> but it does not loop unbounded.

```
   ┌─────────────────────────────────────────────────────────────────┐
   │                                                                   │
   ▼                                                                   │
[1] TOOLS scan the whole codebase (deterministic recall)               │
    → emit findings with exact file:line                               │
        │                                                              │
        ▼                                                              │
[2] AI reads the surrounding code for CONTEXT and writes a TEST        │
    → decides true positive vs false positive (evidence-bound)         │
        │                                                              │
        ▼                                                              │
[3] AI explores adjacent code the tool's rules can't model             │
    → finds variants / new patterns / logic flaws                      │
        │                                                              │
        ▼                                                              │
[4] AI AUTHORS A NEW DETERMINISTIC RULE for each new pattern           │
    (Semgrep YAML / CodeQL query) ─────────────────────────────────────┘
    → re-run tools to get recall on it across ALL repos, then re-triage
```

Each turn: the tools give the AI precise, scalable starting points; the AI gives
the tools new rules and judgment they structurally lack. Recall improves
(new rules), precision improves (triage kills noise), and coverage compounds.

## Practical rules this implies

- **Never ask the AI to be `grep`.** Don't have it "scan the whole repo for X" —
  write a Semgrep rule and run it. The AI's job is the *next* layer: is this real,
  why, and what did the rule miss.
- **Never trust tools for completeness.** A clean scan is not a clean bill of
  health; tools have false negatives. Phase 9 (deep dive) exists for what they miss.
- **Every AI claim is evidence-bound.** A verdict cites real `file:line` and a
  traced path, or it doesn't count. A "false positive" must name the specific
  mitigating control and its location.
- **Capture AI judgment as durable assets.** A discovered pattern becomes a
  committed Semgrep rule; a confirmed bug gets a regression test. One-time thoughts
  become repeatable checks.
- **Humans gate the expensive/irreversible decisions.**

> **[sca divergence]** The bundle listed 5 gates: scope (P0), priorities (P6),
> triage trust (P8), verification scope (P10), risk acceptance (P12). The built
> skill has **6 human gates**: AFTER **P0**, **P3** (context), **P6**, **P8**;
> BEFORE **P10**; AT **P12**. The P3_CONTEXT gate (business/domain context
> sign-off) was added during the build and is enforced in `orchestrate.py`
> (`GATE_AFTER`/`GATE_BEFORE`/`GATE_AT`). All 6 gates were additionally hardened
> against two real gate-bypass vulnerability classes found and fixed pre-Phase-9.
