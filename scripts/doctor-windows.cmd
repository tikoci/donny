@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0.."
pushd "%ROOT%" >nul 2>&1

echo.
echo === donny Windows environment doctor ===
echo.

call :check_cmd winget WINGET "WinGet"
call :check_cmd git GIT "Git"
call :check_cmd pwsh PWSH "PowerShell 7+"
call :check_cmd bun BUN "Bun"
call :check_cmd code CODE "VS Code CLI"
call :check_cmd copilot COPILOT "GitHub Copilot CLI"
call :check_cmd node NODE "Node.js"
call :check_cmd npm NPM "npm"
call :check_cmd typescript-language-server TSLS "TypeScript language server"

echo.
if defined HAS_BUN (
  echo Repo commands:
  echo   bun install --frozen-lockfile
  echo   bun run check
  echo   bun test test/unit/
) else (
  echo [warn] Bun is missing, so repo commands cannot run yet.
)

echo.
if not defined HAS_PWSH (
  echo [fix] Install PowerShell 7:
  echo   winget install --id Microsoft.PowerShell --source winget
)
if not defined HAS_COPILOT (
  echo [fix] Install GitHub Copilot CLI:
  echo   winget install GitHub.Copilot
)
if defined HAS_NPM if not defined HAS_TSLS (
  echo [fix] Install TypeScript LSP:
  echo   npm install -g typescript typescript-language-server
)

echo.
echo See CONTRIBUTING.md for the full Windows setup flow.
echo.

popd >nul 2>&1
exit /b 0

:check_cmd
set "CMD_NAME=%~1"
set "FLAG_NAME=%~2"
set "LABEL=%~3"
set "VER="

where "%CMD_NAME%" >nul 2>&1
if errorlevel 1 (
  echo [missing] %LABEL% - command "%CMD_NAME%" not found
  exit /b 0
)

set "HAS_%FLAG_NAME%=1"
for /f "delims=" %%I in ('"%CMD_NAME%" --version 2^>nul') do if not defined VER set "VER=%%I"
if not defined VER for /f "delims=" %%I in ('"%CMD_NAME%" -v 2^>nul') do if not defined VER set "VER=%%I"
if not defined VER for /f "delims=" %%I in ('"%CMD_NAME%" version 2^>nul') do if not defined VER set "VER=%%I"
if not defined VER set "VER=installed"
echo [ ok ] %LABEL% - !VER!
exit /b 0
