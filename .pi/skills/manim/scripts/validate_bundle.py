#!/usr/bin/env python3
"""Static render-bundle validator — the verify state's Tier-1 EXECUTE evidence.

Runs every check that can be executed WITHOUT rendering or importing generated
code (py_compile compiles but never executes; everything else is AST/JSON):

  1. storyboard.json structural validation (stdlib — no jsonschema dependency)
  2. per-scene: py_compile syntax evidence
  3. per-scene: exactly one Scene subclass with a construct() method (AST)
  4. per-scene: every primitive call's kwargs validated against the exported
     primitive-library schema (name, unknown params, missing required params)
  5. duration arithmetic: sum of declared primitive durations vs the scene's
     measured narration duration (tolerance: durations must cover narration)
  6. storyboard <-> scene file correspondence (no missing, no orphans)

Output: a JSON report on stdout. Exit 0 = clean, 1 = violations, 2 = unusable
input. Violations are actionable: "<where>: <what> — <expected vs found>".

Stdlib only. Usage:
  validate_bundle.py --bundle <dir> --schema <primitive_schema.json>
"""

from __future__ import annotations

import argparse
import ast
import json
import py_compile
import sys
from pathlib import Path

DURATION_TOLERANCE = 0.75  # seconds of allowed shortfall vs narration


def _load_json(path: Path, violations: list[str]) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        violations.append(f"{path.name}: missing — expected at {path}")
    except json.JSONDecodeError as exc:
        violations.append(f"{path.name}: invalid JSON — {exc}")
    return None


def check_storyboard_structure(sb: dict) -> list[str]:
    v: list[str] = []
    for key in ("video_id", "title", "theme", "scenes"):
        if key not in sb:
            v.append(f"storyboard: missing required key '{key}'")
    scenes = sb.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        v.append("storyboard: 'scenes' must be a non-empty array")
        return v
    seen: set[str] = set()
    for i, scene in enumerate(scenes):
        sid = str(scene.get("scene_id", "")) if isinstance(scene, dict) else ""
        where = f"storyboard scene[{i}]"
        if not isinstance(scene, dict):
            v.append(f"{where}: must be an object")
            continue
        if not sid:
            v.append(f"{where}: missing scene_id")
        elif sid in seen:
            v.append(f"{where}: duplicate scene_id '{sid}' — ids must be unique")
        seen.add(sid)
        if not str(scene.get("narration", "")).strip():
            v.append(f"{where} ({sid}): empty narration")
        visuals = scene.get("visuals")
        if not isinstance(visuals, list) or not visuals:
            v.append(f"{where} ({sid}): 'visuals' must be a non-empty array")
            continue
        for j, vis in enumerate(visuals):
            if not isinstance(vis, dict) or "primitive" not in vis or "params" not in vis:
                v.append(f"{where} ({sid}) visual[{j}]: needs 'primitive' and 'params'")
    return v


def check_primitive_refs(sb: dict, schema: dict) -> list[str]:
    v: list[str] = []
    prims = {str(p.get("name")): p.get("params") or {} for p in schema.get("primitives", [])}
    themes = set((schema.get("themes") or {}).keys())
    if themes and sb.get("theme") not in themes:
        v.append(
            f"storyboard theme: unknown — expected one of {sorted(themes)}, "
            f"found '{sb.get('theme')}'"
        )
    for scene in sb.get("scenes", []):
        sid = scene.get("scene_id", "?")
        for j, vis in enumerate(scene.get("visuals", [])):
            if not isinstance(vis, dict):
                continue
            name = str(vis.get("primitive", ""))
            where = f"scene {sid} visual[{j}]"
            if name not in prims:
                v.append(
                    f"{where}: unknown primitive — expected one of {sorted(prims)}, "
                    f"found '{name}'"
                )
                continue
            spec = prims[name]
            params = vis.get("params") or {}
            for p in params:
                if p not in spec:
                    v.append(
                        f"{where}: unknown param '{p}' for {name} — "
                        f"expected one of {sorted(spec)}"
                    )
            for p, meta in spec.items():
                if isinstance(meta, dict) and meta.get("required") and p not in params:
                    v.append(f"{where}: {name} missing required param '{p}'")
    return v


def scene_path(bundle: Path, sid: str) -> Path | None:
    for candidate in (
        bundle / "scenes" / f"{sid.replace('-', '_')}.py",
        bundle / "scenes" / f"{sid}.py",
    ):
        if candidate.is_file():
            return candidate
    return None


