# Johari Window Framework - Cognitive Domain Enhanced

**Purpose:** Python type definitions, format decision guidance, compression techniques, and anti-pattern examples for agent memory outputs

**Scope:** Supplementary content not covered in agent-protocol-core.md

**Note:** For agent execution protocols, agents MUST read agent-protocol-core.md (all agents) and agent-protocol-extended.md (code generation agents)

## Format Decision Matrix

| Component | Format | Rationale |
|-----------|--------|-----------|
| Workflow Metadata | JSON Schema | Type validation, phase tracking, cross-entity state synchronization |
| Unknown Registry | JSON Schema | Automated tracking, enum validation, structured resolution lifecycle |
| Downstream Directives | JSON Schema | Reliable parsing, structure compliance, validated field types |
| Phase Overviews | Markdown | Narrative compression, token efficiency, human readability |
| Johari Quadrants | JSON wrapper + Markdown strings | Programmatic extraction + narrative expressiveness, reduced hallucination (21% → 7.5%) |

## Format Requirements (CRITICAL)

**✅ CORRECT Format:**
- Markdown document structure
- JSON in code blocks (```json ... ```)
- Markdown headings (## Section Name)

**❌ INCORRECT Format (DO NOT USE):**
- XML wrapper tags (`<agent_output>`, `<metadata>`, `<johari_summary>`, etc.)
- XML attributes (`max_tokens="750"`)
- Nested XML structure

**Why:** XML format is not specified in the protocol and breaks automated parsing. Always use Markdown + JSON code blocks as shown in the Format Decision Matrix above.

## Token Limits

### Strict Limits

| Quadrant | Min | Max | Unit |
|----------|-----|-----|------|
| open | 200 | 300 | tokens |
| hidden | 200 | 300 | tokens |
| blind | 150 | 200 | tokens |
| unknown | 150 | 200 | tokens |
| domain_insights (optional) | 150 | 200 | tokens |

### Totals

**Johari Summary:**
- Maximum: 1200 tokens
- Unit: tokens
- Enforcement: strictly enforced

**Complete Memory File:**
- Target: 300-400 lines
- Components: Step Overview + Johari + Downstream Directives

## Compression Techniques

### Decision-Focused Writing

**Bad Example:**
> We conducted extensive research into OAuth2 providers including Google, Microsoft, and Auth0. After careful consideration of multiple factors including ease of implementation, documentation quality, community support, and long-term maintenance, we decided that Google's OAuth2 implementation would be the best fit for our needs.

**Good Example:**
> Selected Google OAuth2 (vs Microsoft, Auth0) for superior docs, active community, simpler integration.

### Abbreviation Usage

**Common Abbreviations:** API, CRUD, TDD, JWT, REST, OWASP, PWA, CLI, UI, UX, DB

**Domain Abbreviations:** Define once, use throughout

**Bad Example:** Application Programming Interface endpoints for Create, Read, Update, Delete operations

**Good Example:** CRUD API endpoints

### List Over Prose

**Bad Example:**
> The architecture has several key components. First, there's the authentication layer which handles user login and session management. Second, we have the business logic layer that processes requests. Third, there's the data access layer for database operations.

**Good Example:**
> Architecture: 1) Auth layer (login, sessions), 2) Business logic (request processing), 3) Data access (DB ops)

### Reference Over Repetition

**Bad Example:**
> As mentioned in the requirements phase, we need to support OAuth2 authentication with Google as the provider, using JWT tokens for session management...

**Good Example:**
> Implements requirements: OAuth2+Google, JWT sessions (see Phase 0)

### Quantify, Don't Elaborate

**Bad Example:**
> The system is quite complex with numerous interconnected components and significant architectural considerations

**Good Example:**
> Complexity: MEDIUM (8 components, 12 integrations, 3 external APIs)

### Use Symbols and Shorthand

**Examples:**
- Tests: 15/15 ✓, Coverage: 87%, Security: OWASP compliant ✓
- Risks: H (token refresh UX), M (rate limiting), L (docs)

## Python Type Definitions

Enhanced Python type definitions for cognitive domains using Pydantic:

