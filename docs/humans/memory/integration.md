# Penny Memory Integration

This document describes how to integrate with and use the Mempalace memory system in skills, extensions, and agents.

## Overview

Mempalace is a structured memory system organized as a palace with wings, rooms, and drawers. It provides:

- **Semantic search** across all memories
- **Knowledge graph** for entity relationships
- **Session diary** for agent reflection
- **Cross-session persistence** for learning

## Memory Architecture

```
Memory Palace
├── Wings (projects, people, topics)
│   ├── Rooms (categories within wings)
│   │   └── Drawers (individual memory entries)
│   │       └── Verbatim content + metadata
└── Knowledge Graph
    └── Entities → Relationships → Entities

Agent Diary
└── AAAK Format: SESSION:YYYY-MM-DD|topic|key_points|★★★
```

### Wings

Wings organize memories by domain:

| Wing    | Purpose          | Example Rooms                                     |
| ------- | ---------------- | ------------------------------------------------- |
| `penny` | Project memories | `decisions`, `architecture`, `skills`, `sessions` |
| `user`  | User preferences | `preferences`, `context`, `history`               |
| Custom  | Project-specific | Any room structure                                |

### Knowledge Graph

Stores relationships between entities:

- `Entity → predicate → Entity`
- Supports predicates: `works_on`, `uses`, `prefers`, `decided`, `owns`, `assigned_to`
- Temporal: `valid_from` and `ended` dates

## Tool Reference

### memory_status

Get palace overview: total drawers, wings, rooms.

```typescript
const status = await memory_status();
// Returns: { totalDrawers, wings: [...], rooms: [...] }
```

### memory_list_wings

List all wings with drawer counts.

```typescript
const wings = await memory_list_wings();
// Returns: [{ name: "penny", drawers: 42 }, ...]
```

### memory_list_rooms

List rooms within a wing or all rooms.

```typescript
// All rooms
const rooms = await memory_list_rooms();

// Rooms in specific wing
const rooms = await memory_list_rooms({ wing: "penny" });
```

### memory_get_taxonomy

Get complete hierarchy: wing → room → drawer count.

```typescript
const taxonomy = await memory_get_taxonomy();
// Returns full structure
```

### memory_search

Semantic search across all memories.

```typescript
const results = await memory_search({
  query: "TDD patterns for authentication",
  limit: 5,
  wing: "penny", // Optional: filter by wing
  room: "technical", // Optional: filter by room
});
// Returns: { success, results: [{ text, wing, room, similarity }] }
```

### memory_smart_search

Context-aware search for efficient retrieval (returns summaries).

```typescript
const results = await memory_smart_search({
  query: "authentication decisions",
  limit: 3,
  min_similarity: 0.25, // Lower = more results (L2-to-similarity scale: 0-1)
  include_full: false, // Set true for full content
});
// Returns: summarized results with relevance scores
```

### memory_check_duplicate

Check if content already exists before adding.

```typescript
const exists = await memory_check_duplicate({
  content: "TDD session for user authentication...",
  threshold: 0.9, // Similarity threshold
});
// Returns: { success, isDuplicate, matchingDrawerId }
```

### memory_add_drawer

Store verbatim content in the palace.

```typescript
const result = await memory_add_drawer({
  wing: "penny",
  room: "decisions",
  content: `
    # Decision: Use python-statemachine
    
    **Date:** 2026-04-09
    **Decision:** Use python-statemachine for skill state management
    
    **Rationale:**
    - Active maintenance (v3.0 Feb 2026)
    - SCXML compliant
    - Async-native
    
    **Alternatives Considered:**
    - transitions: 7-month maintenance gap
    - LangGraph: Tool wrapping overhead
  `,
  source_file: "docs/research/state-management.md",
  added_by: "penny",
});
// Returns: { success, drawer_id: "drawer_penny_decisions_xxx" }
```

### memory_delete_drawer

Delete a drawer by ID.

```typescript
await memory_delete_drawer({
  drawer_id: "drawer_penny_decisions_xxx",
});
```

### memory_list_drawers

List drawers in a wing/room. Used for bulk operations, auditing, and cleanup.

```typescript
// List all drawers in a specific room
const result = await memory_list_drawers({
  wing: "penny",
  room: "outcomes",
});
// Returns: { success, count, drawers: [{ id, wing, room, source_file, created_at }] }

// List all drawers in a wing (no room filter)
const result = await memory_list_drawers({
  wing: "penny",
});

// Limit results
const result = await memory_list_drawers({
  wing: "penny",
  room: "diary",
  limit: 10,
});
```

### memory_delete_drawers_by_room

Bulk delete all drawers in a room. Requires BOTH wing AND room as a safety guard.

```typescript
// Delete all drawers in a room (e.g., for cleanup)
const result = await memory_delete_drawers_by_room({
  wing: "penny",
  room: "general", // Both wing and room are required
});
// Returns: { success, count, message: "Deleted X drawers from penny/general" }
```

**⚠️ Warning:** This operation is irreversible. Always use `memory_list_drawers` first to verify contents before bulk deletion.

### memory_kg_query

Query knowledge graph for entity relationships.

