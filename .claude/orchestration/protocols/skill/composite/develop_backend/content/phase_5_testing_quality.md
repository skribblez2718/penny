# Phase 5: Testing & Quality

**Agent:** orchestrate-generation
**Type:** LINEAR

## Objective

Implement test pyramid (unit, integration, E2E) with 70%+ coverage, configure CI/CD pipeline, and establish quality gates.

## Testing Strategy

### Test Pyramid

```
         /\
        /  \  E2E (5-10%)
       /____\
      /      \  Integration (20-30%)
     /________\
    /          \  Unit (60-70%)
   /____________\
```

**Distribution:**
- **Unit Tests:** 60-70% (fast, isolated, numerous)
- **Integration Tests:** 20-30% (moderate speed, database/API)
- **E2E Tests:** 5-10% (slow, full user flows)

### 1. Unit Testing

**Purpose:** Test individual functions in isolation

**Example (Jest/Mocha):**
```javascript
// user.service.js
class UserService {
  async createUser(email, password) {
    if (!email || !password) {
      throw new Error('Email and password required');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    return await db.users.create({ email, password_hash: passwordHash });
  }
}

// user.service.test.js
describe('UserService', () => {
  describe('createUser', () => {
    it('should create user with hashed password', async () => {
      const service = new UserService();
      const user = await service.createUser('test@example.com', 'password123');

      expect(user.email).toBe('test@example.com');
      expect(user.password_hash).not.toBe('password123'); // Hashed
      expect(user.id).toBeDefined();
    });

    it('should throw error if email missing', async () => {
      const service = new UserService();

      await expect(service.createUser(null, 'password123'))
        .rejects.toThrow('Email and password required');
    });

    it('should throw error if password missing', async () => {
      const service = new UserService();

      await expect(service.createUser('test@example.com', null))
        .rejects.toThrow('Email and password required');
    });
  });
});
```

**Best Practices:**
- **One assertion per test** (or closely related assertions)
- **AAA Pattern:** Arrange, Act, Assert
- **Descriptive names:** `should_create_user_when_valid_input`
- **Mock external dependencies:** Database, APIs, file system
- **Fast execution:** < 10ms per test

### 2. Integration Testing

**Purpose:** Test interactions between components (API + Database)

**Example (Supertest):**
```javascript
// auth.integration.test.js
const request = require('supertest');
const app = require('../app');

describe('POST /api/v1/auth/register', () => {
  beforeEach(async () => {
    await db.users.deleteAll(); // Clean database before each test
  });

  it('should register new user', async () => {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: 'test@example.com',
        password: 'SecurePass123!'
      })
      .expect(201);

    expect(response.body.user).toHaveProperty('id');
    expect(response.body.user.email).toBe('test@example.com');
    expect(response.body).not.toHaveProperty('password_hash'); // Not exposed

    // Verify database
    const dbUser = await db.users.findByEmail('test@example.com');
    expect(dbUser).toBeDefined();
    expect(dbUser.password_hash).not.toBe('SecurePass123!'); // Hashed
  });

  it('should return 400 if email already exists', async () => {
    // Create existing user
    await db.users.create({
      email: 'existing@example.com',
      password_hash: 'hash'
    });

    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: 'existing@example.com',
        password: 'password123'
      })
      .expect(400);

    expect(response.body.error).toBeDefined();
  });

  it('should return 400 if password too short', async () => {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: 'test@example.com',
        password: 'short'
      })
      .expect(400);

    expect(response.body.error).toContain('at least 8 characters');
  });
});

describe('POST /api/v1/auth/login', () => {
  beforeEach(async () => {
    // Create test user
    const passwordHash = await bcrypt.hash('SecurePass123!', 10);
    await db.users.create({
      email: 'test@example.com',
      password_hash: passwordHash
    });
  });

  it('should login with valid credentials', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'test@example.com',
        password: 'SecurePass123!'
      })
      .expect(200);

    expect(response.body.token).toBeDefined();
    expect(typeof response.body.token).toBe('string');
  });

  it('should return 401 with invalid password', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'test@example.com',
        password: 'WrongPassword'
      })
      .expect(401);

    expect(response.body.error).toBeDefined();
  });
});
```

**Setup:**
- Use test database (separate from dev/prod)
- Seed test data in `beforeEach` hooks
- Clean database after tests
- Use real database (not mocks) for integration tests

### 3. End-to-End (E2E) Testing

**Purpose:** Test complete user flows (UI → API → Database)

**Example (Playwright, Cypress):**
```javascript
// e2e/user-registration.spec.js
test('complete user registration flow', async ({ page }) => {
  // Navigate to signup page
  await page.goto('https://app.example.com/signup');

  // Fill form
  await page.fill('input[name="email"]', 'newuser@example.com');
  await page.fill('input[name="password"]', 'SecurePass123!');
  await page.click('button[type="submit"]');

  // Verify redirect to dashboard
  await expect(page).toHaveURL(/.*\/dashboard/);

  // Verify user is logged in
  await expect(page.locator('.user-email')).toHaveText('newuser@example.com');

  // API verification
  const response = await page.request.get('/api/v1/users/me', {
    headers: {
      'Authorization': `Bearer ${await getToken(page)}`
    }
  });

  expect(response.status()).toBe(200);
  const data = await response.json();
  expect(data.user.email).toBe('newuser@example.com');
});

async function getToken(page) {
  return await page.evaluate(() => localStorage.getItem('token'));
}
```

