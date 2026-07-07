# Web App — Full Worked Example

**Case: User Authentication Dashboard** — a web application for managing user accounts, roles, and authentication settings for a SaaS platform.

## Layer 1: Narrative PRD

### 1. Overview

We're building a User Authentication Dashboard — a React SPA with a FastAPI backend — that enables SaaS administrators to manage user accounts, assign roles, view login activity, and configure authentication policies. Currently, account management requires direct database access by engineering, creating a security risk and bottleneck. The dashboard will give non-technical admins self-service account management with audit trails.

### 2. Problem Statement

The SaaS platform has 200+ business customers with 15,000+ end users. When a customer needs to add/remove users, reset MFA, or investigate suspicious login activity, they must email support. Support tickets average 4-hour response time, and 30% require engineering intervention (database queries). This costs ~$12,000/month in support overhead and delays customer onboarding. Additionally, direct database access for account operations violates SOC 2 separation-of-duties controls.

### 3. Success Metrics

- Admin task completion: 95% of account management tasks completed via dashboard (no engineering intervention)
- Support ticket reduction: 70% decrease in account-related support tickets within 60 days
- Time to onboard: user provisioning from 4 hours → 5 minutes
- Performance: dashboard page loads < 1.5s (P95), API responses < 200ms (P95)
- Security: all admin actions logged to immutable audit trail, SOC 2 compliant
- Accessibility: Lighthouse accessibility score ≥ 90

### 4. User Stories

1. **As an admin**, I want to view all users in my organization, so that I can understand who has access.
   - Acceptance: Paginated user list with search, filter by role, sort by name/email/last login. Loads within 200ms for up to 1000 users.

2. **As an admin**, I want to invite new users via email, so that I can onboard team members without engineering help.
   - Acceptance: Invite form sends email with time-limited signup link. Link expires in 48h. Duplicate invites show friendly error.

3. **As an admin**, I want to assign roles (Admin, Manager, Viewer), so that I can enforce least-privilege access.
   - Acceptance: Role dropdown updates immediately, reflected in JWT on next token refresh. Cannot assign role higher than own.

4. **As an admin**, I want to disable/deactivate user accounts, so that I can revoke access for departed employees.
   - Acceptance: Deactivate button with confirmation modal. Immediate session invalidation. Account re-activatable.

5. **As an admin**, I want to view login activity (last login, failed attempts, IP), so that I can detect suspicious behavior.
   - Acceptance: Activity table per user. Red highlight for >5 failed attempts in 24h. Export to CSV.

6. **As an admin**, I want to configure password policies (length, complexity, expiry), so that my organization meets compliance requirements.
   - Acceptance: Policy form with live preview of policy effect. Changes apply to new passwords; existing unchanged.

7. **As a screen reader user**, I want to perform all admin functions via keyboard + screen reader, so that I am not blocked by accessibility barriers.
   - Acceptance: All interactive elements have accessible labels, all modals trap focus, all tables have proper headers. Lighthouse accessibility ≥ 90.

### 5. Features

| Priority | Feature | Description |
|----------|---------|-------------|
| P0 | User list with search/filter | Paginated list, search by name/email, filter by role, sortable columns |
| P0 | Invite user flow | Email invitation with time-limited signup link, invite status tracking |
| P0 | Role management | Assign/change roles, role hierarchy enforcement, audit log |
| P0 | Account deactivation/reactivation | Disable accounts, session invalidation, re-activation |
| P1 | Login activity dashboard | Last login, failed attempts, IP address, suspicious activity flags |
| P1 | Password policy configuration | Length, complexity, expiry rules with live preview |
| P2 | Bulk user import | CSV upload for batch user creation |
| P2 | Audit log viewer | Filterable, searchable audit log of all admin actions |

### 6. Out of Scope

- Creating/editing/deleting organizations (handled by super-admin console)
- SSO/SAML configuration (separate enterprise feature)
- Custom role creation (predefined roles only for v1)
- User profile editing (users manage own profiles)
- Real-time notifications (email-only for v1)
- Mobile native app
- Offline support

### 7. Non-Functional Requirements

