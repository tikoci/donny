# dude-agent lab

Boot two RouterOS CHR instances — one as a Dude **server**, one with Dude enabled — and sniff inter-device protocol traffic with TZSP.

## What It Does

```text
[ dude-server ]──ether2 socket L2──[ dude-agent ]
      │                                   │
      │  TZSP stream → 10.0.2.2:37008     │
      ▼
  [ host ]
  tshark captures neighbor discovery + probe traffic
```

1. Boots `dude-server` and `dude-agent` with the `dude` package (port blocks assigned dynamically by quickchr)
2. Connects them via a QEMU socket L2 network (ether2: 192.168.100.0/24)
3. Enables Dude on both CHRs
4. Configures `/tool/sniffer` on the server to TZSP-stream **all-interface** traffic to the host
5. Optionally runs `tshark` to capture to `/tmp/dude-agent.pcap`

## Quick Start

```sh
bun install
bun run boot.ts --keep   # keeps both CHRs running for manual exploration
```

To capture traffic while the CHRs run (macOS):

```sh
tshark -i lo0 -f "udp port 37008" -w /tmp/dude-agent.pcap &
# ... wait 30–60s for activity ...
kill %1
wireshark /tmp/dude-agent.pcap
```

On Linux use `-i any` instead of `-i lo0`.

## What You'll Capture

| Traffic | Interface | Interval |
|---------|-----------|----------|
| MNDP neighbor discovery | ether2 | ~30s |
| CDP announcements | ether2 | ~30s |
| LLDP announcements | ether2 | ~30s |
| Dude probe traffic (ICMP/TCP) | ether1 | probe-interval |
| **Nova message TCP sessions** | ether2 | **requires WinBox** |

### Dude Agent Protocol Limitation

The Dude agent-to-server protocol (Nova Messages over TCP) requires **WinBox GUI** to configure. The RouterOS v7 CLI command `/dude/agent/add` exists in the command tree but returns `doAdd not implemented`. To capture Nova messages, use WinBox to connect to `dude-server` and add `dude-agent` (192.168.100.2) as an agent.

## Instance Addresses

Port blocks are assigned dynamically by quickchr. After `--keep`, the script prints the actual ports. Example with dude-server reusing a pre-existing machine:

| Instance | REST | SSH | ether2 |
|----------|------|-----|--------|
| dude-server | `http://127.0.0.1:9110` | port 9112 | 192.168.100.1/24 |
| dude-agent  | `http://127.0.0.1:9120` | port 9122 | 192.168.100.2/24 |

Management from host:

```sh
ssh -p 9112 admin@127.0.0.1   # dude-server
ssh -p 9122 admin@127.0.0.1   # dude-agent
```

REST API:

```sh
curl -u admin: http://127.0.0.1:9110/rest/dude        # server status
curl -u admin: http://127.0.0.1:9110/rest/dude/device # server devices
curl -u admin: http://127.0.0.1:9120/rest/dude        # agent status
```

## Key Findings from Live Testing

- **tshark on macOS**: Use `-i lo0` (QEMU user-mode NAT traffic arrives on loopback). `-i any` requires `ioctl(SIOCIFCREATE)` privileges.
- **TZSP works**: RouterOS `/tool/sniffer` streams to `10.0.2.2:37008` and packets appear on `lo0:37008` on the macOS host.
- **MNDP decoded**: Both CHRs send MNDP broadcasts every ~30s advertising their identity; captured and decoded cleanly by Wireshark/tshark.
- **L2 link confirmed**: Sub-millisecond ping between 192.168.100.1 ↔ 192.168.100.2 over QEMU socket network.
- **Agent CLI not implemented**: `/dude/agent/add` returns `"doAdd Agent not implemented"` — agent links require WinBox 4.
- **import-db caution**: Importing a large database (4 MB, 2000+ devices) floods the probe queue and can lock the CHR. Use `--keep` and monitor CPU before importing.
