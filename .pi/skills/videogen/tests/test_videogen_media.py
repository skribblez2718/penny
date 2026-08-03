from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from media_tools import (  # noqa: E402
    POSTER_FFMPEG_QSCALE,
    POSTER_JPEG_QUALITY,
    AssemblyError,
    CaptionError,
    MediaProbeError,
    MediaProbeResult,
    VTTCue,
    assemble_video,
    caption_coverage,
    check_assembly,
    extract_poster,
    measure_wav,
    parse_vtt,
    probe_media,
    srt_to_vtt,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "captions"
FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
MEDIA_TOOLS_MISSING = FFMPEG is None or FFPROBE is None
MEDIA_SKIP_REASON = "real-media integration requires both ffmpeg and ffprobe binaries"


def _run_checked(command: list[str]) -> None:
    subprocess.run(command, capture_output=True, text=True, check=True, timeout=30)


def _make_wav(path: Path) -> None:
    assert FFMPEG is not None
    _run_checked(
        [
            FFMPEG,
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=8000",
            "-t",
            "0.25",
            "-c:a",
            "pcm_s16le",
            str(path),
        ]
    )


def _make_mp4(path: Path, *, color: str, frequency: int = 440) -> None:
    assert FFMPEG is not None
    _run_checked(
        [
            FFMPEG,
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c={color}:s=160x90:r=10:d=0.4",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={frequency}:sample_rate=8000:duration=0.4",
            "-t",
            "0.4",
            "-c:v",
            "mpeg4",
            "-q:v",
            "5",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            "-movflags",
            "+faststart",
            str(path),
        ]
    )


def test_srt_to_vtt_fixture_preserves_every_cue_timing_order_and_text(
    tmp_path: Path,
) -> None:
    destination = tmp_path / "sample.vtt"

    artifact = srt_to_vtt(
        FIXTURES / "sample.srt",
        destination,
        output_root=tmp_path,
        scene_ids=["scene-a", "scene-b", "scene-c"],
    )
    expected_text = (FIXTURES / "sample.vtt").read_text(encoding="utf-8")
    cues = parse_vtt(destination.read_text(encoding="utf-8"))

    assert destination.read_text(encoding="utf-8") == expected_text
    assert artifact["path"] == str(destination.resolve())
    assert artifact["size_bytes"] == len(expected_text.encode("utf-8"))
    assert [cue.identifier for cue in cues] == ["scene-a", "scene-b", "scene-c"]
    assert [(cue.start_seconds, cue.end_seconds) for cue in cues] == [
        (0.0, 1.25),
        (1.25, 3.5),
        (3.5, 5.0),
    ]
    assert [cue.text for cue in cues] == [
        "First cue, exactly preserved.",
        "Second cue spans\nmultiple lines.",
        "Final cue — UTF-8 intact.",
    ]


def test_parse_vtt_rejects_overlap_reversal_and_unsupported_blocks() -> None:
    overlap = """WEBVTT

00:00:00.000 --> 00:00:02.000
one

00:00:01.999 --> 00:00:03.000
two
"""
    reversed_cue = """WEBVTT

00:00:02.000 --> 00:00:01.000
bad
"""
    note_block = """WEBVTT

NOTE unsupported metadata
text
"""

    with pytest.raises(CaptionError, match="overlaps or is nonmonotonic"):
        parse_vtt(overlap)
    with pytest.raises(CaptionError, match="reversed or empty"):
        parse_vtt(reversed_cue)
    with pytest.raises(CaptionError, match="unsupported WebVTT block"):
        parse_vtt(note_block)


def test_caption_coverage_checks_identifiers_text_scene_bounds_and_video_bounds() -> None:
    cues = parse_vtt((FIXTURES / "sample.vtt").read_text(encoding="utf-8"))
    narration = {
        "scene-a": "First cue, exactly preserved.",
        "scene-b": "Second cue spans multiple lines.",
        "scene-c": "Final cue — UTF-8 intact.",
    }
    windows = {
        "scene-a": (0.0, 1.25),
        "scene-b": (1.25, 3.5),
        "scene-c": (3.5, 5.0),
    }

    clean = caption_coverage(
        cues,
        narration_by_scene=narration,
        scene_windows=windows,
        video_duration_seconds=5.0,
    )
    bad_cues = cues[:-1] + (VTTCue("scene-c", 3.5, 5.1, "wrong caption text"),)
    defects = caption_coverage(
        bad_cues,
        narration_by_scene=narration,
        scene_windows=windows,
        video_duration_seconds=5.0,
    )

    assert clean.ok is True
    assert clean.cue_count == 3
    assert clean.covered_scene_ids == ("scene-a", "scene-b", "scene-c")
    assert clean.errors == ()
    assert defects.ok is False
    assert defects.out_of_range_cue_indices == (2,)
    assert defects.text_mismatch_scene_ids == ("scene-c",)


def test_probe_media_uses_one_exact_json_command_and_classifies_malformed(
    tmp_path: Path,
) -> None:
    source = tmp_path / "input.bin"
    source.write_bytes(b"probe-input")
    calls: list[tuple[list[str], dict[str, Any]]] = []

    def valid_runner(command: list[str], **kwargs: Any) -> SimpleNamespace:
        calls.append((command, kwargs))
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps(
                {
                    "format": {"duration": "1.25", "format_name": "generic"},
                    "streams": [
                        {
                            "codec_type": "video",
                            "codec_name": "generic-video",
                            "width": 160,
                            "height": 90,
                        },
                        {
                            "codec_type": "audio",
                            "codec_name": "generic-audio",
                            "sample_rate": "8000",
                        },
                    ],
                }
            ),
            stderr="",
        )

    probe = probe_media(
        source, ffprobe_bin="caller-ffprobe", timeout_seconds=7.5, runner=valid_runner
    )

    assert probe.duration_seconds == 1.25
    assert len(probe.video_streams) == 1
    assert len(probe.audio_streams) == 1
    assert calls == [
        (
            [
                "caller-ffprobe",
                "-v",
                "error",
                "-show_format",
                "-show_streams",
                "-of",
                "json",
                str(source),
            ],
            {"capture_output": True, "text": True, "timeout": 7.5, "check": False},
        )
    ]

    def malformed_runner(command: list[str], **kwargs: Any) -> SimpleNamespace:
        return SimpleNamespace(returncode=0, stdout="not-json", stderr="")

    with pytest.raises(MediaProbeError, match="malformed JSON"):
        probe_media(source, runner=malformed_runner)


