# Phase 0: Design Requirements Clarification

**Type:** LINEAR (MANDATORY)
**Atomic Skill:** orchestrate-clarification
**Agent:** clarification

## Objective

Clarify design system requirements including target platforms, brand identity, accessibility level, and design system scope.

## Input Context

- User request for UI/UX design system
- Any existing brand guidelines or design references
- Platform requirements (if mentioned)

## Clarification Focus Areas

### 1. Target Platforms

Identify which platforms the design system will support:
- **Web** - Browser-based applications (default)
- **Mobile** - iOS and/or Android native apps
- **Desktop** - Electron or native desktop applications

**Questions to Clarify:**
- Which platforms need support?
- Are there platform-specific constraints?
- Should the system be platform-agnostic (works everywhere)?

### 2. Brand Identity

Determine brand identity status:
- **Existing** - Brand guidelines already exist (colors, fonts, logo)
- **New** - Brand identity needs to be created from scratch
- **Partial** - Some brand elements exist, others need creation

**Questions to Clarify:**
- Do you have existing brand guidelines?
- Are there specific colors, fonts, or visual styles to incorporate?
- Any brand identity examples or references to follow?

### 3. Accessibility Level

Set WCAG compliance target:
- **AA** - Standard compliance (default, suitable for most projects)
- **AAA** - Enhanced compliance (required for government, healthcare, finance)

**Questions to Clarify:**
- What WCAG level is required (AA or AAA)?
- Are there specific accessibility requirements (e.g., screen reader support)?
- Any legal or regulatory accessibility obligations?

### 4. Design System Scope

Define what deliverables are needed:
- **Full** - Tokens + components + accessibility (default)
- **Tokens-only** - Design token architecture only
- **Components-only** - Component library only (assumes tokens exist)

**Questions to Clarify:**
- Do you need the complete design system or specific parts?
- Are design tokens already defined elsewhere?
- Should we include accessibility documentation?

### 5. Visual Reference Systems

Identify any design systems to reference or emulate:
- Material Design (Google)
- Carbon Design System (IBM)
- Ant Design (Alibaba)
- Fluent UI (Microsoft)
- Custom reference

**Questions to Clarify:**
- Are there design systems you want to reference?
- Any visual examples or inspiration sources?
- Should we follow specific design patterns or methodologies?

## Output Requirements

### Requirements Document

```markdown
# Design System Requirements

## Target Platforms
- [ ] Web
- [ ] Mobile (iOS/Android)
- [ ] Desktop

## Brand Identity
- Status: [Existing | New | Partial]
- Guidelines: [Link or description]
- Colors: [Primary palette if known]
- Typography: [Font families if known]

## Accessibility Level
- WCAG Level: [AA | AAA]
- Special requirements: [List any]

## Design System Scope
- Scope: [Full | Tokens-only | Components-only]
- Deliverables:
  - [ ] Design tokens
  - [ ] Component library
  - [ ] Accessibility documentation

## Visual References
- Reference systems: [List design systems to reference]
- Inspiration sources: [Links or descriptions]

## Success Criteria
- [List what "done" looks like for this design system]
```

## Gate Criteria

- [ ] Target platforms identified (minimum 1)
- [ ] Brand identity status clarified
- [ ] Accessibility level set (AA or AAA)
- [ ] Design system scope defined
- [ ] Visual references documented (if any)
- [ ] Success criteria established

## Downstream Context

Phase 1 (Design Pattern Research) will use:
- Target platforms → to research platform-specific patterns
- Brand identity status → to determine if brand creation is needed
- Accessibility level → to research WCAG compliance strategies
- Visual references → to analyze reference design systems

## Common Pitfalls

- Assuming web-only when mobile is also needed
- Not clarifying WCAG level upfront (causes rework later)
- Skipping brand identity discovery (leads to generic designs)
- Unclear scope boundaries (causes feature creep)

## Default Assumptions

If not specified:
- Target platforms: **Web**
- Brand identity: **New** (we'll create it)
- Accessibility level: **AA**
- Design system scope: **Full**

## Agent Invocation Template

```markdown
# Agent Invocation: clarification

## Task Context
- **Task ID:** `{task-id}`
- **Skill:** `develop-ui-ux`
- **Phase:** `0`
- **Domain:** `creative/technical`
- **Agent:** `clarification`

## Role Extension

**Task-Specific Focus:**
- Clarify target platforms for design system
- Determine brand identity status and requirements
- Set WCAG accessibility compliance level
- Define design system scope boundaries
- Identify visual reference systems to emulate

## Task

Clarify design system requirements through structured questions focused on platforms, brand, accessibility, and scope.

Document all requirements in structured format for downstream phases.

## Related Research Terms

- Design system requirements
- Platform-specific design
- Brand identity guidelines
- WCAG accessibility levels
- Design token scope
- Component library planning
- Multi-platform design

## Output

Write to: `.claude/memory/{task-id}-clarification-memory.md`
```
