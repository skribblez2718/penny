# Phase 4: Architecture & Scalability

**Agent:** orchestrate-synthesis
**Type:** LINEAR

## Objective

Define scaling strategy, caching layers, circuit breaker patterns, service boundaries, and architectural patterns for production resilience.

## Key Design Areas

### 1. Scaling Strategy

#### Vertical Scaling (Scale Up)
- **Approach:** Increase CPU, RAM, disk on single machine
- **Pros:** Simple, no code changes
- **Cons:** Hardware limits, single point of failure
- **When:** Early stage, simple workloads

#### Horizontal Scaling (Scale Out)
- **Approach:** Add more instances behind load balancer
- **Pros:** Unlimited scale, fault tolerance
- **Cons:** Complexity, stateless requirement
- **When:** Production systems, high availability

**Load Balancing:**
- **Round Robin:** Distribute evenly
- **Least Connections:** Send to least busy
- **IP Hash:** Sticky sessions (same client → same server)

**Considerations:**
- **Stateless Services:** No in-memory session storage (use Redis)
- **Database Connection Pooling:** Limit per instance
- **Shared File Storage:** S3, EFS, not local disk

### 2. Caching Layers

#### In-Memory Cache (Redis, Memcached)

**Use Cases:**
- Session storage
- Frequently accessed data
- Rate limiting counters
- Real-time leaderboards

**Example (Redis):**
```javascript
const redis = require('redis');
const client = redis.createClient({
  host: 'redis.example.com',
  port: 6379
});

// Cache-aside pattern
async function getUser(userId) {
  const cacheKey = `user:${userId}`;

  // Check cache first
  const cached = await client.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Cache miss - fetch from database
  const user = await db.users.findById(userId);

  // Store in cache (TTL: 5 minutes)
  await client.setex(cacheKey, 300, JSON.stringify(user));

  return user;
}
```

**Cache Strategies:**
- **Cache-Aside (Lazy Loading):** App checks cache, fetches on miss
- **Write-Through:** Write to cache and DB simultaneously
- **Write-Behind:** Write to cache, async write to DB

**TTL Settings:**
- **Static Data:** 1 hour - 24 hours
- **User Data:** 5 minutes - 1 hour
- **Session Data:** Session lifetime (24 hours)

#### CDN (Content Delivery Network)

**Use Cases:**
- Static assets (images, CSS, JS)
- API responses (if cacheable)
- Geographically distributed users

**Headers:**
```
Cache-Control: public, max-age=31536000  // 1 year for static assets
Cache-Control: private, max-age=300      // 5 minutes for user data
Cache-Control: no-store                   // Never cache
```

### 3. Circuit Breaker Pattern

**Purpose:** Prevent cascading failures when downstream services fail

**States:**
- **CLOSED:** Normal operation, requests pass through
- **OPEN:** Failure threshold exceeded, requests fail fast
- **HALF-OPEN:** Test if service recovered

**Implementation:**
```javascript
class CircuitBreaker {
  constructor(threshold = 5, timeout = 60000) {
    this.failureCount = 0;
    this.threshold = threshold;
    this.timeout = timeout;
    this.state = 'CLOSED';
    this.nextAttempt = Date.now();
  }

  async call(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        throw new Error('Circuit breaker is OPEN');
      }
      this.state = 'HALF_OPEN';
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  onSuccess() {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  onFailure() {
    this.failureCount++;
    if (this.failureCount >= this.threshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.timeout;
    }
  }
}

// Usage
const paymentServiceBreaker = new CircuitBreaker(5, 60000);

app.post('/api/v1/orders', async (req, res) => {
  try {
    const payment = await paymentServiceBreaker.call(() =>
      paymentService.charge(req.body.amount)
    );
    res.json({ success: true, payment });
  } catch (err) {
    res.status(503).json({ error: 'Payment service unavailable' });
  }
});
```

### 4. Service Boundaries

#### Monolith vs Microservices

**Monolith:**
- **Pros:** Simple deployment, shared code, easier debugging
- **Cons:** Tight coupling, single point of failure, scaling all-or-nothing

**Microservices:**
- **Pros:** Independent scaling, tech diversity, fault isolation
- **Cons:** Complexity, distributed debugging, data consistency challenges

**When to Split:**
- Different scaling needs (auth service vs analytics)
- Different teams (ownership boundaries)
- Different deployment cadence

**Service Communication:**
- **Synchronous:** REST, gRPC (request/response)
- **Asynchronous:** Message queues (RabbitMQ, Kafka)
- **Event-Driven:** Pub/sub (SNS, EventBridge)

### 5. Database Scaling

#### Read Replicas

**Pattern:**
- **Primary (Master):** All writes
- **Replicas (Read-only):** Distribute reads

