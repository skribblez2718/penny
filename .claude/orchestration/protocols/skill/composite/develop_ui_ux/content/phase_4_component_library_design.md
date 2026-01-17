# Phase 4: Component Library Design

**Type:** LINEAR
**Atomic Skill:** orchestrate-generation
**Agent:** generation

## Objective

Generate atomic design component specifications using token references from Phase 3. All components MUST reference design tokens, not hardcoded values.

## Input Context

From Phase 0:
- Target platforms
- Design system scope

From Phase 1:
- **Application-specific research (MUST REVIEW)**
  - Reference `.claude/plans/{task-name}/ui-research/ui_research_index.md`
  - Use captured designs as visual quality benchmarks
  - Justify component styling decisions against research findings

From Phase 3 (CRITICAL):
- Component tokens (button, input, card, etc.)
- Semantic tokens (interactive, text, surface)
- Token naming conventions

## Atomic Design Methodology

### Atoms (Basic Building Blocks)

**Definition:** Smallest functional components that cannot be broken down further.

#### Button Atom
```markdown
## Button Component

### Variants
- Primary
- Secondary
- Tertiary
- Destructive

### Sizes
- Small (sm)
- Medium (base)
- Large (lg)

### States
- Default
- Hover
- Active
- Focus
- Disabled

### Token References

#### Primary Button
- Background: `$button-primary-bg`
- Background (hover): `$button-primary-bg-hover`
- Background (active): `$button-primary-bg-active`
- Background (disabled): `$button-primary-bg-disabled`
- Text color: `$button-primary-text`
- Border: `$button-primary-border`
- Padding (x): `$button-primary-padding-x`
- Padding (y): `$button-primary-padding-y`
- Border radius: `$button-primary-border-radius`
- Font size: `$font-size-base`
- Font weight: `$button-primary-font-weight`

#### Focus State (All Variants)
- Outline: `$focus-indicator-width solid $focus-indicator-color`
- Outline offset: `$focus-indicator-offset`

### Accessibility
- Role: `button`
- Keyboard: Space, Enter to activate
- Focus: Visible focus indicator
- ARIA: `aria-pressed` for toggle buttons

### Platform Notes
[PLATFORM:WEB]
- HTML: `<button>` element
- CSS: Token-based styling

[PLATFORM:MOBILE]
- iOS: Custom UIButton subclass or SwiftUI Button
- Android: MaterialButton with token theming
```

#### Input Atom
```markdown
## Input Component

### Variants
- Text
- Email
- Password
- Number
- Search

### Sizes
- Small
- Medium
- Large

### States
- Default
- Focus
- Error
- Disabled
- Read-only

### Token References
- Background: `$input-bg`
- Background (disabled): `$input-bg-disabled`
- Border: `$input-border`
- Border (focus): `$input-border-focus`
- Border (error): `$input-border-error`
- Text color: `$input-text`
- Placeholder color: `$input-text-placeholder`
- Padding (x): `$input-padding-x`
- Padding (y): `$input-padding-y`
- Border radius: `$input-border-radius`
- Font size: `$input-font-size`

### Accessibility
- Role: `textbox`
- Labels: Associated `<label>` or `aria-label`
- Error state: `aria-invalid="true"`, `aria-describedby` for error message
- Focus: Visible focus indicator
```

#### Other Atoms
- Icon
- Badge
- Avatar
- Checkbox
- Radio
- Switch/Toggle
- Chip/Tag
- Spinner/Loader
- Divider
- Link

[Specify each with token references, states, accessibility]

### Molecules (Simple Component Groups)

**Definition:** Groups of atoms functioning together as a unit.

#### Form Field Molecule
```markdown
## Form Field Component

### Composition
- Label (text)
- Input (atom)
- Helper text (text)
- Error message (text)

### States
- Default
- Focus (input focused)
- Error (validation failed)
- Disabled

### Token References
- Label color: `$text-secondary`
- Label font size: `$font-size-sm`
- Label margin bottom: `$space-1`
- Helper text color: `$text-tertiary`
- Helper text font size: `$font-size-xs`
- Error text color: `$feedback-error-text`
- Error text font size: `$font-size-xs`
- Spacing between elements: `$space-2`

### Accessibility
- Label: `for` attribute matching input `id`
- Helper text: `aria-describedby` on input
- Error message: `aria-describedby` on input, `role="alert"`
```

#### Card Molecule
```markdown
## Card Component

### Composition
- Container (surface)
- Optional: Header
- Content area
- Optional: Footer

### Variants
- Elevated (with shadow)
- Outlined (with border)
- Filled (with background)

### Token References
- Background: `$card-bg`
- Border: `$card-border`
- Padding: `$card-padding`
- Border radius: `$card-border-radius`
- Elevation: `$card-elevation`
- Header font size: `$font-size-lg`
- Header font weight: `$font-weight-semibold`

### Accessibility
- Semantic HTML: `<article>` or `<section>`
- Heading: Use appropriate heading level for card title
```

#### Other Molecules
- List item
- Dropdown menu
- Tooltip
- Alert/Notification
- Progress bar
- Breadcrumb
- Pagination item
- Tab item

[Specify each with composition, token references, accessibility]

### Organisms (Complex Component Assemblies)

**Definition:** Complex UI sections composed of molecules and atoms.

#### Header Organism
```markdown
## Header Component

### Composition
- Container
- Logo/Brand (icon + text)
- Navigation menu (molecules)
- User actions (buttons/dropdown)

### Variants
- Fixed (sticky header)
- Static
- Transparent (with overlay)

### Token References
- Background: `$surface-primary`
- Border bottom: `$border-secondary`
- Padding (x): `$space-6`
- Padding (y): `$space-4`
- Height: `$space-16` (64px)
- Logo font size: `$font-size-xl`
- Navigation link color: `$text-primary`
- Navigation link hover: `$text-link`

### Accessibility
- Landmark: `<header>` or `role="banner"`
- Navigation: `<nav>` or `role="navigation"`
- Skip link: "Skip to main content" link for keyboard users
```

