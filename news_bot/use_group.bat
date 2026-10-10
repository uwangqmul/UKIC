@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PY=
where python >nul 2>nul && set PY=python
if not defined PY where py >nul 2>nul && set PY=py
%PY% use_group.py
pause
