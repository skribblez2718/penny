#!/usr/bin/env python3
"""
smart_retriever.py — Context-Aware Memory Retrieval

Intelligent memory search that:
1. Extracts context from current query/conversation
2. Uses knowledge graph to find related entities
3. Auto-selects relevant wings/rooms
4. Filters by relevance threshold
5. Returns summaries instead of full text
6. Implements progressive retrieval

The problem with blind search:
- 532 drawers, many irrelevant
- Negative similarity scores returned
- Full verbatim text consuming context window
- No awareness of current conversation focus

The solution:
- Build focused queries from context
- Use knowledge graph for entity relationships
- Threshold filtering (discard low relevance)
- Summary mode for initial results
- Progressive expansion when needed
"""

import json
import re
import sys
from pathlib import Path

import chromadb

# Try to use MemPalaceConfig for correct path
try:
    from mempalace.config import MempalaceConfig
    MEMPALACE_AVAILABLE = True
except ImportError:
    MEMPALACE_AVAILABLE = False

# Chunk reassembly — shared single source of truth in the bridge. get_full_content
# must return a drawer's WHOLE content, not just the matched/first chunk. The
# bridge dir is derived from this file's location so it also resolves standalone.
try:
    from chunk_reassembly import reassemble_rows
except ImportError:  # pragma: no cover - import-context robustness
    _bridge_dir = Path(__file__).resolve().parents[3] / "scripts" / "system" / "bridge"
    if str(_bridge_dir) not in sys.path:
        sys.path.insert(0, str(_bridge_dir))
    from chunk_reassembly import reassemble_rows

# Configuration
DEFAULT_CONFIG = {
    "palace_path": None,  # Set via environment or default
    "kg_path": None,
    "collection_name": "mempalace_drawers",  # Primary collection name
    "default_limit": 3,  # Lower default than 5
    "min_similarity": 0.25,  # Filter out noise (low L2-similarity results). 0.25 ≈ L2 distance > 3.0
    "summary_max_chars": 200,  # Truncate for summaries
    "context_window_keywords": 5,  # Extract top N keywords from context
    "max_hops": 2,  # For knowledge graph traversal
    "query_multiplier": 3,  # Over-fetch from ChromaDB for threshold filtering (3x limit, capped at 100)
}

# Keyword -> room mapping for suggest_wing_room. Dict order is significant: the
# first room whose first matching keyword appears in the query wins.
_ROOM_KEYWORDS = {
    "decisions": ["decided", "decision", "chose", "choice", "selected", "picked"],
    "architecture": ["architecture", "design", "structure", "component", "system", "pattern"],
    "technical": ["bug", "fix", "error", "issue", "implementation", "code", "function"],
    "sessions": ["session", "meeting", "discussion", "conversation", "talked"],
    "planning": ["plan", "roadmap", "goal", "milestone", "timeline", "future"],
}


