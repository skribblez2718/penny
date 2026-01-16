# Team Defaults (2-Person Team)

## Default Configuration

**Team Size:** 2 (user + Penny)
**Cloud Strategy:** on-premise
**Pattern Preference:** Modular, extensible
**Consistency Model:** Strong (ACID)
**Security Sensitivity:** Standard

## Recommended Pattern (2-Person Team)

**Base Pattern:** Layered or Modular Monolith

**Rationale:**
- Low coordination overhead (only 2 people)
- Rapid iteration without distributed systems complexity
- Easy debugging and deployment
- Can transition to Modular Monolith for future scaling

## Scale Assumptions

| Factor | Default | Override Trigger |
|--------|---------|-----------------|
| Expected Users | <100K | User specifies >100K in Phase 0 |
| Requests/Second | <100 | Performance requirements indicate higher |
| Data Volume | <1TB | User specifies larger dataset |
| Geographic Distribution | Single region | User needs multi-region |

## When to Upgrade from Monolith

**Signals:**
- Team grows beyond 10 developers
- Expected scale >100K users
- Deployment coordination becomes bottleneck
- Different components need independent scaling

**Upgrade Path:** Layered Monolith → Modular Monolith → Modular + Selective Services

## Default Technology Choices (can override)

**Database:** PostgreSQL (strong consistency, relational data)
**API:** REST (simple, well-understood)
**Authentication:** OAuth 2.0 with OIDC
**Infrastructure:** Terraform (cloud-agnostic IaC)
**Deployment:** Container-based (Docker)