```python
from typing import Literal, Optional, List, Dict, Any
from pydantic import BaseModel, Field, ConfigDict

# Task domain enumeration
TaskDomain = Literal[
    "technical",
    "personal",
    "creative",
    "professional",
    "recreational",
    "hybrid"
]

# Cognitive function enumeration
CognitiveFunction = Literal[
    "RESEARCH",
    "ANALYSIS",
    "SYNTHESIS",
    "GENERATION",
    "VALIDATION",
    "CLARIFICATION",
    "COORDINATION"
]

class WorkflowMetadata(BaseModel):
    model_config = ConfigDict(extra='forbid')

    task_id: str = Field(pattern=r'^task-[a-z0-9-]{1,36}$')
    workflow_type: Literal["cognitive-orchestration", "develop-project", "develop-skill", "custom"]
    task_domain: TaskDomain  # Domain classification
    start_date: str  # ISO 8601: YYYY-MM-DDTHH:mm:ssZ
    current_phase: int = Field(ge=1)
    total_phases: int = Field(ge=1)
    critical_constraints: List[str]
    success_criteria: List[str]
    quality_standards: List[str] = Field(default_factory=list)  # Domain-specific standards
    artifact_types: List[str] = Field(default_factory=list)  # Expected output types
    cognitive_sequence: List[CognitiveFunction] = Field(default_factory=list)  # Agent sequence
    blocking_issues: Optional[str] = None

class Unknown(BaseModel):
    model_config = ConfigDict(extra='forbid')

    id: str = Field(pattern=r'^U[0-9]+$')
    phase: int = Field(ge=1)
    category: Literal[
        "Research", "Implementation", "Architecture", "Requirements", "Risk",
        "Scope", "Source", "Interpretation", "Validation", "Depth",
        "Technical", "Security", "Integration", "Performance", "Environment",
        "Personal", "Creative", "Professional", "Recreational",
        "Ethical", "Resource", "Quality"
    ]
    description: str
    resolution_phase: Optional[int] = Field(None, ge=1)
    cognitive_agent: Optional[CognitiveFunction] = None  # NEW: Which agent resolves
    status: Literal["Unresolved", "In Progress", "Resolved", "Deferred"]
    resolution: Optional[str] = None

class UnknownRegistry(BaseModel):
    model_config = ConfigDict(extra='forbid')
    unknowns: List[Unknown]

# Domain-aware Johari Summary
class JohariSummary(BaseModel):
    open: str = Field(min_length=10, max_length=500)
    hidden: str = Field(min_length=10, max_length=500)
    blind: str = Field(min_length=10, max_length=500)
    unknown: str = Field(min_length=5, max_length=500)
    domain_insights: Optional[Dict[str, str]] = None  # NEW: Domain-specific insights

# Cognitive Context for agent invocation
class CognitiveContext(BaseModel):
    task_id: str
    task_domain: TaskDomain
    cognitive_function: CognitiveFunction
    step_number: int
    purpose: str
    gate_entry: List[str]
    gate_exit: List[str]
    quality_standards: List[str]
    predecessor_outputs: List[str]  # File paths to read
```

## Domain Adaptations

The Johari Window structure is universal, but content adapts to domain.

### Technical Domain (Compressed)

```json
{
  "open": "OAuth2+Google confirmed. Flask/SQLAlchemy stack. Targets: <500ms token endpoint, OWASP compliant. JWT over opaque tokens (stateless scaling).",
  "hidden": "Refresh token rotation implemented (security). Redis caching for token validation (performance). Layered architecture: Auth→Service→Storage.",
  "blind": "Microservice communication patterns not addressed. Load balancer config pending. Performance under load not validated.",
  "unknown": "K8s deployment specifics. Rate limiting algorithm TBD. Token cleanup strategy undefined.",
  "domain_insights": {
    "architecture": "Event-driven over synchronous for resilience",
    "security": "Zero-trust throughout. OWASP baseline + JWT best practices"
  }
}
```

### Personal Domain (Compressed)

```json
{
  "open": "Morning routine structured: 6AM wake, exercise (30min), meditation (15min). Habit tracking via Notion. Goals aligned with values (health, growth, connection).",
  "hidden": "Exercise flexibility reduces barrier (gym/home/walk options). Social accountability via workout buddy increases adherence 3x.",
  "blind": "Evening routine undefined. Weekend structure lacking. Stress management reactive not proactive.",
  "unknown": "Optimal sleep duration for energy (7.5h vs 8h?). Nutrition impact on morning focus unclear. Recovery day frequency TBD."
}
```

