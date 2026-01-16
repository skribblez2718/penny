# Phase 6: Monitoring & Observability

**Agent:** orchestrate-generation
**Type:** LINEAR

## Objective

Implement structured logging, metrics collection, distributed tracing, alerting, and health checks for production observability.

## Observability Pillars

```
┌────────────────────────────────────────────────────┐
│                 OBSERVABILITY                      │
│                                                    │
│  ┌─────────┐  ┌─────────┐  ┌──────────┐          │
│  │  LOGS   │  │ METRICS │  │  TRACES  │          │
│  │         │  │         │  │          │          │
│  │What     │  │How much │  │Where did │          │
│  │happened │  │happened │  │time go   │          │
│  └─────────┘  └─────────┘  └──────────┘          │
└────────────────────────────────────────────────────┘
```

### 1. Structured Logging

**Purpose:** Queryable, parsable logs for debugging and monitoring

**Libraries:**
- **JavaScript:** Winston, Pino, Bunyan
- **Python:** structlog, python-json-logger
- **Go:** Zap, Logrus
- **Java:** Logback, Log4j2

**Implementation (Pino - Node.js):**
```javascript
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label })
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: ['password', 'password_hash', 'token', 'Authorization']
});

// Usage in application
app.post('/api/v1/auth/login', async (req, res) => {
  const { email, password } = req.body;

  logger.info({ email, endpoint: '/auth/login' }, 'Login attempt');

  try {
    const user = await User.findByEmail(email);

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      logger.warn({ email }, 'Login failed - invalid credentials');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '24h' });

    logger.info({ userId: user.id, email }, 'Login successful');

    res.json({ token });
  } catch (err) {
    logger.error({ err, email }, 'Login error');
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

**Log Levels:**
- **FATAL:** Application crash (process.exit)
- **ERROR:** Handled exception (500 response)
- **WARN:** Unexpected but handled (rate limit exceeded)
- **INFO:** Normal operation (request completed)
- **DEBUG:** Detailed information (dev/staging only)
- **TRACE:** Very detailed (rarely used)

**Best Practices:**
- **JSON Format:** Machine-parsable
- **Correlation IDs:** Track requests across services
- **Redact Secrets:** Never log passwords, tokens
- **Context-Rich:** Include user_id, request_id, endpoint
- **Production Level:** INFO or WARN (not DEBUG)

**Example Log Output:**
```json
{
  "level": "info",
  "time": "2024-01-16T10:30:00.000Z",
  "msg": "Login successful",
  "userId": "user-123",
  "email": "user@example.com",
  "request_id": "req-abc-xyz",
  "duration_ms": 45
}
```

### 2. Metrics Collection

**Purpose:** Time-series data for monitoring trends and alerting

**Types of Metrics:**
- **Counter:** Increments only (requests_total, errors_total)
- **Gauge:** Current value (active_connections, queue_size)
- **Histogram:** Distribution (request_duration, response_size)
- **Summary:** Like histogram but with percentiles

**Implementation (Prometheus + prom-client):**
```javascript
const promClient = require('prom-client');

// Register default metrics (CPU, memory, GC)
promClient.collectDefaultMetrics({ timeout: 5000 });

// Custom metrics
const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status']
});

const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5]
});

const activeUsers = new promClient.Gauge({
  name: 'active_users',
  help: 'Number of currently active users'
});

// Middleware to track metrics
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;

    httpRequestsTotal.inc({
      method: req.method,
      route: req.route?.path || req.path,
      status: res.statusCode
    });

    httpRequestDuration.observe({
      method: req.method,
      route: req.route?.path || req.path
    }, duration);
  });

  next();
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});
```

**Key Metrics to Track:**
- **Requests:** Total, by status code, by endpoint
- **Duration:** P50, P95, P99 response times
- **Errors:** Error rate, error types
- **Database:** Query count, query duration, connection pool usage
- **Cache:** Hit rate, miss rate
- **Queue:** Queue depth, processing rate, failure rate

**Example Metrics Output:**
```
# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",route="/api/v1/users",status="200"} 1543

# HELP http_request_duration_seconds HTTP request duration in seconds
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{method="GET",route="/api/v1/users",le="0.05"} 1200
http_request_duration_seconds_bucket{method="GET",route="/api/v1/users",le="0.1"} 1500
http_request_duration_seconds_sum{method="GET",route="/api/v1/users"} 45.6
http_request_duration_seconds_count{method="GET",route="/api/v1/users"} 1543
```

### 3. Distributed Tracing

**Purpose:** Track requests across multiple services

**Standards:**
- **OpenTelemetry:** Vendor-neutral standard
- **Jaeger:** Open-source distributed tracing
- **Zipkin:** Alternative tracing system

**Implementation (OpenTelemetry):**
```javascript
const opentelemetry = require('@opentelemetry/api');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const { registerInstrumentations } = require('@opentelemetry/instrumentation');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');

// Configure provider
const provider = new NodeTracerProvider();

// Configure exporter
const exporter = new JaegerExporter({
  serviceName: 'backend-api',
  agentHost: 'jaeger-agent',
  agentPort: 6832
});

provider.addSpanProcessor(new opentelemetry.SimpleSpanProcessor(exporter));
provider.register();

// Auto-instrument HTTP and Express
registerInstrumentations({
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation()
  ]
});

// Manual span creation
const tracer = opentelemetry.trace.getTracer('backend-api');

