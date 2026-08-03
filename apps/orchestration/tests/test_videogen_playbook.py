"""Hermetic acceptance battery for the ``videogen`` orchestration playbook.

Every ``start``/``step`` call uses a fresh playbook instance and one temporary
SQLite checkpointer. External services and memory are exercised only through
``VideogenPlaybook``'s documented subclass seams; no HTTP client is used here.
"""

from __future__ import annotations

import copy
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence

import pytest

from orchestration.checkpointer import STATUS_AWAITING_USER, Checkpointer
from orchestration.playbooks.videogen import (
    CONFIDENCES,
    VG_ANNIE_INGEST_CONTRACT,
    VG_CARREN_NARRATION_GATE_CONTRACT,
    VG_CARREN_REFINE_GATE_CONTRACT,
    VG_SKRIBBLE_CODEGEN_CONTRACT,
    VG_SKRIBBLE_REFINE_CONTRACT,
    VG_SYNTHIA_NARRATION_CONTRACT,
    VG_SYNTHIA_REFINE_CONTRACT,
    VG_SYNTHIA_STORYBOARD_CONTRACT,
    VG_VERA_AUTO_QA_CONTRACT,
    VideogenPlaybook,
)

SID = "session-videogen"
RID = "run-videogen"
PROJECT_ROOT = Path(__file__).resolve().parents[3]
QA_FIXTURES = PROJECT_ROOT / ".pi" / "skills" / "videogen" / "tests" / "fixtures" / "qa"
VIDEOGEN_SCRIPTS = PROJECT_ROOT / ".pi" / "skills" / "videogen" / "scripts"
if str(VIDEOGEN_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(VIDEOGEN_SCRIPTS))

from videogen_qa import roll_up_report  # noqa: E402

REQUIRED_FIELDS = (
    "section_content",
    "section_identity",
    "content_gate",
    "teaching_canon_paths",
    "analogy_registry",
    "pronunciation_canon",
    "universe_canon_dir",
    "superpose_url",
    "voice_studio_url",
    "voice_id",
    "theme",
    "primitive_schema_source",
    "workspace_dir",
    "output_dir",
    "publish_target_conventions",
)
ALL_SUMMARY_CONTRACTS = (
    VG_ANNIE_INGEST_CONTRACT,
    VG_SYNTHIA_STORYBOARD_CONTRACT,
    VG_SYNTHIA_NARRATION_CONTRACT,
    VG_CARREN_NARRATION_GATE_CONTRACT,
    VG_SKRIBBLE_CODEGEN_CONTRACT,
    VG_SYNTHIA_REFINE_CONTRACT,
    VG_SKRIBBLE_REFINE_CONTRACT,
    VG_CARREN_REFINE_GATE_CONTRACT,
    VG_VERA_AUTO_QA_CONTRACT,
)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write(path: Path, data: str | bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, bytes):
        path.write_bytes(data)
    else:
        path.write_text(data, encoding="utf-8", newline="")
    return path


def _json(path: Path, value: Any) -> Path:
    return _write(path, json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n")


def _ref(path: Path) -> dict[str, Any]:
    return {"path": str(path.resolve()), "sha256": _sha(path.read_bytes())}


def _evidence(detail: str = "verified test evidence") -> list[dict[str, Any]]:
    return [{"kind": "file", "ref": "evidence:test", "sha256": None, "detail": detail}]


def _constraints(tmp_path: Path, *, section_text: str = "# Generic section\n\nExact content.\n") -> dict[str, Any]:
    inputs = tmp_path / "inputs"
    teaching = _write(inputs / "teaching.md", "Generic teaching canon.\n")
    analogy = _write(inputs / "analogies.json", "{}\n")
    pronunciation = _write(inputs / "pronunciation.md", "Generic pronunciation canon.\n")
    universe = inputs / "universe"
    _write(universe / "visual.md", "Generic visual canon.\n")
    schema = _json(
        inputs / "primitive-schema.json",
        {"version": "1.2.3", "primitives": {"KnownPrimitive": {"parameters": {}}}},
    )
    return {
        "section_content": {"text": section_text},
        "section_identity": {
            "course_slug": "generic-course",
            "unit_slug": "generic-unit",
            "lesson_slug": "generic-lesson",
            "stable_key": "generic-section",
        },
        "content_gate": {
            "finalized": True,
            "derivation_verdict": "INDEPENDENT",
            "evidence_ref": "evidence:independent",
        },
        "teaching_canon_paths": [str(teaching.resolve())],
        "analogy_registry": str(analogy.resolve()),
        "pronunciation_canon": str(pronunciation.resolve()),
        "universe_canon_dir": str(universe.resolve()),
        "superpose_url": "https://renderer.example.test",
        "voice_studio_url": "https://voice.example.test",
        "voice_id": "caller-voice",
        "theme": "caller-theme",
        "primitive_schema_source": {"path": str(schema.resolve())},
        "workspace_dir": str((tmp_path / "workspace").resolve()),
        "output_dir": str((tmp_path / "output").resolve()),
        "publish_target_conventions": {
            "video_id_template": "{stable_key}",
            "base_name_template": "{course_slug}--{unit_slug}--{lesson_slug}--{stable_key}",
            "video_destination_template": "consumer/{base_name}.mp4",
            "captions_destination_template": "consumer/{base_name}.vtt",
            "poster_destination_template": "consumer/{base_name}.jpg",
            "attach_behavior": "consumer-managed",
            "handoff_only": True,
        },
    }


def _vtt_timestamp(seconds: float) -> str:
    milliseconds = round(seconds * 1000)
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    whole, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole:02d}.{milliseconds:03d}"


