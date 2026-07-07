# P3 — Context (Domain Guidance for `synthia`)

Reconstruct the business and domain context of the target: who uses it, at what
trust levels, what data it holds, and — crucially — whether it processes
personal or otherwise sensitive data (PII). Build on the P1 census and P2
baseline already summarized in your task; do not re-derive the codebase from
scratch. This context feeds P4 architecture, P5 requirements, and drives the
P6 threat model's LINDDUN applicability decision.

**MemPalace:** write ALL entries for this phase to wing `wing_sca`, room
`<session_id>-p3_context`. Search that wing first for the P1_CENSUS inventory
and the approved P0 charter (scope bounds this work). Emit only a compact
`SUMMARY:{...}` JSON block inline; the full context write-up lives in mempalace.

---

## 1. Actors and trust levels

Enumerate the human and machine actors that interact with the target
(anonymous users, authenticated users, admins, service accounts, third-party
integrations, internal jobs). For each, record its trust level and how it
authenticates. Distinguish trusted callers from untrusted input sources — that
boundary is where later threats concentrate. Note privilege tiers explicitly:
an actor that can escalate from one tier to another (self-service admin, tenant
crossover) is a threat driver P6 will model, so capture the intended separation
now even when the code does not yet enforce it.

## 2. Assets and data classification

List the assets worth protecting (credentials, tokens, financial records,
health data, user content, business logic) and classify each: public,
internal, confidential, or regulated. Where the target names a regulatory
regime (payment card, health, or regional privacy data), record it — it raises
the bar for the requirements P5 derives. Decide explicitly **whether personal /
sensitive data (PII) is processed** and record the evidence behind the
decision — this flag is load-bearing: P6 applies LINDDUN only when personal
data is in scope, so a wrong call here silently drops (or fabricates) a whole
privacy-threat class.

## 3. External dependencies and integrations

Identify the external systems the target trusts or exchanges data with
(databases, payment providers, identity providers, SaaS APIs, message queues).
Each integration is a trust relationship and a data flow that P4 will detail
and P6 may attack. For each, note the direction of trust (does the target trust
data coming back from it?) and what secret or credential the connection
requires — inbound trust in an external response is a common, easily missed
injection and spoofing vector.

## 4. Ground every claim; separate assumption from fact

Anchor each actor, asset, and integration in a concrete signal from the census,
config, or code you actually read. Where the evidence is thin, record it as an
**assumption** or **unknown** rather than asserting it — never fabricate
business context the code does not support. Context flows in one direction:
this phase must precede architecture and requirements, so a shaky assumption
here propagates. Degrade gracefully when the census or baseline is missing:
model what the available data supports, mark the rest unknown, and say plainly
what is absent. If critical ambiguity cannot be resolved from available
context, set `needs_clarification: true` with `clarifying_questions` in your
SUMMARY rather than guessing at the business purpose.

## 5. Output shape

Write the full context reconstruction as mempalace entries in the P3 room, then
emit a compact inline summary:

```
SUMMARY:{"phase":"P3_CONTEXT","actors":[{"name":"<actor>","trust":"<level>"}],"data_classes":["<class>"],"pii_processed":<true|false>,"pii_evidence":"<one line>","external_integrations":["<name>"],"assumptions":["<one line>"],"unknowns":["<one line>"],"needs_clarification":<true|false>}
```

Make the context evidence-anchored, get the PII decision right, and hand P4 and
P5 a trustworthy foundation.
