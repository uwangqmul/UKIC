@echo off
chcp 65001 >nul
cd /d "%~dp0"

set PY=
where python >nul 2>nul && set PY=python
if not defined PY where py >nul 2>nul && set PY=py
if not defined PY if exist "%USERPROFILE%\anaconda3\python.exe" set PY="%USERPROFILE%\anaconda3\python.exe"
if not defined PY (
  echo Python not found. Please install Python 3 first: https://www.python.org/downloads/
  pause
  exit /b 1
)

echo [1/2] Installing dependencies...
%PY% -m pip install -q -r requirements.txt
if errorlevel 1 (
  echo Installing dependencies failed. Send the error above to Claude.
  pause
  exit /b 1
)

echo [2/2] Setting up Telegram...
%PY% setup_telegram.py
echo.
pause
