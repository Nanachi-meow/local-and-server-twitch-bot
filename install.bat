@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Установка Twitch-бота
echo.
echo === Установка локального Twitch-бота ===
echo.

rem Путь установки: аргумент или окно выбора
set "INSTDIR=%~1"
if defined INSTDIR goto :havepath

echo Сейчас откроется окно: выбери папку, куда поставить бота...
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "try { (New-Object -ComObject Shell.Application).BrowseForFolder(0,'Куда установить Twitch-бота?',0x10).Self.Path } catch { '' }"`) do set "INSTDIR=%%I"
if defined INSTDIR if "%INSTDIR:~0,2%"=="::" set "INSTDIR="

:havepath
if not defined INSTDIR set "INSTDIR="
if not defined INSTDIR (
  set /p "INSTDIR=Папка не выбрана. Введи путь вручную (Enter = C:\twitch-bot): "
)
if not defined INSTDIR set "INSTDIR=C:\twitch-bot"

echo.
echo Ставлю в: %INSTDIR%

rem Проверка Node.js
node -v >nul 2>&1
if errorlevel 1 (
  echo.
  echo [!] Node.js не найден. Установи его с https://nodejs.org ^(кнопка LTS^)
  echo     или выполни: winget install OpenJS.NodeJS.LTS
  echo     Потом запусти установку заново.
  pause
  exit /b 1
)

rem Скачиваем и распаковываем — всё через PowerShell one-liner, без внешних файлов
echo Скачиваю бота с GitHub...
powershell -NoProfile -Command ^
  "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;" ^
  "$tmp = Join-Path $env:TEMP ('twitch-bot-inst-' + [Guid]::NewGuid().ToString('N').Substring(0,8));" ^
  "New-Item -ItemType Directory -Path $tmp -Force | Out-Null;" ^
  "Invoke-WebRequest -Uri 'https://github.com/Nanachi-meow/local-and-server-twitch-bot/archive/refs/heads/main.zip' -OutFile (Join-Path $tmp 'bot.zip') -TimeoutSec 120;" ^
  "Expand-Archive -Path (Join-Path $tmp 'bot.zip') -DestinationPath (Join-Path $tmp 'unpacked') -Force;" ^
  "$inner = (Get-ChildItem (Join-Path $tmp 'unpacked') -Directory | Select-Object -First 1).FullName;" ^
  "New-Item -ItemType Directory -Path '%INSTDIR%' -Force | Out-Null;" ^
  "Copy-Item -Path (Join-Path $inner '*') -Destination '%INSTDIR%' -Recurse -Force;" ^
  "Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue;" ^
  "Write-Host 'OK: файлы скопированы.'"

if errorlevel 1 (
  echo.
  echo [!] Ошибка скачивания/распаковки. Проверь интернет и попробуй ещё раз.
  pause
  exit /b 1
)

echo.
set "RUN="
set /p "RUN=Запустить бота прямо сейчас? (y = да, Enter/что угодно = нет): "
if /i "%RUN%"=="y" start "" "%INSTDIR%\start-bot.bat"
echo.
echo Готово! Панель бота: http://localhost:8080
echo Обновления: запусти update.bat в папке бота.
pause
