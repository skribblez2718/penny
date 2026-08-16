from __future__ import annotations

import io
import os
import zipfile
from pathlib import Path
from types import ModuleType
from typing import Any, Callable

import pytest
from PIL import Image, PngImagePlugin

from conftest import generate_deck


def _save_png(path: Path, size: tuple[int, int] = (320, 180)) -> None:
    Image.new("RGB", size, "royalblue").save(path)


def _background_spec(path: str) -> dict[str, Any]:
    return {
        "design": {"background": {"path": path}},
        "slides": [{"layout": "title", "title": "Asset"}],
    }


def _assert_atomic_rejection(
    powerpointgen: ModuleType,
    tmp_path: Path,
    spec: dict[str, Any],
    match: str,
) -> None:
    target = tmp_path / "existing.pptx"
    target.write_bytes(b"known-good")
    with pytest.raises(ValueError, match=match):
        powerpointgen.generate(
            {
                "output_path": str(target),
                "project_root": str(tmp_path),
                **spec,
            }
        )
    assert target.read_bytes() == b"known-good"
    assert not list(tmp_path.glob(".*.tmp.pptx"))


def test_default_root_and_explicit_additional_root_are_the_only_asset_grants(
    tmp_path: Path, powerpointgen: ModuleType
) -> None:
    project = tmp_path / "project"
    outside = tmp_path / "outside"
    project.mkdir()
    outside.mkdir()
    _save_png(project / "inside.png")
    _save_png(outside / "outside.png")

    _, presentation = generate_deck(
        powerpointgen,
        project,
        design={"background": {"path": "inside.png"}},
        slides=[{"layout": "title", "title": "Inside"}],
    )
    assert any(shape.name == "Penny Background" for shape in presentation.slides[0].shapes)

    output = project / "outside-rejected.pptx"
    with pytest.raises(ValueError, match="escapes the allowed"):
        powerpointgen.generate(
            {
                "output_path": str(output),
                "project_root": str(project),
                **_background_spec(str(outside / "outside.png")),
            }
        )
    assert not output.exists()

    result = powerpointgen.generate(
        {
            "output_path": str(project / "outside-allowed.pptx"),
            "project_root": str(project),
            "allowed_image_roots": [str(outside)],
            **_background_spec(str(outside / "outside.png")),
        }
    )
    assert result["slide_count"] == 1


@pytest.mark.parametrize(
    "path,match",
    [
        ("../outside.png", "path traversal"),
        ("https://example.com/a.png", "URI"),
        ("data:image/png;base64,AAAA", "URI"),
        ("//server/share/a.png", "network path"),
        (r"C:\\assets\\a.png", "URI or drive"),
    ],
)
def test_traversal_uri_data_network_and_drive_paths_fail_closed(
    tmp_path: Path,
    powerpointgen: ModuleType,
    path: str,
    match: str,
) -> None:
    _assert_atomic_rejection(powerpointgen, tmp_path, _background_spec(path), match)


def test_symlink_escape_and_non_regular_file_fail_closed(
    tmp_path: Path, powerpointgen: ModuleType
) -> None:
    project = tmp_path / "project"
    outside = tmp_path / "outside"
    project.mkdir()
    outside.mkdir()
    _save_png(outside / "secret.png")
    (project / "escape.png").symlink_to(outside / "secret.png")
    _assert_atomic_rejection(
        powerpointgen,
        project,
        _background_spec("escape.png"),
        "escapes the allowed",
    )

    if hasattr(os, "mkfifo"):
        fifo = project / "asset.png"
        os.mkfifo(fifo)
        _assert_atomic_rejection(
            powerpointgen,
            project,
            _background_spec(fifo.name),
            "regular file",
        )


