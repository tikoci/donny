# dude-chr lab

Boot a RouterOS CHR with the **Dude** package, optionally load a custom `dude.db`, and verify devices via REST.

## Purpose

- Validate that donny can read a `dude.db` that was produced by a real live Dude server
- Experiment with the REST API paths exposed by the Dude package (`/dude/devices`, `/dude/services`, etc.)
- Give feedback on `@tikoci/quickchr` from a real integration scenario (SCP, exec, packages)

## Prerequisites

```sh
# QEMU installed
qemu-system-x86_64 --version   # or qemu-system-aarch64 on Apple Silicon

# quickchr cloned as a sibling repo
ls ../../quickchr/package.json

# Install lab dependencies (once)
bun install
```

## Run

```sh
# Boot CHR with Dude, enable it, download the fresh empty dude.db
bun run boot.ts

# Load a custom dude.db from the donny repo root
bun run boot.ts --load ../../2022.db

# Expose the Dude data directory as an SMB share (host port 9106)
bun run boot.ts --smb --keep

# Keep the instance running for manual inspection
bun run boot.ts --keep

# Named instance — reuses if already started (faster on repeat runs)
bun run boot.ts --name my-dude --keep
```

## SMB Experiment

The `--smb` flag forwards guest port 445 and configures `/ip/smb` to share the Dude data directory. This lets you read `dude.db` live from the host without SCP, and write to it (safely only when Dude is stopped).

```sh
# Boot with SMB enabled
bun run boot.ts --smb --keep

# Mount on macOS (after boot completes and SMB is configured)
mkdir -p /tmp/chr-dude
mount_smbfs //guest@127.0.0.1:9106/dude /tmp/chr-dude
ls -la /tmp/chr-dude    # → dude.db, dude.db-wal, dude.db-shm

# Write experiment: stop Dude first, then add a device via SMB mount
# (run from repo root)
curl -u admin: -X POST http://127.0.0.1:9100/rest/dude/set -d '{"enabled":"false"}'
bun run src/cli/index.ts add device --db /tmp/chr-dude/dude.db --name "test" --address 1.2.3.4 --routeros
curl -u admin: -X POST http://127.0.0.1:9100/rest/dude/set -d '{"enabled":"true","data-directory":"dude"}'

# Unmount when done
umount /tmp/chr-dude
```

> **Warning**: Never write to `dude.db` via the SMB mount while Dude is running — it holds
> a write lock and concurrent writes will corrupt the database.

## What it does

| Phase | Action |
|-------|--------|
| 1 · Boot | `QuickCHR.start` with `packages: ["dude"]` — downloads CHR + dude.npk, starts QEMU |
| 2 · Enable | `/dude/set enabled=yes data-directory=dude` — creates `/dude/` dir and empty db |
| 2b · SMB (optional) | `/ip/smb` configured to share `/dude/` on forwarded port 9106 |
| 3 · Load (optional) | Disable Dude → SCP custom `.db` as `/dude/dude.db` → re-enable |
| 4 · Download | SCP `/dude/dude.db` back to local disk for inspection with `donny info` |
| 5 · Verify | `/dude/devices/print count-only` + REST `GET /dude/devices` |

## Unknowns to investigate

- Does Dude accept an arbitrary SQLite db (the format donny reads) or does it require its own schema?
- What is the exact filename Dude uses inside `data-directory`? (`dude.db`? something else?)
- Does the REST API expose all fields that the Nova codec parses, or only a subset?
- Are there WAL files that need to be SCP'd alongside the main `.db`?

## Inspecting the downloaded db with donny

Run from the **repo root** (not from inside `labs/dude-chr/`):

```sh
cd ../..
bun run src/cli/index.ts info labs/dude-chr/downloaded-fresh-*.db
bun run src/cli/index.ts list labs/dude-chr/downloaded-fresh-*.db
```

> **WAL note**: `boot.ts` disables Dude before downloading so the WAL is checkpointed
> into the main `.db` file. Never open a Dude `.db` downloaded while Dude is still running —
> the `.db-shm` will be stale and `DudeDB.open(readonly: true)` will throw `SQLITE_CANTOPEN`.

## Stopping / cleaning up

```sh
# From the repo root, using the quickchr CLI
bunx quickchr stop dude-lab
bunx quickchr remove dude-lab
```
