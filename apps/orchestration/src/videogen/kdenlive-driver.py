#!/usr/bin/python3
"""Fixed native ABI, run only inside ConfinedNativeRunner's disposable namespace.

Tools/configuration are pinned host bindings at /runtime/kdenlive-tools.json.
No PATH lookup, network, shell source, installation, GUI coordinates or PASS inputs.
KMainWindow Save As + Qt QWidget.close are introspected on the actual private bus;
MLT's documented avformat consumer renders the explicitly marked terminal wrapper.
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

PROTOCOL = "kdenlive-dbus-mlt-v1"
VERBS = (
    "open_save_normalize",
    "close_reopen_readback",
    "relocate_reopen_readback",
    "render_compare",
)
MAIN = "/kdenlive/MainWindow_1"
MAX_CONTROL = 1048576
TRANSCRIPT: list[dict[str, object]] = []
PROCESSES: list[dict[str, object]] = []
ACTIONS: list[str] = []


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError("native driver: " + message)


def canonical(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode()


def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def unique(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def mapping(value: object) -> dict[str, object]:
    require(isinstance(value, dict), "object required")
    if not isinstance(value, dict):
        raise ValueError("object required")
    result: dict[str, object] = {}
    for key, item in value.items():
        require(isinstance(key, str), "string key required")
        if isinstance(key, str):
            result[key] = item
    return result


def string(value: object) -> str:
    require(isinstance(value, str), "string required")
    if not isinstance(value, str):
        raise ValueError("string required")
    return value


def read(path: Path, cap: int = MAX_CONTROL) -> bytes:
    require(not path.is_symlink() and path.is_file(), "regular file required")
    with path.open("rb") as stream:
        data = stream.read(cap + 1)
    require(0 < len(data) <= cap, "file byte bound")
    return data


def read_map(path: Path) -> dict[str, object]:
    value: object = json.loads(read(path), object_pairs_hook=unique)
    return mapping(value)


def portable(value: str) -> str:
    require(bool(re.fullmatch(r"[A-Za-z0-9_./-]{1,512}", value)), "relative path syntax")
    require(
        not value.startswith("/") and all(p and not p.startswith(".") for p in value.split("/")),
        "relative path escape",
    )
    return value


def caption_family(caption: bytes) -> str:
    """Closed single-style ASS subset: no embedded resources or font/animation overrides."""
    text = caption.decode("utf-8")
    lines = text.splitlines()
    sections = [line for line in lines if line.startswith("[")]
    require(
        sections == ["[Script Info]", "[Kdenlive Extradata]", "[V4+ Styles]", "[Events]"],
        "unsupported caption section/resource",
    )
    styles = [line for line in lines if line.lstrip().casefold().startswith("style:")]
    require(len(styles) == 1, "one active caption style required")
    family = re.fullmatch(r"Style: Default,([A-Za-z0-9 -]{1,64}),.*", styles[0])
    require(family is not None, "one safe caption font family required")
    events = [line for line in lines if line.lstrip().casefold().startswith("dialogue:")]
    require(bool(events), "active caption events required")
    for event in events:
        fields = event.split(",", 9)
        require(
            len(fields) == 10 and fields[3:9] == ["Default", "", "0", "0", "0", ""],
            "unsupported caption event/effect",
        )
        require(
            not any(c in fields[9].replace("\\N", "") for c in "{}\\"),
            "caption font/active override refused",
        )
    if family is None:
        raise ValueError("caption family absent")
    return family.group(1)


class Driver:
    def __init__(self, verb: str) -> None:
        self.verb = verb
        self.root = Path("/relocated" if verb == "relocate_reopen_readback" else "/input")
        self.call = read_map(self.root / "native-call.json")
        require(
            self.call.get("protocol") == PROTOCOL and self.call.get("verb") == verb,
            "host correlation required",
        )
        config = read_map(Path("/runtime/kdenlive-tools.json"))
        require(set(config) == {"tools", "environment", "bus_config"}, "closed tool configuration")
        self.tools = mapping(config["tools"])
        self.env = {key: string(value) for key, value in mapping(config["environment"]).items()}
        require(
            set(self.env)
            <= {
                "LD_LIBRARY_PATH",
                "MLT_REPOSITORY",
                "MLT_DATA",
                "MLT_ROOT_DIR",
                "MLT_APPDIR",
                "MLT_PROFILES_PATH",
                "MLT_PRESETS_PATH",
                "XDG_DATA_DIRS",
                "FONTCONFIG_FILE",
                "ALSA_CONFIG_PATH",
                "PULSE_CLIENTCONFIG",
                "QT_PLUGIN_PATH",
            },
            "unsupported environment key",
        )
        self.env.update(
            {
                "HOME": "/work/home",
                "TMPDIR": "/tmp",
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
                "QT_QPA_PLATFORM": "xcb",
                "QT_QUICK_BACKEND": "software",
                "LIBGL_ALWAYS_SOFTWARE": "1",
                "QT_XCB_GL_INTEGRATION": "none",
                "SDL_AUDIODRIVER": "dummy",
                "OMP_NUM_THREADS": "1",
                "OPENBLAS_NUM_THREADS": "1",
                "DISPLAY": ":91",
                "XAUTHORITY": "/tmp/xauth",
                "XDG_RUNTIME_DIR": "/tmp/runtime",
                "PULSE_SERVER": "unix:/tmp/no-pulse",
            }
        )
        self.fonts: list[dict[str, str]] = []
        self.caption: dict[str, str] | None = None
        self.caption_bytes: bytes | None = None
        self.bus_config = string(config["bus_config"])
        for role in (
            "python",
            "editor",
            "renderer",
            "xvfb",
            "xauth",
            "xwininfo",
            "xdotool",
            "gdbus",
            "dbus_session",
        ):
            self.tool(role)
        self.session = Path(
            "/work/relocated" if verb == "relocate_reopen_readback" else "/work/session"
        )

    def tool(self, role: str) -> str:
        pin = mapping(self.tools[role])
        require(set(pin) == {"path", "sha256"}, "closed tool pin")
        name = string(pin["path"])
        require(name.startswith("/") and ".." not in Path(name).parts, "tool path")
        require(sha(read(Path(name), 33554432)) == pin["sha256"], "tool byte pin drift")
        return name

    def command(self, role: str, args: list[str], *, data: bytes | None = None) -> bytes:
        argv = [self.tool(role), *args]
        result = subprocess.run(
            argv,
            input=data,
            stdin=subprocess.DEVNULL if data is None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self.env,
            timeout=12,
            check=False,
        )
        require(len(result.stdout) + len(result.stderr) <= MAX_CONTROL, "command output bound")
        TRANSCRIPT.append(
            {
                "argv": argv,
                "exit": result.returncode,
                "stdout": result.stdout.decode(errors="replace"),
                "stderr": result.stderr.decode(errors="replace"),
            }
        )
        require(len(canonical(TRANSCRIPT)) <= MAX_CONTROL, "transcript bound")
        require(
            result.returncode == 0,
            "control failed: " + role + ": " + result.stderr[:512].decode(errors="replace"),
        )
        return result.stdout

    def observe(
        self, process: subprocess.Popen[bytes], role: str, argv: list[str]
    ) -> dict[str, object]:
        root = Path("/proc") / str(process.pid)
        before = read(root / "stat", 8192)
        executable = root / "exe"
        # /proc/exe is a kernel identity link, intentionally followed, never a caller path.
        with executable.open("rb") as stream:
            payload = stream.read(33554433)
        expected = mapping(self.tools["editor" if role == "editor" else "renderer"])
        raw = read(root / "cmdline", 16384)
        namespaces = {key: os.readlink(root / "ns" / key) for key in ("pid", "mnt", "net")}
        after = read(root / "stat", 8192)
        require(
            len(payload) <= 33554432 and sha(payload) == expected["sha256"],
            "live executable mismatch",
        )
        require(
            os.readlink(executable) == argv[0]
            and raw == b"\0".join(a.encode() for a in argv) + b"\0",
            "live argv/executable mismatch",
        )
        first, last = before.rsplit(b") ", 1)[1].split(), after.rsplit(b") ", 1)[1].split()
        require(
            first[1] == last[1] == str(os.getpid()).encode() and first[19] == last[19],
            "process identity changed",
        )
        require(
            all(
                value == os.readlink(Path("/proc/self/ns") / key)
                for key, value in namespaces.items()
            ),
            "process namespace drift",
        )
        plugins: list[dict[str, str]] = []
        mapped = read(root / "maps", MAX_CONTROL).decode().splitlines()
        repository = Path(self.env["MLT_REPOSITORY"])
        require(
            repository.is_absolute() and ".." not in repository.parts and repository != Path("/"),
            "pinned plugin repository required",
        )
        objects = sorted(
            {
                line.split()[-1]
                for line in mapped
                if len(line.split()) >= 6
                and "x" in line.split()[1]
                and Path(line.split()[-1]).is_relative_to(repository)
            }
        )
        require(len(objects) <= 128, "loaded plugin bound")
        for name in objects:
            plugins.append({"target": name, "sha256": sha(read(Path(name), 134217728))})
        require(len(os.sched_getaffinity(process.pid)) == 1, "native process CPU affinity drift")
        return {
            "cpu_ids": sorted(os.sched_getaffinity(process.pid)),
            "role": role,
            "pid": process.pid,
            "start_ticks": int(first[19]),
            "executable_sha256": sha(payload),
            "argv": argv,
            "namespaces": namespaces,
            "plugins": plugins,
        }

    def bus(self, service: str, method: str, *args: str) -> bytes:
        try:
            return self.command(
                "gdbus",
                [
                    "call",
                    "--session",
                    "--dest",
                    service,
                    "--object-path",
                    MAIN,
                    "--method",
                    method,
                    "--",
                    *args,
                ],
            )
        except ValueError as error:
            raise ValueError(method + ": " + str(error)) from error

    def input_rows(self) -> list[dict[str, object]]:
        rows = self.call["files"]
        if not isinstance(rows, list) or not 1 <= len(rows) <= 1024:
            raise ValueError("bounded input manifest required")
        result = [mapping(row) for row in rows]
        require(sha(canonical(result)) == self.call["inputs_sha256"], "input manifest correlation")
        return result

    def caption_alias(self, tree: ET.Element, property_name: str, name_value: str) -> str:
        if property_name == "av.filename" and re.fullmatch(
            r"(?:saved|saved-first|saved-second)\.kdenlive\.ass", name_value
        ):
            listed = tree.findtext(".//property[@name='kdenlive:sequenceproperties.subtitlesList']")
            entries_value: object = json.loads(listed or "[]")
            require(
                isinstance(entries_value, list) and len(entries_value) == 1,
                "caption alias requires original binding",
            )
            if not isinstance(entries_value, list):
                raise ValueError("caption alias requires original binding")
            name_value = string(mapping(entries_value[0])["file"])
            for prefix in ("/work/session/", "/work/relocated/", "./"):
                name_value = name_value.removeprefix(prefix)
        return name_value

    def rewrite_resources(self, tree: ET.Element) -> None:
        for node in tree.iter("property"):
            property_name = node.get("name")
            if property_name in {"resource", "av.filename"} and node.text != "black":
                name_value = node.text or ""
                for prefix in ("/work/session/", "/work/relocated/", "./"):
                    name_value = name_value.removeprefix(prefix)
                name_value = self.caption_alias(tree, string(property_name), name_value)
                node.text = str(self.session / portable(name_value))
            if property_name == "kdenlive:sequenceproperties.subtitlesList":
                entries: object = json.loads(node.text or "")
                require(isinstance(entries, list), "subtitle list required")
                if not isinstance(entries, list):
                    raise ValueError("subtitle list required")
                mapped: list[dict[str, object]] = []
                for entry in entries:
                    fields = mapping(entry)
                    name_value = string(fields["file"])
                    for prefix in ("/work/session/", "/work/relocated/", "./"):
                        name_value = name_value.removeprefix(prefix)
                    fields["file"] = str(self.session / portable(name_value))
                    mapped.append(fields)
                node.text = canonical(mapped).decode()

    def bind_captions(self, tree: ET.Element, rows: list[dict[str, object]]) -> None:
        captions = [p.text for p in tree.iter("property") if p.get("name") == "av.filename"]
        require(len(captions) <= 1, "one active caption source supported")
        if captions:
            caption = read(Path(captions[0] or ""))
            self.caption_bytes = caption
            self.caption = {
                "relative_path": str(Path(captions[0] or "").relative_to(self.session)),
                "sha256": sha(caption),
                "sidecar_sha256": sha(caption),
            }
            Path(str(self.session / "project.kdenlive") + ".ass").write_bytes(caption)
            font_paths = [
                portable(string(mapping(r)["relative_path"]))
                for r in rows
                if string(mapping(r)["relative_path"]).endswith((".ttf", ".otf"))
            ]
            require(len(font_paths) == 1, "one packaged active font required")
            family = caption_family(caption)
            font_path = self.session / font_paths[0]
            fc = ET.Element("fontconfig")
            ET.SubElement(fc, "dir").text = str(font_path.parent)
            ET.SubElement(fc, "cachedir").text = "/work/font-cache"
            Path("/work/native-fonts.conf").write_bytes(
                ET.tostring(fc, encoding="utf-8", xml_declaration=True)
            )
            self.env["FONTCONFIG_FILE"] = "/work/native-fonts.conf"
            match = (
                self.command("fc_match", ["-f", "%{file}\n%{family}\n", "--", family])
                .decode()
                .splitlines()
            )
            require(
                len(match) == 2 and Path(match[0]) == font_path and family in match[1].split(","),
                "active font fallback or unbound resource",
            )
            self.fonts.append(
                {
                    "relative_path": font_paths[0],
                    "sha256": sha(read(font_path, 33554432)),
                    "family": family,
                }
            )

    def prepare(self) -> None:
        rows = self.input_rows()
        self.session.mkdir(mode=0o700)
        for raw in rows:
            row = mapping(raw)
            name = portable(string(row["relative_path"]))
            source = self.root / name
            payload = read(source, 67108864)
            require(
                len(payload) == row["bytes"] and sha(payload) == row["sha256"],
                "input bytes changed",
            )
            target = self.session / name
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with target.open("xb") as stream:
                stream.write(payload)
        if self.verb == "relocate_reopen_readback":
            require(
                not Path("/input/project.kdenlive").exists(), "original project still accessible"
            )
        project = self.session / "project.kdenlive"
        payload = read(project)
        require(b"<!" not in payload, "active XML refused")
        tree = ET.fromstring(payload)
        require(
            tree.get("root") in {".", "/work/session", "/work/relocated"},
            "portable or observed confined root required",
        )
        tree.set("root", str(self.session))
        self.rewrite_resources(tree)
        self.bind_captions(tree, rows)
        project.write_bytes(ET.tostring(tree, encoding="utf-8", xml_declaration=True))

    def open_service(self, process: subprocess.Popen[bytes], project: Path, output: Path) -> str:
        service = ""
        for _ in range(100):
            require(
                process.poll() is None,
                "editor exited before open: "
                + (Path("/work") / (output.stem + ".editor.log")).read_text()[-2048:],
            )
            names = self.command(
                "gdbus",
                [
                    "call",
                    "--session",
                    "--dest",
                    "org.freedesktop.DBus",
                    "--object-path",
                    "/org/freedesktop/DBus",
                    "--method",
                    "org.freedesktop.DBus.ListNames",
                ],
            )
            candidates = re.findall(rb"'([^']*kdenlive[^']*)'", names)
            if candidates:
                require(len(candidates) == 1, "ambiguous private editor service")
                service = candidates[0].decode()
                break
            time.sleep(0.1)
        require(bool(service), "editor bus service absent")
        actual = self.command(
            "gdbus",
            [
                "call",
                "--session",
                "--dest",
                "org.freedesktop.DBus",
                "--object-path",
                "/org/freedesktop/DBus",
                "--method",
                "org.freedesktop.DBus.GetConnectionUnixProcessID",
                service,
            ],
        )
        require(actual == f"(uint32 {process.pid},)\n".encode(), "DBus/editor PID mismatch")
        introspection = b""
        for _ in range(100):
            require(process.poll() is None, "editor exited before interface publication")
            try:
                introspection = self.command(
                    "gdbus",
                    [
                        "introspect",
                        "--session",
                        "--dest",
                        service,
                        "--object-path",
                        MAIN,
                        "--xml",
                    ],
                )
                break
            except ValueError as error:
                if "UnknownObject" not in str(error):
                    raise
                time.sleep(0.1)
        require(bool(introspection), "editor interface startup bound")
        tree = ET.fromstring(introspection)
        require(
            any(n.get("name") == "activateAction" for n in tree.iter("method"))
            and any(n.get("name") == "close" for n in tree.iter("method")),
            "supported Save/close interfaces absent",
        )
        for _ in range(150):
            title = self.bus(
                service,
                "org.freedesktop.DBus.Properties.Get",
                "org.qtproject.Qt.QWidget",
                "windowTitle",
            )
            enabled = self.bus(
                service,
                "org.freedesktop.DBus.Properties.Get",
                "org.qtproject.Qt.QWidget",
                "enabled",
            )
            if project.stem.encode() in title and enabled == b"(<true>,)\n":
                break
            require(process.poll() is None, "editor exited before document open")
            time.sleep(0.1)
        else:
            raise ValueError("native driver: requested document did not open")
        return service

    def edit(self, project: Path, output: Path) -> Path:
        argv = [self.tool("editor"), "--no-welcome", str(project)]
        with (Path("/work") / (output.stem + ".editor.log")).open("xb") as log:
            process = subprocess.Popen(
                argv,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                cwd=self.session,
                env=self.env,
            )
            try:
                service = self.open_service(process, project, output)
                identity = self.observe(process, "editor", argv)
                ACTIONS.append("editor_opened")
                require(
                    self.bus(service, "org.kde.KMainWindow.actionIsEnabled", "file_save_as")
                    == b"(true,)\n",
                    "Save As unavailable",
                )
                save_args = [
                    self.tool("gdbus"),
                    "call",
                    "--session",
                    "--dest",
                    service,
                    "--object-path",
                    MAIN,
                    "--method",
                    "org.kde.KMainWindow.activateAction",
                    "--",
                    "file_save_as",
                ]
                with subprocess.Popen(
                    save_args,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=self.env,
                ) as save:
                    windows: list[tuple[bytes, bytes]] = []
                    for _ in range(50):
                        view = self.command("xwininfo", ["-root", "-tree"])
                        windows = re.findall(rb'(0x[0-9a-f]+) "([^"\n]*[Ss]ave[^"\n]*)"', view)
                        if windows:
                            break
                        require(save.poll() is None, "Save action returned without dialog")
                        time.sleep(0.1)
                    require(
                        len(windows) == 1,
                        "unique native Save As dialog absent: "
                        + view.decode(errors="replace")[:1600],
                    )
                    self.command("xdotool", ["windowfocus", "--sync", windows[0][0].decode()])
                    self.command("xdotool", ["key", "--clearmodifiers", "ctrl+a"])
                    self.command(
                        "xdotool", ["type", "--clearmodifiers", "--delay", "1", str(output)]
                    )
                    self.command("xdotool", ["key", "--clearmodifiers", "Return"])
                    stdout, stderr = save.communicate(timeout=12)
                    require(
                        save.returncode == 0 and stdout == b"(true,)\n" and not stderr,
                        "native Save As refused",
                    )
                    TRANSCRIPT.append(
                        {
                            "argv": save_args,
                            "exit": save.returncode,
                            "stdout": stdout.decode(),
                            "stderr": stderr.decode(),
                        }
                    )
                read(output)
                self.verify_resources(output)
                ACTIONS.append("save_as")
                require(
                    self.bus(
                        service,
                        "org.freedesktop.DBus.Properties.Get",
                        "org.qtproject.Qt.QWidget",
                        "windowModified",
                    )
                    == b"(<false>,)\n",
                    "unsaved editor state after Save As",
                )
                try:
                    require(
                        self.bus(service, "org.qtproject.Qt.QWidget.close") == b"(true,)\n",
                        "graceful close refused",
                    )
                except ValueError as error:
                    # Qt may tear down its bus connection before delivering close()'s reply.
                    # Only that close-call race plus an independently waited natural exit 0
                    # is accepted. Cleanup-induced termination can never satisfy this branch.
                    require(
                        ("NoReply" in str(error) or "ServiceUnknown" in str(error))
                        and process.wait(timeout=12) == 0,
                        "close reply missing without natural exit 0: " + str(error),
                    )
                require(process.wait(timeout=12) == 0, "editor nonzero exit")
                identity["exit_code"] = 0
                PROCESSES.append(identity)
                ACTIONS.append("editor_exited")
                return output
            finally:
                if process.poll() is not None and process.returncode != 0:
                    sys.stderr.write(
                        "native editor exit "
                        + str(process.returncode)
                        + ": "
                        + (Path("/work") / (output.stem + ".editor.log")).read_text()[-2048:]
                        + "\n"
                    )
                Path("/work/driver-transcript.json").write_bytes(canonical(TRANSCRIPT))
                if process.poll() is None:
                    self.command("xwininfo", ["-root", "-tree"])
                    Path("/work/driver-transcript.json").write_bytes(canonical(TRANSCRIPT))
                    process.kill()
                    process.wait(timeout=3)

    def verify_resources(self, project: Path) -> None:
        rows = self.input_rows()
        for raw in rows:
            row = mapping(raw)
            name = portable(string(row["relative_path"]))
            if name != "project.kdenlive":
                require(
                    sha(read(self.session / name, 67108864)) == row["sha256"],
                    "native asset changed",
                )
        tree = ET.fromstring(read(project))
        caption = tree.find(".//property[@name='av.filename']")
        require(
            (caption is not None) == (self.caption_bytes is not None),
            "active caption presence changed",
        )
        if caption is not None:
            original = Path(caption.text or "")
            if not original.is_absolute():
                original = self.session / portable(str(original).removeprefix("./"))
            require(original.is_relative_to(self.session), "saved caption resource escaped")
            sidecar = Path(str(project) + ".ass")
            require(
                read(sidecar) == self.caption_bytes and read(original) == self.caption_bytes,
                "native caption sidecar missing or changed",
            )

    def render(self, project: Path) -> bytes:
        payload = read(project)
        require(b"<!" not in payload, "active XML declaration refused")
        root = ET.fromstring(payload)
        wrappers = [
            n
            for n in root.findall("tractor")
            if n.findtext("property[@name='kdenlive:projectTractor']") == "1"
        ]
        require(
            len(wrappers) == 1 and list(root)[-1] is wrappers[0],
            "unique terminal marked project wrapper required",
        )
        wrapper = wrappers[0]
        require(
            len(wrapper.findall("track")) == 1 and wrapper.get("in") in {"0", "00:00:00.000"},
            "unsupported wrapper range",
        )
        # MLT XML loader returns the terminal producing service, not root@producer.
        # Do NOT select an arbitrary last tractor or reinterpret retained main_bin.
        target = Path("/work/render.mp4")
        wrapper_track = wrapper.find("track")
        if wrapper_track is None:
            raise ValueError("render wrapper track absent")
        sequence_id = wrapper_track.get("producer")
        sequence = next((n for n in root.findall("tractor") if n.get("id") == sequence_id), None)
        require(sequence is not None, "render sequence absent")
        frames = (
            int(sequence.findtext("property[@name='kdenlive:maxduration']") or "0")
            if sequence is not None
            else 0
        )
        require(0 < frames <= 10000000, "render content extent bound")
        args = [
            self.tool("renderer"),
            str(project),
            "in=0",
            "out=" + str(frames - 1),
            "-consumer",
            "avformat:" + str(target),
            "f=mp4",
            "vcodec=libx264",
            "acodec=aac",
            "threads=1",
            "real_time=-1",
            "preset=veryfast",
            "crf=18",
            "bf=0",
            "pix_fmt=yuv420p",
            "channels=1",
            "ar=48000",
            "ab=160k",
            "g=25",
            "vprofile=baseline",
        ]
        ACTIONS.append("render_job_written")
        with Path("/work/render.log").open("xb") as log:
            process = subprocess.Popen(
                args,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                cwd=self.session,
                env=self.env,
            )
            try:
                while not target.exists():
                    require(process.poll() is None, "renderer exited before consumer publication")
                    time.sleep(0.01)
                identity = self.observe(process, "renderer", args)
                ACTIONS.append("renderer_observed")
                while process.poll() is None:
                    before = read(Path("/proc") / str(process.pid) / "stat", 8192)
                    try:
                        process.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        after = read(Path("/proc") / str(process.pid) / "stat", 8192)
                        if before != after:
                            sys.stderr.write(
                                "native-progress renderer CPU/process state advanced\n"
                            )
                            sys.stderr.flush()
                require(process.returncode == 0, "native renderer failed")
                identity["exit_code"] = 0
                PROCESSES.append(identity)
                ACTIONS.append("renderer_exited")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=3)
        result = read(target, 67108864)
        ACTIONS.append("render_readback")
        return result

    def run(self) -> bytes:
        self.prepare()
        project = self.session / "project.kdenlive"
        if self.verb == "render_compare":
            return self.render(project)
        if self.verb == "close_reopen_readback":
            first = self.edit(project, self.session / "saved-first.kdenlive")
            final = self.edit(first, self.session / "saved-second.kdenlive")
        else:
            ACTIONS.append(
                "original_unavailable"
                if self.verb == "relocate_reopen_readback"
                else "input_copied"
            )
            final = self.edit(project, self.session / "saved.kdenlive")
        ACTIONS.append("saved_readback")
        return read(final)

    def session_main(self) -> None:
        self.env["DBUS_SESSION_BUS_ADDRESS"] = os.environ["DBUS_SESSION_BUS_ADDRESS"]
        # Verify actual kernel enforcement after exec, not just prctl()'s return value.
        # Isolated Python cannot import a module from the input/project directory.
        protection_probe = (
            "import os,sys\n"
            "for member in ('mem','fd/1'):\n"
            " try: fd=os.open('/proc/'+sys.argv[1]+'/'+member,os.O_RDONLY|os.O_CLOEXEC)\n"
            " except PermissionError: continue\n"
            " else: os.close(fd); raise SystemExit('controller proc capability exposed')\n"
        )
        self.command("python", ["-I", "-c", protection_probe, str(os.getpid())])
        Path("/work/home/.config").mkdir(mode=0o700, parents=True)
        # KDE's file dialog falls back to HOME when its default video directory is absent.
        # Keep reopen metadata on the same fixed, confined path across fresh sessions.
        Path("/work/home/Videos").mkdir(mode=0o700)
        Path("/work/home/.config/kdenliverc").write_text(
            "[sdl]\naudiodrivername=dummy\n[env]\nprocessingthreads=1\nencodethreads=1\n"
        )
        Path("/tmp/runtime").mkdir(mode=0o700)
        Path("/tmp/.X11-unix").mkdir(mode=0o700)
        self.command(
            "xauth",
            ["-f", "/tmp/xauth", "source", "-"],
            data=("add :91 MIT-MAGIC-COOKIE-1 " + os.urandom(16).hex() + "\n").encode(),
        )
        args = [
            self.tool("xvfb"),
            ":91",
            "-screen",
            "0",
            "1280x800x24",
            "-auth",
            "/tmp/xauth",
            "-nolisten",
            "tcp",
            "-noreset",
            "-fp",
            "/usr/share/fonts/X11/misc",
        ]
        with Path("/work/xvfb.log").open("xb") as log:
            display = subprocess.Popen(
                args, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=self.env
            )
            try:
                time.sleep(0.5)
                require(
                    display.poll() is None,
                    "private Xvfb exited: " + Path("/work/xvfb.log").read_text()[:1024],
                )
                self.command("xwininfo", ["-root"])
                payload = self.run()
                self.verify_resources(self.session / "project.kdenlive")
                control = [
                    {
                        "argv": r["argv"],
                        "exit_code": r["exit"],
                        "stdout_sha256": sha(string(r["stdout"]).encode()),
                        "stderr_sha256": sha(string(r["stderr"]).encode()),
                    }
                    for r in TRANSCRIPT
                ]
                require(len(control) <= 512, "control observation count bound")
                header = {
                    "control": control,
                    "protocol": PROTOCOL,
                    "nonce": self.call["nonce"],
                    "verb": self.verb,
                    "inputs_sha256": self.call["inputs_sha256"],
                    "runtime_sha256": self.call["runtime_sha256"],
                    "processes": PROCESSES,
                    "fonts": self.fonts,
                    "caption": self.caption,
                    "actions": ACTIONS,
                    "payload_sha256": sha(payload),
                    "payload_bytes": len(payload),
                    "control_sha256": sha(canonical(control)),
                }
                encoded = canonical(header)
                require(len(encoded) <= 65536, "phase evidence bound")
                sys.stdout.buffer.write(struct.pack(">I", len(encoded)) + encoded + payload)
                sys.stdout.buffer.flush()
            finally:
                display.terminate()
                display.wait(timeout=3)


def main() -> None:
    os.umask(0o077)
    # Prevent same-UID native children from opening the controller's /proc memory/fds.
    # This is a fixed libc operation, never caller-provided FFI or a syscall selector.
    prctl = ctypes.CDLL(None, use_errno=True).prctl
    prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    prctl.restype = ctypes.c_int
    pr_set_dumpable = 4
    require(prctl(pr_set_dumpable, 0, 0, 0, 0) == 0, "controller process protection unavailable")
    # Bound library auto-thread sizing to one already-admitted CPU. No host affinity,
    # CPU index, shell command or deployment topology is assumed or widened.
    admitted_cpus = os.sched_getaffinity(0)
    require(bool(admitted_cpus), "admitted CPU affinity absent")
    os.sched_setaffinity(0, {min(admitted_cpus)})
    require(len(sys.argv) == 2 and sys.argv[1] in VERBS, "one fixed verb required")
    driver = Driver(sys.argv[1])
    if os.environ.get("PENNY_NATIVE_SESSION") == PROTOCOL:
        driver.session_main()
    else:
        env = {**driver.env, "PENNY_NATIVE_SESSION": PROTOCOL}
        argv = [
            driver.tool("dbus_session"),
            "--config-file=" + driver.bus_config,
            "--",
            driver.tool("python"),
            str(Path(__file__)),
            driver.verb,
        ]
        env.pop(
            "LD_LIBRARY_PATH", None
        )  # Private bus uses host-pinned libdbus, not the editor bundle.
        os.execve(argv[0], argv, env)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError, ET.ParseError) as error:
        sys.stderr.write(str(error)[:2048] + "\n")
        raise SystemExit(1) from error
