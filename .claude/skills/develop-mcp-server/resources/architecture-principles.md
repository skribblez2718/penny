# Architecture Principles

## Purpose

This document defines the architectural patterns and principles that MUST be followed when generating MCP server code. These principles ensure modularity, testability, maintainability, and production readiness.

## Core Architectural Patterns

### 1. Factory Method Pattern

**Principle:** Use factory classes for creating tool instances with dependency injection

**Why:** Enables centralized configuration, dependency management, and easier testing through mock injection

**Pattern:**
- ToolFactory class creates all MCP tool instances
- Factory injects dependencies (config, services, API clients) into tools
- Tools are created lazily (on first request) and cached
- Factory maintains single source of truth for tool instantiation

**Anti-Pattern (Don't Do This):**
- Direct tool instantiation with `new Tool()` scattered throughout code
- Global singletons for services
- Hardcoded dependencies in tool constructors

**Key Requirements:**
- Factory must accept Config in constructor
- Factory creates API client, services, and injects into tools
- Factory provides `create_tool(name)` and `get_all_tools()` methods
- Tools follow MCPToolProtocol interface

### 2. Single Responsibility Principle (SRP)

**Principle:** Each module, class, and function does ONE thing well

**Why:** Improves testability, reduces complexity, makes code easier to understand and maintain

**Module-Level SRP:**
- `server.py`: ONLY MCP server initialization and request routing
- `config.py`: ONLY configuration loading and validation
- `api_client.py`: ONLY HTTP communication with external API
- `feature1_service.py`: ONLY business logic for feature1
- `feature1_tool.py`: ONLY MCP tool wrapper for feature1
- `validation.py`: ONLY input validation utilities
- `rate_limiter.py`: ONLY rate limiting logic
- `logging.py`: ONLY logging configuration

**File Size Limit:** Maximum 200 lines per file

**If module exceeds 200 lines:** Decompose into smaller, more focused modules

**Anti-Pattern (Don't Do This):**
- Monolithic files with mixed responsibilities
- God classes that do everything
- Functions with multiple unrelated purposes

### 3. Dependency Injection

**Principle:** Pass dependencies explicitly through constructors rather than creating them internally

**Why:** Makes code testable (can inject mocks), reduces coupling, makes dependencies explicit

**Pattern:**
```
Tool Constructor: def __init__(self, service: FeatureService, config: Config)
Service Constructor: def __init__(self, api_client: APIClient, config: Config)
API Client Constructor: def __init__(self, base_url: str, api_key: str, rate_limiter: RateLimiter)
```

**Benefits:**
- Easy to test (inject mocks)
- Dependencies are explicit and visible
- Configuration centralized in factory
- No hidden global state

**Anti-Pattern (Don't Do This):**
- Creating dependencies inside constructors
- Using global variables
- Importing and instantiating dependencies directly

### 4. Layered Architecture

**Principle:** Organize code into distinct layers with clear responsibilities and unidirectional dependencies

**Layers (Top to Bottom):**
1. **Server Layer** (server.py) - MCP protocol handling, request routing
2. **Tool Layer** (tools/) - MCP tool implementations, parameter validation
3. **Service Layer** (services/) - Business logic, API orchestration
4. **Data Layer** (models/) - Data models, validation schemas
5. **Infrastructure Layer** (utils/, config.py) - Cross-cutting concerns

**Dependency Flow:** Server → Tools → Services → Models/Utils

**Rule:** Higher layers can depend on lower layers, never reverse

**Anti-Pattern (Don't Do This):**
- Services importing from tools
- Models depending on services
- Circular dependencies between layers

## Mandatory Modular Structure

**Required Directory Structure:**
```
project_name/
├── src/
│   ├── __init__.py
│   ├── server.py              # MCP server initialization only
│   ├── config.py              # Configuration management
│   ├── tools/                 # MCP tool implementations
│   │   ├── __init__.py
│   │   ├── tool_factory.py    # Factory for creating tools
│   │   ├── feature1_tool.py   # One tool per file
│   │   └── feature2_tool.py
│   ├── services/              # Business logic layer
│   │   ├── __init__.py
│   │   ├── api_client.py      # API communication (if external API)
│   │   ├── feature1_service.py
│   │   └── feature2_service.py
│   ├── models/                # Data models (pydantic)
│   │   ├── __init__.py
│   │   ├── requests.py
│   │   └── responses.py
│   ├── utils/                 # Shared utilities
│   │   ├── __init__.py
│   │   ├── validation.py
│   │   ├── logging.py
│   │   └── rate_limiter.py    # If API has rate limits
│   └── exceptions.py          # Custom exceptions
├── tests/
│   ├── __init__.py
│   ├── conftest.py            # Shared fixtures
│   ├── fixtures/              # Mock data
│   │   ├── __init__.py
│   │   └── api_responses.py
│   ├── unit/
│   │   ├── test_tools/
│   │   ├── test_services/
│   │   └── test_utils/
│   └── integration/
│       └── test_server.py
├── .env.example
├── .gitignore
├── pyproject.toml             # uv-compatible
├── requirements.txt           # Traditional fallback
├── setup.py                   # Traditional fallback
├── README.md
├── CONTRIBUTING.md
├── systemd/
│   └── mcp-{service}.service
└── scripts/
    ├── setup.sh
    └── install.sh
```

**Critical Rules:**
- One tool per file in tools/
- One service per file in services/
- Shared utilities in utils/
- All models use pydantic
- No business logic in tools (delegate to services)
- No MCP-specific code in services (services are reusable)

## Component Responsibilities

### server.py

**Responsibility:** MCP server initialization and request routing ONLY

**Contains:**
- MCP server instance creation
- Tool registration via factory
- Request handler routing
- Logging setup
- Main entry point

**Does NOT Contain:**
- Business logic
- API calls
- Tool implementations
- Configuration validation

**Max Lines:** 100-150

### config.py

**Responsibility:** Configuration loading and validation ONLY

**Contains:**
- Pydantic Settings class with all environment variables
- Validation logic for configuration values
- `load_config()` function
- Configuration defaults

**Does NOT Contain:**
- Business logic
- API calls
- Tool logic

**Max Lines:** 100-200 depending on config complexity

### tools/tool_factory.py

**Responsibility:** Centralized tool creation with dependency injection

**Contains:**
- ToolFactory class
- Tool instantiation logic
- Dependency injection (config, services)
- Tool caching
- Tool protocol definition

**Does NOT Contain:**
- Business logic
- Individual tool implementations (those go in separate files)

**Max Lines:** 150-200

### tools/feature_tool.py

**Responsibility:** MCP tool wrapper for one specific feature

**Contains:**
- Tool class implementing MCPToolProtocol
- `execute(arguments)` method that delegates to service
- `get_definition()` method returning MCP Tool schema
- Input parameter validation
- Tool-specific error handling

**Does NOT Contain:**
- Business logic (delegate to service)
- API calls (delegate to service)
- Complex computations (delegate to service)

**Max Lines:** 100-150 per tool

### services/feature_service.py

**Responsibility:** Business logic for one specific feature

**Contains:**
- Service class with feature-specific methods
- Business logic and API orchestration
- Response processing and transformation
- Feature-specific error handling

**Does NOT Contain:**
- MCP-specific code
- Tool definitions
- Direct MCP protocol handling

**Max Lines:** 150-200 per service

### services/api_client.py

**Responsibility:** HTTP communication with external API ONLY

**Contains:**
- APIClient class with httpx
- HTTP methods (get, post, put, delete)
- Authentication header management
- Rate limiting integration
- Request/response error handling
- Timeout handling

**Does NOT Contain:**
- Business logic
- Feature-specific logic
- MCP tool code

**Max Lines:** 200-250

### models/

**Responsibility:** Data models and validation schemas

**Contains:**
- Pydantic models for requests
- Pydantic models for responses
- Field validation rules
- Type definitions

**Does NOT Contain:**
- Business logic
- API calls
- Processing logic

**Max Lines:** 50-100 per model file

### utils/

**Responsibility:** Shared utility functions

**Contains:**
- Validation helpers
- Logging configuration
- Rate limiter implementation
- Common transformations

**Does NOT Contain:**
- Feature-specific logic
- Business logic

**Max Lines:** 100-150 per utility file

### exceptions.py

**Responsibility:** Custom exception hierarchy

**Contains:**
- Base exception class
- Specific exception types (APIError, ValidationError, RateLimitError, etc.)
- Exception hierarchy

**Does NOT Contain:**
- Exception handling logic (that goes where exceptions are raised/caught)

**Max Lines:** 50-100

## Architecture Decision Guidelines

### When to Create a New Module

**Create new module if:**
- File exceeds 200 lines
- Code has distinct responsibility separate from existing modules
- Module would improve testability
- Multiple features share common logic

**Don't create new module if:**
- Code is <50 lines and closely related to existing module
- Would create excessive fragmentation
- Creates circular dependency issues

### Error Handling Strategy

**Approach:** Fail-fast with informative errors

**Pattern:**
- Validate inputs early (tool layer)
- Catch specific exceptions (HTTPStatusError, TimeoutError)
- Transform to domain exceptions (APIError, ValidationError)
- Never expose internal details in error messages
- Log detailed errors, return user-friendly messages

### Configuration Management

**Approach:** Centralized configuration with validation

**Pattern:**
- All config in environment variables
- Pydantic Settings for validation
- No hardcoded values in code
- .env.example provides template
- Config validated at startup (fail fast)

### Authentication Flow

**API Key Pattern:**
1. Load API key from config
2. Inject into APIClient constructor
3. APIClient adds to request headers
4. No API key handling in tools/services

**OAuth Pattern:**
1. OAuth handler utility in utils/
2. Token management in APIClient
3. Token refresh logic in APIClient
4. No OAuth code in tools/services

## Testing Architecture

**Pattern:** Mirror source structure in tests

**Structure:**
```
tests/
├── unit/
│   ├── test_tools/              # One test file per tool
│   ├── test_services/           # One test file per service
│   └── test_utils/              # One test file per utility
└── integration/
    └── test_server.py           # End-to-end server tests
```

**Benefits:**
- Easy to find tests for specific code
- Clear coverage mapping
- Parallel test execution possible

## Deployment Architecture

**Pattern:** Systemd service with security hardening

**Components:**
- Systemd service file with security restrictions
- Installation script for production setup
- Setup script for development
- Log directory with proper permissions
- Low-privilege user (mcp)

**Security Measures:**
- NoNewPrivileges=true
- ProtectSystem=strict
- ProtectHome=true
- Resource limits (CPU, memory)
- Restricted system calls

## Common Anti-Patterns to Avoid

### 1. God Classes
**Problem:** One class/file does everything
**Solution:** Apply SRP, decompose into focused modules

### 2. Hardcoded Configuration
**Problem:** Values embedded in code
**Solution:** Environment variables with validation

### 3. Circular Dependencies
**Problem:** Module A imports B, B imports A
**Solution:** Introduce interface/protocol, refactor dependencies

### 4. Hidden Dependencies
**Problem:** Dependencies created internally
**Solution:** Dependency injection

### 5. Mixed Layers
**Problem:** Business logic in tools, MCP code in services
**Solution:** Respect layer boundaries, delegate appropriately

### 6. Skeleton Code
**Problem:** Placeholder implementations like `pass` or `# TODO`
**Solution:** Always generate complete, runnable implementations

### 7. No Error Handling
**Problem:** Uncaught exceptions crash server
**Solution:** Comprehensive try/except with specific exception types

## Architecture Verification Checklist

Before considering architecture complete, verify:

- [ ] Factory method pattern used for tool creation
- [ ] Single responsibility applied (no file >200 lines)
- [ ] Dependencies injected, not created internally
- [ ] Layers clearly separated (server → tools → services)
- [ ] One tool per file
- [ ] One service per file
- [ ] Business logic in services, not tools
- [ ] MCP protocol in tools, not services
- [ ] Configuration centralized in config.py
- [ ] Shared utilities in utils/
- [ ] Custom exceptions in exceptions.py
- [ ] Test structure mirrors source structure
- [ ] No hardcoded values in code
- [ ] No circular dependencies

## Notes

- These principles are non-negotiable for production-ready code
- Architecture should scale well if features double
- Modularity enables easy testing and maintenance
- Clear boundaries reduce cognitive load for future developers
