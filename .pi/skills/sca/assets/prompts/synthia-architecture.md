# P4 — Architecture (Domain Guidance for `synthia`)

Reconstruct the target's architecture: its components, the data flows between
them, the trust boundaries they cross, and the entry points that make up the
attack surface. Build on the P3 context summarized in your task; do not
re-derive the business context here. Every element you record must be a
concrete, grounded fact — P5 requirements and P6 threats attach directly to the
components, flows, and boundaries you name.

**MemPalace:** write ALL entries for this phase to wing `wing_sca`, room
`<session_id>-p4_architecture`. Search that wing first for the P3_CONTEXT
actors, assets, and integrations — the architecture must be consistent with
them. Emit only a compact `SUMMARY:{...}` JSON block inline; the full model
lives in mempalace.

---

## 1. Components

Identify the runtime components (services, APIs, workers, front ends,
datastores, caches, external integrations). Give each a stable, unambiguous
name; downstream requirements and threats reference these names, so a rename
later breaks traceability. Record what each component is responsible for and
which actors (from P3) drive it, so a reviewer can tell load-bearing security
components (auth service, session store, payment gateway) from incidental ones.

## 2. Data flows

Trace how data moves between components: what data, in which direction, over
what channel, and whether the channel is authenticated and encrypted. Pay
special attention to flows that carry the sensitive/PII data classes P3
flagged — those flows dominate the confidentiality and privacy threats P6 will
model. A flow that leaves a trust boundary carrying regulated data with no
stated protection is exactly the kind of concrete fact P5 turns into a
requirement, so record the protection (or its absence) rather than assuming it.

## 3. Trust boundaries

Mark where data or control crosses a change in trust (client → server, service
→ datastore, internal → third party, privilege escalation points). A trust
boundary is where an untrusted producer meets a trusting consumer — the highest
concentration of exploitable weakness.

## 4. Entry points and attack surface

Enumerate every point where untrusted input reaches the code: routes, RPC/GraphQL
endpoints, message consumers, file uploads, webhooks, CLI arguments, environment
and config. For each, note what authenticates the caller and what validates the
input — an unauthenticated or unvalidated entry point on a sensitive flow is the
highest-value target. This surface is what the P7 targeted scan and P10
verification aim at, so completeness here directly bounds their coverage.

## 5. Ground every element; separate assumption from fact

Anchor each component, flow, and boundary in the census, config, or code you
actually read. Where a flow or boundary is inferred rather than observed, record
it as an **assumption** or **unknown** — never invent structure to make the
diagram tidy. Degrade gracefully when P3 context is missing: model what the
available signals support and state what is absent.

## 6. Output shape

Write the full architecture model as mempalace entries in the P4 room, then emit
a compact inline summary:

```
SUMMARY:{"phase":"P4_ARCHITECTURE","components":["<name>"],"data_flows":[{"from":"<c>","to":"<c>","data":"<class>"}],"trust_boundaries":["<one line>"],"entry_points":["<one line>"],"assumptions":["<one line>"],"unknowns":["<one line>"],"needs_clarification":<true|false>}
```

If critical ambiguity about a component or flow cannot be resolved from
available context, set `needs_clarification: true` with `clarifying_questions`
in your SUMMARY rather than inventing the missing structure.

Keep every element grounded and named consistently, so P5 can pin requirements
to components and P6 can pin threats to concrete flows and boundaries.
