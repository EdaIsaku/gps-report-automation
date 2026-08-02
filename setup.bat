@echo off
title Instalimi - GPS Reports Automation
cd /d "%~dp0"
echo Po instalohen paketat...
call npm install
if errorlevel 1 goto error
echo Po instalohet browser-i Chromium...
call npm run install-browser
if errorlevel 1 goto error
if not exist .env copy .env.example .env >nul
echo.
echo Instalimi perfundoi. Ploteso skedarin .env dhe pastaj hap run.bat.
pause
exit /b 0
:error
echo.
echo Instalimi deshtoi. Kontrollo qe Node.js eshte instaluar.
pause
exit /b 1
