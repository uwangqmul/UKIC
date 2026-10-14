@echo off
rem Double-click: open UMushroom (logged-in project Chrome) with the portfolio journal beside it.
rem Close this window or press Ctrl+C to stop; the project Chrome windows close too.
chcp 65001 >nul
cd /d "%~dp0"
set MCP_CHROME_MODE=profile
call npm run open
