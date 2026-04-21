import { existsSync } from "node:fs";

const KNOWN_COMMANDS = new Set(["setup", "wizard", "info", "list", "export", "add", "--help", "-h", "help"]);

/** Parse --flag=value and --flag value pairs. */
export function parseFlags(argv: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else if (arg.startsWith("--no-")) {
        flags[arg.slice(5)] = false;
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) { flags[key] = next; i++; }
        else flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function str(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function bool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === "true";
}

function requireDB(positional: string[], offset = 0): string {
  const p = positional[offset];
  if (!p) { console.error("Error: missing <db> path"); process.exit(1); }
  return p;
}

export function resolveWizardDbPath(argv: string[], isTTY: boolean): string | undefined {
  const command = argv[0];
  if (!isTTY || !command || KNOWN_COMMANDS.has(command) || command.startsWith("-")) return undefined;
  return existsSync(command) ? command : undefined;
}

export async function runCli(argv: string[], isTTY: boolean): Promise<void> {
  const wizardDbPath = resolveWizardDbPath(argv, isTTY);
  const command = argv[0];

  if (!command && isTTY) {
    const { runWizard } = await import("./wizard.ts");
    await runWizard();
    return;
  }

  if (wizardDbPath) {
    const { runWizard } = await import("./wizard.ts");
    await runWizard(wizardDbPath);
    return;
  }

  const { flags, positional } = parseFlags(argv.slice(command === "list" || command === "add" ? 2 : 1));

  switch (command) {
    case "setup":
    case "wizard": {
      const { runWizard } = await import("./wizard.ts");
      await runWizard();
      break;
    }

    case "info": {
      const { DudeDB } = await import("../lib/db.ts");
      const { printStats } = await import("./format.ts");
      const dbPath = requireDB(positional);
      const db = DudeDB.open(dbPath, { readonly: true });
      const stats = db.stats();
      console.log(`\n  dude.db: ${dbPath}`);
      printStats(stats);
      console.log();
      db.close();
      break;
    }

    case "list": {
      const sub = argv[1];
      const { DudeDB } = await import("../lib/db.ts");
      const { printDevices, printProbes } = await import("./format.ts");
      const dbPath = requireDB(positional);
      const db = DudeDB.open(dbPath, { readonly: true });
      switch (sub) {
        case "devices": {
          const devices = db.devices();
          console.log(`\n  ${devices.length} device(s) in ${dbPath}:\n`);
          printDevices(devices);
          console.log();
          break;
        }
        case "probes": {
          const probes = db.probeTemplates();
          console.log(`\n  ${probes.length} probe template(s) in ${dbPath}:\n`);
          printProbes(probes);
          console.log();
          break;
        }
        default:
          console.error(`Unknown list subcommand: ${sub ?? "(none)"}\n  Available: devices, probes`);
          process.exit(1);
      }
      db.close();
      break;
    }

    case "export": {
      const dbPath = requireDB(positional);
      const format = (str(flags, "format") ?? "json") as "csv" | "json";
      const includeCreds = bool(flags, "include-credentials");
      const { DudeDB } = await import("../lib/db.ts");
      const { printDevicesCSV, printDevicesJSON } = await import("./format.ts");
      const db = DudeDB.open(dbPath, { readonly: true });
      const devices = db.devices();
      if (format === "csv") printDevicesCSV(devices, includeCreds);
      else printDevicesJSON(devices, includeCreds);
      db.close();
      break;
    }

    case "add": {
      const sub = argv[1];
      if (sub !== "device") {
        console.error(`Unknown add subcommand: ${sub ?? "(none)"}\n  Available: device`);
        process.exit(1);
      }
      const dbPath = requireDB(positional);
      const name = str(flags, "name");
      const address = str(flags, "address");
      if (!name || !address) {
        console.error("Error: --name and --address are required\n  Example: donny add device dude.db --name myrouter --address 192.168.88.1");
        process.exit(1);
      }
      const { DudeDB } = await import("../lib/db.ts");
      const db = DudeDB.open(dbPath);
      const ids = db.addDevice({
        name,
        address,
        username: str(flags, "username"),
        password: str(flags, "password"),
        routerOS: bool(flags, "routeros"),
        snmpEnabled: bool(flags, "snmp"),
      });
      console.log(`Added device id=${ids.deviceId} probe id=${ids.probeId} service id=${ids.serviceId}`);
      console.log("Restart The Dude server to pick up the new object.");
      db.close();
      break;
    }

    case "--help":
    case "-h":
    case "help":
    case undefined: {
      console.log(`
donny — MikroTik Dude DB Manager

Usage:
  donny                                     interactive wizard
  donny <db>                                interactive wizard for an existing DB
  donny setup                               interactive wizard (explicit)
  donny info <db>                           show database statistics
  donny list devices <db>                   list all devices
  donny list probes <db>                    list probe templates
  donny export <db> [options]               export devices
    --format csv|json                       output format (default: json)
    --include-credentials                   include username/password in output
  donny add device <db> [options]           add a device with ping probe
    --name <name>                           device name (required)
    --address <ip|hostname>                 IP address or FQDN (required)
    --username <user>                       RouterOS username
    --password <pass>                       RouterOS password
    --routeros                              flag device as RouterOS
    --snmp                                  enable SNMP monitoring

  donny --help                              show this help
`);
      process.exit(0);
    }

    default:
      console.error(`Unknown command: ${command}\nRun \`donny --help\` for usage.`);
      process.exit(1);
  }
}
