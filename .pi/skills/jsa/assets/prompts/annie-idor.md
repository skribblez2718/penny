# IDOR — Worker Analysis Prompt

> **Reference Catalog:** `assets/references/idor.md` — use `grep`/`read` to search, not full-file reads.



## Lane (Phase D)

**Lane:** `network_behavior`
**Packet type:** page_card with Caido HTTP history (request/response, headers)
**Tools to use:**
- **Caido tools** (caido_search, caido_request) for HTTP request/response capture
- **playwright_route** for request interception/modification
- **html_parser** (scripts/html_parser.py) for header inspection

This declaration tells INVESTIGATE phase how to route and packetize work items
for this analyzer. See `resources/reference.md` for lane semantics.

## Reference Catalog Usage
Before and during analysis, consult the reference catalog for patterns:
- `grep("^## Sources", "assets/references/idor.md")` — input patterns
- `grep("^## Sinks", "assets/references/idor.md")` — execution sinks
- `grep("^## Payloads", "assets/references/idor.md")` — test payloads
- `grep("^## Detection", "assets/references/idor.md")` — grep patterns for triage
- `grep("^## False Positives", "assets/references/idor.md")` — common FP patterns
- `read("assets/references/idor.md", limit=30)` then `read(..., offset=N)` for specific sections


## Mission

Find Insecure Direct Object References: API endpoints where object IDs can be manipulated to access unauthorized resources.

## Workflow

### 1. Find Object Reference Patterns
```bash
grep -nE "/api/.*/[0-9]+|/api/.*/\$\{|/users/\$\{|/orders/\$\{|fetch\(.*\$\{|axios\.get\(.*\$\{|id\s*:|userId:|orderId:|accountId:" {file}
```

### 2. Identify Predictable References
- Sequential numeric IDs (`/users/1`, `/users/2`, `/users/3`)
- Predictable UUIDs (v1 UUIDs based on timestamp+MAC)
- Hashed IDs that can be reversed (MD5 of email, base64 of username)
- Slug-based references that can be enumerated

### 3. Check Authorization
Does the code check that the current user OWNS the referenced object?
```javascript
// VULNERABLE — no ownership check
app.get('/api/orders/:id', (req, res) => {
  db.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
});

// SAFE — ownership check
app.get('/api/orders/:id', (req, res) => {
  db.query('SELECT * FROM orders WHERE id = ? AND user_id = ?', 
    [req.params.id, req.session.userId]);
});
```

### 4. GraphQL IDOR
Check if GraphQL resolvers enforce ownership:
```graphql
query { user(id: 123) { email creditCard } }
```
If the resolver doesn't check `context.user.id === args.id`, any user's data is accessible.

### Key Detection
```bash
grep -nE "req\.params\.|req\.query\.|\$route\.params|useParams\(|:id|:userId|:orderId" {file}
```

### False Positives
- [ ] Ownership check present (query includes `WHERE user_id = ?`)
- [ ] Object ID is a non-enumerable random token (crypto.randomUUID())
- [ ] Endpoint is intentionally public (public profile, shared resource)
