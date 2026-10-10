@echo off
chcp 65001 >nul
cd /d "%~dp0"

set PY=
where python >nul 2>nul && set PY=python
if not defined PY where py >nul 2>nul && set PY=py
if not defined PY if exist "%USERPROFILE%\anaconda3\python.exe" set PY="%USERPROFILE%\anaconda3\python.exe"
if not defined PY (
  echo 没有找到 Python，请先安装 Python 3：https://www.python.org/downloads/
  pause
  exit /b 1
)

echo [1/2] 安装依赖...
%PY% -m pip install -q -r requirements.txt
if errorlevel 1 (
  echo 依赖安装失败，请把上面的报错发给 Claude。
  pause
  exit /b 1
)

echo [2/2] 配置 Telegram...
%PY% setup_telegram.py
echo.
pause
