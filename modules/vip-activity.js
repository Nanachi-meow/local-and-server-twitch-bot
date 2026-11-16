/**
 * ══════════════════════════════════════════════════════════════════════════════
 * vip-activity — снимает VIP-статус с неактивных зрителей.
 *
 * Этот файл — ДВОЙНОЙ:
 *   1) РАБОЧИЙ модуль (сухой режим dryRun=true по умолчанию — ничего не снимает,
 *      только предупреждает в лог панели);
 *   2) СПРАВОЧНИК API МОДУЛЕЙ — в комментариях показана КАЖДАЯ возможность,
 *      даже та, что не используется в VIP-логике. Копируй отсюда готовые куски.
 *
 * Копируй этот файл, переименуй, держи шапку-гайд под рукой. Правки подхватываются
 * на лету — перезапускать бота не нужно (панель → 🧩 Модули → «Перезагрузить»).
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────
 * ПОЛНЫЙ СПРАВОЧНИК API МОДУЛЕЙ
 * (каждая функция с примером использования)
 * ─────────────────────────────────────────────
 *
 * 🔹 api.say(текст, {channel})
 *    Написать в чат любого канала бота
 *    await api.say('Привет всем в #krolik_nya!', {channel: 'krolik_nya'})
 *
 * 🔹 api.announce(текст, {color, channel})
 *    Цветное объявление (боевое уведомление)
 *    await api.announce('🚨 Стрим начинается!', {color: 'blue'})
 *
 * 🔹 api.pin(текст, {channel})
 *    Закрепить сообщение на 20 минут
 *    await api.pin('Правила чата: не спамить!')
 *
 * 🔹 api.shoutout(ник, {channel})
 *    Настоящий шатаут Twitch (карточка + Follow)
 *    await api.shoutout('freund_chan')
 *
 * 🔹 api.helix.get(path, query)
 *    ПРЯМОЙ доступ к любому Twitch API
 *    Примеры:
 *    const user = await api.helix.get('/users', {login: 'ник'})                    // найти юзера
 *    const stream = await api.helix.get('/streams', {user_login: 'канал'})        // инфо о стриме
 *    const vips = await api.helix.get('/channels/vips', {broadcaster_id: id})      // список VIP
 *    const mods = await api.helix.get('/moderation/moderators', {broadcaster_id: id}) // список модов
 *    const chatters = await api.helix.get('/chat/chatters', {broadcaster_id: id, first: 100}) // кто в чате
 *
 * 🔹 api.helix.post(path, body)
 *    Создать что-то новое (таймауты, шёпоты, объявления)
 *    await api.helix.post('/moderation/bans', {data: [{user_id: uid, reason: 'спам', duration: 600}]}) // таймаут 10 мин
 *
 * 🔹 api.helix.del(path, query)
 *    Удалить/снять что-то
 *    await api.helix.del('/channels/vips', {broadcaster_id: id, user_id: uid}) // снять VIP
 *    await api.helix.del('/moderation/bans', {broadcaster_id: id, user_id: uid}) // разбан
 *
 * 🔹 api.broadcaster.helix.get/post/del(...)
 *    Те же методы, но с токеном СТРИМЕРА («Вход как стример» в панели —
 *    нужен для наград канала и всего, что Twitch разрешает только владельцу).
 *    Если стример не залогинен — методы возвращают { error: 'стример не залогинен' }.
 *    const rewards = await api.broadcaster.helix.get('/channel_points/custom_rewards', {broadcaster_id: id})
 *
 * 🔹 api.store.get(key, default) / api.store.set(key, value)
 *    Персистентное хранилище (переживает рестарт бота, файл data/module-store/<имя>.json)
 *    api.store.set('visits', (api.store.get('visits', 0) || 0) + 1)
 *    также: api.store.delete(key) — удалить ключ, api.store.all() — копия всего,
 *           api.store.save() — принудительно записать на диск прямо сейчас
 *
 * 🔹 api.fetch(url, opts)
 *    HTTP-запросы к внешним API (через прокси, если включен в настройках)
 *    Возвращает { status, body } — body это строка (при необходимости JSON.parse)
 *    const joke = JSON.parse((await api.fetch('https://official-joke-api.appspot.com/random_joke')).body)
 *    await api.say(`😂 ${joke.setup} — ${joke.punchline}`)
 *
 * 🔹 api.obs.setScene(name) / api.obs.getScenes() / api.obs.toggleSource(...)
 *    Управление OBS из модуля (obs-websocket 5)
 *    await api.obs.setScene('BRB')                        // переключить сцену → true | {error}
 *    const scenes = await api.obs.getScenes()             // { scenes: [...], current: '...' }
 *    await api.obs.toggleSource('Overlay', 'Webcam', false) // выключить вебку в сцене
 *    Если OBS не подключён — вместо данных придёт { error: 'OBS не подключён' }
 *
 * 🔹 api.overlay.push(payload)
 *    Кинуть что угодно в оверлей (SSE-шина, страница /overlay в OBS)
 *    api.overlay.push({kind: 'meme', text: '🎉 Событие!', sound: 'hype.mp3'})
 *    api.overlay.push({kind: 'wheel', text: '🎡 Кто-то крутил колесо'})
 *
 * 🔹 api.setInterval(fn, ms) / api.setTimeout(fn, ms)
 *    Таймеры, авто-очищаются при остановке модуля — обычные setInterval тут запрещены
 *    api.setInterval(() => { api.log('тик') }, 60_000)   // раз в минуту
 *    api.setTimeout(() => { api.say('⏱ Время вышло!') }, 10_000) // через 10 сек
 *
 * 🔹 api.state.counters / api.state.running
 *    Счётчики бота и статус подключения
 *    const total = api.state.counters.messagesSeen // сколько сообщений видел бот
 *    if (api.state.running) { /* бот подключён к Twitch *\/ }
 *
 * 🔹 api.channels()
 *    Все каналы бота: [{id, login, displayName}]
 *    for (const ch of api.channels()) { await api.say(`Привет #${ch.login}!`, {channel: ch.login}) }
 *
 * 🔹 api.channel
 *    Логин канала, в котором случилось событие (у хуков; null вне контекста)
 *
 * 🔹 api.settings / api.saveSettings()
 *    Настройки модуля из панели (объект) и их принудительное сохранение
 *    const days = Number(api.settings.inactiveDays) || 7
 *    api.saveSettings()
 *
 * 🔹 api.log(text, level)
 *    Записать в системный лог панели (лента ⚙︎ на дашборде)
 *    api.log('что-то произошло')
 *    api.log('ошибка!', 'error')
 *
 * 🔹 api.stop()
 *    Остановить сам модуль (после этого модуль выключен в панели)
 *    api.stop()
 *
 * ─────────────────────────────────────────────
 * СОБЫТИЯ (events) — какие хуки доступны:
 *
 * 'chat.message'      — каждое сообщение чата (return false = перехватить и заблокировать!)
 * 'chat.notification' — уведомление чата (саб/рейд и т.п.)
 * 'follow'            — новый фоллоу
 * 'raid'              — рейд
 * 'sub' / 'resub' / 'subgift' — подписки
 * 'stream.online' / 'stream.offline' — стрим начался/кончился
 * 'redemption'        — покупка награды канала (Channel Points)
 * 'tick'              — каждые 20 секунд (пока бот запущен)
 *
 * ─────────────────────────────────────────────
 * КОМАНДЫ (commands) — три типа:
 *
 * 1. Строка (простой ответ, шаблонные переменные {user}, {target}, {args}...):
 *    commands: { 'факт': 'Котики мурчат 🐱' }
 *
 * 2. Async-функция (полная логика, весь API):
 *    commands: {
 *      'погода': async (session, args, api) => {
 *        const data = JSON.parse((await api.fetch('https://api.openweathermap.org/data/2.5/weather?q=' + args[0])).body);
 *        await api.say(`🌡 ${data.main.temp}°C в ${args[0]}`);
 *      },
 *    }
 *    На функцию можно повесить метаданные: myFn.level = 'mod'; myFn.cooldown = 30;
 *
 * 3. Объект (фан-команда с roll/вариантами — как в панели):
 *    commands: {
 *      'хорни': {
 *        mode: 'roll', rollMin: 0, rollMax: 100, cooldown: 5, level: 'everyone',
 *        response: '{user} хорни на {roll}%',
 *        ranges: [{from: 90, to: 100, text: '{user} хорни на {roll}% — слишком хорни 🔥'}],
 *      },
 *    }
 *
 * Кастомные команды из панели ВСЕГДА сильнее модульных (при конфликте имён).
 *
 * ─────────────────────────────────────────────
 * LIFECYCLE:
 *
 * async start(api) — при загрузке и включении (регистрация таймеров, инициализация)
 * async stop(api)  — при остановке (обязан: api.store.save(), управляемые таймеры
 *                    чистятся сами, но свои внешние соединения закрой сам)
 * ─────────────────────────────────────────────
 */

