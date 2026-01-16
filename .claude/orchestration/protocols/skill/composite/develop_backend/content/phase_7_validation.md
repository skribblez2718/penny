# Phase 7: Final Validation

**Agent:** orchestrate-validation
**Type:** REMEDIATION (loops to Phase 3 on security failure)

## Objective

Validate all backend components against acceptance criteria, run security scans, verify all gate criteria from previous phases, and ensure production readiness.

## Validation Categories

### 1. Security Validation (CRITICAL - Triggers Remediation)

#### OWASP ZAP Scan

**Dynamic Application Security Testing:**
```bash
# Run ZAP in daemon mode
docker run -d -p 8080:8080 owasp/zap2docker-stable zap.sh -daemon \
  -host 0.0.0.0 -port 8080 -config api.disablekey=true

# Spider the application
curl "http://localhost:8080/JSON/spider/action/scan/?url=http://api.example.com"

# Active scan
curl "http://localhost:8080/JSON/ascan/action/scan/?url=http://api.example.com"

# Get results
curl "http://localhost:8080/JSON/core/view/alerts/?baseurl=http://api.example.com" \
  > zap-results.json

# Fail build if high/critical vulnerabilities found
CRITICAL=$(jq '[.alerts[] | select(.risk == "High" or .risk == "Critical")] | length' zap-results.json)

if [ "$CRITICAL" -gt 0 ]; then
  echo "SECURITY VALIDATION FAILED: $CRITICAL critical/high vulnerabilities found"
  exit 1
fi
```

**Remediation Trigger:** If security scan finds critical/high vulnerabilities, loop back to Phase 3 (max 2 iterations)

#### Dependency Vulnerability Scan

**Node.js:**
```bash
npm audit --audit-level=high
# Fail if critical or high vulnerabilities
if [ $? -ne 0 ]; then
  echo "SECURITY VALIDATION FAILED: Vulnerable dependencies"
  exit 1
fi
```

**Python:**
```bash
pip-audit --desc
# Check for known vulnerabilities
```

**Go:**
```bash
go list -json -m all | nancy sleuth
```

#### Security Checklist

- [ ] **A01: Broken Access Control**
  - Authentication required on protected routes
  - Authorization checks before data access
  - Ownership verification for user resources

- [ ] **A02: Cryptographic Failures**
  - HTTPS enforced (TLS 1.3)
  - Passwords hashed with bcrypt (salt rounds >= 10)
  - JWT secrets are strong (256-bit)
  - Sensitive data encrypted at rest

- [ ] **A03: Injection**
  - Parameterized queries (no string concatenation)
  - Input validation on all endpoints
  - SQL injection tests passed

- [ ] **A04: Insecure Design**
  - Threat modeling completed
  - Security requirements defined
  - Secure defaults applied

- [ ] **A05: Security Misconfiguration**
  - Default credentials removed
  - Debug mode disabled in production
  - Security headers configured (Helmet)
  - Error messages don't expose internals

- [ ] **A06: Vulnerable Components**
  - Dependencies up to date
  - No critical/high vulnerabilities
  - Automated dependency scanning

- [ ] **A07: Authentication Failures**
  - Password policy enforced (8+ chars)
  - Rate limiting on login
  - Session expiration configured
  - No hardcoded credentials

- [ ] **A08: Software Integrity**
  - Code signing for releases
  - Integrity checks on dependencies
  - Secure CI/CD pipeline

- [ ] **A09: Security Logging Failures**
  - Login attempts logged
  - Authorization failures logged
  - Sensitive data redacted from logs

- [ ] **A10: SSRF**
  - URL validation before fetching
  - Whitelist allowed domains
  - Network segmentation

### 2. API Validation

#### Contract Testing

**Test against OpenAPI spec:**
```javascript
const SwaggerParser = require('@apidevtools/swagger-parser');
const request = require('supertest');

describe('API Contract Validation', () => {
  let apiSpec;

  beforeAll(async () => {
    apiSpec = await SwaggerParser.validate('./openapi.yaml');
  });

  it('should match OpenAPI spec for GET /api/v1/users', async () => {
    const response = await request(app)
      .get('/api/v1/users')
      .expect(200);

    // Validate response schema matches spec
    const schema = apiSpec.paths['/api/v1/users'].get.responses['200'].content['application/json'].schema;
    expect(response.body).toMatchSchema(schema);
  });
});
```

