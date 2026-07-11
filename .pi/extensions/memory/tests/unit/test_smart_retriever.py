#!/usr/bin/env python3
"""
Characterization tests for smart_retriever.SmartRetriever.

These tests lock the CURRENT observable behavior of the two functions that are
being refactored to clear flake8 C901 (McCabe complexity) warnings:

  - ``search_summaries`` (was complexity 11)
  - ``suggest_wing_room`` (was complexity 12)

They are byte-identical characterization tests: they assert the FULL output
dicts (suggestions incl. reasoning order + confidence; hits incl. summaries /
similarities / filter / order) so that the extract-method refactor can be
proven to preserve behavior exactly. They must pass GREEN against the
pre-refactor code and remain GREEN unchanged after the refactor.

Determinism (no dependence on live embeddings or a real knowledge graph):
  - ``_get_collection`` is replaced with a fake collection whose ``.query``
    returns the ChromaDB nested-list shape.
  - ``_get_kg`` is replaced with either ``None`` or a fake sqlite-like
    connection.
  - ``get_related_entities`` / ``extract_entities`` / ``extract_keywords`` are
    monkeypatched on the instance where a specific, order-stable input is
    needed (``extract_entities`` returns ``list(set(...))`` in the real code,
    which is intentionally left to its own dedicated feeder-lock test that
    asserts as a set).
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


class FakeCursor:
    def __init__(self, rows):
        self._rows = list(rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class FakeKG:
    """Stand-in for the sqlite knowledge-graph connection. Only needs to serve
    the ``suggest_wing_room`` known-entity probe:
    ``SELECT name FROM entities WHERE name = ? OR id = ?``."""

    def __init__(self, known=()):
        self.known = set(known)

    def execute(self, _sql, params=()):
        name = params[0] if len(params) > 0 else None
        ident = params[1] if len(params) > 1 else None
        if name in self.known or ident in self.known:
            return FakeCursor([("known-name",)])
        return FakeCursor([])


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


# ─── suggest_wing_room: keyword -> room detection ────────────────────────


def test_suggest_wing_room_room_from_keyword(retriever):
    retriever.extract_entities = lambda _text: []
    retriever.extract_keywords = lambda _text: ["decision"]
    retriever._get_kg = lambda: None

    result = retriever.suggest_wing_room("some query")

    assert result == {
        "wing": None,
        "room": "decisions",
        "confidence": 0.3,
        "reasoning": ["Keyword 'decision' suggests room 'decisions'"],
        "entities_found": [],
        "keywords_found": ["decision"],
    }


def test_suggest_wing_room_first_room_wins_in_dict_order(retriever):
    # keywords that match BOTH 'architecture' and 'technical'; dict order puts
    # 'architecture' before 'technical', so architecture wins and confidence
    # increments exactly once.
    retriever.extract_entities = lambda _text: []
    retriever.extract_keywords = lambda _text: ["bug", "design"]
    retriever._get_kg = lambda: None

    result = retriever.suggest_wing_room("q")

    assert result["room"] == "architecture"
    assert result["confidence"] == 0.3
    assert result["reasoning"] == ["Keyword 'design' suggests room 'architecture'"]


def test_suggest_wing_room_no_keyword_match(retriever):
    retriever.extract_entities = lambda _text: []
    retriever.extract_keywords = lambda _text: ["unrelated", "words"]
    retriever._get_kg = lambda: None

    result = retriever.suggest_wing_room("q")

    assert result == {
        "wing": None,
        "room": None,
        "confidence": 0,
        "reasoning": [],
        "entities_found": [],
        "keywords_found": ["unrelated", "words"],
    }


# ─── suggest_wing_room: relationship + known-entity reasoning ─────────────


def test_suggest_wing_room_relationship_reasoning_first(retriever):
    retriever.extract_entities = lambda _text: ["Alpha", "Beta"]
    retriever.extract_keywords = lambda _text: []
    retriever._get_kg = lambda: None

    def fake_related(entity):
        rels = ["Alpha \u2192 uses \u2192 X"] if entity == "Alpha" else []
        return {"entity": entity, "related": [], "relationships": rels}

    retriever.get_related_entities = fake_related

    result = retriever.suggest_wing_room("q")

    assert result["reasoning"] == [
        "Entity 'Alpha' has relationships: ['Alpha \u2192 uses \u2192 X']"
    ]
    assert result["confidence"] == 0
    assert result["room"] is None


def test_suggest_wing_room_known_entity_reasoning(retriever):
    retriever.extract_entities = lambda _text: ["Gamma"]
    retriever.extract_keywords = lambda _text: []
    retriever.get_related_entities = lambda e: {"entity": e, "related": [], "relationships": []}
    retriever._get_kg = lambda: FakeKG(known={"Gamma"})

    result = retriever.suggest_wing_room("q")

    assert result["reasoning"] == ["Entity 'Gamma' is known"]


def test_suggest_wing_room_reasoning_order_and_confidence_once(retriever):
    """SC-6 dedicated test: reasoning append order is
    relationships -> room -> known-entities, and confidence increments by
    exactly 0.3 once when a room is found."""
    retriever.extract_entities = lambda _text: ["Alpha"]
    retriever.extract_keywords = lambda _text: ["decision"]
    retriever.get_related_entities = lambda e: {
        "entity": e,
        "related": [],
        "relationships": ["Alpha \u2192 works_on \u2192 Proj"],
    }
    retriever._get_kg = lambda: FakeKG(known={"Alpha"})

    result = retriever.suggest_wing_room("q")

    assert result["reasoning"] == [
        "Entity 'Alpha' has relationships: ['Alpha \u2192 works_on \u2192 Proj']",
        "Keyword 'decision' suggests room 'decisions'",
        "Entity 'Alpha' is known",
    ]
    assert result["confidence"] == 0.3
    assert result["room"] == "decisions"


def test_suggest_wing_room_full_output_dict(retriever):
    """Assert the entire suggestions dict, including entities_found /
    keywords_found passthrough and the exact reasoning list."""
    # 'decisions' and 'architecture' are earlier in dict order but match nothing;
    # 'technical' is the first room with a matching keyword ('code'), so it wins
    # even though 'session' (a 'sessions' keyword) is present.
    retriever.extract_entities = lambda _text: ["Alpha"]
    retriever.extract_keywords = lambda _text: ["session", "code"]
    retriever.get_related_entities = lambda e: {"entity": e, "related": [], "relationships": []}
    retriever._get_kg = lambda: None

    result = retriever.suggest_wing_room("query", context="ctx")

    assert result == {
        "wing": None,
        "room": "technical",
        "confidence": 0.3,
        "reasoning": ["Keyword 'code' suggests room 'technical'"],
        "entities_found": ["Alpha"],
        "keywords_found": ["session", "code"],
    }


# ─── Feeder locks: extract_keywords / extract_entities ───────────────────


def test_extract_keywords_deterministic(retriever):
    """Lock the frequency-ordered keyword extraction (Counter.most_common)."""
    text = "decided decided architecture bug bug bug"
    # bug=3, decided=2, architecture=1 -> most_common order
    assert retriever.extract_keywords(text) == ["bug", "decided", "architecture"]


def test_extract_entities_deterministic(retriever):
    """Lock capitalized-stopword removal, snake_case, camelCase, and quoted
    extraction. Result is order-independent (real code returns list(set(...)))
    so it is asserted as a set."""
    text = 'The smart_retriever handles myVariable and "quoted text"'
    assert set(retriever.extract_entities(text)) == {
        "smart_retriever",
        "myVariable",
        "quoted text",
    }
