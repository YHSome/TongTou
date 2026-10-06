@echo off
rem ===========================================================================
rem  TONGTOU 4K launcher  -  double-click this file.
rem
rem  A browser refuses to run the game from a file:// path (it blocks ES modules
rem  on a null origin), so this starts a small local server and opens the page.
rem
rem  Node is preferred: serve.mjs answers HTTP Range requests, which lets the
rem  BGA video seek, and it detects an already-running copy of itself instead of
rem  dying with EADDRINUSE.  Python's server works too but streams the whole
rem  file first.
rem ===========================================================================
setlocal
cd /d "%~dp0"
title TONGTOU 4K

rem Switch the console to UTF-8 so the server's messages render properly on a
rem CP936/CP437 console.  The previous codepage is restored on the way out.
set "_prevcp="
for /f "tokens=2 delims=:." %%c in ('chcp') do set "_prevcp=%%c"
chcp 65001 >nul 2>nul

where node >nul 2>nul && (
  echo.
  echo   Node.js found - starting serve.mjs ...
  echo.
  node serve.mjs --open
  if errorlevel 1 pause
  goto :bye
)

where py >nul 2>nul && (
  echo.
  echo   Node.js not found - using the Python launcher.
  echo   Opening http://127.0.0.1:8080/ ...
  echo.
  start "" "http://127.0.0.1:8080/"
  py -m http.server 8080
  if errorlevel 1 pause
  goto :bye
)

where python >nul 2>nul && (
  echo.
  echo   Node.js not found - using Python.
  echo   Opening http://127.0.0.1:8080/ ...
  echo.
  start "" "http://127.0.0.1:8080/"
  python -m http.server 8080
  if errorlevel 1 pause
  goto :bye
)

echo.
echo   Neither Node.js nor Python was found on PATH.
echo.
echo   Install one of them, then run either of these in this folder:
echo       node serve.mjs
echo       python -m http.server 8080
echo.
echo   Do NOT open index.html directly by double-clicking it - the browser
echo   will block the game's scripts and it will stay on the loading screen.
echo.
pause

:bye
if defined _prevcp chcp %_prevcp% >nul 2>nul
endlocal
