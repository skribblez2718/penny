# FastAPI Documentation Links

> Source: https://fastapi.tiangolo.com/ (canonical mkdocs.yml, 2026-06-02)
> 138 core pages across all documentation sections

## Navigation

Use these links to look up FastAPI patterns, endpoints, middleware, and deployment guides.

---

## Getting Started

- [FastAPI Home](https://fastapi.tiangolo.com/) - Home page: framework overview, features, installation, quickstart
- [Features](https://fastapi.tiangolo.com/features/) - Language-agnostic feature summary
- [Python Types Intro](https://fastapi.tiangolo.com/python-types/) - Python type hints primer for FastAPI
- [Async](https://fastapi.tiangolo.com/async/) - Concurrency and async/await in FastAPI
- [First Steps](https://fastapi.tiangolo.com/tutorial/first-steps/) - Create your first FastAPI app

## Tutorial - User Guide

### Path & Query Parameters
- [Path Parameters](https://fastapi.tiangolo.com/tutorial/path-params/) - Path parameters with types
- [Query Parameters](https://fastapi.tiangolo.com/tutorial/query-params/) - Query parameters and defaults
- [Query Parameters and String Validations](https://fastapi.tiangolo.com/tutorial/query-params-str-validations/) - Additional validation for query params
- [Path Parameters and Numeric Validations](https://fastapi.tiangolo.com/tutorial/path-params-numeric-validations/) - Numeric validations for path params

### Request Body (KEY FOR THIS PROJECT)
- [Request Body](https://fastapi.tiangolo.com/tutorial/body/) - Declaring request bodies with Pydantic
- [Body - Multiple Parameters](https://fastapi.tiangolo.com/tutorial/body-multiple-params/) - Multiple body parameters
- [Body - Fields](https://fastapi.tiangolo.com/tutorial/body-fields/) - Using Pydantic `Field` for extra validation
- [Declare Request Example Data](https://fastapi.tiangolo.com/tutorial/schema-extra-example/) - Example/schema data for OpenAPI docs

### Response Handling
- [Response Model - Return Type](https://fastapi.tiangolo.com/tutorial/response-model/) - Control response shape with `response_model`
- [Response Status Code](https://fastapi.tiangolo.com/tutorial/response-status-code/) - Set HTTP status codes

### Handling Errors (KEY)
- [Handling Errors](https://fastapi.tiangolo.com/tutorial/handling-errors/) - HTTPException and custom exceptions

### Middleware & CORS (KEY)
- [Middleware](https://fastapi.tiangolo.com/tutorial/middleware/) - Adding middleware to your app
- [CORS (Cross-Origin Resource Sharing)](https://fastapi.tiangolo.com/tutorial/cors/) - Configuring CORS

### Background Tasks (KEY FOR ASYNC CHAT)
- [Background Tasks](https://fastapi.tiangolo.com/tutorial/background-tasks/) - Running tasks after returning a response

### Server-Sent Events (KEY FOR STREAMING)
- [Server-Sent Events](https://fastapi.tiangolo.com/tutorial/server-sent-events/) - SSE streaming with FastAPI
- [Stream JSON Lines](https://fastapi.tiangolo.com/tutorial/stream-json-lines/) - Streaming newline-delimited JSON

### Testing
- [Testing](https://fastapi.tiangolo.com/tutorial/testing/) - Testing FastAPI apps with TestClient and pytest

### Other Tutorial
- [Bigger Applications - Multiple Files](https://fastapi.tiangolo.com/tutorial/bigger-applications/) - Structuring large apps with APIRouter
- [Metadata and Docs URLs](https://fastapi.tiangolo.com/tutorial/metadata/) - OpenAPI metadata, docs URLs, tags
- [Static Files](https://fastapi.tiangolo.com/tutorial/static-files/) - Serving static files

## Advanced User Guide

- [Advanced User Guide](https://fastapi.tiangolo.com/advanced/) - Additional features beyond the tutorial
- [Custom Response - HTML, Stream, File, others](https://fastapi.tiangolo.com/advanced/custom-response/) - HTMLResponse, StreamingResponse, FileResponse
- [Return a Response Directly](https://fastapi.tiangolo.com/advanced/response-directly/) - Returning raw Response objects
- [Using the Request Directly](https://fastapi.tiangolo.com/advanced/using-request-directly/) - Accessing raw Starlette Request
- [Events: startup - shutdown](https://fastapi.tiangolo.com/advanced/events/) - Startup and shutdown lifecycle hooks
- [WebSockets](https://fastapi.tiangolo.com/advanced/websockets/) - WebSocket endpoints
- [Behind a Proxy](https://fastapi.tiangolo.com/advanced/behind-a-proxy/) - Using FastAPI behind nginx, Traefik, etc.

## API Reference

- [Reference - Code API](https://fastapi.tiangolo.com/reference/) - Code API reference index
- [FastAPI Class](https://fastapi.tiangolo.com/reference/fastapi/) - The `FastAPI` class (main app class)
- [Parameters](https://fastapi.tiangolo.com/reference/parameters/) - `Path`, `Query`, `Body`, `Form`, `File`, `Cookie`, `Header`, `Depends`, `Security`
- [Status Codes](https://fastapi.tiangolo.com/reference/status/) - HTTP status code constants
- [Exceptions](https://fastapi.tiangolo.com/reference/exceptions/) - `HTTPException` and `WebSocketException`
- [APIRouter](https://fastapi.tiangolo.com/reference/apirouter/) - The `APIRouter` class for modular apps
- [Background Tasks](https://fastapi.tiangolo.com/reference/background/) - `BackgroundTasks` class
- [Request](https://fastapi.tiangolo.com/reference/request/) - The `Request` object
- [Response](https://fastapi.tiangolo.com/reference/response/) - Response objects (`Response`, `JSONResponse`, `HTMLResponse`, etc.)
- [Responses](https://fastapi.tiangolo.com/reference/responses/) - Additional response helpers (`FileResponse`, `StreamingResponse`, `RedirectResponse`)
- [Middleware](https://fastapi.tiangolo.com/reference/middleware/) - Middleware classes (CORS, TrustedHost, GZip)
- [TestClient](https://fastapi.tiangolo.com/reference/testclient/) - `TestClient` class for testing

## Deployment

- [Deployment](https://fastapi.tiangolo.com/deployment/) - Deployment overview and concepts
- [Run a Server Manually](https://fastapi.tiangolo.com/deployment/manually/) - Manual Uvicorn/Gunicorn setup
- [Docker](https://fastapi.tiangolo.com/deployment/docker/) - Containerized deployment with Docker

## How-To Recipes

- [How-To - Recipes](https://fastapi.tiangolo.com/how-to/) - Practical how-to guides index
- [Conditional OpenAPI](https://fastapi.tiangolo.com/how-to/conditional-openapi/) - Conditionally enabling/disabling OpenAPI
- [Extending OpenAPI](https://fastapi.tiangolo.com/how-to/extending-openapi/) - Modifying the generated OpenAPI schema
- [Configure Swagger UI](https://fastapi.tiangolo.com/how-to/configure-swagger-ui/) - Swagger UI configuration parameters

## Resources

- [FastAPI People](https://fastapi.tiangolo.com/fastapi-people/) - Sponsors, contributors, and community
- [Release Notes](https://fastapi.tiangolo.com/release-notes/) - Changelog and version history
- [External Links and Articles](https://fastapi.tiangolo.com/external-links/) - Blog posts, tutorials, videos
