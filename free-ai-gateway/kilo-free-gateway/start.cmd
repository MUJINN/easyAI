@echo off
setlocal
cd /d "%~dp0"

REM Default startup does not probe models or consume upstream requests.
set "TARGET=%~1"
if not defined TARGET set "TARGET=gateway"

if /i "%TARGET%"=="gateway" goto gateway

if /i "%TARGET%"=="select" (
  echo [kilo] Explicitly probing free models. This sends test requests upstream.
  node lib\selector.js > roles.json
  if errorlevel 1 exit /b 1
  call :verify_roles
  if errorlevel 1 (
    echo [kilo] No usable default model was selected.
    exit /b 1
  )
  echo [kilo] Model selection saved to roles.json
  exit /b 0
)

if /i "%TARGET%"=="claude-code" goto generate
if /i "%TARGET%"=="cline" goto generate
if /i "%TARGET%"=="continue" goto generate
if /i "%TARGET%"=="opencode" goto generate
if /i "%TARGET%"=="env" goto generate
if /i "%TARGET%"=="vscode" goto generate
if /i "%TARGET%"=="all" goto generate

echo Unknown target: %TARGET%
echo Available: gateway, select, claude-code, cline, continue, opencode, env, vscode, all
exit /b 1

:gateway
  echo [kilo] Starting local gateway and dashboard...
  echo [kilo] Dashboard: http://127.0.0.1:8899/
  node server.js
  exit /b %errorlevel%

:generate
echo [kilo] Explicitly probing models before generating client configuration.
node lib\selector.js > roles.json
if errorlevel 1 (
  echo [kilo] Model selection failed. No client configuration was generated.
  exit /b 1
)
call :verify_roles
if errorlevel 1 (
  echo [kilo] No usable default model was selected. No client configuration was generated.
  exit /b 1
)

if /i "%TARGET%"=="claude-code" (
  node lib\adaptors.js --target=env --input=roles.json > .env
  if errorlevel 1 exit /b 1
  echo [kilo] Wrote .env. Review it before loading it into your shell.
  exit /b 0
)
if /i "%TARGET%"=="env" (
  node lib\adaptors.js --target=env --input=roles.json
  if errorlevel 1 exit /b 1
  exit /b 0
)
if /i "%TARGET%"=="cline" (
  if not exist .vscode mkdir .vscode
  node lib\adaptors.js --target=cline --input=roles.json > .vscode\cline.json
  if errorlevel 1 exit /b 1
  echo [kilo] Wrote .vscode\cline.json
  exit /b 0
)
if /i "%TARGET%"=="continue" (
  if not exist .continue mkdir .continue
  node lib\adaptors.js --target=continue --input=roles.json > .continue\config.json
  if errorlevel 1 exit /b 1
  echo [kilo] Wrote .continue\config.json
  exit /b 0
)
if /i "%TARGET%"=="opencode" (
  node lib\adaptors.js --target=opencode --input=roles.json > opencode-config.json
  if errorlevel 1 exit /b 1
  echo [kilo] Wrote opencode-config.json
  exit /b 0
)
if /i "%TARGET%"=="vscode" (
  node lib\adaptors.js --target=vscode --input=roles.json > vscode-settings.json
  if errorlevel 1 exit /b 1
  echo [kilo] Wrote vscode-settings.json
  exit /b 0
)
if /i "%TARGET%"=="all" (
  node lib\adaptors.js --target=all --input=roles.json > all-configs.json
  if errorlevel 1 exit /b 1
  echo [kilo] Wrote all-configs.json
  exit /b 0
)

:verify_roles
node -e "const r=JSON.parse(require('node:fs').readFileSync('roles.json','utf8')); if(!r.roles || !r.roles.DEFAULT || !r.roles.DEFAULT.model) process.exit(1)"
exit /b %errorlevel%
