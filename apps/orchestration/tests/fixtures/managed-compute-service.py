"""Isolated CPU-only protocol fixture; not a production service launcher."""

import json
import os
import sys
import threading
from pathlib import Path

from penny_compute_gate.gate import Denied, Gate, Window
from penny_compute_gate.ipc import Session, private_listener, process_identity, serve


def main() -> None:
    root = Path(sys.argv[1])
    gate = Gate(lambda: None)
    queue: list[str] = ["unrelated"]
    running: list[str] = []

    def submit(window: Window) -> None:
        queue.append(window.prompt_id)

        def work() -> None:
            try:
                running.append(window.prompt_id)
                queue.remove(window.prompt_id)
                with gate.call(window.graph, window.prompt_id):
                    gate.check()
            except Denied:
                pass
            finally:
                running.remove(window.prompt_id)

        threading.Thread(target=work, daemon=True).start()

    def state(prompt_id: str, cancel: bool) -> tuple[bool, bool]:
        if cancel and prompt_id in queue:
            queue.remove(prompt_id)
        assert "unrelated" in queue
        return prompt_id in queue, prompt_id in running

    listener = private_listener(root / "gate.sock", os.getuid())
    identity = process_identity(os.getpid())
    identity["worker_id"] = os.environ.get("PENNY_TEST_WORKER_ID", "worker-a")
    threading.Thread(
        target=serve,
        args=(
            listener,
            lambda connection: Session(
                connection,
                gate,
                os.getuid(),
                identity,
                os.environ.get("PENNY_TEST_GATE_BUILD", "b" * 64),
                submit,
                state,
            ),
        ),
        daemon=True,
    ).start()
    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.flush()
    sys.stdin.read()


if __name__ == "__main__":
    main()
