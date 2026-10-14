@echo off
chcp 65001 >nul
set LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Stock News Bot.lnk
if exist "%LNK%" (
  del "%LNK%"
  echo Auto-start removed.
) else (
  echo Auto-start was not set up.
)
pause
