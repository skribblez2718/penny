# Phase 5: Accessibility Compliance

**Type:** LINEAR
**Atomic Skill:** orchestrate-generation
**Agent:** generation

## Objective

Generate WCAG accessibility documentation and audit artifacts for the design system.

## Input Context

From Phase 0:
- Accessibility level (AA/AAA)
- Target platforms

From Phase 3:
- Color tokens (for contrast validation)
- Focus indicator tokens

From Phase 4:
- Component specifications
- ARIA roles documented
- Keyboard navigation patterns

## WCAG Compliance Levels

### Level AA (Default)
- Color contrast: 4.5:1 for normal text, 3:1 for large text
- Focus visible: Focus indicators must be visible
- Keyboard accessible: All functionality available via keyboard
- Labels or instructions: Form inputs have labels
- Link purpose: Link text indicates destination

### Level AAA (Enhanced)
- Color contrast: 7:1 for normal text, 4.5:1 for large text
- Enhanced focus visible: Focus indicators with high contrast
- Enhanced keyboard navigation: Additional keyboard shortcuts
- Detailed instructions: Comprehensive form guidance

## Accessibility Artifact Generation

### 1. WCAG Compliance Checklist

Generate comprehensive checklist for [{accessibility_level}]:

```markdown
# WCAG {AA|AAA} Compliance Checklist

## 1. Perceivable

### 1.1 Text Alternatives
- [ ] All images have `alt` text
- [ ] Decorative images use `alt=""` or `role="presentation"`
- [ ] Icons have accessible labels (`aria-label` or visually hidden text)

### 1.2 Time-based Media
- [ ] Audio/video have captions (if applicable)
- [ ] Transcripts provided (if applicable)

### 1.3 Adaptable
- [ ] Content structure uses semantic HTML
- [ ] Reading order is logical
- [ ] Instructions don't rely solely on visual characteristics

### 1.4 Distinguishable

#### Color Contrast ({AA: 4.5:1 | AAA: 7:1} for normal text)
- [ ] Body text meets contrast requirements
- [ ] Link text meets contrast requirements
- [ ] Button text meets contrast requirements
- [ ] Form labels meet contrast requirements
- [ ] Error messages meet contrast requirements

[Document contrast ratios for all text/background combinations]

#### Color Usage
- [ ] Color is not the only means of conveying information
- [ ] Alternative indicators provided (icons, labels, patterns)

#### Focus Indicators
- [ ] Focus indicators visible on all interactive elements
- [ ] Focus indicators meet {AA: 3:1 | AAA: 4.5:1} contrast requirement
- [ ] Focus indicators not obscured by other content

## 2. Operable

### 2.1 Keyboard Accessible
- [ ] All functionality available via keyboard
- [ ] No keyboard traps
- [ ] Keyboard shortcuts documented

### 2.2 Enough Time
- [ ] No time limits (or adjustable/extendable)
- [ ] Timeouts have warnings

### 2.3 Seizures
- [ ] No content flashes more than 3 times per second

### 2.4 Navigable
- [ ] Skip navigation link provided
- [ ] Page titles describe content
- [ ] Focus order is logical
- [ ] Link purpose clear from link text or context
- [ ] Multiple ways to find pages (if multi-page)
- [ ] Headings and labels descriptive
- [ ] Current focus visible

## 3. Understandable

### 3.1 Readable
- [ ] Page language identified (`lang` attribute)
- [ ] Language changes identified

### 3.2 Predictable
- [ ] Components behave consistently
- [ ] Navigation is consistent
- [ ] Consistent identification of components

### 3.3 Input Assistance
- [ ] Error messages identify errors
- [ ] Labels or instructions for user input
- [ ] Error suggestions provided (when known)
- [ ] Error prevention for important actions

## 4. Robust

### 4.1 Compatible
- [ ] Valid HTML (no parsing errors)
- [ ] ARIA roles/states/properties valid
- [ ] Status messages use appropriate ARIA
```

### 2. ARIA Role Assignments

Document ARIA roles for all components:

