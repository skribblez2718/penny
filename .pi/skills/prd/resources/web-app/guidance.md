# Web App — Synthesis Guidance

Per-section guidance for synthesizing the 12 PRD sections for web applications. Each section note explains what to emphasize and what web-app-specific considerations to include.

## 1. Overview

Emphasize the tech stack in the overview: "We're building a React + FastAPI dashboard for..." Include deployment target if known. One paragraph max — the problem statement handles the "why now."

## 2. Problem Statement

For web apps: quantify in terms of user impact (bounce rate, support tickets, page load time, conversion rate) rather than just technical metrics. "Users abandon the checkout flow 40% of the time because the form takes 8 seconds to validate."

## 3. Success Metrics

Web-app-specific metrics to consider:
- **Core Web Vitals**: LCP < 2.5s, INP < 200ms, CLS < 0.1
- **User metrics**: conversion rate, bounce rate, session duration
- **Availability**: uptime percentage (99.9%+)
- **Error rate**: < 1% of requests return 5xx
- **Accessibility**: Lighthouse accessibility score > 90

## 4. User Stories

Include web-specific personas: anonymous visitor, authenticated user, admin, mobile user, screen reader user, keyboard-only user. Each story should have web-specific acceptance criteria (e.g., "form works with Enter key," "responsive at 320px width").

## 5. Features

For web apps, features map to routes/pages. Group P0 features by page: "Login page: email+password form, social auth buttons, forgot password link". Consider progressive enhancement: features that work without JavaScript.

## 6. Out of Scope

Common web app scope boundaries: browser support for IE11, native mobile apps, offline mode, real-time collaboration, admin dashboard (if not in scope), analytics dashboard.

## 7. Non-Functional Requirements

Web-app-specific NFRs from `nfr-checklist.md`:
- **Performance**: Core Web Vitals targets
- **Accessibility**: WCAG 2.1 AA minimum
- **Security**: CSP headers, CSRF protection, XSS prevention, rate limiting
- **Reliability**: error boundaries (React), graceful degradation, retry with backoff
- **SEO**: meta tags, sitemap, structured data (if applicable)
- **Browser support**: last 2 versions of Chrome, Firefox, Safari, Edge

## 8. Dependencies & Constraints

Include web-app-specific dependencies: CDN, DNS provider, auth provider (Auth0, Clerk, Firebase Auth), payment processor, email service, hosting platform constraints (serverless timeouts, cold starts).

## 9. Risks & Assumptions

Web-app-specific risks:
- Browser compatibility issues (especially Safari quirks)
- Mobile network latency and bandwidth
- Third-party script blocking (ad blockers breaking analytics)
- CDN outages affecting asset delivery
- CORS misconfiguration in production
- Session management across deployments

## 10. Edge Cases

Web-app-specific edge cases:
- What happens when the user has JavaScript disabled?
- What if the browser doesn't support a required API (e.g., WebSocket, Clipboard)?
- What if the user resizes the browser during a form submission?
- What if the user hits the back button after a POST?
- What on 404 pages? Is there a custom error page?
- What on very slow connections (3G)?
- What if localStorage is full or blocked?

## 11. Build Order

Capture web-app *dependency constraints* as objectives, not a fixed pipeline. Real dependencies look like: an endpoint can't be integration-tested until its data store exists; a page can't be E2E-tested until its backing API is reachable; auth middleware must exist before the endpoints it gates can be verified. Record those dependency facts and let the implementer choose any sequence that satisfies them. For each deliverable, make explicit **how it is verified independently** (unit/integration/E2E strategy) — the verification is the objective; the ordering is a consequence of the dependencies, not a prescribed recipe (do not hard-code "infrastructure → backend → frontend").

## 12. Deliverables

Include web-app-specific artifacts: `Dockerfile`, `docker-compose.yml`, `nginx.conf`, `robots.txt`, `sitemap.xml`, environment variable template (`.env.example`), README with setup instructions, API documentation (OpenAPI spec).

## Scope Calibration for Web Apps

| Task Type | Sections | Question Depth |
|-----------|----------|----------------|
| Landing page | 1-6, 8, 12 | 8-10 questions |
| Full SPA feature | 1-8, 10-12 | 15-20 questions |
| New SaaS product | All 12 sections | Full PRD questionnaire (40+ questions) |
| API-only backend | 1-3, 5, 7-9, 11-12 | 12-15 questions |