def test_check_assembly_reports_order_stream_duration_and_audio_defects() -> None:
    clean_probe = MediaProbeResult(
        path="/caller/media.mp4",
        duration_seconds=1.0,
        format_name="mp4",
        size_bytes=1,
        video_streams=({"codec_type": "video", "width": 160, "height": 90},),
        audio_streams=({"codec_type": "audio"},),
    )
    defective_probe = MediaProbeResult(
        path="/caller/media.mp4",
        duration_seconds=0.0,
        format_name="mp4",
        size_bytes=1,
        video_streams=(),
        audio_streams=(),
    )

    assert (
        check_assembly(
            clean_probe,
            expected_scene_ids=["scene-a", "scene-b"],
            assembly_order=["scene-a", "scene-b"],
            require_audio=True,
        )["ok"]
        is True
    )
    result = check_assembly(
        defective_probe,
        expected_scene_ids=["scene-a", "scene-b"],
        assembly_order=["scene-b", "scene-b"],
        require_audio=True,
    )
    assert result["ok"] is False
    assert any("order" in error for error in result["errors"])
    assert any("duplicate" in error for error in result["errors"])
    assert any("omitted" in error for error in result["errors"])
    assert any("video stream" in error for error in result["errors"])
    assert any("audio stream" in error for error in result["errors"])

    with pytest.raises(AssemblyError, match="expected_scene_ids must not contain duplicates"):
        check_assembly(
            clean_probe,
            expected_scene_ids=["scene-a", "scene-a"],
            assembly_order=["scene-a"],
            require_audio=True,
        )


