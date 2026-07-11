# Coding Best Practices — Agent Reference Index

- [conventions.md](conventions.md): Universal pre-generation rules and severity legend
- [multi-gpu-standard.md](multi-gpu-standard.md): Multi-GPU coding standards and patterns
- [python.md](python.md): Python style, patterns, idioms, and testing
- [typescript.md](typescript.md): TypeScript strict mode, types, validation, and patterns
- [library-docs.md](library-docs.md): **Look third-party/library docs up live** — the governing convention for external docs (canonical base URL + version check + runtime fetch instead of static link lists)
- [fastapi/AGENTS.md](fastapi/AGENTS.md): FastAPI documentation **lookup** — canonical base + section→path map; fetch current pages at runtime
- [lit/AGENTS.md](lit/AGENTS.md): Lit documentation **lookup** — canonical base + section→path map, styling & security cross-refs; fetch live (**default UI framework**)
- [tailwind/AGENTS.md](tailwind/AGENTS.md): Tailwind CSS documentation **lookup** — canonical base + version check, plus the shadow-DOM/Lit integration pattern; fetch live (**default CSS framework**)
- [security/AGENTS.md](security/AGENTS.md): Security anti-patterns for generated code — injection, XSS, auth, crypto, secrets, input validation
