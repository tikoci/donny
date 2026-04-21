# Contributing to donny

This repository is a **Bun-first TypeScript project** with a CLI and a low-level binary codec. On Windows, the main extra requirement for Copilot CLI is **PowerShell 7+** (`pwsh.exe`), which is not included with stock Windows PowerShell 5.1.

This guide is Windows-first for now. It covers the minimum setup needed to work on this repo in **VS Code**, use **GitHub Copilot** in the editor, and use **GitHub Copilot CLI** from a terminal in the repo root.

## Quick start

If you want the repo to do most of the Windows setup work for you:

```cmd
scripts\setup-windows.cmd
scripts\doctor-windows.cmd
```

The bootstrap script installs the baseline tools and VS Code extensions. The doctor script verifies what is available in the current shell and tells you what is still missing.

## Repository requirements

- **Bun** is the runtime and package manager for this repo.
- **PowerShell 7+** is required for GitHub Copilot CLI on Windows.
- **Git** and **VS Code** are the expected baseline tools.
- **GitHub CLI** and **SQLite CLI** are part of the Windows bootstrap because they are commonly useful for GitHub workflows, agent tasks, and direct database inspection.
- **Node.js is optional** for this repo itself, but useful if you want TypeScript LSP support in Copilot CLI or if you prefer npm-based Copilot CLI installs.

## 1. Baseline Windows tooling

Open **Windows Terminal**, **PowerShell**, or **Command Prompt** and install the base tools with `winget`.

### WinGet

`winget` ships through **App Installer** on Windows 11 and current Windows 10 builds.

Verify it:

```powershell
winget --version
```

If `winget` is missing, update or install **App Installer** first.

### Git

```powershell
winget install --id Git.Git -e
```

The Windows doctor prefers **Git for Windows** specifically and also checks whether `bash` is available on PATH, since some tooling expects the Git-for-Windows shell.

### PowerShell 7

This is the key fix for Copilot CLI on Windows. GitHub Copilot CLI requires **PowerShell v6 or higher**, and on this machine the missing `pwsh.exe` is the reason shell-backed tools are failing.

```powershell
winget install --id Microsoft.PowerShell --source winget
```

After install, close and reopen terminals and VS Code, then verify:

```powershell
pwsh --version
```

### Visual Studio Code

```powershell
winget install --id Microsoft.VisualStudioCode -e
```

Verify:

```powershell
code --version
```

If `code` is not on PATH, rerun the VS Code installer and enable the option to add VS Code to PATH.

This repo also includes `.vscode/extensions.json` with recommended extensions and `.vscode/tasks.json` with common Bun workflows plus Windows bootstrap/doctor tasks.

### GitHub CLI

```powershell
winget install --id GitHub.cli -e
```

Verify:

```powershell
gh --version
```

### Bun

Preferred on Windows:

```powershell
winget install --id Oven-Bun.Bun -e
```

Alternative official installer:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Verify:

```powershell
bun --version
```

### SQLite CLI

```powershell
winget install --id SQLite.SQLite -e
```

Verify:

```powershell
sqlite3 --version
```

## 2. GitHub Copilot in VS Code

Install these extensions in VS Code:

- **GitHub Copilot**
- **GitHub Copilot Chat**
- **RouterOS LSP**

Then sign in with the GitHub account that has Copilot access.

Quick checks:

1. Open this repo in VS Code.
2. Open any `.ts` file.
3. Confirm inline suggestions appear and Copilot Chat can open in the sidebar.

## 3. GitHub Copilot CLI

### Recommended Windows install

Once `pwsh.exe` is available:

```powershell
winget install GitHub.Copilot
```

Verify:

```powershell
copilot --version
```

Start it in the repo root:

```powershell
copilot
```

On first launch:

1. Run `/login` if prompted.
2. Run `/env` to confirm instructions and environment details loaded.
3. Run `/ide` to connect the current VS Code workspace.
4. Run `/lsp` after installing the language servers you want to use so Copilot CLI can confirm the repository LSP configuration is active.

### Alternative install

If you prefer npm, Copilot CLI also supports:

