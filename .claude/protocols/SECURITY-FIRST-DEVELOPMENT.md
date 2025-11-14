SECURITY-FIRST DEVELOPMENT PROTOCOL

PURPOSE
This protocol defines mandatory security requirements, secure coding practices, and vulnerability prevention strategies for all architecture and code generation agents in the Penny AI system. Security is integrated from architecture design through implementation, not added as an afterthought.

CRITICAL REQUIREMENT
ALL architecture and code generation agents MUST apply this protocol to prevent security vulnerabilities. Every design decision and code implementation MUST be evaluated for security implications. Code with CRITICAL or HIGH severity vulnerabilities MUST NOT pass validation gates. This is NON-NEGOTIABLE for production-quality software.

SCOPE OF APPLICATION
This protocol applies to:
- architecture-synthesizer (secure architecture design)
- architecture-validator (security architecture review)
- code-structure-generator (secure project scaffolding)
- core-implementation-generator (secure feature implementation)
- implementation-validator (security testing)
- security-validator (dedicated security audit)

SECURITY CORE PRINCIPLES

PRINCIPLE 1: DEFENSE IN DEPTH
Implement multiple layers of security controls. If one layer fails, others provide protection.

PRINCIPLE 2: LEAST PRIVILEGE
Grant minimum permissions necessary. Users, processes, and components access only what they need.

PRINCIPLE 3: FAIL SECURELY
System failures must not compromise security. Default to denying access, not granting it.

PRINCIPLE 4: SECURE BY DEFAULT
Security features enabled out-of-the-box. Users opt out of security, not opt in.

PRINCIPLE 5: NEVER TRUST INPUT
All input is untrusted until validated. This includes user input, API data, file contents, environment variables.

PRINCIPLE 6: SEPARATION OF DUTIES
Critical operations require multiple parties or steps. Prevents single point of compromise.

OWASP TOP 10 VULNERABILITIES (2021)

VULNERABILITY 1: BROKEN ACCESS CONTROL
Description: Users can act outside their intended permissions
Impact: Unauthorized access to data, privilege escalation
Prevention:
- Deny by default for all resources
- Implement role-based access control (RBAC)
- Enforce authorization checks on server side, not client
- Validate user owns resource before allowing access
- Log access control failures for monitoring

Code examples:
BAD:
```python
# Client-side check only
if user.is_admin:
    show_admin_panel()
```

GOOD:
```python
# Server-side authorization
@require_permission('admin')
def admin_endpoint():
    if not current_user.has_role('admin'):
        raise Forbidden("Admin access required")
    return admin_data
```

