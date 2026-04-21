/**
 * Interactive wizard for donny — walks through common operations.
 * Loaded dynamically only when the wizard is invoked.
 */

import type { DudeDB } from "../lib/db.ts";

export async function runWizard(): Promise<void> {
  const clack = await import("@clack/prompts");
  const { DudeDB } = await import("../lib/db.ts");
  const { printStats, printDevices, bold } = await import("./format.ts");

  clack.intro(`${bold("donny")} — MikroTik Dude DB Manager`);

  const dbPath = await clack.text({
    message: "Path to dude.db file:",
    placeholder: "dude.db",
    validate: (v) => {
      if (!v.trim()) return "Required.";
    },
  });
  if (clack.isCancel(dbPath)) { clack.cancel("Cancelled."); process.exit(0); }

  let db: DudeDB;
  try {
    db = DudeDB.open(dbPath.trim());
  } catch (err) {
    clack.log.error(`Cannot open ${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const op = await clack.select({
    message: "What would you like to do?",
    options: [
      { value: "info", label: "Show database statistics" },
      { value: "devices", label: "List all devices" },
      { value: "export", label: "Export devices to CSV or JSON" },
      { value: "add", label: "Add a new device (with ping probe)" },
    ],
  });
  if (clack.isCancel(op)) { clack.cancel("Cancelled."); process.exit(0); }

  switch (op) {
    case "info": {
      const stats = db.stats();
      clack.log.info(`Database statistics for ${bold(dbPath.trim())}:`);
      printStats(stats);
      break;
    }

    case "devices": {
      const devices = db.devices();
      clack.log.info(`${devices.length} device(s) found:`);
      printDevices(devices);
      break;
    }

    case "export": {
      const format = await clack.select({
        message: "Export format:",
        options: [
          { value: "csv" as const, label: "CSV (comma-separated)" },
          { value: "json" as const, label: "JSON" },
        ],
      });
      if (clack.isCancel(format)) { clack.cancel("Cancelled."); process.exit(0); }

      const devices = db.devices();
      const { printDevicesCSV, printDevicesJSON } = await import("./format.ts");
      if ((format as string) === "csv") printDevicesCSV(devices);
      else printDevicesJSON(devices);
      break;
    }

    case "add": {
      const name = await clack.text({ message: "Device name:", validate: (v) => (!v.trim() ? "Required." : undefined) });
      if (clack.isCancel(name)) { clack.cancel("Cancelled."); process.exit(0); }

      const address = await clack.text({
        message: "IP address or hostname:",
        validate: (v) => (!v.trim() ? "Required." : undefined),
      });
      if (clack.isCancel(address)) { clack.cancel("Cancelled."); process.exit(0); }

      const username = await clack.text({ message: "RouterOS username (optional):", defaultValue: "" });
      if (clack.isCancel(username)) { clack.cancel("Cancelled."); process.exit(0); }

      const password = await clack.password({ message: "RouterOS password (optional):" });
      if (clack.isCancel(password)) { clack.cancel("Cancelled."); process.exit(0); }

      const spin = clack.spinner();
      spin.start("Adding device…");
      const ids = db.addDevice({ name: name.trim(), address: address.trim(), username: username || undefined, password: password || undefined });
      spin.stop(`Added device id=${ids.deviceId}, probe id=${ids.probeId}, service id=${ids.serviceId}`);
      clack.log.success(`Device "${name}" added. Restart The Dude server to pick up changes.`);
      break;
    }
  }

  db.close();
  clack.outro("Done.");
}
