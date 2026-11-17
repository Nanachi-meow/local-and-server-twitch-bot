import { AuthManager, SCOPES } from './twitch/auth.js';
import { BroadcasterAuth, BROADCASTER_SCOPES } from './twitch/broadcaster-auth.js';
import { Helix, HelixError } from './twitch/helix.js';
import { EventSocket } from './twitch/eventsub.js';
import { CommandEngine, LEVELS, loadSettings, mergeTts, mergeEventList } from './bot/commands.js';
import { EventProcessor } from './bot/events.js';
import { TimerRunner } from './bot/timers.js';
import { ModuleManager } from './bot/modules.js';
import { QuotesManager } from './bot/quotes.js';
import { ObsClient } from './bot/obs.js';
import { LiveTracker } from './bot/live.js';
import { SongsManager } from './bot/songs.js';
import { RedemptionRouter } from './bot/redemptions.js';
import { overlay } from './bot/alerts.js';
import { createHttpServer } from './server.js';
import { logs } from './logs.js';
import {
  loadConfig, saveConfig, isConfigured, effectivePort,
} from './config.js';
import { SETTINGS_FILE, saveJson } from './store.js';
import { createRequire } from 'node:module';

// версия — единственный источник правды package.json (его же читает апдейтер и GitHub)
const VERSION = createRequire(import.meta.url)('../package.json').version;

const state = {
  startedAt: Date.now(),
  running: false,
  lastError: null,
  broadcasterId: null,
  broadcasterName: null,
  channels: [],
  counters: { messagesSeen: 0, commandsRun: 0, follow: 0, raid: 0, sub: 0 },
};

const config = loadConfig();
const settings = loadSettings();
const port = effectivePort(config);

const auth = new AuthManager({ clientId: config.clientId, clientSecret: config.clientSecret });
const helix = new Helix({ auth });
// Второй вход — «Вход как стример»: события наград канала Twitch отдаёт
// только токену владельца канала, токену бота-модератора они недоступны.
const broadcaster = new BroadcasterAuth({ clientId: config.clientId, clientSecret: config.clientSecret });
const helixBc = new Helix({ auth: broadcaster }); // EventSub-подписки токеном стримера

/** Реестр каналов, где бот работает. Ключ — id канала на Twitch. */
const channels = {
  _map: new Map(),
  set(list) {
    this._map.clear();
    for (const c of list) this._map.set(String(c.id), { id: c.id, login: c.login, displayName: c.displayName });
  },
  get(id) { return this._map.get(String(id)) ?? null; },
  loginOf(id) { return this._map.get(String(id))?.login ?? null; },
  list() { return [...this._map.values()]; },
  byLogin(login) {
    const key = String(login || '').toLowerCase();
    return this.list().find((c) => c.login === key) ?? null;
  },
};

const commands = new CommandEngine({ helix, auth, logs, settings, state, channels });
const processor = new EventProcessor({ helix, auth, logs, settings, state, channels });
commands.setChannels(channels);
processor.setChannels(channels);
processor.setCommands(commands);

// автоопределение начала/конца стрима: EventSub мгновенно + страховочная сверка с Helix
const live = new LiveTracker({ helix, channels, logs, pollMs: 60_000 });
processor.setLive(live);

const timers = new TimerRunner({ helix, auth, logs, settings, channels });

// OBS раньше модулей: api.obs у плагинов должен быть живым уже на их start()
const obs = new ObsClient({ logs, settings });
commands.setObs(obs);
if (settings.obs?.enabled) obs.start(); // подключение к OBS при настроенном включении

// Модули — полноправные плагины: им видны Helix (бота и стримера), хранилище,
// OBS, оверлей, managed-таймеры и состояние бота.
const modules = new ModuleManager({
  helix,
  auth,
  logs,
  channels,
  settings,           // api.fetch → settings.proxy
  state,              // api.state (счётчики, running)
  obs,                // api.obs
  broadcasterAuth: broadcaster,  // «Вход как стример» — api.broadcaster.helix
  broadcasterHelix: helixBc,     // Helix-клиент с токеном стримера
});
commands.setModules(modules);
await modules.load(); // файлы из modules/ — до старта сервера (lifecycle start)
modules.start(); // тик 'tick' каждые 20с + автоподхват правок файлов

const songs = new SongsManager({ logs, settings });
commands.setSongs(songs);

// награды канала Twitch: приходят по EventSub, роутер пишет их в ленту
// и (для замапленных наград) кидает алерт в оверлей
const redemptions = new RedemptionRouter({ logs, settings });

const quotes = new QuotesManager({ logs }); // цитаты канала: data/quotes.json, без таймеров
commands.setQuotes(quotes);

// Единственный конвейер событий EventSub — общий для обоих сокетов
// (модули → таймеры → награды → процессор), различается лишь источник.
const onSubEvent = async (type, event) => {
  // модули видят событие первыми: хук chat.message может вернуть false — и заблокировать его
  const passed = await modules.dispatch(type, event).catch(() => true);
  if (passed === false) return; // перехвачено модулем
  if (type === 'channel.chat.message') {
    timers.noteChat(event); // счётчик для таймеров
  }
  if (type === 'channel.channel_points_custom_reward_redemption.add') {
    const r = redemptions.handle(event); // награды канала: лента + оверлей
    await onSongRedemption(event).catch((e) => {
      logSystem(`Заказ музыки наградой: сбой — ${e.message}`, 'error');
    });
    void r;
  }
  processor.dispatch(type, event);
};

