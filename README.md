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

## 📥 Установка

Нужен [Node.js 22+](https://nodejs.org) (кнопка **LTS**, ставится один раз). Больше никаких зависимостей.

Выбери способ — все дают одинаковый результат:

<details>
<summary><b>🥇 Способ 1 — Установщик двойным кликом (Windows, самый простой)</b></summary>

1. 👉 **[⬇ Скачать install.bat](https://github.com/Nanachi-meow/local-and-server-twitch-bot/releases/latest/download/install.bat)** — один файл, ничего больше не нужно.
2. Двойной клик по скачанному файлу.
3. Windows спросит «разрешить внесение изменений?» — **Разрешить** (это текстовый скрипт, можно открыть блокнотом и проверить).
4. Откроется окошко выбора папки — выбери куда поставить (или создай новую) → **ОК**.
5. Спросит «Запустить бота сейчас?» → набери **`y`** (или Enter = потом).
6. Откроется браузер с панелью: **http://localhost:8080**

Если кнопка не сработала: [страница релизов](https://github.com/Nanachi-meow/local-and-server-twitch-bot/releases) → блок **Assets** → файл `install.bat` → Download.

</details>

<details>
<summary><b>🖥 Способ 2 — Через PowerShell (если хочешь указать путь кодом)</b></summary>

Скачай [`install.ps1`](https://github.com/Nanachi-meow/local-and-server-twitch-bot/releases/latest/download/install.ps1), положи куда удобно и запусти:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Path "C:\twitch-bot"
```

Скрипт проверит Node.js, скачает бота и распакует его в указанную папку.

</details>

<details>
<summary><b>📦 Способ 3 — Просто zip-архив (без скриптов)</b></summary>

1. 👉 **[⬇ Скачать zip бота](https://github.com/Nanachi-meow/local-and-server-twitch-bot/archive/refs/heads/main.zip)**
2. Правый клик по архиву → **«Извлечь всё…»** → выбери папку.
3. Зайди в появившуюся папку → двойной клик **`start-bot.bat`**.
4. Браузер откроет **http://localhost:8080**

</details>

<details>
<summary><b>🐧 Способ 4 — Linux / macOS / git (для гиков)</b></summary>

```bash
git clone https://github.com/Nanachi-meow/local-and-server-twitch-bot.git
cd local-and-server-twitch-bot
node src/index.js
```

Проверь Node: `node -v` → должно быть `v22` или новее. `npm install` не нужен.

Обновление: `git pull`

</details>

---

## ⚙️ Первый запуск

<details open>
<summary><b>📖 Полный гайд подключения к Twitch (~5 минут, один раз)</b></summary>

Понадобится **отдельный аккаунт Twitch для бота** — [заведи его заранее](https://twitch.tv) (НЕ твой личный, НЕ стримерский).

### Шаг 1. Создай приложение в Twitch

1. Открой **https://dev.twitch.tv/console/apps/create** (логин — под твоим личным/стримерским аккаунтом). Если нет доступа — подтверди телефон в [настройках Twitch](https://www.twitch.tv/settings/security).
2. **Name** — любое, например `moj-lokalny-bot`.
3. **OAuth Redirect URLs** — добавь **две** строки (кнопка «Add URL» для второй):
   ```
   http://localhost:8080/auth/callback
   http://localhost:8080/auth/broadcaster/callback
   ```
   Первая — для входа бота, вторая — для входа стримера (награды канала).
4. **Category** — выбери `Chat Bot`.
5. Жми **Create**.
6. Скопируй **Client ID** (виден сразу) → рядом **New Secret** → скопируй **Client Secret**. Запиши оба.

### Шаг 2. Настрой панель бота

1. Открой **http://localhost:8080** → вкладка **«Настройки»**.
2. Вставь **Client ID** и **Client Secret** → **«Сохранить»**.
3. Ниже в «Каналы, где работает бот» впиши имя **СВОЕГО канала** → **«Добавить канал»**. Аккаунт бота сюда писать НЕ надо.

### Шаг 3. Войди как БОТ (⚠️ не как ты!)

1. Открой **инкогнито-окно** (в Chrome: `Ctrl+Shift+N`).
2. В нём зайди на twitch.tv и залогинься **под аккаунтом бота**.
3. В панели бота (обычное окно): Настройки → **«Войти как бот»**.
4. Twitch спросит «Разрешить доступ?» → **Authorize**. Убедись что в инкогнито залогинен именно бот.

### Шаг 4. Дай боту права модератора

Зайди на свою страницу Twitch → свой чат → напиши:

```txt
/mod ник_бота
```

Без этого не работают шатауты, анонсы, закрепы и фоллоу-приветствия.

### Шаг 5. Войди как СТРИМЕР (для наград канала)

1. Панель → Настройки → **«👑 Войти как стример»**.
2. Логин — под **твоим стримерским** аккаунтом (не бота!).

После этого бот видит каждое списание наград Channel Points.

### Готово 🎉

На дашборде горит «✅ чат подключен (6/6 подписок)». Можно стримить!

### Если что-то не заводится

| Проблема | Решение |
|---|---|
| Панель не открывается | Запущен ли бот? (`start-bot.bat`) Адрес ровно `http://localhost:8080` |
| «Бот не авторизован» | Шаг 3 делали в инкогнито под ботом? Если сомневаешься: Настройки → «Выйти» → снова «Войти как бот» |
| «redirect_uri does not match» | В dev.twitch.tv/console → в приложении должны быть **обе** Redirect URL из Шага 1 |
| «Канал не найден» | Имя канала без `@` и без опечаток |
| Шатауты/анонсы «нет прав» | Сделан ли `/mod ник_бота` в твоём чате? |
| Windows не даёт запустить .bat | «Подробнее» → «Выполнить в любом случае» |

</details>

---

## 🔄 Обновление

| Как ставил | Как обновиться |
|---|---|
| Способ 1–3 (батник/PowerShell/zip) | Двойной клик **`update.bat`** в папке бота (или [`update.ps1`](https://github.com/Nanachi-meow/local-and-server-twitch-bot/releases/latest/download/update.ps1) в папку) |
| Способ 4 (git) | `git pull` |

Твои **токены, настройки, цитаты, музыка и модули не тронутся** — они в файлах, которые в обновление не входят.

---

## ✨ Что умеет

<details>
<summary><b>✨ Что умеет (нажми чтобы посмотреть все 12 функций)</b></summary>

| | |
|---|---|
| 📺 **Оверлей для OBS** | Всплывающие алерты (фоллоу, саб, рейд), свои звуки (кинь mp3 в `overlay-media/`), Event List (лента событий), TTS-озвучка. Страница `/overlay` в OBS как Browser Source. |
| 🎵 **Плеер музыки** | Заказы YouTube через чат (`!ср <ссылка>`) или награды канала. Отдельная страница `/music` — своя аудиодорожка в OBS (без риска авторских прав). Кастомизируемый и заменяемый плеер (`sr-player.js`). |
| 👑 **Награды канала** | Channel Points Twitch — бот видит покупки наград и реагирует. Мэппинг «название награды → действие бота» в панели. |
| 🧩 **Кастомные команды** | Текст / случайные варианты / рандом-число с диапазонами. Условие «нужен @ник», шанс срабатывания. Всё из панели, вкладка «Команды» (подвкладки «Кастомные» и «Встроенные»). |
| ⚙️ **Фан-команды** | РП (`!обнять @ник`), рандом-проценты (`!хорни`), колесо фортуны. Готовые шаблоны одним кликом. Встроенные команды — с кнопкой вкл/выкл. |
| ⏰ **Таймеры** | Периодические сообщения. Режимы: по времени, по количеству сообщений в чате, или оба условия (И/ИЛИ). |
| 📖 **Цитаты** | Авто-нумерация, поиск, добавление из чата или панели. |
| 🎬 **Управление OBS** | `!сцена <имя>` — смена сцены из чата (obs-websocket 5, встроенный WebSocket Node, без зависимостей). |
| 💬 **Чат-команды** | `!uptime`, `!game`, `!title`, `!followage`, `!so`, `!pin`, `!unpin`, `!announce` |
| 🧩 **Модули-плагины** | .js-файл в папку `modules/` = новая функция. Подхват на лету, упавший модуль не роняет бот. Свой API (say/announce/pin/shoutout/settings/events). |
| 🛡️ **Автозакреп** | На старте стрима бот пишет приветствие и закрепляет его. |
| 📣 **Автошатауты** | Друзья-стримеры пишут в чат → бот кидает шатаут с их текстом. |

</details>

<details>
<summary><b>🛠 Технические детали ( для интересующихся )</b></summary>

- **Node.js 22+**, ноль зависимостей (`npm install` не нужен)
- Только **официальные API Twitch**: Chat Bot API + EventSub WebSocket (IRC не используется — это legacy)
- Оверлей — SSE (Server-Sent Events), без WebSocket-библиотек
- OBS-клиент — встроенный WebSocket Node 22 + `node:crypto` для SHA-256 challenge
- Прокси — чистый `node:http` CONNECT-туннель + `node:tls`
- Хранение — JSON-файлы в `data/`, атомарные записи (tmp + rename)
- Тесты — 203 самотеста без сети (`npm run selftest`)
- ~50 КБ кода, всё читается за вечер

</details>

---

## 📚 Документация

| Что | Где |
|---|---|
| **Все команды** | [ДОКУМЕНТАЦИЯ.md — Команды](ДОКУМЕНТАЦИЯ.md#команды) |
| **Музыка: плеер, настройки** | [ДОКУМЕНТАЦИЯ.md — Музыка](ДОКУМЕНТАЦИЯ.md#музыка) |
| **Награды канала** | [ДОКУМЕНТАЦИЯ.md — Награды](ДОКУМЕНТАЦИЯ.md#награды-канала) |
| **Оверлей: алерты, TTS** | [ДОКУМЕНТАЦИЯ.md — Оверлей](ДОКУМЕНТАЦИЯ.md#оверлей) |
| **Управление OBS** | [ДОКУМЕНТАЦИЯ.md — OBS](ДОКУМЕНТАЦИЯ.md#obs) |
| **Модули-плагины (API)** | [ДОКУМЕНТАЦИЯ.md — Модули](ДОКУМЕНТАЦИЯ.md#модули) |
| **Прокси** | [ДОКУМЕНТАЦИЯ.md — Прокси](ДОКУМЕНТАЦИЯ.md#прокси) |
| **Структура файлов** | [ДОКУМЕНТАЦИЯ.md — Структура](ДОКУМЕНТАЦИЯ.md#структура) |

---

## 🤔 Сравнение

| | Наш бот | Streamer.bot | StreamElements |
|---|---|---|---|
| Зависимости | **0** | .NET Runtime | Облако (нужен аккаунт) |
| Локальность | ✅ 100% | ✅ | ❌ данные в облаке |
| Размер кода | ~50 КБ | ~100 МБ | ? |
| Модули | ✅ .js (люба я правка) | ✅ C# | ⚠️ ограничено |
| OBS-управление | ✅ | ✅ | ⚠️ |
| Стоимость | **Бесплатно навсегда** | Бесплатно | Freemium |

---

## 📄 Лицензия

[MIT](LICENSE) — делай что хочешь, продавай, меняй, продавай.