Testing:
- Test accessing resources without authentication
- Test accessing resources of other users
- Test privilege escalation attempts
- Test horizontal access (user A accessing user B's data)
- Test vertical access (user accessing admin functions)

VULNERABILITY 2: CRYPTOGRAPHIC FAILURES
Description: Inadequate protection of sensitive data in transit and at rest
Impact: Data breaches, credential theft, privacy violations
Prevention:
- Use TLS 1.2+ for all network transmission
- Never store passwords in plain text (use bcrypt, argon2, scrypt)
- Use strong encryption algorithms (AES-256, not DES/3DES)
- Secure key management (environment variables, key vaults, not hardcoded)
- Hash sensitive data that doesn't need decryption
- Avoid weak random number generators

Code examples:
BAD:
```python
# Plain text password storage
user.password = request.form['password']

# Weak hashing
import md5
hash = md5.new(password).hexdigest()
```

GOOD:
```python
# Secure password hashing
from bcrypt import hashpw, gensalt
user.password_hash = hashpw(password.encode(), gensalt(rounds=12))

# Secure comparison
from bcrypt import checkpw
if checkpw(password.encode(), user.password_hash):
    authenticate_user()
```

Testing:
- Verify TLS/HTTPS enforced
- Check no sensitive data in logs
- Verify passwords hashed, not encrypted
- Test key rotation capabilities
- Validate secure random number generation

VULNERABILITY 3: INJECTION
Description: Untrusted data sent to interpreter as part of command or query
Types: SQL injection, NoSQL injection, OS command injection, LDAP injection
Impact: Data breach, data corruption, complete system compromise
Prevention:
- Use parameterized queries (prepared statements)
- Use ORM frameworks correctly
- Validate and sanitize all input
- Escape special characters for target interpreter
- Apply principle of least privilege to database users
- Use allowlists for input validation when possible

Code examples:
BAD (SQL Injection):
```python
# Concatenating user input into SQL
query = f"SELECT * FROM users WHERE username = '{username}'"
cursor.execute(query)  # VULNERABLE!
```

GOOD (Parameterized Query):
```python
# Using parameterized query
query = "SELECT * FROM users WHERE username = ?"
cursor.execute(query, (username,))  # SAFE
```

BAD (Command Injection):
```python
# Passing user input to shell
import os
os.system(f"ping {user_input}")  # VULNERABLE!
```

GOOD (Safe Alternative):
```python
# Using safe API with validation
import subprocess
import re
if re.match(r'^[\w\.-]+$', hostname):  # Allowlist validation
    subprocess.run(['ping', '-c', '1', hostname], check=True)
else:
    raise ValueError("Invalid hostname")
```

Testing:
- Test SQL injection with quotes, semicolons, UNION statements
- Test command injection with pipes, semicolons, backticks
- Test NoSQL injection with special characters
- Test LDAP injection
- Verify parameterized queries used throughout

VULNERABILITY 4: INSECURE DESIGN
Description: Missing or ineffective security controls in design phase
Impact: Architectural flaws that can't be fixed by implementation alone
Prevention:
- Threat modeling during architecture phase
- Define security requirements alongside functional requirements
- Use secure design patterns (authentication, session management)
- Implement rate limiting and resource limits
- Design for graceful degradation under attack
- Review architecture against security principles

Architecture patterns:
- Authentication: OAuth2, OpenID Connect, JWT with proper validation
- Session management: Secure cookies, token rotation, timeout
- API security: API keys, rate limiting, request signing
- Data flow: Minimize sensitive data exposure, encrypt in transit
- Logging: Centralized, tamper-resistant, no sensitive data

Security requirements to define:
- Authentication mechanisms
- Authorization model (RBAC, ABAC)
- Data encryption requirements
- Audit logging requirements
- Rate limiting thresholds
- Input validation rules
- Session timeout values
- Password complexity requirements

VULNERABILITY 5: SECURITY MISCONFIGURATION
Description: Insecure default configurations, incomplete setups, open cloud storage
Impact: Unauthorized access, information disclosure, system compromise
Prevention:
- Remove default accounts and passwords
- Disable unnecessary features, ports, services
- Keep all software up to date
- Use secure defaults in configuration
- Implement proper error handling (no stack traces in production)
- Configure security headers (CSP, HSTS, X-Frame-Options)
- Separate development, staging, production environments

Configuration checklist:
- [ ] Debug mode disabled in production
- [ ] Default credentials changed
- [ ] Unnecessary services disabled
- [ ] Security headers configured
- [ ] CORS properly configured (not wildcard in production)
- [ ] File permissions restrictive
- [ ] Environment-specific configurations
- [ ] Secrets in environment variables, not code
- [ ] Error messages don't reveal sensitive info
- [ ] Dependency versions pinned

Code examples:
BAD:
```python
# Debug mode in production
app.run(debug=True)  # NEVER in production!

# Verbose error messages
except Exception as e:
    return f"Error: {e} {traceback.format_exc()}"  # Info leak!
```

GOOD:
```python
# Production-ready configuration
if os.getenv('ENVIRONMENT') == 'production':
    app.run(debug=False)
    app.config['PROPAGATE_EXCEPTIONS'] = False

# Safe error handling
except Exception as e:
    logger.error(f"Error: {e}", exc_info=True)
    return "An error occurred. Please contact support.", 500
```

VULNERABILITY 6: VULNERABLE AND OUTDATED COMPONENTS
Description: Using libraries with known vulnerabilities
Impact: Inheriting vulnerabilities from dependencies
Prevention:
- Maintain inventory of components and versions
- Monitor for security advisories (CVEs)
- Use dependency scanning tools (npm audit, pip-audit, OWASP Dependency-Check)
- Update dependencies regularly
- Remove unused dependencies
- Verify integrity of downloaded components (checksums, signatures)
- Use Software Composition Analysis (SCA) tools

Implementation:
- Pin dependency versions in lockfiles
- Automate dependency updates (Dependabot, Renovate)
- Run security scans in CI/CD pipeline
- Establish update cadence (monthly minimum)
- Test updates before deploying

Commands to integrate:
```bash
# JavaScript
npm audit
npm audit fix

# Python
pip-audit
safety check

# Ruby
bundle audit

# Java
mvn dependency-check:check
```

VULNERABILITY 7: IDENTIFICATION AND AUTHENTICATION FAILURES
Description: Weak authentication, session management flaws, credential stuffing
Impact: Account takeover, unauthorized access
Prevention:
- Implement multi-factor authentication (MFA)
- Enforce strong password requirements
- Implement account lockout after failed attempts
- Use secure session management
- Invalidate session on logout
- Regenerate session ID after authentication
- Protect against credential stuffing (rate limiting)
- Never expose session IDs in URLs

Password requirements:
- Minimum 12 characters (NIST recommendation)
- Complexity requirements (upper, lower, number, special)
- Check against common password lists
- Implement password history (prevent reuse)
- Secure password reset flow (time-limited tokens)

Session management:
- Use framework's session management (don't roll your own)
- Set secure, httpOnly, sameSite flags on cookies
- Implement absolute and idle timeouts
- Invalidate all sessions on password change
- One session per user (or limited concurrent sessions)

