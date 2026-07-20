# Insecure Direct Object Reference Reference Catalog

> **Search shortcuts:** `grep "^## Sources"` | `grep "^## Sinks"` | `grep "^## Detection"`

---

## Table of Contents
- [Sources](#sources) — User-controllable input patterns
- [Sinks](#sinks) — Execution/exploitation points
- [Detection Heuristics](#detection-heuristics) — Pattern matching and grep patterns
- [Payloads](#payloads) — Test payloads and exploit conditions
- [False Positives](#false-positives) — Common misidentified patterns

---

## Sources

| Source | Pattern |
|--------|--------|
| `/api/users/{id}` | User-controllable input |
| `/orders/{id}` | User-controllable input |
| `req.params.id` | User-controllable input |

## Sinks

| Sink | Risk |
|------|------|
| `MissingWHEREuser_id=?` | High |
| `Noownershipcheckinquery` | High |

## Detection Heuristics

### Grep Patterns
```bash
# Object reference patterns in requests / JS
grep -nE "/api/.*/[0-9]+|/api/.*/\$\{|/users/\$\{|/orders/\$\{|fetch\(.*\$\{|axios\.get\(.*\$\{|id\s*:|userId:|orderId:|accountId:" {file}
# Route/param handlers that read the object id
grep -nE "req\.params\.|req\.query\.|\$route\.params|useParams\(|:id|:userId|:orderId" {file}
```

- **Predictable/enumerable IDs raise severity:** sequential numerics (`/users/1,2,3`), v1
  UUIDs (timestamp + MAC — not random), reversible "hashes" (MD5 of email, base64 of
  username), and enumerable slugs.
- **Ownership check is the pivot:** `SELECT ... WHERE id = ?` is vulnerable;
  `... WHERE id = ? AND user_id = ?` is safe. Absence of the session-scoped predicate = finding.

## Payloads

- **REST IDOR** — increment/replace the object id with another user's value and compare
  responses (`/api/orders/1001` → `/api/orders/1002`).
- **GraphQL IDOR** — `query { user(id: 123) { email creditCard } }` is vulnerable unless the
  resolver enforces `context.user.id === args.id`.

## False Positives

| Pattern | Why FP | Verification |
|---------|--------|-------------|
| Ownership check present (`WHERE user_id = ?`) | Query is session-scoped | Confirm the user id is bound from the session, not attacker-supplied |
| ID is a non-enumerable random token (`crypto.randomUUID()`) | Not guessable/enumerable | Verify it's a v4 UUID, not v1/sequential |
| Endpoint is intentionally public (public profile, shared resource) | No authorization expected | Confirm no sensitive fields are returned |

