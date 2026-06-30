# Web App — Clarifying Question Bank

Domain-specific questionnaire organized by area. Each question targets a specific, answerable gap. Rationale explains why the question matters for PRD quality.

## Architecture

| # | Question | Rationale |
|---|----------|-----------|
| 1 | Monolith, microservices, or serverless? | Determines deployment architecture, inter-service communication, and complexity |
| 2 | Which frontend framework? (React, Vue, Angular, Svelte, etc.) | Drives component patterns, state management choice, and build tooling |
| 3 | Which backend framework? (FastAPI, Django, Flask, Express, Next.js, etc.) | Determines API design patterns, ORM choice, and middleware architecture |
| 4 | What database(s)? (PostgreSQL, MySQL, MongoDB, Supabase, etc.) | Affects data modeling, query patterns, and scaling strategy |
| 5 | Authentication strategy? (JWT, OAuth2, session-based, SSO) | Drives security architecture, token management, and middleware |
| 6 | Is this a new project or adding to an existing codebase? | Determines integration complexity, constraints from existing patterns |
| 7 | Monorepo or separate repos for frontend/backend? | Affects CI/CD pipeline design, dependency management, and developer workflow |
| 8 | Will there be a mobile app later? If yes, same API? | Determines if the API needs to be mobile-first from the start |

## Frontend

| # | Question | Rationale |
|---|----------|-----------|
| 1 | SPA, SSR, or static site? (Next.js, Nuxt, plain React, etc.) | Determines routing strategy, SEO requirements, and deployment model |
| 2 | State management approach? (Redux, Zustand, Context, Pinia, etc.) | Drives component architecture and data flow patterns |
| 3 | Responsive design breakpoints? (mobile-first vs desktop-first) | Affects CSS architecture, component design, and testing surface |
| 4 | Accessibility target? (WCAG 2.1 AA, AAA, or none) | Drives ARIA patterns, keyboard navigation, and color contrast requirements |
| 5 | Theming / dark mode required? | Affects CSS variable strategy, component library choice |
| 6 | Component library? (Tailwind, MUI, shadcn/ui, Chakra, custom) | Determines design token strategy and development speed |
| 7 | i18n / localization required? Languages? | Affects string management, date/number formatting, RTL support |
| 8 | Offline support / PWA? | Determines service worker strategy and caching architecture |

## Backend

| # | Question | Rationale |
|---|----------|-----------|
| 1 | REST, GraphQL, or WebSocket API? (or combination) | Determines API design, documentation tooling, and client patterns |
| 2 | Rate limiting strategy? (IP-based, token-based, tiered) | Affects middleware design and DoS protection |
| 3 | Caching layer? (Redis, in-memory, CDN, none) | Drives performance architecture and cache invalidation patterns |
| 4 | Logging and monitoring? (structured logging, OpenTelemetry, Sentry) | Determines observability architecture and debugging capabilities |
| 5 | Background job processing? (Celery, BullMQ, RQ, none) | Affects async task architecture, queue infrastructure |
| 6 | File uploads / storage? (S3, local, Cloudinary) | Determines storage architecture, CDN integration, and security |
| 7 | Email / notifications? (SendGrid, SES, Firebase, push) | Drives notification service architecture |

## Infrastructure

| # | Question | Rationale |
|---|----------|-----------|
| 1 | Deployment target? (Vercel, AWS, GCP, Railway, bare metal) | Determines infrastructure-as-code needs and CI/CD design |
| 2 | CI/CD pipeline? (GitHub Actions, GitLab CI, CircleCI) | Drives automation architecture and deployment frequency |
| 3 | Containerization? (Docker, Kubernetes, none) | Affects development environment and deployment consistency |
| 4 | Scaling targets? (100 users, 10k users, 1M users) | Determines horizontal vs vertical scaling architecture |
| 5 | Backup and disaster recovery requirements? | Drives data protection strategy and RPO/RTO requirements |
| 6 | Environment strategy? (dev/staging/prod, preview deploys) | Affects branching strategy and deployment pipeline |

## Testing

| # | Question | Rationale |
|---|----------|-----------|
| 1 | E2E testing framework? (Playwright, Cypress, Selenium) | Determines browser automation strategy and CI integration |
| 2 | API testing approach? (pytest, Jest, Supertest, Postman) | Drives integration test architecture |
| 3 | Load testing required? (k6, Locust, Artillery) | Determines performance validation requirements |
| 4 | Visual regression testing? (Percy, Chromatic, BackstopJS) | Affects UI regression detection strategy |
| 5 | Code coverage targets? (80%, 90%, none) | Drives test strategy rigor |
| 6 | Security scanning? (SAST, DAST, dependency scanning) | Determines security automation requirements |

## Compliance

| # | Question | Rationale |
|---|----------|-----------|
| 1 | GDPR / CCPA compliance required? (user data, EU users) | Drives data handling architecture and consent management |
| 2 | Accessibility legal requirements? (ADA, Section 508, EN 301 549) | Determines WCAG conformance level and audit requirements |
| 3 | SOC 2 / ISO 27001 compliance needed? | Affects security controls, logging, and audit trail requirements |
| 4 | PCI-DSS applicable? (handling payment card data) | Determines payment architecture and security scope |
| 5 | Cookie consent / tracking compliance? | Drives consent management platform integration |
| 6 | Data residency requirements? (specific geographic regions) | Affects hosting location and data storage architecture |
