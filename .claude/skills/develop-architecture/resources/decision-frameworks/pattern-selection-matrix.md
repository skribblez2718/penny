# Pattern Selection Decision Matrix

## Decision Table

| Team Size | Expected Scale | Domain Complexity | Recommended Pattern | Rationale |
|-----------|----------------|-------------------|---------------------|-----------|
| <10 | <100K users | Low-Medium | Layered Monolith | Minimal coordination overhead, rapid iteration |
| <10 | >100K users | Medium-High | Layered + Caching | Vertical scaling with performance optimization |
| 10-25 | <100K users | Medium | Modular Monolith | Enforced module boundaries, stepping stone to services |
| 10-25 | >100K users | High | Modular Monolith + API Gateway | Prepare for selective service extraction |
| 25-50 | Any | High | Modular Monolith + Selective Services | Gradual decomposition, hybrid approach |
| >50 | >100K users | High | Microservices + Platform Team | Scale requires independence, platform investment justified |

## Pattern Scoring Formula

```
Pattern Score = (Team Size Weight × Team Fit) +
                (Scale Weight × Scale Fit) +
                (Complexity Weight × Complexity Fit) +
                (Expertise Weight × Expertise Fit)

Weights: Team Size (0.30), Scale (0.30), Complexity (0.25), Expertise (0.15)
Fit Scores: Perfect (1.0), Good (0.75), Acceptable (0.5), Poor (0.25), Mismatch (0.0)
```

## Event-Driven Pattern Overlay

**Trigger:** Asynchronous workflows, decoupled systems, eventual consistency acceptable

**Adoption Sequence (DO NOT SKIP STEPS):**
1. Event Bus/Pub-Sub → Low complexity, foundation for all event patterns
2. CQRS → Medium complexity, requires Event Bus
3. Event Sourcing → High complexity, requires CQRS for querying
4. Saga Pattern → Very High complexity, requires Microservices + Event Bus

**WARNING:** Do not adopt Saga pattern without genuine cross-service transaction requirements.

## Hexagonal/Clean Architecture Overlay

**Trigger:** High testability requirements, external dependency isolation, domain-driven design

**Compatible with:** All base patterns above
**Application:** Structural pattern applied WITHIN chosen base pattern
**Trade-off:** Medium design cost, high long-term maintainability

## Team Size Thresholds (Evidence-Based)

| Team Size | Coordination Overhead | Deployment Frequency | Pattern |
|-----------|----------------------|---------------------|---------|
| <10 | Low | Daily+ | Layered Monolith |
| 10-25 | Medium | Daily | Modular Monolith |
| 25-50 | Medium-High | Multiple times/day | Hybrid |
| >50 | High (requires platform team) | Continuous per service | Microservices |

## Scalability Indicators

| Indicator | Monolith | Modular Monolith | Microservices |
|-----------|----------|------------------|---------------|
| Expected Users | <100K | 100K-1M | >1M |
| Requests/Second | <100 | 100-1000 | >1000 |
| Data Volume | <1TB | 1TB-10TB | >10TB |
| Geographic Distribution | Single region | Multi-region (replicas) | Multi-region (services) |
| Consistency Requirements | Strong (ACID) | Strong or Eventual | Eventual (BASE) |
