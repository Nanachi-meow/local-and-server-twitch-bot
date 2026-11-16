# Установка Twitch-бота с GitHub (для новых пользователей)
# Запуск из PowerShell:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Path "C:\моё\место" -Force
param(
  [string]$Path = 'C:\twitch-bot',
  [string]$Repo = 'Nanachi-meow/local-and-server-twitch-bot',
  [string]$Branch = 'main',
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host '=== Установка локального Twitch-бота ===' -ForegroundColor Cyan

# ---------- Node.js есть? ----------
$nodeVersion = $null
try { $nodeVersion = (& node -v 2>$null) } catch {}
if (-not $nodeVersion) {
  Write-Host '❌ Не нашла Node.js. Установи LTS с https://nodejs.org (или: winget install OpenJS.NodeJS.LTS) и запусти установку заново.' -ForegroundColor Red
  exit 1
}
Write-Host "Node.js: $nodeVersion ✅"

# ---------- папка ----------
if (Test-Path $Path) {
  $has = Get-ChildItem $Path -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($has -and -not $Force) {
    Write-Host "❌ Папка $Path не пуста. Если это старая копия бота — запусти её update.bat; если уверен(а) — добавь -Force." -ForegroundColor Red
    exit 1
  }
}
New-Item -ItemType Directory -Path $Path -Force | Out-Null

# ---------- скачиваем ----------
$tmp = Join-Path $env:TEMP ("twitch-bot-install-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp | Out-Null
$zip = Join-Path $tmp 'bot.zip'
$url = "https://github.com/$Repo/archive/refs/heads/$Branch.zip"
Write-Host "Скачиваю $url …"
Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 120
Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'unpacked') -Force
$inner = Get-ChildItem (Join-Path $tmp 'unpacked') -Directory | Select-Object -First 1
if (-not $inner) { throw 'В архиве не нашёл папку с ботом' }

Write-Host "Копирую в $Path …"
Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $Path -Recurse -Force
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

$version = '?'
try { $version = (Get-Content (Join-Path $Path 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch {}
Write-Host ""
Write-Host "=== Готово! Установлена v$version ✅ ===" -ForegroundColor Green
Write-Host ""
Write-Host 'Что дальше:'
Write-Host "  1. Запусти бота:  $Path\start-bot.bat  (или:  node src\index.js)"
Write-Host '  2. Открой панель:  http://localhost:8080'
Write-Host '  3. В панели пройди «Первичную настройку» (Client ID/Secret приложения Twitch, свой канал, вход ботом).'
Write-Host '     Как создать приложение: README.md, раздел «Первый запуск — 4 шага».'
Write-Host ''
Write-Host 'Обновления в будущем: в папке бота запускай update.bat — твои данные и настройки не тронутся.' -ForegroundColor Cyan
