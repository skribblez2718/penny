---
description: Bitter Lesson alignment audit of a skill — goal, for/against, violations, upgrade plan
argument-hint: "<skill-name>"
---

Perform a Bitter Lesson alignment audit of the **$1** skill and deliver: the skill's inferred ultimate goal, what is working for and against that goal, every violation of Bitter Lesson engineering, and a comprehensive upgrade plan that makes the skill more flexible to future improvements in the models we use.

If the skill name argument is missing, or `.pi/skills/$1/` does not exist, stop and ask which skill to audit before doing anything else.

**Phase 1 — Ground the rubric.** Deeply study Richard Sutton's "The Bitter Lesson" (fetch http://www.incompleteideas.net/IncIdeas/BitterLesson.html and read it in full). From it, distill a written rubric for how the essay applies to overengineering in AI and coding harnesses — specifically: which kinds of mechanisms leverage computation (search, learning, iteration, verification) and gain value as models improve, versus which bake in human knowledge (hardcoded heuristics, keyword lists, thresholds, mandated procedural steps, rigid phase structures) and age into liabilities. State the rubric explicitly before applying it — every violation called in Phase 3 must cite which rubric point it fails.

**Phase 2 — Read all of it before assessing** (paths relative to the penny repo root):

- Every file under `.pi/skills/$1/` — `SKILL.md`, `README.md`, `scripts/orchestrate.py`, everything in `assets/`, and everything in `resources/`
- The shared Python orchestration framework the skill runs on (`apps/orchestration/`), to the depth needed to understand how this skill's phases, gates, and agents actually execute

**Phase 3 — Deliver, in this structure:**

1. **Inferred ultimate goal** — one or two paragraphs characterizing what the skill ultimately exists to accomplish (the outcome it produces, not a restatement of its phase list), citing the specific files/passages that evidence that reading.
2. **Working FOR the goal** — a list; each item names the mechanism, the file(s) it lives in, and how it advances the goal.
3. **Working AGAINST the goal** — a list; each item names the friction or contradiction, the file(s) it lives in, the evidence (quoted or referenced passage/code), and the direction of a fix. Misalignment *between* components (prompts vs. orchestrator vs. templates vs. README) counts.
4. **Bitter Lesson violations** — every place the skill or its orchestration bakes in human knowledge where computation plus verification could do the job. Per violation: the mechanism, the file and passage/code, which rubric point it fails, the capability it currently provides, and why it will lose value as models improve. Be exhaustive — cover prompts, orchestrator code, gates, templates, and configuration.
5. **Upgrade plan** — a comprehensive, prioritized plan for making the skill more flexible to future model improvements. Per item: the violation(s) it addresses, the proposed replacement (prefer verified iteration, search, and evidence checks over procedure), the capability that must not regress and how that would be verified after the change (ratchet on capabilities, never on implementations), the risk level, and whether the change is reversible. Order the plan so the highest leverage, lowest-risk changes come first.

**Branch conditions (choose exactly one path):**

- **Goal unclear:** If you cannot state a single clear ultimate goal for the skill, or its components imply conflicting goals, STOP after Phase 2 and interview me instead — targeted, specific questions, each tied to a concrete ambiguity you found, with the conflicting evidence cited — so we can get everything pulling in the same direction. Do not guess at the goal and proceed.
- **Fully aligned:** If after the full review everything is pulling in the same direction and no Bitter Lesson violations or improvements are warranted, say exactly that. Empty "working against" and "violations" lists are legitimate results — do not invent findings to appear thorough.
- **Otherwise:** deliver all five sections.

**Constraints:**

- Analysis and plan only — do not modify any files in `.pi/skills/$1/` or `apps/orchestration/`.
- Every claim about the skill's behavior must be grounded in a specific file or code passage. Mark anything you could not confirm as [UNVERIFIED].
- Do not audit other skills except where the $1 skill directly depends on them; note shared-framework findings (`apps/orchestration/`) in a clearly separated subsection, since fixes there affect every skill.
- If the essay URL cannot be fetched, say so and stop — do not audit against a rubric built from memory alone.

**Done when:** the response contains the stated rubric, the inferred goal with evidence, all four assessment/plan sections (or stated-empty lists), with every item traceable to a file — or, on the unclear-goal path, the interview questions have been asked instead.
