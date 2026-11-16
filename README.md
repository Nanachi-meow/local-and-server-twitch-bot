# 🤖 Локальный Twitch-бот с веб-панелью

Полностью свой, полностью локальный бот для твич-чата. Без облаков, без подписок, без зависимостей.

[![GitHub stars](https://img.shields.io/github/stars/Nanachi-meow/local-and-server-twitch-bot?style=for-the-badge&color=yellow)](https://github.com/Nanachi-meow/local-and-server-twitch-bot/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/Nanachi-meow/local-and-server-twitch-bot?style=for-the-badge&color=blue)](https://github.com/Nanachi-meow/local-and-server-twitch-bot/network)
[![GitHub issues](https://img.shields.io/github/issues/Nanachi-meow/local-and-server-twitch-bot?style=for-the-badge&color=red)](https://github.com/Nanachi-meow/local-and-server-twitch-bot/issues)
[![License](https://img.shields.io/github/license/Nanachi-meow/local-and-server-twitch-bot?style=for-the-badge&color=green)](LICENSE)
[![Code Size](https://img.shields.io/github/languages/code-size/Nanachi-meow/local-and-server-twitch-bot?style=for-the-badge&color=purple)](#)
[![Last Commit](https://img.shields.io/github/last-commit/Nanachi-meow/local-and-server-twitch-bot?style=for-the-badge&color=orange)](https://github.com/Nanachi-meow/local-and-server-twitch-bot/commits)

[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-blue?style=for-the-badge)](#)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/Dependencies-0-ff69b4?style=for-the-badge)](#)
[![API](https://img.shields.io/badge/API-100%25%20Official%20Twitch-9146FF?style=for-the-badge)](#)

---

📚 **[Полная документация](ДОКУМЕНТАЦИЯ.md)** — все команды, настройки, модули, API

---

## Что умеет

| | |
|---|---|
| 📺 **Оверлей для OBS** | всплывающие алерты, свои звуки, Event List, TTS-озвучка |
| 🎵 **Плеер музыки** | заказы YouTube через чат или награды канала, отдельная аудиодорожка |
| 👑 **Награды канала** | Channel Points Twitch — бот видит покупки и реагирует |
| 🧩 **Кастомные команды** | текст / варианты / рандом-число с диапазонами, без кода из панели |
| ⏰ **Таймеры** | периодические сообщения: по времени, по чату, или оба условия |
| ♻ **Тотализатор** | мод открывает, зрители ставят на исходы (бесплатная игра) |
| 📖 **Цитаты** | авто-нумерация, поиск, добавление из чата или панели |
| 🎬 **Управление OBS** | смена сцены из чата (obs-websocket 5, без зависимостей) |
| 🧩 **Модули-плагины** | .js-файл в папку = новая функция, подхват на лету |

## Установка

### 🥇 Батник (Windows, рекомендую)

**[⬇ Скачать install.bat](https://github.com/Nanachi-meow/local-and-server-twitch-bot/releases/latest/download/install.bat)** → двойной клик → выбери папку → готово.

### Другие способы

<details>
<summary>PowerShell / zip / git</summary>

```powershell
# PowerShell
powershell -ExecutionPolicy Bypass -File install.ps1 -Path "C:\twitch-bot"
```

```txt
# git (Linux/macOS)
git clone https://github.com/Nanachi-meow/local-and-server-twitch-bot.git
cd local-and-server-twitch-bot
node src/index.js
```
</details>

Нужен [Node.js 22+](https://nodejs.org) (LTS). Больше ничего, `npm install` не нужен.

## Первый запуск

Подробно — в **[документации](ДОКУМЕНТАЦИЯ.md)**. Коротко:

1. [dev.twitch.tv/console/apps/create](https://dev.twitch.tv/console/apps/create) → создай приложение (Redirect URL: `http://localhost:8080/auth/callback`)
2. Добавь **второй** Redirect URL: `http://localhost:8080/auth/broadcaster/callback` (для наград канала)
3. Панель (`http://localhost:8080`) → вставь Client ID/Secret → «Войти как бот» (инкогнито, под аккаунтом бота)
4. В своём чате: `/mod ник_бота`

## Обновление

В папке бота — двойной клик `update.bat`. Твои данные, настройки и модули не тронутся.
Git: `git pull`.

---

## Сравнение

| | Наш бот | Streamer.bot | StreamElements |
|---|---|---|---|
| Зависимости | **0** | C#/.NET | Облако |
| Локальность | ✅ | ✅ | ❌ |
| Панель управления | ✅ встроенная | ✅ | ✅ |
| Модули-плагины | ✅ (.js) | ✅ (C#) | ⚠️ ограничено |
| OBS-управление | ✅ | ✅ | ⚠️ |
| Размер кода | ~50 КБ | ~100 МБ | ? |

## Лицензия

[MIT](LICENSE) — делай что хочешь.