/**
 * Заказ музыки через награду канала (settings.songs.requestMode === 'reward').
 * Заказ не прошёл (чс/лимиты/доступ) — редемпция отменяется, Twitch возвращает баллы.
 * Нужен токен стримера со скоупом channel:manage:redemptions (иначе вернётся 403 — просто запишем в лог).
 */
async function onSongRedemption(event) {
  const scfg = settings.songs ?? {};
  if (scfg.requestMode !== 'reward') return;
  const wanted = String(scfg.rewardName ?? '').trim().toLowerCase();
  const evReward = String(event?.reward?.title ?? event?.reward_name ?? '').trim().toLowerCase();
  if (!wanted || evReward !== wanted) return;

  const login = String(event?.user_login ?? '').toLowerCase();
  const byName = String(event?.user_name ?? '') || login;
  const broadcasterId = String(event?.broadcaster_user_id ?? '');
  const sayToChat = async (text) => {
    if (!broadcasterId || !auth.tokens?.userId) return;
    try {
      await helix.sendMessage({ broadcasterId, senderId: auth.tokens.userId, text: `@${login}, ${text}`.slice(0, 480) });
    } catch { /* чат недоступен — молча; главное — очередь и возврат */ }
  };

  const { parseVideoId, requestAllowed, cancelRedemption } = await import('./bot/songs.js');
  const videoId = parseVideoId(String(event?.user_input ?? ''));
  if (!videoId) {
    await sayToChat('пришли ссылку YouTube в поле ввода награды 🎵');
    await refund();
    return;
  }
  // доступ: у редемпции нет бейджей — проверяем личный список/фолловеров; остальное пускает баллы
  const gate = await requestAllowed(scfg, { level: 'everyone', login, userId: event?.user_id, broadcasterId, helix });
  if (!gate.ok) {
    await sayToChat('заказывать музыку пока нельзя — спроси у стримера');
    await refund();
    return;
  }
  const left = songs.orderCooldownLeft(login);
  if (left > 0) {
    await sayToChat(`следующий заказ через ${left} сек ⏳`);
    await refund();
    return;
  }
  const r = await songs.add({ videoId, by: login, byName });
  if (r.error) {
    await sayToChat(r.error);
    await refund();
    return;
  }
  const pos = r.position === 0 ? 'включаю сейчас! 🎵' : `в очереди на ${r.position}-м месте`;
  await sayToChat(`🎵 ${r.song.title} — ${pos}`.slice(0, 400));

  async function refund() {
    const rewardId = event?.reward?.id ?? event?.reward_id;
    const redemptionId = event?.id;
    if (!rewardId || !redemptionId) return;
    try {
      const res = await cancelRedemption({ broadcasterId, rewardId, redemptionId, helix: helixBc });
      if (res.ok) logSystem(`Награда «${evReward}» отменена — баллы возвращены @${login}`, 'info');
    } catch (e) {
      logSystem(`Возврат баллов не удался (@${login}): ${e.message} — нужен перевход стримера (скоуп channel:manage:redemptions)`, 'warn');
    }
  }
}

// Подписки токена бота: чат, уведомления, фоллоу, рейды, старт/конец стрима.
const socket = new EventSocket({
  helix,
  onEvent: onSubEvent,
  onLog: (message, level) => logs.system.push({ level, message }),
});

// Подписки токена СТРИМЕРА (награды канала) — Twitch запрещает держать
// подписки разных пользователей на одном websocket-соединении, поэтому
// сокет стримера отдельный. Создаётся только при входе стримера
// (в startRuntime), когда есть что подписывать.
let broadcasterSocket = null;

function logSystem(message, level = 'info') {
  logs.system.push({ level, message });
  console.log(`[${level}] ${message}`);
}

