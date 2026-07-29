#!/usr/bin/env python3
"""
scaffold-skill.py — Scaffold a new Penny skill on the shared orchestration engine.

Usage:
    python scripts/tools/scaffold-skill.py --name weather-analysis \
        --description "Analyze weather data and generate reports" \
        --agents echo,piper,vera

Every Penny skill has two homes:

1. A ``BasePlaybook`` subclass in the installed ``orchestration`` package — the
   single source of truth for states, transitions, gates, and routing:

       apps/orchestration/src/orchestration/playbooks/<name>.py
       apps/orchestration/tests/test_<name>_playbook.py

   This scaffolder registers the new playbook in
   ``apps/orchestration/src/orchestration/playbooks/__init__.py`` automatically
   (idempotent — safe to re-run).

2. A skill directory that holds the manifest, a thin delegate, domain-guidance
   prompts, and resources:

    .pi/skills/weather-analysis/
    ├── SKILL.md                    # metadata.penny.engine: orchestration
    ├── README.md
    ├── scripts/
    │   └── orchestrate.py          # 5-line delegate — NO FSM logic
    ├── assets/
    │   └── prompts/
    │       └── echo.md (and one per other --agents)
    └── resources/
        ├── reference.md
        └── flow.html

The generated playbook is a MINIMAL BUT VALID stub: intake -> one working state
per agent (in the order given by --agents) -> complete, plus the standard
unknown/awaiting_clarification/error escalation states. It is intentionally
linear — replace the routing, add gates/parallel fan-out, and flesh out the
SUMMARY contracts as the skill's real domain logic is designed. Look for the
``# TODO`` markers.

After scaffolding, invoke the plan skill to design the real states/routing, then
edit the generated playbook directly.

MAINTENANCE: When Penny skill conventions change, update the templates in this
file. This file is the single source of truth for skill scaffolding — see
docs/agents/skills/skill-standard.md, skill-md-template.md, and
quick-reference.md for the authoring standard it must stay consistent with.
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import List, Tuple

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
SKILLS_DIR = PROJECT_ROOT / ".pi" / "skills"
PLAYBOOKS_DIR = PROJECT_ROOT / "apps" / "orchestration" / "src" / "orchestration" / "playbooks"
PLAYBOOKS_INIT = PLAYBOOKS_DIR / "__init__.py"
ORCH_TESTS_DIR = PROJECT_ROOT / "apps" / "orchestration" / "tests"

# Standard self-contained flow-diagram skeleton (see docs/agents/skills/flow-diagrams.md).
# Placeholders: __NAME__, __HEIGHT__, __N__ (node data lines), __E__ (edge data lines).
_FLOW_HTML_TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>__NAME__ skill \u2014 execution flow</title>
<style>
  :root{--bg:#0d1117;--panel:#161b22;--panel2:#1c2230;--border:#2a3341;--ink:#e6edf3;--muted:#8b949e;
    --desc:#b3bdc9;--tool:#8b949e;--gate:#e3b341;--esc:#9ca3af;--done:#3fb950;--error:#f85149;
    --fwd:#8b98a9;--exit:#3fb950;--loop:#e3a52e;--abort:#f85149;}
  *{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);
    font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  header{padding:22px 28px 8px}h1{margin:0;font-size:22px}.sub{color:var(--muted);margin-top:4px;font-size:13px}
  #wrap{position:relative;margin:8px 20px 40px;width:1240px;height:__HEIGHT__px}
  svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
  .node{position:absolute;background:var(--panel);border:1px solid var(--border);border-radius:10px;
    box-shadow:0 1px 2px rgba(0,0,0,.35);padding:10px 12px}
  .node .t{font-weight:700;font-size:13.5px;display:flex;align-items:center;gap:7px}
  .node .t .who{font-weight:600;color:var(--muted);font-size:11.5px}
  .node .d{color:var(--desc);font-size:12px;margin-top:5px}
  .node::before{content:"";position:absolute;left:0;top:0;bottom:0;width:5px;border-radius:10px 0 0 10px}
  .node.tool::before{background:var(--tool)}.node.esc::before{background:var(--esc)}
  .node.gate{background:#211d10;border-color:#4d3f1a}.node.gate::before{background:var(--gate)}
  .node.done{background:#0f2417;border-color:#1f5136}.node.done::before{background:var(--done)}
  .node.error{background:#2a1517;border-color:#5c2a2a}.node.error::before{background:var(--error)}
  .node .badge{margin-left:auto;font-size:10px;font-weight:700;text-transform:uppercase;color:#0d1117;
    padding:2px 6px;border-radius:999px}.badge.hitl{background:var(--gate)}.badge.term{background:#5b6675;color:#e6edf3}
  .lbl{position:absolute;transform:translate(-50%,-50%);background:var(--panel2);border:1px solid #313c4a;
    color:#c9d3df;font-size:11px;padding:1px 6px;border-radius:999px;white-space:nowrap}
  .foot{margin:0 28px 48px;font-size:12.5px;color:#c3cdd9}code{background:#22293a;color:#cdd6e3;padding:1px 5px;border-radius:4px}
</style></head><body>
<header><h1>__NAME__ skill \u2014 execution flow</h1>
<div class="sub">Validated against <code>orchestration/playbooks/__NAME__.py</code>. TODO: fill node/edge descriptions.</div></header>
<div id="wrap"><svg id="edges"><defs>
  <marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
    <path d="M0,0 L8,3 L0,6 Z" fill="context-stroke"></path></marker></defs></svg></div>
<div class="foot">
  <p>The uniform <code>abort \u2192 error</code> (every non-final state) and <code>escalation \u2192 unknown</code>
  (every agent state) seams are collapsed into this note and NOT drawn, per the standard.</p>
</div>
<script>
const COLS = { Louter:30, C:470, Router:960 };
const W = { C:300, side:250 };
const N = {
__N__
};
const E = [
__E__
];
const KIND = {fwd:'#8b98a9',exit:'#3fb950',loop:'#e3a52e',esc:'#9ca3af',abort:'#f85149'};
const wrap=document.getElementById('wrap'), svg=document.getElementById('edges');
for(const id in N){const n=N[id];const w=(n.col==='C')?W.C:W.side;
  const el=document.createElement('div');el.className='node '+n.cls;el.id='n_'+id;
  el.style.left=COLS[n.col]+'px';el.style.top=n.y+'px';el.style.width=w+'px';
  const who=n.who?`<span class="who">\u00b7 ${n.who}</span>`:'';
  const badge=n.badge?`<span class="badge ${n.badge==='TERM'?'term':'hitl'}">${n.badge}</span>`:'';
  el.innerHTML=`<div class="t">${n.title}${who}${badge}</div><div class="d">${n.desc}</div>`;
  wrap.appendChild(el);}
const base=wrap.getBoundingClientRect();
function rect(id){const r=document.getElementById('n_'+id).getBoundingClientRect();
  return{left:r.left-base.left,top:r.top-base.top,width:r.width,height:r.height};}
function anchor(r,s){switch(s){case'top':return{x:r.left+r.width/2,y:r.top};
  case'bottom':return{x:r.left+r.width/2,y:r.top+r.height};case'left':return{x:r.left,y:r.top+r.height/2};
  case'right':return{x:r.left+r.width,y:r.top+r.height/2};}}
function ctrl(p,s,b){const k=64;b=b||0;switch(s){case'top':return{x:p.x+b,y:p.y-k};
  case'bottom':return{x:p.x+b,y:p.y+k};case'left':return{x:p.x-k-Math.abs(b),y:p.y};
  case'right':return{x:p.x+k+Math.abs(b),y:p.y};}}
const SVGNS='http://www.w3.org/2000/svg';
for(const e of E){const ra=rect(e.from),rb=rect(e.to);const p1=anchor(ra,e.s1),p2=anchor(rb,e.s2);
  const c1=e.c1?{x:p1.x+e.c1.dx,y:p1.y+e.c1.dy}:ctrl(p1,e.s1,e.bow);
  const c2=e.c2?{x:p2.x+e.c2.dx,y:p2.y+e.c2.dy}:ctrl(p2,e.s2,e.kind==='exit'?-(e.bow||0):e.bow);
  const path=document.createElementNS(SVGNS,'path');
  path.setAttribute('d',`M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`);
  path.setAttribute('fill','none');path.setAttribute('stroke',KIND[e.kind]);
  path.setAttribute('stroke-width','2');path.setAttribute('marker-end','url(#ah)');
  if(e.kind==='esc')path.setAttribute('stroke-dasharray','6 5');svg.appendChild(path);
  if(e.label){const t=0.5,mt=1-t;
    const x=mt*mt*mt*p1.x+3*mt*mt*t*c1.x+3*mt*t*t*c2.x+t*t*t*p2.x;
    const y=mt*mt*mt*p1.y+3*mt*mt*t*c1.y+3*mt*t*t*c2.y+t*t*t*p2.y;
    const l=document.createElement('div');l.className='lbl';l.textContent=e.label;
    l.style.left=x+'px';l.style.top=y+'px';wrap.appendChild(l);}}
</script></body></html>
"""


