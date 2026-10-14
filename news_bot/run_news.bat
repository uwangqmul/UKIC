@echo off
chcp 65001 >nul
cd /d "%~dp0"

set PY=
where python >nul 2>nul && set PY=python
if not defined PY where py >nul 2>nul && set PY=py
if not defined PY goto nopython

echo [1/3] Installing dependencies...
%PY% -m pip install -q -r requirements.txt
if errorlevel 1 goto failed

echo [2/3] Checking Telegram config...
%PY% setup_telegram.py --quiet
if errorlevel 1 goto failed

echo [3/3] Fetching news and pushing...
%PY% news.py
if errorlevel 1 goto failed

echo Updating dashboard...
%PY% dashboard.py

echo.
echo Done. Check Telegram.
pause
exit /b 0

:nopython
echo Python not found. Install Python 3 from https://www.python.org/downloads/
pause
exit /b 1

:failed
echo.
echo Failed. Send the error above to Claude (hide your token first).
pause
exit /b 1