class FakeVideogen(VideogenPlaybook):
    """All external effects replaced with deterministic caller-root artifacts."""

    calls: list[tuple[Any, ...]] = []
    voice_calls: list[str] = []
    render_calls: list[dict[str, Any]] = []
    validation_calls: list[str] = []
    learning_records: list[dict[str, Any]] = []
    retrieved_queries: list[dict[str, Any]] = []
    normalized_intakes: list[dict[str, Any]] = []
    validation_violations: list[dict[str, Any]] = []

    @classmethod
    def reset(cls) -> None:
        cls.calls = []
        cls.voice_calls = []
        cls.render_calls = []
        cls.validation_calls = []
        cls.learning_records = []
        cls.retrieved_queries = []
        cls.normalized_intakes = []
        cls.validation_violations = []

    def _prepare_ingest(self, ctx, intake):
        cls = type(self)
        cls.calls.append(("prepare_ingest", ctx.run_id))
        cls.normalized_intakes.append(copy.deepcopy(intake.to_dict()))
        artifacts = self._artifacts(ctx)
        root = Path(intake.workspace_dir)
        # Content-address snapshots so a changed source creates a new immutable
        # evidence tree rather than mutating the prior snapshot.
        snapshot_root = root / "source" / "snapshots" / intake.content_sha256
        source = artifacts.snapshot_bytes(
            intake.section_bytes, snapshot_root / "section.md", workspace_root=root
        )
        teaching = [
            {"source_path": path, **artifacts.snapshot_file(
                path, snapshot_root / "canon" / "teaching" / f"{index:03d}",
                workspace_root=root,
            )}
            for index, path in enumerate(intake.teaching_canon_paths)
        ]
        analogy = artifacts.snapshot_file(
            intake.analogy_registry, snapshot_root / "canon" / "analogy", workspace_root=root
        )
        pronunciation = artifacts.snapshot_file(
            intake.pronunciation_canon,
            snapshot_root / "canon" / "pronunciation",
            workspace_root=root,
        )
        universe = artifacts.snapshot_tree(
            intake.universe_canon_dir,
            snapshot_root / "canon" / "universe",
            workspace_root=root,
        )
        universe_ledger = artifacts.atomic_write_json(
            snapshot_root / "canon" / "universe-ledger.json",
            artifacts.build_tree_ledger(universe["path"]),
            root=root,
        )
        schema = artifacts.snapshot_file(
            intake.primitive_schema_source["path"],
            snapshot_root / "schema" / "primitive-schema.json",
            workspace_root=root,
        )
        publish = artifacts.atomic_write_json(
            snapshot_root / "publish" / "convention.json",
            intake.publish_target_conventions,
            root=root,
        )
        profile = None
        if intake.profile_provenance["mode"] == "profile":
            profile = artifacts.snapshot_file(
                intake.profile_provenance["resolved_path"],
                snapshot_root / "profile" / "profile.json",
                workspace_root=root,
            )
        ledger = artifacts.atomic_write_json(
            root / "evidence" / "snapshot-ledger.json",
            {
                "section": {"source_path": intake.section_source_path, **source},
                "teaching_canon": teaching,
                "analogy_registry": {"source_path": intake.analogy_registry, **analogy},
                "pronunciation_canon": {"source_path": intake.pronunciation_canon, **pronunciation},
                "universe_canon": {
                    "source_path": intake.universe_canon_dir,
                    **universe,
                    "ledger_path": universe_ledger["path"],
                },
                "primitive_schema": {"source": intake.primitive_schema_source["path"], **schema},
                "publish_convention": {"source": "inline", **publish},
                "profile": profile,
            },
            root=root,
        )
        learning = self._retrieve_learning_records(
            ctx,
            query={"record_type": "videogen_learning", "profile_mode": intake.profile_provenance["mode"]},
        )
        intake_ref = artifacts.atomic_write_json(
            root / "evidence" / "intake.json",
            {"run_id": ctx.run_id, "normalized_intake": intake.to_dict(), "readiness": "seamed"},
            root=root,
        )
        return {
            "intake_path": intake_ref["path"],
            "intake_sha256": intake_ref["sha256"],
            "source_snapshot_path": source["path"],
            "source_sha256": source["sha256"],
            "schema_snapshot_path": schema["path"],
            "schema_sha256": schema["sha256"],
            "snapshot_ledger_path": ledger["path"],
            "snapshot_ledger_sha256": ledger["sha256"],
            "expanded_publish": self._contracts(ctx).expand_publish_convention(
                intake.publish_target_conventions, intake.section_identity
            ),
            "learning_refs": learning,
            "warnings": [],
        }

    def _check_readiness(self, ctx, intake):
        type(self).calls.append(("check_readiness", ctx.run_id))
        schema_path = self._vg(ctx)["paths"]["schema_snapshot"]
        schema_hash = self._artifacts(ctx).sha256_file(schema_path)
        theme_hash = self._artifacts(ctx).sha256_bytes(intake.theme.encode("utf-8"))
        return {
            "superpose": {"health": {"ok": True}, "schema": {"ok": True}, "themes": {"ok": True}},
            "voice_studio": {
                "status": "DEFERRED",
                "reason": "no_pinned_read_only_readiness_operation",
                "first_mutation_phase": "VOICE_SYNTH",
            },
            "bundle_version": 1,
            "primitive_library_version": "1.2.3",
            "schema_snapshot_path": schema_path,
            "schema_sha256": schema_hash,
            "selected_theme_sha256": theme_hash,
            "reported_render_capacity": 1,
            "evidence_paths": [],
            "warnings": [],
        }

    def _voice_scene(
        self,
        ctx,
        *,
        scene_id: str,
        narration_text: str,
        narration_sha256: str,
        pronunciation_actions: Sequence[Mapping[str, Any]],
        destination_path: str,
    ) -> dict[str, Any]:
        cls = type(self)
        cls.calls.append(("voice", scene_id))
        cls.voice_calls.append(scene_id)
        ref = self._artifacts(ctx).atomic_write(
            destination_path,
            b"RIFF" + scene_id.encode("utf-8") + narration_sha256.encode("ascii"),
            root=self._vg(ctx)["paths"]["workspace_dir"],
        )
        return {
            "scene_id": scene_id,
            "narration_sha256": narration_sha256,
            "audio_path": ref["path"],
            "audio_sha256": ref["sha256"],
            "duration_seconds": 1.0,
            "item_id": f"item-{scene_id}",
            "job_id": f"tts-{scene_id}",
            "terminal_status": "completed",
            "pronunciation_actions": list(pronunciation_actions),
            "cleanup_status": "succeeded",
            "journal_refs": [f"voice:{scene_id}:{narration_sha256}"],
            "warnings": [],
        }

    def _validate_bundle_service(self, ctx, *, bundle_dir: str, bundle_sha256: str):
        cls = type(self)
        cls.calls.append(("validate", bundle_sha256))
        cls.validation_calls.append(bundle_sha256)
        violations = copy.deepcopy(cls.validation_violations)
        return {
            "import_result": {"ok": True, "operation": "import_bundle"},
            "project_id": 7,
            "validation_result": {"ok": not violations, "operation": "validate_project"},
            "violations": violations,
            "journal_refs": [f"validate:{bundle_sha256}"],
            "evidence_paths": [str(Path(bundle_dir) / "manifest.json")],
        }

    def _render_project(
        self,
        ctx,
        *,
        project_id: int,
        quality: str,
        scene_ids: Sequence[str] | None,
        assemble: bool,
        input_sha256: str,
    ) -> dict[str, Any]:
        cls = type(self)
        selected = list(scene_ids or self._vg(ctx)["scene_ledger"])
        call = {
            "quality": quality,
            "scene_ids": selected,
            "assemble": assemble,
            "input_sha256": input_sha256,
        }
        cls.calls.append(("render", quality, tuple(selected)))
        cls.render_calls.append(call)
        artifacts = self._artifacts(ctx)
        root = Path(self._vg(ctx)["paths"]["workspace_dir"])
        call_no = len(cls.render_calls)
        media_dir = root / "renders" / quality / f"call-{call_no:03d}"
        video = artifacts.atomic_write(
            media_dir / "assembled.mp4",
            f"fake-{quality}-video-{call_no}".encode(),
            root=root,
        )
        narration = {row["scene_id"]: row["narration"] for row in self._narration_scenes(ctx)}
        cursor = 0.0
        cues = ["WEBVTT", ""]
        for scene_id in self._vg(ctx)["scene_ledger"]:
            cues.extend(
                [
                    scene_id,
                    f"{_vtt_timestamp(cursor)} --> {_vtt_timestamp(cursor + 2.0)}",
                    narration.get(scene_id, ""),
                    "",
                ]
            )
            cursor += 2.0
        captions = artifacts.atomic_write(
            media_dir / "captions.vtt", "\n".join(cues), root=root
        )
        outputs: dict[str, Any] = {}
        jobs: list[dict[str, Any]] = []
        for scene_id in selected:
            scene = artifacts.atomic_write(
                media_dir / f"{scene_id}.mp4",
                f"fake-{quality}-{scene_id}-{call_no}".encode(),
                root=root,
            )
            outputs[scene_id] = {
                **scene,
                "duration_seconds": 2.0,
                "job_id": f"render-{quality}-{scene_id}-{call_no}",
                "cache_status": "miss",
            }
            jobs.append(
                {
                    "scene_id": scene_id,
                    "status": "completed",
                    "quality": quality,
                    "job_id": f"render-{quality}-{scene_id}-{call_no}",
                    "cache_status": "miss",
                }
            )
        evidence = artifacts.atomic_write_json(
            media_dir / "render-evidence.json", call, root=root
        )
        return {
            "project_id": project_id,
            "quality": quality,
            "render_result": {"ok": True, "video": video, "captions": captions},
            "job_table": jobs,
            "video_id": 100 + call_no,
            "scene_outputs": outputs,
            "cache": {"hits": 0, "misses": len(selected), "reported": True},
            "journal_refs": [f"render:{quality}:{input_sha256}"],
            "evidence_paths": [evidence["path"]],
        }

    def _probe_media(self, ctx, path: str):
        resolved = Path(path).resolve(strict=True)
        duration = (
            float(max(1, len(self._vg(ctx)["scene_ledger"])) * 2)
            if resolved.name == "assembled.mp4"
            else 2.0
        )
        return {
            "path": str(resolved),
            "duration_seconds": duration,
            "format_name": "mp4",
            "size_bytes": resolved.stat().st_size,
            "video_streams": [{"codec_type": "video", "width": 160, "height": 90}],
            "audio_streams": [{"codec_type": "audio"}],
        }

    def _extract_poster(self, ctx, *, scene1_final_video_path: str, destination_path: str):
        type(self).calls.append(("poster", scene1_final_video_path))
        ref = self._artifacts(ctx).atomic_write(
            destination_path, b"fake-jpeg", root=self._vg(ctx)["paths"]["workspace_dir"]
        )
        return {
            **ref,
            "width": 160,
            "height": 90,
            "source_path": scene1_final_video_path,
            "command": ["seamed-poster", scene1_final_video_path],
            "elapsed_ms": 0,
        }

    def _retrieve_learning_records(self, ctx, *, query: Mapping[str, Any]):
        cls = type(self)
        cls.retrieved_queries.append(copy.deepcopy(dict(query)))
        return [
            {"ref": f"memory:{row['run_id']}", "summary": row["outcome"], "similarity": 1.0}
            for row in cls.learning_records
        ]

    def _write_learning_record(self, ctx, *, record: Mapping[str, Any]):
        cls = type(self)
        if not any(row.get("run_id") == ctx.run_id for row in cls.learning_records):
            cls.learning_records.append(copy.deepcopy(dict(record)))
        return {"ok": True, "ref": f"memory:{ctx.run_id}", "warning": None}


