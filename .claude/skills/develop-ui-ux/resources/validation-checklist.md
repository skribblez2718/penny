# Design System Validation Checklist

Complete validation criteria for develop-ui-ux skill (Phase 6).

## 1. Token Architecture Validation

### Structural Integrity (Critical)

- [ ] **Three-tier taxonomy** - Primitive → Semantic → Component hierarchy maintained
- [ ] **No hardcoded values in semantic tokens** - All semantic tokens reference primitive tokens
- [ ] **No hardcoded values in component tokens** - All component tokens reference semantic tokens
- [ ] **Token naming conventions** - Consistent format `$category-property-variant-state`
- [ ] **All token categories present** - Color, spacing, typography, border-radius, elevation, opacity, z-index

### Primitive Token Completeness

- [ ] **Color palette** - Full color scale (50-900 for each brand color)
- [ ] **Grayscale palette** - Complete grayscale (50-900 or equivalent)
- [ ] **Spacing scale** - Consistent scale with base unit (typically 4px or 8px)
- [ ] **Typography tokens** - Font families, sizes, weights, line heights
- [ ] **Border radius tokens** - Multiple sizes (sm, base, lg, xl, full)
- [ ] **Elevation tokens** - Shadow values for depth
- [ ] **Opacity tokens** - Standard opacity values
- [ ] **Z-index tokens** - Layering values

### Semantic Token Completeness

- [ ] **Surface tokens** - Primary, secondary, tertiary, overlay, inverse
- [ ] **Text tokens** - Primary, secondary, tertiary, disabled, inverse, link, error, success, warning
- [ ] **Interactive tokens** - Primary, secondary with all states (hover, active, disabled)
- [ ] **Border tokens** - Primary, secondary, focus, error
- [ ] **Feedback tokens** - Error, success, warning, info (surface, border, text)

### Component Token Completeness

- [ ] **Button tokens** - All variants (primary, secondary, tertiary, destructive) with states
- [ ] **Input tokens** - All properties and states
- [ ] **All component tokens exist** - Tokens for every component in Phase 4

### Platform Compatibility

- [ ] **Platform-agnostic structure** - Tokens work across all target platforms
- [ ] **Transformation documented** - Clear approach to transform tokens per platform
- [ ] **Platform overrides identified** - Platform-specific variations documented (if needed)

## 2. Component Library Validation

### Atomic Design Coverage

- [ ] **Minimum 10 atoms** - Button, Input, Icon, Badge, Avatar, Checkbox, Radio, Switch, Link, Spinner
- [ ] **Minimum 6 molecules** - Form Field, Card, List Item, Dropdown Menu, Tooltip, Alert
- [ ] **Minimum 4 organisms** - Header, Navigation Sidebar, Footer, Modal/Dialog
- [ ] **Hierarchy followed** - Molecules use atoms, organisms use molecules and atoms

### Token Reference Compliance (Critical)

- [ ] **All components reference tokens** - NO hardcoded values for colors, spacing, typography
- [ ] **Valid token references** - All referenced tokens exist in Phase 3 architecture
- [ ] **Consistent referencing** - Token reference format used consistently

### Component State Coverage

- [ ] **Default state** - All components document default appearance
- [ ] **Hover state** - Interactive components document hover behavior
- [ ] **Focus state** - Interactive components document focus indicators
- [ ] **Active state** - Interactive components document active/pressed state
- [ ] **Disabled state** - Interactive components document disabled appearance
- [ ] **Error state** - Form components document error appearance

### Documentation Quality

- [ ] **Purpose/description** - Each component has clear use case
- [ ] **Variants** - All component variants documented
- [ ] **Composition** - Molecules/organisms document atom/molecule usage
- [ ] **Token references** - All styling uses token references
- [ ] **Platform notes** - Platform-specific implementation details added (if multi-platform)

## 3. Accessibility Validation

### WCAG Compliance (AA)

#### Perceivable
- [ ] **Color contrast (normal text)** - Minimum 4.5:1 ratio
- [ ] **Color contrast (large text)** - Minimum 3:1 ratio
- [ ] **Color not sole indicator** - Alternative indicators provided
- [ ] **Text alternatives** - Images have alt text, icons have labels
- [ ] **Semantic HTML** - Proper heading hierarchy, lists, etc.

#### Operable
- [ ] **Keyboard accessible** - All functionality available via keyboard
- [ ] **No keyboard traps** - Focus can always move away
- [ ] **Keyboard shortcuts documented** - Navigation patterns specified
- [ ] **Focus visible** - Focus indicators meet 3:1 contrast
- [ ] **Skip navigation** - Skip link provided for page navigation

#### Understandable
- [ ] **Predictable** - Components behave consistently
- [ ] **Labels/instructions** - Form inputs have labels
- [ ] **Error identification** - Error messages identify errors
- [ ] **Error suggestions** - Suggestions provided when known

#### Robust
- [ ] **Valid HTML** - No parsing errors
- [ ] **Valid ARIA** - Roles, states, properties used correctly

