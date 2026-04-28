# labs/

Experimental scripts for live RouterOS + Dude integration testing.
These run outside the main `src/` tree so iteration doesn't affect production code.

| Directory | Purpose |
|-----------|---------|
| `dude-chr/` | Boot a CHR with the Dude package, load a `dude.db`, verify via REST. `--smb` flag exposes the Dude directory as a network share. |
| `dude-agent/` | Two-CHR setup (server + agent mode) connected via QEMU socket L2 network. Sniffs agent protocol traffic with TZSP. |
| `dude-ui/` | Local-only Wine `dude.exe` UI-driving lab. Uses client-written DB exports plus donny Nova diffs to ground field mappings. |

## Prerequisites

- QEMU (`qemu-system-x86_64` or `qemu-system-aarch64`)
- Bun 1.x
- The `quickchr` project cloned at `../../quickchr` (sibling to this repo)

## Notes

- `.db` files are gitignored — copy a real `dude.db` locally to experiment
- `labs/dude-ui/artifacts/` is for local screenshots/pcaps/reports and should stay uncommitted
- Labs are intentionally low-structure: scripts, not test suites
- See each sub-directory's `README.md` for run instructions