@pytest.fixture(autouse=True)
def _reset_fake() -> None:
    FakeVideogen.reset()


@pytest.fixture
def cp(tmp_path: Path) -> Checkpointer:
    return Checkpointer(db_path=tmp_path / "orchestration.db")


def _start(cp: Checkpointer, constraints: dict[str, Any], *, run_id: str = RID) -> dict[str, Any]:
    return FakeVideogen(cp).start(
        session_id=SID,
        run_id=run_id,
        goal="Produce the caller-constrained instructional video",
        constraints=constraints,
        project_root=str(PROJECT_ROOT),
    )


def _step(cp: Checkpointer, agent: str, result: Any, *, run_id: str = RID) -> dict[str, Any]:
    return FakeVideogen(cp).step(
        session_id=SID, run_id=run_id, agent=agent, result=result
    )


def _parallel(cp: Checkpointer, branch: str, agent: str, summary: Mapping[str, Any], *, run_id: str = RID):
    return _step(
        cp,
        "__parallel__",
        [{"branch_id": branch, "agent": agent, "summary": dict(summary), "exitCode": 0}],
        run_id=run_id,
    )


def _annie(workspace: Path) -> dict[str, Any]:
    inventory = _json(workspace / "agent" / "inventory.json", {"concepts": ["concept-one"]})
    return {
        "status": "COMPLETE",
        "phase": "INGEST",
        "confidence": "CERTAIN",
        "needs_clarification": False,
        "inventory_path": str(inventory.resolve()),
        "inventory_sha256": _sha(inventory.read_bytes()),
        "concept_count": 1,
        "evidence_refs": _evidence("source inventory"),
        "issues": [],
    }


def _storyboard(workspace: Path, scene_ids: Sequence[str] = ("scene-one", "scene-two")) -> dict[str, Any]:
    scenes = [
        {
            "scene_id": scene_id,
            "title": f"Title {scene_id}",
            "purpose": f"Teach {scene_id}",
            "concept_ids": ["concept-one"],
            "analogy_id": None,
            "narration": f"Narration for {scene_id}.",
            "visuals": [],
        }
        for scene_id in scene_ids
    ]
    storyboard = _json(workspace / "design" / "storyboard.json", {"scenes": scenes})
    coverage = _json(workspace / "design" / "coverage.json", {"concept-one": list(scene_ids)})
    return {
        "status": "COMPLETE",
        "phase": "STORYBOARD",
        "confidence": "CERTAIN",
        "needs_clarification": False,
        "storyboard_path": str(storyboard.resolve()),
        "storyboard_sha256": _sha(storyboard.read_bytes()),
        "coverage_matrix_path": str(coverage.resolve()),
        "coverage_matrix_sha256": _sha(coverage.read_bytes()),
        "scene_count": len(scene_ids),
        "estimated_duration_seconds": float(len(scene_ids) * 2),
        "over_guide": False,
        "evidence_refs": _evidence("storyboard coverage"),
        "issues": [],
    }


