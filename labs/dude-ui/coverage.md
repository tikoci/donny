# Dude UI validation coverage

This file is the human-readable companion to the machine-readable matrix in
`labs/dude-ui/evidence.ts`.

Run the live evidence report with:

```sh
bun run lab:dude-ui:evidence
```

Strict mode is for local validation after all expected Wine `dude.exe` artifact
pairs have been captured:

```sh
bun run lab:dude-ui:evidence -- --require-live
```

Current status: **not complete**. donny decodes useful subsets of `dude.db`, but
most Dude UI fields are not yet grounded by client-written before/after exports.

| Area | Field or behavior | Evidence level | Notes |
|------|-------------------|----------------|-------|
| Server metadata | last client connect (`TAG.SYS_LAST_CLIENT_CONNECT`, `0x1017`) | client-written | Written by real `dude.exe --connect` and verified by `lab:dude-ui:evidence`. |
| Device | RouterOS flag (`TAG.DEVICE_ROUTER_OS`, `0x1f4a`) | Replay assertion target | `labs/dude-ui/session.ts --first-routeros-flag` writes `before-routeros-flag.export` / `after-routeros-flag.export`; replay requires the device name used in the run. |
| Probe | client adds device + ping probe (`TAG.PROBE_DEVICE_ID`/`PROBE_TYPE_ID`/`PROBE_SERVICE_ID`, range `0x2ee0..0x2ef4`) | Replay assertion target | `labs/dude-ui/session.ts --add-device-with-probe` writes `before-add-probe.export` / `after-add-probe.export`; `assert-probe` confirms the new device, service, and probe-config decode. |
| Device | name (`TAG.NAME`) | CLI/export + diff oracle | Generic decode is known, but Device Settings client-edit evidence is not grounded. |
| Device | addresses and DNS names (`TAG.DEVICE_IP`, `TAG.DEVICE_DNS_NAMES`) | RouterOS CLI/export | Covered by fixtures/QuickCHR DNS-mode integration; client UI editing evidence still needed. |
| Device | credentials (`TAG.DEVICE_USERNAME`, `TAG.DEVICE_PASSWORD`) | synthetic | Unit fixtures cover dummy values; live UI evidence must use non-secret dummy values only. |
| Device | polling enabled/interval | planned/synthetic | `TAG.DEVICE_ENABLED` is not exposed in `Device`; `TAG.DEVICE_POLL_INTERVAL` is decoded but UI units need grounding. |
| Device | SNMP profile/enabled | synthetic | Decode exists; client UI semantics are not grounded. |
| Device | custom fields (`TAG.DEVICE_CUSTOM_FIELD`) | static strings | `dude.exe` strings include `CustomField1..3`; DB shape and domain model still need live grounding. |
| Device | agent assignment | planned | GUI-only known gap; `/dude/agent/add` is limited/not implemented in RouterOS CLI. |
| Map | node placement | planned | Requires reliable map interaction or protocol automation. |
| Protocol | client-to-server messages | Research sidecar | Capture loopback WinBox/Dude traffic and search for Nova magic. |
| Static | EXE vocabulary | Research sidecar | Use `scripts/dude-exe-strings.ts`; hints only, not authoritative. |

Evidence levels:

- `client-written`: The Wine Dude client changed the value and exported DB diffs matched donny's mapping.
- `CLI/export`: RouterOS `/dude/...` wrote the value and exported DB diffs matched donny's mapping.
- `synthetic`: Unit fixtures or donny encoders exercise the code path; this does not prove client UI semantics.
- `static strings`: The client binary contains a relevant label/name, but DB behavior is not yet proven.
- `candidate`: Good next target, not grounded yet.
- `planned`: Known gap with no replay assertion yet.
