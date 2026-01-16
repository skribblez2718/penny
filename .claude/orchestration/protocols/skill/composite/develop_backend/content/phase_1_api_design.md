# Phase 1: API Design

**Agent:** orchestrate-synthesis
**Type:** LINEAR

## Objective

Design API contracts (REST/GraphQL), versioning strategy, rate limiting, pagination, and error handling patterns based on Phase 0 requirements.

## Key Design Areas

### 1. API Contract Design

#### RESTful APIs
- **Resource Modeling:** Identify entities and relationships
- **Endpoint Structure:** `/api/v1/resource/{id}/sub-resource`
- **HTTP Methods:** GET (read), POST (create), PUT/PATCH (update), DELETE (remove)
- **Request/Response Schemas:** JSON structure with validation rules
- **Status Codes:** 200 (OK), 201 (Created), 400 (Bad Request), 401 (Unauthorized), 404 (Not Found), 500 (Server Error)

#### GraphQL APIs
- **Schema Definition:** Types, queries, mutations, subscriptions
- **Resolver Design:** Data fetching and transformation logic
- **N+1 Query Prevention:** DataLoader pattern
- **Introspection:** Schema discovery for clients

#### gRPC APIs
- **Protocol Buffers:** Message and service definitions
- **Service Methods:** Unary, server streaming, client streaming, bidirectional
- **Error Handling:** Status codes and error details

### 2. Versioning Strategy

**Options:**
- **URL Versioning:** `/api/v1/users`, `/api/v2/users`
- **Header Versioning:** `Accept: application/vnd.api+json; version=1`
- **Query Parameter:** `/api/users?version=1`

**Recommendation:** URL versioning for simplicity and clarity

**Deprecation Policy:**
- Announce deprecation 6 months before removal
- Support N-1 versions (current + previous)
- Provide migration guides

### 3. Rate Limiting

**Strategies:**
- **Fixed Window:** 1000 requests per hour
- **Sliding Window:** More accurate but higher complexity
- **Token Bucket:** Burst handling with sustained rate

**Implementation:**
- **Headers:** `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- **Response:** 429 Too Many Requests with `Retry-After` header
- **Tiers:** Different limits for authenticated vs anonymous, free vs paid

**Example:**
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 847
X-RateLimit-Reset: 1610000000
```

### 4. Pagination

**Offset-based:**
```
GET /api/v1/users?limit=20&offset=40
Response: { "items": [...], "total": 1234, "limit": 20, "offset": 40 }
```

**Cursor-based:** (Better for large datasets)
```
GET /api/v1/users?limit=20&cursor=eyJpZCI6MTIzfQ
Response: { "items": [...], "next_cursor": "eyJpZCI6MTQzfQ", "has_more": true }
```

### 5. Error Handling Patterns

**Standard Error Response:**
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input data",
    "details": [
      { "field": "email", "issue": "Invalid email format" }
    ],
    "request_id": "req_abc123xyz"
  }
}
```

**Error Categories:**
- **Client Errors (4xx):** Validation, authentication, authorization, not found
- **Server Errors (5xx):** Internal error, service unavailable, timeout

**Best Practices:**
- Include `request_id` for debugging
- Don't expose stack traces in production
- Use error codes for programmatic handling
- Provide actionable error messages

### 6. Request/Response Standards

**Content Negotiation:**
- `Content-Type: application/json` (primary)
- `Accept: application/json`
- Support compression: `Accept-Encoding: gzip`

**Common Headers:**
- `Authorization: Bearer {token}`
- `X-Request-ID: {uuid}` (for tracing)
- `X-Correlation-ID: {uuid}` (for distributed tracing)

**Response Envelope:** (Optional, decide based on requirements)
```json
{
  "data": { ... },
  "meta": { "request_id": "...", "timestamp": "..." }
}
```

### 7. CORS Configuration

**Headers:**
```
Access-Control-Allow-Origin: https://example.com
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
```

**Considerations:**
- Use specific origins in production (not `*`)
- Handle preflight OPTIONS requests
- Credentials handling: `Access-Control-Allow-Credentials: true`

## Design Checklist

- [ ] **Endpoints Defined:** All resources with CRUD operations documented
- [ ] **Schemas Validated:** Request/response JSON schemas with validation rules
- [ ] **Versioning Strategy:** Approach selected and documented
- [ ] **Rate Limiting:** Strategy defined with headers and tiers
- [ ] **Pagination:** Approach selected (offset or cursor)
- [ ] **Error Handling:** Standard error format with codes
- [ ] **CORS Policy:** Origins, methods, headers configured
- [ ] **Documentation:** OpenAPI/Swagger spec generated

## OpenAPI/Swagger Example

```yaml
openapi: 3.0.0
info:
  title: Backend API
  version: 1.0.0
paths:
  /api/v1/users:
    get:
      summary: List users
      parameters:
        - name: limit
          in: query
          schema:
            type: integer
            default: 20
      responses:
        '200':
          description: Success
          content:
            application/json:
              schema:
                type: object
                properties:
                  items:
                    type: array
                    items:
                      $ref: '#/components/schemas/User'
components:
  schemas:
    User:
      type: object
      properties:
        id:
          type: string
        email:
          type: string
```

## Gate Criteria

Before advancing to Phase 2 (Database Architecture), ensure:

- [ ] **API endpoints defined:** All resources with HTTP methods/GraphQL types
- [ ] **Versioning strategy established:** URL, header, or query parameter approach
- [ ] **Rate limiting rules specified:** Strategy, tiers, headers
- [ ] **Error handling patterns defined:** Standard error format with codes
- [ ] **Pagination approach selected:** Offset-based or cursor-based
- [ ] **CORS policy configured:** Origins, methods, credentials
- [ ] **OpenAPI/Swagger spec:** Documentation generated

## Output Expectations

The SYNTHESIS agent should produce:

1. **API Specification:** OpenAPI/Swagger YAML or GraphQL schema
2. **Endpoint Inventory:** List of all endpoints with methods, schemas
3. **Versioning Policy:** Documentation of approach and deprecation timeline
4. **Rate Limiting Configuration:** Strategy, tiers, headers
5. **Error Catalog:** Standard error codes and messages
6. **Client SDK Considerations:** Notes for frontend/mobile client integration

## Next Phase

Upon gate verification, advance to **Phase 2: Database Architecture** where the SYNTHESIS agent will design database schemas aligned with API contracts.