def _narration(
    workspace: Path,
    scene_ids: Sequence[str] = ("scene-one", "scene-two"),
    *,
    changed_scene: str | None = None,
) -> dict[str, Any]:
    scenes = [
        {
            "scene_id": scene_id,
            "narration": (
                f"Revised narration for {scene_id}."
                if scene_id == changed_scene
                else f"Narration for {scene_id}."
            ),
            "pronunciation_actions": [],
        }
        for scene_id in scene_ids
    ]
    narration = _json(workspace / "design" / "narration.json", {"scenes": scenes})
    pronunciation = _json(workspace / "design" / "pronunciation.json", {"actions": []})
    claims = _json(workspace / "design" / "claim-map.json", {"claims": []})
    return {
        "status": "COMPLETE",
        "phase": "NARRATION_SCRIPT",
        "confidence": "CERTAIN",
        "needs_clarification": False,
        "narration_path": str(narration.resolve()),
        "narration_sha256": _sha(narration.read_bytes()),
        "pronunciation_table_path": str(pronunciation.resolve()),
        "pronunciation_table_sha256": _sha(pronunciation.read_bytes()),
        "claim_source_map_path": str(claims.resolve()),
        "claim_source_map_sha256": _sha(claims.read_bytes()),
        "scene_count": len(scene_ids),
        "evidence_refs": _evidence("narration source map"),
        "issues": [],
    }


def _carren(cp: Checkpointer, verdict: str = "APPROVE", *, evidence: bool = True) -> dict[str, Any]:
    vg = cp.load(RID).context.extras["videogen"]
    uncertain = verdict == "UNCERTAIN"
    issue = {
        "scene_id": "scene-one",
        "earliest_route": "NARRATION_SCRIPT",
        "evidence": "evidence:test",
        "detail": "revision required",
    }
    return {
        "status": "UNCERTAIN" if uncertain else "COMPLETE",
        "phase": "NARRATION_SCRIPT",
        "verdict": verdict,
        "confidence": "UNCERTAIN" if uncertain else "CERTAIN",
        "needs_clarification": False,
        "met": verdict == "APPROVE",
        "reviewed_storyboard_sha256": vg["hashes"]["storyboard"],
        "reviewed_narration_sha256": vg["hashes"]["narration"],
        "cited_evidence": _evidence("pre-synthesis review") if evidence else [],
        "issues": [] if verdict == "APPROVE" else [issue],
    }


def _codegen(cp: Checkpointer, *, primitive: str = "KnownPrimitive") -> dict[str, Any]:
    vg = cp.load(RID).context.extras["videogen"]
    files = []
    for scene_id in vg["scene_ledger"]:
        source = _write(
            Path(vg["paths"]["workspace_dir"]) / "scenes" / f"{scene_id}.py",
            f"# primitive: {primitive}\nclass Scene_{scene_id.replace('-', '_')}:\n    pass\n",
        )
        files.append({"scene_id": scene_id, **_ref(source)})
    return {
        "status": "COMPLETE",
        "phase": "CODEGEN",
        "confidence": "CERTAIN",
        "needs_clarification": False,
        "files": files,
        "scene_ids": list(vg["scene_ledger"]),
        "schema_sha256": vg["hashes"]["schema"],
        "schema_version": "1.2.3",
        "primitive_inventory": [{"scene_id": "scene-one", "primitive": primitive}],
        "validation_evidence": _evidence("syntax and schema checks"),
        "issues": [],
    }


def _load_clean_rows() -> list[dict[str, Any]]:
    return copy.deepcopy(json.loads((QA_FIXTURES / "clean.json").read_text(encoding="utf-8"))["checks"])


def _vera(cp: Checkpointer, rows: list[dict[str, Any]] | None = None, *, run_id: str = RID) -> dict[str, Any]:
    rows = _load_clean_rows() if rows is None else rows
    verdict = "FAIL" if any(row["status"] == "FAIL" for row in rows) else (
        "UNCERTAIN" if any(row["status"] == "UNCERTAIN" for row in rows) else "PASS"
    )
    rec = cp.load(run_id)
    workspace = Path(rec.context.extras["videogen"]["paths"]["workspace_dir"])
    report = _json(workspace / "evidence" / "qa" / f"vera-{rec.context.iteration}.json", {"checks": rows, "verdict": verdict})
    return {
        "status": "UNCERTAIN" if verdict == "UNCERTAIN" else "COMPLETE",
        "phase": "AUTO_QA",
        "verdict": verdict,
        "confidence": "UNCERTAIN" if verdict == "UNCERTAIN" else "CERTAIN",
        "needs_clarification": False,
        "met": verdict == "PASS",
        "qa_report_path": str(report.resolve()),
        "qa_report_sha256": _sha(report.read_bytes()),
        "check_results": rows,
        "rationale": f"All rows roll up to {verdict}.",
        "unresolved_issues": [row["id"] for row in rows if row["status"] != "PASS"],
    }


def _to_carren(cp: Checkpointer, constraints: dict[str, Any], *, run_id: str = RID) -> dict[str, Any]:
    started = _start(cp, constraints, run_id=run_id)
    assert started["state_id"] == "INGEST"
    workspace = Path(constraints["workspace_dir"])
    storyboard = _storyboard(workspace)
    _step(cp, "annie", _annie(workspace), run_id=run_id)
    _step(cp, "synthia", storyboard, run_id=run_id)
    return _parallel(cp, "synthia", "synthia", _narration(workspace), run_id=run_id)


def _to_codegen(cp: Checkpointer, constraints: dict[str, Any]) -> dict[str, Any]:
    _to_carren(cp, constraints)
    return _parallel(cp, "carren", "carren", _carren(cp))


def _to_auto_qa(cp: Checkpointer, constraints: dict[str, Any]) -> dict[str, Any]:
    _to_codegen(cp, constraints)
    return _step(cp, "skribble", _codegen(cp))


def _to_gate(cp: Checkpointer, constraints: dict[str, Any]) -> dict[str, Any]:
    _to_auto_qa(cp, constraints)
    return _step(cp, "vera", _vera(cp))


