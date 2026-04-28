# Dude UI validation coverage

This matrix tracks how strongly each mapping is grounded.

| Area | Field or behavior | Evidence level | Notes |
|------|-------------------|----------------|-------|
| Device | name (`TAG.NAME`) | CLI/export + diff oracle | Existing QuickCHR tests and the diff helper can observe this. Use UI session as smoke only. |
| Device | DNS-mode address (`TAG.DEVICE_IP`, `TAG.DEVICE_DNS_NAMES`) | RouterOS CLI/export | Covered by `test/integration/quickchr-dude-dns.test.ts`. |
| Device | RouterOS flag (`TAG.DEVICE_ROUTER_OS`, `0x1f4a`) | Replay assertion target | `labs/dude-ui/session.ts --first-routeros-flag` seeds a target device and `labs/dude-ui/first-mapping.ts assert` verifies the client-written bool diff once `after.export` exists. |
| Server metadata | last client connect (`TAG.SYS_LAST_CLIENT_CONNECT`, `0x1017`) | client-written | Written by real `dude.exe --connect` and verified with `labs/dude-ui/first-mapping.ts assert-connect`. |
| Device | custom fields (`TAG.DEVICE_CUSTOM_FIELD`) | Candidate UI target + static strings | `dude.exe` strings include `CustomField1..3`; needs UI-written export diff. |
| Device | SNMP profile/enabled | Candidate UI target | Important but more UI branching than RouterOS/custom field. |
| Device | agent assignment | GUI-only known gap | `/dude/agent/add` is not implemented via RouterOS CLI in v7; validate after basic UI driver is stable. |
| Map | node placement | Candidate later target | Requires reliable map interactions and coordinates. |
| Protocol | client-to-server messages | Research sidecar | Capture loopback WinBox/Dude traffic and search for Nova magic. |
| Static | EXE vocabulary | Research sidecar | Use `scripts/dude-exe-strings.ts`; hints only, not authoritative. |

Evidence levels:

- `client-written`: The Wine Dude client changed the value and exported DB diffs matched donny's mapping.
- `CLI/export`: RouterOS `/dude/...` wrote the value and exported DB diffs matched donny's mapping.
- `static strings`: The client binary contains a relevant label/name, but DB behavior is not yet proven.
- `candidate`: Good next target, not grounded yet.
