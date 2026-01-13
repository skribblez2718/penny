# config.py Registration Template

## Overview

Templates for registering new composite skills in the master skill registry.

**Target File:** `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/config/config.py`

**IMPORTANT:** These templates generate code for MANUAL insertion. Do NOT auto-inject into config.py. Always review generated code before insertion.

---

## 1. COMPOSITE_SKILLS Entry

Add to the `COMPOSITE_SKILLS` dictionary in config.py.

### Template

```python
"{skill-name}": {
    "description": "{description}",
    "semantic_trigger": "{semantic_trigger}",
    "not_for": "{not_for}",
    "composition_depth": {depth},
    "phases": "{SKILL_NAME_UPPER}_PHASES",
},
```

### Placeholder Substitutions

| Placeholder | Description | Example |
|-------------|-------------|---------|
| `{skill-name}` | Hyphenated skill name | `my-new-skill` |
| `{description}` | One-line description | `Process and validate user requests` |
| `{semantic_trigger}` | Comma-separated trigger phrases (5-10 words) | `process requests, validate input, handle submissions` |
| `{not_for}` | Comma-separated exclusions | `simple queries, read-only tasks, direct execution` |
| `{depth}` | 0 (atomics only) or 1 (uses composites) | `0` |
| `{SKILL_NAME_UPPER}` | Uppercase underscored name | `MY_NEW_SKILL` |

### Example

```python
"my-new-skill": {
    "description": "Process and validate user requests",
    "semantic_trigger": "process requests, validate input, handle submissions",
    "not_for": "simple queries, read-only tasks, direct execution",
    "composition_depth": 0,
    "phases": "MY_NEW_SKILL_PHASES",
},
```

---

## 2. Phase Definition Dictionary

Add BEFORE the `SKILL_PHASES` dictionary in config.py.

### Template

```python
{SKILL_NAME_UPPER}_PHASES: Dict[str, Dict[str, Any]] = {
    "0": {
        "name": "CLARIFICATION",
        "title": "Requirements Clarification",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-clarification",
        "script": None,
        "content": "phase_0_requirements_clarification.md",
        "next": "{next_phase}",
        "description": "Clarify requirements via Johari discovery",
    },
{additional_phases}
}
```

### Phase Entry Template

```python
    "{phase_id}": {
        "name": "{PHASE_NAME_UPPER}",
        "title": "{Phase Title}",
        "type": PhaseType.{TYPE},
        "uses_atomic_skill": "{atomic_skill_or_None}",
        "script": {script_or_None},
        "content": "phase_{phase_id}_{name_snake}.md",
        "next": "{next_phase_or_None}",
        "description": "{What this phase does}",
    },
```

### Phase Type Values

| PhaseType | When to Use |
|-----------|-------------|
| `LINEAR` | Standard sequential phase (most common) |
| `OPTIONAL` | Conditional phase with skip trigger |
| `ITERATIVE` | Multi-iteration phase (3A, 3B, 3C) |
| `REMEDIATION` | Retry after validation failure |
| `PARALLEL` | Execute branches concurrently |
| `AUTO` | **DEPRECATED** - Do not use. All phases must invoke agents. |

### Atomic Skill Values

| uses_atomic_skill | Cognitive Function |
|-------------------|-------------------|
| `"orchestrate-clarification"` | CLARIFICATION |
| `"orchestrate-research"` | RESEARCH |
| `"orchestrate-analysis"` | ANALYSIS |
| `"orchestrate-synthesis"` | SYNTHESIS |
| `"orchestrate-generation"` | GENERATION |
| `"orchestrate-validation"` | VALIDATION |
| `"orchestrate-memory"` | METACOGNITION |

**IMPORTANT:** `uses_atomic_skill: None` is deprecated. All phases MUST specify an agent. If a phase produces output, use `orchestrate-generation`. If a phase verifies/validates, use `orchestrate-validation`.

### Example Phase Definitions