def _refine_summary(cp: Checkpointer, feedback: str, *, changed_scene: str | None = None, route: str = "DRAFT_RENDER") -> dict[str, Any]:
    rec = cp.load(RID)
    vg = rec.context.extras["videogen"]
    workspace = Path(vg["paths"]["workspace_dir"])
    iteration = vg["review"]["iteration"]
    if changed_scene:
        _narration(workspace, changed_scene=changed_scene)
    note = {
        "note_id": f"FB-{iteration}-1",
        "raw_text": feedback,
        "category": "narration" if changed_scene else "technical",
        "requested_outcome": feedback,
        "scene_ids": [changed_scene] if changed_scene else ["scene-one"],
        "beat_ids": [],
        "mapping_basis": ["explicit-id"],
        "confidence": "CERTAIN",
        "status": "applied",
        "resolution_evidence": _evidence("change applied"),
    }
    ledger = _json(workspace / "feedback" / f"ledger-{iteration}.json", {"notes": [note]})
    plan = _json(workspace / "feedback" / f"plan-{iteration}.json", {"route": route})
    return {
        "status": "COMPLETE",
        "phase": "REFINE",
        "confidence": "CERTAIN",
        "needs_clarification": False,
        "met": True,
        "feedback_ledger_path": str(ledger.resolve()),
        "feedback_ledger_sha256": _sha(ledger.read_bytes()),
        "change_plan_path": str(plan.resolve()),
        "change_plan_sha256": _sha(plan.read_bytes()),
        "affected_scene_ids": [changed_scene] if changed_scene else ["scene-one"],
        "earliest_route": route,
        "unresolved_note_ids": [],
        "evidence_refs": _evidence("feedback mapping"),
        "issues": [],
    }


# §14.1 — public boundary

def test_tracked_videogen_tree_is_generic() -> None:
    tracked = PROJECT_ROOT / ".pi" / "skills" / "videogen"
    forbidden = ("/home/", "127.0.0.1", "localhost", "ketwise", "2a63d14982be")
    offenders: list[str] = []
    for path in tracked.rglob("*"):
        if not path.is_file() or "tests" in path.parts or "__pycache__" in path.parts:
            continue
        try:
            text = path.read_text(encoding="utf-8").lower()
        except UnicodeDecodeError:
            continue
        if any(token.lower() in text for token in forbidden):
            offenders.append(str(path.relative_to(PROJECT_ROOT)))
    assert offenders == []


# §14.2–3 / SK-002 / SK-003 — complete intake rejection matrix

@pytest.mark.parametrize("field", REQUIRED_FIELDS)
def test_every_required_constraint_fails_before_side_effects(tmp_path: Path, field: str) -> None:
    constraints = _constraints(tmp_path)
    constraints.pop(field)
    directive = _start(Checkpointer(db_path=tmp_path / "cp.db"), constraints)
    assert directive["action"] == "error"
    assert any(field in error for error in directive["errors"])
    assert FakeVideogen.calls == []
    assert not Path(constraints.get("workspace_dir", tmp_path / "workspace")).exists()
    assert not Path(constraints.get("output_dir", tmp_path / "output")).exists()


@pytest.mark.parametrize(
    ("mutation", "field"),
    [
        (lambda c: c.update(section_content={"text": "---\nsection_type: simulation\n---\n"}), "section_content"),
        (lambda c: c["content_gate"].update(finalized=False), "content_gate"),
        (lambda c: c["content_gate"].update(derivation_verdict="DERIVATIVE"), "content_gate"),
    ],
)
def test_only_final_independent_markdown_proceeds_without_reject_side_effects(
    tmp_path: Path, mutation, field: str
) -> None:
    constraints = _constraints(tmp_path)
    mutation(constraints)
    directive = _start(Checkpointer(db_path=tmp_path / "cp.db"), constraints)
    assert directive["action"] == "error"
    assert any(field in error for error in directive["errors"])
    assert FakeVideogen.calls == []
    assert not Path(constraints["workspace_dir"]).exists()
    assert not Path(constraints["output_dir"]).exists()


@pytest.mark.parametrize("source_mode", ["inline", "file"])
def test_inline_and_file_backed_content_are_accepted(tmp_path: Path, source_mode: str) -> None:
    constraints = _constraints(tmp_path)
    if source_mode == "file":
        section = _write(tmp_path / "inputs" / "section.md", "# File section\n\nExact.\n")
        constraints["section_content"] = {"path": str(section.resolve())}
    directive = _start(Checkpointer(db_path=tmp_path / "cp.db"), constraints)
    assert directive["action"] == "invoke_agent"
    assert directive["state_id"] == "INGEST"
    assert FakeVideogen.normalized_intakes[-1]["section_content"]["source_mode"] == source_mode


# §14.4 / SK-005 — schema snapshot gates generated APIs

def test_schema_snapshot_rejects_unknown_primitive_and_routes_to_codegen(cp: Checkpointer, tmp_path: Path) -> None:
    constraints = _constraints(tmp_path)
    _to_codegen(cp, constraints)
    FakeVideogen.validation_violations = [
        {"fix_route": "CODEGEN", "detail": "UnknownPrimitive absent from schema snapshot"}
    ]
    directive = _step(cp, "skribble", _codegen(cp, primitive="UnknownPrimitive"))
    assert directive["action"] == "invoke_agent"
    assert directive["state_id"] == "CODEGEN"
    assert directive["agent"] == "skribble"
    rec = cp.load(RID)
    assert rec.context.extras["videogen"]["lifecycle_state"] == "CODEGEN"
    assert len(FakeVideogen.render_calls) == 0


# §14.5 / SK-012 — Carren is a hash-bound, evidence-backed pre-TTS gate

@pytest.mark.parametrize("verdict", ["NEEDS_REVISION", "UNCERTAIN"])
def test_carren_nonapproval_never_calls_voice_or_journals(cp: Checkpointer, tmp_path: Path, verdict: str) -> None:
    _to_carren(cp, _constraints(tmp_path))
    directive = _parallel(cp, "carren", "carren", _carren(cp, verdict))
    assert FakeVideogen.voice_calls == []
    rec = cp.load(RID)
    assert rec.context.extras["videogen"]["operation_journal"]["keys"] == []
    if verdict == "UNCERTAIN":
        assert directive["action"] == "escalate_to_user"
        assert rec.status == STATUS_AWAITING_USER
    else:
        assert directive["state_id"] == "NARRATION_SCRIPT"


