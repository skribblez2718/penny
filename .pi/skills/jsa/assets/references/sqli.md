# SQL / NoSQL Injection Reference Catalog

> **Search shortcuts:** `grep "^## Sinks"` | `grep "^## ORM"` | `grep "^## Payloads"` | `grep "^## Detection"`

---

## Table of Contents
- [SQL Injection Sinks](#sql-injection-sinks) — Raw query sinks by library
- [ORM Injection Patterns](#orm-injection-patterns) — Sequelize, Knex, TypeORM, Prisma, Drizzle
- [NoSQL Injection Patterns](#nosql-injection-patterns) — MongoDB, DynamoDB, Redis
- [Payloads](#payloads) — Test payloads for SQL and NoSQL
- [Detection Heuristics](#detection-heuristics) — Pattern matching guidance
- [False Positives](#false-positives) — Parameterized queries, ORM safe patterns
- [Framework Notes](#framework-notes) — Express, Next.js, NestJS specifics

---

## SQL Injection Sinks

### Raw Query Execution

| Library | Sink Pattern | Example |
|---------|-------------|---------|
| mysql/mysql2 | `connection.query(sql, callback)` | `connection.query('SELECT * FROM users WHERE id=' + req.params.id)` |
| mysql2 | `connection.execute(sql, params)` unsafe if `sql` contains interpolation | `connection.execute(`SELECT * FROM users WHERE name='${name}'`)` |
| pg (node-postgres) | `client.query(sql)` | `client.query('SELECT * FROM users WHERE email=\'' + email + '\'')` |
| sqlite3 | `db.run(sql)`, `db.all(sql)`, `db.get(sql)` | `db.all('SELECT * FROM notes WHERE user=' + userId)` |
| mssql | `request.query(sql)` | `request.query('SELECT * FROM users WHERE id=' + input)` |
| oracledb | `connection.execute(sql)` | `connection.execute('SELECT * FROM users WHERE name=\'' + name + '\'')` |

### String Building Patterns (Red Flags)

| Pattern | Detection |
|---------|-----------|
| String concatenation | `'SELECT * FROM ' + table + ' WHERE id=' + id` |
| Template literals | `` `SELECT * FROM users WHERE id=${id}` `` |
| String format | `util.format('SELECT * FROM %s WHERE id=%s', table, id)` |
| Array join | `['SELECT * FROM', table, 'WHERE id=', id].join(' ')` |

---

## ORM Injection Patterns

### Sequelize
| Pattern | Risk | Example |
|---------|------|---------|
| `sequelize.query(sql)` | 🔴 Raw query — same as native driver | `sequelize.query('SELECT * FROM users WHERE name=\'' + name + '\'')` |
| `sequelize.query(sql, { replacements })` | 🟢 Safe if `replacements` used | `sequelize.query('SELECT * FROM users WHERE name=?', {replacements: [name]})` |
| `Model.findAll({ where: { [Op.lt]: userInput } })` | 🟡 Operator injection possible | `{ where: { id: { [userInput]: 1 } } }` → `{ where: { id: { $gte: 1 } } }` |
| `Model.findAll({ where: JSON.parse(userInput) })` | 🔴 Full query object injection | Never deserialize user input into query objects |

### Knex
| Pattern | Risk | Example |
|---------|------|---------|
| `knex.raw(sql)` | 🔴 Raw SQL | `knex.raw('SELECT * FROM users WHERE id=' + id)` |
| `knex.raw(sql, bindings)` | 🟢 Safe with bindings | `knex.raw('SELECT * FROM users WHERE id=?', [id])` |
| `knex('users').whereRaw('id=' + id)` | 🔴 `whereRaw` with concatenation | Use `knex('users').where('id', id)` instead |
| `knex('users').orderByRaw('id ' + direction)` | 🔴 `orderByRaw` injection | Always validate direction against `['ASC', 'DESC']` |

### TypeORM
| Pattern | Risk | Example |
|---------|------|---------|
| `repository.query(sql)` | 🔴 Raw query | `repository.query('SELECT * FROM users WHERE id=' + id)` |
| `repository.createQueryBuilder().where('id=' + id)` | 🔴 Concatenation in `.where()` | Use `.where('id = :id', { id })` |
| `manager.query(sql)` | 🔴 Raw query via entity manager | Same as `repository.query` |

### Prisma
| Pattern | Risk | Example |
|---------|------|---------|
| `prisma.$queryRawUnsafe(sql)` | 🔴 Explicitly unsafe raw query | `prisma.$queryRawUnsafe('SELECT * FROM users WHERE id=' + id)` |
| `prisma.$executeRawUnsafe(sql)` | 🔴 Explicitly unsafe raw execute | Same pattern |
| `prisma.$queryRaw\`...\`` | 🟡 Template literal — safe if no interpolation | `prisma.$queryRaw\`SELECT * FROM users WHERE id=${id}\`` → NOT SAFE |

### Drizzle
| Pattern | Risk | Example |
|---------|------|---------|
| `db.run(sql\`...\`)` with interpolation | 🟡 Template literal injection | `db.run(sql\`SELECT * FROM users WHERE id=${id}\`)` → NOT SAFE |
| `db.select().from(users).where(eq(users.id, id))` | 🟢 Query builder — safe | Always use the query builder API |

---

## NoSQL Injection Patterns

### MongoDB
| Pattern | Risk | Example |
|---------|------|---------|
| `$where` operator | 🔴 JS expression injection | `collection.find({ $where: 'this.name == "' + name + '"' })` |
| `$ne` / `$gt` / `$lt` object injection | 🔴 Query operator injection | `{ username: { $ne: null } }` → bypasses auth |
| `$regex` injection | 🟡 ReDoS + data exfiltration | `{ name: { $regex: userInput } }` |
| `$func` (MongoDB < 4.4) | 🔴 JS execution via aggregation | `{ $func: { body: userInput, args: [], lang: 'js' } }` |
| `$where` with `function()` | 🔴 Full JS execution | `{ $where: 'function() { ' + userInput + ' }' }` |
| `JSON.parse(userInput)` in query objects | 🔴 Full object injection | Never parse user input as query objects |

### DynamoDB
| Pattern | Risk | Example |
|---------|------|---------|
| `FilterExpression` injection | 🟡 Query manipulation | `FilterExpression: 'contains(name, ' + userInput + ')'` |
| `KeyConditionExpression` injection | 🟡 Key bypass | String building in condition expressions |

---

## Payloads

### SQL Injection Probes
```sql
-- Basic probes
' OR '1'='1
' OR '1'='1' --
' OR 1=1 #
admin'--
' UNION SELECT NULL--
' UNION SELECT 1,2,3--
' UNION SELECT username,password FROM users--

-- Time-based blind
' OR SLEEP(5)--
' OR pg_sleep(5)--
'; WAITFOR DELAY '0:0:5'--

-- Error-based
' AND extractvalue(1,concat(0x7e,version()))--
' AND 1=CAST(@@version AS int)--
```

### NoSQL Injection Probes
```javascript
// MongoDB operator injection
{"username": {"$ne": null}}
{"username": {"$gt": ""}}
{"$where": "1==1"}

// MongoDB auth bypass
{"username": "admin", "password": {"$ne": ""}}

// Regex extraction
{"username": {"$regex": "^a"}}
{"username": {"$regex": "^b"}}
```

---

## Detection Heuristics

### Grep Patterns
```bash
# Raw SQL sinks
grep -nE '\.query\(|\.execute\(|\.raw\(|\.all\(|\.get\(|\.run\(|queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe' file.js

# String concatenation in queries
grep -nE "SELECT.*\+|SELECT.*\$\{|INSERT.*\+|UPDATE.*\+|DELETE.*\+" file.js

# ORM raw methods
grep -nE 'sequelize\.query|knex\.raw|\.whereRaw|\.orderByRaw|\.queryRawUnsafe|sql\`.*\$\{' file.js

# NoSQL operators
grep -nE '\$\b(where|ne|gt|lt|regex|func|nin|exists|type|mod|elemMatch|all|size)\b' file.js
```

### Multi-Step Chain Detection
1. **Source:** User input → `req.query`, `req.params`, `req.body`, `req.cookies`
2. **Transformation:** Check for sanitization, escaping, parameterization
3. **Sink:** SQL execution function without parameter binding
4. **Red flags:** String concatenation/template literals with user input before query execution

---

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| `db.query('SELECT * FROM users WHERE id=?', [id])` | Parameterized query — safe | Check for placeholder `?` `$1` `:name` |
| `knex('users').where('id', id)` | Query builder — safe | No raw SQL strings |
| `Model.findOne({ where: { id } })` | ORM method — safe | Full ORM abstraction |
| `prisma.user.findUnique({ where: { id } })` | Prisma query — safe | No `$queryRawUnsafe` |
| `JSON.stringify(req.body)` passed to query | Not direct injection if used as data | Check if it's used as data, not query structure |
| `mongoSanitize(req.body)` before `find()` | `express-mongo-sanitize` strips `$` operators | Verify sanitizer is applied |
| Template literal with ONLY hardcoded values | `` sql`SELECT 1` `` | No user input interpolation |

---

## Framework Notes

### Express.js
- Check `req.query`, `req.params`, `req.body`, `req.cookies` reaching SQL sinks
- Common pattern: `const { id } = req.params; db.query('SELECT * FROM users WHERE id=' + id)`
- `express-mongo-sanitize` middleware for NoSQL protection

### Next.js
- API routes: `export async function GET(req) { const { searchParams } = req.nextUrl; ... }`
- Server Components: SQL in `getData()` functions without parameterization
- `unstable_noStore` not relevant — focus on route handlers

### NestJS
- TypeORM repository patterns — check for `.query()` and `.createQueryBuilder().where('id=' + id)`
- Decorator validation doesn't protect against SQLi — `@Param('id') id: string` is still raw
