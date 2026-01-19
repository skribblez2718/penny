---
name: develop-ui-ux
description: Platform-agnostic UI/UX design system generation
tags: design-system, ui-ux, design-tokens, component-library, accessibility, wcag
type: composite
composition_depth: 0
uses_composites: []
---

# develop-ui-ux

**Type:** Composite Skill
**Description:** Platform-agnostic UI/UX design system generation with token architecture and accessibility compliance
**Status:** production
**Complexity:** high

## Overview

Orchestrates complete design system lifecycle from requirements clarification through validation with token architecture, component library design, and WCAG accessibility compliance.

**Cognitive Pattern:** CLARIFICATION (MANDATORY) → DESIGN PATTERN RESEARCH → PLATFORM ANALYSIS → TOKEN ARCHITECTURE (CRITICAL PATH) → COMPONENT LIBRARY → ACCESSIBILITY COMPLIANCE → VALIDATION (with remediation loop)

**Key Capabilities:**
- Platform-agnostic design token architecture using three-tier taxonomy
- Atomic design component specifications (atoms, molecules, organisms)
- WCAG AA/AAA accessibility compliance built-in
- Multi-platform support (web, mobile, desktop)
- Validation with remediation loop to Phase 4 (preserves token architecture)
- Industry best practices integration (Material Design, Carbon, Ant Design)

**Default Assumptions:**
- Target platforms: **web** (can extend to mobile/desktop in Phase 0)
- Accessibility level: **AA** (can upgrade to AAA in Phase 0)
- Design system scope: **full** (tokens + components + accessibility)

## When to Use

Invoke this skill when queries match these semantic triggers:

- **Design system** - "create design system", "build design system"
- **UI/UX design** - "design UI/UX", "user interface design"
- **Design tokens** - "create design tokens", "design token architecture"
- **Component library** - "build component library", "component specifications"
- **Accessibility audit** - "WCAG compliance", "accessibility review"
- **Design patterns** - "design pattern library", "UI pattern system"

## NOT for

Do NOT invoke this skill for:

- **Code implementation** - use development-phase skill (actual component coding)
- **Visual mockups** - use design tools (Figma, Sketch) - this skill generates specifications
- **Architecture design** - use develop-architecture skill (system architecture)
- **Requirements gathering** - use develop-requirements skill first
- **Frontend development** - use generation skill for React/Vue/Angular code

**Boundary Clarity:** This skill generates design SPECIFICATIONS and DOCUMENTATION; it does not generate production code or visual mockups.

## Core Principles

1. **Platform-agnostic tokens** - Three-tier taxonomy (primitive → semantic → component) works across all platforms
2. **Atomic design methodology** - Systematic component hierarchy (atoms → molecules → organisms)
3. **Accessibility-first** - WCAG compliance integrated from Phase 0, not retrofitted
4. **Token-driven components** - All component specs reference design tokens, not hardcoded values
5. **Validation with remediation** - Loops to Phase 4 (not Phase 3) to preserve validated token architecture
6. **Absolute Imports Only** - All generated code MUST use absolute imports. Relative imports are forbidden to ensure code portability and clear dependency chains.
7. **CLAUDE.md Documentation** - Every code directory MUST include a CLAUDE.md file documenting the directory's purpose, key files, and usage patterns.

## Workflow Protocol

**Reference:** See `${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/` for full workflow lifecycle

### Initialization
- Generate task-id: `task-design-{project-keywords}`
- Create workflow metadata per protocol
- Task domain: creative/technical hybrid
- Detect platform requirements (web/mobile/desktop)

### Completion
- Aggregate all deliverables (tokens, components, accessibility artifacts)
- Review Unknown Registry for gaps
- Present completion summary with design system package
- Finalize workflow per protocol

## MANDATORY Execution

**After invoking this skill, IMMEDIATELY execute:**

```bash
python3 ${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/develop_ui_ux/entry.py "{task_id}"
```

This triggers Python-enforced phase orchestration. DO NOT manually read files or bypass this step.

## Workflow Phases

**NOTE:** Phase details are managed by Python orchestration in:
`${CAII_DIRECTORY}/.claude/orchestration/protocols/skill/composite/develop_ui_ux/`

