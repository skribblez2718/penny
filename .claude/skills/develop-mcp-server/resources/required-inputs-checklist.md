# Required Inputs Checklist

## Purpose

This document defines the 6 required inputs that MUST be validated before MCP server generation can proceed. These inputs are blocking requirements enforced by the validation gate.

## Blocking Requirements

### 1. Service/Tool Name

**Status:** REQUIRED (Blocking)

**Definition:** The name of the MCP server being created

**Validation Criteria:**
- Must be valid Python module name (alphanumeric + underscores only)
- No spaces, hyphens become underscores
- Cannot start with a number
- Cannot be Python reserved keyword (if, for, class, def, etc.)
- Recommended: lowercase with underscores (snake_case)

**Used For:**
- Python module naming
- Systemd service name (mcp-{service_name})
- Package name in pyproject.toml
- Directory structure naming

**Examples:**
- ✅ Valid: "github_mcp", "file_search", "weather_service", "slack_api"
- ❌ Invalid: "github-mcp" (hyphen), "2fast" (starts with number), "my service" (space), "class" (reserved keyword)

**If Missing/Invalid:**
BLOCK with message: "Service name must be a valid Python module name (alphanumeric + underscores, cannot start with number)"

---

### 2. API Documentation

**Status:** CONDITIONALLY REQUIRED (Critical Blocker if API used)

**Definition:** URL to comprehensive API documentation or explicit "N/A" if no external API

**Validation Criteria:**
- If any feature requires external API calls: MUST provide one of:
  * OpenAPI/Swagger specification URL
  * Comprehensive API documentation URL
  * API reference documentation URL
  * Postman collection URL
- If NO external API needed: Must explicitly confirm "N/A" or "no external API"
- Cannot proceed with vague "I'll use X API" without documentation URL

**Used For:**
- Generating accurate request/response models (pydantic)
- Creating realistic test fixtures that match actual API responses
- Implementing correct error handling for API-specific status codes
- Ensuring proper API endpoint usage
- Documenting API rate limits and authentication requirements

**Examples:**
- ✅ Valid: "https://docs.github.com/en/rest", "https://api.slack.com/docs", "N/A - file based only"
- ❌ Invalid: "GitHub API", "Slack", "some weather API", "" (empty)

**If Missing When API Needed:**
BLOCK with message: "CRITICAL: API documentation required for external API integration. Cannot generate realistic tests or correct API implementation without documentation URL. Please provide: [OpenAPI spec URL | API reference docs | Postman collection]"

**Why This Is Critical:**
- Test fixtures must match real API responses for >80% coverage
- Error handling must account for API-specific error codes
- Request/response models need accurate field types and constraints
- Without docs, generated code will be guesswork and likely fail in production

---

### 3. Required Features

**Status:** REQUIRED (Blocking)

**Definition:** List of specific features/tools the MCP server must implement

**Validation Criteria:**
- Must be concrete, actionable feature descriptions
- Each feature should map to one or more MCP tools
- Cannot be vague like "search stuff" or "do things"
- Should include brief description of what each feature does
- Minimum: 1 feature, typical: 2-5 features

**Used For:**
- Determining number of tool modules to generate
- Planning service layer structure
- Designing test coverage
- Documenting tool capabilities in README

**Examples:**
- ✅ Valid:
  * "search_repositories: Search GitHub repos by keyword"
  * "get_repository_details: Fetch detailed info for a specific repo"
  * "list_user_repos: List all repositories for a given user"
- ❌ Invalid:
  * "GitHub stuff"
  * "work with repos"
  * "search" (too vague)

**If Missing/Unclear:**
BLOCK with message: "Required features must be specific and implementable. Please list each feature with format: 'feature_name: description'. Example: 'search_files: Search text files by keyword'"

---

### 4. Authentication

**Status:** REQUIRED (Blocking)

**Definition:** Authentication type and implementation details

**Validation Criteria:**
Must specify ONE of the following with details:

**API Keys:**
- Specify header name (e.g., "X-API-Key", "Authorization")
- Specify format (e.g., "Bearer {key}", "ApiKey {key}", "{key}" directly)
- Example: "API key in Authorization header as 'Bearer {key}'"

**OAuth 2.0:**
- Specify provider (GitHub, Google, custom)
- Specify required scopes
- Specify redirect URI requirements (if applicable)
- Example: "OAuth 2.0 with GitHub, scopes: repo, user:email"