def test_carren_approve_with_empty_evidence_is_reissued_without_tts(cp: Checkpointer, tmp_path: Path) -> None:
    _to_carren(cp, _constraints(tmp_path))
    directive = _parallel(cp, "carren", "carren", _carren(cp, evidence=False))
    assert directive["state_id"] == "NARRATION_SCRIPT"
    assert directive["action"] in {"invoke_agent", "invoke_agents_parallel"}
    assert FakeVideogen.voice_calls == []
    assert cp.load(RID).context.extras["videogen"]["operation_journal"]["keys"] == []


def test_current_hash_cited_carren_approval_precedes_voice(cp: Checkpointer, tmp_path: Path) -> None:
    _to_carren(cp, _constraints(tmp_path))
    directive = _parallel(cp, "carren", "carren", _carren(cp))
    assert directive["state_id"] == "CODEGEN"
    assert FakeVideogen.voice_calls == ["scene-one", "scene-two"]
    calls = FakeVideogen.calls
    assert max(i for i, call in enumerate(calls) if call[0] == "check_readiness") < min(
        i for i, call in enumerate(calls) if call[0] == "voice"
    )


# §14.6 / SK-004 / SK-009 — exact manifest, repeated provenance, staleness

def test_manifest_provenance_and_receipt_repeat_exact_binding(cp: Checkpointer, tmp_path: Path) -> None:
    constraints = _constraints(tmp_path)
    _to_gate(cp, constraints)
    done = _step(cp, "user", {"action": "approve"})
    assert done["action"] == "complete"
    vg = cp.load(RID).context.extras["videogen"]
    manifest = json.loads((Path(vg["paths"]["bundle"]) / "manifest.json").read_text())
    provenance = json.loads(Path(vg["paths"]["provenance"]).read_text())
    receipt = json.loads(Path(vg["paths"]["handoff_receipt"]).read_text())
    assert set(manifest) == {"bundle_version", "video_id", "primitive_library_version", "theme"}
    for key in ("section_identity", "content_sha256", "approval_record", "checksums"):
        assert receipt[key] == provenance[key]
        assert json.dumps(receipt[key], sort_keys=True, separators=(",", ":")) == json.dumps(
            provenance[key], sort_keys=True, separators=(",", ":")
        )


def test_whitespace_only_source_change_gets_new_hash_and_routes_stale(cp: Checkpointer, tmp_path: Path) -> None:
    constraints = _constraints(tmp_path)
    source = _write(tmp_path / "inputs" / "section.md", "# Exact\n")
    constraints["section_content"] = {"path": str(source.resolve())}
    _to_carren(cp, constraints)
    before = cp.load(RID).context.extras["videogen"]["hashes"]["content"]
    source.write_text("# Exact\n ", encoding="utf-8", newline="")
    directive = _parallel(cp, "carren", "carren", _carren(cp))
    rec = cp.load(RID)
    after = rec.context.extras["videogen"]["hashes"]["content"]
    assert before != after == _sha(source.read_bytes())
    assert directive["state_id"] == "INGEST"
    assert rec.context.extras["videogen"]["staleness"]["content_status"] == "STALE"
    assert FakeVideogen.voice_calls == []


# §14.8 / SK-010 — durable structured operator gate

def test_operator_review_packet_is_complete_durable_and_requires_structured_approval(
    cp: Checkpointer, tmp_path: Path
) -> None:
    directive = _to_gate(cp, _constraints(tmp_path))
    rec = cp.load(RID)
    assert directive["action"] == "escalate_to_user"
    assert rec.status == STATUS_AWAITING_USER and rec.current_state_id == "OPERATOR_REVIEW"
    packet = directive["questions"][0]["packet"]
    assert Path(packet["draft_video_path"]).is_file()
    assert _sha(Path(packet["draft_video_path"]).read_bytes()) == packet["draft_video_sha256"]
    assert Path(packet["captions_path"]).is_file()
    assert packet["duration_seconds"] > 0
    assert packet["storyboard_summary"]
    assert packet["auto_qa"]["verdict"] == "PASS"
    refused = _step(cp, "user", {"user_response": "approve this draft"})
    assert refused["action"] == "escalate_to_user"
    assert cp.load(RID).current_state_id == "OPERATOR_REVIEW"
    assert not any(call[0] == "poster" for call in FakeVideogen.calls)


def test_approval_is_refused_when_persisted_draft_hash_is_stale(cp: Checkpointer, tmp_path: Path) -> None:
    _to_gate(cp, _constraints(tmp_path))
    vg = cp.load(RID).context.extras["videogen"]
    Path(vg["paths"]["draft_video"]).write_bytes(b"changed-after-review")
    refused = _step(cp, "user", {"action": "approve"})
    assert refused["action"] == "escalate_to_user"
    rec = cp.load(RID)
    assert rec.current_state_id == "OPERATOR_REVIEW"
    assert rec.context.extras["videogen"]["paths"]["approval_record"] is None
    assert not any(call[0] == "poster" for call in FakeVideogen.calls)


# §14.9 / OPS-004 — targeted audio, full validation/render/QA convergence

def test_one_scene_narration_feedback_resynthesizes_only_that_wav_and_reruns_full_gates(
    cp: Checkpointer, tmp_path: Path
) -> None:
    constraints = _constraints(tmp_path)
    _to_gate(cp, constraints)
    initial_validation_count = len(FakeVideogen.validation_calls)
    initial_render_count = len(FakeVideogen.render_calls)
    feedback = "Revise scene-one narration only."
    refine = _step(cp, "user", {"action": "refine", "feedback": feedback})
    assert refine["state_id"] == "REFINE"
    carren = _step(
        cp,
        "synthia",
        _refine_summary(cp, feedback, changed_scene="scene-one", route="VOICE_SYNTH"),
    )
    assert carren["state_id"] == "NARRATION_SCRIPT"
    assert _parallel(cp, "carren", "carren", _carren(cp))["state_id"] == "CODEGEN"
    assert FakeVideogen.voice_calls == ["scene-one", "scene-two", "scene-one"]
    qa = _step(cp, "skribble", _codegen(cp))
    assert qa["state_id"] == "AUTO_QA"
    gate = _step(cp, "vera", _vera(cp))
    assert gate["previous_state"] == "OPERATOR_REVIEW"
    assert len(FakeVideogen.validation_calls) == initial_validation_count + 1
    assert len(FakeVideogen.render_calls) == initial_render_count + 1
    assert FakeVideogen.render_calls[-1]["scene_ids"] == ["scene-one"]


# §14.13 / SK-008 — fresh process recovery without duplicate seam submissions