Code examples:
BAD:
```python
# Weak session management
session_id = hashlib.md5(username.encode()).hexdigest()
response.set_cookie('session', session_id)  # Insecure!
```

GOOD:
```python
# Secure session management
from flask import session
session.permanent = True
session['user_id'] = user.id
# Flask handles secure session ID generation and storage

# Cookie settings in config
app.config.update(
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    PERMANENT_SESSION_LIFETIME=1800  # 30 minutes
)
```

VULNERABILITY 8: SOFTWARE AND DATA INTEGRITY FAILURES
Description: Insecure CI/CD, auto-updates without integrity verification, untrusted sources
Impact: Malicious code execution, supply chain attacks
Prevention:
- Verify digital signatures of software
- Use trusted repositories only
- Implement code review process
- Use version control with signed commits
- Implement secure CI/CD pipeline (isolated build environments)
- Generate and verify checksums for artifacts
- Implement subresource integrity (SRI) for CDN resources

CI/CD security:
- Secrets management (vault, not hardcoded)
- Least privilege for CI/CD systems
- Audit logs for deployments
- Immutable build artifacts
- Separate build and deploy stages

Code examples:
BAD:
```html
<!-- CDN without integrity check -->
<script src="https://cdn.example.com/lib.js"></script>
```

GOOD:
```html
<!-- CDN with subresource integrity -->
<script src="https://cdn.example.com/lib.js"
        integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/ux"
        crossorigin="anonymous"></script>
```

VULNERABILITY 9: SECURITY LOGGING AND MONITORING FAILURES
Description: Insufficient logging, lack of monitoring, no alerting
Impact: Delayed detection of breaches, incomplete incident response
Prevention:
- Log all authentication attempts (success and failure)
- Log all access control failures
- Log all input validation failures
- Centralize log management
- Implement real-time monitoring and alerting
- Protect log integrity (append-only, signed)
- Regular log review
- Retention policy for compliance

Logging best practices:
- Include timestamp, user ID, action, result, IP address
- Never log passwords, tokens, credit cards, PII
- Use structured logging (JSON format)
- Implement log levels (DEBUG, INFO, WARNING, ERROR)
- Separate security logs from application logs

Code examples:
BAD:
```python
# Insufficient logging
if not authenticate(user, password):
    return "Login failed"  # No logging!
```

GOOD:
```python
# Comprehensive security logging
import logging
security_logger = logging.getLogger('security')

if not authenticate(user, password):
    security_logger.warning(
        "Failed login attempt",
        extra={
            'username': username,
            'ip_address': request.remote_addr,
            'timestamp': datetime.utcnow(),
            'event_type': 'authentication_failure'
        }
    )
    return "Login failed", 401
```

