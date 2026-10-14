@echo off
chcp 65001 >nul
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\UKIC Hub.lnk" 2>nul
echo Autostart removed.
pause
