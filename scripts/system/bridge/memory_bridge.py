#!/usr/bin/env python3
"""
Memory Bridge - Python bridge for MemPalace tools
Called by the TypeScript extension to interact with MemPalace

All 20 MemPalace MCP tools are available:
- Palace (read): status, list_wings, list_rooms, get_taxonomy, search, smart_search, check_duplicate, get_aaak_spec
- Palace (write): add_drawer, delete_drawer
- Knowledge Graph: kg_query, kg_add, kg_invalidate, kg_timeline, kg_stats
- Navigation: traverse, find_tunnels, graph_stats
- Agent Diary: diary_write, diary_read

Configuration:
    MEMPALACE_PATH: Override default palace path (default: ~/.mempalace/palace)
"""

import sys
import os
import json
import hashlib
from datetime import datetime
from pathlib import Path
from typing import Optional, Any

# Import mempalace modules
try:
    from mempalace.config import MempalaceConfig
    from mempalace.searcher import search_memories
    from mempalace.palace_graph import traverse, find_tunnels, graph_stats
    from mempalace.knowledge_graph import KnowledgeGraph
    import chromadb
    # Smart retriever import — prefer project copy over site-packages
    # (site-packages copy can be overwritten by pip upgrade)
    # Use sys.prefix (reliable for .venv/bin/python) instead of VIRTUAL_ENV
    # because spawned subprocesses don't inherit VIRTUAL_ENV from the parent.
    _project_root = Path(sys.prefix).parent
    _project_smart_retriever = _project_root / ".pi" / "extensions" / "memory" / "smart_retriever.py"
    if _project_smart_retriever.exists():
        sys.path.insert(0, str(_project_smart_retriever.parent))
    try:
        from smart_retriever import SmartRetriever
        SMART_RETRIEVER_AVAILABLE = True
    except ImportError:
        SMART_RETRIEVER_AVAILABLE = False
except ImportError as e:
    print(json.dumps({"error": f"MemPalace import failed: {e}", "hint": "Run: pip install mempalace"}))
    sys.exit(1)

# Initialize config and knowledge graph
_config = MempalaceConfig()
_kg = KnowledgeGraph()


def _get_collection(create: bool = False):
    """Get ChromaDB collection."""
    try:
        client = chromadb.PersistentClient(path=_config.palace_path)
        # Always use 'mempalace_drawers' to match searcher.py
        collection_name = "mempalace_drawers"
        if create:
            return client.get_or_create_collection(collection_name)
        return client.get_collection(collection_name)
    except Exception:
        return None


def _no_palace() -> dict:
    """Return error when palace doesn't exist."""
    return {
        "error": "No palace found",
        "palace_path": _config.palace_path,
        "hint": "Run: mempalace init <dir> && mempalace mine <dir>",
    }


# ==================== PALACE READ TOOLS ====================

def tool_status(params: dict) -> dict:
    """Get palace overview with drawer counts."""
    col = _get_collection()
    if not col:
        return _no_palace()
    
    count = col.count()
    wings = {}
    rooms = {}
    
    try:
        all_meta = col.get(include=["metadatas"])["metadatas"]
        for m in all_meta:
            w = m.get("wing", "unknown")
            r = m.get("room", "unknown")
            wings[w] = wings.get(w, 0) + 1
            rooms[r] = rooms.get(r, 0) + 1
    except Exception as e:
        wings["_error"] = f"Metadata scan failed: {e}"
    
    return {
        "success": True,
        "total_drawers": count,
        "wings": wings,
        "rooms": rooms,
        "palace_path": str(_config.palace_path),
    }


def tool_list_wings(params: dict) -> dict:
    """List all wings with drawer counts."""
    col = _get_collection()
    if not col:
        return _no_palace()
    
    wings = {}
    try:
        all_meta = col.get(include=["metadatas"])["metadatas"]
        for m in all_meta:
            w = m.get("wing", "unknown")
            wings[w] = wings.get(w, 0) + 1
    except Exception as e:
        wings["_error"] = f"Metadata scan failed: {e}"
    
    return {"success": True, "wings": wings}