class SmartRetriever:
    def __init__(self, config: dict = None):
        self.config = {**DEFAULT_CONFIG, **(config or {})}

        # Set default paths using MemPalaceConfig if available
        if MEMPALACE_AVAILABLE and not self.config.get("palace_path"):
            try:
                mp_config = MempalaceConfig()
                self.config["palace_path"] = str(mp_config.palace_path)
            except Exception:
                pass

        # Fallback to default if still not set
        if not self.config.get("palace_path"):
            self.config["palace_path"] = str(Path.home() / ".mempalace")

        if not self.config.get("kg_path"):
            self.config["kg_path"] = str(Path(self.config["palace_path"]).parent / "knowledge_graph.sqlite3")

        self._collection = None
        self._kg_conn = None

    def _get_collection(self):
        """Lazy-load ChromaDB collection."""
        if self._collection is None:
            try:
                client = chromadb.PersistentClient(path=self.config["palace_path"])
                collection_name = self.config.get("collection_name", "mempalace_drawers")
                self._collection = client.get_collection(collection_name)
            except Exception:
                return None
        return self._collection

    def _get_kg(self):
        """Lazy-load knowledge graph connection."""
        if self._kg_conn is None:
            import sqlite3
            kg_path = Path(self.config["kg_path"])
            if kg_path.exists():
                self._kg_conn = sqlite3.connect(str(kg_path))
        return self._kg_conn

    # ─── Context Extraction ──────────────────────────────────────────────

    def extract_entities(self, text: str) -> list[str]:
        """Extract potential entities from text using patterns."""
        entities = []

        # Capitalized words (names, projects)
        caps = re.findall(r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b', text)
        entities.extend(caps)

        # CamelCase and snake_case identifiers
        identifiers = re.findall(r'\b[a-z]+(?:[A-Z][a-z]+)+\b|\b[a-z]+(?:_[a-z]+)+\b', text)
        entities.extend(identifiers)

        # Quoted strings
        quoted = re.findall(r'"([^"]+)"|\'([^\']+)\'', text)
        for q in quoted:
            entities.extend([x for x in q if x])

        # Remove common words
        stopwords = {'The', 'This', 'That', 'These', 'Those', 'What', 'When', 'Where', 'Why', 'How'}
        entities = [e for e in entities if e not in stopwords and len(e) > 2]

        return list(set(entities))

    def extract_keywords(self, text: str, n: int = None) -> list[str]:
        """Extract key terms from text for search query."""
        n = n or self.config["context_window_keywords"]

        # Remove common words
        stopwords = {
            'the', 'a', 'an', 'is', 'it', 'to', 'for', 'of', 'and', 'or', 'in',
            'on', 'at', 'by', 'with', 'from', 'that', 'this', 'be', 'are', 'was',
            'were', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
            'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall',
            'can', 'need', 'dare', 'ought', 'used', 'get', 'got', 'getting',
            'how', 'what', 'when', 'where', 'why', 'who', 'which', 'whom', 'whose',
            'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'him', 'his',
            'she', 'her', 'they', 'them', 'their', 'it', 'its', 's', 't', 'll',
            've', 're', 'd', 'm', 'o', 'y', 'ain', 'aren', 'couldn', 'didn',
            'doesn', 'hadn', 'hasn', 'haven', 'isn', 'ma', 'mightn', 'mustn',
            'needn', 'shan', 'shouldn', 'wasn', 'weren', 'won', 'wouldn',
        }

        # Tokenize and filter
        words = re.findall(r'\b[a-zA-Z]{3,}\b', text.lower())
        keywords = [w for w in words if w not in stopwords]

        # Count frequency
        from collections import Counter
        counts = Counter(keywords)

        return [w for w, _ in counts.most_common(n)]

    # ─── Knowledge Graph Integration ──────────────────────────────────────

    def get_related_entities(self, entity: str) -> dict:
        """Find entities related to this one via knowledge graph."""
        kg = self._get_kg()
        if not kg:
            return {"entity": entity, "related": [], "relationships": []}

        entity_id = entity.lower().replace(" ", "_")

        try:
            # Find outgoing relationships
            cursor = kg.execute(
                """
                SELECT t.predicate, e.name as obj_name, t.valid_to IS NULL as current
                FROM triples t
                JOIN entities e ON t.object = e.id
                WHERE t.subject = ? AND (t.valid_to IS NULL OR t.valid_to >= date('now'))
                ORDER BY t.valid_from DESC
                """,
                (entity_id,)
            )
            outgoing = cursor.fetchall()

            # Find incoming relationships
            cursor = kg.execute(
                """
                SELECT t.predicate, e.name as sub_name, t.valid_to IS NULL as current
                FROM triples t
                JOIN entities e ON t.subject = e.id
                WHERE t.object = ? AND (t.valid_to IS NULL OR t.valid_to >= date('now'))
                ORDER BY t.valid_from DESC
                """,
                (entity_id,)
            )
            incoming = cursor.fetchall()

            related = set()
            relationships = []

            for pred, name, current in outgoing:
                related.add(name)
                relationships.append(f"{entity} → {pred} → {name}")

            for pred, name, current in incoming:
                related.add(name)
                relationships.append(f"{name} → {pred} → {entity}")

            return {
                "entity": entity,
                "related": list(related),
                "relationships": relationships,
            }
        except Exception:
            return {"entity": entity, "related": [], "relationships": []}

    def detect_project_context(self, text: str) -> list[str]:
        """Detect project names/identifiers from context."""
        # Check knowledge graph for known projects
        kg = self._get_kg()
        if not kg:
            return []

        entities = self.extract_entities(text)
        projects = []

        try:
            for entity in entities:
                entity_id = entity.lower().replace(" ", "_")
                # Check if entity has works_on relationship
                cursor = kg.execute(
                    """
                    SELECT e.name FROM triples t
                    JOIN entities e ON t.object = e.id
                    WHERE t.subject = ? AND t.predicate = 'works_on'
                    UNION
                    SELECT e.name FROM triples t
                    JOIN entities e ON t.subject = e.id
                    WHERE t.object = ? AND t.predicate = 'works_on'
                    """,
                    (entity_id, entity_id)
                )
                for row in cursor.fetchall():
                    projects.append(row[0])
        except Exception:
            pass

        return list(set(projects))

    # ─── Wing/Room Detection ───────────────────────────────────────────────

    def _entity_relationship_reasoning(self, entities: list[str]) -> list[str]:
        """Reasoning lines for the top-5 entities that have known KG relationships."""
        reasoning = []
        for entity in entities[:5]:  # Check top 5
            related = self.get_related_entities(entity)
            if related["relationships"]:
                reasoning.append(
                    f"Entity '{entity}' has relationships: {related['relationships'][:3]}"
                )
        return reasoning

    @staticmethod
    def _room_from_keywords(keywords: list[str]):
        """Return (room, reasoning) for the first room in _ROOM_KEYWORDS order whose
        first matching keyword appears in ``keywords``; None when nothing matches."""
        for room, kws in _ROOM_KEYWORDS.items():
            for kw in kws:
                if kw in keywords:
                    return room, f"Keyword '{kw}' suggests room '{room}'"
        return None

    def _known_entity_reasoning(self, entities: list[str]) -> list[str]:
        """Reasoning lines for the top-5 entities that exist in the knowledge graph."""
        kg = self._get_kg()
        reasoning = []
        if kg and entities:
            try:
                # Check if any entity is in a known wing
                for entity in entities[:5]:
                    cursor = kg.execute(
                        "SELECT name FROM entities WHERE name = ? OR id = ?",
                        (entity, entity.lower().replace(" ", "_"))
                    )
                    if cursor.fetchone():
                        # Could check for wing metadata here
                        reasoning.append(f"Entity '{entity}' is known")
            except Exception:
                pass
        return reasoning

    def suggest_wing_room(self, query: str, context: str = None) -> dict:
        """
        Suggest wing/room filters based on query and context.
        Returns recommended filters and reasoning.

        Reasoning is appended in a fixed order: relationships -> room -> known
        entities. Confidence increments by 0.3 exactly once, when a room match
        is found.
        """
        full_text = f"{query} {context or ''}"
        entities = self.extract_entities(full_text)
        keywords = self.extract_keywords(full_text)

        suggestions = {
            "wing": None,
            "room": None,
            "confidence": 0,
            "reasoning": [],
            "entities_found": entities,
            "keywords_found": keywords,
        }

        # Check knowledge graph for known entities (relationship reasoning)
        suggestions["reasoning"].extend(self._entity_relationship_reasoning(entities))

        # Keyword-based room detection
        room_match = self._room_from_keywords(keywords)
        if room_match:
            room, reason = room_match
            suggestions["room"] = room
            suggestions["confidence"] += 0.3
            suggestions["reasoning"].append(reason)

        # Wing detection from entity/project names (known-entity reasoning)
        suggestions["reasoning"].extend(self._known_entity_reasoning(entities))

        return suggestions

    # ─── Progressive Retrieval ──────────────────────────────────────────────

    @staticmethod
    def _l2_to_similarity(distance: float) -> float:
        """
        Convert ChromaDB L2 distance to a [0,1] similarity score.
        L2 distance is in [0, ∞); use 1/(1+d) to map to (0,1].
        A distance of 0 → similarity 1.0 (exact match).
        A distance of 1.0 → similarity 0.5.
        A distance of 2.0 → similarity 0.33.
        Guards against NaN and negative distances (return 0.0).
        """
        if not isinstance(distance, (int, float)) or distance != distance or distance < 0:
            return 0.0
        return round(1.0 / (1.0 + float(distance)), 3)

    @staticmethod
    def _build_where(wing: str = None, room: str = None) -> dict:
        """Build the ChromaDB metadata filter for the given wing/room combo."""
        if wing and room:
            return {"$and": [{"wing": wing}, {"room": room}]}
        if wing:
            return {"wing": wing}
        if room:
            return {"room": room}
        return {}

    def _summarize_hits(self, results: dict, min_similarity: float) -> list[dict]:
        """Convert a ChromaDB query result into threshold-filtered summary hits."""
        docs = results["documents"][0]
        metas = results["metadatas"][0]
        dists = results["distances"][0]
        ids = results["ids"][0]
        max_chars = self.config["summary_max_chars"]

        hits = []
        for idx, (doc, meta, dist) in enumerate(zip(docs, metas, dists)):
            similarity = self._l2_to_similarity(dist)
            if similarity < min_similarity:
                continue  # Skip low-relevance results

            # Create summary
            summary = doc[:max_chars]
            if len(doc) > max_chars:
                summary += "..."

            drawer_id = ids[idx] if idx < len(ids) else None
            hits.append({
                "summary": summary,
                "similarity": similarity,
                "wing": meta.get("wing", "unknown"),
                "room": meta.get("room", "unknown"),
                "source_file": Path(meta.get("source_file", "?")).name,
                "id": drawer_id,
            })
        return hits

    def search_summaries(
        self,
        query: str,
        wing: str = None,
        room: str = None,
        limit: int = None,
        min_similarity: float = None,
    ) -> dict:
        """
        Search and return summaries (truncated content).
        Use this for initial retrieval to minimize context usage.
        """
        limit = limit or self.config["default_limit"]
        min_similarity = min_similarity if min_similarity is not None else self.config["min_similarity"]

        col = self._get_collection()
        if not col:
            return {"error": "No palace found", "results": []}

        # Build where filter
        where = self._build_where(wing, room)

        # Query
        kwargs = {
            "query_texts": [query],
            "n_results": min(limit * self.config.get("query_multiplier", 3), 100),  # Over-fetch for threshold filtering; capped at 100
            "include": ["documents", "metadatas", "distances"],
        }
        if where:
            kwargs["where"] = where

        try:
            results = col.query(**kwargs)
        except Exception as e:
            return {"error": str(e), "results": []}

        hits = self._summarize_hits(results, min_similarity)

        return {
            "query": query,
            "filters": {"wing": wing, "room": room},
            "min_similarity": min_similarity,
            "results": hits[:limit],  # Trim to requested limit
            "total_before_threshold": len(results["documents"][0]),
            "total_after_threshold": len(hits),
        }

    def get_full_content(self, drawer_id: str) -> dict:
        """
        Get full content for a drawer by ID.
        Use this after search_summaries to expand specific results.

        Reassembles chunked drawers: a search hit's id is a single chunk (chunk 0
        of a large drawer), so this resolves the drawer_key and concatenates ALL
        sibling chunks in chunk_index order via the shared reassemble_rows helper
        — otherwise "full content" would silently be only the first ~2000 chars.
        """
        col = self._get_collection()
        if not col:
            return {"error": "No palace found"}

        try:
            # Resolve the drawer_key so we can gather every sibling chunk. Fall
            # back to the single row when there is no key (unchunked / legacy).
            head = col.get(ids=[drawer_id], include=["metadatas"])
            if not head["ids"]:
                return {"error": f"Drawer not found: {drawer_id}"}
            drawer_key = (head["metadatas"][0] or {}).get("drawer_key")
            if drawer_key:
                siblings = col.get(
                    where={"drawer_key": drawer_key},
                    include=["documents", "metadatas"],
                )
                logical = reassemble_rows(
                    siblings.get("ids") or [],
                    siblings.get("documents") or [],
                    siblings.get("metadatas") or [],
                )
                if logical:
                    return {
                        "id": drawer_id,
                        "content": logical[0]["content"],
                        "metadata": logical[0]["metadata"],
                    }
            single = col.get(ids=[drawer_id], include=["documents", "metadatas"])
            return {
                "id": drawer_id,
                "content": single["documents"][0],
                "metadata": single["metadatas"][0],
            }
        except Exception as e:
            return {"error": str(e)}

    # ─── Smart Search ─────────────────────────────────────────────────────

    def smart_search(
        self,
        query: str,
        context: str = None,
        wing: str = None,
        room: str = None,
        limit: int = None,
        include_full: bool = False,
    ) -> dict:
        """
        Intelligent search that:
        1. Extracts context-aware query terms
        2. Suggests wing/room filters
        3. Returns summaries (or full content)
        4. Filters by relevance threshold

        Args:
            query: The search query
            context: Additional context (e.g., recent conversation)
            wing: Optional wing filter
            room: Optional room filter
            limit: Max results (default 3)
            include_full: Return full content instead of summary

        Returns:
            Dict with results and metadata
        """
        limit = limit or self.config["default_limit"]

        # Step 1: Extract context
        full_text = f"{query} {context or ''}"
        entities = self.extract_entities(full_text)
        keywords = self.extract_keywords(full_text)

        # Step 2: Suggest filters if not provided
        suggested = None
        if not (wing and room):
            suggested = self.suggest_wing_room(query, context)

        # Use provided filters or suggestions
        effective_wing = wing or (suggested["wing"] if suggested else None)
        effective_room = room or (suggested["room"] if suggested else None)

        # Step 3: Build enhanced query using context
        enhanced_query = query
        if entities and not wing and not room:
            # Add entity context if no filters
            enhanced_query = f"{query} {' '.join(entities[:3])}"

        # Step 4: Search with summaries
        results = self.search_summaries(
            enhanced_query,
            wing=effective_wing,
            room=effective_room,
            limit=limit,
        )

        # Step 5: Optionally expand to full content
        if include_full and results.get("results"):
            for hit in results["results"]:
                if hit.get("id"):
                    full = self.get_full_content(hit["id"])
                    if "content" in full:
                        hit["full_content"] = full["content"]

        # Add metadata
        results["context_analysis"] = {
            "entities_extracted": entities[:5],
            "keywords_extracted": keywords[:5],
            "suggested_filters": suggested,
            "effective_filters": {
                "wing": effective_wing,
                "room": effective_room,
            },
            "query_enhanced": enhanced_query != query,
            "enhanced_query": enhanced_query if enhanced_query != query else None,
        }

        return results


# ─── CLI Interface ───────────────────────────────────────────────────────

def main():
    """CLI interface for smart retrieval."""
    import argparse

    parser = argparse.ArgumentParser(description="Smart Memory Retrieval")
    parser.add_argument("query", help="Search query")
    parser.add_argument("--context", "-c", help="Additional context")
    parser.add_argument("--wing", "-w", help="Wing filter")
    parser.add_argument("--room", "-r", help="Room filter")
    parser.add_argument("--limit", "-l", type=int, default=3, help="Max results")
    parser.add_argument("--full", "-f", action="store_true", help="Include full content")
    parser.add_argument("--json", "-j", action="store_true", help="JSON output")

    args = parser.parse_args()

    retriever = SmartRetriever()
    results = retriever.smart_search(
        query=args.query,
        context=args.context,
        wing=args.wing,
        room=args.room,
        limit=args.limit,
        include_full=args.full,
    )

    if args.json:
        print(json.dumps(results, indent=2))
    else:
        print(f"\n{'='*60}")
        print(f"Smart Search Results for: {args.query}")
        print(f"{'='*60}\n")

        if results.get("context_analysis"):
            ca = results["context_analysis"]
            if ca.get("entities_extracted"):
                print(f"Entities: {', '.join(ca['entities_extracted'])}")
            if ca.get("suggested_filters"):
                sf = ca["suggested_filters"]
                if sf.get("room"):
                    print(f"Suggested room: {sf['room']}")
                if sf.get("reasoning"):
                    print(f"Reasoning: {sf['reasoning'][0]}")
            print()

        if results.get("results"):
            for i, hit in enumerate(results["results"], 1):
                print(f"[{i}] {hit['wing']} / {hit['room']}")
                print(f"    Match: {hit['similarity']}")
                print(f"    {hit['summary']}")
                print()
        else:
            print("No results found (threshold filtered)")

        if results.get("total_before_threshold"):
            print(f"\nFiltered: {results['total_before_threshold']} → {results['total_after_threshold']} (min_similarity={results.get('min_similarity', 0.25)})")


if __name__ == "__main__":
    main()