**Configuration:**
```javascript
const primaryDb = new Client({ host: 'primary.db.example.com' });
const replicaDb = new Client({ host: 'replica.db.example.com' });

// Write operation
await primaryDb.query('INSERT INTO users ...');

// Read operation
const users = await replicaDb.query('SELECT * FROM users');
```

**Replication Lag:** Eventual consistency (typically < 1 second)

#### Sharding

**Pattern:** Split data across multiple databases

**Strategies:**
- **Range-Based:** user_id 1-1000 → shard1, 1001-2000 → shard2
- **Hash-Based:** hash(user_id) % num_shards → shard
- **Geographic:** US users → us_shard, EU users → eu_shard

**Challenges:**
- Cross-shard queries difficult
- Rebalancing when adding shards
- Application complexity

### 6. Asynchronous Processing

#### Background Jobs

**Use Cases:**
- Email sending
- Image processing
- Report generation
- Data imports/exports

**Queue-Based (Bull, BullMQ):**
```javascript
const Queue = require('bull');
const emailQueue = new Queue('email', {
  redis: { host: 'redis.example.com', port: 6379 }
});

// Producer (API endpoint)
app.post('/api/v1/users', async (req, res) => {
  const user = await User.create(req.body);

  // Queue welcome email
  await emailQueue.add({ userId: user.id, type: 'welcome' });

  res.status(201).json({ user });
});

// Consumer (background worker)
emailQueue.process(async (job) => {
  const { userId, type } = job.data;
  const user = await User.findById(userId);

  await sendEmail({
    to: user.email,
    subject: 'Welcome!',
    body: '...'
  });
});
```

**Benefits:**
- Offload slow operations
- Retry failed jobs
- Better user experience (fast API responses)

### 7. Rate Limiting & Throttling

**Token Bucket Algorithm:**
```javascript
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Max 100 requests per windowMs
  message: 'Too many requests, please try again later',
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false,
});

app.use('/api/v1/', limiter);

// Per-user rate limiting
const userLimiter = rateLimit({
  keyGenerator: (req) => req.user.id,
  max: 1000,
  windowMs: 60 * 60 * 1000, // 1 hour
});

app.use('/api/v1/users', authenticate, userLimiter);
```

### 8. Health Checks & Graceful Shutdown

**Health Endpoint:**
```javascript
app.get('/health', async (req, res) => {
  const checks = {
    database: false,
    redis: false,
    uptime: process.uptime()
  };

  try {
    await db.query('SELECT 1');
    checks.database = true;
  } catch (err) {
    // Database unhealthy
  }

  try {
    await redis.ping();
    checks.redis = true;
  } catch (err) {
    // Redis unhealthy
  }

  const healthy = checks.database && checks.redis;

  res.status(healthy ? 200 : 503).json(checks);
});
```

**Graceful Shutdown:**
```javascript
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');

  // Stop accepting new requests
  server.close(() => {
    console.log('HTTP server closed');
  });

  // Close database connections
  await db.end();
  await redis.quit();

  process.exit(0);
});
```

## Architecture Checklist

- [ ] **Scaling Strategy:** Vertical or horizontal approach defined
- [ ] **Load Balancing:** Strategy selected (round robin, least connections)
- [ ] **Caching Layers:** Redis/Memcached for hot data, CDN for static
- [ ] **Circuit Breakers:** Implemented for external service calls
- [ ] **Service Boundaries:** Monolith or microservices decision made
- [ ] **Database Scaling:** Read replicas or sharding if needed
- [ ] **Background Jobs:** Queue for async processing
- [ ] **Rate Limiting:** Per-user and per-endpoint limits
- [ ] **Health Checks:** Endpoint for load balancer probes
- [ ] **Graceful Shutdown:** SIGTERM handling

## Gate Criteria

Before advancing to Phase 5 (Testing & Quality), ensure:

- [ ] **Scaling strategy documented:** Horizontal/vertical approach
- [ ] **Caching layers identified:** Redis, CDN, cache-aside pattern
- [ ] **Circuit breaker patterns applied:** For external service calls
- [ ] **Service boundaries defined:** Monolith or microservices decision
- [ ] **Database scaling plan:** Read replicas, sharding, connection pooling
- [ ] **Background job queue:** For async operations
- [ ] **Health checks implemented:** /health endpoint with dependency checks

## Output Expectations

The SYNTHESIS agent should produce:

1. **Architecture Diagram:** Services, databases, caches, queues
2. **Scaling Plan:** Horizontal scaling with load balancer config
3. **Cache Configuration:** Redis TTLs, cache-aside pattern
4. **Circuit Breaker Strategy:** Thresholds, timeouts, fallbacks
5. **Background Job Definitions:** Queue names, job types, workers
6. **Health Check Spec:** Endpoint response format, dependencies

## Next Phase

Upon gate verification, advance to **Phase 5: Testing & Quality** where the GENERATION agent will implement comprehensive test suites.
