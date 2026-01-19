# Phase 3: UI/UX Design

**Agent:** orchestrate-synthesis
**Type:** LINEAR
**Purpose:** Follow develop-ui-ux workflow pattern to generate design system with Tailwind

## Context

This phase synthesizes UI/UX design using the develop-ui-ux composite skill workflow pattern. The synthesis agent should follow the develop-ui-ux methodology to produce a comprehensive design system optimized for Tailwind CSS.

## Workflow Pattern: develop-ui-ux

Follow the develop-ui-ux skill phases:
1. Design System Foundation (tokens, scales, conventions)
2. Component Library Specification
3. Accessibility Audit (WCAG AA)
4. Responsive Design Strategy

**Reference:** `develop-ui-ux` skill documentation

## Focus Areas

### 1. Design Tokens (Tailwind Config)

Define Tailwind configuration:
- **Colors:** Primary, secondary, accent, semantic (success, error, warning), neutral scale
- **Typography:** Font families, sizes, weights, line heights
- **Spacing:** Spacing scale (rem-based)
- **Breakpoints:** Responsive breakpoints (sm, md, lg, xl, 2xl)
- **Shadows:** Box shadow scale
- **Border Radius:** Rounding scale
- **Transitions:** Duration and easing

### 2. Component Specifications

Design Lit component specifications:
- **Auth Components:** Login form, OTP verification form, session indicator
- **Layout Components:** Header, footer, navigation, sidebar
- **UI Components:** Buttons, inputs, cards, modals, alerts, tables
- **Form Components:** Text input, email input, number input (OTP), submit button
- **Feedback Components:** Loading spinners, toast notifications, error messages

Each component spec includes:
- Props/attributes
- State management
- Event handlers
- Accessibility attributes (ARIA)
- Tailwind classes applied

### 3. Accessibility (WCAG AA)

Ensure WCAG AA compliance:
- **Perceivable:** Color contrast ratios >= 4.5:1, alt text, semantic HTML
- **Operable:** Keyboard navigation, focus indicators, no keyboard traps
- **Understandable:** Clear labels, error identification, consistent navigation
- **Robust:** Valid HTML, ARIA attributes, screen reader testing

### 4. Responsive Design

Define responsive strategy:
- **Mobile-first:** Base styles for mobile, progressively enhance
- **Breakpoints:** sm (640px), md (768px), lg (1024px), xl (1280px), 2xl (1536px)
- **Layout Patterns:** Stacked (mobile) → grid (desktop)
- **Touch Targets:** Minimum 44x44px for interactive elements

### 5. Design Patterns

Document patterns for:
- **Navigation:** Top nav (desktop), hamburger menu (mobile)
- **Forms:** Inline validation, error display, submit states
- **Feedback:** Toast notifications, loading states, empty states
- **Auth Flow:** Login → OTP entry → authenticated state
- **Error Handling:** 404 pages, error boundaries, network errors

## Context from Previous Phases

- **Phase 0:** Stack config, accessibility requirements
- **Phase 1:** User stories, usability NFRs
- **Phase 2:** Component architecture, API endpoints

## Gate Criteria

- [ ] Design tokens defined in Tailwind config format
- [ ] Component specifications complete with Tailwind classes
- [ ] WCAG AA compliance verified
- [ ] Responsive layouts designed for all breakpoints
- [ ] Design patterns documented
- [ ] Design system ready for implementation in Phase 4

## Output Artifacts

- Tailwind configuration file (tailwind.config.js)
- Component specification document
- Accessibility audit report (WCAG AA checklist)
- Responsive layout designs
- Design pattern guide

## Agent Invocation

```markdown
# Agent Invocation: synthesis

## Task Context
- **Task ID:** `{task-id}`
- **Skill:** `develop-web-app`
- **Phase:** `3`
- **Domain:** `technical`
- **Agent:** `synthesis`
- **Workflow Mode:** CREATE

## Role Extension

**Task-Specific Focus:**
- Follow develop-ui-ux workflow pattern adapted for Tailwind CSS
- Generate design tokens as Tailwind config (not Figma/design tool)
- Specify Lit component library with Tailwind utility classes
- Ensure WCAG AA accessibility compliance
- Design responsive layouts using Tailwind breakpoints
- Create design patterns for auth flow and form interactions

## Johari Context

### Open (from Phase 0-2)
{Stack config, user stories, component architecture}

## Task

Synthesize comprehensive UI/UX design following the develop-ui-ux workflow pattern. Generate a design system optimized for Tailwind CSS and Lit web components.

Ensure design supports:
- Email+OTP authentication flow
- WCAG AA accessibility
- Responsive design (mobile-first)
- Tailwind utility-first approach
- Semantic HTML with ARIA attributes

## Related Research Terms

- Tailwind CSS configuration
- Design tokens
- Lit web component styling
- WCAG AA compliance
- Responsive design patterns
- Accessibility ARIA attributes
- Color contrast ratios
- Mobile-first design

## Output

Write findings to: `.claude/memory/{task-id}-synthesis-memory.md`
```