**Bearer Token:**
- Specify token acquisition method
- Specify header format
- Example: "Bearer token in Authorization header, user provides token"

**None:**
- Explicit "None" or "No authentication"
- Only valid for file-based or local-only servers

**Used For:**
- Generating authentication flow in API client
- Configuring environment variables in .env.example
- Creating authentication utilities
- Documenting token/key acquisition in README

**Examples:**
- ✅ Valid:
  * "API key in X-API-Key header"
  * "OAuth 2.0, GitHub provider, scopes: repo, read:user"
  * "Bearer token in Authorization header"
  * "None - file-based server"
- ❌ Invalid:
  * "API key" (missing header/format details)
  * "OAuth" (missing provider/scopes)
  * "Yes" (too vague)

**If Missing/Insufficient:**
BLOCK with message: "Authentication details insufficient. Please specify: [API key with header name | OAuth 2.0 with provider and scopes | Bearer token with acquisition method | None]"

---

### 5. Data Sources

**Status:** REQUIRED (Blocking)

**Definition:** All external data dependencies the MCP server will use

**Validation Criteria:**
Must list all data sources with details:

**Files:**
- Specify file formats (JSON, CSV, TXT, etc.)
- Specify expected locations (user-provided paths, fixed directory)
- Example: "JSON configuration files in user-specified directory"

**Databases:**
- Specify database type (PostgreSQL, SQLite, MongoDB, etc.)
- Specify schema requirements (if known) or note as dynamic
- Specify connection approach (connection string, file path)
- Example: "SQLite database with schema: users, posts, comments tables"

**APIs:**
- Specify API name and base URL
- Cross-reference with API Documentation requirement
- Example: "GitHub REST API v3 (see API docs above)"

**Other:**
- Specify source type (system commands, sensors, etc.)
- Provide relevant details
- Example: "Local file system via os.listdir and file I/O"

**Used For:**
- Planning service layer dependencies
- Determining required Python libraries
- Designing data access patterns
- Configuring environment variables

**Examples:**
- ✅ Valid:
  * "GitHub REST API at https://api.github.com"
  * "Local SQLite database with user-defined schema"
  * "CSV files in directory specified by user"
  * "Local file system (no external dependencies)"
- ❌ Invalid:
  * "files" (which formats? where?)
  * "database" (which type? schema?)
  * "API" (which one?)

**If Missing/Unclear:**
BLOCK with message: "Data sources must be specified with details. For files: formats and locations. For databases: type and schema. For APIs: name and URL (with API docs)."

---

### 6. MCP Client

**Status:** REQUIRED (Blocking)

**Definition:** Target MCP client application for documentation

**Validation Criteria:**
Must specify ONE of:
- Claude Desktop
- Cursor
- Windsurf
- fast-agent
- Other (with name)

Cannot be vague like "any" or "whatever"

**Used For:**
- Generating client-specific configuration examples in README
- Tailoring installation instructions
- Creating appropriate troubleshooting guides
- Documenting client-specific setup paths and file formats

**Examples:**
- ✅ Valid: "Claude Desktop", "Cursor", "Windsurf", "fast-agent", "Cline"
- ❌ Invalid: "any", "doesn't matter", "IDE", "" (empty)