#### Navigation Sidebar Organism
```markdown
## Navigation Sidebar Component

### Composition
- Container
- Navigation items (list)
- Optional: User profile section
- Optional: Collapse/expand toggle

### States
- Expanded
- Collapsed

### Token References
- Background: `$surface-secondary`
- Width (expanded): `$space-64` (256px)
- Width (collapsed): `$space-16` (64px)
- Item padding: `$space-3`
- Item hover background: `$interactive-secondary-hover`
- Active item background: `$interactive-secondary-active`
- Active item border: `$border-focus`

### Accessibility
- Landmark: `<nav>` or `role="navigation"`
- ARIA: `aria-label="Main navigation"`
- Current page: `aria-current="page"`
- Collapse toggle: `aria-expanded` state
```

#### Other Organisms
- Footer
- Data table
- Modal/Dialog
- Form (multi-field)
- Search bar with results
- User profile card
- Settings panel

[Specify each with composition, token references, accessibility]

## Component Documentation Format

For each component:

1. **Overview** - Purpose and use cases
2. **Composition** - Atoms/molecules used (for molecules/organisms)
3. **Variants** - Different versions (primary/secondary, sizes, etc.)
4. **States** - Interactive states (hover, focus, active, disabled, error)
5. **Token References** - ALL styling values as token references
6. **Accessibility** - ARIA roles, keyboard navigation, WCAG compliance
7. **Platform Notes** - Platform-specific implementation details (if needed)
8. **Examples** - Visual or code examples (optional)

## Token Reference Rules

**CRITICAL:** All component specs MUST reference tokens, not hardcoded values.

**Correct:**
```
Background: $button-primary-bg
Padding: $space-4
```

**Incorrect:**
```
Background: #1E88E5
Padding: 16px
```

## Accessibility Requirements

Each component MUST document:
- Semantic HTML element or ARIA role
- Keyboard navigation behavior
- Focus indicators
- ARIA attributes (if needed)
- Screen reader considerations
- WCAG compliance level

## Output Requirements

### Component Library Specification

```markdown
# Component Library Specification

## Atomic Design Hierarchy

### Atoms ({count})
[List all atomic components]

### Molecules ({count})
[List all molecular components]

### Organisms ({count})
[List all organism components]

---

## Component Specifications

### Atoms

#### Button
[Complete button spec with all variants, states, tokens, accessibility]

#### Input
[Complete input spec]

[Repeat for all atoms]

### Molecules

#### Form Field
[Complete form field spec]

[Repeat for all molecules]

### Organisms

#### Header
[Complete header spec]

[Repeat for all organisms]

---

## Token Reference Summary

### Tokens Used
[List all component tokens referenced]

### Coverage Verification
- [ ] All components reference tokens
- [ ] No hardcoded values present
- [ ] All states documented
- [ ] All accessibility requirements specified
```

## Gate Criteria

- [ ] Atomic design levels complete (atoms, molecules, organisms)
- [ ] All components documented with token references
- [ ] No hardcoded values (all styling references tokens)
- [ ] All component states specified (hover, focus, active, disabled)
- [ ] Accessibility requirements documented for all components
- [ ] Platform-specific notes added (if multi-platform)
- [ ] Component count meets scope requirements

## Downstream Context

Phase 5 (Accessibility Compliance) will use:
- Component specifications → to generate WCAG checklists
- ARIA roles → to document accessibility patterns
- Keyboard navigation → to create testing guidelines

Phase 6 (Validation) will verify:
- All components reference tokens (no hardcoded values)
- Accessibility requirements complete
- Atomic design hierarchy followed

## Component Scope

**Minimum Coverage (for "full" scope):**
- Atoms: 10+ components
- Molecules: 6+ components
- Organisms: 4+ components

**Adjust based on Phase 0 scope:**
- Components-only scope: More comprehensive component library
- Full scope: Balanced coverage across all levels

## Common Pitfalls

- Hardcoding values instead of token references (breaks token architecture)
- Forgetting state variations (hover, focus, active, disabled)
- Missing accessibility requirements
- Not documenting keyboard navigation
- Skipping ARIA roles for custom components
- Inconsistent naming conventions

## Platform-Specific Variations

For multi-platform design systems, note when components differ:

```markdown
[PLATFORM:WEB]
- Implementation: React component with CSS modules
- Unique considerations: Responsive breakpoints

[PLATFORM:MOBILE]
- iOS: SwiftUI view
- Android: Jetpack Compose composable
- Unique considerations: Touch target sizes (min 44x44px)
```

## Agent Invocation Template

```markdown
# Agent Invocation: generation

## Task Context
- **Task ID:** `{task-id}`
- **Skill:** `develop-ui-ux`
- **Phase:** `4`
- **Domain:** `creative/technical`
- **Agent:** `generation`

## Role Extension

**Task-Specific Focus:**
- Generate atomic design component specifications
- Document all component variants and states
- Reference design tokens (NO hardcoded values)
- Specify accessibility requirements per component
- Create atoms, molecules, and organisms

## Task

Generate component library specifications using atomic design methodology.

CRITICAL: All styling MUST reference tokens from Phase 3. No hardcoded values.

## Related Research Terms

- Atomic design methodology
- Component specifications
- Token-driven components
- ARIA roles
- Keyboard navigation
- WCAG component compliance
- Component states
- Accessible components

## Output

Write to: `.claude/memory/{task-id}-generation-memory.md`
```
