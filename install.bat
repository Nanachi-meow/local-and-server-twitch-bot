@echo off
chcp 65001 >nul
title Установка Twitch-бота
setlocal EnableExtensions
echo.
echo === Установка локального Twitch-бота ===
echo.

rem Если путь передан аргументом (install.bat C:\my\dir) — окно выбора не открываем
set "INSTDIR=%~1"

if defined INSTDIR goto :havepath
echo Сейчас откроется окно: выбери папку, куда поставить бота...
for /f "usebackq delims=" %%I in (`powershell -NoProfile -Command "try { (New-Object -ComObject Shell.Application).BrowseForFolder(0,'Куда установить Twitch-бота?',0x10).Self.Path } catch { '' }"`) do set "INSTDIR=%%I"

rem виртуальные папки (::{GUID}) и отмена считаются «не выбрано»
if defined INSTDIR if "%INSTDIR:~0,2%"=="::" set "INSTDIR="

:havepath
if not defined INSTDIR set "INSTDIR="
if not defined INSTDIR (
  set /p "INSTDIR=Папка не выбрана. Введи путь вручную (Enter = C:\twitch-bot): "
)
if not defined INSTDIR set "INSTDIR=C:\twitch-bot"

echo.
echo Ставлю в: %INSTDIR%
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Path "%INSTDIR%"
if errorlevel 1 (
  echo.
  echo Установка не удалась — посмотри сообщения выше.
  pause
  exit /b 1
)

echo.
set "RUN="
set /p "RUN=Запустить бота прямо сейчас? (y = да, Enter/что угодно = нет): "
if /i "%RUN%"=="y" start "" "%INSTDIR%\start-bot.bat"
echo.
echo Готово! Обновления в будущем: запусти update.bat в папке бота.
pause
