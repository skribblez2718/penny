# SQLi — Analysis Reference

> **Reference Catalog:** `assets/references/sqli.md` — use `grep`/`read` to search, not full-file reads.



## Lane

**Lane:** `code_static`
**Packet type:** flow_card (with source/sink/sanitizer, ~50-200 lines of code)
**Tools to use:**
- **Joern queries** (when available): scripts/joern_queries/{vuln_class}.sc
- **tree-sitter queries** for source/sink matching
- **semgrep** for pattern validation

This declaration tells INVESTIGATE phase how to route and packetize work items
for this analyzer. See `resources/reference.md` for lane semantics.

## Reference Catalog Usage
Before and during analysis, consult the reference catalog for patterns:
- `grep("^## Sources", "assets/references/sqli.md")` — input patterns
- `grep("^## Sinks", "assets/references/sqli.md")` — execution sinks
- `grep("^## Payloads", "assets/references/sqli.md")` — test payloads
- `grep("^## Detection", "assets/references/sqli.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/sqli.md")` — common FP patterns
- `read("assets/references/sqli.md", limit=30)` then `read(..., offset=N)` for specific sections


## Mission

Find SQL Injection patterns in JavaScript: database queries built from user input without parameterization.

## Workflow

### 1. Find Query Construction
```bash
grep -nE "\.query\(|\.execute\(|\.raw\(|\$queryRaw|\.sql\(|SELECT.*\+|SELECT.*concat|SELECT.*\$\{" {file}
```

### 2. Check for User Input in Queries
**VULNERABLE — string building:**
```javascript
db.query("SELECT * FROM users WHERE name = '" + req.query.name + "'");
db.execute(`SELECT * FROM users WHERE id = ${req.params.id}`);
knex.raw(`SELECT * FROM users WHERE email = '${userInput}'`);
```

**SAFE — parameterized:**
```javascript
db.query("SELECT * FROM users WHERE name = ?", [req.query.name]);
db.execute("SELECT * FROM users WHERE id = $1", [req.params.id]);
knex('users').where('email', userInput);
```

### 3. ORM Injection Patterns
- Sequelize: `sequelize.query(userInput)` — raw query with user input
- Knex: `knex.raw(userInput)` or `knex.raw(`SELECT ${userInput}`)` 
- TypeORM: `getConnection().query(userInput)`
- Prisma: `prisma.$queryRawUnsafe(userInput)` or `prisma.$executeRawUnsafe(userInput)`

### 4. NoSQL Injection
MongoDB with user input in `$where`, `$ne`, `$regex`:
```javascript
collection.find({ $where: userInput });
collection.find({ username: { $ne: '' }, password: { $ne: '' } });  // Auth bypass
collection.find({ $where: `this.username == '${userInput}'` });
```

### Key Detection
```bash
semgrep --config p/javascript --config p/owasp-top-ten --json {file}
```

### False Positives
- [ ] Query uses parameterized placeholders (? or $1/$2)
- [ ] ORM uses safe query builder methods (`.where()`, `.findOne()`)
- [ ] User input goes through `parseInt()` or other type coercion before query
