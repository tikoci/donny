/**
 * boot.ts — Lab: Two-CHR Dude server + agent with TZSP protocol sniffing.
 *
 * Boots two RouterOS CHR instances:
 *   - dude-server: Dude in server mode, holds dude.db
 *   - dude-agent:  Dude in agent mode, probes on behalf of the server
 *
 * Both CHRs are connected on a shared L2 socket network (ether2: 192.168.100.0/24)
 * so the agent can reach the server. Management (SSH/REST) uses the standard
 * user-mode network (ether1: 10.0.2.x) on separate port blocks.
 *
 * TZSP sniffer is configured on dude-server to stream ether2 traffic to the host.
 * Run tshark on the host to capture the agent protocol:
 *   tshark -i any -f "udp port 37008" -w /tmp/dude-agent.pcap
 *
 * Usage:
 *   bun run boot.ts          # Boot both CHRs, configure server+agent, start sniffer
 *   bun run boot.ts --keep   # Keep both instances running after script exits
 *   bun run boot.ts --help   # Print this help
 *
 * Prerequisites:
 *   bun install  (run once in this directory)
 *   tshark       (optional, for capturing agent traffic: brew install wireshark)
 */

import { QuickCHR } from "@tikoci/quickchr";
import type { ChrInstance } from "@tikoci/quickchr";
import { $ } from "bun";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
dude-agent lab — two-CHR Dude server+agent with TZSP protocol sniffing

Usage:
  bun run boot.ts [--keep] [--channel <ch>]

Options:
  --keep             Keep both CHR instances running after script exits
  --channel <ch>     RouterOS channel: stable, long-term, testing (default: long-term)
  --help             Show this help

The script boots two CHRs:
  dude-server  (port block 9100)  — Dude in server mode
  dude-agent   (port block 9110)  — Dude in agent mode, connects to server

Inter-CHR link: QEMU socket network on L2 (192.168.100.0/24)
  server ether2: 192.168.100.1/24
  agent  ether2: 192.168.100.2/24

TZSP stream from server → host:
  Server streams ether2 traffic to 10.0.2.2:37008 (QEMU user-net gateway = host).
  Capture with: tshark -i any -f "udp port 37008" -w /tmp/dude-agent.pcap

What to look for in the pcap:
  - TCP connection from 192.168.100.2 (agent) → 192.168.100.1 (server) — find the port
  - Binary TCP payload starting with 4D 32 01 00 FF 88 01 00 (Nova Message magic)
  - Periodic keepalives / state updates from the agent
