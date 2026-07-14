# Prompt Architecture Evidence Base

What the 2024–2026 empirical literature actually supports, what it debunks, and which of Penny's design principles are evidence-backed versus house hypotheses awaiting our own measurement. Compiled 2026-07 from the sources in [References](#references). Local measurement lives in the prompt-efficacy eval (`scripts/system/evals/README.md`, north star N6).

## Evidence tiers used across the prompt docs

| Tag | Meaning |
|-----|---------|
| **[EVIDENCE]** | Replicated, cross-model published results support it |
| **[HYPOTHESIS]** | Plausible, internally consistent, but not established in the literature — must earn its place through the prompt-efficacy eval (section ablation) |
| **[DEBUNKED-ADJACENT]** | The nearby popular claim failed replication; our usage survives only in a narrower form |

## Per-technique verdicts (the short version)

| Technique | Verdict | What the numbers say |
|-----------|---------|----------------------|
| Chain-of-thought prompting | Robust but narrow | +12–14 pts on math/symbolic, **+0.7 pts on everything else** (meta-analysis of 1,218 comparisons); near-zero to negative on reasoning-native models, which all vendors say not to CoT-prompt |
| Self-consistency (vote over samples) | Robust, diminishing | +4–18 pts at 10–40× cost on older models; gains shrink as base accuracy rises |
| Clear, complete, specific instructions | Robust | The one intervention that helps everywhere; wording/format idiosyncrasies swamp technique choice in the Prompt Report's own case studies |
| Position (front-load / end-load critical content) | Robust | U-shaped attention ("lost in the middle") replicates broadly |
| Light structural delimiting (tags/headers when mixing content types) | Robust as hygiene | Reduces misinterpretation; **no universally best format exists** — best format is model-specific |
| Structured output (JSON mode) | Mixed | Neutral to +4% with matched prompts and reasoning-before-answer field order; naive answer-only schemas genuinely hurt weak models |
| Persona/role prompting for accuracy | Debunked | 162 personas × 4 model families: no gain, per-persona effects "largely random"; 9 significant *decreases* across 6 frontier models |
| Emotional appeals, politeness, tips/threats | Debunked | Null aggregate effects with huge per-question variance — a lottery ticket, not a lever |
| Intrinsic self-correction ("review your answer") | Debunked without external feedback | GPT-4 *lost* 4 pts on GSM8K after self-review; no prior work shows successful intrinsic self-correction |
| Prompt transfer across models | Strongly negative | Best-format overlap across families IoU < 0.2; optimized prompts lose ~6–11 pts absolute when ported; format choice alone swings results up to 76 pts |
| Automatic per-model prompt optimization (DSPy/MIPRO/GEPA-style) | Robust when an eval metric exists | Reliably beats expert hand-tuning; gains are model-specific by construction |

## What this means for Penny's goal

The strong form of "one universal prompt that adds points on any model" is **not supported** — prompts are model-specific artifacts. The defensible reframe, which the architecture now adopts ([Overview](overview.md)):

1. **The universal layer raises the floor and cuts variance.** Completeness, explicitness, non-contradiction, position, and structural hygiene are the cross-model survivors. They mostly prevent losses; they are not where double-digit gains live.
2. **Points come from per-model work**: per-model variants of the swappable layers (Role Definition, Domain Guidance) optimized against the golden task set, plus invocation-parameter tuning. See `plans/per-model-optimization/`.
3. **Task-specification quality is the best-evidenced universal lever** — which is what the Enhance extension targets (Invocation Context enhancement).
4. **Every claim gets measured here.** Single-to-double-digit gains claimed for any universal technique should be presumed to be (a) measured on pre-2024 base models, (b) cherry-picked from the best variant, or (c) per-question variance masquerading as signal — until shown otherwise on our own task set across ≥3 model families.

## Status of Penny's design principles

