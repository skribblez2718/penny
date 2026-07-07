# Web App — Non-Functional Requirements Checklist

Concrete thresholds for web application NFRs. Use these as defaults unless overridden by user constraints.

## Performance (Core Web Vitals)

| Metric | Target | Measurement Tool |
|--------|--------|-----------------|
| LCP (Largest Contentful Paint) | < 2.5s (P75) | Lighthouse, Web Vitals library |
| INP (Interaction to Next Paint) | < 200ms (P75) | Web Vitals library, Chrome UX Report |
| CLS (Cumulative Layout Shift) | < 0.1 (P75) | Lighthouse, Web Vitals library |
| TTFB (Time to First Byte) | < 800ms (P75) | WebPageTest, Lighthouse |
| FCP (First Contentful Paint) | < 1.8s (P75) | Lighthouse |
| Total bundle size (JS) | < 200KB gzipped (initial route) | webpack-bundle-analyzer |
| Image size | < 100KB per image, WebP format | Image optimization pipeline |

### API Performance

| Metric | Target |
|--------|--------|
| P50 API latency | < 100ms |
| P95 API latency | < 500ms |
| P99 API latency | < 1000ms |
| Rate limit per IP | 100 req/s (authenticated), 10 req/s (anonymous) |

## Accessibility (WCAG 2.1 AA)

| Requirement | Checklist |
|-------------|-----------|
| Color contrast | All text ≥ 4.5:1, large text ≥ 3:1 |
| Keyboard navigation | All interactive elements focusable and operable via keyboard |
| Focus indicators | Visible focus ring on all focusable elements (≥ 2px, contrast ≥ 3:1) |
| Screen reader | All images have alt text, form inputs have labels, landmarks used |
| Skip links | "Skip to main content" link as first focusable element |
| ARIA | Used only when HTML semantics insufficient; no aria-* misuse |
| Reduced motion | `prefers-reduced-motion` media query respected |
| Zoom | Content readable at 200% zoom without horizontal scrolling |
| Forms | Error messages linked to inputs via aria-describedby |
| Lighthouse score | ≥ 90 accessibility score |

## Security

| Requirement | Implementation |
|-------------|---------------|
| XSS prevention | CSP header with strict-dynamic, no inline scripts, React auto-escaping |
| CSRF protection | SameSite=Strict cookies, CSRF token for state-changing requests |
| SQL injection | Parameterized queries / ORM exclusively |
| Authentication | bcrypt/argon2 for passwords, JWT with short expiry + refresh tokens |
| Authorization | Route-level guards, resource-level ownership checks |
| Rate limiting | API-wide + endpoint-specific limits, 429 with Retry-After |
| Security headers | HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy |
| Dependency scanning | CI pipeline scans for known CVEs (Dependabot, Snyk) |
| Secrets | Never in code; env vars or secret manager; .env in .gitignore |
| Input validation | Server-side validation for ALL inputs (never trust client-only) |
| OWASP ASVS | Reference ASVS Level 1 for standard web apps, Level 2 for sensitive data |

## Reliability

| Requirement | Target |
|-------------|--------|
| Uptime | 99.9% (8.76 hours downtime/year max) |
| Error rate | < 1% of all requests return 5xx |
| Error boundaries | Every React route wrapped in error boundary with fallback UI |
| Graceful degradation | Core features work without JavaScript (where applicable) |
| Retry logic | Exponential backoff with jitter for API calls (max 3 retries) |
| Circuit breaker | For external service calls (after 5 consecutive failures, break for 30s) |
| Health check | `/health` endpoint returning 200 + dependency statuses |

## Maintainability

| Requirement | Checklist |
|-------------|-----------|
| TypeScript | Strict mode enabled, no `any` without justification |
| Design system / tokens | CSS variables or design tokens for colors, spacing, typography |
| Component documentation | Storybook or similar for shared components |
| API documentation | OpenAPI 3.0 spec, auto-generated from code |
| Code coverage | ≥ 80% line coverage for business logic |
| Linting | ESLint + Prettier (JS/TS), Ruff (Python) in CI |
| Conventional commits | Semantic commit messages for automated changelog |
| README | Setup instructions, architecture diagram, environment variables table |
| Logging | Structured JSON logging with request IDs, log levels (DEBUG/INFO/WARN/ERROR) |
| Monitoring | Error tracking (Sentry), performance monitoring, uptime monitoring |

## Browser Support

| Browser | Versions |
|---------|----------|
| Chrome | Last 2 major versions |
| Firefox | Last 2 major versions |
| Safari | Last 2 major versions |
| Edge | Last 2 major versions |
| Mobile Safari | iOS 15+ |
| Chrome Android | Last 2 major versions |
