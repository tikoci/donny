/**
 * Domain types for The Dude database objects.
 *
 * All IDs are the integer primary keys from the `objs` table.
 * IPv4 addresses are dotted-decimal strings. Credentials are
 * present only when read from a database that stores them — callers
 * are responsible for handling these values appropriately.
 */

/** Summary statistics for an open database. */
export interface DbStats {
  objects: number;
  outages: number;
  chartRaw: number;
  chart10min: number;
  chart2hour: number;
  chart1day: number;
}

/** A monitored network device. */
export interface Device {
  id: number;
  name: string;
  /** Dotted-decimal IPv4, or FQDN for DNS-mode devices. */
  address: string;
  /** RouterOS admin username — stored plaintext in dude.db. */
  username?: string;
  /** RouterOS admin password — stored plaintext in dude.db. */
  password?: string;
  /** Device Settings > Polling > Enabled. */
  enabled: boolean;
  routerOS: boolean;
  snmpEnabled: boolean;
  snmpProfileId?: number;
  /** Device Settings > Polling > Probe interval, in seconds. */
  probeInterval?: number;
  /** @deprecated Use probeInterval, matching the Dude UI label. */
  pollInterval?: number;
  /** Device Settings > General > Custom Fields > CustomField1. */
  customField1?: string;
  /** Device Settings > General > Custom Fields > CustomField2. */
  customField2?: string;
  /** Device Settings > General > Custom Fields > CustomField3. */
  customField3?: string;
  /** Device type object ID (refs DeviceType). 0xFFFFFFFF sentinel surfaces as undefined. */
  deviceTypeId?: number;
  /** Colon-separated MAC addresses observed on this device. */
  macs: string[];
}

/** Options for adding a new device. */
export interface AddDeviceOptions {
  name: string;
  /** Dotted-decimal IPv4, or FQDN for DNS-mode. */
  address: string;
  username?: string;
  password?: string;
  enabled?: boolean;
  routerOS?: boolean;
  snmpEnabled?: boolean;
  snmpProfileId?: number;
  /** Device Settings > Polling > Probe interval, in seconds. */
  probeInterval?: number;
  /** @deprecated Use probeInterval, matching the Dude UI label. */
  pollInterval?: number;
  customField1?: string;
  customField2?: string;
  customField3?: string;
  /** Probe type IDs to attach. Defaults to ping (10160) if omitted. */
  probeTypeIds?: number[];
}

/** A probe type template (defines what can be monitored). */
export interface ProbeTemplate {
  id: number;
  name: string;
  /** 1=ping, 3=routeros, 5=snmp, etc. */
  kind: number;
  port?: number;
  builtIn: boolean;
}

/** A per-device probe configuration (links device ↔ service ↔ template). */
export interface ProbeConfig {
  id: number;
  deviceId: number;
  serviceId: number;
  probeTypeId: number;
  enabled: boolean;
  createdAt?: number;
}

/** A monitoring service — time-series anchor in chart_values_* tables. */
export interface Service {
  id: number;
  /** Convention: "probe_type @ device_name" */
  name: string;
  unit: string;
  enabled: boolean;
}

/** A Dude map canvas. */
export interface DudeMap {
  id: number;
  name: string;
}

/** An outage record from the outages table. */
export interface Outage {
  serviceId: number;
  deviceId: number;
  mapId: number;
  time: number;
  status: number;
  duration: number;
}

/** Chart/metric data point. */
export interface MetricPoint {
  serviceId: number;
  timestamp: number;
  value: number;
}

/** Options for export operations. */
export interface ExportOptions {
  format: "json" | "csv";
  type: "devices" | "probes" | "services" | "maps" | "all";
  includeCredentials?: boolean;
}

/** A Dude device type template (defines known device categories). */
export interface DeviceType {
  id: number;
  name: string;
  /** Default probe type IDs assigned when this device type is selected. */
  defaultProbeIds: number[];
  /** Parent type ID from the device type hierarchy, or undefined for root types. */
  parentTypeId?: number;
  /** Manage URL template string. */
  manageUrl?: string;
  builtIn: boolean;
}

/** A link/interface type definition. */
export interface LinkType {
  id: number;
  name: string;
  /** 0=ethernet, 1=vlan, 2=point-to-point, 3=wireless */
  category: number;
  /** SNMP ifType integer (e.g. 6=ethernet, 135=vlan, 23=ppp). */
  ifType?: number;
  /** Rated speed in bits per second, 0 if unspecified. */
  speedBps: bigint;
  builtIn: boolean;
}

/** A network/subnet group. */
export interface Network {
  id: number;
  name: string;
  /** CIDR subnet strings in this network group. */
  subnets: string[];
  mapId?: number;
}

/** A syslog rule for routing/filtering Dude syslog messages. */
export interface SyslogRule {
  id: number;
  name: string;
  enabled: boolean;
  pattern: string;
  /** Action: 0=notify, 1=log, 2=ignore, etc. */
  action: number;
  notificationId?: number;
}

/** A named collection of device IDs for bulk operations (group tag 0x2328). */
export interface DeviceGroup {
  id: number;
  name: string;
  memberIds: number[];
}

/**
 * An auto-discovery job record ("Discover Info" objects, range 0x6590–0x65AD).
 * Each record represents one scheduled network scan configuration.
 */
export interface DiscoverJob {
  id: number;
  name: string;
  /** Target network IPv4 address (LE u32 decoded). */
  network?: string;
  /** Seed/gateway IP string (may be empty). */
  seedIp: string;
  /** Destination canvas/map ID where discovered nodes are placed. */
  canvasId?: number;
  /** Scan interval in seconds (default 3600). */
  intervalSecs: number;
  /** Probe template IDs to apply to newly discovered devices. */
  probeTemplateIds: number[];
  enabled: boolean;
}
