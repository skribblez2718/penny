# Phase 3: Design Token Architecture

**Type:** LINEAR (CRITICAL PATH)
**Atomic Skill:** orchestrate-synthesis
**Agent:** synthesis

## Objective

Synthesize platform-agnostic design token architecture using three-tier taxonomy (primitive → semantic → component).

**CRITICAL:** This is the CRITICAL PATH phase. All subsequent phases depend on the token architecture designed here.

## Input Context

From Phase 0:
- Brand identity requirements
- Accessibility level (AA/AAA)

From Phase 1:
- Three-tier token taxonomy research
- Industry design system examples
- Token format standards
- **Application-specific template research (`.claude/plans/{task-name}/ui-research/`)**
  - Color palette inspiration from captured designs
  - Typography patterns from exemplary templates

From Phase 2:
- Platform-specific constraints
- Cross-platform token strategy
- Token transformation approach

## Three-Tier Token Taxonomy

### Tier 1: Primitive Tokens

**Definition:** Raw design values with no semantic meaning. These are the foundation.

#### Color Primitives
```
$color-blue-50: #E3F2FD
$color-blue-100: #BBDEFB
$color-blue-200: #90CAF9
...
$color-blue-900: #0D47A1

$color-gray-50: #FAFAFA
...
$color-gray-900: #212121

[Repeat for all brand colors]
```

**Requirements:**
- Full color palette (50-900 scale)
- WCAG contrast validation
- Light/Dark mode variants (if needed)

#### Spacing Primitives
```
$space-1: 4px
$space-2: 8px
$space-3: 12px
$space-4: 16px
$space-5: 20px
$space-6: 24px
...
$space-16: 64px
```

**Requirements:**
- Base unit (typically 4px or 8px)
- Consistent scale (linear or modular)

#### Typography Primitives
```
$font-family-primary: 'Inter', sans-serif
$font-family-secondary: 'Georgia', serif
$font-family-mono: 'Fira Code', monospace

$font-size-xs: 12px
$font-size-sm: 14px
$font-size-base: 16px
$font-size-lg: 18px
$font-size-xl: 20px
$font-size-2xl: 24px
...

$font-weight-light: 300
$font-weight-regular: 400
$font-weight-medium: 500
$font-weight-semibold: 600
$font-weight-bold: 700

$line-height-tight: 1.25
$line-height-normal: 1.5
$line-height-relaxed: 1.75
```

#### Other Primitives
```
$border-radius-sm: 2px
$border-radius-base: 4px
$border-radius-lg: 8px
$border-radius-xl: 12px
$border-radius-full: 9999px

$elevation-1: 0 1px 2px rgba(0,0,0,0.1)
$elevation-2: 0 2px 4px rgba(0,0,0,0.1)
...

$opacity-0: 0
$opacity-25: 0.25
$opacity-50: 0.5
$opacity-75: 0.75
$opacity-100: 1

$z-index-dropdown: 1000
$z-index-modal: 2000
$z-index-tooltip: 3000
```

### Tier 2: Semantic Tokens

**Definition:** Purpose-based tokens that reference primitives. These convey meaning.

#### Surface Semantic Tokens
```
$surface-primary: $color-white
$surface-secondary: $color-gray-50
$surface-tertiary: $color-gray-100
$surface-overlay: rgba($color-black, $opacity-50)
$surface-inverse: $color-gray-900
```

#### Text Semantic Tokens
```
$text-primary: $color-gray-900
$text-secondary: $color-gray-700
$text-tertiary: $color-gray-500
$text-disabled: $color-gray-400
$text-inverse: $color-white
$text-link: $color-blue-600
$text-error: $color-red-600
$text-success: $color-green-600
$text-warning: $color-yellow-700
```

#### Interactive Semantic Tokens
```
$interactive-primary: $color-blue-600
$interactive-primary-hover: $color-blue-700
$interactive-primary-active: $color-blue-800
$interactive-primary-disabled: $color-gray-300

$interactive-secondary: $color-gray-200
$interactive-secondary-hover: $color-gray-300
...
```

#### Border Semantic Tokens
```
$border-primary: $color-gray-300
$border-secondary: $color-gray-200
$border-focus: $color-blue-500
$border-error: $color-red-500
```

