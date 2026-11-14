@echo off
chcp 65001 >nul
title Локальный Twitch-бот
cd /d "%~dp0"
echo Запускаю бота... Панель откроется сама: http://localhost:8080
echo Остановить бота — закрой это окно (или Ctrl+C).
powershell -NoProfile -Command "Start-Sleep 2; Start-Process 'http://localhost:8080'"
node src\index.js
pause