- **Performance**: LCP < 1.5s, API P95 < 200ms, bundle < 150KB gzipped
- **Accessibility**: WCAG 2.1 AA, Lighthouse ≥ 90
- **Security**: CSP headers, CSRF tokens, rate limiting (100 req/s per admin), audit trail (immutable), JWT with refresh tokens
- **Reliability**: 99.9% uptime, error boundaries on all routes, retry with backoff on API failures
- **Maintainability**: TypeScript strict, React+shadcn/ui, FastAPI+SQLAlchemy, pytest > 80% coverage

### 8. Dependencies & Constraints

- React 18+, TypeScript 5+, FastAPI 0.100+, PostgreSQL 15+
- Existing auth service (modify, don't replace)
- Email service (SendGrid) for invitations
- Deployed on AWS ECS (existing infrastructure)
- Must not introduce new infrastructure services
- JWT-based auth in place; add role claims to existing token

### 9. Risks & Assumptions

- **Risk**: Admin actions could lock out legitimate users. Mitigation: confirmation dialogs for destructive actions, audit trail for reversal.
- **Risk**: Performance degradation with 15k+ users. Mitigation: server-side pagination, database indexing, load testing before launch.
- **Assumption**: Existing auth service has APIs for user CRUD and session management. Verification: audit auth service codebase before implementation.
- **Assumption**: Email delivery is reliable. Risk: invitation emails may land in spam. Mitigation: resend capability, SPF/DKIM verification.

### 10. Edge Cases

- What if an admin tries to deactivate their own account? → Prevented: self-deactivation disabled with tooltip.
- What if an invite email bounces? → Error logged, admin shown "email delivery failed" with retry option.
- What if 2 admins simultaneously change the same user's role? → Last-write-wins with optimistic locking; both admins see the final state.
- What if the auth service is down? → Dashboard shows degraded state, read-only mode with cached data.
- What if a user is in 10,000-user org? → Server-side pagination prevents memory issues; virtual scrolling for large lists.
- What if an admin has JavaScript disabled? → Graceful degradation: basic HTML forms with server-side rendering fallback.
- What happens on 404? → Custom 404 page with navigation back to dashboard.
- What on session expiry? → Silent token refresh; if refresh fails, redirect to login with return URL.

### 11. Build Order

1. Database migration: add roles table, audit_log table → unit tests
2. Backend API: user list endpoint (paginated, searchable) → integration tests
3. Backend API: invite, role, deactivation endpoints → integration tests
4. Frontend: user list page with search/filter → unit tests + E2E
5. Frontend: invite modal → unit tests + E2E
6. Frontend: role management + deactivation → unit tests + E2E
7. Backend: login activity endpoint → integration tests
8. Frontend: activity dashboard → unit tests
9. Backend: password policy CRUD → integration tests
10. Frontend: policy configuration page → unit tests
11. Audit log endpoint → integration tests
12. Audit log viewer → unit tests
13. Accessibility audit and remediation → manual + automated
14. Load testing and performance optimization

### 12. Deliverables

```
backend/
  migrations/versions/004_add_roles_audit.py
  src/admin/
    __init__.py
    router.py           # All admin API endpoints
    models.py           # Role, AuditLog models
    schemas.py          # Pydantic request/response schemas
    service.py          # Business logic
    auth.py             # Admin authorization middleware
  tests/
    test_admin_api.py
    test_admin_service.py

frontend/
  src/pages/admin/
    UserList.tsx
    UserDetail.tsx
    InviteModal.tsx
    RoleManager.tsx
    ActivityDashboard.tsx
    PolicyConfig.tsx
    AuditLogViewer.tsx
  src/components/admin/
    UserTable.tsx
    SearchBar.tsx
    ConfirmDialog.tsx
  src/hooks/
    useUsers.ts
    useRoles.ts
    useAuditLog.ts
  tests/
    admin/

docs/
  admin-dashboard.md
  api-spec.yaml       # OpenAPI 3.0

.env.example          # Updated with admin-related env vars
CHANGELOG.md
```

## Layer 2: Atomic Requirement Catalog

```json
[
  {
    "id": "REQ-001",
    "priority": "P0",
    "title": "Paginated user list endpoint",
    "description": "GET /api/admin/users returns paginated, searchable, filterable user list",
    "acceptance_criteria": [
      "Returns JSON with users[], total_count, page, per_page",
      "Supports ?search= query parameter for name/email search",
      "Supports ?role= query parameter for role filtering",
      "Supports ?sort_by=name|email|last_login&order=asc|desc",
      "Returns 403 if requester lacks admin role"
    ]
  },
  {
    "id": "REQ-002",
    "priority": "P0",
    "title": "User list UI with search and filter",
    "description": "React page displaying paginated user table with search bar and role filter dropdown",
    "acceptance_criteria": [
      "Displays user name, email, role, status, last login in table columns",
      "Search bar filters results by name/email with 300ms debounce",
      "Role filter dropdown filters table to selected role",
      "Pagination controls (prev/next, page numbers) for result sets > 20",
      "Responsive: table scrolls horizontally on mobile"
    ]
  },
  {
    "id": "REQ-003",
    "priority": "P0",
    "title": "User invitation endpoint",
    "description": "POST /api/admin/users/invite sends email invitation with time-limited signup link",
    "acceptance_criteria": [
      "Accepts {email, role} in request body",
      "Sends email via SendGrid with 48h-expiry signup link",
      "Returns 201 with invite_id and status 'pending'",
      "Returns 409 if email already registered or pending invite",
      "Returns 400 for invalid email format"
    ]
  },
  {
    "id": "REQ-004",
    "priority": "P0",
    "title": "Invite user modal UI",
    "description": "Modal form for admin to invite a new user with email and role selection",
    "acceptance_criteria": [
      "Email input with client-side format validation",
      "Role dropdown limited to roles ≤ admin's own role",
      "Submit button disabled while request in flight",
      "Success: toast notification + new row appears in user list",
      "Error: inline error message (duplicate email, invalid format, network error)"
    ]
  },
  {
    "id": "REQ-005",
    "priority": "P0",
    "title": "Role update endpoint",
    "description": "PATCH /api/admin/users/:id/role updates a user's role",
    "acceptance_criteria": [
      "Accepts {role} in request body",
      "Enforces role hierarchy: cannot assign role ≥ own role level",
      "Role change reflected in JWT on next token refresh",
      "Audit log entry created for every role change",
      "Returns 404 for nonexistent user, 403 for insufficient permission"
    ]
  },
  {
    "id": "REQ-006",
    "priority": "P0",
    "title": "Role management UI",
    "description": "Inline role dropdown on user row with confirmation on destructive changes",
    "acceptance_criteria": [
      "Dropdown shows current role, changes on selection",
      "Demotion to lower role: no confirmation needed",
      "Promotion to higher role: confirmation dialog",
      "Optimistic UI update with rollback on API error",
      "Role options filtered by admin's own role level"
    ]
  },
  {
    "id": "REQ-007",
    "priority": "P0",
    "title": "Account deactivation endpoint",
    "description": "POST /api/admin/users/:id/deactivate and POST /api/admin/users/:id/reactivate",
    "acceptance_criteria": [
      "Deactivate: sets user status to 'inactive', invalidates all sessions",
      "Reactivate: sets user status to 'active', does not restore old sessions",
      "Admin cannot deactivate their own account",
      "Audit log entry for both deactivation and reactivation",
      "Deactivated users do not appear in user list by default (toggle to show)"
    ]
  },
  {
    "id": "REQ-008",
    "priority": "P0",
    "title": "Account deactivation UI",
    "description": "Deactivate/Reactivate toggle button per user row with confirmation",
    "acceptance_criteria": [
      "Active users: 'Deactivate' button opens confirmation modal",
      "Inactive users: 'Reactivate' button with confirmation modal",
      "Own account row: deactivate button disabled with tooltip explanation",
      "User status visibly updates (row styling changes for inactive)",
      "Filter toggle to show/hide inactive users"
    ]
  },
  {
    "id": "REQ-009",
    "priority": "P1",
    "title": "Login activity endpoint",
    "description": "GET /api/admin/users/:id/activity returns login history for a user",
    "acceptance_criteria": [
      "Returns array of {timestamp, ip_address, success, failure_reason}",
      "Includes failed_login_count_24h field",
      "Supports ?from= and ?to= date range filtering",
      "Paginated for users with extensive history",
      "Returns 403 if requester lacks admin role"
    ]
  },
  {
    "id": "REQ-010",
    "priority": "P1",
    "title": "Login activity dashboard UI",
    "description": "Activity table and summary cards on user detail view",
    "acceptance_criteria": [
      "Summary card: last login time, failed attempts (24h), primary IP",
      "Activity table: timestamp, IP, success/failure, detail",
      "Red highlight on users with >5 failed attempts in 24h",
      "Export to CSV button",
      "Date range picker for filtering"
    ]
  },
  {
    "id": "REQ-011",
    "priority": "P1",
    "title": "Password policy configuration endpoint",
    "description": "CRUD endpoints for organization password policy",
    "acceptance_criteria": [
      "GET /api/admin/policy returns current password policy",
      "PUT /api/admin/policy updates policy (min_length, require_uppercase, etc.)",
      "Policy validation: min_length 8-128, must include at least one requirement",
      "Changes apply to new passwords only, existing passwords unchanged",
      "Returns policy preview showing how current passwords would fare"
    ]
  },
  {
    "id": "REQ-012",
    "priority": "P1",
    "title": "Password policy configuration UI",
    "description": "Form for configuring password policy with live preview",
    "acceptance_criteria": [
      "Checkbox toggles: uppercase, lowercase, numbers, special chars",
      "Slider for minimum length (8-128)",
      "Expiry days input (0 = never)",
      "Live preview showing password examples that pass/fail",
      "Save button with confirmation; displays 'affects new passwords only' note"
    ]
  },
  {
    "id": "REQ-013",
    "priority": "P0",
    "title": "Audit trail for all admin actions",
    "description": "Every admin action (invite, role change, deactivate, reactivate, policy change) logged immutably",
    "acceptance_criteria": [
      "Audit log includes: timestamp, admin_id, action, target_user_id, old_value, new_value, ip_address",
      "Audit log is append-only (no updates or deletes)",
      "Audit log entries created server-side, not client-submitted",
      "Log retention: 7 years minimum",
      "Log entries queryable via API by date range, action type, admin"
    ]
  },
  {
    "id": "REQ-014",
    "priority": "P0",
    "title": "Admin authorization middleware",
    "description": "Backend middleware that verifies JWT and checks admin role before allowing access to admin endpoints",
    "acceptance_criteria": [
      "All /api/admin/* routes require valid JWT with admin role claim",
      "Missing/expired JWT returns 401 with WWW-Authenticate header",
      "JWT without admin role returns 403",
      "Rate limited: 100 req/s per authenticated admin IP",
      "Admin role hierarchy: Admin > Manager > Viewer (Viewer has read-only admin access)"
    ]
  },
  {
    "id": "REQ-015",
    "priority": "P0",
    "title": "Accessibility compliance",
    "description": "All admin dashboard pages meet WCAG 2.1 AA standards",
    "acceptance_criteria": [
      "Lighthouse accessibility score ≥ 90 on all pages",
      "All images have alt text, all form inputs have labels",
      "Keyboard navigation works for all interactive elements",
      "Visible focus indicator on all focusable elements",
      "Skip-to-content link on every page",
      "Color contrast ≥ 4.5:1 for all text",
      "Screen reader announces dynamic content changes (role updates, errors)",
      "Modals trap focus and close on Escape"
    ]
  }
]
```

## Layer 3: Verification / Traceability Matrix

```json
{
  "REQ-001": {
    "unit_tests": ["test_admin_service.py::test_list_users_paginated", "test_admin_service.py::test_list_users_search", "test_admin_service.py::test_list_users_filter_by_role"],
    "integration_tests": ["test_admin_api.py::test_get_users_returns_200", "test_admin_api.py::test_get_users_requires_admin_role", "test_admin_api.py::test_get_users_search_param"],
    "e2e_tests": ["admin/user-list.spec.ts::test_user_list_loads", "admin/user-list.spec.ts::test_search_filters_users"],
    "manual_tests": []
  },
  "REQ-002": {
    "unit_tests": ["UserList.test.tsx::test_renders_table", "UserList.test.tsx::test_search_debounce", "UserTable.test.tsx::test_pagination"],
    "integration_tests": [],
    "e2e_tests": ["admin/user-list.spec.ts::test_user_list_displays_users", "admin/user-list.spec.ts::test_sorting_works"],
    "manual_tests": []
  },
  "REQ-003": {
    "unit_tests": ["test_admin_service.py::test_invite_user_sends_email", "test_admin_service.py::test_invite_duplicate_email_fails"],
    "integration_tests": ["test_admin_api.py::test_invite_returns_201", "test_admin_api.py::test_invite_duplicate_returns_409"],
    "e2e_tests": [],
    "manual_tests": ["Verify invitation email received with correct link"]
  },
  "REQ-004": {
    "unit_tests": ["InviteModal.test.tsx::test_form_validation", "InviteModal.test.tsx::test_submit_disabled_while_loading"],
    "integration_tests": [],
    "e2e_tests": ["admin/invite.spec.ts::test_invite_user_flow"],
    "manual_tests": []
  },
  "REQ-005": {
    "unit_tests": ["test_admin_service.py::test_update_role_success", "test_admin_service.py::test_update_role_permission_denied"],
    "integration_tests": ["test_admin_api.py::test_patch_role_returns_200", "test_admin_api.py::test_patch_role_self_escalation_returns_403"],
    "e2e_tests": ["admin/roles.spec.ts::test_change_user_role"],
    "manual_tests": []
  },
  "REQ-006": {
    "unit_tests": ["RoleManager.test.tsx::test_role_dropdown_options", "RoleManager.test.tsx::test_promotion_requires_confirmation"],
    "integration_tests": [],
    "e2e_tests": ["admin/roles.spec.ts::test_role_change_ui"],
    "manual_tests": []
  },
  "REQ-007": {
    "unit_tests": ["test_admin_service.py::test_deactivate_user", "test_admin_service.py::test_reactivate_user", "test_admin_service.py::test_cannot_deactivate_self"],
    "integration_tests": ["test_admin_api.py::test_deactivate_returns_200", "test_admin_api.py::test_deactivate_self_returns_400"],
    "e2e_tests": ["admin/deactivate.spec.ts::test_deactivate_and_reactivate_flow"],
    "manual_tests": []
  },
  "REQ-008": {
    "unit_tests": ["DeactivateButton.test.tsx::test_shows_confirmation", "DeactivateButton.test.tsx::test_self_deactivate_disabled"],
    "integration_tests": [],
    "e2e_tests": ["admin/deactivate.spec.ts::test_deactivate_button_ui"],
    "manual_tests": []
  },
  "REQ-009": {
    "unit_tests": ["test_admin_service.py::test_get_activity", "test_admin_service.py::test_get_activity_date_range"],
    "integration_tests": ["test_admin_api.py::test_get_activity_returns_200"],
    "e2e_tests": [],
    "manual_tests": []
  },
  "REQ-010": {
    "unit_tests": ["ActivityDashboard.test.tsx::test_renders_summary_cards", "ActivityDashboard.test.tsx::test_red_highlight_on_suspicious"],
    "integration_tests": [],
    "e2e_tests": ["admin/activity.spec.ts::test_activity_dashboard_loads"],
    "manual_tests": []
  },
  "REQ-011": {
    "unit_tests": ["test_admin_service.py::test_get_policy", "test_admin_service.py::test_update_policy_validation"],
    "integration_tests": ["test_admin_api.py::test_put_policy_returns_200", "test_admin_api.py::test_put_policy_invalid_returns_400"],
    "e2e_tests": [],
    "manual_tests": []
  },
  "REQ-012": {
    "unit_tests": ["PolicyConfig.test.tsx::test_live_preview_updates", "PolicyConfig.test.tsx::test_save_button"],
    "integration_tests": [],
    "e2e_tests": ["admin/policy.spec.ts::test_policy_configuration_flow"],
    "manual_tests": []
  },
  "REQ-013": {
    "unit_tests": ["test_audit_service.py::test_log_created_on_action", "test_audit_service.py::test_log_is_immutable"],
    "integration_tests": ["test_admin_api.py::test_audit_log_created_on_role_change", "test_admin_api.py::test_audit_log_queryable"],
    "e2e_tests": [],
    "manual_tests": ["Verify audit log entries appear for all action types"]
  },
  "REQ-014": {
    "unit_tests": ["test_admin_auth.py::test_missing_jwt_returns_401", "test_admin_auth.py::test_non_admin_jwt_returns_403", "test_admin_auth.py::test_rate_limit_enforced"],
    "integration_tests": ["test_admin_api.py::test_admin_endpoints_require_auth"],
    "e2e_tests": ["admin/auth.spec.ts::test_unauthorized_redirect"],
    "manual_tests": []
  },
  "REQ-015": {
    "unit_tests": [],
    "integration_tests": [],
    "e2e_tests": ["a11y/admin.spec.ts::test_lighthouse_score_above_90", "a11y/admin.spec.ts::test_keyboard_navigation", "a11y/admin.spec.ts::test_screen_reader_flow"],
    "manual_tests": ["Full keyboard-only walkthrough", "Screen reader (VoiceOver/NVDA) audit"]
  }
}
```

## IDEAL_STATE JSON

```json
{
  "goal": "Build a User Authentication Dashboard (React + FastAPI) enabling SaaS admins to manage users, roles, and auth policies with full audit trail",
  "source": "prd_synthesis",
  "success_criteria": [
    "Admin task completion: 95% of account management via dashboard, zero engineering intervention",
    "Support ticket reduction: 70% decrease in account-related tickets within 60 days",
    "User provisioning time: from 4 hours to under 5 minutes",
    "Dashboard page load: < 1.5s P95 LCP",
    "API response: < 200ms P95",
    "Lighthouse accessibility score ≥ 90 on all admin pages",
    "All admin actions logged to immutable audit trail"
  ],
  "anti_criteria": [
    "Do NOT break existing user auth flow",
    "Do NOT introduce new infrastructure services",
    "Do NOT allow privilege escalation via role management",
    "Do NOT expose user data to non-admin users"
  ],
  "verification": {
    "lint": true,
    "type_check": true,
    "unit_tests": true,
    "integration_tests": true,
    "e2e_tests": true,
    "accessibility": true
  },
  "security_review": ["injection", "xss", "auth", "csrf", "secrets"],
  "edge_cases": [
    "Admin cannot deactivate own account",
    "Two admins simultaneously changing same user's role",
    "Invite email bounces",
    "Auth service unavailable (degraded dashboard)",
    "10,000+ user organization pagination",
    "JavaScript disabled (server-rendered fallback)",
    "Session expiry during admin action"
  ],
  "language": "python",
  "impacted_files_estimate": 25,
  "dependencies": [
    "Existing auth service (JWT-based)",
    "SendGrid (email delivery)",
    "PostgreSQL 15+ (existing)",
    "React 18+ with shadcn/ui",
    "FastAPI 0.100+",
    "AWS ECS (existing deployment)"
  ],
  "deliverables": [
    "backend/src/admin/router.py",
    "backend/src/admin/models.py",
    "backend/src/admin/schemas.py",
    "backend/src/admin/service.py",
    "backend/src/admin/auth.py",
    "backend/migrations/versions/004_add_roles_audit.py",
    "frontend/src/pages/admin/UserList.tsx",
    "frontend/src/pages/admin/UserDetail.tsx",
    "frontend/src/pages/admin/InviteModal.tsx",
    "frontend/src/pages/admin/RoleManager.tsx",
    "frontend/src/pages/admin/ActivityDashboard.tsx",
    "frontend/src/pages/admin/PolicyConfig.tsx",
    "frontend/src/pages/admin/AuditLogViewer.tsx",
    "frontend/src/components/admin/*.tsx",
    "backend/tests/test_admin_api.py",
    "backend/tests/test_admin_service.py",
    "backend/tests/test_audit_service.py",
    "backend/tests/test_admin_auth.py",
    "frontend/tests/admin/*.spec.ts",
    "docs/admin-dashboard.md",
    "docs/api-spec.yaml"
  ],
  "build_order": [
    "Database migration: roles + audit_log tables",
    "Backend: user list endpoint (GET /api/admin/users)",
    "Backend: invite user endpoint (POST /api/admin/users/invite)",
    "Backend: role update endpoint (PATCH /api/admin/users/:id/role)",
    "Backend: deactivation endpoints",
    "Backend: admin auth middleware",
    "Frontend: user list page",
    "Frontend: invite modal",
    "Frontend: role management UI",
    "Frontend: deactivation UI",
    "Backend: login activity endpoint",
    "Frontend: activity dashboard",
    "Backend: password policy endpoint",
    "Frontend: policy configuration page",
    "Backend: audit log endpoint",
    "Frontend: audit log viewer",
    "Accessibility audit and remediation",
    "Load testing and performance optimization"
  ]
}
```
