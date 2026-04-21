#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SETTINGS_KEYS = [
  "baseUrl",
  "username",
  "password",
  "apiTimeout",
  "allowClientProvidedCredentials",
  "checkCertificates",
];

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function compareVersions(a, b) {
  const aParts = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const bParts = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const max = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < max; i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function candidateExtensionRoots() {
  const roots = [];
  if (process.env.VSCODE_EXTENSIONS) roots.push(process.env.VSCODE_EXTENSIONS);
  if (process.env.USERPROFILE) {
    roots.push(path.join(process.env.USERPROFILE, ".vscode", "extensions"));
    roots.push(path.join(process.env.USERPROFILE, ".vscode-insiders", "extensions"));
  }
  return roots;
}

function findRouterOsServer() {
  if (process.env.ROUTEROSLSP_SERVER && fs.existsSync(process.env.ROUTEROSLSP_SERVER)) {
    return process.env.ROUTEROSLSP_SERVER;
  }

  const matches = [];
  for (const root of candidateExtensionRoots()) {
    if (!root || !fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = /^tikoci\.lsp-routeros-ts-(.+)$/i.exec(entry.name);
      if (!match) continue;
      const serverPath = path.join(root, entry.name, "server", "dist", "server.js");
      if (!fs.existsSync(serverPath)) continue;
      matches.push({
        version: match[1],
        serverPath,
      });
    }
  }

  matches.sort((left, right) => compareVersions(right.version, left.version));
  return matches[0]?.serverPath;
}

function mergeRouterOsSettings(target, source, sourceName, sources) {
  if (!source || typeof source !== "object") return;
  let used = false;
  for (const key of SETTINGS_KEYS) {
    const flatKey = `routeroslsp.${key}`;
    if (Object.prototype.hasOwnProperty.call(source, flatKey)) {
      target[key] = source[flatKey];
      used = true;
    }
  }
  const nested = source.routeroslsp;
  if (nested && typeof nested === "object") {
    for (const key of SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(nested, key)) {
        target[key] = nested[key];
        used = true;
      }
    }
  }
  if (used) sources.push(sourceName);
}

function mergeEnvSettings(target, sources) {
  const envMap = {
    ROUTEROSLSP_BASE_URL: "baseUrl",
    ROUTEROSLSP_USERNAME: "username",
    ROUTEROSLSP_PASSWORD: "password",
    ROUTEROSLSP_API_TIMEOUT: "apiTimeout",
    ROUTEROSLSP_ALLOW_CLIENT_PROVIDED_CREDENTIALS: "allowClientProvidedCredentials",
    ROUTEROSLSP_CHECK_CERTIFICATES: "checkCertificates",
  };
  let used = false;
  for (const [envKey, targetKey] of Object.entries(envMap)) {
    const raw = process.env[envKey];
    if (!raw) continue;
    let value = raw;
    if (targetKey === "apiTimeout") value = Number.parseInt(raw, 10);
    if (targetKey === "allowClientProvidedCredentials" || targetKey === "checkCertificates") {
      value = /^(1|true|yes|on)$/i.test(raw);
    }
    target[targetKey] = value;
    used = true;
  }
  if (used) sources.push("environment");
}

function loadRouterOsSettings() {
  const settings = {};
  const sources = [];
  const repoRoot = path.resolve(__dirname, "..");

  mergeRouterOsSettings(
    settings,
    readJson(path.join(repoRoot, ".vscode", "settings.json")),
    "workspace .vscode/settings.json",
    sources,
  );

  if (process.env.APPDATA) {
    mergeRouterOsSettings(
      settings,
      readJson(path.join(process.env.APPDATA, "Code", "User", "settings.json")),
      "VS Code user settings",
      sources,
    );
    mergeRouterOsSettings(
      settings,
      readJson(path.join(process.env.APPDATA, "Code - Insiders", "User", "settings.json")),
      "VS Code Insiders user settings",
      sources,
    );
  }

  mergeEnvSettings(settings, sources);
  return { settings, sources };
}

function makeConfigItem(section, settings) {
  if (!section) return { routeroslsp: settings };
  if (section === "routeroslsp") return settings;
  if (section.startsWith("routeroslsp.")) {
    const key = section.slice("routeroslsp.".length);
    return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : null;
  }
  return null;
}

function createMessageBuffer() {
  let buffer = Buffer.alloc(0);
  return (chunk, onMessage) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const headerText = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!match) throw new Error("Missing Content-Length header");
      const bodyLength = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + bodyLength;
      if (buffer.length < bodyEnd) return;
      const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      buffer = buffer.subarray(bodyEnd);
      onMessage(JSON.parse(body));
    }
  };
}

function writeMessage(stream, message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  stream.write(`Content-Length: ${body.length}\r\n\r\n`);
  stream.write(body);
}

function runProbe() {
  const serverPath = findRouterOsServer();
  if (!serverPath) {
    console.error("RouterOS LSP server not found. Install TIKOCI.lsp-routeros-ts in VS Code.");
    process.exit(1);
  }
  const { sources } = loadRouterOsSettings();
  const sourceText = sources.length > 0 ? sources.join(", ") : "defaults only";
  console.log(`${serverPath} [settings: ${sourceText}]`);
}

function runProxy() {
  const serverPath = findRouterOsServer();
  if (!serverPath) {
    console.error("RouterOS LSP server not found. Install TIKOCI.lsp-routeros-ts in VS Code.");
    process.exit(1);
  }

  const { settings } = loadRouterOsSettings();
  const child = spawn(process.execPath, [serverPath, "--stdio"], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  const fromClient = createMessageBuffer();
  const fromServer = createMessageBuffer();

  process.stdin.on("data", (chunk) => {
    fromClient(chunk, (message) => {
      if (message?.method === "initialize" && message.params) {
        message.params.capabilities ??= {};
        message.params.capabilities.workspace ??= {};
        message.params.capabilities.workspace.configuration = true;
      }
      writeMessage(child.stdin, message);
    });
  });

  child.stdout.on("data", (chunk) => {
    fromServer(chunk, (message) => {
      if (message?.method === "workspace/configuration" && Object.prototype.hasOwnProperty.call(message, "id")) {
        const items = Array.isArray(message.params?.items) ? message.params.items : [];
        writeMessage(child.stdin, {
          jsonrpc: "2.0",
          id: message.id,
          result: items.map((item) => makeConfigItem(item?.section, settings)),
        });
        return;
      }
      writeMessage(process.stdout, message);
    });
  });

  process.stdin.on("end", () => child.stdin.end());
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

if (process.argv.includes("--probe")) {
  runProbe();
} else {
  runProxy();
}