def tool_list_rooms(params: dict) -> dict:
    """List rooms within a wing (or all rooms)."""
    col = _get_collection()
    if not col:
        return _no_palace()
    
    wing = params.get("wing")
    rooms = {}
    
    try:
        kwargs = {"include": ["metadatas"]}
        if wing:
            kwargs["where"] = {"wing": wing}
        all_meta = col.get(**kwargs)["metadatas"]
        for m in all_meta:
            r = m.get("room", "unknown")
            rooms[r] = rooms.get(r, 0) + 1
    except Exception:
        pass
    
    return {"success": True, "wing": wing or "all", "rooms": rooms}


def tool_get_taxonomy(params: dict) -> dict:
    """Get full taxonomy: wing -> room -> count."""
    col = _get_collection()
    if not col:
        return _no_palace()
    
    taxonomy = {}
    try:
        all_meta = col.get(include=["metadatas"])["metadatas"]
        for m in all_meta:
            w = m.get("wing", "unknown")
            r = m.get("room", "unknown")
            if w not in taxonomy:
                taxonomy[w] = {}
            taxonomy[w][r] = taxonomy[w].get(r, 0) + 1
    except Exception:
        pass
    
    return {"success": True, "taxonomy": taxonomy}


def tool_search(params: dict) -> dict:
    """Semantic search with optional wing/room filter."""
    query = params.get("query", "")
    limit = int(params.get("limit", 5))
    wing = params.get("wing")
    room = params.get("room")
    
    if not query:
        return {"error": "Query is required"}
    
    try:
        results = search_memories(
            query,
            palace_path=_config.palace_path,
            wing=wing,
            room=room,
            n_results=limit,
        )
        return {"success": True, "results": results}
    except Exception as e:
        return {"error": str(e)}


def tool_smart_search(params: dict) -> dict:
    """
    Context-aware memory search that minimizes context usage.
    
    Features:
    - Extracts entities and keywords from query
    - Uses knowledge graph for related entities  
    - Suggests wing/room filters based on context
    - Returns summaries (truncated) not full content
    - Filters by minimum similarity threshold (default 0.25, uses 1/(1+L2dist) mapping)
    - Lower default limit (3 vs 5)
    
    Use this instead of search() for context-efficient retrieval.
    """
    if not SMART_RETRIEVER_AVAILABLE:
        return {"error": "Smart retriever not available", "hint": "Check smart_retriever.py is in Python path"}
    
    query = params.get("query", "")
    context = params.get("context")
    wing = params.get("wing")
    room = params.get("room")
    limit = int(params.get("limit", 3))  # Lower default
    include_full = params.get("include_full", False)
    min_similarity = params.get("min_similarity", 0.25)  # L2-similarity scale [0,1]
    
    if not query:
        return {"error": "Query is required"}
    
    try:
        retriever = SmartRetriever({
            "palace_path": str(_config.palace_path),
            "kg_path": str(Path.home() / ".mempalace" / "knowledge_graph.sqlite3"),
            "default_limit": limit,
            "min_similarity": min_similarity,
        })
        
        results = retriever.smart_search(
            query=query,
            context=context,
            wing=wing,
            room=room,
            limit=limit,
            include_full=include_full,
        )
        
        # Convert to expected format
        formatted_results = []
        for hit in results.get("results", []):
            formatted_results.append({
                "text": hit.get("full_content") if include_full else hit["summary"],
                "summary": hit["summary"],
                "wing": hit["wing"],
                "room": hit["room"],
                "source_file": hit["source_file"],
                "similarity": hit["similarity"],
                "id": hit.get("id"),
            })
        
        return {
            "success": True,
            "query": query,
            "results": formatted_results,
            "context_analysis": results.get("context_analysis", {}),
            "filter_stats": {
                "total_before_threshold": results.get("total_before_threshold", 0),
                "total_after_threshold": results.get("total_after_threshold", 0),
                "min_similarity": min_similarity,
            },
        }
    except Exception as e:
        import traceback
        return {"error": str(e), "traceback": traceback.format_exc()}


