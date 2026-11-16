@echo off
chcp 65001 >nul
title Обновление Twitch-бота
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" %*
echo.
pause
