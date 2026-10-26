@echo off
rem Startet das Arena-Gateway in einem eigenen Fenster (Autostart-/Test-Modus).
rem Kein Adminrecht noetig. Beenden mit Strg+C oder Fenster schliessen.
setlocal
set "REPO=%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js wurde nicht gefunden. Installiere Node.js 20 oder neuer von https://nodejs.org/
  echo Im Plugin-Modus ^(Installation direkt in DSH Desktop^) ist Node.js nicht noetig.
  pause
  exit /b 1
)
if "%FREEMODELS_GATEWAY_PORT%"=="" set "FREEMODELS_GATEWAY_PORT=8787"
node "%REPO%\bin\arena-gateway.mjs" --port %FREEMODELS_GATEWAY_PORT%
echo.
echo Gateway beendet.
pause