def tool_check_duplicate(params: dict) -> dict:
    """Check for duplicate content before filing."""
    col = _get_collection()
    if not col:
        return _no_palace()
    
    content = params.get("content", "")
    threshold = params.get("threshold", 0.9)
    
    if not content:
        return {"error": "Content is required"}
    
    try:
        results = col.query(
            query_texts=[content],
            n_results=5,
            include=["metadatas", "documents", "distances"],
        )
        duplicates = []
        
        if results["ids"] and results["ids"][0]:
            for i, drawer_id in enumerate(results["ids"][0]):
                dist = results["distances"][0][i]
                similarity = round(1.0 / (1.0 + dist), 3)
                if similarity >= threshold:
                    meta = results["metadatas"][0][i]
                    doc = results["documents"][0][i]
                    duplicates.append({
                        "id": drawer_id,
                        "wing": meta.get("wing", "?"),
                        "room": meta.get("room", "?"),
                        "similarity": similarity,
                        "content": doc[:200] + "..." if len(doc) > 200 else doc,
                    })
        
        return {
            "success": True,
            "is_duplicate": len(duplicates) > 0,
            "matches": duplicates,
        }
    except Exception as e:
        return {"error": str(e)}


def tool_get_aaak_spec(params: dict) -> dict:
    """Return the AAAK dialect specification."""
    aaak_spec = """AAAK is a compressed memory dialect that MemPalace uses for efficient storage.
It is designed to be readable by both humans and LLMs without decoding.

FORMAT:
  ENTITIES: 3-letter uppercase codes. ALC=Alice, JOR=Jordan, RIL=Riley, MAX=Max, BEN=Ben.
  EMOTIONS: *action markers* before/during text. *warm*=joy, *fierce*=determined, *raw*=vulnerable, *bloom*=tenderness.
  STRUCTURE: Pipe-separated fields. FAM: family | PROJ: projects | ⚠: warnings/reminders.
  DATES: ISO format (2026-03-31). COUNTS: Nx = N mentions (e.g., 570x).
  IMPORTANCE: ★ to ★★★★★ (1-5 scale).
  HALLS: hall_facts, hall_events, hall_discoveries, hall_preferences, hall_advice.
  WINGS: wing_user, wing_agent, wing_team, wing_code, wing_myproject, wing_hardware, wing_ue5, wing_ai_research.
  ROOMS: Hyphenated slugs representing named ideas (e.g., chromedb-setup, gpu-pricing).

EXAMPLE:
  FAM: ALC→♡JOR | 2D(kids): RIL(18,sports) MAX(11,chess+swimming) | BEN(contributor)

Read AAAK naturally — expand codes mentally, treat *markers* as emotional context.
When WRITING AAAK: use entity codes, mark emotions, keep structure tight."""

    palace_protocol = """IMPORTANT — MemPalace Memory Protocol:
1. ON WAKE-UP: Call mempalace_status to load palace overview + AAAK spec.
2. BEFORE RESPONDING about any person, project, or past event: call mempalace_kg_query or mempalace_search FIRST. Never guess — verify.
3. IF UNSURE about a fact (name, gender, age, relationship): say "let me check" and query the palace. Wrong is worse than slow.
4. AFTER EACH SESSION: call mempalace_diary_write to record what happened, what you learned, what matters.
5. WHEN FACTS CHANGE: call mempalace_kg_invalidate on the old fact, mempalace_kg_add for the new one.

This protocol ensures the AI KNOWS before it speaks. Storage is not memory — but storage + this protocol = memory."""

    return {
        "success": True,
        "aaak_spec": aaak_spec,
        "palace_protocol": palace_protocol,
    }


# ==================== PALACE WRITE TOOLS ====================

