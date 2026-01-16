# Phase 2: Database Architecture

**Agent:** orchestrate-synthesis
**Type:** LINEAR

## Objective

Design database schema, indexing strategy, migration approach, and data integrity rules aligned with Phase 1 API contracts.

## Key Design Areas

### 1. Schema Design

#### Relational Databases (PostgreSQL, MySQL)

**Table Structure:**
```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL  -- Soft delete
);

CREATE TABLE posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(500) NOT NULL,
    content TEXT,
    status VARCHAR(20) DEFAULT 'draft',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_posts_user_id ON posts(user_id);
CREATE INDEX idx_posts_status ON posts(status);
CREATE INDEX idx_posts_created_at ON posts(created_at DESC);
```

**Naming Conventions:**
- Tables: Plural nouns (`users`, `posts`)
- Columns: Snake_case (`created_at`, `user_id`)
- Foreign Keys: `{table}_id` pattern
- Indexes: `idx_{table}_{columns}` pattern

#### NoSQL Databases (MongoDB, DynamoDB)

**Document Structure (MongoDB):**
```javascript
{
  "_id": ObjectId("..."),
  "email": "user@example.com",
  "password_hash": "...",
  "profile": {
    "name": "John Doe",
    "bio": "..."
  },
  "posts": [
    { "id": "...", "title": "...", "created_at": ISODate("...") }
  ],
  "created_at": ISODate("..."),
  "updated_at": ISODate("...")
}
```

**Key-Value Structure (DynamoDB):**
```
Partition Key: user_id
Sort Key: created_at
Attributes: { email, password_hash, profile, ... }
```

### 2. Indexing Strategy

**Index Types:**
- **Primary Index:** Unique identifier (id)
- **Unique Index:** Email, username (unique constraints)
- **Foreign Key Index:** user_id, post_id (JOIN optimization)
- **Composite Index:** (status, created_at) for filtered sorting
- **Full-Text Index:** Search on title, content fields

**Index Trade-offs:**
- **Read Performance:** Indexes speed up SELECT queries
- **Write Performance:** Each index slows INSERT/UPDATE
- **Storage Cost:** Indexes consume disk space

**Best Practices:**
- Index foreign keys used in JOINs
- Index columns in WHERE, ORDER BY, GROUP BY clauses
- Use composite indexes for multi-column queries
- Monitor query performance and add indexes based on actual usage
- Avoid over-indexing (diminishing returns)

### 3. Migration Approach

**Version-Controlled Migrations:**

**Tools:**
- **Node.js:** Knex.js, Sequelize, TypeORM, Prisma Migrate
- **Python:** Alembic, Django Migrations, SQLAlchemy
- **Go:** golang-migrate, goose
- **Java:** Flyway, Liquibase

**Migration File Example (Knex.js):**
```javascript
// migrations/20240101_create_users_table.js
exports.up = function(knex) {
  return knex.schema.createTable('users', function(table) {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('email', 255).unique().notNullable();
    table.string('password_hash', 255).notNullable();
    table.timestamps(true, true);
  });
};

exports.down = function(knex) {
  return knex.schema.dropTable('users');
};
```

**Best Practices:**
- **Forward and Backward:** Always provide `up` and `down` migrations
- **Idempotent:** Migrations should be safe to run multiple times
- **Data Migrations:** Separate from schema migrations
- **Testing:** Test migrations in staging before production
- **Rollback Plan:** Ensure `down` migrations work

### 4. Data Integrity

**Constraints:**
- **NOT NULL:** Required fields
- **UNIQUE:** Email, username
- **CHECK:** Status in ('draft', 'published', 'archived')
- **FOREIGN KEY:** Referential integrity with CASCADE/RESTRICT

**Example:**
```sql
CREATE TABLE posts (
    id UUID PRIMARY KEY,
    status VARCHAR(20) CHECK (status IN ('draft', 'published', 'archived')),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
```

**Data Validation Layers:**
1. **Database Constraints:** Last line of defense
2. **ORM Validation:** Application-level before DB write
3. **API Validation:** Input validation before business logic

### 5. Soft Delete Pattern

**Instead of hard deletes:**
```sql
ALTER TABLE users ADD COLUMN deleted_at TIMESTAMP NULL;

-- Query only active records
SELECT * FROM users WHERE deleted_at IS NULL;

-- Soft delete
UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = '...';
```

**Benefits:**
- Data recovery possible
- Audit trail maintained
- Referential integrity preserved

### 6. Timestamps and Auditing

**Standard Columns:**
```sql
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
deleted_at TIMESTAMP NULL,
created_by UUID REFERENCES users(id),
updated_by UUID REFERENCES users(id)
```

**Audit Logging:**
- Track who created/updated records
- Log changes for compliance (GDPR, HIPAA)
- Use triggers or application-level audit logs

### 7. Connection Pooling

**Configuration:**
```javascript
// Node.js example (pg)
const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  user: 'dbuser',
  password: 'dbpass',
  max: 20,           // Max connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
```

**Best Practices:**
- Set max pool size based on database limits and app concurrency
- Use connection pooling (not new connection per request)
- Monitor connection usage and idle time
- Handle connection errors gracefully

### 8. Data Seeding

**Test Data:**
```javascript
// seeds/dev/01_users.js
exports.seed = function(knex) {
  return knex('users').del()
    .then(function () {
      return knex('users').insert([
        { email: 'admin@example.com', password_hash: '...' },
        { email: 'user@example.com', password_hash: '...' }
      ]);
    });
};
```

**Environments:**
- **Development:** Rich test data
- **Staging:** Production-like data (anonymized)
- **Production:** Minimal seeds (admin user only)

## Design Checklist

- [ ] **Schema Documented:** All tables/collections with columns/fields
- [ ] **Primary Keys:** UUID or auto-increment chosen consistently
- [ ] **Foreign Keys:** Relationships defined with CASCADE/RESTRICT
- [ ] **Indexes Defined:** Primary, unique, foreign key, composite indexes
- [ ] **Constraints Added:** NOT NULL, UNIQUE, CHECK constraints
- [ ] **Soft Delete:** Pattern implemented for user-facing data
- [ ] **Timestamps:** created_at, updated_at on all tables
- [ ] **Migration Files:** Initial schema migrations created
- [ ] **Seed Data:** Development seeds for testing

## Gate Criteria

Before advancing to Phase 3 (Authentication & Security), ensure:

- [ ] **Database schema documented:** All tables/collections with types
- [ ] **Indexing strategy defined:** Indexes for queries, JOINs, sorts
- [ ] **Migration approach established:** Tool selected, initial migrations created
- [ ] **Data validation rules specified:** Constraints, checks, foreign keys
- [ ] **Connection pooling configured:** Pool size, timeouts set
- [ ] **Audit trail plan:** Timestamps, soft delete, created_by/updated_by

## Output Expectations

The SYNTHESIS agent should produce:

1. **Schema Diagram:** ERD (Entity-Relationship Diagram) or document structure
2. **Migration Files:** Initial schema creation migrations
3. **Index Documentation:** List of indexes with rationale
4. **Constraint Catalog:** All constraints with descriptions
5. **Seed Scripts:** Development test data
6. **ORM Configuration:** Database connection settings

## Next Phase

Upon gate verification, advance to **Phase 3: Authentication & Security** where the GENERATION agent will implement authentication mechanisms and security patterns.