| Phase | Name | Atomic Skill | Type |
|-------|------|--------------|------|
| 0 | Design Requirements Clarification | orchestrate-clarification | **LINEAR** (MANDATORY) |
| 1 | Design Pattern Research | orchestrate-research | LINEAR |
| 2 | Platform Analysis | orchestrate-analysis | LINEAR |
| 3 | Design Token Architecture | orchestrate-synthesis | LINEAR (CRITICAL PATH) |
| 4 | Component Library Design | orchestrate-generation | LINEAR |
| 5 | Accessibility Compliance | orchestrate-generation | LINEAR |
| 6 | Prototype & Validation | orchestrate-validation | **REMEDIATION** |

**Execution:** Phases are enforced by `protocols/skill/core/fsm.py` with state tracked in `protocols/skill/state/`.

### Phase Details

#### Phase 0: Design Requirements Clarification (LINEAR)
- Clarify target platforms (web/mobile/desktop)
- Determine brand identity (existing vs new)
- Set accessibility level (AA vs AAA)
- Define design system scope (full/tokens-only/components-only)
- Identify visual reference systems (if any)
- **Gate:** Design requirements documented, scope boundaries clear

#### Phase 1: Design Pattern Research (LINEAR)
- Research design token format standards (W3C Design Tokens, Style Dictionary)
- Analyze industry design systems (Material Design, Carbon, Ant Design, Fluent)
- Identify component pattern best practices
- Document platform-specific considerations
- **Gate:** Research depth parameter satisfied, patterns cataloged

#### Phase 2: Platform Analysis (LINEAR)
- Analyze web platform constraints (CSS variables, responsive breakpoints)
- Analyze mobile platform constraints (iOS/Android design guidelines)
- Analyze desktop platform constraints (Electron, native frameworks)
- Document platform-specific token mappings
- **Gate:** All target platforms analyzed with constraints documented

#### Phase 3: Design Token Architecture (LINEAR - CRITICAL PATH)
- Design primitive tokens (colors, spacing, typography, elevation)
- Design semantic tokens (surface, text, interactive, feedback)
- Design component tokens (button, input, card, navigation)
- Create three-tier token taxonomy
- Document token naming conventions and structure
- **Gate:** Three-tier token taxonomy complete, all tiers validated

#### Phase 4: Component Library Design (LINEAR)
- Design atomic components (button, input, icon, badge, avatar)
- Design molecular components (form field, card, list item, tooltip)
- Design organism components (header, footer, navigation, sidebar)
- Apply atomic design methodology
- Reference design tokens in all component specs
- **Gate:** Atomic design coverage complete (atoms + molecules + organisms)
- [ ] All generated code uses absolute imports only
- [ ] CLAUDE.md file created in each component directory

#### Phase 5: Accessibility Compliance (LINEAR)
- Generate WCAG compliance checklist (Level AA or AAA)
- Define ARIA role assignments for all components
- Document keyboard navigation patterns
- Create screen reader testing recommendations
- Generate color contrast verification rules
- **Gate:** WCAG level verified, accessibility artifacts complete

#### Phase 6: Prototype & Validation (REMEDIATION)
- Validate token architecture completeness
- Validate component specifications against requirements
- Check accessibility compliance coverage
- Verify platform compatibility
- If validation fails → loop to Phase 4 (max 2 remediation iterations)
- **Gate:** Validation pass (PASS/CONDITIONAL/FAIL)

### Remediation Flow

If Phase 6 validation identifies gaps:

1. **Analysis:** Validation agent identifies specific gaps
2. **Decision:** Loop back to **Phase 4** (Component Library Design)
3. **Preserve:** Token architecture from Phase 3 remains unchanged
4. **Regenerate:** Components and accessibility artifacts are revised
5. **Limit:** Max 2 remediation loops before escalation

**Critical:** Remediation loops to Phase 4, NOT Phase 3, to preserve the validated token architecture.

## Directory Structure

```
.claude/
├── skills/develop-ui-ux/
│   ├── SKILL.md                    # This file
│   └── resources/
│       └── validation-checklist.md # Validation criteria for Phase 6
│
└── orchestration/protocols/skill/composite/develop_ui_ux/
    ├── __init__.py                 # Package metadata
    ├── entry.py                    # Self-configuring entry point
    ├── complete.py                 # Self-configuring completion
    ├── CLAUDE.md                   # Skill documentation for Claude
    └── content/
        ├── phase_0_design_requirements_clarification.md
        ├── phase_1_design_pattern_research.md
        ├── phase_2_platform_analysis.md
        ├── phase_3_design_token_architecture.md
        ├── phase_4_component_library_design.md
        ├── phase_5_accessibility_compliance.md
        └── phase_6_prototype_validation.md
```