def tool_list_drawers(params: dict) -> dict:
    """List drawer IDs and metadata, filtered by wing and/or room."""
    col = _get_collection()
    if not col:
        return _no_palace()
    
    wing = params.get("wing")
    room = params.get("room")
    limit = min(int(params.get("limit", 1000)), 10000)
    
    where = {}
    if wing and room:
        where = {"$and": [{"wing": wing}, {"room": room}]}
    elif wing:
        where = {"wing": wing}
    elif room:
        where = {"room": room}
    
    try:
        kwargs = {
            "where": where,
            "include": ["metadatas"],
            "limit": limit,
        } if where else {"include": ["metadatas"], "limit": limit}
        results = col.get(**kwargs)
        
        drawers = []
        for i, doc_id in enumerate(results["ids"]):
            meta = results["metadatas"][i] if results["metadatas"] else {}
            drawers.append({
                "id": doc_id,
                "wing": meta.get("wing", ""),
                "room": meta.get("room", ""),
                "source_file": meta.get("source_file", ""),
            })
        
        return {"success": True, "drawers": drawers, "count": len(drawers)}
    except Exception as e:
        return {"error": str(e)}


def tool_delete_drawers_by_room(params: dict) -> dict:
    """Bulk delete all drawers in a specific wing/room combination. Irreversible."""
    wing = params.get("wing")
    room = params.get("room")
    
    if not wing or not room:
        return {"error": "Both wing and room are required for bulk delete"}
    
    col = _get_collection()
    if not col:
        return _no_palace()
    
    try:
        results = col.get(
            where={"$and": [{"wing": wing}, {"room": room}]},
            include=[]
        )
        ids = results["ids"]
        deleted_count = 0
        if ids:
            try:
                col.delete(ids=ids)
                deleted_count = len(ids)
            except Exception as delete_err:
                # Partial delete possible — count what survived
                remaining = col.get(
                    where={"$and": [{"wing": wing}, {"room": room}]},
                    include=[]
                )
                deleted_count = len(ids) - len(remaining["ids"])
                return {
                    "success": False,
                    "error": f"Partial delete: {delete_err}",
                    "deleted_count": deleted_count,
                    "total_attempted": len(ids),
                    "wing": wing,
                    "room": room,
                }
        
        return {
            "success": True,
            "deleted_count": deleted_count,
            "wing": wing,
            "room": room,
        }
    except Exception as e:
        return {"error": str(e)}


def tool_add_drawer(params: dict) -> dict:
    """File verbatim content into the palace."""
    col = _get_collection(create=True)
    if not col:
        return _no_palace()
    
    wing = params.get("wing", "wing_general")
    room = params.get("room", "general")
    content = params.get("content", "")
    source_file = params.get("source_file", "")
    added_by = params.get("added_by", "penny")
    
    if not content:
        return {"error": "Content is required"}
    
    # Check for duplicates
    dup = tool_check_duplicate({"content": content, "threshold": 0.9})
    if dup.get("is_duplicate"):
        return {
            "success": False,
            "reason": "duplicate",
            "matches": dup["matches"],
        }
    
    # Generate drawer ID
    drawer_id = f"drawer_{wing}_{room}_{hashlib.md5((content[:100] + datetime.now().isoformat()).encode()).hexdigest()[:16]}"
    
    try:
        col.add(
            ids=[drawer_id],
            documents=[content],
            metadatas=[{
                "wing": wing,
                "room": room,
                "source_file": source_file,
                "chunk_index": 0,
                "added_by": added_by,
                "filed_at": datetime.now().isoformat(),
            }],
        )
        return {
            "success": True,
            "drawer_id": drawer_id,
            "wing": wing,
            "room": room,
        }
    except Exception as e:
        return {"error": str(e)}


def tool_delete_drawer(params: dict) -> dict:
    """Delete a drawer by ID."""
    col = _get_collection()
    if not col:
        return _no_palace()
    
    drawer_id = params.get("drawer_id")
    if not drawer_id:
        return {"error": "drawer_id is required"}
    
    try:
        existing = col.get(ids=[drawer_id])
        if not existing["ids"]:
            return {"success": False, "error": f"Drawer not found: {drawer_id}"}
        
        col.delete(ids=[drawer_id])
        return {"success": True, "drawer_id": drawer_id}
    except Exception as e:
        return {"error": str(e)}


