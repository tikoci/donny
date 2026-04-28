# dude-ui lab

Local-only harness for driving the Wine-hosted The Dude Windows client against a QuickCHR Dude server.

This lab is intentionally not part of CI. Its purpose is to let the real `dude.exe` client write values, then use donny's DB diff tooling to identify the exact Nova fields the client changed.

## Current truth: donny is not complete

Do not treat unit tests or synthetic fixtures as proof that donny's UI mapping is complete. They prove codec behavior and donny's current encoders/decoders; they do **not** prove that our domain names, field names, or value semantics match the real Dude client.

The source of truth for UI mappings is:

1. A real Wine `dude.exe` session connected to QuickCHR.
2. A known UI change with a known value.
3. RouterOS `/dude/export-db` before and after that UI change.
4. A replay assertion that checks the raw Nova diff **and** donny's decoded domain object.

The regular entry point is the evidence report:

```sh
bun run lab:dude-ui:evidence
```

It prints every tracked UI mapping target and one of these states:

- `grounded` — live artifacts exist and the replay assertion passed.
- `missing-artifact` — the target has an assertion, but the before/after export pair has not been captured yet.
- `planned` — the target is known from Dude docs/static strings/donny's code, but no replay assertion exists yet.
- `failed` — artifacts exist, but the replay assertion does not match donny's mapping.

Use strict mode only after a local evidence run when you expect all replay-target artifacts to exist:

```sh
bun run lab:dude-ui:evidence -- --require-live
```

The matrix intentionally includes planned gaps such as Custom Fields, Agent, map placement, and Polling fields so future agents can see what is **not** grounded yet.

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

For mapping work, prefer a named evidence mode instead of the generic loop:

```sh
# RouterOS checkbox evidence: before-routeros-flag.export / after-routeros-flag.export
bun run labs/dude-ui/session.ts --first-routeros-flag --device-name donny-ui-routeros-flag-manual --drive-login --keep

# Add Device + ping probe evidence: before-add-probe.export / after-add-probe.export
bun run lab:dude-ui:add-probe -- --device-name donny-ui-probe-target-manual --drive-login
```

Then run the evidence report:

```sh
bun run lab:dude-ui:evidence -- --routeros-device-name donny-ui-routeros-flag-manual \
  --probe-device-name donny-ui-probe-target-manual
```

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
  --after labs/dude-ui/artifacts/after-cli-connect.export
```

The stronger interactive target remains the device **RouterOS** checkbox.

The first client-written mapping target is the device **RouterOS** checkbox:

- Nova tag: `TAG.DEVICE_ROUTER_OS`
- Hex tag: `0x1f4a`
- Expected value kind: `bool`
- Default target device name: `donny-ui-routeros-flag-<pid>`

Run a guided session that seeds a known device, exports `before-routeros-flag.export`, asks you to toggle the RouterOS checkbox in the Dude client, exports `after-routeros-flag.export`, and asserts that the client changed `TAG.DEVICE_ROUTER_OS`:

```sh
bun run labs/dude-ui/session.ts --first-routeros-flag --device-name donny-ui-routeros-flag-manual --drive-login --keep
```

If a human or external driver already produced the artifact pair, replay the assertion without launching a GUI:

```sh
bun run labs/dude-ui/first-mapping.ts assert \
  --before labs/dude-ui/artifacts/before-routeros-flag.export \
  --after labs/dude-ui/artifacts/after-routeros-flag.export \
  --name donny-ui-routeros-flag-manual
```

The assertion checks both the raw Nova diff and `DudeDB.devices()` decode, so a passing replay means the `routerOS` domain field is grounded by a real client-written export.

## Probe target: client adds a device with a probe

This grounds donny's probe-config decoding by letting the real `dude.exe` perform the **Add Device** flow (which under the hood writes one device, one service, and one probe-config object) and then asserting donny decodes the new triple correctly:

- Range: `RANGE.PROBE_CONFIG_LO..HI` = `0x2ee0..0x2ef4`
- Key tags: `TAG.PROBE_DEVICE_ID` (`0x2ee1`), `TAG.PROBE_TYPE_ID` (`0x2ee3`), `TAG.PROBE_SERVICE_ID` (`0x2eec`)
- Default probe template: `PROBE_ID_PING` = `10160`
- Default target device name: `donny-ui-probe-target-<pid>`

Run a guided session that exports `before-add-probe.export`, asks you to add a new device + probe in the Dude client, exports `after-add-probe.export`, and asserts donny resolves the device, service, and probe-config the client just wrote:

```sh
bun run lab:dude-ui:add-probe
# equivalent to:
bun run labs/dude-ui/session.ts --add-device-with-probe --keep
```

If a human or external driver already produced `after-add-probe.export`, replay the assertion without launching a GUI:

```sh
bun run lab:dude-ui:assert-probe
# equivalent to:
bun run labs/dude-ui/first-mapping.ts assert-probe \
  --before labs/dude-ui/artifacts/before-add-probe.export \
  --after  labs/dude-ui/artifacts/after-add-probe.export \
  --expected-probe-type 10160
```

Pass `--name <device-name>` to scope to one specific device when the export contains other concurrent writes. Pass `--expected-probe-type <id>` to require a specific probe template (omit for any). The assertion fails loudly if the new device, the new probe-config, or the linked service is missing from `DudeDB.devices()` / `probeConfigs()` / `services()`.

A synthetic version of this assertion runs in `test/unit/diff.test.ts` using `DudeDB.inMemory().addDevice(...)` so the assertion logic itself is regression-tested even before live evidence exists.

## How to add the next UI field

1. Pick a target from `bun run lab:dude-ui:evidence` with `planned`, `static`, `synthetic`, or `cli-written` evidence.
2. Use the Dude docs terms in `labs/dude-ui/evidence.ts` (`dudeTerm`, `area`, and `docs`); do not invent donny-only names when the client has a visible label.
3. Capture a before/after pair with exactly one intentional UI write. Artifact names should be stable: `before-<target>.export`, `after-<target>.export`, and `<target>-diff.json`.
4. Add or extend an assertion in `labs/dude-ui/first-mapping.ts` that checks:
   - the expected raw Nova tag(s) changed or were added;
   - the value equals the known value entered in the UI;
   - the corresponding `DudeDB` domain reader returns the same value, if donny exposes that domain field;
   - unexpected unknown changes are reported, not silently ignored.
5. Add the target to `EVIDENCE_TARGETS` in `labs/dude-ui/evidence.ts`.
6. Add a synthetic unit test only for the assertion mechanics. Do not mark the target as grounded until `bun run lab:dude-ui:evidence` passes against live `dude.exe` artifacts.

Use non-secret dummy values for credential-like fields. Never commit real `.db`, `.export`, screenshots, or pcaps from a production Dude server.

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
