# Architecture Validation Checklist

## High-Level Design (HLD)

- [ ] System Context Diagram (C4 Level 1) complete
- [ ] All major components identified and described
- [ ] External system dependencies documented
- [ ] Data flow diagrams for critical paths
- [ ] Technology stack selections justified with ADRs
- [ ] Deployment architecture overview provided

## Low-Level Design (LLD)

- [ ] Container Diagram (C4 Level 2) complete - all deployable units shown
- [ ] Component Diagram (C4 Level 3) complete - internal modules defined
- [ ] Sequence diagrams for at least 3 critical workflows
- [ ] State diagrams for complex entities (if applicable)
- [ ] Module dependency graph shows acyclic dependencies
- [ ] Class diagrams for critical components (optional C4 Level 4)

## Database Schema

- [ ] Entity-Relationship Diagram (ERD) complete
- [ ] All tables defined with constraints (PK, FK, NOT NULL, UNIQUE)
- [ ] Normalized to at least 3NF (Third Normal Form)
- [ ] BCNF (Boyce-Codd Normal Form) achieved where possible
- [ ] Indexes defined for performance-critical queries
- [ ] Migration strategy documented (versioning approach)
- [ ] DDL scripts provided for all schema objects
- [ ] Polyglot persistence justified (if multiple databases used)

## API Specifications

- [ ] OpenAPI 3.0 compliant specification file
- [ ] All endpoints documented (path, method, parameters, responses)
- [ ] Authentication/authorization specified per endpoint
- [ ] Rate limiting strategy defined
- [ ] API versioning approach documented (URL path/header/query)
- [ ] Error response standards defined
- [ ] Request/response examples provided
- [ ] Schema definitions for all data models

## Security Architecture

- [ ] OWASP Top 10 (2021) mitigations addressed for all 10 categories
- [ ] Defense-in-depth layers defined (network, auth, app, data, monitoring)
- [ ] Authentication architecture complete (OAuth 2.0/OIDC or equivalent)
- [ ] Authorization model defined (RBAC or ABAC with role/permission matrix)
- [ ] Encryption at rest strategy (AES-256, TDE, or equivalent)
- [ ] Encryption in transit strategy (TLS 1.3, mTLS for internal)
- [ ] Key management strategy (KMS or equivalent)
- [ ] Security ADRs document critical decisions
- [ ] Least privilege principle applied to all service accounts
- [ ] Secure-by-default configuration verified

## Infrastructure Architecture

- [ ] IaC templates provided for all environments (dev, staging, prod)
- [ ] Tool selection justified (Terraform/CloudFormation/Pulumi ADR)
- [ ] Network layer defined (VPC, subnets, route tables, NAT)
- [ ] Compute layer defined (EC2/ECS/EKS, auto-scaling, load balancers)
- [ ] Data layer defined (RDS/DynamoDB, S3, caching)
- [ ] Security layer defined (security groups, IAM roles, KMS keys)
- [ ] Monitoring layer defined (CloudWatch, logging infrastructure)
- [ ] Container orchestration configured (Kubernetes/Docker Swarm if applicable)
- [ ] Helm charts provided (if Kubernetes selected)
- [ ] Infrastructure templates are idempotent
- [ ] Cost estimation provided (cloud pricing calculator)

## Architecture Decision Records (ADRs)

- [ ] Pattern selection ADR (monolith/modular/microservices)
- [ ] Database technology ADR (relational/NoSQL/polyglot)
- [ ] IaC tool selection ADR (Terraform/CloudFormation/Pulumi)
- [ ] Container orchestration ADR (if applicable)
- [ ] Security technology ADRs (auth provider, KMS, etc.)
- [ ] All ADRs follow Michael Nygard template
- [ ] ADRs stored in version control (docs/architecture/decisions/)
- [ ] ADRs cross-reference C4 diagrams and code modules

## C4 Diagrams

- [ ] Level 1: System Context - shows system + external dependencies
- [ ] Level 2: Container - shows deployable units + protocols
- [ ] Level 3: Component - shows internal modules + dependencies
- [ ] Level 4: Code (optional) - class diagrams for critical components
- [ ] All diagrams use consistent notation
- [ ] Diagrams cross-reference ADRs
- [ ] PlantUML/Draw.io/Structurizr source files provided
- [ ] Diagrams versioned alongside code

## Platform-Specific Extensions (Conditional)

### [PLATFORM:WEB] Web Applications
- [ ] SSR vs CSR decision documented with ADR
- [ ] Bundle optimization strategy defined
- [ ] PWA checklist addressed (if applicable)
- [ ] CDN configuration defined
- [ ] Browser compatibility matrix provided

### [PLATFORM:MOBILE] Mobile Applications
- [ ] Offline-first synchronization design complete
- [ ] Local database schema defined
- [ ] Background task strategy documented
- [ ] Battery optimization checklist addressed
- [ ] Framework selection ADR (React Native/Flutter/Native)

### [PLATFORM:DESKTOP] Desktop Applications
- [ ] Native API integration requirements defined
- [ ] Auto-update mechanism designed
- [ ] Framework selection ADR (Electron/Tauri/Native)
- [ ] File system access patterns documented

### [PLATFORM:API] API Services
- [ ] Service mesh vs API gateway decision documented
- [ ] Rate limiting architecture defined
- [ ] API versioning strategy ADR
- [ ] Authentication/authorization per endpoint complete

## AWS Well-Architected Framework (5 Pillars)

### Operational Excellence
- [ ] IaC for infrastructure reproducibility
- [ ] Observability architecture defined (where to instrument)
- [ ] Deployment automation planned

### Security
- [ ] OWASP principles integrated
- [ ] Least privilege enforced
- [ ] Defense-in-depth implemented

### Reliability
- [ ] Fault tolerance mechanisms (circuit breakers, retries)
- [ ] Backup and recovery strategy
- [ ] Disaster recovery plan

### Performance Efficiency
- [ ] Scalability strategy defined
- [ ] Caching layers identified
- [ ] Database query optimization planned

### Cost Optimization
- [ ] Cloud cost estimation provided
- [ ] Right-sizing guidance (compute, storage)
- [ ] Managed services vs self-hosted trade-offs evaluated

## Architecture Validation Tools

- [ ] ArchUnit rules defined for package dependencies (if Java/Kotlin)
- [ ] Fitness functions defined for performance thresholds
- [ ] Fitness functions defined for security (dependency scanning)
- [ ] Architecture smell detection configured (circular deps, god classes)
- [ ] CI/CD integration planned for architecture tests

## Completion Gate

**All checklist items MUST be addressed before skill completion.**

- Items marked "Not Applicable" must be justified with reasoning
- Platform-specific sections activate based on application type
- Validation failures trigger remediation back to relevant phase
- Maximum 2 remediation iterations before forced completion
