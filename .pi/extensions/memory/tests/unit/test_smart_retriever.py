#!/usr/bin/env python3
"""
Tests for smart_retriever.SmartRetriever (the vector-search path).

  - ``search_summaries`` — ChromaDB query, similarity threshold, summary
    truncation, limit trimming, and where-filter construction.
  - ``smart_search`` (Bitter-Lesson #12) — the embedding is the router: NO
    keyword room-routing and NO regex entity mutation sit in front of the store.
    Retrieval spans all rooms unless an explicit wing/room is passed.

Determinism (no live embeddings): ``_get_collection`` is replaced with a fake
collection returning the ChromaDB nested-list shape; ``search_summaries`` is
stubbed on the instance when a smart_search test only asserts the args it passed.
"""

import sys
from pathlib import Path

import pytest

# Put the extension dir (which contains smart_retriever.py) on the path.
MEMORY_DIR = Path(__file__).resolve().parents[2]  # .pi/extensions/memory
if str(MEMORY_DIR) not in sys.path:
    sys.path.insert(0, str(MEMORY_DIR))

from smart_retriever import SmartRetriever  # noqa: E402


# ─── Test doubles ────────────────────────────────────────────────────────


class FakeCollection:
    """Stand-in for a ChromaDB collection. Records the kwargs it was queried
    with so where-filter / n_results construction can be asserted."""

    def __init__(self, response=None, raise_exc=None):
        self._response = response
        self._raise = raise_exc
        self.last_kwargs = None

    def query(self, **kwargs):
        self.last_kwargs = kwargs
        if self._raise is not None:
            raise self._raise
        return self._response


@pytest.fixture
def retriever():
    """A SmartRetriever with a stub config that never touches a real palace.
    All external boundaries are monkeypatched per-test."""
    return SmartRetriever({"palace_path": "/tmp/fake-palace-does-not-exist"})


def _chroma_response(documents, metadatas, distances, ids):
    """Build the ChromaDB nested-list response shape (one query row)."""
    return {
        "documents": [list(documents)],
        "metadatas": [list(metadatas)],
        "distances": [list(distances)],
        "ids": [list(ids)],
    }


# ─── search_summaries: guard branches ────────────────────────────────────


def test_search_summaries_no_collection_returns_error(retriever):
    retriever._get_collection = lambda: None
    result = retriever.search_summaries("anything")
    assert result == {"error": "No palace found", "results": []}


def test_search_summaries_query_exception_returns_error(retriever):
    boom = FakeCollection(raise_exc=RuntimeError("chroma exploded"))
    retriever._get_collection = lambda: boom
    result = retriever.search_summaries("anything")
    assert result == {"error": "chroma exploded", "results": []}


# ─── search_summaries: full output dict (threshold + truncation + order) ──


def test_search_summaries_full_output_dict(retriever):
    """Assert the ENTIRE returned dict: hit order, similarity mapping, summary
    truncation, threshold filtering, and the two totals."""
    long_doc = "B" * 250
    response = _chroma_response(
        documents=["short doc A", long_doc, "filtered low-relevance doc"],
        metadatas=[
            {"wing": "penny", "room": "decisions", "source_file": "/home/x/a.md"},
            {"wing": "penny", "room": "architecture", "source_file": "/home/x/b.md"},
            {"wing": "penny", "room": "sessions", "source_file": "/home/x/c.md"},
        ],
        distances=[0.0, 0.5, 3.5],  # -> similarities 1.0, 0.667, 0.222
        ids=["id-a", "id-b", "id-c"],
    )
    retriever._get_collection = lambda: FakeCollection(response=response)

    result = retriever.search_summaries("test query")

    assert result == {
        "query": "test query",
        "filters": {"wing": None, "room": None},
        "min_similarity": 0.25,
        "results": [
            {
                "summary": "short doc A",
                "similarity": 1.0,
                "wing": "penny",
                "room": "decisions",
                "source_file": "a.md",
                "id": "id-a",
            },
            {
                "summary": ("B" * 200) + "...",
                "similarity": 0.667,
                "wing": "penny",
                "room": "architecture",
                "source_file": "b.md",
                "id": "id-b",
            },
        ],
        "total_before_threshold": 3,
        "total_after_threshold": 2,
    }


def test_search_summaries_all_filtered_by_threshold(retriever):
    response = _chroma_response(
        documents=["doc1", "doc2"],
        metadatas=[
            {"wing": "w", "room": "r", "source_file": "/p/one.md"},
            {"wing": "w", "room": "r", "source_file": "/p/two.md"},
        ],
        distances=[5.0, 9.0],  # similarities 0.167, 0.1 -> both < 0.25
        ids=["1", "2"],
    )
    retriever._get_collection = lambda: FakeCollection(response=response)

    result = retriever.search_summaries("q")

    assert result["results"] == []
    assert result["total_before_threshold"] == 2
    assert result["total_after_threshold"] == 0


