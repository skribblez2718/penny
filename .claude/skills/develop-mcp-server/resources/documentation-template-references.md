# Documentation Template References

## Purpose

Documentation structure and content requirements for generated MCP servers.

## README.md Required Sections

1. **Title and Description:** Service name and brief description
2. **Features:** Bullet list of all tools/capabilities
3. **Architecture:** Mermaid diagram showing components
4. **Prerequisites:** Python version, API keys, MCP client
5. **Installation:** Quick start (dev) and production installation
6. **Configuration:** Environment variables table with descriptions
7. **MCP Client Setup:** Client-specific configuration for target client
8. **Usage:** Tool descriptions with parameters, examples, responses
9. **Development:** Running tests, code quality, project structure
10. **Troubleshooting:** Common issues with solutions
11. **Security Considerations:** API keys, rate limiting, validation
12. **Contributing:** Link to CONTRIBUTING.md
13. **License and Support:** License type, issue tracker

## MCP Client-Specific Setup

Must include detailed setup for target client (Claude Desktop/Cursor/Windsurf/fast-agent) with exact file paths, JSON/YAML examples, restart instructions.

## CONTRIBUTING.md Required Content

Development setup steps, code standards (PEP 8, Black, type hints, docstrings), testing requirements (>80% coverage), pull request process, commit message format

## Troubleshooting Section

Common issues: Server won't start, API authentication errors, rate limiting, connection timeouts, MCP client not detecting server, test failures. Each with symptoms and step-by-step solutions.