```markdown
# ARIA Role Reference

## Atoms

### Button
- Role: `button` (implicit with `<button>` element)
- States: `aria-pressed` (for toggle buttons), `aria-disabled`
- Properties: `aria-label` (if no visible text)

### Input
- Role: `textbox` (implicit with `<input>` element)
- States: `aria-invalid` (for error state), `aria-disabled`, `aria-readonly`
- Properties: `aria-label`, `aria-labelledby`, `aria-describedby`, `aria-required`

### Checkbox
- Role: `checkbox` (implicit with `<input type="checkbox">`)
- States: `aria-checked` (true/false/mixed)
- Properties: `aria-label`, `aria-labelledby`

[Repeat for all atomic components]

## Molecules

### Form Field
- Composition roles:
  - Label: Associated via `for`/`id`
  - Input: `textbox` role
  - Helper text: Referenced via `aria-describedby`
  - Error message: `role="alert"`, referenced via `aria-describedby`

### Dropdown Menu
- Trigger: `button` with `aria-expanded`, `aria-haspopup="menu"`
- Menu container: `role="menu"`
- Menu items: `role="menuitem"`
- Properties: `aria-label` for menu

[Repeat for all molecular components]

## Organisms

### Header
- Landmark: `<header>` or `role="banner"`
- Navigation: `<nav>` or `role="navigation"` with `aria-label`

### Modal/Dialog
- Container: `role="dialog"` or `role="alertdialog"`
- Properties: `aria-labelledby` (title), `aria-describedby` (description), `aria-modal="true"`
- Focus management: Trap focus inside modal, restore on close

[Repeat for all organism components]
```

### 3. Keyboard Navigation Patterns

Document keyboard interactions:

```markdown
# Keyboard Navigation Reference

## Global Shortcuts
- Tab: Move focus forward
- Shift+Tab: Move focus backward
- Enter: Activate focused element
- Esc: Close modal/dropdown

## Component-Specific Navigation

### Button
- Space, Enter: Activate button
- [No additional navigation needed]

### Dropdown Menu
- Enter, Space, Down Arrow: Open menu (when focused on trigger)
- Up/Down Arrow: Navigate menu items
- Enter, Space: Select menu item
- Esc: Close menu
- Tab: Close menu and move focus to next element

### Tab Component
- Left/Right Arrow: Navigate between tabs
- Home: Focus first tab
- End: Focus last tab
- Tab: Move focus from tab list to tab panel

### Modal Dialog
- Tab: Cycle through focusable elements within modal
- Esc: Close modal (if dismissible)
- [Focus trap: Focus cannot leave modal]

### Data Table
- Arrow keys: Navigate cells
- Home/End: First/last cell in row
- Page Up/Down: Scroll table (if applicable)

[Document for all interactive components]
```

### 4. Screen Reader Testing Recommendations

```markdown
# Screen Reader Testing Guide

## Recommended Screen Readers
- **NVDA** (Windows, free)
- **JAWS** (Windows, commercial)
- **VoiceOver** (macOS/iOS, built-in)
- **TalkBack** (Android, built-in)

## Testing Checklist

### General
- [ ] All content read in logical order
- [ ] Headings announce level
- [ ] Lists announce item count
- [ ] Links announce destination or purpose

### Forms
- [ ] Form labels read with inputs
- [ ] Required fields announced
- [ ] Error messages read immediately
- [ ] Success feedback announced

### Interactive Components
- [ ] Button purpose clear
- [ ] Current state announced (expanded/collapsed, checked/unchecked)
- [ ] Loading states announced
- [ ] Dynamic content changes announced

### Navigation
- [ ] Landmarks identified (header, nav, main, aside, footer)
- [ ] Skip links functional
- [ ] Breadcrumbs read in order

## Testing Scenarios by Component

[Document specific screen reader expectations for each component type]
```

### 5. Color Contrast Verification

Generate color contrast report:

```markdown
# Color Contrast Verification Report

Target Level: {AA|AAA}

## Text/Background Combinations

### Primary Text
- Foreground: $text-primary (#212121)
- Background: $surface-primary (#FFFFFF)
- Contrast ratio: 16.1:1
- Status: ✅ PASS ({AA: 4.5:1 | AAA: 7:1})

### Secondary Text
- Foreground: $text-secondary (#757575)
- Background: $surface-primary (#FFFFFF)
- Contrast ratio: 4.6:1
- Status: {✅ PASS AA | ❌ FAIL AAA}

### Link Text
- Foreground: $text-link (#1E88E5)
- Background: $surface-primary (#FFFFFF)
- Contrast ratio: 4.8:1
- Status: ✅ PASS AA

### Error Text
- Foreground: $feedback-error-text (#C62828)
- Background: $surface-primary (#FFFFFF)
- Contrast ratio: 7.2:1
- Status: ✅ PASS AAA

[Document all text/background combinations]

## Interactive Elements

### Primary Button
- Text: $button-primary-text (#FFFFFF)
- Background: $button-primary-bg (#1E88E5)
- Contrast ratio: 4.9:1
- Status: ✅ PASS AA

### Focus Indicators
- Indicator: $focus-indicator-color (#1E88E5)
- Adjacent color: varies
- Contrast ratio: {ratio}
- Status: {PASS|FAIL} ({AA: 3:1 | AAA: 4.5:1})

[Document all interactive element contrasts]

## Remediation Recommendations
[If any combinations fail, provide alternatives]
```

