# Phase 2: Design Synthesis

**Uses Atomic Skill:** `orchestrate-synthesis`

## Purpose

Synthesize optimal cognitive flow by integrating clarification, analysis, and research findings.

## Domain-Specific Extensions

When synthesizing skill design:

1. **Integrate Findings**
   - Combine requirements from Phase 0
   - Apply complexity insights from Phase 1
   - Incorporate patterns from Phase 1.5

2. **Design Workflow Structure**
   - Define phase sequence
   - Identify optional phases
   - Plan sub-phases (0.5, 0.6, etc.)
   - Design remediation loops if needed

3. **Define Agent Sequence**
   - Map phases to atomic skills
   - Specify configuration for each
   - Define context flow between phases

4. **Resolve Contradictions**
   - Balance simplicity vs completeness
   - Reconcile competing requirements
   - Make explicit trade-off decisions

## Synthesis Output Structure

```
Skill Design:
├── Metadata (name, type, depth)
├── Phase Definitions
│   ├── Phase ID, Name, Type
│   ├── Atomic Skill Used
│   ├── Configuration
│   └── Gate Criteria
├── Context Flow
│   ├── Input requirements
│   ├── Phase-to-phase context
│   └── Output artifacts
└── Validation Criteria
```

## Gate Exit Criteria

- [ ] Complete phase sequence designed
- [ ] All phases mapped to atomic skills
- [ ] Context flow defined
- [ ] Configuration specified per phase
- [ ] Gate criteria documented

## Output

Skill design documented in synthesis memory file.