```typescript
const facts = await memory_kg_query({
  entity: "TDDSession",
  direction: "outgoing", // or "incoming" or "both"
  as_of: "2026-04-09", // Optional: date filter
});
// Returns: [{ entity, predicate, object, valid_from }]
```

### memory_kg_add

Add a relationship fact to the knowledge graph.

```typescript
await memory_kg_add({
  subject: "TDDSession:auth-001",
  predicate: "implemented",
  object: "Feature:UserAuthentication",
  valid_from: "2026-04-09",
  source_closet: "drawer_penny_skills_xxx",
});
```

### memory_kg_invalidate

Mark a fact as no longer true.

```typescript
await memory_kg_invalidate({
  subject: "Decision:use-transitions",
  predicate: "works_on",
  object: "Skill:TDD",
  ended: "2026-04-09",
});
```

### memory_kg_timeline

Get chronological timeline of facts for an entity.

```typescript
const timeline = await memory_kg_timeline({
  entity: "Penny",
});
// Returns: [{ date, subject, predicate, object }]
```

### memory_kg_stats

Get knowledge graph statistics.

```typescript
const stats = await memory_kg_stats();
// Returns: { entityCount, tripleCount, predicateCounts }
```

### memory_traverse

Walk the palace graph from a room.

```typescript
const connections = await memory_traverse({
  start_room: "architecture",
  max_hops: 2,
});
// Returns: connected rooms and concepts
```

### memory_find_tunnels

Find rooms that bridge two wings.

```typescript
const tunnels = await memory_find_tunnels({
  wing_a: "penny",
  wing_b: "user",
});
// Returns: shared topics between wings
```

### memory_graph_stats

Get palace graph statistics.

```typescript
const stats = await memory_graph_stats();
// Returns: { totalRooms, tunnelConnections, edgeCounts }
```

### memory_diary_write

Write an entry to agent diary.

```typescript
await memory_diary_write({
  agent_name: "penny",
  entry: "SESSION:2026-04-09|skill-standard|Created skill standard with TDD requirements|★★★",
  topic: "skills",
});
```

### memory_diary_read

Read recent diary entries.

```typescript
const entries = await memory_diary_read({
  agent_name: "penny",
  last_n: 10,
});
// Returns: [{ date, entry, topic }]
```

## Integration Patterns

### Before Workflow (Context Retrieval)

```python
async def _get_context(self) -> Dict[str, Any]:
    """Retrieve context from Mempalace before workflow execution"""

    # 1. Search for relevant patterns
    patterns = await memory_smart_search(
        query=f"{self.model.skill_name} patterns",
        wing="penny",
        room="technical",
        limit=3,
    )

    # 2. Find related sessions
    sessions = await memory_smart_search(
        query=f"{self.model.skill_name} session",
        wing="penny",
        room="skills",
        limit=2,
    )

    # 3. Query knowledge graph for related entities
    facts = await memory_kg_query(
        entity=f"Skill:{self.model.skill_name}",
        direction="both",
    )

    return {
        "patterns": patterns,
        "sessions": sessions,
        "facts": facts,
    }
```

### After Workflow (Learning Storage)

```python
async def _store_learnings(self) -> None:
    """Store learnings in Mempalace after workflow completion"""

    # 1. Store detailed session record
    drawer_id = await memory_add_drawer(
        wing="penny",
        room="skills",
        content=f"""
        Skill Session: {self.model.skill_name}
        Session ID: {self.model.session_id}
        Timestamp: {datetime.now().isoformat()}

        Input: {self.model.input_summary}
        Output: {self.model.output_summary}

        Key Decisions:
        {self._format_decisions()}

        Lessons Learned:
        {self._format_lessons()}

        Metrics:
        - Iterations: {self.model.iteration}
        - Duration: {self.model.duration}
        """,
    )

    # 2. Store knowledge graph relationships
    await memory_kg_add(
        subject=f"SkillSession:{self.model.session_id}",
        predicate="completed",
        object=f"Skill:{self.model.skill_name}",
        valid_from=datetime.now().isoformat(),
    )

    # 3. Store relationships to produced artifacts
    if self.model.artifacts:
        for artifact in self.model.artifacts:
            await memory_kg_add(
                subject=f"SkillSession:{self.model.session_id}",
                predicate="produced",
                object=f"Artifact:{artifact}",
            )
```

### Decision Recording

```python
async def record_decision(self, decision: str, rationale: str, alternatives: List[str]):
    """Record a significant decision in Mempalace"""

    await memory_add_drawer(
        wing="penny",
        room="decisions",
        content=f"""
        # Decision: {decision}

        **Date:** {datetime.now().isoformat()}
        **Decision:** {decision}

        **Rationale:**
        {rationale}

        **Alternatives Considered:**
        {chr(10).join(f'- {a}' for a in alternatives)}
        """,
    )
```

### Preference Learning

```python
async def learn_preference(self, entity: str, preference: str, value: str):
    """Learn and store user/agent preferences"""

    await memory_kg_add(
        subject=entity,
        predicate="prefers",
        object=f"{preference}:{value}",
        valid_from=datetime.now().isoformat(),
    )
```

