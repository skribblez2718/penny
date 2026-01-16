# Phase 2: Platform Analysis

**Type:** LINEAR
**Atomic Skill:** orchestrate-analysis
**Agent:** analysis

## Objective

Analyze platform-specific constraints and requirements for target platforms to ensure token architecture and components work across all intended platforms.

## Input Context

From Phase 0:
- Target platforms (web/mobile/desktop)
- Brand identity requirements

From Phase 1:
- Platform-specific pattern research
- Token format standards
- Industry design system examples

## Analysis Focus Areas

### 1. Platform Constraints Analysis

For each target platform, analyze:
- Technical limitations
- Design guidelines
- Token implementation approaches
- Responsive/adaptive requirements

### 2. Platform-Specific Sections

#### [PLATFORM:WEB]

**Technical Constraints:**
- Browser compatibility (modern browsers, IE11 if needed)
- CSS custom property support
- JavaScript framework compatibility (React, Vue, Angular, Svelte)
- SSR/SSG considerations (Next.js, Gatsby, Nuxt)

**Design Guidelines:**
- Responsive breakpoints (mobile-first vs desktop-first)
- Touch target sizes (min 44x44px for mobile)
- Viewport units and scaling

**Token Implementation:**
- CSS custom properties (`:root` scope)
- SCSS/SASS variables
- CSS-in-JS token mapping
- PostCSS token transformation

**Analysis Questions:**
- What are minimum browser requirements?
- Should we support SSR/SSG frameworks?
- What responsive breakpoint strategy fits best?
- How will tokens integrate with CSS frameworks?

#### [PLATFORM:MOBILE]

**iOS Constraints:**
- SwiftUI color/spacing systems
- SF Symbols icon system
- Dynamic Type text scaling
- Light/Dark mode support

**Android Constraints:**
- Material Design 3 token mapping
- Jetpack Compose theming
- XML theme attributes
- Vector drawable icon system

**Design Guidelines:**
- iOS Human Interface Guidelines spacing (8pt grid)
- Android Material Design spacing (4dp grid)
- Platform-specific navigation patterns
- Platform-specific interaction patterns

**Token Implementation:**
- iOS: Swift color assets, spacing constants
- Android: colors.xml, dimens.xml, themes.xml
- React Native: JavaScript token objects
- Flutter: Dart theme data

**Analysis Questions:**
- Support native (Swift/Kotlin) or cross-platform (React Native/Flutter)?
- How to handle platform-specific icons?
- Light/Dark mode token strategy?
- Platform-specific spacing grid alignment?

#### [PLATFORM:DESKTOP]

**Electron Constraints:**
- Chromium rendering engine
- Native OS integration (menu bars, system dialogs)
- Window management (titlebar, controls)

**Native Constraints:**
- Windows: WPF, WinUI 3 theming
- macOS: AppKit, SwiftUI design guidelines
- Linux: GTK, Qt theming

**Design Guidelines:**
- Desktop-specific interaction patterns (hover, right-click)
- Keyboard shortcuts and accessibility
- Window sizing and responsive layout
- Native OS appearance matching

**Token Implementation:**
- Electron: Same as web (CSS custom properties)
- WPF: ResourceDictionary XAML
- SwiftUI: Asset catalogs
- Qt: QSS (Qt Style Sheets)

**Analysis Questions:**
- Electron or native desktop?
- Should design match native OS appearance?
- How to handle desktop-specific components (menu bars, toolbars)?
- Keyboard navigation patterns?

### 3. Cross-Platform Compatibility

Analyze how token architecture can work across all target platforms:

**Primitive Token Compatibility:**
- Colors: Hex, RGB, HSL compatibility
- Spacing: px, rem, em, dp, pt conversions
- Typography: Font family availability across platforms

**Semantic Token Compatibility:**
- Platform-neutral naming conventions
- Platform-specific token overrides (if needed)

**Component Token Compatibility:**
- Shared component patterns
- Platform-specific component variations

## Output Requirements

### Platform Analysis Report

