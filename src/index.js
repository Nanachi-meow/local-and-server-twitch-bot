import { AuthManager, SCOPES } from './twitch/auth.js';
import { Helix, HelixError } from './twitch/helix.js';
import { EventSocket } from './twitch/eventsub.js';
import { CommandEngine, loadSettings, mergeTts, mergeEventList } from './bot/commands.js';
import { EventProcessor } from './bot/events.js';
import { TimerRunner } from './bot/timers.js';
import { ModuleManager } from './bot/modules.js';
import { PointsManager } from './bot/points.js';
import { QuotesManager } from './bot/quotes.js';
import { BetsManager } from './bot/bets.js';
import { overlay } from './bot/alerts.js';
import { createHttpServer } from './server.js';
import { logs } from './logs.js';
import {
  loadConfig, saveConfig, isConfigured, effectivePort,
} from './config.js';
import { SETTINGS_FILE, saveJson } from './store.js';

const VERSION = '1.0.0';

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

const timers = new TimerRunner({ helix, auth, logs, settings, channels });

const modules = new ModuleManager({ helix, auth, logs, channels });
commands.setModules(modules);
await modules.load(); // файлы из modules/ — до старта сервера
modules.start(); // тик 'tick' каждые 20с + автоподхват правок файлов

const points = new PointsManager({ helix, auth, logs, settings, channels });
commands.setPoints(points);
points.start(); // начисление за просмотр + автосохранение

const quotes = new QuotesManager({ logs }); // цитаты канала: data/quotes.json, без таймеров
commands.setQuotes(quotes);

const bets = new BetsManager({ logs, settings });
commands.setBets(bets);
bets.setPoints(points); // для авто-возвратов по таймауту
bets.start(); // раз в 5 сек закрывает просроченные ставки/дуэли с возвратом баллов