def test_search_summaries_summary_truncation_boundary(retriever):
    """Truncation triggers only when len(doc) STRICTLY exceeds max_chars."""
    exactly = "E" * 200  # == summary_max_chars -> NOT truncated
    over = "O" * 201  # -> truncated to 200 chars + "..."
    response = _chroma_response(
        documents=[exactly, over],
        metadatas=[
            {"wing": "w", "room": "r", "source_file": "/p/e.md"},
            {"wing": "w", "room": "r", "source_file": "/p/o.md"},
        ],
        distances=[0.0, 0.0],
        ids=["e", "o"],
    )
    retriever._get_collection = lambda: FakeCollection(response=response)

    result = retriever.search_summaries("q")

    assert result["results"][0]["summary"] == exactly
    assert result["results"][1]["summary"] == ("O" * 200) + "..."


def test_search_summaries_limit_trims_after_counting(retriever):
    """results is trimmed to limit, but total_after_threshold counts ALL hits
    that passed the threshold (trim happens after counting)."""
    response = _chroma_response(
        documents=["a", "b", "c", "d"],
        metadatas=[{"wing": "w", "room": "r", "source_file": f"/p/{n}.md"} for n in "abcd"],
        distances=[0.0, 0.0, 0.0, 0.0],
        ids=["a", "b", "c", "d"],
    )
    fake = FakeCollection(response=response)
    retriever._get_collection = lambda: fake

    result = retriever.search_summaries("q", limit=2)

    assert [h["id"] for h in result["results"]] == ["a", "b"]
    assert result["total_after_threshold"] == 4
    assert result["total_before_threshold"] == 4
    # n_results over-fetch = min(limit * query_multiplier, 100) = min(2*3, 100)
    assert fake.last_kwargs["n_results"] == 6


# ─── search_summaries: where-filter construction ─────────────────────────


def test_search_summaries_where_wing_and_room(retriever):
    fake = FakeCollection(response=_chroma_response([], [], [], []))
    retriever._get_collection = lambda: fake

    result = retriever.search_summaries("q", wing="penny", room="decisions")

    assert fake.last_kwargs["where"] == {"$and": [{"wing": "penny"}, {"room": "decisions"}]}
    assert result["filters"] == {"wing": "penny", "room": "decisions"}


def test_search_summaries_where_wing_only_and_room_only(retriever):
    # wing only
    fake_w = FakeCollection(response=_chroma_response([], [], [], []))
    retriever._get_collection = lambda: fake_w
    retriever.search_summaries("q", wing="penny")
    assert fake_w.last_kwargs["where"] == {"wing": "penny"}

    # room only
    fake_r = FakeCollection(response=_chroma_response([], [], [], []))
    retriever._get_collection = lambda: fake_r
    retriever.search_summaries("q", room="decisions")
    assert fake_r.last_kwargs["where"] == {"room": "decisions"}

    # neither -> no 'where' key passed to query at all
    fake_n = FakeCollection(response=_chroma_response([], [], [], []))
    retriever._get_collection = lambda: fake_n
    retriever.search_summaries("q")
    assert "where" not in fake_n.last_kwargs

# ─── smart_search (#12): embedding is the router, no keyword layer ─────────────


def _spy_search_summaries(retriever, captured, results=None):
    """Stub search_summaries to record the args smart_search passes it."""
    def spy(query, wing=None, room=None, limit=None):
        captured.update(query=query, wing=wing, room=room, limit=limit)
        return {"results": results or []}
    retriever.search_summaries = spy


def test_smart_search_no_keyword_room_routing(retriever):
    captured = {}
    _spy_search_summaries(retriever, captured)
    # A query dense with 'decision' keywords must NOT be routed to a room; the
    # old keyword layer would have filtered to room='decisions'.
    retriever.smart_search("we decided to choose the plan and picked the design")
    assert captured["wing"] is None and captured["room"] is None


def test_smart_search_no_entity_query_mutation(retriever):
    captured = {}
    _spy_search_summaries(retriever, captured)
    # No context -> the embedded query is the raw query (no appended entities).
    retriever.smart_search("The FooBar refactor in smart_retriever")
    assert captured["query"] == "The FooBar refactor in smart_retriever"


def test_smart_search_explicit_filters_pass_through(retriever):
    captured = {}
    _spy_search_summaries(retriever, captured)
    retriever.smart_search("q", wing="penny", room="decisions")
    assert captured["wing"] == "penny" and captured["room"] == "decisions"


def test_smart_search_folds_context_into_query(retriever):
    captured = {}
    _spy_search_summaries(retriever, captured)
    out = retriever.smart_search("main query", context="prior chat about auth tokens")
    assert "main query" in captured["query"] and "auth tokens" in captured["query"]
    assert out["context_analysis"]["query_enhanced"] is True


def test_smart_search_context_analysis_has_no_keyword_layer(retriever):
    retriever.search_summaries = lambda query, wing=None, room=None, limit=None: {"results": []}
    out = retriever.smart_search("q")
    ca = out["context_analysis"]
    assert set(ca) == {"effective_filters", "query_enhanced"}
    assert ca["effective_filters"] == {"wing": None, "room": None}
    assert ca["query_enhanced"] is False


def test_smart_search_include_full_expands_hits(retriever):
    retriever.search_summaries = lambda query, wing=None, room=None, limit=None: {
        "results": [{"id": "d1", "summary": "s"}]
    }
    retriever.get_full_content = lambda drawer_id: {"content": "FULL BODY"}
    out = retriever.smart_search("q", include_full=True)
    assert out["results"][0]["full_content"] == "FULL BODY"