**If Missing:**
ASK (non-blocking, can default to "Claude Desktop" if user doesn't respond): "Which MCP client will you use? (Claude Desktop, Cursor, Windsurf, fast-agent, or other)"

**Configuration Differences:**

**Claude Desktop:**
- Config file: `claude_desktop_config.json`
- Location: Platform-specific (macOS: ~/Library/Application Support/Claude/)
- Format: JSON with mcpServers object

**Cursor:**
- Config: Settings UI or config file
- Format: Similar to Claude Desktop JSON

**Windsurf:**
- Config file: `config.json`
- Location: ~/.windsurf/
- Format: JSON with mcp.servers object

**fast-agent:**
- Config file: `servers.yaml`
- Location: ~/.fast-agent/
- Format: YAML

---

## Validation Process

### Step 1: Extract Inputs from User Request

Parse user request to identify each of the 6 required inputs.

### Step 2: Validate Each Input

Check each input against validation criteria above.

### Step 3: Identify Blocking Issues

**Critical Blockers (Stop Generation):**
- Service name missing or invalid
- API documentation missing when external API mentioned
- Features missing or too vague
- Authentication insufficient for implementation
- Data sources unclear or missing

**Non-Blocking Clarifications (Ask Once):**
- MCP client not specified (can default)
- Minor auth details missing but type is clear
- Feature descriptions could be clearer but are implementable

### Step 4: Gate Decision

**If ANY critical blocker exists:**
- BLOCK generation
- Return error message listing specific missing/invalid inputs
- Explain why each is required
- Do NOT proceed to analysis phase

**If only non-blocking clarifications needed (max 3):**
- Ask ALL clarifying questions in ONE message
- Wait for user response
- Proceed after clarifications received

**If all inputs validated:**
- Set validation_gate.ready_to_proceed = true
- Pass validated_inputs to analysis-agent
- Proceed to architecture analysis

## Validation Gate Error Message Templates

### Template: Missing Service Name
```
I cannot generate the MCP server because the service name is missing or invalid.

❌ **Service Name**
   - Must be valid Python module name (alphanumeric + underscores)
   - Cannot contain spaces, hyphens, or start with numbers
   - Examples: "github_mcp", "file_search", "weather_api"

Please provide a valid service name.
```

### Template: Missing API Documentation (Critical)
```
I cannot generate the MCP server because API documentation is missing.

❌ **API Documentation (CRITICAL REQUIREMENT)**
   - You mentioned using "{API_NAME}" but did not provide documentation URL
   - Required for: Generating realistic test fixtures, accurate request/response models, correct error handling
   - Needed: Complete API documentation URL

Please provide one of:
- OpenAPI/Swagger specification URL
- API reference documentation URL
- Postman collection URL

Without API documentation, I cannot generate production-ready code with >80% test coverage.
```

### Template: Multiple Missing Inputs
```
I cannot generate the MCP server because the following required information is missing:

❌ **{Input 1 Name}**
   - {Why it's needed}
   - {What format/details required}

❌ **{Input 2 Name}**
   - {Why it's needed}
   - {What format/details required}

Please provide all missing information so I can generate a complete, production-ready MCP server.
```

### Template: Non-Blocking Clarifications
```
I have the core requirements, but need clarification on these points to optimize the implementation:

1. **{Clarification 1}**
   - {Options or guidance}

2. **{Clarification 2}**
   - {Options or guidance}

3. **{Clarification 3}**
   - {Options or guidance}

Please answer these so I can proceed with generation.
```

## Validation Examples

### Example 1: All Inputs Valid (Proceed)

**User Input:**
"Create MCP server called 'github_search' using GitHub REST API at https://docs.github.com/en/rest. Features: search_repos, get_repo_details. Auth is token in Authorization header as 'Bearer {token}'. Data source is GitHub API. Target is Claude Desktop."

**Validation Result:**
- ✅ Service name: "github_search" (valid Python module name)
- ✅ API docs: https://docs.github.com/en/rest (provided)
- ✅ Features: 2 specific tools listed
- ✅ Auth: Bearer token with header details
- ✅ Data sources: GitHub API (matches API docs)
- ✅ MCP client: Claude Desktop

**Action:** validation_gate.ready_to_proceed = true → Proceed to analysis-agent

### Example 2: API Docs Missing (Block)

**User Input:**
"Create MCP server for Slack messaging with tools to send messages and list channels. Use Slack API. Bearer token auth. For Cursor."

**Validation Result:**
- ✅ Service name: "slack_messaging" (can infer)
- ❌ API docs: NOT PROVIDED (CRITICAL - external API mentioned)
- ✅ Features: 2 tools mentioned
- ⚠️ Auth: "Bearer token" (sufficient but could use details)
- ✅ Data sources: Slack API (but no docs)
- ✅ MCP client: Cursor

**Action:** BLOCK with API documentation error message

### Example 3: Vague Features (Block)

**User Input:**
"Create MCP server called 'data_tool' that works with files. No API. No auth. For Claude Desktop."

**Validation Result:**
- ✅ Service name: "data_tool" (valid)
- ✅ API docs: N/A (no external API)
- ❌ Features: Too vague ("works with files" - what operations?)
- ✅ Auth: None (valid for file-based)
- ⚠️ Data sources: "files" (what format? where?)
- ✅ MCP client: Claude Desktop

**Action:** BLOCK with features/data sources clarification request

## Notes

- Validation gate is intentionally strict to ensure production-ready output
- API documentation requirement is non-negotiable when external API is used
- Better to block early than generate low-quality code
- Clear error messages help users provide correct information quickly
