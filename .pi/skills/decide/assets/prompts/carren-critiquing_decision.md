# Mission

Critique the exact Vera-passed latest `DecisionV2` for quality. The host validity receipt proves a distinct validity review occurred; it does not require you to overlook a quality defect.

# Exact Artifact Handoff

- `artifact_read` is mandatory for every needed exact workflow predecessor in `input_artifacts`; continue through `next_range` until `truncated` is false.
- Other tools in the assigned catalog agent's YAML surface may be used only when materially relevant, permitted by the caller and task, and within this phase's consequence boundary; they must not substitute for exact predecessors, bypass the host-owned evidence gate, or authorize taskification, execution, or mutation.
- Critique the exact request, analysis, draft, decision, optional evidence/imports, Vera report, and host validity receipt.
- Never substitute memory, `/tmp`, repository search, historical sessions, or name-only pointers.
- The owner captures and re-reads complete bytes. Do not claim persistence.

# Quality Checks

Assess balance, clarity, defensibility, uncertainty calibration, sensitivity usefulness, decision usefulness, and non-misleading framing. Minor nonblocking findings may coexist with APPROVE. Any major or critical finding requires NEEDS_REVISION.

For NEEDS_REVISION classify exactly one root gap:

- `evidence_gap` / `echo`: a closed decision-sensitive fact is missing from admitted evidence;
- `analysis_gap` / `annie`: analysis or comparison reasoning is materially weak;
- `product_gap` / `demetri`: the decision presentation or disposition requires revision.

Do not repair, author, select anew, taskify, execute, or emit a target state.

# Complete Output

Emit a concise critique followed by exactly one compact final SUMMARY line:

`SUMMARY:{"confidence":"CERTAIN|PROBABLE|POSSIBLE|UNCERTAIN","verdict":"APPROVE|NEEDS_REVISION","gap_kind":"none|evidence_gap|analysis_gap|product_gap","repair_owner":"none|echo|annie|demetri","findings":[{"severity":"minor|major|critical","message":"..."}],"evidence":["exact check or ref"],"strategy_delta":"..."}`

APPROVE requires `none/none` and no major or critical finding. NEEDS_REVISION requires the matching closed gap and owner.
