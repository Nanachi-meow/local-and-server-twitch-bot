# Обновление бота с GitHub (для установок из zip; git-клоны обновляются через git pull)
# Запуск: update.bat (или powershell -ExecutionPolicy Bypass -File update.ps1)
# Параметры: -Force — обновиться, даже если версии совпадают
param(
  [string]$Repo = 'Nanachi-meow/local-and-server-twitch-bot',
  [string]$Branch = 'main',
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$botDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---------- какая версия у нас и на GitHub ----------
$localVersion = '?'
try {
  $localVersion = (Get-Content (Join-Path $botDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
} catch {}
$remoteVersion = $null
try {
  $remoteVersion = (Invoke-RestMethod "https://raw.githubusercontent.com/$Repo/$Branch/package.json" -TimeoutSec 15).version
} catch {
  Write-Host "Не удалось узнать версию с GitHub ($($_.Exception.Message)) — попробую всё равно." -ForegroundColor Yellow
}
Write-Host "У тебя: v$localVersion | на GitHub: v$(if ($remoteVersion) { $remoteVersion } else { '?' })"
if (-not $Force -and $remoteVersion -and $remoteVersion -eq $localVersion) {
  Write-Host 'Обновлений нет — у тебя уже свежая версия ✅' -ForegroundColor Green
  exit 0
}

# ---------- чистка устаревших файлов ----------
# Никогда не трогаем личное: сессии, токены, настройки, медиа, свои модули, плеер.
$protectedDirs = @('data', 'overlay-media', 'modules', 'player', 'node_modules', '.git')
$protectedFiles = @('config.json')

function Test-Protected([string]$rel) {
  $top = ($rel -split '[\\/]')[0]
  return ($protectedDirs -contains $top) -or ($protectedFiles -contains $rel)
}

# Удаляет хлам по манифесту update-removed.txt (если путь существует).
function Remove-StaleByList([string]$listPath, [string]$root) {
  if (-not (Test-Path $listPath)) { return }
  Get-Content $listPath -Encoding UTF8 | ForEach-Object {
    $rel = $_.Trim()
    if (-not $rel -or $rel.StartsWith('#')) { return }
    if (Test-Protected $rel) { return }
    $target = Join-Path $root $rel
    if (Test-Path $target) {
      Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
      Write-Host "  Удалил устаревшее: $rel" -ForegroundColor DarkGray
    }
  }
}

# ---------- останавливаем бота, если он запущен из этой папки ----------
$running = @()
try {
  $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($botDir) }
} catch {}
if ($running) {
  Write-Host 'Останавливаю бота на время обновления…'
  $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
}

# ---------- обновление ----------
if (Test-Path (Join-Path $botDir '.git')) {
  # это git-клон — обновляемся напрямую
  Write-Host 'Это git-клон: делаю git pull…'
  git -C $botDir pull --ff-only
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'git pull не прошёл — скачаю zip поверх (данные не тронутся).' -ForegroundColor Yellow
  } else {
    Remove-StaleByList (Join-Path $botDir 'update-removed.txt') $botDir
    Write-Host 'Готово ✅ (данные в data/ и config.json не затронуты — они под gitignore)' -ForegroundColor Green
    if ($running) { Start-Process node -ArgumentList 'src\index.js' -WorkingDirectory $botDir -WindowStyle Hidden; Write-Host 'Бот запущен обратно (скрыто, без окна).' }
    exit 0
  }
}

# zip-путь: качаем ветку и накладываем поверх (свои файлы не в архиве — уцелеют)
$tmp = Join-Path $env:TEMP ("twitch-bot-update-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp | Out-Null
$zip = Join-Path $tmp 'bot.zip'
$url = "https://github.com/$Repo/archive/refs/heads/$Branch.zip"
Write-Host "Скачиваю $url …"
Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 120
Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'unpacked') -Force
$inner = Get-ChildItem (Join-Path $tmp 'unpacked') -Directory | Select-Object -First 1
if (-not $inner) { throw 'В архиве не нашёл папку с ботом' }

Write-Host 'Накладываю файлы поверх текущей установки…'
Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $botDir -Recurse -Force

# ---------- чистка лишнего (которого больше нет в поставке) ----------
Remove-StaleByList (Join-Path $inner.FullName 'update-removed.txt') $botDir

# src/ — код бота: если файл там не из новой поставки (переименован/выпилен) — удаляем.
# Свои файлы юзера там быть не должны: модули — modules/, данные — data/.
$newSrcFiles = Get-ChildItem (Join-Path $inner.FullName 'src') -Recurse -File -ErrorAction SilentlyContinue |
  ForEach-Object { $_.FullName.Substring($inner.FullName.Length + 1) }
$srcDir = Join-Path $botDir 'src'
if ((Test-Path $srcDir) -and $newSrcFiles) {
  Get-ChildItem $srcDir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($botDir.Length + 1)
    if ($newSrcFiles -notcontains $rel) {
      Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
      Write-Host "  Удалил устаревшее: $rel" -ForegroundColor DarkGray
    }
  }
  Get-ChildItem $srcDir -Recurse -Directory | Sort-Object { $_.FullName.Length } -Descending |
    Where-Object { -not (Get-ChildItem $_.FullName -Recurse -File) } |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

$newVersion = '?'
try { $newVersion = (Get-Content (Join-Path $botDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch {}
Write-Host "Обновлено: v$localVersion → v$newVersion ✅" -ForegroundColor Green
Write-Host 'Твои данные целы: config.json, data/ (токены, настройки, баллы, цитаты), overlay-media/ — не тронуты.'

if ($running) {
  Start-Process node -ArgumentList 'src\index.js' -WorkingDirectory $botDir -WindowStyle Hidden
  Write-Host 'Бот запущен обратно (скрыто, без окна). Панель: http://localhost:8080' -ForegroundColor Cyan
} else {
  Write-Host 'Бот не был запущен — запусти его как обычно (start-bot.bat или node src\index.js).' -ForegroundColor Cyan
}