## Context Flow

```
Phase 0 (Clarification)
├── Input: User request
├── Output: Requirements document
│   ├── target_platforms: [web, mobile, desktop]
│   ├── brand_identity: existing | new
│   ├── accessibility_level: AA | AAA
│   └── design_system_scope: full | tokens-only | components-only
└── Flows to: Phase 1

Phase 1 (Research)
├── Input: Requirements + prior research report
├── Output: Design patterns research
│   ├── Token format standards
│   ├── Component patterns
│   └── Industry best practices
└── Flows to: Phase 2

Phase 2 (Analysis)
├── Input: Research findings
├── Output: Platform constraints
│   ├── [PLATFORM:WEB] specifications
│   ├── [PLATFORM:MOBILE] specifications
│   └── [PLATFORM:DESKTOP] specifications
└── Flows to: Phase 3

Phase 3 (Synthesis) ← CRITICAL PATH
├── Input: Research + Analysis
├── Output: Token architecture
│   ├── Primitive tokens (colors, spacing, typography)
│   ├── Semantic tokens (surface, text, interactive)
│   └── Component tokens (button, input, card)
└── Flows to: Phase 4

Phase 4 (Generation - Components)
├── Input: Token architecture
├── Output: Component specifications
│   ├── Atoms (button, input, icon)
│   ├── Molecules (form field, card)
│   └── Organisms (header, footer, navigation)
└── Flows to: Phase 5

Phase 5 (Generation - Accessibility)
├── Input: Component specs + token architecture
├── Output: Accessibility artifacts
│   ├── WCAG compliance checklist
│   ├── ARIA role assignments
│   └── Testing recommendations
└── Flows to: Phase 6

Phase 6 (Validation) ← REMEDIATION
├── Input: All prior outputs
├── Output: Validation report
│   ├── PASS → Complete workflow
│   └── FAIL → Loop to Phase 4 (max 2 times)
└── Flows to: Complete
```

## Gate Criteria

| Phase | Gate | Threshold |
|-------|------|-----------|
| 0 | Requirements documented | 100% coverage |
| 1 | Research depth met | depth parameter satisfied |
| 2 | All platforms analyzed | target_platforms.length |
| 3 | Three-tier taxonomy complete | 3 tiers defined |
| 4 | Atomic design coverage | atoms, molecules, organisms |
| 5 | WCAG level verified | accessibility_level met |
| 6 | Validation pass | PASS/CONDITIONAL/FAIL |

## Validation Checklist

See `resources/validation-checklist.md` for complete validation criteria.

**Key Validation Points:**
- Token architecture follows three-tier taxonomy
- All component specs reference tokens (no hardcoded values)
- Atomic design levels complete (atoms, molecules, organisms)
- WCAG compliance level achieved (AA or AAA)
- Platform compatibility verified for target platforms
- Documentation complete and consistent

## Related Research Terms

- Design tokens
- Atomic design methodology
- WCAG accessibility guidelines
- Component-driven development
- Design system documentation
- Three-tier token taxonomy
- Semantic design tokens
- Platform-agnostic design
- Accessibility-first design
- Design pattern libraries

## References

- W3C Design Tokens Community Group
- Atomic Design by Brad Frost
- WCAG 2.1 Guidelines
- Material Design System
- Carbon Design System
- Ant Design System
- Style Dictionary (token management)
- Design Systems Handbook

## Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `import_style` | `absolute` | REQUIRED - relative imports forbidden |
| `documentation_standard` | `claude_md` | CLAUDE.md in every code directory |

## Agent Invocation Format

When invoking agents for this skill, use the standardized Agent Prompt Template format:

```markdown
# Agent Invocation: {agent-name}

## Task Context
- **Task ID:** `{task-id}`
- **Skill:** `develop-ui-ux`
- **Phase:** `{phase-id}`
- **Domain:** `creative/technical`
- **Agent:** `{agent-name}`

## Role Extension
{3-5 task-specific focus areas dynamically generated by DA}

## Johari Context (if available)
{Open/Blind/Hidden/Unknown from reasoning protocol Step 0}

## Task
{Specific cognitive work for this phase}

## Related Research Terms
{7-10 keywords dynamically generated by DA}

## Output
{Memory file path and format requirements}
```

**Reference:** See `${CAII_DIRECTORY}/.claude/orchestration/shared/templates/agent-system-prompt.md` for full template.