async function startRuntime() {
  const cfg = loadConfig();
  auth.updateClient(cfg);
  if (!isConfigured(cfg)) {
    state.lastError = 'Не заполнены настройки (каналы и приложение Twitch)';
    return;
  }
  auth.load();
  if (!auth.tokens) {
    state.lastError = 'Бот не авторизован — войдите через панель';
    logSystem(state.lastError, 'warn');
    return;
  }
  broadcaster.updateClient(cfg);
  broadcaster.load(); // вход стримера — опциональный (нужен только для наград канала)
  try {
    await auth.validate();
    const botId = auth.tokens.userId;
    if (cfg.channels.includes(String(auth.tokens.login || '').toLowerCase())) {
      logSystem('В списке каналов значится аккаунт самого бота — добавь именно свой канал (и другие, где бот модератор)', 'warn');
    }
    const found = [];
    const missing = [];
    for (const login of cfg.channels) {
      const u = await helix.getUserByLogin(login);
      if (u) found.push({ id: u.id, login: u.login, displayName: u.display_name });
      else missing.push(login);
    }
    if (!found.length) throw new Error(`Каналы не найдены на Twitch: ${missing.join(', ')}`);
    if (missing.length) logSystem(`Не нашлись каналы: ${missing.join(', ')} — проверь написание`, 'warn');

    channels.set(found);
    state.channels = channels.list();
    const first = channels.list()[0];
    state.broadcasterId = first.id; // главный канал (по умолчанию для панели)
    state.broadcasterName = first.displayName;
    commands.setChannels(channels);
    processor.setChannels(channels);

    const desired = [];
    for (const c of channels.list()) {
      desired.push({ key: `чат @${c.login}`, type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: c.id, user_id: botId } });
      desired.push({ key: `уведомления @${c.login}`, type: 'channel.chat.notification', version: '1', condition: { broadcaster_user_id: c.id, user_id: botId } });
      desired.push({ key: `фоллоу @${c.login}`, type: 'channel.follow', version: '2', condition: { broadcaster_user_id: c.id, moderator_user_id: botId } });
      desired.push({ key: `рейды @${c.login}`, type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: c.id } });
      desired.push({ key: `старт стрима @${c.login}`, type: 'stream.online', version: '1', condition: { broadcaster_user_id: c.id } });
      desired.push({ key: `конец стрима @${c.login}`, type: 'stream.offline', version: '1', condition: { broadcaster_user_id: c.id } });
    }
    // награды канала (Channel Points): Twitch создаёт такую подписку только
    // токену ВЛАДЕЛЬЦА канала и запрещает подписки разных пользователей на
    // одном websocket-соединении — поэтому это ОТДЕЛЬНЫЙ сокет, все подписки
    // токеном «Входа как стример». Подписываем те каналы, которые принадлежат
    // залогиненному стримеру, только когда награды включены.
    const desiredBroadcaster = [];
    if (broadcaster.tokens?.userId && redemptions.cfg().enabled) {
      const bcId = String(broadcaster.tokens.userId);
      let rewardsMatched = 0;
      for (const c of channels.list()) {
        if (String(c.id) !== bcId) continue;
        rewardsMatched += 1;
        desiredBroadcaster.push({
          key: `награды @${c.login}`,
          type: 'channel.channel_points_custom_reward_redemption.add',
          version: '1',
          condition: { broadcaster_user_id: c.id, user_id: bcId },
        });
      }
      if (!rewardsMatched) {
        logSystem('Стример залогинен, но его канал не в списке каналов бота — подписка на награды не создана', 'warn');
      }
    }
    socket.setDesired(desired);
    await socket.stop();
    await broadcasterSocket?.stop();
    broadcasterSocket = desiredBroadcaster.length
      ? new EventSocket({
        helix: helixBc, // ВСЕ подписки этого сокета — токеном стримера
        onEvent: onSubEvent,
        onLog: (message, level) => logs.system.push({ level, message: `[награды] ${message}` }),
      })
      : null;
    if (broadcasterSocket) broadcasterSocket.setDesired(desiredBroadcaster);
    state.running = true;
    state.lastError = null;
    if (broadcasterSocket) await broadcasterSocket.start();
    await socket.start();
    timers.touchAll(); // после запуска таймеры стреляют только по полному интервалу
    logSystem(`Бот ${auth.tokens.login} подключается к каналам: ${channels.list().map((c) => c.login).join(', ')}`, 'info');

    // эфир: первичная сверка (тихая — бот мог подняться посреди стрима) + страховочный поллинг раз в минуту
    await live.sync({ quiet: true }).catch(() => {});
    live.start();

    // если бот стартовал прямо во время стрима — обновим автозакреп там, где закрепа нет
    if (settings.autoPin?.enabled) {
      for (const c of channels.list()) {
        try {
          const live = await helix.getStreamByLogin(c.login);
          if (!live) continue;
          const pinned = await helix.getPinned({ broadcasterId: c.id, moderatorId: auth.tokens.userId });
          if (!pinned?.message_id) {
            await processor.autoPin(c.id);
            logSystem(`Стрим #${c.login} уже идёт — автозакреп обновлён`, 'info');
          }
        } catch {}
      }
    }
  } catch (e) {
    state.running = false;
    state.lastError = e.message;
    logSystem(`Не удалось запустить: ${e.message}`, 'error');
  }
}

async function stopRuntime() {
  state.running = false;
  live.stop(); // ссвечка эфира гаснет вместе с рантаймом
  await broadcasterSocket?.stop(); // сокет стримера гасим первым
  await socket.stop();
}

async function onConfigSaved(patch = {}) {
  const before = loadConfig();
  // пустые поля не затирают уже сохранённые значения
  for (const key of ['channel', 'clientId', 'clientSecret', 'port']) {
    if (patch[key] === '' || patch[key] === undefined || patch[key] === null) delete patch[key];
  }
  // пустой список каналов не должен обнулять настройку (панель не даст, но и сервер застрахуемся)
  if (Array.isArray(patch.channels) && patch.channels.length === 0) delete patch.channels;
  const next = saveConfig(patch);
  const clientIdChanged = Boolean(patch.clientId) && patch.clientId !== before.clientId;
  if (clientIdChanged) {
    auth.logout();
    broadcaster.logout(); // токены обоих входов привязаны к приложению
    logSystem('Client ID изменился — старые токены сброшены, нужен новый вход', 'warn');
  }
  logSystem(`Настройки сохранены (каналы: ${next.channels.join(', ') || '—'})`, 'info');
  await stopRuntime();
  await startRuntime();
  // смена порта требует перезапуска
  if (patch.port !== undefined && Number(patch.port) !== before.port) {
    logSystem('Порт панели изменился — перезапусти бота (Ctrl+C → npm start), чтобы он применился', 'warn');
  }
}