/**
 * Точка зрения throttling-сканера: держим в closure модуля (замыкании файла).
 * При hot-reload файл импортируется заново → значение сбрасывается — это ок.
 */
let _lastScanAt = 0; // когда последний раз сканировали VIP-списки (0 = ещё никогда)

export default {
  // ── имя и описание для панели («🧩 Модули») ────────────────────────────────
  name: 'vip-activity',
  description: 'снимает VIP-статус с неактивных (dryRun по умолчанию) — справочник API в комментариях',

  // ── настройки: правятся из панели, модуль читает их живьём через api.settings ──
  settings: {
    inactiveDays: 7,   // сколько дней не писать в чат = «неактивен»
    dryRun: true,      // true = только предупреждать в лог, VIP не снимать (БЕЗОПАСНЫЙ дефолт)
    scanMinutes: 15,   // как часто ходить в Twitch за списком VIP (не чаще раза в N минут)
  },

  // ── lifecycle: бот загрузил/включил модуль ─────────────────────────────────
  async start(api) {
    // api.log — строка в системной ленте панели ⚙︎ (уровни: info/warn/error)
    api.log('vip-activity: запущен');
  },

  // ── события ────────────────────────────────────────────────────────────────
  events: {
    // каждое сообщение чата: запоминаем, когда юзер писал в последний раз.
    // ключ — Twitch ID юзера (не меняет ник): `last:<user_id>` → timestamp.
    'chat.message': async (m, api) => {
      api.store.set(`last:${m.chatter_user_id}`, Date.now());
    },

    // тик раз в 20 секунд: проверяем VIP-списки всех каналов бота
    'tick': async (_, api) => {
      if (!api.state.running) return; // бот не подключён к Twitch — пропускаем тик

      // свой throttle: не чаще раза в scanMinutes минут (0 = каждый тик)
      const minutes = Number(api.settings.scanMinutes);
      if (minutes > 0 && Date.now() - _lastScanAt < minutes * 60_000) return;
      _lastScanAt = Date.now();

      const days = Number(api.settings.inactiveDays) || 7; // порог неактивности
      const cutoff = Date.now() - days * 86_400_000; // всё, что раньше = неактивен

      // api.channels() — все каналы, где бот работает: [{id, login, displayName}]
      for (const ch of api.channels()) {
        try {
          // прямой Helix-запрос: GET /channels/vips (нужны скоупы channel:*:vips
          // и повторный вход бота, если токен старый)
          const vips = await api.helix.get('/channels/vips', { broadcaster_id: ch.id, first: 100 });
          for (const v of vips?.data ?? []) {
            // когда этот VIP последний раз писал в чат? (0 = никогда)
            const last = api.store.get(`last:${v.user_id}`, 0);
            if (last < cutoff) {
              const name = v.user_name || v.user_login;
              if (api.settings.dryRun) {
                // сухой режим: ничего не делаем, только предупреждаем в лог панели
                api.log(`⚠️ ${name} неактивен ${days}+ дней (dryRun — не снимаю)`);
              } else {
                // боевой режим: снимаем VIP + алерт в оверлей + отметка в лог
                await api.helix.del('/channels/vips', { broadcaster_id: ch.id, user_id: v.user_id });
                api.overlay.push({ kind: 'meme', text: `💔 ${name} потерял VIP: неактивен ${days}+ дней` });
                api.log(`VIP снят: ${name}`);
              }
            }
          }
        } catch (e) {
          // ошибка одного канала не должна ронять весь скан
          api.log(`vip-activity: ${e.message}`);
        }
      }
    },
  },

  // ── lifecycle: бот выключает/перезагружает модуль ─────────────────────────
  async stop(api) {
    // сохраняем хранилище сразу — не ждём debounce
    api.store.save();
  },
};