Monitoring requirements:
- Failed login attempts (detect brute force)
- Privilege escalation attempts
- Unusual access patterns
- Multiple requests from same IP (rate limiting)
- Error rate spikes
- Unauthorized API calls

VULNERABILITY 10: SERVER-SIDE REQUEST FORGERY (SSRF)
Description: Application fetches remote resources without validating user-supplied URLs
Impact: Access to internal systems, cloud metadata exposure, port scanning
Prevention:
- Validate and sanitize all URLs
- Use allowlist of permitted domains/IPs
- Disable HTTP redirections
- Block requests to private IP ranges (RFC 1918)
- Block requests to localhost (127.0.0.1, ::1)
- Implement network segmentation
- Use DNS validation

Code examples:
BAD:
```python
# Fetching user-supplied URL without validation
import requests
url = request.args.get('url')
response = requests.get(url)  # VULNERABLE!
```

GOOD:
```python
# URL validation before fetching
import requests
from urllib.parse import urlparse
import ipaddress

def is_safe_url(url):
    parsed = urlparse(url)

    # Allowlist of permitted domains
    allowed_domains = ['api.example.com', 'cdn.example.com']
    if parsed.hostname not in allowed_domains:
        return False

    # Block private IP ranges
    try:
        ip = ipaddress.ip_address(parsed.hostname)
        if ip.is_private or ip.is_loopback:
            return False
    except ValueError:
        pass  # Not an IP address, domain validation sufficient

    # Only allow HTTPS
    if parsed.scheme != 'https':
        return False

    return True

url = request.args.get('url')
if is_safe_url(url):
    response = requests.get(url, timeout=5, allow_redirects=False)
else:
    raise ValueError("Invalid or unsafe URL")
```

ADDITIONAL SECURITY REQUIREMENTS

CROSS-SITE SCRIPTING (XSS)
Prevention:
- Escape all user input before rendering in HTML
- Use Content Security Policy (CSP) headers
- Set HttpOnly flag on cookies
- Use framework's auto-escaping features
- Validate input on server side
- Sanitize HTML if rich text required (use DOMPurify or similar)

Code examples:
BAD:
```javascript
// Directly inserting user input into DOM
element.innerHTML = userInput;  // VULNERABLE!
```

GOOD:
```javascript
// Using framework's safe rendering (React)
<div>{userInput}</div>  // Auto-escaped

// Or manual escaping
const escaped = DOMPurify.sanitize(userInput);
element.innerHTML = escaped;
```

CROSS-SITE REQUEST FORGERY (CSRF)
Prevention:
- Use anti-CSRF tokens for state-changing requests
- Set SameSite attribute on cookies
- Verify Origin and Referer headers
- Require re-authentication for sensitive operations
- Use framework's CSRF protection (Django, Rails, etc.)

Code examples:
```python
# Flask-WTF provides CSRF protection
from flask_wtf.csrf import CSRFProtect
csrf = CSRFProtect(app)

# Django requires csrf_token in forms
{% csrf_token %}
```

SECURITY HEADERS
Required headers for web applications:
- Content-Security-Policy: Prevents XSS, data injection
- Strict-Transport-Security: Enforces HTTPS
- X-Frame-Options: Prevents clickjacking
- X-Content-Type-Options: Prevents MIME sniffing
- X-XSS-Protection: Browser XSS filter
- Referrer-Policy: Controls referrer information
- Permissions-Policy: Controls browser features

Code example:
```python
# Setting security headers
@app.after_request
def set_security_headers(response):
    response.headers['Content-Security-Policy'] = "default-src 'self'"
    response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    return response
```