const socket = new EventSocket({
  helix,
  onEvent: (type, event) => {
    if (type === 'channel.chat.message') {
      timers.noteChat(event); // счётчик для таймеров
      points.noteMessage(event?.chatter_user_login, event?.chatter_user_name); // бонус за сообщение
    }
    processor.dispatch(type, event);
    modules.dispatch(type, event).catch(() => {}); // хуки модулей (ошибки логируются внутри)
  },
  onLog: (message, level) => logs.system.push({ level, message }),
});

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
    socket.setDesired(desired);
    await socket.stop();
    state.running = true;
    state.lastError = null;
    await socket.start();
    timers.touchAll(); // после запуска таймеры стреляют только по полному интервалу
    logSystem(`Бот ${auth.tokens.login} подключается к каналам: ${channels.list().map((c) => c.login).join(', ')}`, 'info');

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
  helix,
  commands,
  processor,
  modules,
  points,
  quotes,
  bets,
  socket,
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
      runtime: {
        running: state.running,
        lastError: state.lastError,
        broadcasterId: state.broadcasterId,
        broadcasterName: state.broadcasterName,
        channels: state.channels.map((c) => c.login),
        eventsub: socket.status(),
      },
      counters: state.counters,
    };
  },

  saveSettings(patch = {}) {
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
    // баллы/колесо/мем-магазин
    if (patch.points && typeof patch.points === 'object') {
      const a = patch.points;
      const cur = settings.points;
      if (a.enabled !== undefined) cur.enabled = Boolean(a.enabled);
      if (a.intervalMin !== undefined) {
        cur.intervalMin = Math.max(1, Math.min(60, Number(a.intervalMin) || 10));
        points.rearm(); // критик: интервал применяется сразу, без перезапуска
      }
      if (a.amount !== undefined) cur.amount = Math.max(0, Math.min(1000, Number(a.amount) || 10));
      if (a.perMessage !== undefined) cur.perMessage = Math.max(0, Math.min(10, Number(a.perMessage) || 0));
    }
    if (patch.wheel && typeof patch.wheel === 'object') {
      const a = patch.wheel;
      const cur = settings.wheel;
      if (a.enabled !== undefined) cur.enabled = Boolean(a.enabled);
      if (a.minBet !== undefined) cur.minBet = Math.max(1, Math.min(100_000, Number(a.minBet) || 10));
      if (a.maxBet !== undefined) cur.maxBet = Math.max(cur.minBet, Math.min(1_000_000, Number(a.maxBet) || 1000));
      if (a.cooldown !== undefined) cur.cooldown = Math.max(0, Math.min(3600, Number(a.cooldown) || 60));
      if (Array.isArray(a.items)) {
        cur.items = a.items.slice(0, 20).map((it) => ({
          label: String(it?.label || '').trim().slice(0, 60),
          weight: Math.max(0, Math.min(100, Number(it?.weight) || 0)),
          multiplier: Math.max(0, Math.min(100, Number(it?.multiplier) || 0)),
        })).filter((it) => it.label);
      }
    }
    if (patch.memShop && typeof patch.memShop === 'object') {
      const a = patch.memShop;
      const cur = settings.memShop;
      if (a.enabled !== undefined) cur.enabled = Boolean(a.enabled);
      if (a.cooldown !== undefined) cur.cooldown = Math.max(0, Math.min(3600, Number(a.cooldown) || 0));
      if (Array.isArray(a.items)) {
        cur.items = a.items.slice(0, 30).map((it) => ({
          name: String(it?.name || '').trim().toLowerCase().replace(/^!/, '').slice(0, 32),
          price: Math.max(0, Math.min(1_000_000, Number(it?.price) || 0)),
          text: String(it?.text || '').trim().slice(0, 200),
          sound: String(it?.sound || '').replace(/[\\/]/g, '').slice(0, 120),
          enabled: it?.enabled !== false,
        })).filter((it) => it.name);
      }
    }
    // ставки и дуэли
    if (patch.bets && typeof patch.bets === 'object') {
      const a = patch.bets;
      const cur = settings.bets;
      if (a.enabled !== undefined) cur.enabled = Boolean(a.enabled);
      if (a.fee !== undefined) cur.fee = Math.max(0, Math.min(10, Number(a.fee) || 0));
      if (a.durationSec !== undefined) cur.durationSec = Math.max(10, Math.min(3600, Number(a.durationSec) || 300));
      if (a.minBet !== undefined) cur.minBet = Math.max(1, Math.min(100_000, Number(a.minBet) || 10));
      if (a.maxBet !== undefined) cur.maxBet = Math.max(cur.minBet, Math.min(1_000_000, Number(a.maxBet) || 1000));
      if (a.duelCooldown !== undefined) cur.duelCooldown = Math.max(0, Math.min(3600, Number(a.duelCooldown) || 60));
    }
    saveJson(SETTINGS_FILE, settings);
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
      case 'modulesreload': {
        await modules.reload();
        return { modules: modules.list().length };
      }
      case 'timertest': {
        requireRuntime();
        await timers.test(String(body.id || ''), body.channel);
        return { tested: body.id };
      }
      case 'betsopen': {
        // открытие тотализатора из панели: менеджер + объявление в чат (как у !ставка открыть)
        requireRuntime();
        const ch = resolveChannel();
        const question = String(body.question || '').trim();
        const options = (Array.isArray(body.options) ? body.options : [])
          .map((o) => String(o ?? '').trim()).filter(Boolean);
        if (!question) throw new Error('Нужен вопрос');
        if (options.length < 2) throw new Error('Нужно минимум 2 варианта (раздели их «|»)');
        if (options.length > 6) throw new Error('Максимум 6 вариантов');
        // длительность конкретной ставки: менеджер берёт её из настроек — подменяем
        // на время open() и возвращаем назад (файл настроек не трогаем)
        const wanted = Math.max(10, Math.min(3600, Number(body.durationSec) || 0));
        const prevDur = settings.bets.durationSec;
        if (wanted) settings.bets.durationSec = wanted;
        const opened = bets.open({ channelId: ch.id, question, options });
        settings.bets.durationSec = prevDur;
        if (opened.error) throw new Error(opened.error);
        const cfg = bets.cfg();
        const list = opened.options.map((label, i) => `${i + 1}) ${label}`).join(' ');
        await helix.sendMessage({
          broadcasterId: ch.id,
          senderId: auth.tokens.userId,
          text: `📈 Ставка открыта: «${opened.question}» — ${list}. Ставить: !ставить сумма номер (${cfg.minBet}–${cfg.maxBet}), на всё ${opened.durationSec} сек`.slice(0, 480),
        });
        return { opened: true, question: opened.question, options: opened.options, durationSec: opened.durationSec, channel: ch.login };
      }
      case 'betsresolve': {
        // подведение итога из панели: выплаты/возвраты как у !итог + объявление в чат
        requireRuntime();
        const ch = resolveChannel();
        const idx = Number(body.winnerIndex);
        if (!Number.isInteger(idx) || idx <= 0) throw new Error('Номер победного варианта — целое число от 1');
        const r = bets.resolve({ channelId: ch.id, winnerIndex: idx });
        if (r.error) throw new Error(r.error);
        for (const p of r.payouts) points.add(p.login, p.amount);
        for (const ref of r.refunds ?? []) points.add(ref.login, ref.amount);
        const text = !r.payouts.length
          ? ((r.refunds ?? []).length
            ? `🏁 Исход: «${r.winner}» — ставка закрыта без победителя, баллы возвращены 🙂`
            : `🏁 Исход: «${r.winner}» — ставок не было, банк пуст`)
          : `🏁 Исход: «${r.winner}» — банк ${r.pot}${r.fee ? ` (комиссия ${r.fee}%)` : ''}. Победители: ${(r.top ?? []).slice(0, 3).map((w, i) => `${i + 1}. ${w.name || w.login} +${w.amount}`).join(' · ')} 🎉`;
        await helix.sendMessage({ broadcasterId: ch.id, senderId: auth.tokens.userId, text: text.slice(0, 480) });
        return { resolved: true, winner: r.winner, pot: r.pot, payouts: r.payouts.length, refunds: (r.refunds ?? []).length, channel: ch.login };
      }
      case 'betscancel': {
        // отмена из панели: живая ставка/вызов закрываются как «истёкшие» — все баллы возвращаются
        requireRuntime();
        const ch = resolveChannel();
        const pool = bets.active(ch.id);
        const duel = bets.pendingDuel(ch.id);
        if (!pool && !duel) throw new Error('Сейчас нет открытой ставки (или вызова на дуэль)');
        const refunds = bets.closeExpired(Date.now() + 604_800_000); // все живое считается просроченным и закрывается
        for (const r of refunds) {
          points.add(r.login, r.amount);
          logSystem(`Возврат баллов (отмена из панели): @${r.login} +${r.amount}`);
        }
        await helix.sendMessage({
          broadcasterId: ch.id,
          senderId: auth.tokens.userId,
          text: pool
            ? `❌ Ставка «${pool.question}» отменена — все баллы возвращены 🙂`.slice(0, 480)
            : `⚔️ Дуэль ${duel.from.name || duel.from.login} → @${duel.to} отменена — ставка ${duel.amount} вернулась 🙂`.slice(0, 480),
        });
        return { cancelled: true, refunds: refunds.length, channel: ch.login };
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

const shutdown = async () => {
  logSystem('Останавливаюсь…', 'info');
  commands.flushCounters();
  timers.stop();
  modules.stop();
  bets.stop();
  points.stop();
  quotes.stop();
  await socket.stop();
  server.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => {
  logSystem(`Необработанная ошибка: ${e?.message ?? e}`, 'error');
});