### Session Diary

```python
async def write_session_diary(self, topic: str, key_points: List[str], importance: int):
    """Write a session diary entry in AAAK format"""

    # AAAK format: SESSION:YYYY-MM-DD|topic|key_points|★rating
    entry = f"SESSION:{datetime.now().strftime('%Y-%m-%d')}|{topic}|{'|'.join(key_points)}|{'★' * importance}"

    await memory_diary_write({
        agent_name: "penny",
        entry: entry,
        topic: topic,
    })
```

## Best Practices

### What to Store

| Type           | Wing    | Room           | Example                                        |
| -------------- | ------- | -------------- | ---------------------------------------------- |
| Decisions      | `penny` | `decisions`    | Architecture choices, tool selections          |
| Architecture   | `penny` | `architecture` | System design, patterns                        |
| Sessions       | `penny` | `skills`       | Skill execution records                        |
| Technical      | `penny` | `technical`    | Patterns, learnings                            |
| User Prefs     | `user`  | `preferences`  | Preferences, settings                          |
| Outcome Ledger | `penny` | `outcomes`     | Consequential action outcomes and delta scores |
| Diary          | `penny` | `diary`        | Agent session diary entries (AAAK format)      |
| Backlog        | `penny` | `backlog`      | Triage items and deferred work                 |
| Audit          | `penny` | `audit`        | Post-hoc review logs                           |

> **Note:** The canonical wing name is `penny` (not `wing_penny`). Legacy `wing_penny` drawers were migrated on 2026-04-19. Always use `penny` for new drawers.

### What NOT to Store

| Type           | Why                                      | Alternative           |
| -------------- | ---------------------------------------- | --------------------- |
| Workflow state | Mempalace is for knowledge, not sessions | `.context/` directory |
| Temporary data | No need for persistence                  | In-memory             |
| Large files    | Memory is for concepts, not data         | File system           |
| Secrets        | Security risk                            | Environment variables |

### Query Efficiency

```python
# GOOD: Specific query with filters
results = await memory_smart_search({
    "query": "TDD implementation for authentication",
    "wing": "penny",
    "room": "technical",
    "limit": 3,
})

# BAD: Vague query without filters
results = await memory_search({
    "query": "TDD",  # Too vague
    "limit": 20,     # Too many results
})
```

### Duplicate Prevention

```python
# Always check before storing
is_dup = await memory_check_duplicate({
    "content": content_to_store,
    "threshold": 0.9,
})

if is_dup["isDuplicate"]:
    print(f"Similar content exists: {is_dup['matchingDrawerId']}")
else:
    await memory_add_drawer(...)
```

### Temporal Queries

```python
# Get facts valid at a specific date
facts = await memory_kg_query({
    "entity": "Decision:use-transitions",
    "as_of": "2026-04-01",  # Before it was invalidated
})
```

## Knowledge Graph Predicates

Standard predicates for relationships:

| Predicate     | Meaning              | Example                                                                      |
| ------------- | -------------------- | ---------------------------------------------------------------------------- |
| `works_on`    | Active involvement   | `Penny works_on Skill:TDD`                                                   |
| `uses`        | Tool/framework usage | `Skill:TDD uses python-statemachine`                                         |
| `prefers`     | Preference           | `User prefers dark_mode`                                                     |
| `decided`     | Decision made        | `Penny decided python-statemachine`                                          |
| `owns`        | Ownership            | `User owns Project:Penny`                                                    |
| `assigned_to` | Assignment           | `Task:auth assigned_to Coder`                                                |
| `completed`   | Completion           | `Session:001 completed Skill:TDD`                                            |
| `produced`    | Output               | `Session:001 produced File:auth.py`                                          |
| `implemented` | Implementation       | `Session:001 implemented Feature:Login`                                      |
| `evaluated`   | Outcome evaluation   | `Penny evaluated Decision:decision_2026-04-19_001` (post-action delta score) |

## AAAK Diary Format

Sessions should be recorded in the agent diary:

```
SESSION:YYYY-MM-DD|topic|key_point_1|key_point_2|key_point_3|★★★
```

Components:

- Date: `YYYY-MM-DD`
- Topic: Single word or phrase
- Key points: Pipe-separated list
- Importance: `★` (minor) to `★★★★★` (critical)

Example:

```
SESSION:2026-04-09|skill-standard|Created SKILL_STANDARD.md|Added testing requirements|Documented SKILL.md structure|★★★
```

## Error Handling

```python
try:
    result = await memory_add_drawer(...)
except Exception as e:
    # Don't fail the workflow on memory errors
    print(f"Warning: Failed to store memory: {e}")
    # Continue with execution
```

## Testing

```typescript
// tests/memory.test.ts
import { describe, it, expect } from "bun:test";

describe("Memory Integration", () => {
  it("should store and retrieve context", async () => {
    await memory_add_drawer({
      wing: "test",
      room: "test",
      content: "Test content",
    });

    const results = await memory_search({
      query: "Test content",
      wing: "test",
    });

    expect(results.success).toBe(true);
    expect(results.results.length).toBeGreaterThan(0);
  });
});
```
