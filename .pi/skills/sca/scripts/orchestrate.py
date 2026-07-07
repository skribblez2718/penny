#!/usr/bin/env python3
"""Thin delegate to the shared orchestration engine.

The sca skill's entire state machine lives in the installed `orchestration`
package (`orchestration.playbooks.sca:ScaPlaybook`); this file only routes
`start`/`step`/`status`/`recover` to it. No FSM logic, no state serialization,
no /tmp checkpoints — state lives in the durable checkpointer keyed by `run_id`.
The skill's deterministic scan tools (baseline_scan.py, targeted_scan.py,
sandbox.py, …) stay in this scripts/ dir and are imported lazily by the playbook.
"""

from orchestration.cli import main

if __name__ == "__main__":
    raise SystemExit(main(default_playbook="sca"))