def check_scene_file(path: Path, schema: dict, measured: float | None) -> list[str]:
    v: list[str] = []
    where = f"scenes/{path.name}"
    try:
        py_compile.compile(str(path), doraise=True, cfile="/dev/null")
    except py_compile.PyCompileError as exc:
        return [f"{where}: does not compile — {exc.msg}"]
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (SyntaxError, OSError) as exc:
        return [f"{where}: unparseable — {exc}"]

    scene_classes = [
        n for n in ast.walk(tree)
        if isinstance(n, ast.ClassDef) and any("Scene" in ast.unparse(b) for b in n.bases)
    ]
    if len(scene_classes) != 1:
        v.append(f"{where}: expected exactly 1 Scene subclass, found {len(scene_classes)}")
    for cls in scene_classes:
        if not any(isinstance(n, ast.FunctionDef) and n.name == "construct" for n in cls.body):
            v.append(f"{where}: Scene subclass '{cls.name}' has no construct()")

    prims = {str(p.get("name")): p.get("params") or {} for p in schema.get("primitives", [])}
    declared = 0.0
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", "")
        if name in prims:
            spec = prims[name]
            for kw in node.keywords:
                if kw.arg and kw.arg not in spec:
                    v.append(
                        f"{where} line {node.lineno}: {name} unknown param '{kw.arg}' — "
                        f"expected one of {sorted(spec)}"
                    )
            supplied = {kw.arg for kw in node.keywords}
            for p, meta in spec.items():
                if isinstance(meta, dict) and meta.get("required") and p not in supplied:
                    if not any(kw.arg is None for kw in node.keywords):
                        v.append(f"{where} line {node.lineno}: {name} missing required '{p}'")
        if name == "play":  # Primitive(...).play(self, THEME, duration=X)
            for kw in node.keywords:
                if kw.arg == "duration" and isinstance(kw.value, ast.Constant):
                    try:
                        declared += float(kw.value.value)
                    except (TypeError, ValueError):
                        pass

    if measured is not None and declared > 0 and declared + DURATION_TOLERANCE < measured:
        v.append(
            f"{where}: declared animation time {declared:.1f}s does not cover measured "
            f"narration {measured:.1f}s — expected ≥ {measured:.1f}s"
        )
    return v


def validate(bundle: Path, schema_path: Path) -> dict:
    violations: list[str] = []
    checks: list[str] = []

    schema = _load_json(schema_path, violations)
    sb = _load_json(bundle / "storyboard.json", violations)
    if schema is None or sb is None:
        return {"ok": False, "fatal": True, "violations": violations, "checks_run": checks}

    checks.append("storyboard structural validation")
    violations += check_storyboard_structure(sb)
    checks.append("primitive/theme reference validation vs schema")
    violations += check_primitive_refs(sb, schema)

    scene_ids = [
        str(s.get("scene_id", "")) for s in sb.get("scenes", []) if isinstance(s, dict)
    ]
    known_files = set()
    for scene in sb.get("scenes", []):
        if not isinstance(scene, dict):
            continue
        sid = str(scene.get("scene_id", ""))
        f = scene_path(bundle, sid)
        if f is None:
            violations.append(f"scenes/: missing scene file for '{sid}'")
            continue
        known_files.add(f.name)
        measured = scene.get("measured_duration")
        measured = float(measured) if isinstance(measured, (int, float)) else None
        checks.append(f"py_compile+AST+signatures+durations: {f.name}")
        violations += check_scene_file(f, schema, measured)

    scenes_dir = bundle / "scenes"
    if scenes_dir.is_dir():
        for f in scenes_dir.glob("*.py"):
            if f.name not in known_files:
                violations.append(
                    f"scenes/{f.name}: orphan — no storyboard scene references it "
                    f"(scene_ids: {scene_ids})"
                )

    return {
        "ok": not violations,
        "fatal": False,
        "bundle": str(bundle),
        "schema_version": schema.get("version", ""),
        "scene_count": len(scene_ids),
        "checks_run": checks,
        "violations": violations,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bundle", required=True, help="render bundle directory")
    ap.add_argument("--schema", required=True, help="exported primitive schema JSON")
    args = ap.parse_args()
    report = validate(Path(args.bundle).expanduser(), Path(args.schema).expanduser())
    print(json.dumps(report, indent=2))
    if report.get("fatal"):
        return 2
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