def test_kill_recover_same_run_resumes_committed_state_without_duplicate_submissions(
    cp: Checkpointer, tmp_path: Path
) -> None:
    constraints = _constraints(tmp_path)
    code = _to_codegen(cp, constraints)
    assert code["state_id"] == "CODEGEN"
    assert cp.load(RID).current_state_id == "CODEGEN"
    assert FakeVideogen.voice_calls == ["scene-one", "scene-two"]
    # A new playbook instance consumes the committed CODEGEN result, then runs
    # VALIDATE + DRAFT_RENDER exactly once before checkpointing AUTO_QA.
    qa = FakeVideogen(cp).step(
        session_id=SID, run_id=RID, agent="skribble", result=_codegen(cp)
    )
    assert qa["state_id"] == "AUTO_QA"
    assert FakeVideogen.voice_calls == ["scene-one", "scene-two"]
    assert len(FakeVideogen.validation_calls) == 1
    assert len(FakeVideogen.render_calls) == 1
    # Yet another instance resumes AUTO_QA; it does not replay render or TTS.
    gate = FakeVideogen(cp).step(
        session_id=SID, run_id=RID, agent="vera", result=_vera(cp)
    )
    assert gate["previous_state"] == "OPERATOR_REVIEW"
    assert len(FakeVideogen.validation_calls) == 1
    assert len(FakeVideogen.render_calls) == 1
    assert FakeVideogen.voice_calls == ["scene-one", "scene-two"]


# §14.14 / SK-010 — bounded default budget and honest exhaustion

def test_refine_budget_defaults_to_exactly_three(cp: Checkpointer, tmp_path: Path) -> None:
    _start(cp, _constraints(tmp_path))
    rec = cp.load(RID)
    assert rec.context.max_iterations == 3
    assert rec.context.extras["videogen"]["budget"]["max_refine_iterations"] == 3


def test_fourth_refine_request_exhausts_honestly_and_never_handoffs(cp: Checkpointer, tmp_path: Path) -> None:
    _to_gate(cp, _constraints(tmp_path))
    for iteration in range(1, 4):
        feedback = f"Technical adjustment {iteration}."
        assert _step(cp, "user", {"action": "refine", "feedback": feedback})["state_id"] == "REFINE"
        qa = _step(cp, "synthia", _refine_summary(cp, feedback, route="DRAFT_RENDER"))
        assert qa["state_id"] == "AUTO_QA"
        assert _step(cp, "vera", _vera(cp))["previous_state"] == "OPERATOR_REVIEW"
    exhausted = _step(cp, "user", {"action": "refine", "feedback": "A fourth request."})
    assert exhausted["action"] == "complete"
    result = exhausted["result"]
    assert result["lifecycle_state"] == "EXHAUSTED"
    assert result["met"] is False
    assert result["finalized"] is False
    assert result["budget_exhausted"] is True
    assert result["unresolved_issues"] == ["A fourth request."]
    assert result["why"]
    assert result["passed_checks"] == ["AUTO_QA"]
    assert result["failed_checks"] == []
    assert "HANDOFF_READY" not in json.dumps(result)
    assert not Path(_constraints(tmp_path)["output_dir"]).exists()


# §14.15 — SUMMARY confidence wire format

def test_all_agent_summary_contracts_require_exact_confidence() -> None:
    assert CONFIDENCES == {"CERTAIN", "PROBABLE", "POSSIBLE", "UNCERTAIN"}
    assert all(contract["required"].get("confidence") is str for contract in ALL_SUMMARY_CONTRACTS)


def test_invalid_confidence_cannot_advance_agent_phase(cp: Checkpointer, tmp_path: Path) -> None:
    constraints = _constraints(tmp_path)
    _start(cp, constraints)
    summary = _annie(Path(constraints["workspace_dir"]))
    summary["confidence"] = "HIGH"
    retried = _step(cp, "annie", summary)
    assert retried["state_id"] == "INGEST"
    assert cp.load(RID).current_state_id == "INGEST"


# §14.16 / OPS-009 — completed learning and sequential retrieval

def test_completed_run_writes_learning_record_and_second_run_retrieves_it(tmp_path: Path) -> None:
    cp = Checkpointer(db_path=tmp_path / "cp.db")
    first = _constraints(tmp_path / "first")
    _to_gate(cp, first)
    assert _step(cp, "user", {"action": "approve"})["result"]["met"] is True
    assert len(FakeVideogen.learning_records) == 1
    assert FakeVideogen.learning_records[0]["outcome"] == "HANDOFF_READY"
    second = _constraints(tmp_path / "second")
    started = _start(cp, second, run_id="run-videogen-second")
    assert started["state_id"] == "INGEST"
    learning = cp.load("run-videogen-second").context.extras["videogen"]["learning"]
    assert learning["retrieved_refs"] == [
        {"ref": f"memory:{RID}", "summary": "HANDOFF_READY", "similarity": 1.0}
    ]
    assert len(FakeVideogen.retrieved_queries) == 2


# §14.17 / SK-013 — profile resolution through start()

def _profile_invocation(tmp_path: Path, name: str, *, profile_updates: Mapping[str, Any] | None = None):
    direct = _constraints(tmp_path)
    per_item = {key: copy.deepcopy(direct[key]) for key in ("section_content", "section_identity", "content_gate")}
    stable = {key: copy.deepcopy(value) for key, value in direct.items() if key not in per_item}
    stable.update(profile_updates or {})
    root = tmp_path / "profiles"
    _json(root / name / "profile.json", stable)
    per_item.update({"app_profile": name, "profiles_dir": str(root.resolve()), "theme": "inline-theme"})
    return per_item, stable, root


def test_profile_merge_inline_override_and_provenance_flow_through_start(tmp_path: Path) -> None:
    constraints, stable, root = _profile_invocation(tmp_path, "profile-alpha")
    directive = _start(Checkpointer(db_path=tmp_path / "cp.db"), constraints)
    assert directive["state_id"] == "INGEST"
    merged = FakeVideogen.normalized_intakes[-1]
    assert merged["theme"] == "inline-theme"
    assert merged["voice_id"] == stable["voice_id"]
    assert merged["profile_provenance"]["name"] == "profile-alpha"
    assert merged["profile_provenance"]["resolved_path"] == str(
        (root / "profile-alpha" / "profile.json").resolve()
    )
    assert len(merged["profile_provenance"]["sha256"]) == 64


@pytest.mark.parametrize("failure", ["unknown", "unreadable-root", "schema-invalid", "per-work-item"])
def test_profile_failures_precede_all_side_effects(tmp_path: Path, failure: str) -> None:
    constraints, _stable, root = _profile_invocation(tmp_path, "profile-bad")
    profile = root / "profile-bad" / "profile.json"
    if failure == "unknown":
        constraints["app_profile"] = "missing-profile"
    elif failure == "unreadable-root":
        constraints["profiles_dir"] = str((tmp_path / "missing-root").resolve())
    elif failure == "schema-invalid":
        _json(profile, {"max_refine_iterations": "unbounded"})
    else:
        _json(profile, {"section_content": {"text": "forbidden"}})
    workspace = Path(_constraints(tmp_path)["workspace_dir"])
    output = Path(_constraints(tmp_path)["output_dir"])
    directive = _start(Checkpointer(db_path=tmp_path / "cp.db"), constraints)
    assert directive["action"] == "error"
    assert FakeVideogen.calls == []
    assert not workspace.exists() and not output.exists()


