# donny

TypeScript library and CLI for reading and writing MikroTik **The Dude** network monitoring databases (`dude.db`).

## Install

```sh
bun add @tikoci/donny
```

Or use the CLI directly:

```sh
bunx @tikoci/donny --help
```

## CLI

```text
donny                                     interactive wizard
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
```

## Library

```ts
import { DudeDB } from "@tikoci/donny";

// Read devices
const db = DudeDB.open("dude.db", { readonly: true });
const devices = db.devices();
console.log(devices);
db.close();

// Add a device
const db2 = DudeDB.open("dude.db");
const ids = db2.addDevice({
  name: "core-router",
  address: "192.168.88.1",
  username: "admin",
  routerOS: true,
});
console.log(`Added device id=${ids.deviceId}`);
db2.close();
```

### Low-level Nova codec

```ts
import { decodeBlob, encodeDevice, ipv4FromU32, TAG } from "@tikoci/donny";

// Decode a raw blob from the objects table
const msg = decodeBlob(rawBytes);
if (msg) {
  const ipArr = getU32Array(msg, TAG.DEVICE_IP);
  console.log(ipArr ? ipv4FromU32(ipArr[0]) : "DNS mode");
}

// Encode a device blob
const blob = encodeDevice({ id: 99, name: "edge-01", address: "10.0.0.1" });
```

## Requirements

- [Bun](https://bun.sh/) ≥ 1.1

## License

MIT
