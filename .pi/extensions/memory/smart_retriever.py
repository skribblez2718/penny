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
        """Semantic memory search over the vector store (Bitter-Lesson #12).

        The embedding IS the router. There is no keyword room-guessing and no
        regex entity/stopword layer in front of ChromaDB anymore: retrieval spans
        ALL rooms by relevance unless the caller passes an explicit ``wing``/
        ``room`` filter, so a paraphrase can no longer be silently mis-routed to
        the wrong room. Any ``context`` is folded into the embedded query as free
        text — the vector store handles entities, paraphrase, and languages
        natively.

        Args:
            query: The search query.
            context: Optional free-text context, embedded alongside the query.
            wing/room: Optional explicit metadata filters (honored as-is).
            limit: Max results (default 3).
            include_full: Return full content instead of summary.
        """
        limit = limit or self.config["default_limit"]

        # The embedding query is the raw query, optionally enriched with free-text
        # context. No regex entity mutation, no keyword room routing.
        ctx = (context or "").strip()
        enhanced_query = f"{query}\n\n{ctx}" if ctx else query

        results = self.search_summaries(
            enhanced_query,
            wing=wing,
            room=room,
            limit=limit,
        )

        # Optionally expand to full content
        if include_full and results.get("results"):
            for hit in results["results"]:
                if hit.get("id"):
                    full = self.get_full_content(hit["id"])
                    if "content" in full:
                        hit["full_content"] = full["content"]

        results["context_analysis"] = {
            "effective_filters": {"wing": wing, "room": room},
            "query_enhanced": enhanced_query != query,
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
