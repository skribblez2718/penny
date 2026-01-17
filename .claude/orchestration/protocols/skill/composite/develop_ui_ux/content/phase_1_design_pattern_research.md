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

### 0. Application-Specific Template Research (MANDATORY)

**Purpose:** Discover high-quality UI/UX designs for applications similar to the target application to establish visual quality baseline and inform all subsequent research.

**Execution:** Uses playwright-mcp server to navigate design resource sites and capture screenshots.

#### Step 1: Identify Application Type

Analyze target application functionality to determine search terms:
- **Application Category:** (e.g., recipes app, dashboard, e-commerce, social, productivity)
- **Core Features:** (e.g., content browsing, data visualization, shopping cart)
- **Target Audience:** (e.g., consumer, enterprise, creative professionals)

**Search Term Templates:**
- "[application-type] UI design"
- "[application-type] app template"
- "[application-type] dashboard design"
- "[application-type] mobile app UI"
- "best [application-type] app interface"

#### Step 2: Research Design Resources (via playwright-mcp)

Navigate and search these design resource sites:
1. **Dribbble** (https://dribbble.com/search/{search-term})
2. **Behance** (https://www.behance.net/search/projects?search={search-term})
3. **Mobbin** (https://mobbin.com/browse/apps)
4. **UI8** (https://ui8.net/search?query={search-term})
5. **Figma Community** (https://www.figma.com/community/search?query={search-term})

**Playwright-MCP Workflow:**
```
1. browser_navigate → design resource URL with search query
2. browser_snapshot → capture page state for analysis
3. browser_click → select high-quality design examples
4. browser_take_screenshot → capture full-page screenshots of selected designs
5. Repeat for 5-10 exemplary designs
```

#### Step 3: Quality Criteria for Design Selection

Select designs that demonstrate:

**Visual Excellence (REQUIRED):**
- [ ] Sophisticated color schemes (not generic primary colors)
- [ ] Thoughtful typography hierarchy and spacing
- [ ] Deliberate visual hierarchy guiding user attention
- [ ] Polished micro-interactions and transitions (if visible)
- [ ] Distinctive aesthetic (avoids generic "template" look)

**Accessibility Indicators (REQUIRED):**
- [ ] Clear color contrast between text and backgrounds
- [ ] Readable font sizes (not overly small)
- [ ] Logical information architecture

**Usability Patterns (REQUIRED):**
- [ ] Intuitive navigation structure
- [ ] Clear calls-to-action
- [ ] Consistent component patterns

**Red Flags to AVOID:**
- Generic bootstrap-style layouts
- Obvious AI-generated aesthetics ("AI slop")
- Cluttered or unfocused designs
- Poor contrast or accessibility violations

#### Step 4: Screenshot Storage Protocol

**Directory Structure:**
```
.claude/plans/{task-name}/
└── ui-research/
    ├── ui_research_index.md          # Index of all captured designs
    ├── {app-type}_dribbble_01.png    # Screenshot files
    ├── {app-type}_dribbble_02.png
    ├── {app-type}_behance_01.png
    └── ...
```

**Naming Convention:** `{application-type}_{source}_{number}.png`
- Example: `recipes_dribbble_01.png`, `recipes_behance_02.png`

**Index File Format (ui_research_index.md):**
```markdown
# UI Research Index: {Application Type}

## Research Context
- **Application Type:** {type}
- **Search Terms Used:** {terms}
- **Research Date:** {date}

## Captured Designs

### 1. {Design Title}
- **Source:** {Dribbble/Behance/etc.}
- **URL:** {original URL}
- **Screenshot:** `{filename}.png`
- **Key Features:**
  - {Feature 1}
  - {Feature 2}
- **Relevance:** {How this informs our design}
- **Quality Notes:** {What makes this visually excellent}

[Repeat for each captured design]

## Design Patterns Observed
- {Pattern 1}: Seen in designs {1, 3, 5}
- {Pattern 2}: Seen in designs {2, 4}

## Recommendations for Component Design
- {Recommendation based on research}
```

**Research Queries:**
- "[application-type] UI design inspiration"
- "[application-type] app interface examples"
- "Best [application-type] user experience"
- "[application-type] design system"

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

## 0. Application-Specific Template Research

### Application Context
- Application type: [{application-type}]
- Search terms: [{search-terms}]

### Captured Designs Summary
- Total designs captured: [{count}]
- Storage location: `.claude/plans/{task-name}/ui-research/`
- Index file: `ui_research_index.md`

### Key Visual Patterns Identified
- {Pattern 1}: [Description, seen in designs X, Y]
- {Pattern 2}: [Description]

### Quality Benchmark Established
- Color approach: [What sophisticated designs are doing]
- Typography patterns: [What works well]
- Spacing strategy: [Common patterns]
- Visual hierarchy: [How attention is guided]

### Recommendations
- Component styling should reference: [specific captured designs]
- Color palette inspiration: [from captured designs]
- Layout patterns to adopt: [from captured designs]

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

- [ ] Application-specific template research completed (5-10 designs captured)
- [ ] Screenshots saved to `.claude/plans/{task-name}/ui-research/`
- [ ] Index file created with quality notes and relevance analysis
- [ ] Token format standards researched
- [ ] At least 2 industry design systems analyzed
- [ ] Three-tier token taxonomy pattern documented
- [ ] Atomic design methodology researched
- [ ] Platform-specific patterns identified for target platforms
- [ ] WCAG accessibility patterns researched
- [ ] Research depth parameter satisfied

## Downstream Context

**ALL downstream phases MUST reference:**
- `.claude/plans/{task-name}/ui-research/ui_research_index.md` for design inspiration
- Captured screenshots as visual quality benchmarks

Phase 2 (Platform Analysis) will use:
- Platform-specific patterns → to analyze constraints
- Token format standards → to inform platform token mappings
- **Application-specific research → to identify platform-appropriate patterns**

Phase 3 (Design Token Architecture) will use:
- Three-tier taxonomy research → to design token structure
- Industry design systems → as reference examples
- Token format standards → to structure token files
- **Application-specific research → color palette and typography inspiration**

Phase 4 (Component Library Design) will use:
- Atomic design patterns → component hierarchy
- **Application-specific research → visual styling decisions and quality benchmarks**

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
- **FIRST:** Research application-specific UI/UX templates using playwright-mcp
- Capture 5-10 high-quality design screenshots to `.claude/plans/{task-name}/ui-research/`
- Create index documenting design attributes and relevance
- Research design token format standards (W3C, Style Dictionary)
- Analyze industry design systems (Material, Carbon, Ant Design)
- Document three-tier token taxonomy patterns
- Research atomic design component hierarchy
- Identify platform-specific implementation patterns

## Task

Research design system patterns and best practices to inform token architecture and component library design.

Focus on token formats, industry examples, and platform-specific constraints for [{target_platforms}].

## Related Research Terms

- Application-specific UI templates
- UI/UX design inspiration
- Visual design quality criteria
- Playwright browser automation
- Screenshot documentation
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
