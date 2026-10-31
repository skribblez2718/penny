# Architecture Boundaries

## Applies when

Choosing or changing architectural seams, dependency direction, use-case organization, framework integration, component structure or deployment separation.

## Protect policy with the lightest useful boundary

Identify the actual application action, its invariants and the details likely to change. Keep policy independent of volatile delivery, persistence, vendor and device mechanisms where that independence has concrete value. Domain rules may live in functions, modules or plain objects; a rich entity hierarchy is not mandatory.

A focused use case coordinates an application action. Adapters translate requests, external messages, rows or device data into the contract that policy needs, and translate results outward. Controllers, listeners, presenters and gateways should not become alternate homes for the same business rule. Persistence constraints can protect invariants too; do not remove a correctness-critical database constraint merely to make a domain model look independent.

Where a seam is justified, source dependencies point toward the policy-owned contract. The policy states what it needs; an outer adapter implements it. Keep concrete object construction and configuration at an explicit composition point rather than scattering infrastructure construction through business behavior. Plain boundary models avoid leaking framework requests, responses or live database objects into core decisions.

A direct function, narrow module API or partial source boundary may be enough. Do not prescribe layers, ports, repositories, dependency-injection frameworks or a service for every feature. Assess volatility, substitution value, testability, compatibility and operating cost. Keep a useful framework integration when replacing it would add more complexity than the independence is worth. Penny's [canonical platform standards](../../architecture/project-standards.md) remain binding; this guide does not authorize alternative runtimes or storage architectures.

## Organize around change

Names and structure should reveal capabilities and use cases instead of hiding all intent in generic controllers, services or utilities. Technical subdirectories are useful when they clarify rather than obscure the feature. Split a module with unrelated reasons to change; do not formalize organizational roles to describe those technical reasons.

Use cohesive components whose dependencies remain understandable. Avoid cycles that force unrelated releases or test setup. Stable policy should not depend on volatile implementation details; an abstraction should have a real client or variation to justify it. Shared code can worsen coupling when its consumers change independently.

Apply interface segregation by exposing the subset a client needs. Substitution requires preserving preconditions, postconditions, failure and lifecycle expectations, not merely matching method names. Prefer controlled mutation or immutability where it protects invariants. Polymorphism is one way to invert dependencies, not a requirement to replace a simple conditional.

## Source boundaries are not deployment boundaries

A package, diagram or remote service does not by itself establish independence. Check imports, shared state, data authority and failure propagation. A single-process source boundary can preserve options at much lower cost than a distributed split. Remote calls introduce I/O, latency, partial failure and operational work; do not treat them as local method calls.

Keep web, embedded/hardware and real-time details behind testable contracts when appropriate. Operational constraints remain design inputs, not reasons to relocate policy into bootstrap scripts. Keep distinct use cases distinct even if wiring them together is convenient. Revisit a boundary when actual change patterns or runtime requirements change; avoid speculative platform migration.

## Verification and evolution

Use package visibility, dependency checks or focused tests to demonstrate an important boundary rather than relying on naming. Test policy through supported interfaces with deterministic inputs where possible. Separately test adapter translation and real integration behavior; isolated fakes cannot establish external-system or lifecycle correctness.

Prefer incremental boundary extraction with behavior protection over a big rewrite. Name an unavoidable compromise, contain it at the affected seam and preserve a practical path to change it. Do not label a competing architecture necessary merely because it resembles a diagram or an inherited model-generated plan.
