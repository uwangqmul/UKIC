@echo off
rem One file for everything:
rem   1. first time only: moves ..\Nick_fixed\UKIC_Nick_fixed -> trader and ..\Stocks_bot -> news_bot, fixes paths
rem   2. every time: starts the news bot (minimized) and the UKIC Hub dashboard + schedule
chcp 65001 >nul
title UKIC Hub
cd /d "%~dp0"
set "HUB=%~dp0"
set "OLD_NICK=%~dp0..\Nick_fixed\UKIC_Nick_fixed"
set "OLD_BOT=%~dp0..\Stocks_bot"

rem ---------- 1. Move the two old folders in (skipped once done) ----------
set NEED=
if not exist "trader\package.json" set NEED=1
if not exist "news_bot\app.py" set NEED=1
if not defined NEED goto run

echo ========================================================
echo  First run: moving the two project folders into UKIC_Hub
echo    %OLD_NICK%  -^> trader
echo    %OLD_BOT%  -^> news_bot
echo  Before continuing, close the Stock News Bot window, any Chrome
echo  window opened by the UMushroom project, and editors open on them.
echo  With_Nick is not touched.
echo ========================================================
pause

if exist "trader\package.json" goto movebot
if not exist "%OLD_NICK%\package.json" ( echo Not found: %OLD_NICK% & goto failed )
move "%OLD_NICK%" "%HUB%trader" >nul
if errorlevel 1 ( echo Could not move Nick_fixed. Something is still using it; close it and run again. & goto failed )
rmdir "%~dp0..\Nick_fixed" 2>nul
echo Moved Nick_fixed -^> trader
rem mcp.json had the old absolute path (kept outside any ( ) block: the PowerShell line contains brackets)
powershell -NoProfile -Command "$t='%HUB%trader'.TrimEnd('\'); $j=[ordered]@{mcpServers=[ordered]@{umushroom=[ordered]@{type='stdio';command='node';args=@(\"$t\src\server.js\");cwd=$t}}}; $j | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 \"$t\mcp.json\""
echo Updated trader\mcp.json

:movebot
if exist "news_bot\app.py" goto moved
if not exist "%OLD_BOT%\app.py" ( echo Not found: %OLD_BOT% & goto failed )
move "%OLD_BOT%" "%HUB%news_bot" >nul
if errorlevel 1 ( echo Could not move Stocks_bot. Close the Stock News Bot window and run again. & goto failed )
echo Moved Stocks_bot -^> news_bot

:moved
set "OLDLNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Stock News Bot.lnk"
if exist "%OLDLNK%" ( del "%OLDLNK%" & echo Removed the old Stock News Bot autostart. )
echo Folders ready.
echo.

rem ---------- 2. Start ----------
:run
set PY=
where python >nul 2>nul && set PY=python
if not defined PY where py >nul 2>nul && set PY=py
if not defined PY ( echo Python not found. Install Python 3.10+ from https://www.python.org/downloads/ & pause & exit /b 1 )

echo Checking dependencies...
%PY% -m pip install -q -r news_bot\requirements.txt

rem The news bot refuses to start twice, so this is safe to run again
start "Stock News Bot" /min cmd /c "news_bot\start_stock_bot.bat"

%PY% hub\server.py
pause
exit /b 0

:failed
echo.
echo Stopped. Nothing else was changed.
pause
exit /b 1
