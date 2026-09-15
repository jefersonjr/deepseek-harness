@echo off
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0"
if errorlevel 1 exit /b 1

set "ComSpec=%SystemRoot%\System32\cmd.exe"
set "npm_config_script_shell=%ComSpec%"

where node.exe >nul 2>nul
if errorlevel 1 goto missing_node
node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (!((major === 22 && minor >= 19) || major >= 24)) { console.error('DeepSeek Harness requires Node.js 22.19+ (22.x) or 24+.'); process.exit(1); }"
if errorlevel 1 goto command_failed

set "DSH_PNPM=pnpm.cmd"
where pnpm.cmd >nul 2>nul
if not errorlevel 1 goto dependencies
set "DSH_PNPM=pnpm.exe"
where pnpm.exe >nul 2>nul
if errorlevel 1 goto missing_pnpm

:dependencies
if exist "node_modules\.modules.yaml" goto build
echo [DeepSeek Harness] Installing dependencies from the lockfile...
call "%DSH_PNPM%" install --frozen-lockfile
if errorlevel 1 goto command_failed

:build
echo [DeepSeek Harness] Building the checkout...
call "%DSH_PNPM%" run build
if errorlevel 1 goto command_failed

echo [DeepSeek Harness] Open the access link printed below. Press Ctrl+C to stop.
rem The automatic Windows browser opener uses PowerShell.
rem Forward arguments without CALL's second percent expansion.
node --import tsx/esm apps/cli/src/bin.ts web --no-open %*
set "DSH_EXIT_CODE=%errorlevel%"
goto finish

:missing_node
echo [DeepSeek Harness] Node.js is missing. Install Node.js 22.19+ ^(22.x^) or 24+ and reopen this terminal. 1>&2
set "DSH_EXIT_CODE=1"
goto finish

:missing_pnpm
echo [DeepSeek Harness] pnpm is missing. Run: npm install -g pnpm@11.7.0 1>&2
set "DSH_EXIT_CODE=1"
goto finish

:command_failed
set "DSH_EXIT_CODE=%errorlevel%"
echo [DeepSeek Harness] Preparation failed. See the error above. 1>&2

:finish
popd
endlocal & exit /b %DSH_EXIT_CODE%
