# Phase 3: Security Architecture

**Uses Atomic Skill:** `orchestrate-generation`
**Phase Type:** LINEAR

## Purpose

Design OWASP-aligned security architecture integrated from design phase (NOT retrofitted).

## Domain-Specific Extensions (Architecture)

**OWASP Secure Architecture Principles:**

1. **Defense in Depth** - Multi-layer security (network, auth, app, data, monitoring)
2. **Least Privilege** - Minimum access for minimum time
3. **Secure by Default** - Insecurity requires explicit opt-in

**Deliverables:**

1. **Authentication Architecture**
   - OAuth 2.0 + OIDC for end users
   - Mutual TLS or JWT for service-to-service
   - MFA for admin/internal
   - JWT token design (short-lived access, long-lived refresh)

2. **Authorization Architecture**
   - RBAC or ABAC selection
   - Role/permission matrix
   - Policy engine design (if ABAC)

3. **Encryption Strategy**
   - At Rest: AES-256-GCM, TDE, KMS
   - In Transit: TLS 1.3 (external), mTLS (internal)
   - Key management strategy

4. **OWASP Top 10 Mitigations**
   - Architecture-level mitigations for all 10 categories
   - Broken Access Control → Centralized auth layer
   - Cryptographic Failures → Encryption strategy
   - Injection → Parameterized queries, ORMs
   - [Complete all 10]

## Gate Exit Criteria

- [ ] Authentication flows documented
- [ ] Authorization matrix created
- [ ] Encryption strategy (at rest + in transit)
- [ ] OWASP Top 10 mitigation checklist complete
- [ ] Defense-in-depth layers defined
- [ ] Security ADRs for critical decisions

## Output

- security-architecture.md
- authentication-flow-diagrams
- authorization-matrix.md
- owasp-mitigation-checklist.md
- adrs/security/

## MANDATORY Agent Invocation

```bash
Task tool with subagent_type: "orchestrate-generation"
```

Produces: `.claude/memory/{task_id}-generation-memory.md`