app.post('/api/v1/orders', async (req, res) => {
  const span = tracer.startSpan('create_order');

  try {
    span.setAttribute('user.id', req.user.id);
    span.setAttribute('order.amount', req.body.amount);

    // Business logic
    const order = await createOrder(req.body);

    // Child span for payment
    const paymentSpan = tracer.startSpan('process_payment', { parent: span });
    try {
      await processPayment(order);
      paymentSpan.setStatus({ code: opentelemetry.SpanStatusCode.OK });
    } catch (err) {
      paymentSpan.recordException(err);
      paymentSpan.setStatus({ code: opentelemetry.SpanStatusCode.ERROR });
      throw err;
    } finally {
      paymentSpan.end();
    }

    span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
    res.json({ order });
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: opentelemetry.SpanStatusCode.ERROR });
    res.status(500).json({ error: 'Failed to create order' });
  } finally {
    span.end();
  }
});
```

**Trace Context Propagation:**
```javascript
// Inject trace context into outgoing requests
const axios = require('axios');

async function callDownstreamService(data) {
  const span = tracer.startSpan('call_downstream');

  try {
    const headers = {};
    // Inject trace context
    opentelemetry.propagation.inject(opentelemetry.context.active(), headers);

    const response = await axios.post('https://downstream.example.com/api', data, {
      headers
    });

    return response.data;
  } finally {
    span.end();
  }
}
```

### 4. Health Checks

**Liveness vs Readiness:**
- **Liveness:** Is the app alive? (restart if false)
- **Readiness:** Is the app ready for traffic? (remove from load balancer if false)

**Implementation:**
```javascript
// Liveness probe (simple)
app.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'alive' });
});

// Readiness probe (checks dependencies)
app.get('/health/ready', async (req, res) => {
  const checks = {
    database: 'unknown',
    redis: 'unknown',
    queue: 'unknown'
  };

  let allHealthy = true;

  // Check database
  try {
    await db.query('SELECT 1');
    checks.database = 'healthy';
  } catch (err) {
    checks.database = 'unhealthy';
    allHealthy = false;
  }

  // Check Redis
  try {
    await redis.ping();
    checks.redis = 'healthy';
  } catch (err) {
    checks.redis = 'unhealthy';
    allHealthy = false;
  }

  // Check message queue
  try {
    await queue.isReady();
    checks.queue = 'healthy';
  } catch (err) {
    checks.queue = 'unhealthy';
    allHealthy = false;
  }

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'ready' : 'not_ready',
    checks,
    timestamp: new Date().toISOString()
  });
});
```

**Kubernetes Configuration:**
```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /health/ready
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 5
```

### 5. Alerting

**Alerting Rules (Prometheus):**
```yaml
groups:
  - name: backend_alerts
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.05
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"
          description: "Error rate is {{ $value }} errors/sec"

      - alert: HighResponseTime
        expr: histogram_quantile(0.95, http_request_duration_seconds) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High P95 response time"
          description: "P95 response time is {{ $value }}s"

      - alert: DatabaseDown
        expr: up{job="postgres"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Database is down"
```

**Alert Channels:**
- **PagerDuty:** On-call notifications
- **Slack:** Team notifications
- **Email:** Non-critical alerts
- **OpsGenie:** Incident management

### 6. APM Integration

**Application Performance Monitoring Tools:**
- **DataDog:** Full-stack observability
- **New Relic:** APM and infrastructure monitoring
- **Sentry:** Error tracking and performance
- **Elastic APM:** Part of Elastic Stack

**Example (Sentry):**
```javascript
const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 1.0
});

// Error handler middleware
app.use(Sentry.Handlers.errorHandler());
```

## Implementation Checklist

- [ ] **Structured Logging:** JSON format with correlation IDs
- [ ] **Metrics Endpoint:** /metrics for Prometheus scraping
- [ ] **Key Metrics Tracked:** Requests, duration, errors, database
- [ ] **Distributed Tracing:** OpenTelemetry or Jaeger configured
- [ ] **Health Endpoints:** /health/live and /health/ready
- [ ] **Alerting Rules:** Error rate, response time, dependencies
- [ ] **APM Integration:** Sentry, DataDog, or New Relic
- [ ] **Log Aggregation:** Elasticsearch, CloudWatch, or Loki

## Gate Criteria

Before advancing to Phase 7 (Final Validation), ensure:

- [ ] **Structured logging implemented:** JSON logs with correlation IDs
- [ ] **Metrics collection configured:** Prometheus metrics endpoint
- [ ] **Distributed tracing enabled:** OpenTelemetry or Jaeger
- [ ] **Health check endpoints present:** Liveness and readiness probes
- [ ] **Alerting configured:** Critical alerts for errors and latency
- [ ] **APM tool integrated:** Error tracking and performance monitoring
- [ ] **Dashboards created:** Grafana or equivalent for visualization

## Output Expectations

The GENERATION agent should produce:

1. **Logging Configuration:** Pino/Winston setup with redaction
2. **Metrics Implementation:** Prometheus metrics with custom counters/histograms
3. **Tracing Setup:** OpenTelemetry configuration and instrumentation
4. **Health Check Endpoints:** Liveness and readiness with dependency checks
5. **Alerting Rules:** Prometheus alert definitions
6. **Dashboard Definitions:** Grafana JSON or equivalent
7. **APM Configuration:** Sentry/DataDog integration

## Next Phase

Upon gate verification, advance to **Phase 7: Final Validation** where the VALIDATION agent will verify all components and run security scans.