```python
MY_NEW_SKILL_PHASES: Dict[str, Dict[str, Any]] = {
    "0": {
        "name": "CLARIFICATION",
        "title": "Requirements Clarification",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-clarification",
        "script": None,
        "content": "phase_0_requirements_clarification.md",
        "next": "1",
        "description": "Clarify requirements via Johari discovery",
    },
    "1": {
        "name": "ANALYSIS",
        "title": "Request Analysis",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-analysis",
        "script": None,
        "content": "phase_1_request_analysis.md",
        "next": "2",
        "description": "Analyze request complexity and requirements",
    },
    "2": {
        "name": "GENERATION",
        "title": "Response Generation",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-generation",
        "script": None,
        "content": "phase_2_response_generation.md",
        "next": "3",
        "description": "Generate response artifacts",
    },
    "3": {
        "name": "VALIDATION",
        "title": "Output Validation",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-validation",
        "script": None,
        "content": "phase_3_output_validation.md",
        "next": None,  # Final phase
        "description": "Validate generated output",
    },
}
```

---

## 3. SKILL_PHASES Mapping

Add entry to the `SKILL_PHASES` dictionary.

### Template

```python
"{skill-name}": {SKILL_NAME_UPPER}_PHASES,
```

### Example

```python
"my-new-skill": MY_NEW_SKILL_PHASES,
```

---

## 4. Complete Registration Example

Full example for a 4-phase skill:

```python
# === Add to COMPOSITE_SKILLS dictionary ===
"my-new-skill": {
    "description": "Process and validate user requests",
    "semantic_trigger": "process requests, validate input, handle submissions",
    "not_for": "simple queries, read-only tasks, direct execution",
    "composition_depth": 0,
    "phases": "MY_NEW_SKILL_PHASES",
},

# === Add phase definition (before SKILL_PHASES) ===
MY_NEW_SKILL_PHASES: Dict[str, Dict[str, Any]] = {
    "0": {
        "name": "CLARIFICATION",
        "title": "Requirements Clarification",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-clarification",
        "script": None,
        "content": "phase_0_requirements_clarification.md",
        "next": "1",
        "description": "Clarify requirements via Johari discovery",
    },
    "1": {
        "name": "ANALYSIS",
        "title": "Request Analysis",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-analysis",
        "script": None,
        "content": "phase_1_request_analysis.md",
        "next": "2",
        "description": "Analyze request complexity and requirements",
    },
    "2": {
        "name": "GENERATION",
        "title": "Response Generation",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-generation",
        "script": None,
        "content": "phase_2_response_generation.md",
        "next": "3",
        "description": "Generate response artifacts",
    },
    "3": {
        "name": "VALIDATION",
        "title": "Output Validation",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-validation",
        "script": None,
        "content": "phase_3_output_validation.md",
        "next": None,
        "description": "Validate generated output",
    },
}

# === Add to SKILL_PHASES dictionary ===
"my-new-skill": MY_NEW_SKILL_PHASES,
```

---

## 5. Insertion Locations

When manually inserting into config.py:

### COMPOSITE_SKILLS Entry
- Find `COMPOSITE_SKILLS: Dict[str, Dict[str, Any]] = {`
- Insert new entry in alphabetical order
- Ensure trailing comma after entry

### Phase Definition
- Find existing `*_PHASES` definitions (e.g., `DEVELOP_SKILL_PHASES`)
- Insert new definition BEFORE `SKILL_PHASES`
- Follow same formatting as existing definitions

### SKILL_PHASES Mapping
- Find `SKILL_PHASES: Dict[str, Dict[str, Dict[str, Any]]] = {`
- Insert new mapping in alphabetical order
- Ensure trailing comma after entry

---

## 6. Validation Checklist

After inserting registration code:

- [ ] COMPOSITE_SKILLS entry has correct skill name (hyphenated)
- [ ] semantic_trigger field has 5-10 word comma-separated phrases
- [ ] not_for field explicitly excludes inappropriate use cases
- [ ] composition_depth matches actual skill design
- [ ] phases reference matches phase dict name
- [ ] Phase dict has correct variable name (uppercase, underscored)
- [ ] Phase 0 is type LINEAR with orchestrate-clarification
- [ ] All phases have unique IDs
- [ ] All `next` pointers form valid chain (or None for final)
- [ ] Content filenames match actual files in content/
- [ ] SKILL_PHASES mapping references correct phase dict
- [ ] All commas and syntax are correct
- [ ] Import statements present (Dict, Any, PhaseType)

---

## References

- `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/config/config.py` - Master registry
- `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/CLAUDE.md` - Skill protocol