# ============================================================
# Identifier helpers
# ============================================================


def _sanitize_ident(s: str) -> str:
    """Lowercase, underscore-separated Python identifier from arbitrary text."""
    ident = re.sub(r"[^0-9A-Za-z_]+", "_", s).strip("_").lower()
    if not ident:
        ident = "x"
    if ident[0].isdigit():
        ident = f"_{ident}"
    return ident


def _pascal_case(s: str) -> str:
    """PascalCase class-name fragment from arbitrary text (kebab/snake/space)."""
    parts = re.split(r"[^0-9A-Za-z]+", s)
    return "".join(p[:1].upper() + p[1:] for p in parts if p)


def _or_chain(parts: List[str], indent: str = "        ") -> str:
    """Render a python-statemachine ``a.to(x) | b.to(x) | ...`` chain, matching
    the wrapped-parens style used in playbooks/code.py and playbooks/plan.py."""
    lines = [f"{indent}{parts[0]}"]
    for p in parts[1:]:
        lines.append(f"{indent}| {p}")
    return "(\n" + "\n".join(lines) + "\n    )"


# ============================================================
# Playbook registration (idempotent insertion into __init__.py)
# ============================================================


def register_playbook(Name: str, module_name: str) -> bool:
    """Insert the import + PLAYBOOKS entry + __all__ entry for ``<Name>Playbook``
    into playbooks/__init__.py. Returns False (no-op) if already registered."""
    text = PLAYBOOKS_INIT.read_text(encoding="utf-8")
    playbook_cls = f"{Name}Playbook"
    if playbook_cls in text:
        return False  # idempotent — already registered

    import_line = f"from .{module_name} import {playbook_cls}"
    lines = text.split("\n")
    import_idxs = [i for i, ln in enumerate(lines) if ln.startswith("from .")]
    if not import_idxs:
        raise RuntimeError(f"could not find a playbook import block in {PLAYBOOKS_INIT}")
    lines.insert(import_idxs[-1] + 1, import_line)
    text = "\n".join(lines)

    dict_match = re.search(
        r"(PLAYBOOKS: dict\[str, type\[BasePlaybook\]\] = \{\n)(.*?)(\n\})", text, re.DOTALL
    )
    if not dict_match:
        raise RuntimeError(f"could not find the PLAYBOOKS dict in {PLAYBOOKS_INIT}")
    text = (
        text[: dict_match.start()]
        + dict_match.group(1)
        + dict_match.group(2)
        + f"\n    {playbook_cls}.NAME: {playbook_cls},  # domain skill (scaffolded)"
        + dict_match.group(3)
        + text[dict_match.end() :]
    )

    all_match = re.search(r"(__all__ = \[\n)(.*?)(\n\])", text, re.DOTALL)
    if not all_match:
        raise RuntimeError(f"could not find __all__ in {PLAYBOOKS_INIT}")
    text = (
        text[: all_match.start()]
        + all_match.group(1)
        + all_match.group(2)
        + f'\n    "{playbook_cls}",'
        + all_match.group(3)
        + text[all_match.end() :]
    )

    PLAYBOOKS_INIT.write_text(text, encoding="utf-8")
    return True


