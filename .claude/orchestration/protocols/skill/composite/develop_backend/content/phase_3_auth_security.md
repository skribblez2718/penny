# Phase 3: Authentication & Security

**Agent:** orchestrate-generation
**Type:** LINEAR

## Objective

Implement authentication mechanisms (JWT/OAuth), authorization patterns, input validation, and address OWASP Top 10 security vulnerabilities.

## Key Implementation Areas

### 1. Authentication Mechanisms

#### JWT (JSON Web Tokens)

**Token Structure:**
```
Header:  { "alg": "HS256", "typ": "JWT" }
Payload: { "sub": "user_id", "email": "...", "exp": 1234567890 }
Signature: HMACSHA256(base64(header) + "." + base64(payload), secret)
```

**Implementation Pattern:**
```javascript
// Login endpoint
app.post('/api/v1/auth/login', async (req, res) => {
  const { email, password } = req.body;

  // Validate input
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  // Verify credentials
  const user = await User.findByEmail(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Generate JWT
  const token = jwt.sign(
    { sub: user.id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );

  res.json({ token, user: { id: user.id, email: user.email } });
});

// Auth middleware
function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Protected route
app.get('/api/v1/users/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});
```

**Best Practices:**
- Use strong secret (256-bit minimum)
- Set appropriate expiration (24h for access tokens)
- Use refresh tokens for long-lived sessions
- Store secrets in environment variables (never hardcode)
- Consider token rotation on password change

#### OAuth 2.0

**Flow Types:**
- **Authorization Code:** For server-side apps
- **PKCE:** For mobile/SPA apps
- **Client Credentials:** For service-to-service

**Implementation (Authorization Code):**
```javascript
// Redirect to OAuth provider
app.get('/auth/google', (req, res) => {
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${GOOGLE_CLIENT_ID}&` +
    `redirect_uri=${REDIRECT_URI}&` +
    `response_type=code&` +
    `scope=email profile`;
  res.redirect(authUrl);
});

// Callback endpoint
app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;

  // Exchange code for tokens
  const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', {
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code'
  });

  const { access_token, id_token } = tokenResponse.data;

  // Verify ID token and get user info
  const userInfo = jwt.decode(id_token);

  // Create or update user in database
  const user = await User.findOrCreateByEmail(userInfo.email);

  // Generate app JWT
  const appToken = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '24h' });

  res.json({ token: appToken });
});
```

### 2. Authorization Patterns

#### Role-Based Access Control (RBAC)

**Role Definitions:**
```javascript
const ROLES = {
  ADMIN: 'admin',
  MODERATOR: 'moderator',
  USER: 'user'
};

const PERMISSIONS = {
  admin: ['read', 'write', 'delete', 'manage_users'],
  moderator: ['read', 'write', 'delete'],
  user: ['read', 'write_own']
};

function authorize(requiredPermission) {
  return (req, res, next) => {
    const userRole = req.user.role;
    const permissions = PERMISSIONS[userRole] || [];

    if (!permissions.includes(requiredPermission)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    next();
  };
}

// Usage
app.delete('/api/v1/posts/:id',
  authenticate,
  authorize('delete'),
  async (req, res) => {
    // Delete logic
  }
);
```

#### Attribute-Based Access Control (ABAC)

**Ownership Check:**
```javascript
function requireOwnership(resourceType) {
  return async (req, res, next) => {
    const resourceId = req.params.id;
    const userId = req.user.sub;

    const resource = await db[resourceType].findById(resourceId);

    if (!resource) {
      return res.status(404).json({ error: 'Not found' });
    }

    if (resource.user_id !== userId && req.user.role !== ROLES.ADMIN) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    req.resource = resource;
    next();
  };
}

// Usage
app.put('/api/v1/posts/:id',
  authenticate,
  requireOwnership('posts'),
  async (req, res) => {
    // Update logic
  }
);
```

### 3. Password Security

**Hashing with bcrypt:**
```javascript
const bcrypt = require('bcrypt');

// Registration
app.post('/api/v1/auth/register', async (req, res) => {
  const { email, password } = req.body;

  // Validate password strength
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  // Hash password
  const saltRounds = 10;
  const password_hash = await bcrypt.hash(password, saltRounds);

  // Create user
  const user = await User.create({ email, password_hash });

  res.status(201).json({ user: { id: user.id, email: user.email } });
});
```

**Password Policy:**
- Minimum 8 characters (12+ recommended)
- Mix of uppercase, lowercase, numbers, symbols
- No common passwords (use library like zxcvbn)
- Rate limit login attempts
- Account lockout after N failed attempts

### 4. Input Validation

**Schema Validation (Joi, Yup, Zod):**
```javascript
const Joi = require('joi');

const userSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  name: Joi.string().max(100).optional()
});