#### Feedback Semantic Tokens
```
$feedback-error-surface: $color-red-50
$feedback-error-border: $color-red-300
$feedback-error-text: $color-red-700

$feedback-success-surface: $color-green-50
...

$feedback-warning-surface: $color-yellow-50
...

$feedback-info-surface: $color-blue-50
...
```

### Tier 3: Component Tokens

**Definition:** Component-specific tokens that reference semantic tokens. These are implementation-ready.

#### Button Component Tokens
```
// Primary Button
$button-primary-bg: $interactive-primary
$button-primary-bg-hover: $interactive-primary-hover
$button-primary-bg-active: $interactive-primary-active
$button-primary-bg-disabled: $interactive-primary-disabled
$button-primary-text: $text-inverse
$button-primary-border: transparent
$button-primary-padding-x: $space-4
$button-primary-padding-y: $space-2
$button-primary-border-radius: $border-radius-base
$button-primary-font-weight: $font-weight-medium

// Secondary Button
$button-secondary-bg: $interactive-secondary
...

// Small Button
$button-sm-padding-x: $space-3
$button-sm-padding-y: $space-1
$button-sm-font-size: $font-size-sm
```

#### Input Component Tokens
```
$input-bg: $surface-primary
$input-bg-disabled: $surface-secondary
$input-border: $border-primary
$input-border-focus: $border-focus
$input-border-error: $border-error
$input-text: $text-primary
$input-text-placeholder: $text-tertiary
$input-padding-x: $space-3
$input-padding-y: $space-2
$input-border-radius: $border-radius-base
$input-font-size: $font-size-base
```

#### Card Component Tokens
```
$card-bg: $surface-primary
$card-border: $border-secondary
$card-padding: $space-4
$card-border-radius: $border-radius-lg
$card-elevation: $elevation-1
```

[Repeat for all components]

## Token Naming Conventions

**Format:** `$category-property-variant-state`

**Examples:**
- `$color-blue-600` - primitive
- `$text-primary` - semantic
- `$button-primary-bg-hover` - component (with state)

**Rules:**
- Lowercase with hyphens
- Descriptive, not prescriptive (use "primary" not "blue")
- Include state modifiers (hover, active, focus, disabled)

## Token File Structure

```json
{
  "color": {
    "blue": {
      "50": "#E3F2FD",
      "100": "#BBDEFB",
      ...
      "900": "#0D47A1"
    }
  },
  "spacing": {
    "1": "4px",
    "2": "8px",
    ...
  },
  "typography": {
    "fontFamily": {
      "primary": "Inter, sans-serif"
    },
    "fontSize": {
      "xs": "12px",
      ...
    }
  },
  "semantic": {
    "surface": {
      "primary": "{color.white}",
      "secondary": "{color.gray.50}"
    },
    "text": {
      "primary": "{color.gray.900}",
      ...
    }
  },
  "component": {
    "button": {
      "primary": {
        "bg": "{semantic.interactive.primary}",
        "bgHover": "{semantic.interactive.primary-hover}",
        ...
      }
    }
  }
}
```

**Note:** Use token references (e.g., `{color.blue.600}`) not hardcoded values in semantic/component tiers.

## Accessibility Integration

### WCAG Color Contrast Requirements

**Level AA:**
- Normal text: 4.5:1 contrast ratio
- Large text: 3:1 contrast ratio

**Level AAA:**
- Normal text: 7:1 contrast ratio
- Large text: 4.5:1 contrast ratio

**Implementation:**
- Validate all text/background combinations
- Document contrast ratios in token comments
- Provide high-contrast token alternatives if needed

### Focus Indicators

```
$focus-indicator-color: $border-focus
$focus-indicator-width: 2px
$focus-indicator-offset: 2px
```

Must meet WCAG 2.4.7 (AA) or 2.4.11 (AAA) requirements.

## Platform Token Transformation

Define how tokens transform to each platform:

**Web (CSS):**
```css
:root {
  --color-blue-600: #1E88E5;
  --text-primary: var(--color-gray-900);
  --button-primary-bg: var(--interactive-primary);
}
```

