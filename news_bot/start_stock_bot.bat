@echo off
chcp 65001 >nul
title Stock News Bot
cd /d "%~dp0"

set PY=
where python >nul 2>nul && set PY=python
if not defined PY where py >nul 2>nul && set PY=py
if not defined PY goto nopython

echo Checking dependencies...
%PY% -m pip install -q -r requirements.txt
if errorlevel 1 goto failed

%PY% setup_telegram.py --quiet
if errorlevel 1 goto failed

%PY% app.py
pause
exit /b 0

:nopython
echo Python not found. Install Python 3.10+ from https://www.python.org/downloads/
pause
exit /b 1

:failed
echo.
echo Failed. See README.md (troubleshooting) or send the error above to Claude.
pause
exit /b 1