def test_two_generic_profiles_drive_identical_state_trace(tmp_path: Path) -> None:
    traces = []
    for ordinal, name in enumerate(("profile-one", "profile-two"), 1):
        case = tmp_path / name
        constraints, _stable, _root = _profile_invocation(case, name)
        cp = Checkpointer(db_path=case / "cp.db")
        trace = []
        directive = _start(cp, constraints, run_id=RID)
        trace.append((directive["action"], directive["state_id"], directive.get("agent")))
        workspace = Path(constraints.get("workspace_dir", case / "workspace"))
        # workspace/output came from the profile, so use the normalized path.
        workspace = Path(cp.load(RID).context.extras["videogen"]["paths"]["workspace_dir"])
        for agent, summary in (("annie", _annie(workspace)), ("synthia", _storyboard(workspace))):
            directive = _step(cp, agent, summary)
            trace.append((directive["action"], directive["state_id"], directive.get("agent")))
        traces.append(trace)
    assert traces[0] == traces[1]


# QA-001..006 — fail routing, uncertainty, unweighted roll-up, canonical ID

@pytest.mark.parametrize(
    ("check_id", "route"),
    [
        ("MECH-BUNDLE", "VALIDATE"),
        ("MECH-CAP", "NARRATION_SCRIPT"),
        ("ALIGN-ANALOGY", "STORYBOARD"),
        ("ALIGN-TONE", "NARRATION_SCRIPT"),
        ("MECH-ACCESS", "CODEGEN"),
        ("MECH-PROVENANCE", "VALIDATE"),
    ],
)
def test_vera_failure_routes_to_owning_phase(cp: Checkpointer, tmp_path: Path, check_id: str, route: str) -> None:
    _to_auto_qa(cp, _constraints(tmp_path))
    cases = json.loads((QA_FIXTURES / "failures.json").read_text(encoding="utf-8"))["cases"]
    case = next(item for item in cases if item["check_id"] == check_id)
    rows = _load_clean_rows()
    rows[[row["id"] for row in rows].index(check_id)] = case["row"]
    validation_before = len(FakeVideogen.validation_calls)
    directive = _step(cp, "vera", _vera(cp, rows))
    if route == "VALIDATE":
        # Tool phases execute inline; a second validation submission proves the
        # owning route before the run reconverges on AUTO_QA.
        assert directive["state_id"] == "AUTO_QA"
        assert len(FakeVideogen.validation_calls) == validation_before + 1
    else:
        assert directive["state_id"] == route


def test_vera_uncertain_pauses_and_never_reaches_operator_review(cp: Checkpointer, tmp_path: Path) -> None:
    _to_auto_qa(cp, _constraints(tmp_path))
    rows = _load_clean_rows()
    rows[0] = {**rows[0], "status": "UNCERTAIN", "affected_scene_ids": ["scene-one"], "fix_route": "VALIDATE"}
    paused = _step(cp, "vera", _vera(cp, rows))
    assert paused["action"] == "escalate_to_user"
    rec = cp.load(RID)
    assert rec.status == STATUS_AWAITING_USER
    assert rec.current_state_id == "awaiting_clarification"
    assert rec.context.extras["videogen"]["paths"]["gate_packet"] is None


def test_failures_fixture_proves_weighted_aggregate_cannot_hide_any_failure() -> None:
    fixture = json.loads((QA_FIXTURES / "failures.json").read_text(encoding="utf-8"))
    for case in fixture["cases"]:
        rows = _load_clean_rows()
        index = [row["id"] for row in rows].index(case["check_id"])
        rows[index] = case["row"]
        report = roll_up_report(rows)
        assert report["verdict"] == "FAIL", case["name"]
        assert report["blocking_ids"] == [case["check_id"]]
        assert report["counts"]["PASS"] == 17


def test_provenance_check_id_is_canonical_everywhere() -> None:
    roots = [
        PROJECT_ROOT / ".pi" / "skills" / "videogen",
        Path(__file__).resolve(),
    ]
    for root in roots:
        paths = [root] if root.is_file() else root.rglob("*")
        for path in paths:
            if path.is_file() and "__pycache__" not in path.parts:
                try:
                    text = path.read_text(encoding="utf-8")
                except UnicodeDecodeError:
                    continue
                assert "MECH-" + "MANIFEST" not in text
    assert any(row["id"] == "MECH-PROVENANCE" for row in _load_clean_rows())


# Terminal create-mode success and target-boundary oracle

def test_terminal_success_stages_triplet_and_receipt_without_target_side_effects(
    cp: Checkpointer, tmp_path: Path
) -> None:
    constraints = _constraints(tmp_path)
    target = tmp_path / "consumer-target"
    constraints["publish_target_conventions"]["video_destination_template"] = (
        "consumer-target/{base_name}.mp4"
    )
    before = {path.resolve() for path in tmp_path.rglob("*")}
    _to_gate(cp, constraints)
    done = _step(cp, "user", {"action": "approve"})
    assert done["action"] == "complete"
    result = done["result"]
    assert result["met"] is True and result["lifecycle_state"] == "HANDOFF_READY"
    receipt_path = Path(result["artifacts"]["handoff_receipt"])
    release = receipt_path.parent
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert (release / "media" / f"{release.name}.mp4").is_file()
    assert (release / "media" / f"{release.name}.vtt").is_file()
    assert (release / "media" / f"{release.name}.jpg").is_file()
    assert (release / "bundle" / "manifest.json").is_file()
    assert receipt["no_target_side_effects"] == {
        "wrote_target_app": False,
        "ran_target_build": False,
        "ran_target_import": False,
        "committed": False,
    }
    assert not target.exists()
    workspace = Path(constraints["workspace_dir"]).resolve()
    output = Path(constraints["output_dir"]).resolve()
    after_files = {path.resolve() for path in tmp_path.rglob("*") if path.is_file()}
    new_files = after_files - {path for path in before if path.is_file()}
    # The SQLite checkpointer is the only orchestration write outside caller roots.
    assert all(
        path == (tmp_path / "orchestration.db").resolve()
        or path.is_relative_to(workspace)
        or path.is_relative_to(output)
        for path in new_files
    )
