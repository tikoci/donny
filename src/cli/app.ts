import { existsSync } from "node:fs";

const KNOWN_COMMANDS = new Set(["setup", "wizard", "info", "list", "export", "add", "normalize", "denormalize", "--help", "-h", "help"]);

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
      const db = DudeDB.openAuto(dbPath, { readonly: true });
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
      const { printDevices, printProbes, printDeviceTypes, printLinkTypes, printNetworks, printSyslogRules, printDeviceGroups, printDiscoverJobs } = await import("./format.ts");
      const dbPath = requireDB(positional);
      const db = DudeDB.openAuto(dbPath, { readonly: true });
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
        case "device-types": {
          const types = db.deviceTypes();
          console.log(`\n  ${types.length} device type(s) in ${dbPath}:\n`);
          printDeviceTypes(types);
          console.log();
          break;
        }
        case "link-types": {
          const types = db.linkTypes();
          console.log(`\n  ${types.length} link type(s) in ${dbPath}:\n`);
          printLinkTypes(types);
          console.log();
          break;
        }
        case "networks": {
          const nets = db.networks();
          console.log(`\n  ${nets.length} network(s) in ${dbPath}:\n`);
          printNetworks(nets);
          console.log();
          break;
        }
        case "syslog-rules": {
          const rules = db.syslogRules();
          console.log(`\n  ${rules.length} syslog rule(s) in ${dbPath}:\n`);
          printSyslogRules(rules);
          console.log();
          break;
        }
        case "groups": {
          const groups = db.deviceGroups();
          console.log(`\n  ${groups.length} device group(s) in ${dbPath}:\n`);
          printDeviceGroups(groups);
          console.log();
          break;
        }
        case "discover": {
          const jobs = db.discoverJobs();
          console.log(`\n  ${jobs.length} discovery job(s) in ${dbPath}:\n`);
          printDiscoverJobs(jobs);
          console.log();
          break;
        }
        default:
          console.error(`Unknown list subcommand: ${sub ?? "(none)"}\n  Available: devices, probes, device-types, link-types, networks, syslog-rules, groups, discover`);
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
      const db = DudeDB.openAuto(dbPath, { readonly: true });
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

    case "normalize": {
      const inputPath = positional[0];
      const outputPath = positional[1];
      if (!inputPath || !outputPath) {
        console.error("Error: usage: donny normalize <input.db|export.dude> <output.db> [--overwrite] [--skip-timeseries]");
        process.exit(1);
      }
      const overwrite = bool(flags, "overwrite");
      const skipTimeseries = bool(flags, "skip-timeseries");
      const { normalizeToFile } = await import("../lib/normalize.ts");
      const t0 = Date.now();
      const result = normalizeToFile(inputPath, outputPath, { overwrite, skipTimeseries });
      const ms = Date.now() - t0;
      console.log(`\n  Normalized ${inputPath} → ${outputPath} in ${ms}ms\n`);
      const rows = Object.entries(result.tables)
        .filter(([, n]) => n > 0)
        .sort(([a], [b]) => a.localeCompare(b));
      const nameW = Math.max(10, ...rows.map(([n]) => n.length));
      for (const [name, n] of rows) {
        console.log(`    ${name.padEnd(nameW)}  ${String(n).padStart(8)}`);
      }
      console.log(`\n    ${"total".padEnd(nameW)}  ${String(result.totalRows).padStart(8)}\n`);
      break;
    }

    case "denormalize": {
      const inputPath = positional[0];
      const outputPath = positional[1];
      if (!inputPath || !outputPath) {
        console.error("Error: usage: donny denormalize <normalized.db> <dude.db> [--overwrite] [--skip-timeseries]");
        process.exit(1);
      }
      const overwrite = bool(flags, "overwrite");
      const skipTimeseries = bool(flags, "skip-timeseries");
      const { denormalizeToFile } = await import("../lib/denormalize.ts");
      const t0 = Date.now();
      const result = denormalizeToFile(inputPath, outputPath, { overwrite, skipTimeseries });
      const ms = Date.now() - t0;
      console.log(`\n  Rebuilt dude.db at ${outputPath} from ${inputPath} in ${ms}ms\n`);
      const rows = Object.entries(result.tables)
        .filter(([, n]) => (n as number) > 0)
        .sort(([a], [b]) => a.localeCompare(b));
      const nameW = Math.max(18, ...rows.map(([n]) => n.length));
      for (const [name, n] of rows) {
        console.log(`    ${name.padEnd(nameW)}  ${String(n).padStart(8)}`);
      }
      console.log(`\n    ${"total".padEnd(nameW)}  ${String(result.totalRows).padStart(8)}\n`);
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
  donny list device-types <db>             list device type templates
  donny list link-types <db>               list link/interface types
  donny list networks <db>                 list network/subnet groups
  donny list syslog-rules <db>             list syslog rules
  donny list groups <db>                   list device groups
  donny list discover <db>                 list auto-discovery jobs
  donny export <db> [options]               export devices
    --format csv|json                       output format (default: json)
    --include-credentials                   include username/password in output
  donny normalize <in> <out.db> [opts]      transform dude.db into a normalized SQLite
    --overwrite                             replace <out.db> if it exists
    --skip-timeseries                       skip outages and chart_values_* copy
  donny denormalize <in.db> <out.db> [opts] rebuild a working dude.db from a normalized SQLite
    --overwrite                             replace <out.db> if it exists
    --skip-timeseries                       skip outages and chart_values_* copy
  donny add device <db> [options]           add a device with ping probe
    --name <name>                           device name (required)
    --address <ip|hostname>                 IP address or FQDN (required)
    --username <user>                       RouterOS username
    --password <pass>                       RouterOS password
    --routeros                              flag device as RouterOS
    --snmp                                  enable SNMP monitoring

  <db> accepts both dude.db (SQLite) and export.dude (gzip tar) files.
  donny --help                              show this help
`);
      process.exit(0);
    }

    default:
      console.error(`Unknown command: ${command}\nRun \`donny --help\` for usage.`);
      process.exit(1);
  }
}