# ==================== KNOWLEDGE GRAPH TOOLS ====================

def tool_kg_query(params: dict) -> dict:
    """Query knowledge graph for entity relationships."""
    entity = params.get("entity")
    if not entity:
        return {"error": "entity is required"}
    
    as_of = params.get("as_of")
    direction = params.get("direction", "both")
    
    try:
        results = _kg.query_entity(entity, as_of=as_of, direction=direction)
        return {
            "success": True,
            "entity": entity,
            "as_of": as_of,
            "facts": results,
            "count": len(results),
        }
    except Exception as e:
        return {"error": str(e)}


def tool_kg_add(params: dict) -> dict:
    """Add a fact to the knowledge graph."""
    subject = params.get("subject")
    predicate = params.get("predicate")
    obj = params.get("object")
    
    if not all([subject, predicate, obj]):
        return {"error": "subject, predicate, and object are required"}
    
    valid_from = params.get("valid_from")
    source_closet = params.get("source_closet")
    
    try:
        triple_id = _kg.add_triple(subject, predicate, obj, valid_from=valid_from, source_closet=source_closet)
        return {
            "success": True,
            "triple_id": triple_id,
            "fact": f"{subject} → {predicate} → {obj}",
        }
    except Exception as e:
        return {"error": str(e)}


def tool_kg_invalidate(params: dict) -> dict:
    """Mark a fact as no longer true."""
    subject = params.get("subject")
    predicate = params.get("predicate")
    obj = params.get("object")
    
    if not all([subject, predicate, obj]):
        return {"error": "subject, predicate, and object are required"}
    
    ended = params.get("ended")
    
    try:
        _kg.invalidate(subject, predicate, obj, ended=ended)
        return {
            "success": True,
            "fact": f"{subject} → {predicate} → {obj}",
            "ended": ended or "today",
        }
    except Exception as e:
        return {"error": str(e)}


def tool_kg_timeline(params: dict) -> dict:
    """Get chronological timeline of facts."""
    entity = params.get("entity")
    
    try:
        results = _kg.timeline(entity)
        return {
            "success": True,
            "entity": entity or "all",
            "timeline": results,
            "count": len(results),
        }
    except Exception as e:
        return {"error": str(e)}


def tool_kg_stats(params: dict) -> dict:
    """Knowledge graph statistics."""
    try:
        stats = _kg.stats()
        return {"success": True, "stats": stats}
    except Exception as e:
        return {"error": str(e)}


# ==================== NAVIGATION TOOLS ====================

def tool_traverse(params: dict) -> dict:
    """Walk the palace graph from a room."""
    col = _get_collection()
    if not col:
        return _no_palace()
    
    start_room = params.get("start_room")
    if not start_room:
        return {"error": "start_room is required"}
    
    max_hops = params.get("max_hops", 2)
    
    try:
        result = traverse(start_room, col=col, max_hops=max_hops)
        return {"success": True, "result": result}
    except Exception as e:
        return {"error": str(e)}


def tool_find_tunnels(params: dict) -> dict:
    """Find rooms that bridge two wings."""
    col = _get_collection()
    if not col:
        return _no_palace()
    
    wing_a = params.get("wing_a")
    wing_b = params.get("wing_b")
    
    try:
        result = find_tunnels(wing_a, wing_b, col=col)
        return {"success": True, "tunnels": result}
    except Exception as e:
        return {"error": str(e)}


def tool_graph_stats(params: dict) -> dict:
    """Palace graph overview."""
    col = _get_collection()
    if not col:
        return _no_palace()
    
    try:
        stats = graph_stats(col=col)
        return {"success": True, "stats": stats}
    except Exception as e:
        return {"error": str(e)}


# ==================== AGENT DIARY TOOLS ====================