```markdown
# Platform Analysis Report

## Target Platforms
- [x] Web
- [x] Mobile (iOS/Android)
- [x] Desktop

---

[PLATFORM:WEB]

## Web Platform Analysis

### Technical Constraints
- Browser support: [List]
- Framework compatibility: [React/Vue/Angular]
- SSR/SSG requirements: [Yes/No]

### Token Implementation Approach
- Format: CSS custom properties
- Scope: `:root` level
- Transformation: [Style Dictionary/Theo/Custom]

### Responsive Strategy
- Breakpoints: [Mobile/Tablet/Desktop sizes]
- Approach: [Mobile-first/Desktop-first]

### Key Constraints
- [List technical limitations or requirements]

---

[PLATFORM:MOBILE]

## Mobile Platform Analysis

### iOS Constraints
- SwiftUI version: [iOS 14+/15+/16+]
- Icon system: SF Symbols
- Text scaling: Dynamic Type
- Theme modes: Light + Dark

### Android Constraints
- Material Design version: [M2/M3]
- Compose version: [1.x/etc.]
- Icon system: Vector drawables
- Theme modes: Light + Dark

### Token Implementation Approach
- iOS: Swift color assets + spacing constants
- Android: XML resources (colors.xml, dimens.xml)
- Cross-platform: [React Native/Flutter if applicable]

### Platform-Specific Requirements
- iOS-specific patterns: [List]
- Android-specific patterns: [List]

### Key Constraints
- [List mobile-specific limitations]

---

[PLATFORM:DESKTOP]

## Desktop Platform Analysis

### Technology Choice
- Approach: [Electron/Native/Qt]

### Platform Constraints
- Windows: [Requirements]
- macOS: [Requirements]
- Linux: [Requirements if supported]

### Token Implementation Approach
- Format: [CSS variables/XAML/Asset catalogs/QSS]

### Desktop-Specific Requirements
- Window management: [Patterns]
- Keyboard navigation: [Approach]
- Native OS integration: [Level]

### Key Constraints
- [List desktop-specific limitations]

---

## Cross-Platform Token Strategy

### Primitive Tokens
- Color format: [Hex/RGB/HSL]
- Spacing units: [Base unit and conversions]
- Typography: [Font availability strategy]

### Platform Overrides
- [List any platform-specific token overrides needed]

### Token Transformation Pipeline
- Source: [JSON/YAML]
- Targets: [CSS/Swift/XML/etc.]
- Tool: [Style Dictionary/Custom]

## Recommendations
- Primary implementation approach: [Recommendation]
- Token transformation strategy: [Recommendation]
- Platform-specific variations: [Minimal/Moderate/Extensive]
```

## Gate Criteria

- [ ] All target platforms analyzed
- [ ] Platform-specific constraints documented
- [ ] Token implementation approach defined per platform
- [ ] Cross-platform compatibility strategy established
- [ ] Platform-specific requirements identified
- [ ] Recommendations provided

## Downstream Context

Phase 3 (Design Token Architecture) will use:
- Cross-platform token strategy → to design platform-agnostic tokens
- Platform-specific constraints → to plan token transformation
- Token implementation approaches → to structure token files

Phase 4 (Component Library Design) will use:
- Platform-specific requirements → to design component variations
- Responsive strategies → to specify component breakpoints

## Common Pitfalls

- Not analyzing all target platforms early (causes rework)
- Assuming web patterns work on mobile/desktop
- Ignoring platform-specific design guidelines
- Not planning token transformation pipeline upfront

## Trade-off Analysis

### Platform Convergence vs Divergence

**Option A: Maximum Convergence**
- Single token architecture, minimal platform variations
- Pros: Consistency, easier maintenance
- Cons: May not feel native on each platform

**Option B: Platform-Specific Variations**
- Separate token sets per platform
- Pros: Native feel on each platform
- Cons: Maintenance overhead, consistency challenges

**Recommendation:** Converge on primitive/semantic tokens, diverge on component tokens only when platform guidelines require it.

## Agent Invocation Template

```markdown
# Agent Invocation: analysis

## Task Context
- **Task ID:** `{task-id}`
- **Skill:** `develop-ui-ux`
- **Phase:** `2`
- **Domain:** `creative/technical`
- **Agent:** `analysis`

## Role Extension

**Task-Specific Focus:**
- Analyze platform-specific constraints for [{target_platforms}]
- Define token implementation approach per platform
- Establish cross-platform compatibility strategy
- Identify platform-specific design requirements
- Plan token transformation pipeline

## Task

Analyze platform constraints and requirements to ensure design system works across all target platforms.

Document platform-specific sections with `[PLATFORM:*]` markers.

## Related Research Terms

- Platform-specific design constraints
- CSS custom properties
- SwiftUI theming
- Material Design tokens
- Cross-platform token transformation
- Style Dictionary
- Responsive design strategies
- Platform design guidelines

## Output

Write to: `.claude/memory/{task-id}-analysis-memory.md`
```