def register_skill_rooms(name: str) -> None:
    """Register a new skill's MemPalace footprint in the retention manifest so its
    scratch auto-decays from day one. Scaffolded skills use the penny-wing
    convention (``skills/<name>-<session_id>``), already covered by the archiver's
    ``penny/skills/`` base rule. A skill that instead needs a DEDICATED wing must
    edit its manifest entry to ``convention: dedicated-wing`` (see the manifest
    _comment for the shape). Idempotent; best-effort."""
    manifest = PROJECT_ROOT / "scripts" / "system" / "tiered_memory" / "skill_rooms.json"
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    skills = data.setdefault("skills", {})
    if name not in skills:
        skills[name] = {"convention": "penny-wing"}
        manifest.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


# ============================================================
# Scaffolder
# ============================================================


class SkillScaffolder:
    def __init__(self, name: str, description: str, agents: List[str]):
        self.name = name
        self.description = description
        self.agents = agents
        self.Name = _pascal_case(name)
        self.NAME_UPPER = re.sub(r"[^0-9A-Za-z]+", "_", name).strip("_").upper()
        self.module_name = _sanitize_ident(name)
        self.states: List[Tuple[str, str]] = self._compute_states()
        self.playbook_path: Path = PLAYBOOKS_DIR / f"{self.module_name}.py"
        self.test_path: Path = ORCH_TESTS_DIR / f"test_{self.module_name}_playbook.py"

    def _compute_states(self) -> List[Tuple[str, str]]:
        """One working state per --agents entry, in order, deduped if an agent
        name repeats (e.g. --agents echo,echo -> working_echo, working_echo_2)."""
        seen: dict = {}
        states: List[Tuple[str, str]] = []
        for agent in self.agents:
            base = f"working_{_sanitize_ident(agent)}"
            n = seen.get(base, 0)
            seen[base] = n + 1
            state = base if n == 0 else f"{base}_{n + 1}"
            states.append((state, agent))
        return states

    # -- playbook (apps/orchestration) --------------------------------------

    def _build_playbook_source(self) -> str:
        states = self.states
        first_state = states[0][0]
        start_event = f"start_{first_state}"

        state_defs = "\n".join(f"    {s} = State()" for s, _ in states)

        transition_lines = [f"    {start_event} = intake.to({first_state})"]
        for i, (s, _a) in enumerate(states):
            target = states[i + 1][0] if i + 1 < len(states) else "complete"
            transition_lines.append(f"    {s}_done = {s}.to({target})")
        transitions_block = "\n".join(transition_lines)

        to_unknown_val = _or_chain([f"{s}.to(unknown)" for s, _ in states])
        abort_parts = (
            ["intake.to(error)"]
            + [f"{s}.to(error)" for s, _ in states]
            + ["unknown.to(error)", "awaiting_clarification.to(error)"]
        )
        abort_val = _or_chain(abort_parts)

        machine_src = (
            f"class {self.Name}Machine(StateMachine):\n"
            f"    intake = State(initial=True)\n"
            f"{state_defs}\n"
            f"    unknown = State()\n"
            f"    awaiting_clarification = State()\n"
            f"    complete = State(final=True)\n"
            f"    error = State(final=True)\n"
            f"\n"
            f"{transitions_block}\n"
            f"\n"
            f"    to_unknown = {to_unknown_val}\n"
            f"    escalate = unknown.to(awaiting_clarification)\n"
            f"    clarify = awaiting_clarification.to({first_state})\n"
            f"    abort = {abort_val}\n"
        )

        primitive_specs_src = "\n\n".join(
            f'_{s.upper()} = PrimitiveSpec(\n'
            f'    "{self.NAME_UPPER}_{s.upper()}",\n'
            f'    "{a}",\n'
            f'    _c({{"confidence": str}}),\n'
            f'    "TODO: one-line instruction for {a} at this state. Always emit confidence.",\n'
            f')'
            for s, a in states
        )

        primitive_by_state_src = "\n".join(f'        "{s}": _{s.upper()},' for s, _ in states)
        escalatable_src = "\n".join(f'            "{s}",' for s, _ in states)

        route_after_lines = []
        for idx, (s, _a) in enumerate(states):
            kw = "if" if idx == 0 else "elif"
            route_after_lines.append(f'        {kw} state == "{s}":')
            route_after_lines.append(f'            self.sm.send("{s}_done")')
        route_after_body = "\n".join(route_after_lines)

        playbook_src = (
            f"class {self.Name}Playbook(BasePlaybook):\n"
            f'    NAME = "{self.name}"\n'
            f"    machine_cls = {self.Name}Machine\n"
            f"    PRIMITIVE_BY_STATE = {{\n"
            f"{primitive_by_state_src}\n"
            f"    }}\n"
            f"    ESCALATABLE_STATES = frozenset(\n"
            f"        {{\n"
            f"{escalatable_src}\n"
            f"        }}\n"
            f"    )\n"
            f"\n"
            f"    # -- lifecycle ---------------------------------------------------------\n"
            f"    def initial_transition(self, ctx: RunContext) -> str:\n"
            f'        if not (ctx.goal or "").strip():\n'
            f'            raise RuntimeError("{self.name} skill requires a non-empty goal")\n'
            f"        # TODO: seed any playbook-owned domain state, e.g.:\n"
            f'        # ctx.extras.setdefault("{self.name}", {{}})\n'
            f'        self.sm.send("{start_event}")\n'
            f'        return "{first_state}"\n'
            f"\n"
            f"    # -- routing -------------------------------------------------------------\n"
            f"    def route_after(self, state: str, ctx: RunContext, summary: dict) -> None:\n"
            f"        # TODO: replace this linear chain with real domain routing (retries,\n"
            f"        # gates, parallel fan-out, etc.) as {self.name} needs. See code.py /\n"
            f"        # plan.py in this package for real patterns.\n"
            f"{route_after_body}\n"
            f"        else:\n"
            f'            raise ValueError(f"route_after: unexpected state \'{{state}}\'")\n'
            f"\n"
            f"    def done_predicate(self, ctx: RunContext) -> bool:\n"
            f'        # TODO: define what "done" means for {self.name} (default: always met).\n'
            f"        return True\n"
            f"\n"
            f"    # -- prompts + result ----------------------------------------------------\n"
            f"    def result_payload(self, ctx: RunContext) -> dict:\n"
            f"        # TODO: add {self.name}-specific result fields.\n"
            f'        return {{"met": ctx.met, "iterations": ctx.iteration}}\n'
        )

        return (
            f'"""{self.Name}Playbook — TODO: one-line description of what the {self.name} '
            f'skill does on the shared engine.\n'
            f"\n"
            f"TODO: expand this docstring per skill-standard.md — states, any HITL gates or\n"
            f"parallel fan-out, and deliberate design notes. Model the shape on\n"
            f"``apps/orchestration/src/orchestration/playbooks/code.py`` and ``plan.py``.\n"
            f'"""\n'
            f"\n"
            f"from __future__ import annotations\n"
            f"\n"
            f"from statemachine import State, StateMachine\n"
            f"\n"
            f"from ..context import RunContext\n"
            f"from ..engine import BasePlaybook\n"
            f"from ..primitives.spec import PrimitiveSpec\n"
            f"\n"
            f"\n"
            f"def _c(required: dict, optional: dict | None = None) -> dict:\n"
            f'    return {{"required": required, "optional": optional or {{}}}}\n'
            f"\n"
            f"\n"
            f"# ---------------------------------------------------------------------------\n"
            f"# The FSM\n"
            f"# ---------------------------------------------------------------------------\n"
            f"\n"
            f"\n"
            f"{machine_src}\n"
            f"\n"
            f"# ---------------------------------------------------------------------------\n"
            f'# Per-state SUMMARY contracts — TODO: replace the placeholder {{"confidence": str}}\n'
            f"# contract for each state with the real required/optional fields for that\n"
            f"# agent's output.\n"
            f"# ---------------------------------------------------------------------------\n"
            f"\n"
            f"{primitive_specs_src}\n"
            f"\n"
            f"\n"
            f"# ---------------------------------------------------------------------------\n"
            f"# The playbook\n"
            f"# ---------------------------------------------------------------------------\n"
            f"\n"
            f"\n"
            f"{playbook_src}"
        )

    def _build_test_playbook_source(self) -> str:
        walk_lines = []
        for i, (s, a) in enumerate(self.states):
            if i + 1 < len(self.states):
                nxt = self.states[i + 1][0]
                walk_lines.append(
                    f'    assert _step(cp, "{a}", {{"confidence": "PROBABLE"}})["state_id"] == "{nxt}"'
                )
            else:
                walk_lines.append(f'    d = _step(cp, "{a}", {{"confidence": "PROBABLE"}})')
                walk_lines.append('    assert d["action"] == "complete"')
        walk_block = "\n".join(walk_lines)
        first_state, first_agent = self.states[0]

        return (
            f'"""Tests for {self.Name}Playbook (scaffolded stub — expand as the playbook '
            f'grows).\n'
            f"\n"
            f"Each step() constructs a FRESH playbook instance pointed at the same\n"
            f"checkpointer (subprocess-per-invocation reality), mirroring the\n"
            f'run_id/checkpointer contract — NO --state and NO /tmp.\n'
            f'"""\n'
            f"\n"
            f"import pytest\n"
            f"\n"
            f"from orchestration.checkpointer import Checkpointer\n"
            f"from orchestration.playbooks.{self.module_name} import {self.Name}Playbook\n"
            f"\n"
            f'SID, RID = "sess-{self.name}", "run-{self.name}"\n'
            f"\n"
            f"\n"
            f"@pytest.fixture\n"
            f"def cp(tmp_path):\n"
            f'    return Checkpointer(db_path=tmp_path / "orch.db")\n'
            f"\n"
            f"\n"
            f'def _start(cp, goal="do the thing", constraints=None):\n'
            f"    return {self.Name}Playbook(cp).start(\n"
            f"        session_id=SID, run_id=RID, goal=goal, constraints=constraints or {{}}\n"
            f"    )\n"
            f"\n"
            f"\n"
            f"def _step(cp, agent, result):\n"
            f"    return {self.Name}Playbook(cp).step(session_id=SID, run_id=RID, agent=agent, result=result)\n"
            f"\n"
            f"\n"
            f"def test_start_without_goal_errors(cp):\n"
            f'    d = {self.Name}Playbook(cp).start(session_id=SID, run_id=RID, goal="", constraints={{}})\n'
            f'    assert d["action"] == "error"\n'
            f"\n"
            f"\n"
            f"def test_start_emits_first_agent(cp):\n"
            f"    d = _start(cp)\n"
            f'    assert d["action"] == "invoke_agent"\n'
            f'    assert d["agent"] == "{first_agent}" and d["state_id"] == "{first_state}"\n'
            f"\n"
            f"\n"
            f"def test_full_linear_walk_to_complete(cp):\n"
            f"    _start(cp)\n"
            f"{walk_block}\n"
        )

    # -- skill directory -----------------------------------------------------

    def _build_skill_md(self) -> str:
        subagents_list = "\n".join(f"      - {a}" for a in self.agents)
        return f"""---
name: {self.name}
description: "{self.description}. Use when [TODO: trigger conditions + signal phrases]. Do not use when [TODO: anti-cases — use X instead]."
license: MIT
metadata:
  version: "1.0.0"
  penny:
    engine: orchestration
    mempalace: true
    subagents:
{subagents_list}
---

# {self.Name} Skill

{self.description}

## When to Use

- TODO: condition 1 — replace with a real trigger for {self.name}
- User explicitly requests {self.name}-related work
- TODO: condition 3

## When Not to Use

- Simple, single-step tasks (execute directly)
- User explicitly says "just do it" (execute directly)
- Task is already well-defined with clear steps (proceed directly)

## Invocation

Invoke via the `skill` tool. The {self.name} skill runs on the shared
orchestration engine (`orchestration.playbooks.{self.module_name}:{self.Name}Playbook`);
the thin `scripts/orchestrate.py` delegate only routes
`start`/`step`/`status`/`recover`. Run state lives in the engine's durable
checkpointer keyed by `run_id` — there is no `--state`.

```
skill({{
  skill_name: "{self.name}",
  goal: "Your goal here",
  project_root: "/path/to/project"
}})
```

### Parameters

| Parameter | Required | Description |
|-----------|:--------:|-------------|
| `skill_name` | Yes | Must be `"{self.name}"` |
| `goal` | Yes | The goal for this skill |
| `session_id` | No | Unique session ID (auto-generated if omitted) |
| `project_root` | No | Project root directory (defaults to cwd) |
| `constraints` | No | JSON object of constraints |

## Output

Agents write full results to the mempalace room `skills/{self.name}-<session_id>`;
Penny only sees per-state structured SUMMARYs. TODO: document the terminal
`result` payload shape once `result_payload` is filled in.

## Post-Completion

After the skill completes, present the result for user approval — do not execute,
modify, or analyze the output further.

1. Fetch the full result from mempalace:
   ```
   memory_smart_search(query="<session_id>", room="skills/{self.name}-<session_id>", limit=5, include_full=true)
   ```
2. Present it via `questionnaire` with approve / refine / discard options.
3. On **approve**: use the result. On **refine**: re-invoke with refinement notes
   in `constraints`. On **discard**: stop.

## Escalation

If the skill returns an `escalate_to_user` directive, it is a pending
clarification pause, not a failure. Present `escalation.questions` via
`questionnaire`, then resume by re-issuing the step as the `user` agent with the
response:

```
skill({{
  skill_name: "{self.name}",
  run_id: result.run_id,
  user_response: questionnaire_result,
}})
```

## Post-Completion Storage

The engine records the run outcome automatically on completion — do not write
session drawers or knowledge-graph edges by hand.
"""

    def _build_readme_md(self) -> str:
        state_rows = "\n".join(
            f"| `{s}` | `{a}` | TODO: describe {a}'s job at this state |" for s, a in self.states
        )
        flow_lines = [
            f"1. `intake -> {self.states[0][0]}` (`start_{self.states[0][0]}`, non-empty goal required)."
        ]
        for i, (s, _a) in enumerate(self.states):
            n = i + 2
            nxt = self.states[i + 1][0] if i + 1 < len(self.states) else "complete"
            flow_lines.append(f"{n}. `{s} -> {nxt}` (`{s}_done`).")
        flow_block = "\n".join(flow_lines)

        return f"""# {self.Name} Skill

## Overview

- **Purpose**: {self.description}
- **Use When**: TODO — see SKILL.md "When to Use"
- **Outcome**: TODO — describe the terminal result payload

## Engine Architecture

The {self.name} skill runs on the shared **orchestration engine**. It is defined
as a `BasePlaybook` subclass, `{self.Name}Playbook`, in
`apps/orchestration/src/orchestration/playbooks/{self.module_name}.py`. That class
is the single source of truth for the states, transitions, gates, loops, and
agents.

- `scripts/orchestrate.py` is a thin delegate — it calls
  `orchestration.cli:main(default_playbook="{self.name}")` and routes `start` /
  `step` / `status` / `recover`. No FSM logic, no state serialization, no `/tmp`
  checkpoints.
- Run state lives in a durable **SQLite checkpointer keyed by `run_id`**.
- Agents run in fresh context and communicate through the **mempalace** room
  `skills/{self.name}-<session_id>`. Only a structured SUMMARY is returned to the
  engine per step; Penny never sees full agent output.

**Key principle: Penny's context stays clean.**

## States

This is a scaffolded stub: `intake` walks linearly through one working state per
agent, then completes. Replace with real domain routing (retries, gates, parallel
fan-out) as {self.name} needs.

| State | Agent | Purpose |
|-------|-------|---------|
| `intake` | — (initial) | Validate a non-empty goal |
{state_rows}
| `unknown` | — (transient) | Escalation staging state |
| `awaiting_clarification` | — (HITL) | Paused for user clarification |
| `complete` | — (final) | Success |
| `error` | — (final) | Failure (`abort` from any working state) |

## Flow

{flow_block}

## Escalation

Every working state is escalatable: `UNCERTAIN` confidence (or a TODO'd
`progress_check`) triggers `to_unknown -> unknown -> awaiting_clarification`. The
user's clarification resumes at `{self.states[0][0]}` (`clarify`).

## Mempalace Room

Room: `skills/{self.name}-<session_id>`. TODO: document drawer headers per agent.

## Files

| File | Purpose |
|------|---------|
| `SKILL.md` | Manifest and invocation |
| `README.md` | This documentation |
| `scripts/orchestrate.py` | Thin delegate to the orchestration engine |
| `assets/prompts/*.md` | Domain guidance per agent |
| `resources/reference.md` | State/transition/agent reference |
| `resources/flow.html` | Interactive HTML state diagram (matches the playbook FSM) |

## Testing

Playbook tests live in
`apps/orchestration/tests/test_{self.module_name}_playbook.py`:

```
cd apps/orchestration && pytest tests/test_{self.module_name}_playbook.py -v
```

## Version History

- **1.0.0** — Initial scaffold
"""

    def _build_reference_md(self) -> str:
        state_table_rows = "\n".join(
            f"| `{s}` | working | `{a}` | TODO: describe what {a} does + which fields it emits |"
            for s, a in self.states
        )
        escalatable_literal = (
            "{" + ", ".join(f'"{s}"' for s, _ in self.states) + "}"
        )
        transition_rows = [
            f"| `start_{self.states[0][0]}` | `intake` | `{self.states[0][0]}` | non-empty goal (else `intake` raises) |"
        ]
        for i, (s, _a) in enumerate(self.states):
            nxt = self.states[i + 1][0] if i + 1 < len(self.states) else "complete"
            transition_rows.append(f"| `{s}_done` | `{s}` | `{nxt}` | TODO |")
        transition_table_rows = "\n".join(transition_rows)
        contract_rows = "\n".join(
            f"| `{s}` | `{self.NAME_UPPER}_{s.upper()}` | `confidence: str` | TODO |"
            for s, _ in self.states
        )
        agent_rows = "\n".join(
            f"| `{s}` | `{a}` | `assets/prompts/{a}.md` |" for s, a in self.states
        )

        return f"""# {self.Name} Skill Reference

Technical reference for the {self.Name} skill. The authoritative source is the
engine playbook `{self.Name}Playbook` in
`apps/orchestration/src/orchestration/playbooks/{self.module_name}.py`; this file
mirrors its FSM. State lives in the durable checkpointer keyed by `run_id` —
there are no session files and no `--state` argv.

TODO: this is a scaffolded linear stub (`intake` -> one working state per agent
-> `complete`). Update every section below as the real routing, gates, and
contracts are designed.

## State Machine

### States

| State | Kind | Agent | Description |
|-------|------|-------|-------------|
| `intake` | initial | — | Validate non-empty goal |
{state_table_rows}
| `unknown` | transient | — | Escalation staging |
| `awaiting_clarification` | HITL | — (user) | Paused for clarification |
| `complete` | final | — | Success |
| `error` | final | — | Failure |

`ESCALATABLE_STATES = {escalatable_literal}`.

### Transitions

| Event | From | To | Guard / condition |
|-------|------|----|--------------------|
{transition_table_rows}
| `to_unknown` | any working state | `unknown` | TODO: escalation trigger |
| `escalate` | `unknown` | `awaiting_clarification` | — |
| `clarify` | `awaiting_clarification` | `{self.states[0][0]}` | user provided clarification |
| `abort` | any working state | `error` | unrecoverable failure |

## Per-state SUMMARY contracts

TODO: replace the placeholder `confidence: str`-only contract for each state with
real required/optional fields for that agent's output.

| State | Primitive | Required fields | Notable optional fields |
|-------|-----------|------------------|--------------------------|
{contract_rows}

## Agents

| State | Agent | Prompt file |
|-------|-------|-------------|
{agent_rows}

## Mempalace Integration

Room: `skills/{self.name}-<session_id>`. TODO: document per-agent drawer headers.

## Resume

A paused run (clarification escalation) is resumed by re-issuing `step` with
`agent="user"` and the user's response. The engine rehydrates the run by `run_id`
from the checkpointer.

## Result Payload

TODO: document the fields in `result_payload`. Scaffold default: `met`, `iterations`.
"""

    def _build_flow_html(self) -> str:
        """Generate the STANDARD self-contained interactive flow.html skeleton.

        Nodes are keyed by verbatim FSM state ids and edges mirror the linear
        default machine; the two uniform seams (abort -> error, escalation ->
        unknown) are collapsed into the footer note per the standard. Refine it to
        match the final machine and register the skill in
        ``apps/orchestration/tests/test_flow_diagrams.py::CASES`` (see
        docs/agents/skills/flow-diagrams.md).
        """
        first = self.states[0][0]
        nodes = [f"  intake:{{col:'C',y:24,cls:'gate',title:'intake',badge:'HITL',desc:'TODO'}},"]
        y = 118
        for s, a in self.states:
            nodes.append(f"  {s}:{{col:'C',y:{y},cls:'tool',title:'{s}',who:'{a}',desc:'TODO'}},")
            y += 96
        done_y = y + 24
        nodes.append(f"  complete:{{col:'C',y:{done_y},cls:'done',title:'complete',badge:'TERM',desc:'Terminal.'}},")
        nodes.append(f"  unknown:{{col:'Louter',y:{y // 2},cls:'esc',title:'unknown',desc:'Escalation entry (UNCERTAIN / needs_clarification).'}},")
        nodes.append(f"  awaiting_clarification:{{col:'Louter',y:{y // 2 + 150},cls:'esc',title:'awaiting_clarification',desc:'Paused for the user; resumes.'}},")
        nodes.append(f"  error:{{col:'Router',y:{done_y},cls:'error',title:'error',badge:'TERM',desc:'Terminal (abort).'}},")
        edges = [f"  {{from:'intake',to:'{first}',s1:'bottom',s2:'top',kind:'fwd'}},"]
        for i, (s, _a) in enumerate(self.states):
            nxt = self.states[i + 1][0] if i + 1 < len(self.states) else "complete"
            kind = "exit" if nxt == "complete" else "fwd"
            edges.append(f"  {{from:'{s}',to:'{nxt}',s1:'bottom',s2:'top',kind:'{kind}'}},")
        edges.append("  {from:'unknown',to:'awaiting_clarification',s1:'bottom',s2:'top',kind:'esc',label:'escalate'},")
        edges.append(f"  {{from:'awaiting_clarification',to:'{first}',s1:'right',s2:'left',kind:'esc',label:'clarify'}},")
        return (
            _FLOW_HTML_TEMPLATE.replace("__NAME__", self.name)
            .replace("__HEIGHT__", str(done_y + 120))
            .replace("__N__", "\n".join(nodes))
            .replace("__E__", "\n".join(edges))
        )

    def _build_prompt_md(self, agent: str, agent_states: List[str]) -> str:
        contract_refs = ", ".join(f"`_{s.upper()}`" for s in agent_states)
        return f"""# {agent} Prompt — {self.Name} Domain Guidance

## Mission

TODO: describe {agent}'s role in the {self.name} skill context (state(s): {", ".join(f"`{s}`" for s in agent_states)}).

## Mempalace-First Communication

Before starting, check for prior results:

`memory_smart_search(query="<session_id>", room="skills/{self.name}-<session_id>", limit=5)`

After completing your work, write full findings to mempalace:

`memory_add_drawer(wing="penny", room="skills/{self.name}-<session_id>", content="## <session_id> {agent}\\n\\n<your full findings>")`

Your task includes the session ID and mempalace room. Use them.

## Domain Guide

TODO: add {self.name}-specific domain guidance here (checklists, frameworks,
examples relevant to {agent}'s job).

## Mandatory: Structured Output

Your final message MUST end with a STRUCTURED SUMMARY using inline JSON format,
prefixed with `SUMMARY:`. TODO: replace this placeholder contract with the real
required/optional fields declared on {contract_refs} in
`apps/orchestration/src/orchestration/playbooks/{self.module_name}.py`:

`SUMMARY:{{"confidence":"CERTAIN|PROBABLE|POSSIBLE|UNCERTAIN"}}`

Keep your SUMMARY minimal — detailed findings belong in mempalace, not in the
summary.
"""

    def _orchestrate_py(self) -> str:
        return (
            "from orchestration.cli import main\n"
            f'raise SystemExit(main(default_playbook="{self.name}"))\n'
        )

    # -- top-level scaffold ---------------------------------------------------

    def scaffold(self, base_dir: Path) -> Path:
        skill_dir = base_dir / self.name
        if skill_dir.exists():
            raise FileExistsError(f"Skill directory already exists: {skill_dir}")
        if self.playbook_path.exists():
            raise FileExistsError(f"Playbook module already exists: {self.playbook_path}")
        if self.test_path.exists():
            raise FileExistsError(f"Playbook test already exists: {self.test_path}")

        (skill_dir / "scripts").mkdir(parents=True)
        (skill_dir / "assets" / "prompts").mkdir(parents=True)
        (skill_dir / "resources").mkdir(parents=True)

        (skill_dir / "SKILL.md").write_text(self._build_skill_md(), encoding="utf-8")
        (skill_dir / "README.md").write_text(self._build_readme_md(), encoding="utf-8")
        (skill_dir / "scripts" / "orchestrate.py").write_text(
            self._orchestrate_py(), encoding="utf-8"
        )
        (skill_dir / "resources" / "reference.md").write_text(
            self._build_reference_md(), encoding="utf-8"
        )
        (skill_dir / "resources" / "flow.html").write_text(
            self._build_flow_html(), encoding="utf-8"
        )

        for agent in dict.fromkeys(self.agents):  # unique, order-preserving
            agent_states = [s for s, a in self.states if a == agent]
            (skill_dir / "assets" / "prompts" / f"{agent}.md").write_text(
                self._build_prompt_md(agent, agent_states), encoding="utf-8"
            )

        self.playbook_path.parent.mkdir(parents=True, exist_ok=True)
        self.playbook_path.write_text(self._build_playbook_source(), encoding="utf-8")

        self.test_path.parent.mkdir(parents=True, exist_ok=True)
        self.test_path.write_text(self._build_test_playbook_source(), encoding="utf-8")

        register_playbook(self.Name, self.module_name)
        register_skill_rooms(self.name)

        return skill_dir