def tool_diary_write(params: dict) -> dict:
    """Write an agent diary entry."""
    col = _get_collection(create=True)
    if not col:
        return _no_palace()
    
    agent_name = params.get("agent_name")
    entry = params.get("entry")
    
    if not agent_name or not entry:
        return {"error": "agent_name and entry are required"}
    
    topic = params.get("topic", "general")
    wing = f"wing_{agent_name.lower().replace(' ', '_')}"
    room = "diary"
    
    now = datetime.now()
    entry_id = f"diary_{wing}_{now.strftime('%Y%m%d_%H%M%S')}_{hashlib.md5(entry[:50].encode()).hexdigest()[:8]}"
    
    try:
        col.add(
            ids=[entry_id],
            documents=[entry],
            metadatas=[{
                "wing": wing,
                "room": room,
                "hall": "hall_diary",
                "topic": topic,
                "type": "diary_entry",
                "agent": agent_name,
                "filed_at": now.isoformat(),
                "date": now.strftime("%Y-%m-%d"),
            }],
        )
        return {
            "success": True,
            "entry_id": entry_id,
            "agent": agent_name,
            "topic": topic,
            "timestamp": now.isoformat(),
        }
    except Exception as e:
        return {"error": str(e)}


def tool_diary_read(params: dict) -> dict:
    """Read agent diary entries."""
    col = _get_collection()
    if not col:
        return _no_palace()
    
    agent_name = params.get("agent_name")
    if not agent_name:
        return {"error": "agent_name is required"}
    
    last_n = params.get("last_n", 10)
    wing = f"wing_{agent_name.lower().replace(' ', '_')}"
    
    try:
        results = col.get(
            where={"$and": [{"wing": wing}, {"room": "diary"}]},
            include=["documents", "metadatas"],
        )
        
        if not results["ids"]:
            return {"success": True, "agent": agent_name, "entries": [], "message": "No diary entries yet."}
        
        # Sort by timestamp
        entries = []
        for doc, meta in zip(results["documents"], results["metadatas"]):
            entries.append({
                "date": meta.get("date", ""),
                "timestamp": meta.get("filed_at", ""),
                "topic": meta.get("topic", ""),
                "content": doc,
            })
        
        entries.sort(key=lambda x: x["timestamp"], reverse=True)
        entries = entries[:last_n]
        
        return {
            "success": True,
            "agent": agent_name,
            "entries": entries,
            "total": len(results["ids"]),
            "showing": len(entries),
        }
    except Exception as e:
        return {"error": str(e)}


# ==================== DISPATCH ====================

TOOL_HANDLERS = {
    "status": tool_status,
    "list_wings": tool_list_wings,
    "list_rooms": tool_list_rooms,
    "get_taxonomy": tool_get_taxonomy,
    "search": tool_search,
    "smart_search": tool_smart_search,
    "check_duplicate": tool_check_duplicate,
    "get_aaak_spec": tool_get_aaak_spec,
    "list_drawers": tool_list_drawers,
    "delete_drawers_by_room": tool_delete_drawers_by_room,
    "add_drawer": tool_add_drawer,
    "delete_drawer": tool_delete_drawer,
    "kg_query": tool_kg_query,
    "kg_add": tool_kg_add,
    "kg_invalidate": tool_kg_invalidate,
    "kg_timeline": tool_kg_timeline,
    "kg_stats": tool_kg_stats,
    "traverse": tool_traverse,
    "find_tunnels": tool_find_tunnels,
    "graph_stats": tool_graph_stats,
    "diary_write": tool_diary_write,
    "diary_read": tool_diary_read,
}


def handle_request(request: dict) -> dict:
    """Handle a tool request."""
    tool_name = request.get("tool")
    params = request.get("params", {})
    
    if tool_name not in TOOL_HANDLERS:
        return {"success": False, "error": f"Unknown tool: {tool_name}. Available: {list(TOOL_HANDLERS.keys())}"}
    
    handler = TOOL_HANDLERS[tool_name]
    result = handler(params)
    return result


def main():
    """Main entry point - reads JSON from stdin, writes JSON to stdout."""
    try:
        request = json.load(sys.stdin)
        result = handle_request(request)
        print(json.dumps(result))
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON: {e}"}))
    except Exception as e:
        print(json.dumps({"error": f"Error: {e}"}))


if __name__ == "__main__":
    main()