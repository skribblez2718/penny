# Tailwind CSS Feature Index

- [Tailwind CSS Documentation Lookup](tailwind.md): Live-lookup entry point — canonical base (https://tailwindcss.com/docs), version check (v3 vs v4 differ a lot), and the shadow-DOM/Lit integration pattern. Fetch current pages at runtime rather than trusting a static list (see `docs/agents/coding/library-docs.md`).

> **Tailwind CSS is the documented default CSS framework for this project.**
> Pair it with Lit (`docs/agents/coding/lit/AGENTS.md`) web components. Because Lit uses shadow
> DOM, a global Tailwind stylesheet cannot pierce the boundary — adopt the
> compiled sheet into each component. See the required integration pattern in
> `.pi/skills/code/resources/web-ui.md` and the policy in
> `docs/agents/coding/conventions.md`.
