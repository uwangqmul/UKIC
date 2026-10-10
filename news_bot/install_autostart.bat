@echo off
chcp 65001 >nul
cd /d "%~dp0"
set LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Stock News Bot.lnk
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%'); $s.TargetPath='%~dp0start_stock_bot.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"
if exist "%LNK%" (
  echo Done. The bot will start automatically (minimized) every time you log in to Windows.
  echo To undo, run remove_autostart.bat
) else (
  echo Failed to create the startup shortcut.
)
pause