### WCAG Compliance (AAA)

If AAA level required:
- [ ] **Color contrast (normal text)** - Minimum 7:1 ratio
- [ ] **Color contrast (large text)** - Minimum 4.5:1 ratio
- [ ] **Enhanced focus visible** - Focus indicators meet 4.5:1 contrast
- [ ] **Enhanced instructions** - Detailed form guidance
- [ ] **Additional keyboard shortcuts** - Enhanced navigation

### ARIA Documentation

- [ ] **All components have roles** - Appropriate ARIA roles specified
- [ ] **Custom components have ARIA** - Proper roles for non-standard elements
- [ ] **States documented** - ARIA states for stateful components (expanded, checked, etc.)
- [ ] **Properties documented** - ARIA labels, descriptions, etc.

### Keyboard Navigation

- [ ] **Patterns documented** - Keyboard interactions for all components
- [ ] **Focus management** - Focus trapping for modals, focus restoration
- [ ] **Shortcuts specified** - Keyboard shortcuts documented
- [ ] **No traps verified** - Confirmed no keyboard traps

### Screen Reader Support

- [ ] **Testing guide created** - Screen reader testing recommendations
- [ ] **Announcements documented** - Dynamic content change announcements
- [ ] **Landmarks identified** - Header, nav, main, aside, footer
- [ ] **Live regions specified** - ARIA live regions for dynamic updates

## 4. Platform Validation

### [PLATFORM:WEB]

- [ ] **CSS implementation defined** - CSS custom properties, SCSS, CSS-in-JS approach
- [ ] **Responsive breakpoints** - Mobile, tablet, desktop breakpoints specified
- [ ] **Browser compatibility** - Minimum browser versions documented
- [ ] **Framework compatibility** - React, Vue, Angular, Svelte notes (if applicable)
- [ ] **SSR/SSG support** - Next.js, Gatsby, Nuxt considerations (if applicable)

### [PLATFORM:MOBILE]

- [ ] **iOS implementation notes** - SwiftUI, UIKit approach
- [ ] **Android implementation notes** - Jetpack Compose, XML approach
- [ ] **Touch targets** - Minimum 44x44px/dp size met
- [ ] **Platform guidelines** - iOS HIG, Android Material Design followed
- [ ] **Dark mode** - Light/dark mode token strategy (if applicable)

### [PLATFORM:DESKTOP]

- [ ] **Desktop approach defined** - Electron, native (WPF, SwiftUI, Qt)
- [ ] **OS integration** - Native menu bars, system dialogs
- [ ] **Keyboard shortcuts** - Desktop-specific shortcuts
- [ ] **Window management** - Titlebar, controls, sizing patterns

### Cross-Platform

- [ ] **Token transformation** - Clear transformation pipeline for all platforms
- [ ] **Shared patterns** - Core patterns work across platforms
- [ ] **Platform variations** - Differences documented and justified

## 5. Requirements Validation

Against Phase 0 requirements:

- [ ] **Target platforms addressed** - All specified platforms have implementation notes
- [ ] **Brand identity incorporated** - Existing brand guidelines applied (if applicable)
- [ ] **Accessibility level achieved** - WCAG AA or AAA met
- [ ] **Scope delivered** - Full/tokens-only/components-only scope met
- [ ] **Visual references applied** - Reference design systems incorporated appropriately

## Scoring Guide

### Token Architecture (25% weight)
- Critical: Three-tier structure, no hardcoded values
- Pass threshold: 90% criteria met

### Component Library (30% weight)
- Critical: Token references, state coverage
- Pass threshold: 85% criteria met

### Accessibility (30% weight)
- Critical: WCAG compliance
- Pass threshold: AA=95%, AAA=100%

### Platform Compatibility (10% weight)
- Critical: All platforms addressed
- Pass threshold: 90% criteria met

### Requirements Alignment (5% weight)
- Critical: All Phase 0 requirements met
- Pass threshold: 100% criteria met

## Overall Decision

**PASS:** Overall score ≥ 90%
- Design system ready for implementation
- All quality criteria substantially met

**CONDITIONAL:** Overall score 75-89%
- Minor issues documented and accepted
- Proceed with known issues register

**FAIL:** Overall score < 75%
- Critical issues require remediation
- Loop back to Phase 4 (Component Library Design)
- Maximum 2 remediation iterations

## Remediation Guidelines

### When to Loop Back
- Hardcoded values in components (breaks token architecture)
- WCAG compliance failures
- Missing critical accessibility documentation
- Insufficient component coverage

### What to Preserve
- Phase 3 token architecture (unchanged)
- Phase 0, 1, 2 outputs (unchanged)

### What to Regenerate
- Phase 4: Component library specifications
- Phase 5: Accessibility documentation
- Phase 6: Re-validation

### Remediation Limit
- Maximum 2 iterations
- After 2 failures: Escalate to user for scope/requirements adjustment
