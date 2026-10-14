@echo off
chcp 65001 >nul
cd /d "%~dp0"
set LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\UKIC Hub.lnk
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%'); $s.TargetPath='%~dp0start_hub.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"
if exist "%LNK%" ( echo Done. UKIC Hub starts minimized every time you log in to Windows. ) else ( echo Failed to create the startup shortcut. )
pause