### Creative Domain (Compressed)

```json
{
  "open": "Blog series on AI ethics planned. Target audience: tech professionals. Tone: thoughtful, accessible.",
  "hidden": "Drew inspiration from Asimov's laws for framework. Avoiding controversial current events.",
  "blind": "Audience's actual AI knowledge level unclear. Competing content not fully researched.",
  "unknown": "Optimal publishing frequency. Engagement metrics expectations.",
  "domain_insights": {
    "narrative_structure": "Problem-exploration-solution arc for each post",
    "voice": "Authoritative yet approachable, avoiding jargon"
  }
}
```

### Professional Domain (Compressed)

```json
{
  "open": "Q3 strategy includes market expansion to APAC. Budget: $2M. Timeline: 90 days to launch.",
  "hidden": "Competitor analysis reveals vulnerability in their enterprise segment. Building partnerships quietly.",
  "blind": "Regulatory requirements in target markets not fully mapped. Cultural adaptation needs unclear.",
  "unknown": "Currency fluctuation impact. Local competitor response strategies.",
  "domain_insights": {
    "strategic_priority": "Market share over immediate profitability",
    "risk_mitigation": "Phased rollout with exit criteria defined"
  }
}
```

### Recreational Domain (Compressed)

```json
{
  "open": "Puzzle game concept: physics-based with time manipulation. Platform: mobile. Audience: casual gamers.",
  "hidden": "Inspired by Braid mechanics but simplified for mobile. Monetization through optional hints.",
  "blind": "Mobile hardware limitations for physics simulation. Competitor patent landscape.",
  "unknown": "Optimal tutorial length. Player retention metrics for similar games.",
  "domain_insights": {
    "fun_factor": "Discovery and 'aha' moments prioritized over difficulty",
    "accessibility": "One-handed play required, colorblind modes planned"
  }
}
```

## Full Scale Example

**Description:** Complete Johari Summary at 1,200 token limit for complex research phase investigating authentication systems for multi-tenant SaaS platform

**Token Count:** ~980 tokens (within 1,200 limit with room for domain_insights if needed)