def main():
    parser = argparse.ArgumentParser(
        description="Scaffold a new Penny skill on the shared orchestration engine."
    )
    parser.add_argument("--name", required=True, help="Skill name (kebab-case)")
    parser.add_argument("--description", required=True, help="1-2 sentence description")
    parser.add_argument(
        "--agents",
        default="echo,piper,vera",
        help="Comma-separated list of subagents, one working state per agent "
        "in order (default: echo,piper,vera)",
    )
    parser.add_argument(
        "--skills-dir",
        type=Path,
        default=SKILLS_DIR,
        help=f"Base directory for the skill tree (default: {SKILLS_DIR})",
    )

    args = parser.parse_args()
    agents = [a.strip() for a in args.agents.split(",") if a.strip()]
    if not agents:
        print("ERROR: --agents must list at least one agent")
        sys.exit(1)

    scaffolder = SkillScaffolder(name=args.name, description=args.description, agents=agents)

    try:
        skill_dir = scaffolder.scaffold(args.skills_dir)
    except FileExistsError as e:
        print(f"ERROR: {e}")
        sys.exit(1)

    print(f"Scaffolded skill directory: {skill_dir}")
    print(f"Scaffolded playbook:        {scaffolder.playbook_path}")
    print(f"Scaffolded playbook test:   {scaffolder.test_path}")
    print(f"Registered {scaffolder.Name}Playbook in {PLAYBOOKS_INIT}")
    print()
    print("Next steps:")
    print(f"  1. Design the real states/routing/gates for '{args.name}' in")
    print(f"     {scaffolder.playbook_path} (model it on playbooks/code.py and playbooks/plan.py).")
    print("  2. Fill in the per-state SUMMARY contracts (PrimitiveSpec) and replace")
    print("     the linear route_after chain with real domain routing.")
    print("  3. Add GATE_STATES/gate_questions/route_user or PARALLEL_BY_STATE if")
    print(f"     '{args.name}' needs a HITL gate or a parallel fan-out state.")
    print(f"  4. Write domain guidance in {skill_dir}/assets/prompts/*.md")
    print(f"  5. Update {skill_dir}/resources/flow.html and resources/reference.md")
    print("     to match the real FSM once it's designed.")
    print(f"  6. Flesh out the playbook tests: {scaffolder.test_path}")
    print(
        f"  7. Run tests: cd apps/orchestration && pytest tests/test_{scaffolder.module_name}_playbook.py -v"
    )
    print(
        f"  8. Validate structure: python scripts/system/checks/check_skill_structure.py --skill {args.name}"
    )
    print()
    print(f"Project root: {PROJECT_ROOT}")


if __name__ == "__main__":
    main()
