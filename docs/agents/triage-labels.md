# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Who applies them

`apps-triage` (`.claude/agents/apps-triage.md`) applies the readiness labels — exactly one of `needs-info`, `ready-for-agent`, `ready-for-human` per issue — alongside one category label (`bug`, `enhancement`, `documentation`, `question`) and one app label (`studio`, `handoff`, `reader`, `recall`, `workflow`, `workflow-studio`). `apps-implement` consumes `ready-for-agent` and only ever downgrades it. `needs-triage` marks an issue nobody has looked at yet; `apps-triage` removes it.