| Principle ([Design Principles](design-principles.md)) | Status | Basis |
|---|---|---|
| §1 Process-shaped, not output-shaped | **[HYPOTHESIS]** | Consistent with instruction-following findings (specific instructions beat aspirations), but "process-shaped beats output-shaped" as stated has no direct published test. Section ablation target. |
| §1 Before Responding protocol (mandatory cognitive steps) | **[DEBUNKED-ADJACENT]** | Prescriptive step scaffolds are the technique class that goes neutral-to-negative on reasoning-native models. Resolution: the six-step sequence was moved out of the always-on frame entirely — it survives as the *on-demand* clarification protocol, loaded only when the Ask vs. Act trigger fires; the frame keeps single lightweight directives. Monitored per family by the degradation gate (`prompt_efficacy.frame_regressed_families`). |
| §2 Domain-agnostic agents (constraints, tools, output contracts) | **[EVIDENCE]** for the constraints; **[DEBUNKED-ADJACENT]** for any accuracy expectation from identity itself | Personas-for-accuracy is debunked; functional role *constraints* are engineering, not persona magic. Do not expect "You are Carren" to add points. |
| §5 No repetition across layers / no contradiction | **[EVIDENCE]** (contradiction harms); token thrift is engineering |
| §6 Canonical vocabulary | **[HYPOTHESIS]** | Related to format-sensitivity findings (models are sensitive to surface variation), but the specific claim (synonym drift degrades performance) is untested. Ablation target. |
| §7 Declarative rules, not narrative | **[HYPOTHESIS]** | Same family as §1. |
| §9 Self-verification as structured attention, NOT a correctness audit | **[EVIDENCE]** for the framing | Intrinsic self-correction is debunked (models are poor at catching their own errors) — which is exactly why the frame demands *external anchors* (evidence-backed completion, honest exhaustion, the one-line Deliver check) instead of self-critique, and why correctness review routes to a different model (Carren/Vera). |
| §10 Concrete verbs, not nominalizations | **[HYPOTHESIS]** | No direct literature. Cheap to keep; not a claimed performance lever until measured. |
| Token budgets as forcing function (not a model limit) | **[EVIDENCE]** for the honest framing | No hard adherence cliff at small counts; long-context degradation is positional and much higher-scale ("lost in the middle", context-rot reports). |
| Sandwich defense / boundary markers | Security engineering | Defense-in-depth; instruction-hierarchy adherence is imperfect in all models (IHEval) — the docs already say markers are structural, not psychological. |

## References

1. Sprague et al., *To CoT or not to CoT? Chain-of-thought helps mainly on math and symbolic reasoning*, ICLR 2025. arXiv:2409.12183.
2. Schulhoff et al., *The Prompt Report: A Systematic Survey of Prompting Techniques*, arXiv:2406.06608.
3. Sclar et al., *Quantifying Language Models' Sensitivity to Spurious Features in Prompt Design (FormatSpread)*, ICLR 2024. arXiv:2310.11324.
4. Mizrahi et al., *State of What Art? A Call for Multi-Prompt LLM Evaluation*, TACL 2024. arXiv:2401.00595.
5. Zheng et al., *When "A Helpful Assistant" Is Not Really Helpful: Personas in System Prompts Do Not Improve Performance*, EMNLP 2024 Findings. arXiv:2311.10054.
6. Huang et al., *Large Language Models Cannot Self-Correct Reasoning Yet*, ICLR 2024. arXiv:2310.01798.
7. Kamoi et al., *When Can LLMs Actually Correct Their Own Mistakes?*, TACL 2024. arXiv:2406.01297.
8. Vaugrante et al., *A Looming Replication Crisis in Evaluating Behavior in Language Models?*, TMLR 2025. arXiv:2409.20303 (EmotionPrompt, ExpertPrompting, Re-Reading fail replication).
9. Meincke, Mollick et al., *Prompting Science* reports 1–5, Wharton Generative AI Labs, 2025–2026. arXiv:2503.04818, 2506.07142, 2508.00614, 2512.05858 (CoT's shrinking value; politeness/tips/threats null with high per-item variance; personas on frontier models).
10. Liu et al., *Lost in the Middle: How Language Models Use Long Contexts*, TACL 2024. arXiv:2307.03172.
11. Opsahl-Ong et al., *Optimizing Instructions and Demonstrations for Multi-Stage Language Model Programs (MIPROv2)*, EMNLP 2024. arXiv:2406.11695; Yang et al., *Large Language Models as Optimizers (OPRO)*, arXiv:2309.03409.
12. He et al., *Does Prompt Formatting Have Any Impact on LLM Performance?*, arXiv:2411.10541 (best-format overlap across families IoU < 0.2).
13. Tam et al., *Let Me Speak Freely?* arXiv:2408.02442, with the dottxt reanalysis (structured-output harms were confounded); JSONSchemaBench, arXiv:2501.10868.

## Keeping this honest

When a claim in any prompt doc is upgraded from [HYPOTHESIS] to [EVIDENCE], the upgrade must cite either a published replication or our own prompt-efficacy result (artifact path + date). The reverse also applies: if section ablation shows a principle's text is dead weight across families, the principle loses its budget allocation — the eval decides, not the doc.
