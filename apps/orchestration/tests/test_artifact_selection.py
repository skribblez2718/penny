"""Compare-and-swap and concurrent-writer tests for artifact selection."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from orchestration.artifacts import (
    ArtifactDivergenceError,
    ArtifactStore,
    KIND_AGENT_OUTPUT,
    StaleSelectionError,
)


def _put(
    store,
    content=b"version one",
    *,
    operation_id="operation-v1",
    version=1,
    parent_ref=None,
):
    return store.put(
        content,
        run_id="run-1",
        phase="observing",
        branch_id="branch-a",
        kind=KIND_AGENT_OUTPUT,
        operation_id=operation_id,
        version=version,
        producer="agent:echo",
        consumer_scope=["state:synthesizing"],
        media_type="text/plain; charset=utf-8",
        parent_ref=parent_ref,
    )


def test_selection_is_cas_versioned_and_idempotent_on_retry(tmp_path):
    store = ArtifactStore(tmp_path / "artifacts")
    first = _put(store)
    second = _put(
        store,
        b"version two",
        operation_id="operation-v2",
        version=2,
        parent_ref=first,
    )

    assert store.select(first, expected=None) == first
    assert (
        store.get_selected(
            run_id="run-1",
            phase="observing",
            branch_id="branch-a",
            kind=KIND_AGENT_OUTPUT,
        )
        == first
    )
    assert store.select(second, expected=first) == second
    # Retry after the first CAS committed still succeeds only because the desired
    # exact ref is already current.
    assert store.select(second, expected=first) == second
    assert (
        store.get_selected(
            run_id="run-1",
            phase="observing",
            branch_id="branch-a",
            kind=KIND_AGENT_OUTPUT,
        )
        == second
    )

    with pytest.raises(StaleSelectionError, match="not the current"):
        store.validate(first, expected_run_id="run-1", require_selected=True)


def test_stale_expected_ref_and_skipped_version_fail_closed(tmp_path):
    store = ArtifactStore(tmp_path / "artifacts")
    first = _put(store)
    second = _put(
        store,
        b"version two",
        operation_id="operation-v2",
        version=2,
        parent_ref=first,
    )
    third = _put(
        store,
        b"version three",
        operation_id="operation-v3",
        version=3,
        parent_ref=second,
    )
    store.select(first, expected=None)

    with pytest.raises(StaleSelectionError, match="directly parent"):
        store.select(third, expected=first)
    store.select(second, expected=first)
    with pytest.raises(StaleSelectionError, match="stale"):
        store.select(third, expected=first)


def test_two_concurrent_revision_writers_cannot_both_select(tmp_path):
    root = tmp_path / "artifacts"
    owner = ArtifactStore(root)
    first = _put(owner)
    left = _put(
        owner,
        b"left revision",
        operation_id="left-v2",
        version=2,
        parent_ref=first,
    )
    right = _put(
        owner,
        b"right revision",
        operation_id="right-v2",
        version=2,
        parent_ref=first,
    )
    owner.select(first, expected=None)
    barrier = Barrier(2)

    def attempt(ref):
        writer = ArtifactStore(root)
        barrier.wait()
        try:
            return ("selected", writer.select(ref, expected=first))
        except StaleSelectionError:
            return ("stale", ref)

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(attempt, (left, right)))

    assert sorted(status for status, _ref in outcomes) == ["selected", "stale"]
    selected_ref = next(ref for status, ref in outcomes if status == "selected")
    assert (
        ArtifactStore(root).get_selected(
            run_id="run-1",
            phase="observing",
            branch_id="branch-a",
            kind=KIND_AGENT_OUTPUT,
        )
        == selected_ref
    )


def test_concurrent_identical_operation_writers_recover_one_ref(tmp_path):
    root = tmp_path / "artifacts"
    stores = (ArtifactStore(root), ArtifactStore(root))
    barrier = Barrier(2)

    def write(store):
        barrier.wait()
        return _put(store)

    with ThreadPoolExecutor(max_workers=2) as pool:
        refs = list(pool.map(write, stores))

    assert refs[0] == refs[1]
    assert ArtifactStore(root).read_bytes(refs[0], expected_run_id="run-1") == b"version one"


def test_concurrent_divergent_operation_writers_fail_one_loud(tmp_path):
    root = tmp_path / "artifacts"
    stores = (ArtifactStore(root), ArtifactStore(root))
    barrier = Barrier(2)

    def write(item):
        store, content = item
        barrier.wait()
        try:
            return ("stored", _put(store, content))
        except ArtifactDivergenceError:
            return ("divergent", None)

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(write, zip(stores, (b"left", b"right"), strict=True)))

    assert sorted(status for status, _ref in outcomes) == ["divergent", "stored"]
    winning_ref = next(ref for status, ref in outcomes if status == "stored")
    assert winning_ref is not None
    assert ArtifactStore(root).read_bytes(winning_ref, expected_run_id="run-1") in {
        b"left",
        b"right",
    }