def test_missing_corrupt_unsupported_and_animated_assets_fail_closed(
    tmp_path: Path, powerpointgen: ModuleType
) -> None:
    _assert_atomic_rejection(
        powerpointgen,
        tmp_path,
        _background_spec("missing.png"),
        "missing or unreadable",
    )

    corrupt = tmp_path / "corrupt.png"
    corrupt.write_bytes(b"not an image")
    _assert_atomic_rejection(
        powerpointgen,
        tmp_path,
        _background_spec(corrupt.name),
        "corrupt|unsupported",
    )

    unsupported = tmp_path / "image.gif"
    Image.new("RGB", (20, 20), "red").save(unsupported)
    _assert_atomic_rejection(
        powerpointgen,
        tmp_path,
        _background_spec(unsupported.name),
        "extension",
    )

    animated = tmp_path / "animated.png"
    frames = [Image.new("RGBA", (20, 20), color) for color in ("red", "blue")]
    frames[0].save(animated, save_all=True, append_images=frames[1:], duration=100, loop=0)
    _assert_atomic_rejection(
        powerpointgen,
        tmp_path,
        _background_spec(animated.name),
        "animated",
    )


def test_source_byte_and_decoded_pixel_limits_fail_before_publication(
    tmp_path: Path, powerpointgen: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    image_path = tmp_path / "bounded.png"
    _save_png(image_path, (30, 20))

    monkeypatch.setattr(powerpointgen, "NEW_ASSET_MAX_BYTES", 10)
    _assert_atomic_rejection(
        powerpointgen,
        tmp_path,
        _background_spec(image_path.name),
        "25 MiB",
    )

    monkeypatch.setattr(powerpointgen, "NEW_ASSET_MAX_BYTES", 25 * 1024 * 1024)
    monkeypatch.setattr(powerpointgen, "NEW_ASSET_MAX_PIXELS", 100)
    _assert_atomic_rejection(
        powerpointgen,
        tmp_path,
        _background_spec(image_path.name),
        "40,000,000 pixel",
    )


def test_verified_snapshot_is_embedded_without_reopening_source(
    tmp_path: Path, powerpointgen: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    image_path = tmp_path / "snapshot.png"
    _save_png(image_path)
    original: Callable[[Path, str], bytes] = powerpointgen._read_asset_snapshot

    def read_then_remove(path: Path, label: str) -> bytes:
        payload = original(path, label)
        path.unlink()
        return payload

    monkeypatch.setattr(powerpointgen, "_read_asset_snapshot", read_then_remove)
    result, presentation = generate_deck(
        powerpointgen,
        tmp_path,
        design={"background": {"path": image_path.name}},
        slides=[{"layout": "title", "title": "Snapshot"}],
    )
    assert not image_path.exists()
    assert any(shape.name == "Penny Background" for shape in presentation.slides[0].shapes)
    with zipfile.ZipFile(result["path"]) as archive:
        media = [name for name in archive.namelist() if name.startswith("ppt/media/")]
        assert media


def test_new_assets_are_reencoded_without_metadata_and_relationships_are_internal(
    tmp_path: Path, powerpointgen: ModuleType
) -> None:
    image_path = tmp_path / "metadata.png"
    png_info = PngImagePlugin.PngInfo()
    png_info.add_text("private", "must-not-survive")
    Image.new("RGB", (200, 100), "green").save(image_path, pnginfo=png_info)

    result, _ = generate_deck(
        powerpointgen,
        tmp_path,
        slides=[
            {
                "layout": "image_right",
                "title": "Embedded",
                "media": {"path": image_path.name},
            }
        ],
    )
    with zipfile.ZipFile(result["path"]) as archive:
        media_name = next(name for name in archive.namelist() if name.startswith("ppt/media/"))
        payload = archive.read(media_name)
        assert b"must-not-survive" not in payload
        with Image.open(io.BytesIO(payload)) as embedded:
            assert embedded.info.get("private") is None
            assert embedded.size == (200, 100)
        relationships = archive.read("ppt/slides/_rels/slide1.xml.rels").decode()
        assert 'TargetMode="External"' not in relationships
        assert "../media/" in relationships


def test_asset_paths_are_absent_from_resolved_design_telemetry(
    tmp_path: Path, powerpointgen: ModuleType
) -> None:
    image_path = tmp_path / "private-name.png"
    _save_png(image_path)
    result, _ = generate_deck(
        powerpointgen,
        tmp_path,
        design={"background": {"path": str(image_path)}},
        slides=[{"layout": "title", "title": "Telemetry"}],
    )
    telemetry = str(result["resolved_design"])
    assert str(tmp_path) not in telemetry
    assert image_path.name not in telemetry
