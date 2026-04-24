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
 * TZSP sniffer is configured on dude-server to stream all interface traffic to the host.
 * Run tshark on the host to capture (use lo0 on macOS, any on Linux):
 *   tshark -i lo0 -f "udp port 37008" -w /tmp/dude-agent.pcap
 *
 * NOTE: Dude agent-to-server protocol requires WinBox GUI for configuration.
 * The CLI command `/dude/agent/add` exists but is NOT implemented in RouterOS v7.
 * What this lab captures: neighbor discovery (MNDP/CDP/LLDP) on ether2, and
 * any Dude probe traffic on ether1 (if devices are added via the live dude.db).
 *
 * Usage:
 *   bun run boot.ts          # Boot both CHRs, configure server+agent, start sniffer
 *   bun run boot.ts --keep   # Keep both instances running after script exits
 *   bun run boot.ts --help   # Print this help
 *
 * Prerequisites:
 *   bun install  (run once in this directory)
 *   tshark       (optional, for capturing traffic: brew install wireshark)
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
  dude-server  (first available block)  — Dude in server mode
  dude-agent   (next available block)   — Dude enabled (agent protocol needs WinBox)

Inter-CHR link: QEMU socket network on L2 (192.168.100.0/24)
  server ether2: 192.168.100.1/24
  agent  ether2: 192.168.100.2/24

TZSP stream from server → host (macOS: lo0, Linux: any):
  Server streams all-interface traffic to 10.0.2.2:37008 (QEMU gateway = host).
  Capture with: tshark -i lo0 -f "udp port 37008" -w /tmp/dude-agent.pcap

IMPORTANT: Dude agent-to-server protocol requires WinBox GUI configuration.
  /dude/agent/add CLI command exists but "doAdd not implemented" in RouterOS v7.

What you'll see in the pcap:
  - ether2: MNDP/CDP/LLDP neighbor discovery (every ~30s from both CHRs)
  - ether1: ICMP/TCP probe traffic if devices are added to the Dude server
  - No Nova message TCP sessions without WinBox-configured agent links
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

