@echo off
setlocal EnableExtensions

set "ROOT=%~dp0.."
pushd "%ROOT%" >nul 2>&1

where winget >nul 2>&1
if errorlevel 1 (
  echo [error] winget is not available. Install or repair App Installer first.
  exit /b 1
)

echo.
echo === donny Windows bootstrap ===
echo This installs the baseline tools for VS Code, Copilot, Copilot CLI, and this repo.
echo.

call :ensure_pkg "PowerShell 7" "Microsoft.PowerShell" "winget"
if errorlevel 1 goto :fail

call :ensure_pkg "Git" "Git.Git" "winget"
if errorlevel 1 goto :fail

call :ensure_pkg "GitHub CLI" "GitHub.cli" "winget"
if errorlevel 1 goto :fail

call :ensure_pkg "Visual Studio Code" "Microsoft.VisualStudioCode" "winget"
if errorlevel 1 goto :fail

call :ensure_pkg "Bun" "Oven-Bun.Bun" "winget"
if errorlevel 1 goto :fail

call :ensure_pkg "SQLite CLI" "SQLite.SQLite" "winget"
if errorlevel 1 goto :fail

call :ensure_pkg "GitHub Copilot CLI" "GitHub.Copilot" "winget"
if errorlevel 1 goto :fail

call :ensure_pkg "Node.js LTS" "OpenJS.NodeJS.LTS" "winget"
if errorlevel 1 (
  echo [warn] OpenJS.NodeJS.LTS was not available. Trying OpenJS.NodeJS.22 instead...
  call :ensure_pkg "Node.js 22" "OpenJS.NodeJS.22" "winget"
  if errorlevel 1 goto :fail
)

where code >nul 2>&1
if not errorlevel 1 (
  echo.
  echo Installing VS Code extensions...
  call code --install-extension GitHub.copilot --force
  call code --install-extension GitHub.copilot-chat --force
  call code --install-extension biomejs.biome --force
  call code --install-extension ms-vscode.powershell --force
  call code --install-extension TIKOCI.lsp-routeros-ts --force
) else (
  echo.
  echo [warn] code command not found on PATH yet. Reopen your shell after VS Code installs,
  echo        then install recommended extensions from .vscode\extensions.json or rerun this script.
)

where npm >nul 2>&1
if not errorlevel 1 (
  echo.
  echo Installing TypeScript language server for Copilot CLI LSP support...
  call npm install -g typescript typescript-language-server
) else (
  echo.
  echo [warn] npm is not available in this shell yet. Reopen your shell after Node.js installs,
  echo        then run: npm install -g typescript typescript-language-server
)

echo.
echo Bootstrap complete.
echo Restart Windows Terminal and VS Code so PATH updates take effect.
echo Then run:
echo   scripts\doctor-windows.cmd
echo   pwsh --version
echo   bun --version
echo   gh --version
echo   sqlite3 --version
echo   copilot --version
echo.
popd >nul 2>&1
exit /b 0

:ensure_pkg
set "PKG_NAME=%~1"
set "PKG_ID=%~2"
set "PKG_SOURCE=%~3"

echo.
echo Installing or confirming %PKG_NAME%...
winget install --id "%PKG_ID%" --source "%PKG_SOURCE%" -e --accept-source-agreements --accept-package-agreements
exit /b %errorlevel%

:fail
echo.
echo [error] Windows bootstrap stopped before completion.
popd >nul 2>&1
exit /b 1