function validate(schema) {
  return (req, res, next) => {
    const { error } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        error: 'Validation error',
        details: error.details
      });
    }
    next();
  };
}

app.post('/api/v1/users', validate(userSchema), async (req, res) => {
  // Create user
});
```

**SQL Injection Prevention:**
```javascript
// BAD - Vulnerable to SQL injection
const query = `SELECT * FROM users WHERE email = '${email}'`;

// GOOD - Parameterized query
const query = 'SELECT * FROM users WHERE email = ?';
const results = await db.query(query, [email]);

// GOOD - ORM (Sequelize, Prisma, etc.)
const user = await User.findOne({ where: { email } });
```

### 5. OWASP Top 10 Mitigation

#### A01: Broken Access Control
- Implement authentication on all protected routes
- Verify ownership before modification
- Deny by default, allow explicitly

#### A02: Cryptographic Failures
- Use HTTPS (TLS 1.3)
- Hash passwords with bcrypt/argon2
- Encrypt sensitive data at rest
- Use strong JWT secrets

#### A03: Injection
- Use parameterized queries (no string concatenation)
- Validate and sanitize all inputs
- Use ORM/query builder

#### A04: Insecure Design
- Threat modeling in design phase
- Security requirements defined
- Secure defaults (deny by default)

#### A05: Security Misconfiguration
- Remove default credentials
- Disable debug mode in production
- Set secure HTTP headers
- Keep dependencies updated

#### A06: Vulnerable Components
- Regular dependency audits (`npm audit`, `pip audit`)
- Automated dependency updates (Dependabot)
- Pin versions in production

#### A07: Authentication Failures
- Multi-factor authentication (optional)
- Rate limiting on login
- Secure session management
- No hardcoded credentials

#### A08: Software and Data Integrity
- Sign releases and artifacts
- Use integrity checks (checksums)
- Secure CI/CD pipeline

#### A09: Security Logging Failures
- Log authentication events
- Log authorization failures
- Centralized log management
- Alert on suspicious patterns

#### A10: Server-Side Request Forgery (SSRF)
- Validate URLs before fetching
- Whitelist allowed domains
- Use network segmentation

### 6. Security Headers

**Helmet.js (Node.js):**
```javascript
const helmet = require('helmet');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"]
    }
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true
  }
}));
```

**Headers:**
- `Strict-Transport-Security`: Force HTTPS
- `X-Content-Type-Options: nosniff`: Prevent MIME sniffing
- `X-Frame-Options: DENY`: Prevent clickjacking
- `Content-Security-Policy`: XSS protection

## Implementation Checklist

- [ ] **Authentication Implemented:** JWT or OAuth 2.0 working
- [ ] **Password Hashing:** bcrypt with salt rounds >= 10
- [ ] **Authorization Middleware:** Role/ownership checks
- [ ] **Input Validation:** Schema validation on all endpoints
- [ ] **SQL Injection Protected:** Parameterized queries or ORM
- [ ] **Security Headers:** Helmet or equivalent configured
- [ ] **HTTPS Enforced:** TLS 1.3 in production
- [ ] **Rate Limiting:** Login endpoints rate-limited
- [ ] **Dependency Audit:** No critical vulnerabilities
- [ ] **OWASP Top 10 Addressed:** All 10 categories mitigated

## Gate Criteria

Before advancing to Phase 4 (Architecture & Scalability), ensure:

- [ ] **Authentication mechanism implemented:** JWT/OAuth working
- [ ] **Authorization rules defined:** RBAC or ABAC enforced
- [ ] **Input validation present:** Schema validation on all inputs
- [ ] **OWASP Top 10 addressed:** Mitigation for all 10 categories
- [ ] **Security headers configured:** Helmet or equivalent
- [ ] **Passwords secured:** bcrypt hashing with strong policy
- [ ] **Dependencies audited:** No critical/high vulnerabilities

## Output Expectations

The GENERATION agent should produce:

1. **Auth Implementation:** Login, register, JWT middleware
2. **Authorization Middleware:** Role and ownership checks
3. **Validation Schemas:** Input validation for all endpoints
4. **Security Configuration:** Headers, CORS, rate limiting
5. **OWASP Checklist:** Documentation of mitigation strategies
6. **Security Tests:** Unit tests for auth/authz flows

## Remediation Target

If Phase 7 (Validation) detects security failures, the workflow will loop back to this phase for remediation (max 2 iterations).

## Next Phase

Upon gate verification, advance to **Phase 4: Architecture & Scalability** where the SYNTHESIS agent will design scaling strategies and architectural patterns.