const TZSP_PORT = 37008;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function section(label: string) {
  console.log(`\n─── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}`);
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

/**
 * Run tshark analysis on the captured pcap and print findings:
 *  1. Protocol tree summary (what's in the capture)
 *  2. TCP SYN packets — identifies the agent connection port
 *  3. First TCP payload from agent → server — scan for Nova magic bytes
 *  4. Unique TCP connections observed
 */
async function analyzeCapture(pcap: string) {
  section("Analysis · Decoding pcap");

  // Check the file exists and has content
  const stat = await $`wc -c < ${pcap}`.text().catch(() => "0");
  const bytes = parseInt(stat.trim(), 10);
  if (isNaN(bytes) || bytes < 100) {
    console.warn(`pcap is too small (${bytes} bytes) — no TZSP traffic was captured.`);
    console.warn("Possible causes:");
    console.warn("  - RouterOS sniffer not streaming (check /tool/sniffer/print on server)");
    console.warn("  - Agent protocol uses a non-ether2 path (check agent connectivity)");
    console.warn("  - tshark bind interface issue — try: sudo tshark -i any ...");
    return;
  }
  console.log(`pcap size: ${bytes} bytes`);

  // 1. Protocol tree — what protocols are in the capture
  console.log("\n── Protocol hierarchy ──────────────────────────────────────");
  try {
    const tree = await $`tshark -r ${pcap} -q -z io,phs`.text();
    console.log(tree.trim());
  } catch (e) {
    console.warn("Protocol tree failed:", e instanceof Error ? e.message : e);
  }

  // 2. TCP SYN packets — find what port the agent connects on
  console.log("\n── TCP connections (SYN packets from inner packets) ─────────");
  try {
    const syns = await $`tshark -r ${pcap} -Y "tcp.flags.syn==1 && tcp.flags.ack==0" -T fields -e frame.time_relative -e ip.src -e ip.dst -e tcp.dstport`.text();
    if (syns.trim()) {
      console.log("time_rel\tsrc\t\t\tdst\t\t\tdstport");
      console.log(syns.trim());
    } else {
      console.log("No TCP SYN packets found in inner frames.");
      // Fallback: show all TCP flows
      const flows = await $`tshark -r ${pcap} -Y "tcp" -T fields -e ip.src -e ip.dst -e tcp.dstport -e tcp.srcport`.text();
      if (flows.trim()) {
        console.log("TCP flows observed:");
        // Deduplicate
        const seen = new Set<string>();
        for (const line of flows.trim().split("\n")) {
          const key = line.trim();
          if (key && !seen.has(key)) { seen.add(key); console.log(" ", key); }
        }
      }
    }
  } catch (e) {
    console.warn("TCP SYN check failed:", e instanceof Error ? e.message : e);
  }

  // 3. Nova magic scan — look for 4d320100ff880100 in TCP payload data
  const NOVA_MAGIC_HEX = "4d320100ff880100";
  console.log(`\n── Nova Message magic scan (${NOVA_MAGIC_HEX}) ──────────────`);
  try {
    // Extract raw TCP data bytes for all TCP segments that have a payload
    const rawData = await $`tshark -r ${pcap} -Y "tcp.len > 0" -T fields -e frame.number -e ip.src -e ip.dst -e tcp.dstport -e data`.text();
    const lines = rawData.trim().split("\n").filter(l => l.trim());
    let found = 0;
    for (const line of lines) {
      const parts = line.split("\t");
      const hexData = (parts[4] ?? "").replace(/:/g, "").toLowerCase();
      if (hexData.includes(NOVA_MAGIC_HEX)) {
        console.log(`✓ Nova magic found in frame ${parts[0]} (${parts[1]}→${parts[2]}:${parts[3]})`);
        // Print first 64 hex bytes for context
        console.log(`  payload: ${hexData.slice(0, 128)}…`);
        found++;
      }
    }
    if (found === 0) {
      console.log("Nova magic NOT found in TCP payloads.");
      // Show first 32 bytes of any TCP payloads for clues
      let shown = 0;
      for (const line of lines.slice(0, 5)) {
        const parts = line.split("\t");
        const hexData = (parts[4] ?? "").replace(/:/g, "").toLowerCase();
        if (hexData.length >= 8) {
          console.log(`  frame ${parts[0]} (${parts[1]}→${parts[2]}:${parts[3]}): ${hexData.slice(0, 64)}…`);
          shown++;
        }
      }
      if (shown === 0) console.log("  (no TCP payloads with data found)");
    } else {
      console.log(`Total: ${found} frame(s) with Nova magic`);
    }
  } catch (e) {
    console.warn("Nova scan failed:", e instanceof Error ? e.message : e);
  }

  // 4. Unique source/destination pairs seen (summarize traffic pattern)
  console.log("\n── Traffic summary (unique IP pairs + ports) ────────────────");
  try {
    const all = await $`tshark -r ${pcap} -T fields -e ip.src -e ip.dst -e tcp.dstport -e udp.dstport`.text();
    const counts = new Map<string, number>();
    for (const line of all.trim().split("\n")) {
      const k = line.trim();
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    console.log("count\tsrc\t\t\tdst\t\t\ttcp_dst\tudp_dst");
    for (const [k, c] of sorted) console.log(`${c}\t${k}`);
  } catch (e) {
    console.warn("Traffic summary failed:", e instanceof Error ? e.message : e);
  }

  console.log(`\nFull pcap saved at: ${pcap}`);
  console.log(`  wireshark ${pcap}`);
  console.log(`  tshark -r ${pcap} -Y "tcp" -T fields -e frame.time_relative -e ip.src -e tcp.dstport -e data | head -40`);
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
    channel: CHANNEL,
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
    channel: CHANNEL,
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

  const serverDudeUp = await server.waitFor(
    async () => {
      const out = await server!.exec("/dude/print");
      return out.output.includes("enabled: yes");
    },
    30_000
  );
  if (!serverDudeUp) {
    console.warn("dude-server: Dude did not report enabled=yes within timeout");
  }

  const serverDudeState = await server.exec("/dude/print");
  console.log("\ndude-server /dude/print:");
  console.log(serverDudeState.output);

  // ── Phase 5: Start TZSP capture BEFORE enabling agent ─────────────────────
  // Critical ordering: tshark → RouterOS sniffer → enable agent.
  // This ensures we capture the very first TCP handshake from agent → server.
  section("Phase 5 · Start TZSP capture (before enabling agent)");

  const CAPTURE_FILE = "/tmp/dude-agent.pcap";
  const CAPTURE_SECS = 180;

  const tsharkAvailable = await hasTshark();
  let tsharkProc: ReturnType<typeof Bun.spawn> | undefined;

  if (tsharkAvailable) {
    // Remove any stale capture file from prior run
    try { await $`rm -f ${CAPTURE_FILE}`.quiet(); } catch { /* ignore */ }

    tsharkProc = Bun.spawn(
      [
        "tshark", "-i", server.captureInterface,
        "-f", `udp port ${TZSP_PORT}`,
        "-w", CAPTURE_FILE,
        "-a", `duration:${CAPTURE_SECS}`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    console.log(`tshark started — capturing ${CAPTURE_SECS}s to ${CAPTURE_FILE}`);
    await sleep(1000); // let tshark bind before sniffer starts
  } else {
    console.log("tshark not found — install with: brew install wireshark");
    console.log(`Capture manually: tshark -i any -f "udp port ${TZSP_PORT}" -w ${CAPTURE_FILE}`);
  }

  // Start the RouterOS TZSP sniffer — traffic flows to tshark now.
  // Capture ALL interfaces so we see both ether2 (L2 link) and ether1 (probe traffic).
  console.log(`\nConfiguring TZSP: all interfaces → ${server.tzspGatewayIp}:${TZSP_PORT}`);
  await server.exec(`
    /tool/sniffer/set streaming-enabled=yes streaming-server=${server.tzspGatewayIp}:${TZSP_PORT} filter-interface=""
    /tool/sniffer/start
  `);
  const snifferState = await server.exec("/tool/sniffer/print");
  console.log("\n/tool/sniffer/print:");
  console.log(snifferState.output);

  // ── Phase 6: Enable Dude agent ────────────────────────────────────────────
  section("Phase 6 · Enable Dude agent");
  // The Dude server-to-agent protocol in RouterOS v7 requires WinBox GUI for
  // configuration. The CLI command /dude/agent/add exists but returns
  // "doAdd not implemented". We enable Dude on both CHRs so the infrastructure
  // is ready, and both will announce themselves via MNDP/CDP/LLDP.
  console.log("Enabling Dude on agent CHR: /dude/set enabled=yes data-directory=dude");
  await agent.exec("/dude/set enabled=yes data-directory=dude");

  await sleep(5_000);
  const agentDudeState = await agent.exec("/dude/print");
  console.log("\ndude-agent /dude/print:");
  console.log(agentDudeState.output);

  console.log("NOTE: /dude/agent/add is not implemented in RouterOS v7 CLI.");
  console.log("      To capture agent protocol (Nova messages), use WinBox to configure");
  console.log(`      dude-server (${server.restUrl}) and add dude-agent as an agent device.`);

  // ── Phase 7: Wait for capture to complete, then analyze ───────────────────
  if (tsharkProc) {
    section(`Phase 7 · Waiting for ${CAPTURE_SECS}s capture to complete…`);
    console.log("Capturing agent protocol traffic. Dude poll interval ~60s so this gives 2-3 cycles.");

    await Promise.race([
      tsharkProc.exited,
      sleep((CAPTURE_SECS + 10) * 1000),
    ]);
    if (tsharkProc.exitCode === null) {
      console.warn("tshark did not exit cleanly — killing");
      tsharkProc.kill();
      await sleep(500);
    }

    console.log(`\nCapture complete: ${CAPTURE_FILE}`);
    await analyzeCapture(CAPTURE_FILE);
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
    console.log(`  tshark -i lo0 -f "udp port ${TZSP_PORT}"   # live TZSP stream on macOS`);
    console.log(`  tshark -i any -f "udp port ${TZSP_PORT}"   # live TZSP stream on Linux`);
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