```powershell
npm install -g @github/copilot
```

That path requires **Node.js 22+**, so the WinGet install is simpler on a fresh Windows machine.

## 4. LSP servers for Copilot CLI

Copilot CLI supports repository-level LSP configuration, but it does **not** bundle language servers.

This repo configures two LSP servers in `.github/lsp.json`:

- **TypeScript** via `typescript-language-server`
- **RouterOS** via `scripts/routeroslsp-launcher.cjs`, which discovers the installed **RouterOS LSP** VS Code extension and launches its bundled server

### RouterOS LSP settings reuse

The RouterOS launcher reuses RouterOS settings from:

1. workspace `.vscode/settings.json`
2. VS Code user settings
3. environment variables

Supported environment variables:

```text
ROUTEROSLSP_BASE_URL
ROUTEROSLSP_USERNAME
ROUTEROSLSP_PASSWORD
ROUTEROSLSP_API_TIMEOUT
ROUTEROSLSP_ALLOW_CLIENT_PROVIDED_CREDENTIALS
ROUTEROSLSP_CHECK_CERTIFICATES
```

That lets VS Code and Copilot CLI share the same RouterOS endpoint and credentials without hard-coding secrets in the repository.

### TypeScript LSP

If you want Copilot CLI to use TypeScript LSP features, install **Node.js 22+** (or the current LTS release) and the TypeScript language server:

```powershell
winget search Node.js
# install the current OpenJS Node.js package shown by winget, if Node is not already installed
npm install -g typescript typescript-language-server
```

Then start `copilot` and use:

```text
/lsp
```

You should see the configured TypeScript server for `.ts` files.

### RouterOS LSP

The Windows bootstrap installs the VS Code extension:

```powershell
code --install-extension TIKOCI.lsp-routeros-ts
```

You can verify that Copilot CLI can find it with:

```powershell
node scripts\routeroslsp-launcher.cjs --probe
```

Then start `copilot` and run:

```text
/lsp
```

You should see the configured RouterOS server for `.rsc` and related RouterOS file types.

## 5. Clone and bootstrap the repo

```powershell
git clone https://github.com/tikoci/donny.git
cd donny
bun install --frozen-lockfile
```

## 6. Daily development commands

### Lint, typecheck, and markdown

```powershell
bun run check
```

More targeted commands:

```powershell
bun run lint:biome
bun run lint:typecheck
bun run lint:markdown
```

### Tests

Run the full unit suite:

```powershell
bun test test/unit/
```

Run a single test file:

```powershell
bun test test/unit/nova.test.ts
```

Run a single named test:

```powershell
bun test test/unit/nova.test.ts --test-name-pattern "bool_true"
```

### CLI entrypoint

Run the CLI directly from source:

```powershell
bun run src/cli/index.ts --help
```

## 7. Repo-specific development notes

- Runtime is **Bun**, not Node. Prefer Bun-native commands and APIs.
- The project is all-ESM and uses `.ts` extensions in relative imports.
- `src/lib/` is the pure library layer and must not import from `src/cli/` or call `process.exit()`.
- `src/cli/` owns terminal I/O, command routing, and interactive wizard flows.
- The low-level Nova codec lives in `src/lib/nova.ts`; `DESIGN.md` is the authoritative binary-format reference.
- Tests use committed safe fixtures `clean.db` and `clean.export`. Real `*.db` files may contain plaintext credentials and are gitignored.

## 8. Current Windows repair checklist

If Copilot CLI or agent shell tools fail on Windows with an error like **`'pwsh.exe' is not recognized`**:

1. Install PowerShell 7 with `winget install --id Microsoft.PowerShell --source winget`
2. Restart **Windows Terminal**, **VS Code**, and any open Copilot CLI sessions
3. Verify `pwsh --version`
4. Re-run `copilot`

If `winget` works but `pwsh` still does not, check whether PowerShell 7 installed without updating PATH, or start it directly from:

```text
C:\Program Files\PowerShell\7\pwsh.exe
```

Once that works, restart VS Code so integrated terminals and Copilot CLI inherit the updated PATH.
