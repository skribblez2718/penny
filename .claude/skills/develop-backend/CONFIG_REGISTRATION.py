# config.py Registration Code for develop-backend skill
# MANUAL INSERTION REQUIRED into .claude/orchestration/protocols/skill/config/config.py

# ============================================================================
# STEP 1: Add DEVELOP_BACKEND_PHASES dict BEFORE SKILL_PHASES dict
# ============================================================================

DEVELOP_BACKEND_PHASES: Dict[str, Dict[str, Any]] = {
    "0": {
        "name": "REQUIREMENTS_CLARIFICATION",
        "title": "Requirements Clarification",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-clarification",
        "script": None,
        "content": "phase_0_requirements_clarification.md",
        "next": "1",
        "description": "Clarify backend requirements via Johari discovery - tech stack, clients, scalability, security",
        "gate_criteria": [
            "Tech stack confirmed (language, framework, database)",
            "Client types identified (web, mobile, internal services)",
            "Scalability requirements defined (load, growth)",
            "Security requirements clarified (auth, compliance)"
        ]
    },
    "1": {
        "name": "API_DESIGN",
        "title": "API Design",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-synthesis",
        "script": None,
        "content": "phase_1_api_design.md",
        "next": "2",
        "description": "Design API contracts (REST/GraphQL), versioning, rate limiting, pagination",
        "gate_criteria": [
            "API endpoints defined with contracts",
            "Versioning strategy established",
            "Rate limiting rules specified",
            "Error handling patterns defined"
        ]
    },
    "2": {
        "name": "DATABASE_ARCHITECTURE",
        "title": "Database Architecture",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-synthesis",
        "script": None,
        "content": "phase_2_database_architecture.md",
        "next": "3",
        "description": "Schema design, indexing strategy, migration approach, data integrity",
        "gate_criteria": [
            "Database schema documented with ERD",
            "Indexing strategy defined (foreign keys, query columns)",
            "Migration approach established (up/down files)",
            "Data validation rules specified (constraints, checks)"
        ]
    },
    "3": {
        "name": "AUTH_SECURITY",
        "title": "Authentication & Security",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-generation",
        "script": None,
        "content": "phase_3_auth_security.md",
        "next": "4",
        "description": "Implement JWT/OAuth patterns, input validation, OWASP alignment",
        "gate_criteria": [
            "Authentication mechanism implemented (JWT/OAuth)",
            "Authorization rules defined (RBAC/ABAC)",
            "Input validation present (schema validation)",
            "OWASP Top 10 addressed with mitigation strategies"
        ]
    },
    "4": {
        "name": "ARCHITECTURE_SCALABILITY",
        "title": "Architecture & Scalability",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-synthesis",
        "script": None,
        "content": "phase_4_architecture_scalability.md",
        "next": "5",
        "description": "Define scaling strategy, caching, circuit breakers, service boundaries",
        "gate_criteria": [
            "Scaling strategy documented (horizontal/vertical)",
            "Caching layers identified (Redis, CDN)",
            "Circuit breaker patterns applied",
            "Service boundaries defined (monolith/microservices)"
        ]
    },
    "5": {
        "name": "TESTING_QUALITY",
        "title": "Testing & Quality",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-generation",
        "script": None,
        "content": "phase_5_testing_quality.md",
        "next": "6",
        "description": "Implement test pyramid (unit, integration, E2E), achieve 70%+ coverage",
        "gate_criteria": [
            "Unit tests present (70%+ coverage)",
            "Integration tests implemented (API + DB)",
            "E2E tests for critical paths",
            "CI/CD pipeline configured with test automation"
        ]
    },
    "6": {
        "name": "MONITORING_OBSERVABILITY",
        "title": "Monitoring & Observability",
        "type": PhaseType.LINEAR,
        "uses_atomic_skill": "orchestrate-generation",
        "script": None,
        "content": "phase_6_monitoring_observability.md",
        "next": "7",
        "description": "Add structured logging, metrics, distributed tracing, health checks, alerting",
        "gate_criteria": [
            "Structured JSON logging implemented",
            "Metrics collection configured (Prometheus)",
            "Distributed tracing enabled (OpenTelemetry/Jaeger)",
            "Health check endpoints present (liveness/readiness)"
        ]
    },
    "7": {
        "name": "VALIDATION",
        "title": "Final Validation",
        "type": PhaseType.REMEDIATION,
        "uses_atomic_skill": "orchestrate-validation",
        "script": None,
        "content": "phase_7_validation.md",
        "next": None,
        "description": "Validate all components, run security scan, verify all gates",
        "remediation_target": "3",  # Loop back to Phase 3 (Auth & Security)
        "max_remediation": 2,
        "gate_criteria": [
            "All previous gates verified",
            "Security scan passed (OWASP ZAP, 0 critical/high)",
            "Performance benchmarks met (P95 < 500ms)",
            "Documentation complete (API docs, architecture, runbook)"
        ]
    }
}

# ============================================================================
# STEP 2: Add to COMPOSITE_SKILLS dict
# ============================================================================

# Add this entry to the COMPOSITE_SKILLS dict:
"develop-backend": {
    "description": "Production-grade backend development with technology-agnostic patterns",
    "semantic_trigger": "backend development, API design, database architecture, authentication, microservices, server-side development, backend API, RESTful services, GraphQL API, backend security",
    "not_for": "frontend development, UI/UX design, infrastructure deployment, DevOps, mobile app development",
    "composition_depth": 0,
    "phases": "DEVELOP_BACKEND_PHASES",
},

# ============================================================================
# STEP 3: Add to SKILL_PHASES dict
# ============================================================================

# Add this entry to the SKILL_PHASES dict:
"develop-backend": DEVELOP_BACKEND_PHASES,

# ============================================================================
# STEP 4: Add to DEFAULT_SKILL_PARAMS dict (optional but recommended)
# ============================================================================

# Add this entry to the DEFAULT_SKILL_PARAMS dict:
"develop-backend": {
    "tech_stack": "node-express",        # Options: node-express, python-fastapi, go-gin, java-spring
    "database": "postgresql",             # Options: postgresql, mysql, mongodb, dynamodb
    "auth_method": "jwt",                 # Options: jwt, oauth2, session, api-key
    "test_coverage_target": 70,           # Minimum test coverage percentage
    "api_style": "rest",                  # Options: rest, graphql, grpc
    "deployment_target": "docker",        # Options: docker, serverless, vm
},

# ============================================================================
# VERIFICATION CHECKLIST
# ============================================================================
# After manual insertion, verify:
# 1. [ ] DEVELOP_BACKEND_PHASES dict added before SKILL_PHASES
# 2. [ ] "develop-backend" entry added to COMPOSITE_SKILLS
# 3. [ ] "develop-backend": DEVELOP_BACKEND_PHASES added to SKILL_PHASES
# 4. [ ] "develop-backend" entry added to DEFAULT_SKILL_PARAMS
# 5. [ ] No syntax errors (run: python3 config.py)
# 6. [ ] Skill accessible via: python3 -m orchestration.protocols.skill.composite.develop_backend.entry
# ============================================================================