`);
  process.exit(0);
}

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

const KEEP = args.includes("--keep");
const CHANNEL = (flag("--channel") ?? "long-term") as "long-term" | "stable" | "testing";

// ---------------------------------------------------------------------------
// Network constants
// ---------------------------------------------------------------------------

// QEMU socket port for the inter-CHR L2 link.
// The server CHR gets socket-listen, the agent CHR gets socket-connect.
// Pick a port outside the quickchr port blocks (9100–9119 for first two instances).
const CHR_SOCKET_PORT = 9200;

// Static IPs on the socket-networked ether2 interface
const SERVER_ETHER2_IP = "192.168.100.1";
const AGENT_ETHER2_IP = "192.168.100.2";
const LINK_NETMASK = "24";

// TZSP destination on the host — QEMU user-mode gateway (10.0.2.2) is the host
const TZSP_HOST = "10.0.2.2";
const TZSP_PORT = 37008;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function section(label: string) {
  console.log(`\n─── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}`);
}

async function waitForDude(instance: ChrInstance, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out = await instance.exec("/dude/print");
      if (out.output.includes("enabled: yes")) return true;
    } catch { /* not ready yet */ }
    await sleep(2000);
  }
  return false;
}

/** Check if tshark is available on the host. */
async function hasTshark(): Promise<boolean> {
  try {
    await $`which tshark`.quiet();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let server: ChrInstance | undefined;
let agent: ChrInstance | undefined;

async function main() {
  // ── Phase 1: Boot server CHR ───────────────────────────────────────────────
  section("Phase 1 · Boot dude-server CHR");
  console.log(`Channel    : ${CHANNEL}`);
  console.log(`Socket L2  : QEMU socket listen on port ${CHR_SOCKET_PORT} (ether2)`);
  console.log(`Server IP  : ${SERVER_ETHER2_IP}/${LINK_NETMASK} (ether2)`);

  server = await QuickCHR.start({
    name: "dude-server",
    version: CHANNEL,
    background: true,
    secureLogin: false,
    packages: ["dude"],
    cpu: 1,
    mem: 256,
    // Two NICs:
    //  - "user": standard QEMU user-mode net for SSH/REST management from host
    //  - socket-listen: server end of the inter-CHR L2 link
    networks: ["user", { type: "socket-listen", port: CHR_SOCKET_PORT }],
  });

  console.log(`\nSSH port : ${server.sshPort}`);
  console.log(`REST URL : ${server.restUrl}`);
  console.log("Waiting for dude-server to boot…");

  const serverReady = await server.waitForBoot(300_000);
  if (!serverReady) {
    console.error("Timed out waiting for dude-server");
    process.exit(1);
  }
  console.log("dude-server boot OK");

  // ── Phase 2: Boot agent CHR ────────────────────────────────────────────────
  section("Phase 2 · Boot dude-agent CHR");
  console.log(`Agent IP   : ${AGENT_ETHER2_IP}/${LINK_NETMASK} (ether2)`);
  console.log(`Socket L2  : QEMU socket connect to port ${CHR_SOCKET_PORT} (ether2)`);

  agent = await QuickCHR.start({
    name: "dude-agent",
    version: CHANNEL,
    background: true,
    secureLogin: false,
    packages: ["dude"],
    cpu: 1,
    mem: 256,
    // Two NICs:
    //  - "user": standard QEMU user-mode net for SSH/REST management from host
    //  - socket-connect: client end of the inter-CHR L2 link
    networks: ["user", { type: "socket-connect", port: CHR_SOCKET_PORT }],
  });

  console.log(`\nSSH port : ${agent.sshPort}`);
  console.log(`REST URL : ${agent.restUrl}`);
  console.log("Waiting for dude-agent to boot…");

  const agentReady = await agent.waitForBoot(300_000);
  if (!agentReady) {
    console.error("Timed out waiting for dude-agent");
    process.exit(1);
  }
  console.log("dude-agent boot OK");

  // ── Phase 3: Configure ether2 static IPs ──────────────────────────────────
  section("Phase 3 · Configure ether2 static IPs");

  await server.exec(
    `/ip/address/add address=${SERVER_ETHER2_IP}/${LINK_NETMASK} interface=ether2`
  );
  console.log(`dude-server ether2: ${SERVER_ETHER2_IP}/${LINK_NETMASK}`);

  await agent.exec(
    `/ip/address/add address=${AGENT_ETHER2_IP}/${LINK_NETMASK} interface=ether2`
  );
  console.log(`dude-agent  ether2: ${AGENT_ETHER2_IP}/${LINK_NETMASK}`);

  // ── Phase 4: Enable Dude server ───────────────────────────────────────────
  section("Phase 4 · Enable Dude server");
  console.log("Setting server mode: /dude/set enabled=yes data-directory=dude");
  await server.exec("/dude/set enabled=yes data-directory=dude");

  const serverDudeUp = await waitForDude(server, 30_000);
  if (!serverDudeUp) {
    console.warn("dude-server: Dude did not report enabled=yes within timeout");
  }

  const serverDudeState = await server.exec("/dude/print");
  console.log("\ndude-server /dude/print:");
  console.log(serverDudeState.output);

  // ── Phase 5: Enable Dude agent ────────────────────────────────────────────
  section("Phase 5 · Enable Dude agent");
  // RouterOS agent mode: set enabled=yes and point server= at the server's ether2 IP.
  // The agent connects to the server and acts as a remote probe executor.
  console.log(`Setting agent mode: /dude/set enabled=yes server=${SERVER_ETHER2_IP}`);
  await agent.exec(
    `/dude/set enabled=yes server=${SERVER_ETHER2_IP}`
  );

  console.log("Waiting 10s for agent to attempt connection…");
  await sleep(10_000);

  const agentDudeState = await agent.exec("/dude/print");
  console.log("\ndude-agent /dude/print:");
  console.log(agentDudeState.output);

  // ── Phase 6: Configure TZSP sniffer on server ─────────────────────────────
  section("Phase 6 · Configure TZSP sniffer on dude-server");
  // Stream ether2 (the inter-CHR link) to the host via TZSP.
  // 10.0.2.2 is the QEMU user-mode gateway — always the host in QEMU user networking.
  console.log(`Streaming ether2 → ${TZSP_HOST}:${TZSP_PORT} (TZSP)`);
  await server.exec(`
    /tool/sniffer/set streaming-enabled=yes streaming-server=${TZSP_HOST}:${TZSP_PORT} filter-interface=ether2
    /tool/sniffer/start
  `);

  const snifferState = await server.exec("/tool/sniffer/print");
  console.log("\n/tool/sniffer/print:");
  console.log(snifferState.output);

  // ── Phase 7: Host-side capture instructions ────────────────────────────────
  section("Phase 7 · Host capture");

  const tsharkAvailable = await hasTshark();

  if (tsharkAvailable) {
    console.log(`tshark found — starting 60s capture to /tmp/dude-agent.pcap…`);
    console.log(`(Watch live: tshark -i any -f "udp port ${TZSP_PORT}")\n`);

    // Spawn tshark as a background process and let it run for 60s
    const tshark = Bun.spawn(
      [
        "tshark", "-i", "any",
        "-f", `udp port ${TZSP_PORT}`,
        "-w", "/tmp/dude-agent.pcap",
        "-a", "duration:60",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    // Wait for tshark to finish (or timeout)
    await Promise.race([
      tshark.exited,
      sleep(70_000),
    ]);

    if (tshark.exitCode === null) {
      console.warn("tshark still running — killing");
      tshark.kill();
    }

    console.log("\nCapture complete: /tmp/dude-agent.pcap");
    console.log("Analyze with:");
    console.log("  wireshark /tmp/dude-agent.pcap");
    console.log(`  tshark -r /tmp/dude-agent.pcap -T fields -e frame.time_relative -e ip.src -e ip.dst -e tcp.port -e _ws.col.Info`);
    console.log("\nLook for:");
    console.log(`  - TCP connections from ${AGENT_ETHER2_IP} → ${SERVER_ETHER2_IP}  (find the Dude agent port)`);
    console.log(`  - Binary payloads starting with: 4D 32 01 00 FF 88 01 00  (Nova Message magic)`);
  } else {
    console.log("tshark not found — install with: brew install wireshark");
    console.log("\nCapture manually:");
    console.log(`  tshark -i any -f "udp port ${TZSP_PORT}" -w /tmp/dude-agent.pcap`);
    console.log(`\nThe TZSP stream is active on the server (port ${TZSP_PORT}).`);
    console.log(`It will continue streaming as long as dude-server is running.`);
  }

  section("Done");
  console.log(`\ndude-server  SSH port: ${server.sshPort}   REST: ${server.restUrl}`);
  console.log(`dude-agent   SSH port: ${agent.sshPort}   REST: ${agent.restUrl}`);

  if (KEEP) {
    console.log(`\nBoth instances left running (--keep).`);
    console.log(`  Stop server: quickchr stop dude-server`);
    console.log(`  Stop agent:  quickchr stop dude-agent`);
    console.log(`\nUseful commands while running:`);
    console.log(`  ssh -p ${server.sshPort} admin@127.0.0.1 "/dude/device/print"`);
    console.log(`  ssh -p ${agent.sshPort} admin@127.0.0.1 "/dude/print"`);
    console.log(`  tshark -i any -f "udp port ${TZSP_PORT}"   # live TZSP stream`);
  }
}

main()
  .catch(e => {
    console.error("\nFatal:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    if (!KEEP) {
      section("Cleanup");
      for (const [name, inst] of [["dude-server", server], ["dude-agent", agent]] as const) {
        if (inst) {
          console.log(`Stopping ${name}…`);
          try { await inst.remove(); } catch { /* ignore */ }
        }
      }
    }
  });
