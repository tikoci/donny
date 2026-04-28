# dude-ui lab

Local-only harness for driving the Wine-hosted The Dude Windows client against a QuickCHR Dude server.

This lab is intentionally not part of CI. Its purpose is to let the real `dude.exe` client write values, then use donny's DB diff tooling to identify the exact Nova fields the client changed.

## Prerequisites

- macOS with a visible desktop session
- Wine with The Dude installed at the default path, or `DONNY_DUDE_CLIENT`
- `quickchr` on `PATH`
- Python 3
- Optional Python packages for UI driving:

```sh
python3 -m pip install --user pyautogui pillow opencv-python
```

macOS must allow the terminal/Python process in:

- Privacy & Security -> Accessibility
- Privacy & Security -> Screen Recording

## Login target

Start or reuse a Dude-enabled QuickCHR with WinBox enabled. The existing screenshot shows a target like:

```text
Server: localhost
Port:   9125
User:   admin
Pass:   <empty>
```

For a disposable machine, the future UI test path should use the shared helper in `test/helpers/quickchr-dude.ts` with `enableWinbox: true`, then call `loginTarget()` to get the actual forwarded port.

## Driver smoke

The initial driver is coordinate-based with explicit diagnostics. It is designed to establish the local loop before image templates are committed.

```sh
python3 labs/dude-ui/dude_ui_driver.py doctor

python3 labs/dude-ui/dude_ui_driver.py login \
  --port 9125 \
  --origin-x 0 \
  --origin-y 0 \
  --screenshot-dir labs/dude-ui/artifacts
```

If the Wine window is not at the top-left of the screen, pass its visible top-left coordinate with `--origin-x` and `--origin-y`.

## Validation loop

For a guided local session:

```sh
bun run labs/dude-ui/session.ts --drive-login --keep
```

The session exports `before.export`, waits while you make one UI change and save it, then exports `after.export` and writes `diff.json`.

## First concrete mapping target: Device RouterOS flag

The first fully automated client-written mapping currently available without Screen Recording permission is the client-connect server metadata timestamp:

- Nova tag: `TAG.SYS_LAST_CLIENT_CONNECT`
- Hex tag: `0x1017`
- Expected value kind: `u32` Unix timestamp
- Writer: real `dude.exe --server 127.0.0.1:<winbox-port> --connect`

Replay the assertion after any real client connection:

```sh
bun run labs/dude-ui/first-mapping.ts assert-connect \
  --before labs/dude-ui/artifacts/before.export \
  --after labs/dude-ui/artifacts/after.export
```

The stronger interactive target remains the device **RouterOS** checkbox.

The first client-written mapping target is the device **RouterOS** checkbox:

- Nova tag: `TAG.DEVICE_ROUTER_OS`
- Hex tag: `0x1f4a`
- Expected value kind: `bool`
- Default target device name: `donny-ui-routeros-flag-<pid>`

Run a guided session that seeds a known device, exports `before.export`, asks you to toggle the RouterOS checkbox in the Dude client, exports `after.export`, and asserts that the client changed `TAG.DEVICE_ROUTER_OS`:

```sh
bun run labs/dude-ui/session.ts --first-routeros-flag --drive-login --keep
```

If a human or external driver already produced `after.export`, replay the assertion without launching a GUI:

```sh
bun run labs/dude-ui/first-mapping.ts assert \
  --before labs/dude-ui/artifacts/before.export \
  --after labs/dude-ui/artifacts/after.export \
  --name donny-ui-routeros-flag-12345
```

The assertion checks both the raw Nova diff and `DudeDB.devices()` decode, so a passing replay means the `routerOS` domain field is grounded by a real client-written export.

Manual equivalent:

1. Export a baseline DB from RouterOS:

   ```routeros
   /dude/export-db backup-file=before.export
   ```

2. Use this lab to make one UI change in `dude.exe`.
3. Export another DB snapshot:

   ```routeros
   /dude/export-db backup-file=after.export
   ```

4. Diff with donny:

   ```sh
   bun run scripts/diff-db.ts before.export after.export --json
   bun run scripts/diff-db.ts before.export after.export --name router1
   ```

Assertions should be based on the diff output and `DudeDB` decode results, not on screenshot success alone.

## Protocol capture sidecar

The Wine client talks to the QuickCHR forwarded WinBox/Dude port on loopback. Capture locally while performing one UI write:

```sh
sudo tcpdump -i lo0 -s 0 -w labs/dude-ui/artifacts/dude-client.pcap tcp port 9125
```

Then inspect whether Nova message magic appears:

```sh
tshark -r labs/dude-ui/artifacts/dude-client.pcap -Y "tcp.len > 0" -T fields -e data \
  | tr -d ':\n' \
  | grep -i '4d320100ff880100'
```

Keep raw pcaps out of git; they can contain credentials, addresses, and topology data.

## Static strings sidecar

The client binary contains useful vocabulary such as `nv::message`, `FirstAddress`, and `CustomField1`. Generate a local report with:

```sh
bun run scripts/dude-exe-strings.ts > labs/dude-ui/artifacts/dude-exe-strings.txt
```

Use the report as hints for candidate field names, but treat client-written DB diffs as the mapping authority.
