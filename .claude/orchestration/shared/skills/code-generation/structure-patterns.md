# Code Structure Patterns

## Domain-Appropriate Architecture

Select architecture patterns based on task domain.

---

## Technical Domain

**Types:** API, library, system, tool, framework

**Architecture Patterns:**
- Microservices / Monolith decision
- Layered architecture (presentation, business, data)
- Event-driven / Request-response
- Repository pattern for data access

**Standards:** TDD, SOLID, DRY, KISS, YAGNI

---

## Personal Domain

**Types:** automation, tracker, assistant, organizer

**Architecture Patterns:**
- Simple scripts for one-off tasks
- Modular utilities for reuse
- Configuration-driven behavior
- Plugin architecture for extensibility

**Standards:** simplicity, reliability, maintainability

---

## Creative Domain

**Types:** generative, visualization, interactive, artistic

**Architecture Patterns:**
- Pipeline architecture for processing
- Component-based for interactivity
- State machines for complex flows
- Observer pattern for reactivity

**Standards:** expressiveness, performance, user experience

---

## Professional Domain

**Types:** enterprise, reporting, integration, analytics

**Architecture Patterns:**
- Domain-driven design
- CQRS for complex domains
- Service-oriented architecture
- Enterprise integration patterns

**Standards:** compliance, audit trails, documentation

---

## Recreational Domain

**Types:** game, simulator, bot, utility

**Architecture Patterns:**
- Entity-Component-System for games
- State machines for game logic
- Observer for event handling
- Factory pattern for object creation

**Standards:** fun, engagement, accessibility

---

## Standard File Organization

```
project/
├── src/                    # Source code
│   ├── core/              # Core business logic
│   ├── adapters/          # External integrations
│   ├── utils/             # Shared utilities
│   └── [domain]/          # Domain-specific modules
├── tests/                  # Test files
│   ├── unit/              # Unit tests
│   ├── integration/       # Integration tests
│   └── e2e/               # End-to-end tests
├── docs/                   # Documentation
├── config/                 # Configuration files
└── scripts/                # Build/deploy scripts
```

---

## Selection Criteria

1. **Match domain** - Use patterns appropriate to task type
2. **Scale appropriately** - Don't over-engineer simple projects
3. **Follow conventions** - Use language/framework idioms
4. **Document decisions** - Note architectural choices made
