#!/usr/bin/env python3
"""Thin delegate to the shared orchestration engine.

The derivation skill's entire state machine lives in the installed
``orchestration`` package (``orchestration.playbooks.derivation``); this file
only routes ``start``/``step``/``status``/``recover`` to it. No FSM logic, no
state serialization, no /tmp checkpoints — state lives in the durable
checkpointer keyed by ``run_id``.
"""

from orchestration.cli import main

if __name__ == "__main__":
    raise SystemExit(main(default_playbook="derivation"))