**iOS (Swift):**
```swift
extension Color {
  static let colorBlue600 = Color(hex: "#1E88E5")
  static let textPrimary = colorGray900
}
```

**Android (XML):**
```xml
<color name="color_blue_600">#1E88E5</color>
<color name="text_primary">@color/color_gray_900</color>
```

## Output Requirements

### Token Architecture Document

```markdown
# Design Token Architecture

## Overview
- Token format: [JSON/YAML]
- Transformation tool: [Style Dictionary/Theo]
- Total tokens: [Count]

## Tier 1: Primitive Tokens

### Colors
[Complete color palette with hex values]

### Spacing
[Complete spacing scale]

### Typography
[Font families, sizes, weights, line heights]

### Other Primitives
[Border radius, elevation, opacity, z-index]

## Tier 2: Semantic Tokens

### Surface Tokens
[All surface tokens with references]

### Text Tokens
[All text tokens with references]

### Interactive Tokens
[All interactive tokens with states]

### Border Tokens
[All border tokens]

### Feedback Tokens
[All feedback tokens for error/success/warning/info]

## Tier 3: Component Tokens

### Button Tokens
[All button variants and states]

### Input Tokens
[All input variants and states]

### Card Tokens
[All card tokens]

[Repeat for all planned components]

## Token Files

### tokens.json
[Complete JSON token file]

### Platform Transformations
[Style Dictionary config or transformation rules]

## Accessibility Validation
- WCAG Level: [{AA|AAA}]
- Contrast ratios: [Documented]
- Focus indicators: [Specified]

## Token Naming Conventions
[Complete naming rules and examples]
```

## Gate Criteria

- [ ] Three-tier taxonomy complete (primitive, semantic, component)
- [ ] All primitive tokens defined (colors, spacing, typography)
- [ ] All semantic tokens reference primitives (no hardcoded values)
- [ ] All component tokens reference semantic tokens
- [ ] Token naming conventions established
- [ ] WCAG contrast requirements validated
- [ ] Token file structure defined
- [ ] Platform transformation approach documented

## Downstream Context

Phase 4 (Component Library Design) will use:
- Component tokens → as the foundation for all component specs
- Naming conventions → to maintain consistency
- Token structure → to reference tokens in components

Phase 5 (Accessibility Compliance) will use:
- Color tokens → to validate contrast ratios
- Focus indicator tokens → for keyboard navigation specs

Phase 6 (Validation) will verify:
- Three-tier structure maintained
- No hardcoded values in semantic/component tiers
- WCAG contrast requirements met

## Critical Success Factors

1. **No Hardcoded Values** - Semantic and component tokens MUST reference other tokens, never raw values
2. **Complete Coverage** - All visual properties needed by components must have tokens
3. **Platform Agnostic** - Tokens should work across all target platforms
4. **Accessibility Compliant** - All color combinations must meet WCAG requirements

## Common Pitfalls

- Hardcoding values in semantic/component tokens (breaks the taxonomy)
- Missing states (hover, active, focus, disabled)
- Insufficient color palette (not enough shades)
- Ignoring WCAG contrast validation until later
- Platform-specific tokens in the core architecture

## Agent Invocation Template

```markdown
# Agent Invocation: synthesis

## Task Context
- **Task ID:** `{task-id}`
- **Skill:** `develop-ui-ux`
- **Phase:** `3`
- **Domain:** `creative/technical`
- **Agent:** `synthesis`

## Role Extension

**Task-Specific Focus:**
- Design three-tier token taxonomy (primitive → semantic → component)
- Define complete primitive token palette (colors, spacing, typography)
- Create semantic tokens with purpose-based naming
- Generate component tokens for all planned components
- Validate WCAG contrast requirements for [{accessibility_level}]

## Task

Synthesize platform-agnostic design token architecture that serves as the foundation for all components.

CRITICAL: Ensure semantic/component tokens reference other tokens, never hardcoded values.

## Related Research Terms

- Three-tier token taxonomy
- Primitive design tokens
- Semantic design tokens
- Component design tokens
- WCAG color contrast
- Token transformation
- Style Dictionary
- Platform-agnostic tokens

## Output

Write to: `.claude/memory/{task-id}-synthesis-memory.md`
```