### 6. Accessibility Testing Tools

```markdown
# Recommended Accessibility Testing Tools

## Automated Testing
- **axe DevTools** (Browser extension, free)
- **WAVE** (Browser extension, free)
- **Lighthouse** (Chrome DevTools, built-in)
- **Pa11y** (CLI tool, free)

## Manual Testing
- **Color Contrast Analyzer** (Desktop app, free)
- **Screen readers** (See Screen Reader Testing Guide)
- **Keyboard navigation** (No tools needed)

## Testing Workflow
1. Automated scan with axe/WAVE
2. Keyboard navigation testing
3. Screen reader testing
4. Manual color contrast verification
5. Document findings and remediate
```

## Output Requirements

### Accessibility Documentation Package

```markdown
# Accessibility Documentation

## WCAG Compliance Level
- Target: {AA|AAA}
- Status: {Compliant|In Progress|Needs Remediation}

## Deliverables

### 1. WCAG Compliance Checklist
[Link to complete checklist]

### 2. ARIA Role Assignments
[Link to ARIA reference]

### 3. Keyboard Navigation Patterns
[Link to keyboard nav guide]

### 4. Screen Reader Testing Guide
[Link to SR testing recommendations]

### 5. Color Contrast Report
[Link to contrast verification]

### 6. Testing Tools Guide
[Link to tools recommendation]

## Summary

### Compliance Status
- Perceivable: {status}
- Operable: {status}
- Understandable: {status}
- Robust: {status}

### Known Issues
[List any remaining accessibility issues to address]

### Remediation Plan
[If issues exist, outline remediation steps]
```

## Gate Criteria

- [ ] WCAG compliance checklist generated for target level
- [ ] ARIA roles documented for all components
- [ ] Keyboard navigation patterns specified
- [ ] Screen reader testing guide created
- [ ] Color contrast verified for all combinations
- [ ] Testing tools and workflow documented
- [ ] All {AA|AAA} requirements met

## Downstream Context

Phase 6 (Validation) will use:
- WCAG checklist → to verify compliance
- Color contrast report → to validate token choices
- ARIA roles → to verify component specs
- Keyboard navigation → to validate interaction patterns

## Common Pitfalls

- Not verifying color contrast for all states (hover, focus, etc.)
- Missing ARIA roles for custom components
- Incomplete keyboard navigation documentation
- Forgetting screen reader announcements for dynamic changes
- Not testing with actual assistive technologies

## Platform-Specific Considerations

[PLATFORM:WEB]
- Use semantic HTML elements when possible
- Test with multiple browsers and screen readers
- Validate HTML for accessibility errors

[PLATFORM:MOBILE]
- iOS VoiceOver gesture support
- Android TalkBack gesture support
- Touch target sizes (minimum 44x44px/dp)

[PLATFORM:DESKTOP]
- Native accessibility APIs (Windows Accessibility, macOS Accessibility)
- System-level keyboard shortcuts
- Screen reader compatibility (JAWS, NVDA, VoiceOver)

## Agent Invocation Template

```markdown
# Agent Invocation: generation

## Task Context
- **Task ID:** `{task-id}`
- **Skill:** `develop-ui-ux`
- **Phase:** `5`
- **Domain:** `creative/technical`
- **Agent:** `generation`

## Role Extension

**Task-Specific Focus:**
- Generate WCAG {AA|AAA} compliance checklist
- Document ARIA role assignments for all components
- Specify keyboard navigation patterns
- Create screen reader testing recommendations
- Verify color contrast ratios meet WCAG requirements

## Task

Generate comprehensive accessibility documentation for design system.

Target WCAG Level: {AA|AAA}

## Related Research Terms

- WCAG 2.1 guidelines
- ARIA roles and properties
- Keyboard navigation patterns
- Screen reader compatibility
- Color contrast requirements
- Accessible component design
- Assistive technology testing
- Focus management

## Output

Write to: `.claude/memory/{task-id}-generation-memory.md`
```