INPUT VALIDATION
Principles:
- Validate on server side (never trust client)
- Use allowlist approach (define what's valid, reject rest)
- Validate data type, length, format, range
- Reject invalid input, don't try to sanitize
- Validate at each layer (presentation, business, data)

Validation types:
- Syntactic: Correct format (email, URL, phone)
- Semantic: Meaningful value (date in future, valid country code)
- Business: Meets business rules (sufficient balance, authorized operation)

Code example:
```python
# Comprehensive input validation
from email_validator import validate_email, EmailNotValidError
import re

def validate_user_registration(data):
    errors = []

    # Email validation
    try:
        valid = validate_email(data['email'])
        email = valid.email
    except EmailNotValidError as e:
        errors.append(f"Invalid email: {e}")

    # Password strength
    password = data['password']
    if len(password) < 12:
        errors.append("Password must be at least 12 characters")
    if not re.search(r'[A-Z]', password):
        errors.append("Password must contain uppercase letter")
    if not re.search(r'[a-z]', password):
        errors.append("Password must contain lowercase letter")
    if not re.search(r'\d', password):
        errors.append("Password must contain digit")

    # Username allowlist
    username = data['username']
    if not re.match(r'^[a-zA-Z0-9_-]{3,20}$', username):
        errors.append("Username must be 3-20 alphanumeric characters")

    if errors:
        raise ValidationError(errors)

    return {
        'email': email,
        'password': password,
        'username': username
    }
```

SECURITY ARCHITECTURE PATTERNS

AUTHENTICATION PATTERNS
- JWT (JSON Web Tokens): Stateless authentication
  - Sign tokens with strong secret (HS256) or RSA (RS256)
  - Include expiration time (exp claim)
  - Validate signature, expiration, issuer, audience
  - Store in httpOnly cookies or Authorization header
  - Implement token refresh mechanism

- OAuth2 / OpenID Connect: Delegated authentication
  - Use authorization code flow for web apps
  - Use PKCE (Proof Key for Code Exchange) for mobile/SPA
  - Validate redirect URIs
  - Store tokens securely
  - Implement proper scope management

- Session-based: Traditional server-side sessions
  - Use framework's session management
  - Store sessions server-side (Redis, database)
  - Set secure cookie flags
  - Implement session timeout
  - Regenerate session ID on privilege change

AUTHORIZATION PATTERNS
- Role-Based Access Control (RBAC): Users assigned roles, roles have permissions
- Attribute-Based Access Control (ABAC): Policies based on attributes (user, resource, environment)
- Access Control Lists (ACL): Per-resource permission lists

DATA PROTECTION PATTERNS
- Encryption at rest: Encrypt sensitive data in database (transparent data encryption)
- Encryption in transit: TLS 1.2+ for all network communication
- Tokenization: Replace sensitive data with tokens
- Data masking: Show partial data (e.g., ***-**-1234 for SSN)

API SECURITY PATTERNS
- API Gateway: Centralized authentication, rate limiting, logging
- API Keys: Identify API consumers
- Request Signing: Verify request integrity (HMAC)
- Rate Limiting: Prevent abuse (requests per minute/hour)
- Versioning: Maintain backward compatibility, deprecate insecure versions

SECURITY TESTING REQUIREMENTS

STATIC ANALYSIS
- Run SAST (Static Application Security Testing) tools
- Tools: SonarQube, Checkmarx, Veracode, Semgrep
- Integrate into CI/CD pipeline
- Fix CRITICAL and HIGH findings before deployment

DYNAMIC ANALYSIS
- Run DAST (Dynamic Application Security Testing) tools
- Tools: OWASP ZAP, Burp Suite, Acunetix
- Test running application for vulnerabilities
- Perform penetration testing for critical applications

DEPENDENCY SCANNING
- Scan dependencies for known vulnerabilities
- Tools: npm audit, pip-audit, OWASP Dependency-Check, Snyk
- Integrate into CI/CD pipeline
- Update vulnerable dependencies immediately

SECURITY UNIT TESTS
- Write tests for security-critical functions
- Test authentication and authorization
- Test input validation
- Test encryption and hashing
- Test session management

Example security test:
```python
def test_sql_injection_prevention():
    """Verify parameterized queries prevent SQL injection"""
    malicious_input = "'; DROP TABLE users; --"

    # Should not raise exception or execute malicious SQL
    result = get_user_by_username(malicious_input)

    # Should return None (no user found) not execute DROP
    assert result is None

    # Verify users table still exists
    assert table_exists('users')

def test_authorization_enforcement():
    """Verify users cannot access other users' data"""
    user_a = create_test_user('user_a')
    user_b = create_test_user('user_b')

    # User A creates document
    doc = create_document(user_a, "Private data")

    # User B attempts to access
    with pytest.raises(Forbidden):
        access_document(user_b, doc.id)
```

INTEGRATION WITH TDD PROTOCOL

Security tests are part of the TDD cycle:
1. RED: Write failing security test
2. GREEN: Implement security control
3. REFACTOR: Improve without compromising security

Security testing in TDD phases:
- Unit tests: Input validation, authentication logic, authorization checks
- Integration tests: End-to-end authentication flow, API security
- E2E tests: Full security workflows (login, permissions, logout)

SECURITY CODE REVIEW CHECKLIST

During code generation and validation:
- [ ] All user input validated and sanitized
- [ ] Parameterized queries used (no string concatenation)
- [ ] Authentication implemented correctly
- [ ] Authorization checked before data access
- [ ] Passwords hashed with strong algorithm (bcrypt, argon2)
- [ ] Sensitive data encrypted in transit and at rest
- [ ] Security headers configured
- [ ] CSRF protection enabled for state-changing requests
- [ ] XSS prevention (output encoding, CSP)
- [ ] Error messages don't leak sensitive information
- [ ] Logging doesn't include passwords or tokens
- [ ] Dependencies up to date, no known vulnerabilities
- [ ] Secrets in environment variables, not code
- [ ] Rate limiting implemented for APIs
- [ ] Session management secure (timeouts, secure flags)

SEVERITY CLASSIFICATION

CRITICAL: Immediate exploitation leads to complete compromise
- Remote code execution
- SQL injection with admin access
- Authentication bypass
- Exposed API keys or credentials in code

HIGH: Easy exploitation with significant impact
- XSS on sensitive pages
- CSRF on state-changing operations
- Authorization bypass
- Insecure cryptographic storage

MEDIUM: Exploitation requires specific conditions or has limited impact
- Information disclosure
- Security misconfiguration
- Missing security headers
- Weak password policy

LOW: Minimal security impact or difficult to exploit
- Verbose error messages
- Missing rate limiting (non-critical endpoints)
- Weak cryptographic algorithms (non-sensitive data)

REMEDIATION REQUIREMENTS

CRITICAL and HIGH vulnerabilities MUST be fixed before deployment.
MEDIUM vulnerabilities SHOULD be fixed before deployment.
LOW vulnerabilities MAY be accepted as technical debt with documentation.

INTEGRATION WITH OTHER PROTOCOLS

TEST-DRIVEN-DEVELOPMENT.md
- Write security tests first (RED)
- Implement security controls (GREEN)
- Refactor while maintaining security (REFACTOR)

CONTEXT-INHERITANCE.md
- Track security requirements from previous phases
- Resolve security-related unknowns
- Document security decisions in Open quadrant

AGENT-EXECUTION-PROTOCOL.md
- Include security validation in output quality checklist
- Flag security issues in Blind Spot Check
- Document security assumptions in Assumption Audit

ARCHITECTURE-RELATED AGENTS
- architecture-synthesizer: Design secure architecture
- architecture-validator: Validate against security principles

CODE-RELATED AGENTS
- code-structure-generator: Secure scaffolding and configuration
- core-implementation-generator: Secure implementation with validation
- implementation-validator: Execute security tests
- security-validator: Deep security audit

CONFIDENCE SCORING FOR SECURITY

CERTAIN: All OWASP Top 10 addressed, security tests pass, no known vulnerabilities
PROBABLE: Most security controls in place, minor issues only, dependencies updated
POSSIBLE: Basic security implemented, some gaps remain, non-critical findings
UNCERTAIN: Minimal security, known vulnerabilities, missing critical controls

RELATED DOCUMENTATION
- .claude/protocols/TEST-DRIVEN-DEVELOPMENT.md - Security testing in TDD
- .claude/protocols/CONTEXT-INHERITANCE.md - Security requirement tracking
- .claude/protocols/AGENT-EXECUTION-PROTOCOL.md - Security in output validation
- .claude/docs/AGENT-DESIGN-PRINCIPLES.md - Progressive security context loading

REMEMBER
Security is not a feature to add later - it is a fundamental requirement from architecture through deployment. Every line of code is a potential attack vector. Defense in depth, least privilege, and failing securely protect users and systems. When in doubt, deny access and log the attempt.