```json
{
  "open": "OAuth2 + OIDC recommended for multi-tenant SaaS auth. Evaluated 7 providers (Auth0, Okta, AWS Cognito, Azure AD, Google, Keycloak, FusionAuth). Auth0 selected: superior multi-tenancy support (Organizations API), comprehensive audit logs, flexible pricing ($0.023/MAU after 7K free), 99.99% SLA. Key features: custom domains, MFA, SSO, user migration APIs, extensible via Rules/Actions. JWT token structure: access (15min), refresh (30d). Token rotation enforced. PKCE flow for mobile/SPA. Backend validates JWT signature + claims (aud, iss, exp, sub). Database: PostgreSQL for user metadata (users, roles, permissions, tenant_memberships tables). Redis for token blacklist + rate limiting. Architecture: Auth0 → API Gateway → Backend Services. Security: OWASP Top 10 compliant, HTTPS only, secure headers (HSTS, CSP), input validation, SQL injection prevention via parameterized queries. Performance targets: <200ms token validation, <500ms login flow, 10K concurrent users. Compliance: GDPR (data portability, deletion), SOC 2 Type II aligned. Costs: ~$230/month @ 10K MAU (Auth0) + $25 Redis + $50 DB = ~$305/mo.",

  "hidden": "Rejected AWS Cognito (poor UX, complex pricing), Azure AD (Microsoft lock-in), Google (limited enterprise features), Okta (2x cost vs Auth0). Keycloak/FusionAuth strong but require self-hosting (ops burden). Auth0 Rules enable custom authorization logic (e.g., enforce MFA for admin roles, block suspicious IPs). Organizations API maps to tenant model cleanly (1 org = 1 tenant). User migration from legacy system via Management API batch import. Database schema design: tenant_id on all tables for row-level isolation. Considered separate DB per tenant (rejected: ops overhead) vs shared schema (selected: cost-effective, simpler). Redis chosen over Memcached for data structure support (sets for token blacklist). Token blacklist strategy: store jti claims of revoked tokens until exp. Rate limiting: sliding window (100 req/15min per user) via Redis sorted sets. API Gateway handles CORS, request logging, JWT validation before reaching services. Refresh token rotation: new refresh issued on each use, old invalidated. Security decision: store refresh tokens hashed (bcrypt) in DB, not plain text. Password requirements: 12+ chars, complexity rules, hibp breach check via API. MFA: TOTP (Google Authenticator) + SMS backup. SSO via SAML for enterprise tenants. Deployment: Auth0 managed service (no self-hosting). Monitoring: Auth0 logs streamed to Datadog for analysis.",

  "blind": "Load testing under production-like conditions not performed (simulated 10K concurrent, not validated). Auth0 failover behavior during outages unclear (reliance on their SLA). Token refresh UX during network interruptions undefined (mobile app retry logic pending). User migration edge cases: duplicate emails across tenants (strategy TBD), partial migration failures (rollback unclear). Database connection pooling config not optimized (default settings used). Redis failover strategy not fully designed (single instance, no cluster). Monitoring alerts for auth failures not configured (thresholds undefined). Session management for long-running operations unclear (token refresh during multi-hour tasks). Cross-origin scenarios beyond standard CORS not explored (embedded iframes). Performance under DB connection exhaustion not tested. Cost model assumes linear MAU growth (discount tiers not negotiated). Compliance audit process not detailed (documentation gap). Backup/restore procedures for user data undefined. GDPR data retention policies not implemented (default storage unlimited). Security incident response plan not documented.",

  "unknown": "Actual token validation latency in production (depends on Auth0 response time + network). Redis memory requirements at scale (depends on token churn rate). Database size growth rate (depends on user activity patterns). Auth0 rate limits in practice (docs say 50 req/sec per tenant, real-world TBD). Optimal JWT payload size vs performance tradeoff (minimal claims vs rich context). Social login provider adoption rate by users (Google/Microsoft/etc). MFA enrollment rate (compliance requirement vs user friction). SSO adoption by enterprise customers (demand unclear). User migration timeline (depends on legacy system API access). Tenant isolation validation testing approach (needs security audit). Token refresh frequency in mobile apps (background refresh strategy). Auth0 Rules execution time impact on login performance. Cost at 100K MAU (Auth0 pricing changes at scale). Need for custom identity provider integration (customer-specific auth systems). Audit log retention requirements (compliance-driven, unclear duration). Geographic data residency requirements (GDPR-related, varies by tenant). Passwordless authentication demand (WebAuthn/passkeys future consideration). Bot detection/prevention strategy (Auth0 Attack Protection capabilities TBD)."
}
```

### Compression Techniques Demonstrated

- Dense information packing: "Auth0 selected: superior multi-tenancy support (Organizations API), comprehensive audit logs, flexible pricing ($0.023/MAU after 7K free), 99.99% SLA"
- Abbreviations: OAuth2, OIDC, MFA, SSO, API, JWT, MAU, SLA, DB, GDPR, SOC, HTTPS, HSTS, CSP, UX, CORS, TOTP, SAML
- Quantification: "$305/mo", "<200ms", "10K MAU", "15min", "30d", "100 req/15min"
- Lists over prose: "users, roles, permissions, tenant_memberships tables"
- Decision rationale compressed: "Rejected AWS Cognito (poor UX, complex pricing)"
- Symbols: "→" for flow, "~" for approximation, "+" for combining
- Parenthetical context: "(Auth0 Response time + network)" instead of full sentences
- Technical shorthand: "jti claims", "bcrypt", "row-level isolation", "sliding window"

## Cognitive Agent Output Patterns

### RESEARCH Agent

```json
{
  "open": "[Domain] research findings: [Key discoveries relevant to domain]",
  "hidden": "Sources evaluated: [X academic, Y industry, Z community]. Reliability scores: [High/Medium/Low]",
  "blind": "Research gaps: [What couldn't be found]. Contradictions: [Conflicting information]",
  "unknown": "[Domain-specific unknowns requiring other cognitive functions]"
}
```

### ANALYSIS Agent

```json
{
  "open": "Complexity assessment: [SIMPLE/MEDIUM/COMPLEX]. Key dependencies: [List]. Risks: [Identified]",
  "hidden": "Applied [domain] analysis framework. Trade-offs: [Option A vs B]. Critical path: [Identified]",
  "blind": "Analysis limitations: [What couldn't be analyzed]. Edge cases: [Not fully explored]",
  "unknown": "Needs synthesis to resolve: [Conflicting requirements]. Validation required: [Assumptions]"
}
```