#### Endpoint Checklist

- [ ] All endpoints documented in OpenAPI spec
- [ ] Request validation working (400 on invalid input)
- [ ] Error responses follow standard format
- [ ] Rate limiting enforced (429 response)
- [ ] Pagination working (limit, offset/cursor)
- [ ] CORS configured correctly
- [ ] Versioning strategy implemented

### 3. Database Validation

#### Schema Verification

```sql
-- Verify all foreign keys have indexes
SELECT
  tc.table_name,
  kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = tc.table_name
    AND indexdef LIKE '%' || kcu.column_name || '%'
  );

-- Should return 0 rows (all foreign keys indexed)
```

#### Database Checklist

- [ ] All tables have primary keys
- [ ] Foreign keys defined with CASCADE/RESTRICT
- [ ] Indexes on foreign keys and query columns
- [ ] Timestamps (created_at, updated_at) on all tables
- [ ] Soft delete pattern for user data
- [ ] Migration files tested (up and down)
- [ ] Connection pooling configured
- [ ] Query performance tested (< 100ms for simple queries)

### 4. Testing Validation

#### Coverage Report

```bash
npm test -- --coverage

# Verify coverage thresholds
COVERAGE=$(jq '.total.lines.pct' coverage/coverage-summary.json)

if (( $(echo "$COVERAGE < 70" | bc -l) )); then
  echo "TEST VALIDATION FAILED: Coverage $COVERAGE% below threshold 70%"
  exit 1
fi
```

#### Test Pyramid Verification

**Expected Distribution:**
```javascript
// count-tests.js
const fs = require('fs');
const path = require('path');

function countTests(dir, type) {
  const files = fs.readdirSync(dir);
  let count = 0;

  files.forEach(file => {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      count += countTests(filePath, type);
    } else if (file.includes(type) && file.endsWith('.test.js')) {
      const content = fs.readFileSync(filePath, 'utf8');
      const matches = content.match(/it\(/g) || [];
      count += matches.length;
    }
  });

  return count;
}

const unit = countTests('./tests', 'unit');
const integration = countTests('./tests', 'integration');
const e2e = countTests('./tests', 'e2e');

const total = unit + integration + e2e;

console.log(`Unit: ${unit} (${Math.round(unit/total*100)}%)`);
console.log(`Integration: ${integration} (${Math.round(integration/total*100)}%)`);
console.log(`E2E: ${e2e} (${Math.round(e2e/total*100)}%)`);

// Validate pyramid
if (unit < total * 0.6) {
  console.error('Test pyramid violated: Too few unit tests');
  process.exit(1);
}
```

#### Testing Checklist

- [ ] Unit tests >= 60% of total tests
- [ ] Integration tests 20-30% of total
- [ ] E2E tests <= 10% of total
- [ ] Overall coverage >= 70%
- [ ] All tests passing
- [ ] No flaky tests (run 3 times to verify)
- [ ] CI pipeline running tests on every commit

### 5. Performance Validation

#### Load Testing (k6, Artillery)

```javascript
// load-test.js (k6)
import http from 'k6/http';
import { check, sleep } from 'k6';

export let options = {
  stages: [
    { duration: '1m', target: 50 },  // Ramp up to 50 users
    { duration: '3m', target: 50 },  // Stay at 50 users
    { duration: '1m', target: 100 }, // Ramp up to 100 users
    { duration: '3m', target: 100 }, // Stay at 100 users
    { duration: '1m', target: 0 },   // Ramp down
  ],
  thresholds: {
    'http_req_duration': ['p(95)<500'], // 95% of requests < 500ms
    'http_req_failed': ['rate<0.01'],   // Error rate < 1%
  },
};

export default function () {
  const res = http.get('https://api.example.com/api/v1/users');

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 500ms': (r) => r.timings.duration < 500,
  });

  sleep(1);
}
```

**Run test:**
```bash
k6 run load-test.js

# Fail if thresholds not met
if [ $? -ne 0 ]; then
  echo "PERFORMANCE VALIDATION FAILED"
  exit 1
fi
```

#### Performance Checklist

