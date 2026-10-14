@echo off
chcp 65001 >nul
cd /d "%~dp0"

set PY=
where python >nul 2>nul && set PY=python
if not defined PY where py >nul 2>nul && set PY=py

echo Building dashboard...
%PY% dashboard.py
if errorlevel 1 (
  echo Failed. Send the error above to Claude.
  pause
  exit /b 1
)
start "" "%~dp0dashboard.html"