### SYNTHESIS Agent

```json
{
  "open": "Integrated design: [Coherent solution combining all inputs]. Framework: [Structured approach]",
  "hidden": "Resolved contradictions: [How conflicts addressed]. Design decisions: [Key choices with rationale]",
  "blind": "Integration challenges: [Remaining seams]. Assumptions: [What synthesis assumes]",
  "unknown": "Implementation details: [Needs generation]. Validation criteria: [Needs definition]"
}
```

### GENERATION Agent

```json
{
  "open": "Generated artifacts: [List of created items]. Quality standards met: [Checklist]",
  "hidden": "Implementation choices: [Technology/approach decisions]. Optimizations: [Performance/quality improvements]",
  "blind": "Edge cases: [Not fully handled]. Limitations: [Known constraints]",
  "unknown": "Testing coverage: [Needs validation]. Integration points: [Needs verification]"
}
```

### VALIDATION Agent

```json
{
  "open": "Validation results: [PASS/FAIL]. Criteria checked: [List]. Issues found: [Specific problems]",
  "hidden": "Test coverage: [X%]. Security scan: [Results]. Performance metrics: [Measurements]",
  "blind": "Validation gaps: [What couldn't be tested]. Assumptions: [What validation assumes]",
  "unknown": "Production behavior: [Needs real-world testing]. Long-term stability: [Needs monitoring]"
}
```

### CLARIFICATION Agent

```json
{
  "open": "Clarified requirements: [Explicit specifications]. Constraints discovered: [Hidden limitations]",
  "hidden": "Questions asked: [Count]. Assumptions invalidated: [Which ones]. Scope refined: [How]",
  "blind": "Remaining ambiguities: [Still unclear]. Implicit assumptions: [Not yet surfaced]",
  "unknown": "Discovered unknowns: [What we didn't know to ask about]"
}
```

## Anti-Patterns

### Domain Confusion

**Bad:**
```json
{
  "open": "Built REST API for managing personal goals"  // Mixing technical + personal
}
```

**Good:**
```json
{
  "open": "Technical: Built REST API. Personal context: API manages user's personal goals"
}
```

**Description:** Don't mix domains inappropriately. Keep domain context clear.

### Cognitive Function Creep

**Bad:**
```json
{
  "open": "RESEARCH agent: Designed architecture based on findings"  // Research shouldn't design
}
```

**Good:**
```json
{
  "open": "RESEARCH agent: Found 3 architectural patterns applicable to requirements"
}
```

**Description:** Don't exceed cognitive boundaries. Each agent stays in its lane.

### Lost Domain Context

**Bad:**
```json
{
  "downstream_directives": {
    "next_agent": "ANALYSIS"  // Missing domain context
  }
}
```

**Good:**
```json
{
  "downstream_directives": {
    "next_agent": "ANALYSIS",
    "task_domain": "technical",
    "domain_confidence": "CERTAIN"
  }
}
```

**Description:** Don't forget to pass domain forward. Always pass domain information.

### Vague Statements

**Bad:**
```json
{
  "hidden": "Made some decisions"
}
```

**Good:**
```json
{
  "hidden": "Chose 5-query decomposition strategy. Prioritized peer-reviewed sources. Focused on ML subfield."
}
```

**Description:** No concrete information. Name what was decided.

### Ignoring Gaps

**Bad:**
```json
{
  "unknown": ""  // Empty when work proceeds with unvalidated assumptions
}
```

**Good:**
```json
{
  "unknown": "Geographic scope not specified - assumed global. Target expertise unclear - aimed intermediate."
}
```

**Description:** Not acknowledging unknowns. Flag missing information.

## Summary

### Key Points

- Johari compression maintains context fidelity while reducing tokens
- Cognitive agents adapt their process to domain while maintaining consistency
- Domain context must flow through entire workflow for successful adaptation

**Token Savings:** This enhanced reference maintains ~200 lines vs potential 500+ (60% reduction)

**Protocol Reference:** For complete execution protocols, read agent-protocol-core.md or agent-protocol-extended.md