- [ ] P95 response time < 500ms under normal load
- [ ] P99 response time < 1s under normal load
- [ ] Error rate < 1% under load
- [ ] System stable under 2x expected load
- [ ] Database queries < 100ms (simple), < 500ms (complex)
- [ ] Memory usage stable (no leaks)
- [ ] CPU usage < 70% under normal load

### 6. Observability Validation

#### Metrics Verification

```bash
# Query Prometheus metrics
curl -s http://localhost:9090/api/v1/query?query=http_requests_total \
  | jq '.data.result[0].value[1]'

# Verify metrics exist
METRICS=$(curl -s http://localhost:3000/metrics)

echo "$METRICS" | grep -q "http_requests_total" || { echo "Missing http_requests_total"; exit 1; }
echo "$METRICS" | grep -q "http_request_duration_seconds" || { echo "Missing http_request_duration_seconds"; exit 1; }
```

#### Observability Checklist

- [ ] Structured JSON logs with correlation IDs
- [ ] Metrics endpoint (/metrics) working
- [ ] Key metrics tracked (requests, duration, errors)
- [ ] Distributed tracing configured
- [ ] Health endpoints (/health/live, /health/ready) working
- [ ] Alerts configured for critical issues
- [ ] Dashboards created in Grafana or equivalent
- [ ] APM tool receiving traces

### 7. Documentation Validation

#### Documentation Checklist

- [ ] **API Documentation:** OpenAPI/Swagger spec complete
- [ ] **Architecture Diagram:** Services, databases, caches
- [ ] **Database Schema:** ERD or schema documentation
- [ ] **Setup Instructions:** How to run locally
- [ ] **Deployment Guide:** How to deploy to production
- [ ] **Environment Variables:** All required env vars documented
- [ ] **Troubleshooting:** Common issues and solutions
- [ ] **Runbook:** How to handle incidents

### 8. Production Readiness

#### Deployment Checklist

- [ ] Environment variables configured
- [ ] Database migrations tested
- [ ] SSL/TLS certificates configured
- [ ] DNS configured
- [ ] Load balancer configured
- [ ] Auto-scaling rules defined
- [ ] Backup strategy defined
- [ ] Disaster recovery plan documented
- [ ] Monitoring alerts tested
- [ ] On-call rotation established

## Validation Gates

### PASS Criteria

All of the following must be true:
- [ ] Security scan: 0 critical/high vulnerabilities
- [ ] Dependencies: 0 critical/high vulnerabilities
- [ ] OWASP Top 10: All 10 categories addressed
- [ ] API contracts: All endpoints match OpenAPI spec
- [ ] Database: Schema validated, indexes present
- [ ] Test coverage: >= 70% overall
- [ ] Test pyramid: Unit >= 60%, Integration 20-30%, E2E <= 10%
- [ ] Performance: P95 < 500ms, error rate < 1%
- [ ] Observability: Logs, metrics, traces, health checks working
- [ ] Documentation: API docs, setup guide, runbook complete

### FAIL Criteria (Triggers Remediation)

If **ANY** of the following are true:
- Critical or high security vulnerabilities found (OWASP ZAP)
- Critical or high dependency vulnerabilities
- OWASP Top 10 category not addressed
- Test coverage < 70%
- P95 response time > 1s under normal load
- Error rate > 5% under load
- Missing authentication on protected routes
- SQL injection vulnerability detected

**Remediation:** Loop back to Phase 3 (Authentication & Security) to fix issues (max 2 iterations)

## Output Expectations

The VALIDATION agent should produce:

1. **Validation Report:** PASS/FAIL status for all categories
2. **Security Scan Results:** OWASP ZAP report, dependency audit
3. **Performance Report:** Load test results, P95/P99 metrics
4. **Coverage Report:** Test coverage summary
5. **Remediation Plan:** If FAIL, list of issues and recommended fixes
6. **Production Readiness Checklist:** All items verified

## Completion Signal

Upon successful validation:
- All gates verified
- Security scan passed
- Performance benchmarks met
- Documentation complete

**Signal:** `DEVELOP_BACKEND_COMPLETE`

Upon failure requiring remediation:
- Document specific failures
- Return to Phase 3 (Authentication & Security)
- Increment remediation counter (max 2)

## Next Steps

After validation passes, the backend system is production-ready:
- Deploy to staging for final QA
- Deploy to production with monitoring
- Enable alerting
- Conduct post-deployment verification
