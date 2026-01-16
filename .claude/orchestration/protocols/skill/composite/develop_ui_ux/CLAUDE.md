# develop-ui-ux Composite Skill

**Type:** Composite Skill
**Composition Depth:** 0
**Total Phases:** 7

## Overview

Platform-agnostic UI/UX design system generation with token architecture and WCAG accessibility compliance.

**Cognitive Pattern:** CLARIFICATION → RESEARCH → ANALYSIS → SYNTHESIS (CRITICAL) → GENERATION (2×) → VALIDATION (REMEDIATION)

## Phase Sequence

| Phase | Name | Atomic Skill | Type |
|-------|------|--------------|------|
| 0 | Design Requirements Clarification | orchestrate-clarification | LINEAR (MANDATORY) |
| 1 | Design Pattern Research | orchestrate-research | LINEAR |
| 2 | Platform Analysis | orchestrate-analysis | LINEAR |
| 3 | Design Token Architecture | orchestrate-synthesis | LINEAR (CRITICAL PATH) |
| 4 | Component Library Design | orchestrate-generation | LINEAR |
| 5 | Accessibility Compliance | orchestrate-generation | LINEAR |
| 6 | Prototype & Validation | orchestrate-validation | REMEDIATION |

## Critical Path

**Phase 3: Design Token Architecture** is the critical path. It produces the three-tier token taxonomy that all subsequent phases depend on.

## Remediation Flow

Phase 6 validation failures loop back to **Phase 4** (Component Library Design), NOT Phase 3.

**Rationale:** Preserves the validated token architecture while allowing component and accessibility artifacts to be regenerated.

**Max Iterations:** 2 remediation loops before escalation.

## Key Deliverables

### Phase 0 Output
- Target platforms identified (web/mobile/desktop)
- Brand identity requirements
- Accessibility level (AA/AAA)
- Design system scope

### Phase 1 Output
- Token format standards research
- Component pattern analysis
- Industry best practices catalog

### Phase 2 Output
- Platform-specific constraints
- [PLATFORM:WEB] specifications
- [PLATFORM:MOBILE] specifications
- [PLATFORM:DESKTOP] specifications

### Phase 3 Output (CRITICAL)
- Primitive tokens (colors, spacing, typography, elevation)
- Semantic tokens (surface, text, interactive, feedback)
- Component tokens (button, input, card, navigation)
- Three-tier taxonomy documentation

### Phase 4 Output
- Atomic components (button, input, icon, badge, avatar)
- Molecular components (form field, card, list item, tooltip)
- Organism components (header, footer, navigation, sidebar)

### Phase 5 Output
- WCAG compliance checklist
- ARIA role assignments
- Keyboard navigation patterns
- Screen reader testing recommendations
- Color contrast verification rules

### Phase 6 Output
- Validation report (PASS/CONDITIONAL/FAIL)
- Remediation recommendations (if FAIL)
- Completion summary (if PASS)

## Platform Extensions

Phases 2, 4, and 5 include platform-specific sections tagged with `[PLATFORM:*]` markers:
- `[PLATFORM:WEB]` - CSS variables, responsive breakpoints
- `[PLATFORM:MOBILE]` - iOS/Android design guidelines
- `[PLATFORM:DESKTOP]` - Electron, native frameworks

## Token-Component Relationship

All component specifications in Phase 4 MUST reference design tokens from Phase 3. No hardcoded values allowed.

**Example:**
- Button background → `$component-button-bg` (component token)
- Component token → `$interactive-primary` (semantic token)
- Semantic token → `$color-blue-600` (primitive token)

## Gate Criteria

| Phase | Gate | Passing Criteria |
|-------|------|------------------|
| 0 | Requirements complete | 100% scope coverage |
| 1 | Research depth | depth parameter satisfied |
| 2 | Platform analysis | All target platforms analyzed |
| 3 | Token taxonomy | 3 tiers defined and validated |
| 4 | Atomic design | Atoms + molecules + organisms |
| 5 | WCAG compliance | Accessibility level achieved |
| 6 | Validation | PASS or CONDITIONAL |

## Dual Generation Pattern

Phases 4 and 5 both use `orchestrate-generation` but with different domain contexts:
- Phase 4: Generate component specifications (design domain)
- Phase 5: Generate accessibility documentation (compliance domain)

## Files

```
develop_ui_ux/
├── __init__.py          # Skill metadata
├── entry.py             # Self-configuring entry
├── complete.py          # Self-configuring completion
├── CLAUDE.md            # This file
└── content/
    ├── phase_0_design_requirements_clarification.md
    ├── phase_1_design_pattern_research.md
    ├── phase_2_platform_analysis.md
    ├── phase_3_design_token_architecture.md
    ├── phase_4_component_library_design.md
    ├── phase_5_accessibility_compliance.md
    └── phase_6_prototype_validation.md
```

## Related Research Terms

- Design tokens
- Atomic design
- WCAG guidelines
- Component-driven development
- Three-tier token taxonomy
- Platform-agnostic design
- Accessibility-first design
