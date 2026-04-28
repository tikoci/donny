import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface QuickChrDudeOptions {
  machine: string;
  existingMachine?: boolean;
  channel?: "long-term" | "stable" | "testing";
  arch?: "x86" | "arm64";
  enableWinbox?: boolean;
  timeoutMs?: number;
}

export interface QuickChrMachineState {
  ports?: {
    http?: number | { host?: number };
    https?: number | { host?: number };
    ssh?: number | { host?: number };
    api?: number | { host?: number };
    apiSsl?: number | { host?: number };
    winbox?: number | { host?: number };
  };
  pid?: number;
  status?: string;
}

export interface QuickChrDudeHarness {
  machine: string;
  ownsMachine: boolean;
  exec(command: string, timeoutMs?: number): Promise<string>;
  readFile(fileName: string): Promise<Buffer>;
  exportDb(exportName: string): Promise<Buffer>;
  loginTarget(): QuickChrDudeLoginTarget | undefined;
  stop(): Promise<void>;
}

export interface QuickChrDudeLoginTarget {
  host: "localhost";
  port: number;
  username: "admin";
  password: "";
}

export async function startQuickChrDude(options: QuickChrDudeOptions): Promise<QuickChrDudeHarness> {
  const timeoutMs = options.timeoutMs ?? 240_000;
  const ownsMachine = !options.existingMachine;

  if (ownsMachine) {
    const args = [
      "start",
      "--name", options.machine,
      "--channel", options.channel ?? "long-term",
      "--arch", options.arch ?? "x86",
      "--add-package", "dude",
      "--no-secure-login",
      "--no-api-ssl",
      "--device-mode", "skip",
      "--timeout-extra", "120",
    ];
    if (!options.enableWinbox) args.push("--no-winbox");
    await runQuickchr(args, timeoutMs);
  }

  const exec = (command: string, commandTimeoutMs = 60_000) => runQuickchr(["exec", options.machine, command], commandTimeoutMs);

  const harness: QuickChrDudeHarness = {
    machine: options.machine,
    ownsMachine,
    exec,
    readFile: (fileName) => readRouterOSFile(exec, fileName),
    exportDb: async (exportName) => {
      await exec("/dude/set enabled=yes data-directory=dude");
      await exec(`/dude/export-db backup-file=${exportName}`);
      return readRouterOSFile(exec, exportName);
    },
    loginTarget: () => {
      const state = readQuickchrState(options.machine);
      const port = portNumber(state?.ports?.winbox);
      return typeof port === "number"
        ? { host: "localhost", port, username: "admin", password: "" }
        : undefined;
    },
    stop: async () => {
      if (ownsMachine) await runQuickchr(["remove", options.machine], 120_000);
    },
  };

  return harness;
}

function portNumber(port: number | { host?: number } | undefined): number | undefined {
  if (typeof port === "number") return port;
  return typeof port?.host === "number" ? port.host : undefined;
}

export function readQuickchrState(machine: string): QuickChrMachineState | undefined {
  const path = join(homedir(), ".local/share/quickchr/machines", machine, "machine.json");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as QuickChrMachineState;
  } catch {
    return undefined;
  }
}

async function readRouterOSFile(exec: (command: string, timeoutMs?: number) => Promise<string>, fileName: string): Promise<Buffer> {
  const sizeText = await exec(`:put [/file/get [find name="${fileName}"] size]`);
  const size = Number.parseInt(sizeText.replace(/\D/g, ""), 10);
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error(`could not determine RouterOS file size for ${fileName}: ${sizeText}`);
  }

  const chunks: Buffer[] = [];
  const chunkSize = 8192;
  for (let offset = 0; offset < size; offset += chunkSize) {
    const script = `:local r [/file/read file="${fileName}" offset=${offset} chunk-size=${chunkSize} as-value]; :put [:convert ($r->"data") to=base64]`;
    const b64 = await exec(script);
    chunks.push(Buffer.from(b64.replace(/\s+/g, ""), "base64"));
  }
  return Buffer.concat(chunks);
}

async function runQuickchr(args: string[], timeoutMs: number): Promise<string> {
  const proc = Bun.spawn(["quickchr", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`quickchr ${args.join(" ")} failed (${exitCode})\n${stdout}\n${stderr}`);
    }
    return stdout.trim();
  } finally {
    clearTimeout(timeout);
  }
}
