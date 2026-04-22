/**
 * scp.ts — SCP helpers for copying files to/from a RouterOS CHR.
 *
 * Mirrors the SSH_ASKPASS pattern used by @tikoci/quickchr for package uploads.
 * RouterOS SSH accepts SCP; the admin password is supplied via SSH_ASKPASS so
 * `sshpass` is not required and no TTY interaction is needed.
 *
 * Tested paths on RouterOS:
 *   /         — flash root (where packages land)
 *   /dude/    — Dude data directory (exists only after dude creates it)
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, chmodSync, writeFileSync } from "node:fs";

const CHR_HOST = "127.0.0.1";

/** Build a temporary SSH_ASKPASS helper script for the given password. */
function makeAskpass(password: string): string {
  const ext = process.platform === "win32" ? ".cmd" : ".sh";
  const path = join(tmpdir(), `donny-askpass-${process.pid}${ext}`);
  const safe = password.replace(/'/g, "'\\''");
  if (process.platform === "win32") {
    writeFileSync(path, `@echo off\r\necho ${password.replace(/[&|<>^%]/g, "^$&")}\r\n`);
  } else {
    writeFileSync(path, `#!/bin/sh\nprintf '%s' '${safe}'`);
    chmodSync(path, 0o755);
  }
  return path;
}

function scpEnv(askpassPath: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    DISPLAY: "",
    SSH_ASKPASS: askpassPath,
    SSH_ASKPASS_REQUIRE: "prefer",
  };
}

const SSH_OPTS = [
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "UserKnownHostsFile=/dev/null",
  "-o", "LogLevel=ERROR",
];

/**
 * Upload a local file to a running CHR via SCP.
 *
 * @param sshPort   Host-side port forwarded to CHR SSH (22)
 * @param localPath Absolute or relative path on the local machine
 * @param remotePath Destination path on RouterOS, e.g. "/dude/dude.db"
 * @param user      RouterOS user (default: "admin")
 * @param password  RouterOS password (default: "" — empty admin password)
 */
export async function scpUpload(
  sshPort: number,
  localPath: string,
  remotePath: string,
  user = "admin",
  password = "",
): Promise<void> {
  const askpass = makeAskpass(password);
  try {
    const args = [
      "scp", "-P", String(sshPort),
      ...SSH_OPTS,
      localPath,
      `${user}@${CHR_HOST}:${remotePath}`,
    ];
    const result = Bun.spawnSync(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: scpEnv(askpass),
    });
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`SCP upload failed (exit ${result.exitCode}): ${stderr.trim()}`);
    }
  } finally {
    try { unlinkSync(askpass); } catch { /* ignore */ }
  }
}

/**
 * Download a file from a running CHR to a local path via SCP.
 *
 * @param sshPort    Host-side port forwarded to CHR SSH (22)
 * @param remotePath Source path on RouterOS, e.g. "/dude/dude.db"
 * @param localPath  Destination on the local machine
 * @param user       RouterOS user (default: "admin")
 * @param password   RouterOS password (default: "" — empty admin password)
 */
export async function scpDownload(
  sshPort: number,
  remotePath: string,
  localPath: string,
  user = "admin",
  password = "",
): Promise<void> {
  const askpass = makeAskpass(password);
  try {
    const args = [
      "scp", "-P", String(sshPort),
      ...SSH_OPTS,
      `${user}@${CHR_HOST}:${remotePath}`,
      localPath,
    ];
    const result = Bun.spawnSync(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: scpEnv(askpass),
    });
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`SCP download failed (exit ${result.exitCode}): ${stderr.trim()}`);
    }
  } finally {
    try { unlinkSync(askpass); } catch { /* ignore */ }
  }
}
