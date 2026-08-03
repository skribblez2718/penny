#!/usr/bin/env python3
"""Deterministic local media and caption helpers for ``videogen``.

Filesystem writes are confined to a caller-owned output root and installed by a
sibling temporary file plus same-filesystem replacement. Subprocess helpers run
one bounded command per requested probe/render operation and never invoke a
shell.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import subprocess
import tempfile
import time
import wave
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeAlias, TypedDict

Pathish: TypeAlias = str | os.PathLike[str]
JSONScalar: TypeAlias = None | bool | int | float | str
JSONValue: TypeAlias = JSONScalar | list["JSONValue"] | dict[str, "JSONValue"]
RunCallable: TypeAlias = Callable[..., Any]


class ArtifactRef(TypedDict):
    path: str
    sha256: str
    size_bytes: int


class MediaToolError(RuntimeError):
    """Base class for local media failures."""


class MediaProbeError(MediaToolError):
    """ffprobe execution or response validation failed."""


class CaptionError(MediaToolError):
    """SRT/WebVTT input or coverage validation failed."""


class AssemblyError(MediaToolError):
    """Video assembly input, execution, or validation failed."""


class PosterError(MediaToolError):
    """Poster extraction input, execution, or validation failed."""


@dataclass(frozen=True, slots=True)
class WavMeasurement:
    path: str
    duration_seconds: float
    sample_rate_hz: int
    channels: int
    frame_count: int


@dataclass(frozen=True, slots=True)
class MediaProbeResult:
    path: str
    duration_seconds: float
    format_name: str
    size_bytes: int
    video_streams: tuple[dict[str, JSONValue], ...]
    audio_streams: tuple[dict[str, JSONValue], ...]


@dataclass(frozen=True, slots=True)
class VTTCue:
    identifier: str | None
    start_seconds: float
    end_seconds: float
    text: str


@dataclass(frozen=True, slots=True)
class CaptionCoverage:
    ok: bool
    cue_count: int
    covered_scene_ids: tuple[str, ...]
    missing_scene_ids: tuple[str, ...]
    out_of_range_cue_indices: tuple[int, ...]
    text_mismatch_scene_ids: tuple[str, ...]
    errors: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class CommandResult:
    ok: bool
    command: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str
    elapsed_ms: int
    artifact: ArtifactRef | None


# OPEN (skill spec §15: bounded local process operating constants).
# Changes require a spec/test update.
MEDIA_PROBE_TIMEOUT_SECONDS: float = 30.0
MEDIA_ASSEMBLY_TIMEOUT_SECONDS: float = 300.0
POSTER_TIMEOUT_SECONDS: float = 30.0
POSTER_JPEG_QUALITY: int = 85
POSTER_FFMPEG_QSCALE: int = 2

_SRT_TIMING_RE = re.compile(
    r"^(\d{2,}):(\d{2}):(\d{2}),(\d{3})\s+-->\s+" r"(\d{2,}):(\d{2}):(\d{2}),(\d{3})$"
)
_VTT_TIMING_RE = re.compile(
    r"^(?P<start>(?:\d{2,}:)?\d{2}:\d{2}\.\d{3})\s+-->\s+"
    r"(?P<end>(?:\d{2,}:)?\d{2}:\d{2}\.\d{3})(?:\s+.*)?$"
)


def _positive_timeout(value: float, *, error_type: type[MediaToolError]) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise error_type("timeout_seconds must be a positive finite number")
    normalized = float(value)
    if not math.isfinite(normalized) or normalized <= 0:
        raise error_type("timeout_seconds must be a positive finite number")
    return normalized


def _reject_existing_symlinks(path: Path, *, error_type: type[MediaToolError]) -> None:
    absolute = Path(os.path.abspath(os.fspath(path)))
    current = Path(absolute.anchor)
    for component in absolute.parts[1:]:
        current /= component
        if current.is_symlink():
            raise error_type(f"symlink path component refused: {current}")


def _input_file(path: Pathish, *, error_type: type[MediaToolError]) -> Path:
    try:
        candidate = Path(os.path.abspath(os.fspath(path)))
    except (TypeError, ValueError, OSError) as exc:
        raise error_type(f"invalid media path {path!r}: {exc}") from exc
    _reject_existing_symlinks(candidate, error_type=error_type)
    try:
        if not candidate.is_file():
            raise error_type(f"media input is not a regular file: {candidate}")
        return candidate.resolve(strict=True)
    except error_type:
        raise
    except OSError as exc:
        raise error_type(f"cannot inspect media input {candidate}: {exc}") from exc


def _destination(
    destination_path: Pathish,
    *,
    output_root: Pathish,
    error_type: type[MediaToolError],
) -> Path:
    try:
        root = Path(os.path.abspath(os.fspath(output_root)))
        destination_raw = Path(os.fspath(destination_path))
    except (TypeError, ValueError, OSError) as exc:
        raise error_type(f"invalid output path: {exc}") from exc
    _reject_existing_symlinks(root, error_type=error_type)
    if not root.is_dir():
        raise error_type(f"output_root is not an existing directory: {root}")
    root = root.resolve(strict=True)
    destination = (
        Path(os.path.abspath(os.fspath(destination_raw)))
        if destination_raw.is_absolute()
        else root / destination_raw
    )
    destination = Path(os.path.abspath(os.fspath(destination)))
    try:
        if os.path.commonpath((os.fspath(root), os.fspath(destination))) != os.fspath(root):
            raise error_type(f"destination escapes output_root: {destination}")
    except ValueError as exc:
        raise error_type(f"destination is not on output_root filesystem: {destination}") from exc

    _reject_existing_symlinks(destination, error_type=error_type)
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise error_type(
            f"cannot create destination directory {destination.parent}: {exc}"
        ) from exc
    _reject_existing_symlinks(destination.parent, error_type=error_type)
    try:
        resolved_parent = destination.parent.resolve(strict=True)
        if os.path.commonpath((os.fspath(root), os.fspath(resolved_parent))) != os.fspath(root):
            raise error_type(f"destination parent escapes output_root: {resolved_parent}")
    except OSError as exc:
        raise error_type(f"cannot resolve destination parent {destination.parent}: {exc}") from exc
    if destination.is_symlink():
        raise error_type(f"symlink destination refused: {destination}")
    return resolved_parent / destination.name


def _temporary_path(destination: Path, *, suffix: str) -> Path:
    descriptor, raw_path = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=suffix, dir=destination.parent
    )
    os.close(descriptor)
    return Path(raw_path)


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _install_temp(
    temporary: Path,
    destination: Path,
    *,
    error_type: type[MediaToolError],
) -> ArtifactRef:
    try:
        size = temporary.stat().st_size
        if size <= 0:
            raise error_type(f"generated artifact is empty: {temporary}")
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        _fsync_directory(destination.parent)
        return {
            "path": os.fspath(destination.resolve(strict=True)),
            "sha256": _sha256_file(destination),
            "size_bytes": destination.stat().st_size,
        }
    except error_type:
        raise
    except OSError as exc:
        raise error_type(f"cannot install generated artifact {destination}: {exc}") from exc


def _as_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return "" if value is None else str(value)


def _run_command(
    command: Sequence[str],
    *,
    timeout_seconds: float,
    runner: RunCallable | None,
    error_type: type[MediaToolError],
) -> tuple[int, str, str, int]:
    timeout = _positive_timeout(timeout_seconds, error_type=error_type)
    invoke = runner if runner is not None else subprocess.run
    started = time.monotonic()
    try:
        completed = invoke(
            list(command),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise error_type(
            f"command timed out after {timeout:g}s: {' '.join(command)}; "
            f"stderr={_as_text(exc.stderr)[:500]}"
        ) from exc
    except (OSError, UnicodeError, ValueError) as exc:
        raise error_type(f"command failed to start/decode: {' '.join(command)}: {exc}") from exc
    try:
        returncode = int(completed.returncode)
        stdout = _as_text(completed.stdout)
        stderr = _as_text(completed.stderr)
    except (AttributeError, TypeError, ValueError) as exc:
        raise error_type(f"runner returned a malformed result for {' '.join(command)}") from exc
    elapsed_ms = max(0, int((time.monotonic() - started) * 1000))
    return returncode, stdout, stderr, elapsed_ms


def measure_wav(path: Pathish) -> WavMeasurement:
    """Measure uncompressed WAV duration from its container frame count."""
    source = _input_file(path, error_type=MediaToolError)
    try:
        with wave.open(os.fspath(source), "rb") as wav_file:
            if wav_file.getcomptype() != "NONE":
                raise MediaToolError(
                    f"compressed WAV is unsupported ({wav_file.getcomptype()}): {source}"
                )
            frame_count = wav_file.getnframes()
            sample_rate = wav_file.getframerate()
            channels = wav_file.getnchannels()
    except MediaToolError:
        raise
    except (wave.Error, EOFError, OSError) as exc:
        raise MediaToolError(f"invalid or unreadable WAV {source}: {exc}") from exc
    if frame_count <= 0:
        raise MediaToolError(f"WAV contains no frames: {source}")
    if sample_rate <= 0:
        raise MediaToolError(f"WAV sample rate must be positive: {source}")
    if channels <= 0:
        raise MediaToolError(f"WAV channel count must be positive: {source}")
    return WavMeasurement(
        path=os.fspath(source),
        duration_seconds=frame_count / sample_rate,
        sample_rate_hz=sample_rate,
        channels=channels,
        frame_count=frame_count,
    )


def probe_media(
    path: Pathish,
    *,
    ffprobe_bin: str = "ffprobe",
    timeout_seconds: float = MEDIA_PROBE_TIMEOUT_SECONDS,
    runner: RunCallable | None = None,
) -> MediaProbeResult:
    """Run exactly one ffprobe JSON command and validate its media inventory."""
    source = _input_file(path, error_type=MediaProbeError)
    if not isinstance(ffprobe_bin, str) or not ffprobe_bin.strip():
        raise MediaProbeError("ffprobe_bin must be a nonempty caller value")
    command = (
        ffprobe_bin,
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-of",
        "json",
        os.fspath(source),
    )
    returncode, stdout, stderr, _ = _run_command(
        command,
        timeout_seconds=timeout_seconds,
        runner=runner,
        error_type=MediaProbeError,
    )
    if returncode != 0:
        raise MediaProbeError(f"ffprobe exited {returncode} for {source}: {stderr.strip()[:500]}")
    try:
        payload = json.loads(stdout)
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise MediaProbeError(f"ffprobe returned malformed JSON for {source}: {exc}") from exc
    if not isinstance(payload, dict):
        raise MediaProbeError(f"ffprobe response must be an object for {source}")
    format_data = payload.get("format")
    streams = payload.get("streams")
    if not isinstance(format_data, dict) or not isinstance(streams, list):
        raise MediaProbeError(f"ffprobe response lacks format/streams for {source}")
    try:
        duration = float(format_data["duration"])
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise MediaProbeError(f"ffprobe response lacks a numeric duration for {source}") from exc
    if not math.isfinite(duration) or duration < 0:
        raise MediaProbeError(f"ffprobe duration is invalid for {source}: {duration!r}")
    format_name = format_data.get("format_name")
    if not isinstance(format_name, str) or not format_name:
        raise MediaProbeError(f"ffprobe response lacks format_name for {source}")

    video_streams: list[dict[str, JSONValue]] = []
    audio_streams: list[dict[str, JSONValue]] = []
    for index, stream in enumerate(streams):
        if not isinstance(stream, dict):
            raise MediaProbeError(f"ffprobe stream {index} is not an object for {source}")
        codec_type = stream.get("codec_type")
        if not isinstance(codec_type, str):
            raise MediaProbeError(f"ffprobe stream {index} lacks codec_type for {source}")
        normalized = dict(stream)
        if codec_type in {"video", "audio"}:
            codec_name = normalized.get("codec_name")
            if not isinstance(codec_name, str) or not codec_name or codec_name == "unknown":
                raise MediaProbeError(
                    f"ffprobe {codec_type} stream {index} is undecodable for {source}"
                )
        if codec_type == "video":
            width = normalized.get("width")
            height = normalized.get("height")
            if (
                isinstance(width, bool)
                or not isinstance(width, int)
                or width <= 0
                or isinstance(height, bool)
                or not isinstance(height, int)
                or height <= 0
            ):
                raise MediaProbeError(
                    f"ffprobe video stream {index} lacks positive dimensions for {source}"
                )
            video_streams.append(normalized)
        elif codec_type == "audio":
            audio_streams.append(normalized)
    try:
        size_bytes = source.stat().st_size
    except OSError as exc:
        raise MediaProbeError(f"cannot stat probed media {source}: {exc}") from exc
    return MediaProbeResult(
        path=os.fspath(source),
        duration_seconds=duration,
        format_name=format_name,
        size_bytes=size_bytes,
        video_streams=tuple(video_streams),
        audio_streams=tuple(audio_streams),
    )


def _split_blocks(text: str) -> list[list[str]]:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    blocks: list[list[str]] = []
    current: list[str] = []
    for line in normalized.split("\n"):
        if line == "":
            if current:
                blocks.append(current)
                current = []
        else:
            current.append(line)
    if current:
        blocks.append(current)
    return blocks


def _clock_seconds(parts: Sequence[str]) -> float:
    hours, minutes, seconds, milliseconds = (int(part) for part in parts)
    if minutes >= 60 or seconds >= 60:
        raise CaptionError("caption timestamp minute/second fields must be below 60")
    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000


def _format_vtt_timestamp(seconds: float) -> str:
    milliseconds = int(round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"


def _parse_srt(text: str) -> list[VTTCue]:
    blocks = _split_blocks(text)
    if not blocks:
        raise CaptionError("SRT contains no cues")
    cues: list[VTTCue] = []
    previous_end = 0.0
    for block_index, lines in enumerate(blocks):
        if "-->" in lines[0]:
            identifier = None
            timing_index = 0
        else:
            identifier = lines[0]
            timing_index = 1
        if timing_index >= len(lines):
            raise CaptionError(f"SRT cue {block_index} has no timing line")
        match = _SRT_TIMING_RE.fullmatch(lines[timing_index])
        if match is None:
            raise CaptionError(f"SRT cue {block_index} has malformed timing")
        start = _clock_seconds(match.groups()[:4])
        end = _clock_seconds(match.groups()[4:])
        cue_text = "\n".join(lines[timing_index + 1 :])
        if not cue_text:
            raise CaptionError(f"SRT cue {block_index} has no text")
        if end <= start:
            raise CaptionError(f"SRT cue {block_index} has reversed or empty timing")
        if cues and start < previous_end:
            raise CaptionError(f"SRT cue {block_index} overlaps or is nonmonotonic")
        cues.append(VTTCue(identifier, start, end, cue_text))
        previous_end = end
    return cues


def srt_to_vtt(
    source_path: Pathish,
    destination_path: Pathish,
    *,
    output_root: Pathish,
    scene_ids: Sequence[str] | None = None,
) -> ArtifactRef:
    source = _input_file(source_path, error_type=CaptionError)
    destination = _destination(destination_path, output_root=output_root, error_type=CaptionError)
    try:
        source_text = source.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise CaptionError(f"cannot read UTF-8 SRT {source}: {exc}") from exc
    cues = _parse_srt(source_text)
    if scene_ids is not None:
        if isinstance(scene_ids, (str, bytes)) or not isinstance(scene_ids, Sequence):
            raise CaptionError("scene_ids must be a sequence or None")
        if len(scene_ids) != len(cues):
            raise CaptionError(
                f"scene_ids count {len(scene_ids)} does not equal cue count {len(cues)}"
            )
        normalized_ids: list[str] = []
        for index, scene_id in enumerate(scene_ids):
            if not isinstance(scene_id, str) or not scene_id.strip() or "\n" in scene_id:
                raise CaptionError(f"scene_ids[{index}] must be a nonempty single-line string")
            normalized_ids.append(scene_id)
        if len(set(normalized_ids)) != len(normalized_ids):
            raise CaptionError("scene_ids must not contain duplicates")
        cues = [
            VTTCue(normalized_ids[index], cue.start_seconds, cue.end_seconds, cue.text)
            for index, cue in enumerate(cues)
        ]

    output_lines = ["WEBVTT", ""]
    for cue in cues:
        if cue.identifier is not None:
            output_lines.append(cue.identifier)
        output_lines.append(
            f"{_format_vtt_timestamp(cue.start_seconds)} --> "
            f"{_format_vtt_timestamp(cue.end_seconds)}"
        )
        output_lines.extend(cue.text.split("\n"))
        output_lines.append("")
    encoded = ("\n".join(output_lines).rstrip("\n") + "\n").encode("utf-8")
    temporary = _temporary_path(destination, suffix=".vtt")
    try:
        temporary.write_bytes(encoded)
        return _install_temp(temporary, destination, error_type=CaptionError)
    except CaptionError:
        raise
    except OSError as exc:
        raise CaptionError(f"cannot write WebVTT {destination}: {exc}") from exc
    finally:
        temporary.unlink(missing_ok=True)


def _parse_vtt_timestamp(value: str) -> float:
    components = value.split(":")
    if len(components) == 2:
        hours = 0
        minute_text, second_text = components
    elif len(components) == 3:
        hour_text, minute_text, second_text = components
        hours = int(hour_text)
    else:
        raise CaptionError(f"invalid WebVTT timestamp: {value}")
    seconds_text, separator, milliseconds_text = second_text.partition(".")
    if not separator or len(milliseconds_text) != 3:
        raise CaptionError(f"invalid WebVTT timestamp: {value}")
    minutes = int(minute_text)
    seconds = int(seconds_text)
    milliseconds = int(milliseconds_text)
    if minutes >= 60 or seconds >= 60:
        raise CaptionError(f"invalid WebVTT timestamp: {value}")
    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000


def parse_vtt(text: str) -> tuple[VTTCue, ...]:
    if not isinstance(text, str):
        raise CaptionError("WebVTT input must be text")
    normalized = text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    lines = normalized.split("\n")
    if not lines or not (lines[0] == "WEBVTT" or lines[0].startswith("WEBVTT ")):
        raise CaptionError("WebVTT must start with a WEBVTT header")
    body = "\n".join(lines[1:]).lstrip("\n")
    blocks = _split_blocks(body)
    if not blocks:
        raise CaptionError("WebVTT contains no cues")
    cues: list[VTTCue] = []
    previous_start = -1.0
    previous_end = -1.0
    for index, block in enumerate(blocks):
        if block[0].startswith(("NOTE", "STYLE", "REGION")):
            raise CaptionError(f"unsupported WebVTT block at index {index}: {block[0]}")
        if "-->" in block[0]:
            identifier = None
            timing_index = 0
        else:
            identifier = block[0]
            timing_index = 1
        if timing_index >= len(block):
            raise CaptionError(f"WebVTT cue {index} has no timing line")
        match = _VTT_TIMING_RE.fullmatch(block[timing_index])
        if match is None:
            raise CaptionError(f"WebVTT cue {index} has malformed timing")
        try:
            start = _parse_vtt_timestamp(match.group("start"))
            end = _parse_vtt_timestamp(match.group("end"))
        except (ValueError, CaptionError) as exc:
            raise CaptionError(f"WebVTT cue {index} has malformed timing: {exc}") from exc
        cue_text = "\n".join(block[timing_index + 1 :])
        if not cue_text:
            raise CaptionError(f"WebVTT cue {index} has no text")
        if end <= start:
            raise CaptionError(f"WebVTT cue {index} has reversed or empty timing")
        if cues and (start < previous_start or start < previous_end):
            raise CaptionError(f"WebVTT cue {index} overlaps or is nonmonotonic")
        cues.append(VTTCue(identifier, start, end, cue_text))
        previous_start = start
        previous_end = end
    return tuple(cues)


def _collapse_whitespace(value: str) -> str:
    return " ".join(value.split())


def caption_coverage(
    cues: Sequence[VTTCue],
    *,
    narration_by_scene: Mapping[str, str],
    scene_windows: Mapping[str, tuple[float, float]],
    video_duration_seconds: float,
) -> CaptionCoverage:
    if isinstance(cues, (str, bytes)) or not isinstance(cues, Sequence):
        raise CaptionError("cues must be a sequence of VTTCue values")
    if not isinstance(narration_by_scene, Mapping) or not isinstance(scene_windows, Mapping):
        raise CaptionError("narration_by_scene and scene_windows must be mappings")
    if set(narration_by_scene) != set(scene_windows):
        raise CaptionError("narration_by_scene and scene_windows must have identical scene IDs")
    if (
        isinstance(video_duration_seconds, bool)
        or not isinstance(video_duration_seconds, (int, float))
        or not math.isfinite(float(video_duration_seconds))
        or float(video_duration_seconds) <= 0
    ):
        raise CaptionError("video_duration_seconds must be a positive finite number")
    duration = float(video_duration_seconds)
    normalized_windows: dict[str, tuple[float, float]] = {}
    for scene_id, narration in narration_by_scene.items():
        if not isinstance(scene_id, str) or not scene_id:
            raise CaptionError("scene IDs must be nonempty strings")
        if not isinstance(narration, str):
            raise CaptionError(f"narration for {scene_id!r} must be text")
        window = scene_windows[scene_id]
        if not isinstance(window, tuple) or len(window) != 2:
            raise CaptionError(f"scene window for {scene_id!r} must be a two-item tuple")
        try:
            start, end = float(window[0]), float(window[1])
        except (TypeError, ValueError, OverflowError) as exc:
            raise CaptionError(f"scene window for {scene_id!r} must be numeric") from exc
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            raise CaptionError(f"scene window for {scene_id!r} is invalid")
        if end > duration + 1e-6:
            raise CaptionError(f"scene window for {scene_id!r} exceeds video duration")
        normalized_windows[scene_id] = (start, end)

    mapped_text: dict[str, list[str]] = {scene_id: [] for scene_id in narration_by_scene}
    out_of_range: list[int] = []
    errors: list[str] = []
    for index, cue in enumerate(cues):
        if not isinstance(cue, VTTCue):
            raise CaptionError(f"cues[{index}] is not a VTTCue")
        if (
            not math.isfinite(cue.start_seconds)
            or not math.isfinite(cue.end_seconds)
            or cue.start_seconds < 0
            or cue.end_seconds <= cue.start_seconds
            or cue.end_seconds > duration + 1e-6
        ):
            out_of_range.append(index)
        mapped_scene: str | None = None
        if cue.identifier is not None and cue.identifier in narration_by_scene:
            mapped_scene = cue.identifier
        else:
            containing = [
                scene_id
                for scene_id, (start, end) in normalized_windows.items()
                if cue.start_seconds >= start - 1e-6 and cue.end_seconds <= end + 1e-6
            ]
            if len(containing) == 1:
                mapped_scene = containing[0]
            elif not containing:
                errors.append(f"cue[{index}] is not contained in any scene window")
                out_of_range.append(index)
            else:
                errors.append(f"cue[{index}] is ambiguously contained in multiple scene windows")
        if mapped_scene is not None:
            start, end = normalized_windows[mapped_scene]
            if cue.start_seconds < start - 1e-6 or cue.end_seconds > end + 1e-6:
                errors.append(f"cue[{index}] identifier {mapped_scene!r} exceeds its scene window")
                out_of_range.append(index)
            mapped_text[mapped_scene].append(cue.text)

    covered = tuple(sorted(scene_id for scene_id, texts in mapped_text.items() if texts))
    missing = tuple(sorted(scene_id for scene_id, texts in mapped_text.items() if not texts))
    mismatches = tuple(
        sorted(
            scene_id
            for scene_id, texts in mapped_text.items()
            if texts
            and _collapse_whitespace(" ".join(texts))
            != _collapse_whitespace(narration_by_scene[scene_id])
        )
    )
    unique_out_of_range = tuple(sorted(set(out_of_range)))
    for scene_id in missing:
        errors.append(f"scene {scene_id!r} has no caption cue")
    for scene_id in mismatches:
        errors.append(f"scene {scene_id!r} caption text does not match narration")
    normalized_errors = tuple(sorted(set(errors)))
    return CaptionCoverage(
        ok=not missing and not unique_out_of_range and not mismatches and not normalized_errors,
        cue_count=len(cues),
        covered_scene_ids=covered,
        missing_scene_ids=missing,
        out_of_range_cue_indices=unique_out_of_range,
        text_mismatch_scene_ids=mismatches,
        errors=normalized_errors,
    )


def _concat_line(path: Path) -> str:
    # ffmpeg concat-demuxer quoting: close quote, escape a literal quote, reopen.
    escaped = os.fspath(path).replace("'", "'\\''")
    return f"file '{escaped}'\n"


def assemble_video(
    scene_video_paths: Sequence[Pathish],
    destination_path: Pathish,
    *,
    output_root: Pathish,
    ffmpeg_bin: str = "ffmpeg",
    timeout_seconds: float = MEDIA_ASSEMBLY_TIMEOUT_SECONDS,
    runner: RunCallable | None = None,
) -> CommandResult:
    if isinstance(scene_video_paths, (str, bytes)) or not isinstance(scene_video_paths, Sequence):
        raise AssemblyError("scene_video_paths must be a nonempty sequence")
    if not scene_video_paths:
        raise AssemblyError("scene_video_paths must not be empty")
    if not isinstance(ffmpeg_bin, str) or not ffmpeg_bin.strip():
        raise AssemblyError("ffmpeg_bin must be a nonempty caller value")
    sources = [_input_file(path, error_type=AssemblyError) for path in scene_video_paths]
    destination = _destination(destination_path, output_root=output_root, error_type=AssemblyError)
    if destination.suffix.lower() != ".mp4":
        raise AssemblyError("assembled video destination must end in .mp4")
    concat_path = _temporary_path(destination, suffix=".concat.txt")
    video_path = _temporary_path(destination, suffix=".mp4")
    try:
        concat_path.write_text("".join(_concat_line(path) for path in sources), encoding="utf-8")
        command = (
            ffmpeg_bin,
            "-v",
            "error",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            os.fspath(concat_path),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            os.fspath(video_path),
        )
        returncode, stdout, stderr, elapsed_ms = _run_command(
            command,
            timeout_seconds=timeout_seconds,
            runner=runner,
            error_type=AssemblyError,
        )
        if returncode != 0:
            return CommandResult(
                ok=False,
                command=command,
                returncode=returncode,
                stdout=stdout,
                stderr=stderr,
                elapsed_ms=elapsed_ms,
                artifact=None,
            )
        try:
            generated_probe = probe_media(video_path)
        except MediaProbeError as exc:
            raise AssemblyError(f"assembled output failed media probe: {exc}") from exc
        if generated_probe.duration_seconds <= 0 or not generated_probe.video_streams:
            raise AssemblyError("assembled output lacks nonzero duration or a video stream")
        artifact = _install_temp(video_path, destination, error_type=AssemblyError)
        return CommandResult(
            ok=True,
            command=command,
            returncode=returncode,
            stdout=stdout,
            stderr=stderr,
            elapsed_ms=elapsed_ms,
            artifact=artifact,
        )
    except AssemblyError:
        raise
    except OSError as exc:
        raise AssemblyError(f"cannot prepare video assembly for {destination}: {exc}") from exc
    finally:
        concat_path.unlink(missing_ok=True)
        video_path.unlink(missing_ok=True)


def _scene_ids(value: Sequence[str], *, field: str) -> list[str]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise AssemblyError(f"{field} must be a sequence of scene IDs")
    normalized: list[str] = []
    for index, scene_id in enumerate(value):
        if not isinstance(scene_id, str) or not scene_id:
            raise AssemblyError(f"{field}[{index}] must be a nonempty string")
        normalized.append(scene_id)
    return normalized


def check_assembly(
    probe: MediaProbeResult,
    *,
    expected_scene_ids: Sequence[str],
    assembly_order: Sequence[str],
    require_audio: bool,
) -> dict[str, JSONValue]:
    if not isinstance(probe, MediaProbeResult):
        raise AssemblyError("probe must be a MediaProbeResult")
    if not isinstance(require_audio, bool):
        raise AssemblyError("require_audio must be a bool")
    expected = _scene_ids(expected_scene_ids, field="expected_scene_ids")
    order = _scene_ids(assembly_order, field="assembly_order")
    if len(set(expected)) != len(expected):
        raise AssemblyError("expected_scene_ids must not contain duplicates")
    errors: list[str] = []
    if order != expected:
        errors.append("assembly order does not exactly equal expected scene order")
    duplicates = sorted({scene_id for scene_id in order if order.count(scene_id) > 1})
    if duplicates:
        errors.append(f"duplicate assembled scenes: {', '.join(duplicates)}")
    missing = sorted(set(expected) - set(order))
    unexpected = sorted(set(order) - set(expected))
    if missing:
        errors.append(f"omitted scenes: {', '.join(missing)}")
    if unexpected:
        errors.append(f"unexpected scenes: {', '.join(unexpected)}")
    if probe.duration_seconds <= 0:
        errors.append("assembled media duration is not positive")
    if not probe.video_streams:
        errors.append("assembled media has no video stream")
    if require_audio and not probe.audio_streams:
        errors.append("assembled media has no required audio stream")
    error_values: list[JSONValue] = list(errors)
    expected_values: list[JSONValue] = list(expected)
    order_values: list[JSONValue] = list(order)
    return {
        "ok": not errors,
        "errors": error_values,
        "duration_seconds": probe.duration_seconds,
        "video_stream_count": len(probe.video_streams),
        "audio_stream_count": len(probe.audio_streams),
        "expected_scene_ids": expected_values,
        "assembly_order": order_values,
    }


def _jpeg_dimensions(path: Path) -> tuple[int, int]:
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise PosterError(f"cannot read generated poster {path}: {exc}") from exc
    if len(data) < 4 or data[:2] != b"\xff\xd8" or data[-2:] != b"\xff\xd9":
        raise PosterError(f"generated poster is not a complete JPEG: {path}")
    offset = 2
    sof_markers = {
        0xC0,
        0xC1,
        0xC2,
        0xC3,
        0xC5,
        0xC6,
        0xC7,
        0xC9,
        0xCA,
        0xCB,
        0xCD,
        0xCE,
        0xCF,
    }
    while offset + 4 <= len(data):
        if data[offset] != 0xFF:
            offset += 1
            continue
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            break
        marker = data[offset]
        offset += 1
        if marker in {0xD8, 0xD9}:
            continue
        if marker == 0xDA:
            break
        if offset + 2 > len(data):
            break
        segment_length = int.from_bytes(data[offset : offset + 2], "big")
        if segment_length < 2 or offset + segment_length > len(data):
            break
        if marker in sof_markers:
            if segment_length < 7:
                break
            height = int.from_bytes(data[offset + 3 : offset + 5], "big")
            width = int.from_bytes(data[offset + 5 : offset + 7], "big")
            if width <= 0 or height <= 0:
                break
            return width, height
        offset += segment_length
    raise PosterError(f"generated JPEG has no valid dimension marker: {path}")


def extract_poster(
    scene1_final_video_path: Pathish,
    destination_path: Pathish,
    *,
    output_root: Pathish,
    ffmpeg_bin: str = "ffmpeg",
    timeout_seconds: float = POSTER_TIMEOUT_SECONDS,
    runner: RunCallable | None = None,
) -> CommandResult:
    source = _input_file(scene1_final_video_path, error_type=PosterError)
    destination = _destination(destination_path, output_root=output_root, error_type=PosterError)
    if destination.suffix.lower() not in {".jpg", ".jpeg"}:
        raise PosterError("poster destination must end in .jpg or .jpeg")
    if not isinstance(ffmpeg_bin, str) or not ffmpeg_bin.strip():
        raise PosterError("ffmpeg_bin must be a nonempty caller value")
    try:
        source_probe = probe_media(source)
    except MediaProbeError as exc:
        raise PosterError(f"scene-1 final video failed media probe: {exc}") from exc
    if not source_probe.video_streams:
        raise PosterError("scene-1 final video has no video stream")
    first_stream = source_probe.video_streams[0]
    width = first_stream.get("width")
    height = first_stream.get("height")
    if not isinstance(width, int) or not isinstance(height, int):
        raise PosterError("scene-1 final video lacks integer dimensions")
    if width * 9 != height * 16:
        raise PosterError(f"scene-1 final video must be 16:9, got {width}x{height}")

    poster_path = _temporary_path(destination, suffix=".jpg")
    try:
        command = (
            ffmpeg_bin,
            "-v",
            "error",
            "-y",
            "-i",
            os.fspath(source),
            "-map",
            "0:v:0",
            "-vf",
            r"select=eq(n\,0)",
            "-frames:v",
            "1",
            "-c:v",
            "mjpeg",
            "-q:v",
            str(POSTER_FFMPEG_QSCALE),
            os.fspath(poster_path),
        )
        returncode, stdout, stderr, elapsed_ms = _run_command(
            command,
            timeout_seconds=timeout_seconds,
            runner=runner,
            error_type=PosterError,
        )
        if returncode != 0:
            return CommandResult(
                ok=False,
                command=command,
                returncode=returncode,
                stdout=stdout,
                stderr=stderr,
                elapsed_ms=elapsed_ms,
                artifact=None,
            )
        poster_width, poster_height = _jpeg_dimensions(poster_path)
        if (poster_width, poster_height) != (width, height):
            raise PosterError(
                "poster dimensions differ from source video: "
                f"{poster_width}x{poster_height} != {width}x{height}"
            )
        artifact = _install_temp(poster_path, destination, error_type=PosterError)
        return CommandResult(
            ok=True,
            command=command,
            returncode=returncode,
            stdout=stdout,
            stderr=stderr,
            elapsed_ms=elapsed_ms,
            artifact=artifact,
        )
    finally:
        poster_path.unlink(missing_ok=True)
