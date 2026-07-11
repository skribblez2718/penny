# Memory Extension for Penny

Intelligent memory retrieval for the Pi coding agent. Provides 23 tools for AI memory management.

## Tools

### Palace Read Tools (8 tools)

| Tool                     | Description                                                |
| ------------------------ | ---------------------------------------------------------- |
| `memory_status`          | Get palace overview: total drawers, wings, rooms           |
| `memory_list_wings`      | List all wings with drawer counts                          |
| `memory_list_rooms`      | List rooms within a wing or all rooms                      |
| `memory_get_taxonomy`    | Get full hierarchy: wing → room → count                    |
| `memory_search`          | Semantic search across all memories (returns full text)    |
| `memory_smart_search`    | **Context-efficient search** with summaries and thresholds |
| `memory_check_duplicate` | Check if content already exists                            |
| `memory_get_aaak_spec`   | Get AAAK dialect specification for diary entries           |

### Palace Write Tools (2 tools)

| Tool                   | Description                          |
| ---------------------- | ------------------------------------ |
| `memory_add_drawer`    | Store verbatim content in the palace |
| `memory_delete_drawer` | Delete a drawer by ID                |

### Knowledge Graph Tools (5 tools)

| Tool                   | Description                                    |
| ---------------------- | ---------------------------------------------- |
| `memory_kg_query`      | Query knowledge graph for entity relationships |
| `memory_kg_add`        | Add a fact to the knowledge graph              |
| `memory_kg_invalidate` | Mark a fact as no longer true                  |
| `memory_kg_timeline`   | Get chronological timeline of facts            |
| `memory_kg_stats`      | Get knowledge graph statistics                 |

### Navigation Tools (3 tools)

| Tool                  | Description                        |
| --------------------- | ---------------------------------- |
| `memory_traverse`     | Walk the palace graph from a room  |
| `memory_find_tunnels` | Find rooms that bridge two wings   |
| `memory_graph_stats`  | Get palace connectivity statistics |

### Agent Diary Tools (2 tools)

| Tool                 | Description                              |
| -------------------- | ---------------------------------------- |
| `memory_diary_write` | Write an agent diary entry (AAAK format) |
| `memory_diary_read`  | Read recent diary entries                |

---

## Context-Efficient Search

### The Problem

The original `memory_search` returned full verbatim text from all 532+ memory drawers, consuming excessive context window:

- No filtering by relevance threshold
- Full document text returned, no summaries
- Default limit of 5 results
- Negative similarity scores included (noise)
- No context-aware query building

### The Solution: `memory_smart_search`

A context-aware search that minimizes token usage:

**Features:**

1. **Relevance Threshold** - Filters out low-similarity results (default: 0.05)
2. **Summary Mode** - Returns 200-char summaries instead of full text
3. **Lower Default Limit** - Returns 3 results vs 5
4. **Context Analysis** - Extracts entities/keywords from query
5. **Suggested Filters** - Recommends wing/room based on context

**Example Usage:**

```json
{
  "query": "authentication decisions",
  "context": "We discussed using Clerk vs Auth0 for the new project",
  "limit": 3,
  "min_similarity": 0.05
}
```

**Response:**

```json
{
  "results": [
    {
      "summary": "Decided to use Clerk for authentication...",
      "similarity": 0.42,
      "wing": "penny",
      "room": "decisions",
      "id": "drawer_penny_decisions_abc123"
    }
  ],
  "context_analysis": {
    "entities_extracted": ["Clerk", "Auth0"],
    "keywords_extracted": ["authentication", "decisions"],
    "suggested_filters": {
      "room": "decisions",
      "confidence": 0.3
    }
  },
  "filter_stats": {
    "total_before_threshold": 6,
    "total_after_threshold": 2,
    "min_similarity": 0.05
  }
}
```

### When to Use

| Use `memory_search` when             | Use `memory_smart_search` when      |
| ------------------------------------ | ----------------------------------- |
| Need complete verbatim text          | Need quick context-efficient lookup |
| Searching for specific code snippets | Exploring what's in memory          |
| Already know wing/room filters       | Want relevance filtering            |
| High confidence in query terms       | Unsure what terms to use            |

---

## Smart Retriever Module

The `smart_retriever.py` module implements intelligent retrieval:

### Context Extraction

```python
def extract_entities(text: str) -> list[str]:
    """Extract names, projects, identifiers from text"""

def extract_keywords(text: str, n: int = 5) -> list[str]:
    """Extract key terms, ignoring stopwords"""
```

### Knowledge Graph Integration

```python
def get_related_entities(entity: str) -> dict:
    """Find entities related via knowledge graph"""

def detect_project_context(text: str) -> list[str]:
    """Detect project identifiers from known projects"""
```

### Progressive Retrieval

```python
def search_summaries(query, limit=3, min_similarity=0.05):
    """Get summaries first - use for initial retrieval"""

def get_full_content(drawer_id: str):
    """Get full content for specific results"""
```

---

## Prompt Guidelines

For the LLM using these tools:

1. **Use `memory_smart_search` by default** - It's context-efficient
2. **Check `memory_status` first** - Know what's in the palace
3. **Use `memory_kg_query` for entities** - Check relationships
4. **Store with `memory_add_drawer`** - File important decisions
5. **Write diary entries** - Record sessions with `memory_diary_write`

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Pi Coding Agent                       │
│                     (TypeScript)                         │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│            Memory Extension (index.ts)                   │
│    23 tools registered with Pi's tool system            │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼ spawn Python process
┌─────────────────────────────────────────────────────────┐
│          Penny Memory Bridge (Python)                    │
│      penny_memory_bridge.py + smart_retriever.py        │
└─────────────────────┬───────────────────────────────────┘
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
┌──────────────────┐    ┌──────────────────┐
│    ChromaDB      │    │  Knowledge Graph │
│  (Vector Store)  │    │    (SQLite)      │
│   532+ drawers   │    │    47 facts      │
└──────────────────┘    └──────────────────┘
```

---

## Testing

```bash
# Test smart search via bridge
echo '{"tool": "smart_search", "params": {"query": "memory search"}}' | \
  .venv/bin/python .venv/lib/python3.12/site-packages/penny_memory_bridge.py

# Test smart retriever directly
.venv/bin/python -c "
from smart_retriever import SmartRetriever
r = SmartRetriever()
print(r.smart_search('authentication', limit=3))
"
```

---

## Integration Tests

Located in `tests/`:

- `unit/extension.test.ts` - TypeScript extension tests
- `integration/mempalace.test.ts` - End-to-end tests