**Best Practices:**
- Focus on critical user journeys
- Run against staging environment
- Fewer E2E tests (expensive to maintain)
- Use API tests where possible instead

### 4. Test Coverage

**Tools:**
- **JavaScript:** Jest coverage, NYC (Istanbul)
- **Python:** Coverage.py, pytest-cov
- **Go:** go test -cover
- **Java:** JaCoCo

**Configuration (Jest):**
```javascript
// jest.config.js
module.exports = {
  collectCoverage: true,
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70
    }
  },
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/tests/',
    '/migrations/'
  ]
};
```

**Coverage Metrics:**
- **Lines:** Percentage of lines executed
- **Branches:** Percentage of if/else branches taken
- **Functions:** Percentage of functions called
- **Statements:** Percentage of statements executed

**Target:** 70%+ overall, 80%+ for critical business logic

### 5. Test Data Management

**Factories (JavaScript):**
```javascript
// factories/user.factory.js
const faker = require('@faker-js/faker');

function createUserData(overrides = {}) {
  return {
    email: faker.internet.email(),
    password_hash: 'hashed_password',
    created_at: new Date(),
    ...overrides
  };
}

// Usage in tests
const user = await db.users.create(createUserData({
  email: 'specific@example.com'
}));
```

**Fixtures:**
```javascript
// fixtures/users.json
[
  {
    "id": "user-1",
    "email": "admin@example.com",
    "role": "admin"
  },
  {
    "id": "user-2",
    "email": "user@example.com",
    "role": "user"
  }
]

// Load in tests
const fixtures = require('../fixtures/users.json');
await db.users.bulkCreate(fixtures);
```

### 6. CI/CD Pipeline

**GitHub Actions Example:**
```yaml
# .github/workflows/test.yml
name: Test

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_DB: test_db
          POSTGRES_USER: test_user
          POSTGRES_PASSWORD: test_pass
        ports:
          - 5432:5432

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm ci

      - name: Run migrations
        run: npm run migrate
        env:
          DATABASE_URL: postgresql://test_user:test_pass@localhost:5432/test_db

      - name: Run tests
        run: npm test -- --coverage
        env:
          DATABASE_URL: postgresql://test_user:test_pass@localhost:5432/test_db

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/lcov.info

      - name: Enforce coverage threshold
        run: |
          coverage=$(jq '.total.lines.pct' coverage/coverage-summary.json)
          if (( $(echo "$coverage < 70" | bc -l) )); then
            echo "Coverage $coverage% below threshold 70%"
            exit 1
          fi
```

**Pipeline Stages:**
1. **Checkout Code**
2. **Install Dependencies**
3. **Run Linter** (ESLint, Pylint)
4. **Run Unit Tests** (parallel)
5. **Run Integration Tests** (with test DB)
6. **Check Coverage** (fail if < 70%)
7. **Build Artifacts**
8. **Deploy to Staging** (if main branch)

### 7. Quality Gates

**Pre-Commit Hooks (Husky):**
```json
// package.json
{
  "husky": {
    "hooks": {
      "pre-commit": "npm run lint && npm run test:unit"
    }
  }
}
```

**Pull Request Requirements:**
- [ ] All tests passing
- [ ] Coverage >= 70%
- [ ] No linter errors
- [ ] Code review approved
- [ ] Security scan passed

## Implementation Checklist

- [ ] **Unit Tests:** 60-70% of test suite, mocked dependencies
- [ ] **Integration Tests:** 20-30%, real database, API testing
- [ ] **E2E Tests:** 5-10%, critical user flows
- [ ] **Coverage >= 70%:** Lines, branches, functions, statements
- [ ] **Test Fixtures:** Factories or fixtures for test data
- [ ] **CI Pipeline:** Automated testing on push/PR
- [ ] **Quality Gates:** Coverage threshold, linter, security scan
- [ ] **Test Database:** Separate test DB with migrations

## Gate Criteria

Before advancing to Phase 6 (Monitoring & Observability), ensure:

- [ ] **Unit tests present:** 70%+ coverage on business logic
- [ ] **Integration tests implemented:** API + database tests
- [ ] **E2E tests for critical paths:** Registration, login, core features
- [ ] **CI/CD pipeline configured:** Automated testing on every commit
- [ ] **Coverage threshold enforced:** Pipeline fails if < 70%
- [ ] **Test data management:** Factories or fixtures in place
- [ ] **Quality gates active:** Pre-commit hooks, PR checks

## Output Expectations

The GENERATION agent should produce:

1. **Test Files:** Unit, integration, E2E test suites
2. **Coverage Report:** Overall coverage >= 70%
3. **CI Configuration:** GitHub Actions, GitLab CI, or CircleCI
4. **Test Fixtures:** Factories and seed data
5. **Pre-commit Hooks:** Linter and unit tests
6. **Testing Documentation:** How to run tests locally

## Next Phase

Upon gate verification, advance to **Phase 6: Monitoring & Observability** where the GENERATION agent will implement logging, metrics, and tracing.
