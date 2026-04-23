# dude-agent lab

Boot two RouterOS CHR instances — one as a Dude **server**, one as a Dude **agent** — and sniff the inter-agent protocol traffic with TZSP.

## What It Does

```
[ dude-server ]──ether2 socket L2──[ dude-agent ]
      │                                   │
      │  TZSP stream → 10.0.2.2:37008     │
      ▼                                   │
  [ host ]  ←─────────────────────────────┘
  tshark captures agent protocol
```

1. Boots `dude-server` (port block 9100) and `dude-agent` (port block 9110) with the `dude` package
2. Connects them via a QEMU socket L2 network (ether2: 192.168.100.0/24)
3. Enables Dude server mode on the first CHR, agent mode on the second
4. Configures `/tool/sniffer` on the server to TZSP-stream ether2 traffic to the host
5. Optionally runs `tshark` to capture to `/tmp/dude-agent.pcap`

## Quick Start

```sh
bun install
bun run boot.ts --keep   # keeps both CHRs running for manual exploration
```

To capture traffic while the CHRs run:

```sh
tshark -i any -f "udp port 37008" -w /tmp/dude-agent.pcap &
# ... wait 30–60s for agent activity ...
kill %1
wireshark /tmp/dude-agent.pcap
```

## What to Look For

| Goal | What to do |
|------|-----------|
| Find the agent protocol port | Look for TCP from `192.168.100.2` → `192.168.100.1` — the destination port is the Dude agent port |
| Confirm Nova Message framing | Check if TCP payload starts with `4d 32 01 00 ff 88 01 00` (Nova magic bytes) |
| Identify message types | Cross-reference tag bytes against `donny/src/lib/nova.ts` `TAG` constants |
| Agent poll interval | Time between repeated TCP segments of similar size |

## Instance Addresses

| Instance | Port block | ether1 (mgmt) | ether2 (agent link) |
|----------|------------|---------------|---------------------|
| dude-server | 9100 | 10.0.2.15 (DHCP) | 192.168.100.1/24 |
| dude-agent  | 9110 | 10.0.2.15 (DHCP) | 192.168.100.2/24 |

Management from host:

```sh
ssh -p 9102 admin@127.0.0.1   # dude-server
ssh -p 9112 admin@127.0.0.1   # dude-agent
```

REST API:

```sh
curl http://127.0.0.1:9100/rest/dude/device    # server devices
curl http://127.0.0.1:9110/rest/dude/print     # agent status
```
