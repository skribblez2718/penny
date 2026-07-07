#!/usr/bin/env python3
"""Thin delegate to the shared orchestration engine.

The jsa skill's entire state machine lives in the installed `orchestration`
package (`orchestration.playbooks.jsa:JSAPlaybook`); this file only routes
`start`/`step`/`status`/`recover` to it. No FSM logic, no state serialization,
no session.json checkpoint — state lives in the durable checkpointer keyed by
`run_id`. The skill's deterministic analysis tools (scan/card/analyzer modules
+ jsa_domain.py) stay in this scripts/ dir and are imported lazily by the playbook.
"""

from orchestration.cli import main

if __name__ == "__main__":
    raise SystemExit(main(default_playbook="jsa"))
