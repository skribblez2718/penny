# Phase 1: Design Pattern Research

**Type:** LINEAR
**Atomic Skill:** orchestrate-research
**Agent:** research

## Objective

Research design system patterns, token formats, and industry best practices to inform token architecture and component design.

## Input Context

From Phase 0:
- Target platforms (web/mobile/desktop)
- Brand identity status
- Accessibility level (AA/AAA)
- Visual reference systems

## Research Focus Areas

### 1. Design Token Format Standards

Research token specification formats and tooling:
- **W3C Design Tokens** - Community group specification
- **Style Dictionary** - Token transformation framework (Amazon)
- **Theo** - Token transformation tool (Salesforce)
- **JSON Token Format** - Industry-standard token files

**Research Queries:**
- "W3C Design Tokens specification format"
- "Style Dictionary token transformation best practices"
- "Design token naming conventions industry standards"

### 2. Industry Design Systems

Analyze reference design systems for patterns:
- **Material Design** (Google) - Material 3, token structure
- **Carbon Design System** (IBM) - Token taxonomy, component patterns
- **Ant Design** (Alibaba) - Component library structure
- **Fluent UI** (Microsoft) - Fluent 2, accessibility patterns

**Research Queries:**
- "Material Design 3 token architecture"
- "Carbon Design System token taxonomy"
- "Ant Design component library structure"
- "Fluent UI accessibility implementation"

### 3. Three-Tier Token Taxonomy

Research token hierarchies and relationships:
- **Primitive tokens** - Raw values (colors, spacing units, font sizes)
- **Semantic tokens** - Purpose-based (surface, text, interactive)
- **Component tokens** - Component-specific (button, input, card)

**Research Queries:**
- "Design token three-tier taxonomy best practices"
- "Semantic design tokens vs primitive tokens"
- "Component token architecture patterns"

### 4. Atomic Design Methodology

Research component hierarchy patterns:
- **Atoms** - Basic building blocks (button, input, icon)
- **Molecules** - Simple component groups (form field, card)
- **Organisms** - Complex component assemblies (header, footer)

**Research Queries:**
- "Atomic design methodology Brad Frost"
- "Atomic design component hierarchy examples"
- "Design system component classification patterns"

### 5. Platform-Specific Patterns

Research platform constraints for target platforms:

#### [PLATFORM:WEB]
- CSS custom properties (CSS variables)
- Responsive breakpoint strategies
- CSS-in-JS vs CSS modules

**Research Queries:**
- "CSS custom properties design tokens implementation"
- "Responsive design breakpoint best practices"

#### [PLATFORM:MOBILE]
- iOS Human Interface Guidelines
- Android Material Design Guidelines
- Platform-specific token mappings

**Research Queries:**
- "iOS design token implementation patterns"
- "Android Material Design token structure"

#### [PLATFORM:DESKTOP]
- Electron design patterns
- Native desktop UI guidelines (Windows, macOS, Linux)

**Research Queries:**
- "Electron design system implementation"
- "Cross-platform desktop UI patterns"

### 6. Accessibility Best Practices

Research WCAG implementation strategies:
- Color contrast requirements (AA: 4.5:1, AAA: 7:1)
- Focus indicator patterns
- ARIA role best practices
- Keyboard navigation patterns

**Research Queries:**
- "WCAG 2.1 Level AA color contrast requirements"
- "Accessible component design patterns"
- "ARIA roles for common UI components"

## Output Requirements

### Research Report

```markdown
# Design Pattern Research Report

## 1. Token Format Standards
- **W3C Design Tokens:** [Key findings]
- **Style Dictionary:** [Transformation approach]
- **Recommended format:** [JSON/YAML/etc.]

## 2. Industry Design Systems Analysis

### Material Design
- Token structure: [Summary]
- Component patterns: [Key patterns]

### Carbon Design System
- Token taxonomy: [Summary]
- Best practices: [Key learnings]

[Repeat for Ant Design, Fluent UI, etc.]

## 3. Three-Tier Token Taxonomy
- Primitive tokens: [Structure and examples]
- Semantic tokens: [Structure and examples]
- Component tokens: [Structure and examples]

## 4. Atomic Design Patterns
- Atoms: [Common examples]
- Molecules: [Common patterns]
- Organisms: [Common assemblies]

## 5. Platform-Specific Patterns

[PLATFORM:WEB]
- CSS implementation: [Approach]
- Responsive strategy: [Breakpoints]

[PLATFORM:MOBILE]
- iOS patterns: [Key guidelines]
- Android patterns: [Key guidelines]

[PLATFORM:DESKTOP]
- Desktop patterns: [Key guidelines]

## 6. Accessibility Patterns
- WCAG Level {AA|AAA}: [Requirements]
- Color contrast: [Ratios and tools]
- ARIA patterns: [Common roles]
- Keyboard navigation: [Patterns]

## Recommendations
- Token format: [Recommendation]
- Component hierarchy: [Recommendation]
- Platform approach: [Recommendation]
```

## Gate Criteria

- [ ] Token format standards researched
- [ ] At least 2 industry design systems analyzed
- [ ] Three-tier token taxonomy pattern documented
- [ ] Atomic design methodology researched
- [ ] Platform-specific patterns identified for target platforms
- [ ] WCAG accessibility patterns researched
- [ ] Research depth parameter satisfied

## Downstream Context

Phase 2 (Platform Analysis) will use:
- Platform-specific patterns → to analyze constraints
- Token format standards → to inform platform token mappings

Phase 3 (Design Token Architecture) will use:
- Three-tier taxonomy research → to design token structure
- Industry design systems → as reference examples
- Token format standards → to structure token files

## Research Depth Parameter

Default: **MODERATE**
- 2-3 industry design systems analyzed
- Key patterns documented
- Best practices extracted

Can be configured:
- **SHALLOW** - Quick overview, minimal examples
- **DEEP** - Comprehensive analysis, detailed comparisons

## Common Pitfalls

- Researching too many design systems (analysis paralysis)
- Not researching platform-specific constraints early
- Ignoring accessibility patterns until later
- Not documenting token taxonomy patterns clearly

## Agent Invocation Template

```markdown
# Agent Invocation: research

## Task Context
- **Task ID:** `{task-id}`
- **Skill:** `develop-ui-ux`
- **Phase:** `1`
- **Domain:** `creative/technical`
- **Agent:** `research`

## Role Extension

**Task-Specific Focus:**
- Research design token format standards (W3C, Style Dictionary)
- Analyze industry design systems (Material, Carbon, Ant Design)
- Document three-tier token taxonomy patterns
- Research atomic design component hierarchy
- Identify platform-specific implementation patterns

## Task

Research design system patterns and best practices to inform token architecture and component library design.

Focus on token formats, industry examples, and platform-specific constraints for [{target_platforms}].

## Related Research Terms

- W3C Design Tokens
- Style Dictionary
- Three-tier token taxonomy
- Atomic design methodology
- Material Design tokens
- Carbon Design System
- WCAG accessibility patterns
- Platform-specific design patterns

## Output

Write to: `.claude/memory/{task-id}-research-memory.md`
```