@pytest.mark.integration
@pytest.mark.skipif(MEDIA_TOOLS_MISSING, reason=MEDIA_SKIP_REASON)
def test_real_ffmpeg_wav_measurement_and_ffprobe(tmp_path: Path) -> None:
    wav_path = tmp_path / "tone.wav"
    _make_wav(wav_path)

    measurement = measure_wav(wav_path)
    probe = probe_media(wav_path, ffprobe_bin=FFPROBE)

    assert measurement.path == str(wav_path.resolve())
    assert measurement.sample_rate_hz == 8000
    assert measurement.channels == 1
    assert measurement.frame_count > 0
    assert measurement.duration_seconds == pytest.approx(0.25, abs=0.02)
    assert probe.duration_seconds == pytest.approx(measurement.duration_seconds, abs=0.02)
    assert len(probe.audio_streams) == 1
    assert probe.video_streams == ()


@pytest.mark.integration
@pytest.mark.skipif(MEDIA_TOOLS_MISSING, reason=MEDIA_SKIP_REASON)
def test_real_ffmpeg_assembly_real_probe_and_validation(tmp_path: Path) -> None:
    scene_a = tmp_path / "scene-a.mp4"
    scene_b = tmp_path / "scene-b.mp4"
    _make_mp4(scene_a, color="red", frequency=440)
    _make_mp4(scene_b, color="blue", frequency=660)
    assembled = tmp_path / "assembled.mp4"

    command_result = assemble_video(
        [scene_a, scene_b],
        assembled,
        output_root=tmp_path,
        ffmpeg_bin=FFMPEG,
    )
    probe = probe_media(assembled, ffprobe_bin=FFPROBE)
    validation = check_assembly(
        probe,
        expected_scene_ids=["scene-a", "scene-b"],
        assembly_order=["scene-a", "scene-b"],
        require_audio=True,
    )

    assert command_result.ok is True
    assert command_result.artifact is not None
    assert command_result.artifact["path"] == str(assembled.resolve())
    assert assembled.stat().st_size > 0
    assert probe.duration_seconds > 0.6
    assert len(probe.video_streams) == 1
    assert len(probe.audio_streams) == 1
    assert validation["ok"] is True
    assert "concat" in command_result.command
    assert "+faststart" in command_result.command


@pytest.mark.integration
@pytest.mark.skipif(MEDIA_TOOLS_MISSING, reason=MEDIA_SKIP_REASON)
def test_real_poster_is_first_frame_mjpeg_with_same_dimensions_and_pinned_quality(
    tmp_path: Path,
) -> None:
    source = tmp_path / "scene-1-final.mp4"
    _make_mp4(source, color="green")
    poster = tmp_path / "poster.jpg"

    result = extract_poster(source, poster, output_root=tmp_path, ffmpeg_bin=FFMPEG)
    probe_output = subprocess.run(
        [
            FFPROBE,
            "-v",
            "error",
            "-show_streams",
            "-of",
            "json",
            str(poster),
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    poster_probe = json.loads(probe_output.stdout)
    video_stream = poster_probe["streams"][0]

    assert result.ok is True
    assert result.artifact is not None
    assert result.artifact["path"] == str(poster.resolve())
    assert poster.read_bytes().startswith(b"\xff\xd8")
    assert poster.read_bytes().endswith(b"\xff\xd9")
    assert video_stream["codec_name"] == "mjpeg"
    assert (video_stream["width"], video_stream["height"]) == (160, 90)
    assert POSTER_JPEG_QUALITY == 85
    assert POSTER_FFMPEG_QSCALE == 2
    assert r"select=eq(n\,0)" in result.command
    assert result.command[result.command.index("-frames:v") + 1] == "1"
    assert result.command[result.command.index("-q:v") + 1] == "2"
