@echo off
chcp 65001 >nul
cd /d "%~dp0"

set PY=
where python >nul 2>nul && set PY=python
if not defined PY where py >nul 2>nul && set PY=py
if not defined PY goto nopython

echo [1/2] Installing Jev SDK (typesafe-sdk, needs Python 3.10+)...
%PY% -m pip install -q typesafe-sdk
if errorlevel 1 goto failed

echo [2/2] Configuring Jev API key...
%PY% setup_jev.py
if errorlevel 1 goto failed

echo.
pause
exit /b 0

:nopython
echo Python not found.
pause
exit /b 1

:failed
echo.
echo Failed. Send the error above to Claude (hide your key first).
pause
exit /b 1