// ---------------- API уровня приложения ----------------

const app = {
  port,
  version: VERSION,
  auth,
  broadcaster,
  helix,
  commands,
  processor,
  modules,
  quotes,
  redemptions,
  obs,
  songs,
  socket,
  get broadcasterSocket() { return broadcasterSocket; }, // сокет наград (создаётся при входе стримера)
  logs,
  settings,
  state,
  isConfigured: () => isConfigured(loadConfig()),
  startRuntime,
  stopRuntime,
  onConfigSaved,
  logSystem,

  apiState() {
    const cfg = loadConfig();
    return {
      version: VERSION,
      startedAt: state.startedAt,
      port: effectivePort(cfg),
      now: Date.now(),
      configured: isConfigured(cfg),
      channelsConfigured: cfg.channels.length > 0,
      config: {
        channels: cfg.channels,
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret ? 'сохранён' : '',
      },
      auth: {
        status: auth.status,
        login: auth.tokens?.login ?? null,
        userId: auth.tokens?.userId ?? null,
        expiresAt: auth.tokens?.expiresAt ?? null,
        scopes: auth.tokens?.scopes ?? [],
        scopesRequired: SCOPES,
      },
      broadcaster: {
        status: broadcaster.status,
        login: broadcaster.tokens?.login ?? null,
        userId: broadcaster.tokens?.userId ?? null,
        expiresAt: broadcaster.tokens?.expiresAt ?? null,
        scopes: broadcaster.tokens?.scopes ?? [],
        scopesRequired: BROADCASTER_SCOPES,
      },
      runtime: {
        running: state.running,
        lastError: state.lastError,
        broadcasterId: state.broadcasterId,
        broadcasterName: state.broadcasterName,
        channels: state.channels.map((c) => c.login),
        eventsub: { ...socket.status(), broadcaster: broadcasterSocket?.status() ?? null },
      },
      // автоопределение эфира: { [канал]: { live, startedAt, durationMs, title, game } }
      live: live.snapshot(),
      counters: state.counters,
    };
  },

  saveSettings(patch = {}) {
    // встроенные команды: вкл/выкл (панель шлёт полный список выключенных имён)
    if (patch.builtins && typeof patch.builtins === 'object') {
      const known = new Set(Object.keys(commands.builtins));
      settings.builtins ??= { disabled: [] };
      settings.builtins.disabled ??= [];
      settings.builtins.access ??= {};
      if (Array.isArray(patch.builtins.disabled)) {
        settings.builtins.disabled = patch.builtins.disabled
          .map((n) => String(n || '').toLowerCase().replace(/^!/, ''))
          .filter((n) => known.has(n));
      }
      // доступ встроенных: { [имя]: { level?, allow: [роли] } } — мержим по одной команде
      if (patch.builtins.access && typeof patch.builtins.access === 'object') {
        for (const [rawName, cfg] of Object.entries(patch.builtins.access)) {
          const key = String(rawName).toLowerCase().replace(/^!/, '');
          if (!known.has(key) || !cfg || typeof cfg !== 'object') continue;
          const next = { ...(settings.builtins.access[key] ?? {}) };
          if (cfg.level !== undefined) {
            if (LEVELS[cfg.level] !== undefined) next.level = cfg.level;
            else if (cfg.level === null || cfg.level === '') delete next.level;
          }
          if (Array.isArray(cfg.allow)) {
            next.allow = [...new Set(cfg.allow
              .map((r) => String(r).toLowerCase())
              .filter((r) => LEVELS[r] !== undefined && r !== 'broadcaster'))]; // стример может всегда — в список не пишем
          }
          settings.builtins.access[key] = next;
        }
      }
    }
    // события
    if (patch.events && typeof patch.events === 'object') {
      for (const [kind, cfg] of Object.entries(patch.events)) {
        if (!settings.events[kind]) continue;
        if (cfg.enabled !== undefined) settings.events[kind].enabled = Boolean(cfg.enabled);
        if (cfg.mode !== undefined) settings.events[kind].mode = ['chat', 'announce'].includes(cfg.mode) ? cfg.mode : 'chat';
        if (cfg.color !== undefined) settings.events[kind].color = ['primary', 'blue', 'green', 'orange', 'purple'].includes(cfg.color) ? cfg.color : 'purple';
        if (cfg.pin !== undefined) settings.events[kind].pin = Boolean(cfg.pin);
        if (cfg.template !== undefined) settings.events[kind].template = String(cfg.template).slice(0, 400);
      }
    }
    if (patch.so?.template !== undefined) settings.so.template = String(patch.so.template).slice(0, 400);
    if (patch.announceColor !== undefined && ['primary', 'blue', 'green', 'orange', 'purple'].includes(patch.announceColor)) {
      settings.announceColor = patch.announceColor;
    }
    // автозакреп
    if (patch.autoPin && typeof patch.autoPin === 'object') {
      const a = patch.autoPin;
      const cur = settings.autoPin;
      if (a.enabled !== undefined) cur.enabled = Boolean(a.enabled);
      if (a.mode !== undefined) cur.mode = ['stream', '20'].includes(a.mode) ? a.mode : 'stream';
      if (a.template !== undefined) cur.template = String(a.template).slice(0, 400);
    }
    // автошатауты
    if (patch.autoShoutouts && typeof patch.autoShoutouts === 'object') {
      const a = patch.autoShoutouts;
      const cur = settings.autoShoutouts;
      if (a.enabled !== undefined) cur.enabled = Boolean(a.enabled);
      if (a.cooldownMinutes !== undefined) cur.cooldownMinutes = Math.max(1, Math.min(1440, Number(a.cooldownMinutes) || 240));
      if (a.defaultTemplate !== undefined) cur.defaultTemplate = String(a.defaultTemplate).slice(0, 400);
      if (Array.isArray(a.users)) {
        const seen = new Set();
        cur.users = a.users
          .slice(0, 50)
          .map((u) => ({
            login: String(u?.login || '').trim().toLowerCase().replace(/^@/, '').slice(0, 40),
            text: String(u?.text || '').trim().slice(0, 400),
          }))
          .filter((u) => u.login && !seen.has(u.login) && seen.add(u.login));
      }
    }
    // таймеры (периодические сообщения)
    if (patch.timers && typeof patch.timers === 'object') {
      const a = patch.timers;
      const cur = settings.timers;
      if (a.enabled !== undefined) cur.enabled = Boolean(a.enabled);
      if (a.onlyWhenLive !== undefined) cur.onlyWhenLive = Boolean(a.onlyWhenLive);
      if (Array.isArray(a.items)) {
        cur.items = a.items
          .slice(0, 30)
          .map((t, i) => ({
            id: String(t?.id || `t${Date.now()}-${i}`),
            name: String(t?.name || '').trim().slice(0, 40),
            text: String(t?.text || '').trim().slice(0, 400),
            intervalMinutes: Math.max(1, Math.min(720, Number(t?.intervalMinutes) || 5)),
            minMessages: Math.max(1, Math.min(1000, Number(t?.minMessages) || 5)),
            mode: ['time', 'messages', 'and', 'or'].includes(t?.mode) ? t.mode : 'time',
            enabled: t?.enabled !== false,
          }))
          .filter((t) => t.text);
      }
    }
    // алерты оверлея (для OBS)
    if (patch.alerts && typeof patch.alerts === 'object') {
      const a = patch.alerts;
      const cur = settings.alerts;
      if (a.enabled !== undefined) cur.enabled = Boolean(a.enabled);
      for (const kind of ['follow', 'sub', 'resub', 'subgift', 'raid']) {
        const k = a[kind];
        if (!k || typeof k !== 'object' || !cur[kind]) continue;
        if (k.enabled !== undefined) cur[kind].enabled = Boolean(k.enabled);
        if (k.template !== undefined) cur[kind].template = String(k.template).slice(0, 200);
        if (k.sound !== undefined) cur[kind].sound = String(k.sound).replace(/[\\/]/g, '').slice(0, 120);
        if (k.media !== undefined) cur[kind].media = String(k.media).replace(/[\\/]/g, '').slice(0, 120);
        if (k.soundVolume !== undefined) cur[kind].soundVolume = Math.max(0, Math.min(100, Math.round(Number(k.soundVolume) || 0)));
        if (k.duration !== undefined) cur[kind].duration = Math.max(2, Math.min(20, Number(k.duration) || 5));
      }
      // TTS-озвучка оверлея: merge с текущим + нормализация с клампами
      if (a.tts !== undefined) {
        cur.tts = mergeTts(cur.tts, a.tts);
      }
      // список последних событий в углу оверлея (Event List)
      if (a.eventList !== undefined) {
        cur.eventList = mergeEventList(cur.eventList, a.eventList);
      }
    }
    // награды канала (редемпции): таблица мэппингов + кулдаун
    if (patch.redemptions && typeof patch.redemptions === 'object') {
      const a = patch.redemptions;
      const cur = settings.redemptions;
      if (a.enabled !== undefined) cur.enabled = Boolean(a.enabled);
      if (a.cooldown !== undefined) cur.cooldown = Math.max(0, Math.min(3600, Number(a.cooldown) || 30));
      if (Array.isArray(a.mappings)) {
        const seen = new Set();
        cur.mappings = a.mappings
          .slice(0, 50)
          .map((m) => ({
            rewardName: String(m?.rewardName ?? '').trim().slice(0, 100),
            action: ['song', 'meme', 'wheel', 'say', 'command'].includes(m?.action) ? m.action : 'song',
            enabled: m?.enabled !== false,
          }))
          .filter((m) => {
            const key = m.rewardName.toLowerCase();
            if (!key) return false;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
      }
    }
    // OBS (obs-websocket 5)
    if (patch.obs && typeof patch.obs === 'object') {
      const a = patch.obs;
      const cur = settings.obs;
      if (a.enabled !== undefined) cur.enabled = Boolean(a.enabled);
      if (a.host !== undefined) cur.host = String(a.host).trim().slice(0, 100) || '127.0.0.1';
      if (a.port !== undefined) cur.port = Math.max(1, Math.min(65535, Math.round(Number(a.port) || 4455)));
      if (a.password !== undefined) cur.password = String(a.password ?? '').slice(0, 200);
      obs.reconfigure(); // вкл/выкл/смена адреса применяется сразу, без перезапуска
    }
    // музыка: заказы (бесплатные — награды канала разберём отдельной фазой)
    if (patch.songs && typeof patch.songs === 'object') {
      const a = patch.songs;
      const cur = settings.songs;
      if (a.enabled !== undefined) cur.enabled = Boolean(a.enabled);
      if (a.maxLenSec !== undefined) cur.maxLenSec = Math.max(0, Math.min(36_000, Number(a.maxLenSec) || 600));
      if (a.perUser !== undefined) cur.perUser = Math.max(1, Math.min(10, Number(a.perUser) || 2));
      if (a.volume !== undefined) cur.volume = Math.max(0, Math.min(100, Math.round(Number(a.volume) || 0)));
      if (a.nowTemplate !== undefined) cur.nowTemplate = String(a.nowTemplate).slice(0, 200);
      // способ заказов + ограничения + доступ
      if (a.requestMode !== undefined) cur.requestMode = a.requestMode === 'reward' ? 'reward' : 'command';
      if (a.rewardName !== undefined) cur.rewardName = String(a.rewardName).trim().slice(0, 100);
      if (a.commandCooldown !== undefined) cur.commandCooldown = Math.max(0, Math.min(86_400, Math.round(Number(a.commandCooldown) || 0)));
      if (a.minViews !== undefined) cur.minViews = Math.max(0, Math.min(1_000_000_000, Math.round(Number(a.minViews) || 0)));
      if (Array.isArray(a.allow)) {
        cur.allow = [...new Set(a.allow.map((r) => String(r).toLowerCase()))]
          .filter((r) => ['everyone', 'sub', 'vip', 'follower', 'mod', 'broadcaster'].includes(r));
      }
      if (Array.isArray(a.allowUsers)) {
        cur.allowUsers = [...new Set(a.allowUsers.map((u) => String(u).toLowerCase().trim()).filter(Boolean))].slice(0, 50);
      }
      if (Array.isArray(a.blacklist)) {
        cur.blacklist = a.blacklist
          .map((x) => ({ id: String(x?.id || '').slice(0, 20), title: String(x?.title || '').slice(0, 200) }))
          .filter((x) => x.id)
          .slice(0, 300);
      }
      // раскладка-оверлей OBS-плеера: объекты (видео/строка/подложка/свои картинки)
      // двигаются/масштабируются в редакторе панели; всё в px сцены 1920×1080
      if (a.playerCfg !== undefined && a.playerCfg !== null && typeof a.playerCfg === 'object') {
        const curCfg = cur.playerCfg ??= {};
        const p = a.playerCfg;
        if (p.v !== undefined) curCfg.v = 2;
        if (Array.isArray(p.objects)) {
          const num = (v, min, max, dflt) => {
            const n = Number(v);
            return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : dflt;
          };
          curCfg.objects = p.objects
            .filter((o) => o && ['video', 'marquee', 'backdrop', 'image'].includes(o.type))
            .slice(0, 20)
            .map((o) => {
              const base = {
                id: String(o.id || '').slice(0, 40),
                type: o.type,
                x: num(o.x, -500, 2500, 0),
                y: num(o.y, -500, 2500, 0),
                w: num(o.w, 20, 2500, 400),
                h: num(o.h, 20, 2500, 300),
                opacity: num(o.opacity, 0, 100, 100),
                z: num(o.z, 0, 30, 1),
                hideOnIdle: Boolean(o.hideOnIdle),
                image: String(o.image || '').replace(/[\\/]/g, '').slice(0, 120),
                color: String(o.color || '').slice(0, 20),
                radius: num(o.radius, 0, 120, 0),
                fontSize: num(o.fontSize, 10, 60, 22),
                speed: num(o.speed, 5, 300, 30),
              };
              if (o.type === 'video') base.h = Math.round(base.w * 9 / 16); // форма 16:9 не меняется
              if (o.type === 'marquee') base.h = base.fontSize + 16;
              return base;
            });
        }
      }
      // громкость/шаблон применяем к плееру в OBS сразу — SSE-событие доехает до /music
      try { songs?._emit?.('update'); } catch {}
    }
    // прокси (для запросов к YouTube и подобным)
    if (patch.proxy && typeof patch.proxy === 'object') {
      const a = patch.proxy;
      const cur = settings.proxy;
      if (a.enabled !== undefined) cur.enabled = Boolean(a.enabled);
      if (a.url !== undefined) cur.url = String(a.url).trim().slice(0, 200);
    }
    saveJson(SETTINGS_FILE, settings);
  },

  /** Выход стримера: сброс токена + пересборка подписок (награды канала отпадают). */
  async broadcasterLogout() {
    broadcaster.stopAutoRefresh();
    broadcaster.logout();
    logSystem('Токен стримера сброшен — подписка на награды канала снята', 'warn');
    await stopRuntime();
    await startRuntime();
  },

  async runAction(action, body) {
    const requireRuntime = () => {
      if (!state.running || !auth.tokens?.userId || !channels.list().length) {
        const e = new Error('Бот ещё не подключён — авторизуйся и проверь настройки');
        e.status = 409;
        throw e;
      }
    };
    // канал для действия: выбранный в панели или первый из списка
    const resolveChannel = () => {
      const login = String(body.channel || channels.list()[0].login).toLowerCase();
      const ch = channels.byLogin(login);
      if (!ch) throw new Error(`Канал "${login}" не найден в списке каналов бота`);
      return ch;
    };
    const sessionOf = (ch) => ({
      broadcasterId: ch.id,
      channel: ch.login,
      login: auth.tokens.login,
      displayName: 'Панель',
    });
    switch (action) {
      case 'say': {
        requireRuntime();
        const ch = resolveChannel();
        const text = String(body.text || '').trim();
        if (!text) throw new Error('Пустой текст');
        await helix.sendMessage({ broadcasterId: ch.id, senderId: auth.tokens.userId, text });
        return { sent: text, channel: ch.login };
      }
      case 'announce': {
        requireRuntime();
        const ch = resolveChannel();
        const text = String(body.text || '').trim();
        if (!text) throw new Error('Пустой текст');
        const color = ['primary', 'blue', 'green', 'orange', 'purple'].includes(body.color) ? body.color : 'purple';
        await helix.announce({ broadcasterId: ch.id, moderatorId: auth.tokens.userId, text, color });
        return { sent: text, channel: ch.login };
      }
      case 'so': {
        requireRuntime();
        const ch = resolveChannel();
        const target = String(body.target || '').trim();
        await commands.builtins.so.run(sessionOf(ch), [target]);
        return { sent: target, channel: ch.login };
      }
      case 'pin': {
        requireRuntime();
        const ch = resolveChannel();
        const text = String(body.text || '').trim();
        if (!text) throw new Error('Пустой текст');
        const duration = Number(body.duration) || 0;
        if (duration >= 30) {
          const sent = await helix.sendMessage({ broadcasterId: ch.id, senderId: auth.tokens.userId, text });
          await helix.pinMessage({
            broadcasterId: ch.id,
            moderatorId: auth.tokens.userId,
            messageId: sent.message_id,
            durationSeconds: duration,
          });
        } else {
          await helix.sendMessage({ broadcasterId: ch.id, senderId: auth.tokens.userId, text, pin: true });
        }
        return { sent: text, channel: ch.login };
      }
      case 'unpin': {
        requireRuntime();
        const ch = resolveChannel();
        await commands.builtins.unpin.run(sessionOf(ch), []);
        return {};
      }
      case 'test': {
        requireRuntime();
        const ch = resolveChannel();
        const kind = String(body.kind || '');
        await processor.test(kind, {}, { broadcasterId: ch.id });
        return { tested: kind, channel: ch.login };
      }
      case 'autosotest': {
        requireRuntime();
        const ch = resolveChannel();
        const login = String(body.login || '').trim().replace(/^@/, '').toLowerCase();
        if (!login) throw new Error('Укажи ник');
        const entry = (settings.autoShoutouts?.users ?? []).find((u) => u.login === login)
          ?? { login, text: '' };
        await processor.autoShoutoutFor(ch.id, entry, { force: true });
        return { tested: login, channel: ch.login };
      }
      case 'autopintest': {
        requireRuntime();
        const ch = resolveChannel();
        await processor.autoPin(ch.id);
        return { tested: 'автозакреп', channel: ch.login };
      }
      case 'cmdtest': {
        requireRuntime();
        const ch = resolveChannel();
        const cName = String(body.name || '').toLowerCase().replace(/^!/, '');
        const ran = await commands.handleChatMessage({
          broadcasterId: ch.id,
          userId: '0',
          login: '__panel__',
          displayName: 'Панель',
          text: `!${cName}`,
          badges: [{ set_id: 'moderator' }],
        });
        if (!ran) throw new Error('Команда не найдена, выключена или на кулдауне');
        return { tested: cName, channel: ch.login };
      }
      case 'overlaytest': {
        overlay.push({
          kind: String(body.kind || 'follow'),
          channel: channels.list()[0]?.login ?? null,
          user: 'ТестовыйЗритель',
          viewers: 42,
          months: 12,
          recipient: 'ТестовыйДруг',
        });
        return { tested: body.kind || 'follow' };
      }
      case 'redemptiontest': {
        // тест алерта награды канала (карточка «👑 Награды канала»)
        overlay.push({
          kind: 'redemption',
          channel: channels.list()[0]?.login ?? null,
          user: 'ТестовыйЗритель',
          reward: 'мем',
          text: 'ТестовыйЗритель активировал(а) награду «мем»: тестовое списание',
          input: 'тестовое списание',
          sound: '',
        });
        return { tested: 'redemption' };
      }
      case 'obstest': {
        // значения из формы (если юзер ещё не сохранил) поверх сохранённых
        const cur = settings.obs;
        const host = String(body.host || cur.host || '127.0.0.1').trim() || '127.0.0.1';
        const port = Math.max(1, Math.min(65535, Math.round(Number(body.port) || Number(cur.port) || 4455)));
        const password = String(body.password ?? '') !== '' ? String(body.password) : String(cur.password ?? '');
        // если основной клиент уже подключён этими настройками — просто спросить сцены
        if (obs.status === 'connected' && obs.sameConfig(host, port, password)) {
          const list = await obs.getSceneList();
          return { scenes: list.scenes, current: list.current };
        }
        const probe = new ObsClient({ logs, settings: { obs: { enabled: true, host, port, password } } });
        const list = await probe.test();
        return { scenes: list.scenes, current: list.current };
      }
      case 'modulesreload': {
        await modules.reload();
        return { modules: modules.list().length };
      }
      case 'timertest': {
        requireRuntime();
        await timers.test(String(body.id || ''), body.channel);
        return { tested: body.id };
      }
      case 'srnext': { // скип из панели
        const r = songs.skip();
        if (r.error) throw new Error(r.error);
        return { next: Boolean(r.next) };
      }
      case 'srclear': { // очистить очередь из панели
        return songs.clear();
      }
      case 'srcontrol': { // пауза/прод/стоп из панели
        const r = songs.control(String(body.op || ''));
        if (r.error) throw new Error(r.error);
        return { ok: true };
      }
      case 'proxytest': { // проверка прокси из панели
        const { proxyCheck } = await import('./bot/proxy.js');
        const r = await proxyCheck(settings.proxy);
        return { ok: true, via: settings.proxy.enabled ? 'через прокси' : 'напрямую', sample: r.title };
      }
      default:
        throw new Error(`Неизвестное действие: ${action}`);
    }
  },

  async getPinned(channelLogin) {
    const ch = channelLogin
      ? channels.byLogin(channelLogin)
      : channels.list()[0];
    if (!ch) return null;
    try {
      return await helix.getPinned({ broadcasterId: ch.id, moderatorId: auth.tokens.userId });
    } catch (e) {
      return { error: e.message };
    }
  },

  async followage(userLogin, channelLogin) {
    const target = String(userLogin || '').trim().replace(/^@/, '');
    if (!target) throw new Error('Укажи ник');
    const ch = channelLogin
      ? channels.byLogin(channelLogin)
      : channels.list()[0];
    if (!ch) throw new Error('Канал не найден в списке каналов бота');
    const user = await helix.getUserByLogin(target);
    if (!user) throw new Error(`Пользователь "${target}" не найден`);
    const follower = await helix.getFollower({ broadcasterId: ch.id, userId: user.id });
    return {
      user: user.display_name,
      channel: ch.login,
      following: Boolean(follower),
      followed_at: follower?.followed_at ?? null,
    };
  },

  humanizeError(e) {
    if (e instanceof HelixError) {
      if (e.status === 403) return 'Нет прав: сделай бота модератором канала (/mod имя_бота в своём чате)';
      if (e.status === 429) return 'Twitch просит притормозить (лимит частоты)';
      return `Twitch: ${e.message}`;
    }
    return e.message;
  },
};

// ---------------- запуск ----------------

const server = createHttpServer({ app });
server.listen(port, '127.0.0.1', () => {
  logSystem(`Панель: http://localhost:${port} (только локально)`, 'info');
  if (!isConfigured(config)) {
    logSystem('Конфиг не заполнен — открой панель и пройди мастера настройки', 'warn');
  }
});

if (auth.load()) {
  logSystem(`Найден сохранённый вход: ${auth.tokens.login ?? 'неизвестный пользователь'}`, 'info');
}
if (broadcaster.load()) {
  logSystem(`Найден вход стримера: ${broadcaster.tokens.login ?? 'неизвестный пользователь'} — награды канала будут видны`, 'info');
}
if (isConfigured(config) && auth.tokens) {
  startRuntime().catch((e) => logSystem(`Автозапуск не удался: ${e.message}`, 'error'));
}

// фоновые задачи
timers.start(); // периодические сообщения: тик раз в 20 секунд, без каналов/входа сам молчит
setInterval(() => commands.flushCounters(), 30_000);
setInterval(async () => {
  if (auth.tokens && auth.tokens.expiresAt - Date.now() < 15 * 60_000) {
    try {
      await auth.refresh();
      logSystem('Токен бота обновлён автоматически', 'info');
    } catch (e) {
      logSystem(`Не удалось обновить токен: ${e.message}`, 'error');
    }
  }
}, 5 * 60_000).unref?.();
// автообновление токена стримера — тот же ритм, что у токена бота
broadcaster.autoRefresh((level, message) => logSystem(message, level));

const shutdown = async () => {
  logSystem('Останавливаюсь…', 'info');
  commands.flushCounters();
  timers.stop();
  await modules.stop(); // stop-хуки модулей + сохранение их хранилищ
  quotes.stop();
  obs.stop();
  broadcaster.stopAutoRefresh();
  await broadcasterSocket?.stop(); // сокет стримера гасим первым
  await socket.stop();
  server.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => {
  logSystem(`Необработанная ошибка: ${e?.message ?? e}`, 'error');
});
