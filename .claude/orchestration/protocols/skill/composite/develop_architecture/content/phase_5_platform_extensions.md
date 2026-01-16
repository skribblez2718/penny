# Phase 5: Platform Extensions

**Uses Atomic Skill:** `orchestrate-generation`
**Phase Type:** OPTIONAL

**Trigger:** Application type from Phase 0 (web/mobile/desktop/API)

## Purpose

Apply platform-specific architectural considerations.

## Domain-Specific Extensions (Architecture)

### [PLATFORM:WEB] Web Applications

**Deliverables:**
- SSR vs CSR decision ADR
- Bundle optimization strategy (code splitting, tree shaking, minification)
- PWA checklist (if applicable): service worker, manifest, offline caching
- CDN configuration
- Browser compatibility matrix

### [PLATFORM:MOBILE] Mobile Applications

**Deliverables:**
- Offline-first architecture (local DB, sync engine, conflict resolution)
- Battery optimization checklist
- Framework selection ADR (React Native/Flutter/Native)
- Local database schema
- Background task strategy

### [PLATFORM:DESKTOP] Desktop Applications

**Deliverables:**
- Native API integration requirements
- Auto-update mechanism design
- Framework selection ADR (Electron/Tauri/Native)
- File system access patterns
- System tray/notification integration

### [PLATFORM:API] API Services

**Deliverables:**
- Service mesh vs API gateway decision
- Rate limiting architecture (token bucket/fixed window)
- API versioning strategy (URL path recommended)
- GraphQL Federation (if multi-service unified API)
- WebSocket/gRPC (if real-time/high-performance needed)

## Gate Exit Criteria

- [ ] Platform-specific architecture complete
- [ ] Framework selection ADR (if applicable)
- [ ] Platform-specific performance optimizations defined
- [ ] Platform-specific security considerations addressed

## Output

- platform-specific-architecture.md
- framework-selection-adr.md
- performance-optimization-strategy.md

## MANDATORY Agent Invocation

```bash
Task tool with subagent_type: "orchestrate-generation"
```

Produces: `.claude/memory/{task_id}-generation-memory.md`
