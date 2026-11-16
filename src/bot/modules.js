import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODULES_DIR, MODULES_CONFIG_FILE, DATA_DIR, loadJson, saveJson } from '../store.js';
import { httpRequest } from './proxy.js';
import { overlay } from './alerts.js';

/** События Twitch → дружелюбные ключи хуков модулей. */
const HOOK_ALIASES = {
  'channel.chat.message': 'chat.message',
  'channel.chat.notification': 'chat.notification',
  'channel.follow': 'follow',
  'channel.raid': 'raid',
  'stream.online': 'stream.online',
  'stream.offline': 'stream.offline',
  'channel.channel_points_custom_reward_redemption.add': 'redemption', // награда канала
};

/** Из chat.notification выводим понятные хуки подписок. */
const NOTICE_HOOKS = { sub: 'sub', resub: 'resub', sub_gift: 'subgift' };

const TICK_MS = 20_000;          // период хука 'tick'
const STORE_DEBOUNCE_MS = 3_000; // автосохранение хранилища модуля (debounce 3 сек)
const LEVEL_NAMES = ['everyone', 'sub', 'vip', 'mod']; // уровни доступа команд-функций

/** Имя модуля → безопасное имя файла хранилища (без слешей/двоеточий и прочей дичи). */
function safeStoreName(name) {
  return String(name || 'mod').replace(/[^a-zA-Z0-9а-яА-ЯёЁ._-]/g, '_').slice(0, 60) || 'mod';
}

/**
 * Модули-плагины: файлы .js в папке modules/. Каждый экспортирует объект —
 * полноправный плагин с доступом ко ВСЕМУ (Helix, хранилище, OBS, оверлей, HTTP):
 *   {
 *     name: 'имя',                   // опционально, дефолт = имя файла
 *     description: 'что делает',
 *     settings: { ключ: значение },  // настройки по умолчанию (панель даёт править)
 *     commands: {                    // команды модуля — три формы:
 *       'факт': '{user}, котики 🐱',                          // строка = простой ответ
 *       'хорни': { mode: 'roll', rollMin: 0, rollMax: 100 },  // объект = полная схема
 *       'профиль': async (session, args, api) => {},          // функция = полный API
 *     },
 *     events: {                     // хуки: async (событие, api) => {}
 *       'chat.message': async (m, api) => {},  // return false = перехватить событие!
 *       'tick': async (_, api) => {},          // раз в 20 секунд
 *     },
 *     async start(api) { ... },  // lifecycle: включение/загрузка
 *     async stop(api) { ... },   // lifecycle: остановка (api.store.save(), чистка)
 *   }
 * Полный справочник API — в ДОКУМЕНТАЦИЯ.md («Модули») и в шапке modules/vip-activity.js.
 * Ошибка в модуле не роняет бота: грузится с ошибкой/логируется, остальные живут.
 * Изменения файлов подхватываются сами (fs.watch + панель кнопкой «Перезагрузить»).
 */
export class ModuleManager {
  constructor({
    dir = MODULES_DIR,
    configFile = MODULES_CONFIG_FILE,
    storeDir = path.join(DATA_DIR, 'module-store'),
    helix = null,
    auth = null,
    logs,
    channels = null,
    settings = null,
    state = null,
    obs = null,
    broadcasterAuth = null,
    broadcasterHelix = null,
  } = {}) {
    this.dir = dir;
    this.configFile = configFile;
    this.storeDir = storeDir;
    this.helix = helix;           // Helix с токеном бота — api.helix
    this.auth = auth;
    this.logs = logs;
    this.channels = channels;
    this.settings = settings;     // живые настройки бота — api.fetch использует settings.proxy
    this.state = state;           // состояние бота — api.state
    this.obs = obs;               // ObsClient — api.obs
    this.broadcasterAuth = broadcasterAuth;   // вход стримера — api.broadcaster.helix
    this.broadcasterHelix = broadcasterHelix; // Helix-клиент с токеном стримера
    this._mods = [];              // { name, file, def, error }
    this._started = new Set();    // имена модулей, чей lifecycle start прошёл
    this._timers = new Map();     // имя модуля → [{ id, kind }] — managed-таймеры
    this._stores = new Map();     // имя модуля → { data, file, timer } — персистентное хранилище
    this._timer = null;
    this._watcher = null;
    this._watchTimer = null;
    this._config = loadJson(this.configFile, null) ?? { enabled: {}, settings: {} };
    if (typeof this._config.enabled !== 'object' || !this._config.enabled) this._config.enabled = {};
    if (typeof this._config.settings !== 'object' || !this._config.settings) this._config.settings = {};
  }

  // ---------------- загрузка ----------------

  async load() {
    // hot-reload: аккуратно гасим прошлую жизнь (stop-хуки, managed-таймеры, сохранение store)
    await this.stopAll();
    this._mods = [];
    if (fs.existsSync(this.dir)) {
      const files = fs.readdirSync(this.dir)
        .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
        .sort();
      for (const file of files) {
        const full = path.join(this.dir, file);
        try {
          // cache-busting: подхватываем правки файла без перезапуска бота
          const url = `${pathToFileURL(full).href}?t=${Date.now()}`;
          const mod = await import(url);
          const def = mod.default ?? mod;
          if (!def || typeof def !== 'object' || Array.isArray(def)) {
            throw new Error('модуль должен экспортировать объект: export default { ... }');
          }
          const name = String(def.name || path.basename(file, '.js')).toLowerCase();
          if (!name) throw new Error('не смогли понять имя модуля');
          this._mods.push({ name, file, def, error: null });
          // дефолтные настройки модуля — под хранёнными
          this._config.settings[name] = { ...(def.settings ?? {}), ...(this._config.settings[name] ?? {}) };
          // хранилище модуля читаем сразу, если файл уже есть
          this._storeFor(name);
        } catch (e) {
          this._mods.push({ name: path.basename(file, '.js'), file, def: null, error: e.message });
        }
      }
    }
    saveJson(this.configFile, this._config);
    // lifecycle: у включённых модулей вызываем start(api)
    for (const { name, def, error } of this._mods) {
      if (!def || error || !this.isEnabled(name)) continue;
      await this._startModule(name);
    }
    return this.list();
  }

  async reload() {
    await this.load();
    this.logs.system.push({ level: 'info', message: `Модули перезагружены: ${this.list().map((m) => m.name).join(', ') || 'пусто'}` });
  }

  start() {
    if (this._timer) return;
    // тик для модулей: каждые 20 секунд хук 'tick' (если объявлен)
    this._timer = setInterval(() => {
      this._fire('tick', { now: Date.now() }).catch(() => {});
    }, TICK_MS);
    try {
      if (fs.existsSync(this.dir)) {
        this._watcher = fs.watch(this.dir, () => {
          clearTimeout(this._watchTimer);
          this._watchTimer = setTimeout(() => { this.reload().catch(() => {}); }, 500);
        });
      }
    } catch {} // watch недоступен — не страшно, есть кнопка в панели
  }

  async stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    clearTimeout(this._watchTimer);
    try { this._watcher?.close(); } catch {}
    this._watcher = null;
    // останавливаем все модули: stop-хуки + очистка managed-таймеров + сохранение хранилищ
    await this.stopAll();
  }

  // ---------------- состояние ----------------

  isEnabled(name) {
    return this._config.enabled[name] !== false;
  }

  async setEnabled(name, enabled) {
    // флаг переключается синхронно — панель сразу видит новое состояние
    this._config.enabled[name] = Boolean(enabled);
    saveJson(this.configFile, this._config);
    try {
      if (enabled) await this._startModule(name);
      else await this._stopModule(name);
    } catch {} // изоляция: сбой lifecycle одного модуля не роняет панель
    return this.list();
  }

  saveSettings(name) {
    saveJson(this.configFile, this._config);
  }

  updateSettings(name, patch) {
    if (!this._config.settings[name]) this._config.settings[name] = {};
    Object.assign(this._config.settings[name], patch ?? {});
    this.saveSettings(name);
  }

  list() {
    return this._mods.map(({ name, file, def, error }) => ({
      name,
      file: path.basename(file),
      description: def?.description ? String(def.description).slice(0, 200) : '',
      enabled: !error && this.isEnabled(name),
      error,
      commands: Object.keys(def?.commands ?? {}),
      hooks: Object.keys(def?.events ?? {}),
      settings: { ...(this._config.settings[name] ?? {}) },
      // панель видит, какие ключи модуль держит в data/module-store/<имя>.json
      storageKeys: Object.keys(this._storeFor(name).data),
    }));
  }

  // ---------------- lifecycle ----------------

  _find(name) {
    return this._mods.find((m) => m.name === name) ?? null;
  }

  async _startModule(name) {
    const entry = this._find(name);
    if (!entry || entry.error || !entry.def) return;
    this._started.add(name);
    if (typeof entry.def.start !== 'function') return;
    try {
      await entry.def.start(this.apiFor(name, null));
    } catch (e) {
      // ошибка start() не роняет бота, но помечает модуль: панель покажет «ошибка»
      entry.error = `start: ${e.message}`;
      this.logs.system.push({ level: 'error', message: `Модуль «${name}» (start): ${e.message}` });
    }
  }

  async _stopModule(name) {
    const entry = this._find(name);
    const wasStarted = this._started.delete(name);
    if (wasStarted && entry?.def && typeof entry.def.stop === 'function') {
      try {
        await entry.def.stop(this.apiFor(name, null));
      } catch (e) {
        this.logs.system.push({ level: 'error', message: `Модуль «${name}» (stop): ${e.message}` });
      }
    }
    this._clearTimers(name); // managed-таймеры гасим всегда — не течём при любой остановке
    this._saveStore(name);  // и хранилище сохраняем даже при сбойном stop
  }

  async stopAll() {
    for (const { name } of this._mods) await this._stopModule(name);
  }

  // ---------------- managed-таймеры ----------------

  _addTimer(modName, kind, id) {
    id.unref?.(); // таймеры модулей не держат процесс бота
    let list = this._timers.get(modName);
    if (!list) {
      list = [];
      this._timers.set(modName, list);
    }
    list.push({ id, kind });
    return id;
  }

  _clearTimers(modName) {
    const list = this._timers.get(modName);
    if (!list) return;
    for (const { id, kind } of list) {
      try { (kind === 'timeout' ? clearTimeout : clearInterval)(id); } catch {}
    }
    this._timers.delete(modName);
  }

  // ---------------- хранилище (persist) ----------------

  /** Хранилище модуля: data/module-store/<name>.json. Читается при load(), живёт всё время работы. */
  _storeFor(modName) {
    let store = this._stores.get(modName);
    if (!store) {
      const file = path.join(this.storeDir, `${safeStoreName(modName)}.json`);
      let data = {};
      const stored = loadJson(file, null);
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) data = stored;
      store = { data, file, timer: null };
      this._stores.set(modName, store);
    }
    return store;
  }

  /** Отложенная запись (debounce): частые store.set() не спамят диск. */
  _scheduleStoreSave(modName) {
    const store = this._storeFor(modName);
    if (store.timer) clearTimeout(store.timer);
    store.timer = setTimeout(() => {
      store.timer = null;
      this._flushStore(modName);
    }, STORE_DEBOUNCE_MS);
    store.timer.unref?.();
  }

  /** Принудительная запись + отмена отложенной (используется при stop). */
  _saveStore(modName) {
    const store = this._stores.get(modName);
    if (!store) return; // модуль ничего не писал — файла не создаём
    if (store.timer) {
      clearTimeout(store.timer);
      store.timer = null;
    }
    this._flushStore(modName);
  }

  _flushStore(modName) {
    const store = this._stores.get(modName);
    if (!store) return;
    try {
      saveJson(store.file, store.data);
    } catch (e) {
      this.logs.system.push({ level: 'error', message: `Хранилище модуля «${modName}» не записалось: ${e.message}` });
    }
  }

  // ---------------- команды модулей ----------------

  /** Найти команду, объявленную модулями (включёнными). Функция → { type:'function', fn },
   *  строка/схема → нормализованная схема как у кастомных команд. */
  findCommand(commandName) {
    for (const { name, def, error } of this._mods) {
      if (!def || error || !this.isEnabled(name)) continue;
      const raw = def.commands?.[commandName];
      if (raw === undefined) continue;
      // команда-функция: async (session, args, api) => {} — движок зовёт её напрямую
      if (typeof raw === 'function') {
        return {
          name: commandName,
          source: name,
          type: 'function',
          fn: raw,
          // метаданные можно вешать прямо на функцию: fn.level, fn.cooldown
          mode: 'text',
          response: '',
          needsTarget: false,
          variants: [],
          ranges: [],
          rollMin: 0,
          rollMax: 100,
          chance: 100,
          level: LEVEL_NAMES.includes(raw.level) ? raw.level : 'everyone',
          cooldown: Math.max(0, Math.min(3600, Number(raw.cooldown ?? 0) || 0)),
        };
      }
      const spec = (typeof raw === 'string' ? { response: raw } : raw) ?? {};
      return {
        name: commandName,
        source: name,
        mode: ['text', 'variants', 'roll'].includes(spec.mode) ? spec.mode : 'text',
        response: String(spec.response ?? ''),
        needsTarget: Boolean(spec.needsTarget),
        variants: Array.isArray(spec.variants) ? spec.variants : [],
        ranges: Array.isArray(spec.ranges) ? spec.ranges : [],
        rollMin: Number(spec.rollMin ?? 0) || 0,
        rollMax: Number(spec.rollMax ?? 100) || 100,
        chance: spec.chance === undefined ? 100 : Math.max(0, Math.min(100, Number(spec.chance) || 0)),
        level: LEVEL_NAMES.includes(spec.level) ? spec.level : 'everyone',
        cooldown: Math.max(0, Math.min(3600, Number(spec.cooldown ?? 3) || 0)),
      };
    }
    return null;
  }

  commandNames() {
    const names = [];
    for (const { name, def, error } of this._mods) {
      if (!def || error || !this.isEnabled(name)) continue;
      names.push(...Object.keys(def.commands ?? {}));
    }
    return names;
  }

  // ---------------- события ----------------

  /** Возвращает false, если событие перехватили (хук chat.message вернул false). */
  async dispatch(twitchType, event) {
    const key = HOOK_ALIASES[twitchType];
    if (!key) return true;
    let passed = await this._fire(key, event);
    if (key === 'chat.notification') {
      const notice = String(event?.notice_type || '').replace(/^shared_chat_/, '');
      const derived = NOTICE_HOOKS[notice];
      if (derived) passed = (await this._fire(derived, event)) && passed;
    }
    return passed;
  }

  /** Гоняет хук по всем включённым модулям. false от любого хука = событие блокируется. */
  async _fire(hookKey, event) {
    let passed = true;
    for (const { name, def, error } of this._mods) {
      if (!def || error || !this.isEnabled(name)) continue;
      const hook = def.events?.[hookKey];
      if (typeof hook !== 'function') continue;
      try {
        if (await hook(event, this.apiFor(name, event)) === false) passed = false;
      } catch (e) {
        this.logs.system.push({ level: 'error', message: `Модуль «${name}» (${hookKey}): ${e.message}` });
      }
    }
    return passed;
  }

  // ---------------- API модулей ----------------

  /** Публичный доступ к API модуля (используется движком команд для async-команд). */
  apiFor(modName, event = null) {
    return this._apiFor(modName, event);
  }

  /**
   * API, доступный хукам, командам и lifecycle модуля.
   * api.channel — канал события (или основной канал).
   * Полный справочник — ДОКУМЕНТАЦИЯ.md, раздел «Модули».
   */
  _apiFor(modName, event) {
    const self = this;
    const chLogin = event?.broadcaster_user_id
      ? (this.channels?.loginOf?.(event.broadcaster_user_id) ?? null)
      : null;
    const resolve = (channel) => {
      const login = channel ?? chLogin ?? self.channels?.list()?.[0]?.login;
      return self.channels?.byLogin?.(String(login || '').toLowerCase()) ?? self.channels?.list()[0] ?? null;
    };
    const clip = (t) => String(t ?? '').slice(0, 480);
    const store = this._storeFor(modName);
    const safeTimerFn = (fn) => (...args) => {
      try {
        Promise.resolve(fn(...args)).catch((e) => {
          self.logs.system.push({ level: 'error', message: `Модуль «${modName}» (таймер): ${e.message}` });
        });
      } catch (e) {
        self.logs.system.push({ level: 'error', message: `Модуль «${modName}» (таймер): ${e.message}` });
      }
    };
    // Helix токеном стримера: без «Входа как стример» — понятная ошибка вместо исключения
    const broadcasterCall = (method, p, opts) => {
      if (!self.broadcasterHelix) {
        return Promise.resolve({ error: 'стример не залогинен' });
      }
      // файл токена стримера мог ещё не прочитаться на момент start-хука — ленивое чтение
      if (!self.broadcasterAuth?.tokens) self.broadcasterAuth?.load?.();
      if (!self.broadcasterAuth?.tokens) {
        return Promise.resolve({ error: 'стример не залогинен' });
      }
      // ensureValid (обновление токена) происходит внутри broadcasterHelix.call
      return self.broadcasterHelix.call(method, p, opts);
    };
    // OBS: без подключения politely отказываем объектом { error }
    const obsFail = () => ({ error: 'OBS не подключён' });

    return {
      // ---------- чат ----------
      get channel() { return chLogin; },
      channels: () => (self.channels?.list() ?? []),
      say: async (text, { channel } = {}) => {
        const ch = resolve(channel);
        if (!ch || !text) return;
        await self.helix.sendMessage({ broadcasterId: ch.id, senderId: self.auth.tokens?.userId, text: clip(text) });
        self.logs.events.push({ kind: `модуль ${modName}`, channel: ch.login, text: clip(text).slice(0, 200) });
      },
      announce: async (text, { color = 'purple', channel } = {}) => {
        const ch = resolve(channel);
        if (!ch || !text) return;
        const safe = ['primary', 'blue', 'green', 'orange', 'purple'].includes(color) ? color : 'purple';
        await self.helix.announce({ broadcasterId: ch.id, moderatorId: self.auth.tokens?.userId, text: clip(text), color: safe });
      },
      pin: async (text, { channel } = {}) => {
        const ch = resolve(channel);
        if (!ch || !text) return;
        await self.helix.sendMessage({ broadcasterId: ch.id, senderId: self.auth.tokens?.userId, text: clip(text), pin: true });
      },
      shoutout: async (login, { channel } = {}) => {
        const ch = resolve(channel);
        const who = String(login || '').replace(/^@/, '').toLowerCase();
        if (!ch || !who) return;
        const user = await self.helix.getUserByLogin(who);
        if (!user) return;
        await self.helix.shoutout({ fromId: ch.id, toUserId: user.id });
      },

      // ---------- Twitch Helix (токен бота) ----------
      helix: {
        get: (p, query) => self.helix?.call('GET', p, { query }),
        post: (p, body) => self.helix?.call('POST', p, { body }),
        del: (p, query) => self.helix?.call('DELETE', p, { query }),
      },

      // ---------- Helix токеном стримера (награды канала и т.п.) ----------
      broadcaster: {
        helix: {
          get: (p, query) => broadcasterCall('GET', p, { query }),
          post: (p, body) => broadcasterCall('POST', p, { body }),
          del: (p, query) => broadcasterCall('DELETE', p, { query }),
        },
      },

      // ---------- персистентное хранилище ----------
      store: {
        get: (key, def) => (key in store.data ? store.data[key] : def),
        set: (key, value) => { store.data[key] = value; self._scheduleStoreSave(modName); },
        delete: (key) => { delete store.data[key]; self._scheduleStoreSave(modName); },
        all: () => ({ ...store.data }),
        save: () => self._saveStore(modName),
      },

      // ---------- HTTP-запросы (через прокси, если включён в настройках) ----------
      fetch: (url, opts = {}) => {
        const proxy = opts?.proxy ?? self.settings?.proxy ?? null;
        const method = String(opts.method || (opts.body !== undefined ? 'POST' : 'GET')).toUpperCase();
        let body = opts.body; // строка/Buffer как есть, объект — сериализуем в JSON
        const headers = { ...(opts.headers ?? {}) };
        if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) {
          body = JSON.stringify(body);
          if (headers['Content-Type'] === undefined) headers['Content-Type'] = 'application/json';
        }
        return httpRequest(String(url ?? ''), { proxy, method, headers, body, timeoutMs: opts.timeoutMs });
      },

      // ---------- OBS (obs-websocket 5) ----------
      obs: {
        setScene: async (name) => {
          if (typeof self.obs?.setCurrentProgramScene !== 'function') return obsFail();
          try { await self.obs.setCurrentProgramScene(name); return true; } catch (e) { return { error: e.message }; }
        },
        getScenes: async () => {
          if (typeof self.obs?.getSceneList !== 'function') return obsFail();
          try { return await self.obs.getSceneList(); } catch (e) { return { error: e.message }; }
        },
        toggleSource: async (scene, source, visible = true) => {
          if (typeof self.obs?.setSceneItemEnabled !== 'function') return obsFail();
          try { await self.obs.setSceneItemEnabled(scene, source, Boolean(visible)); return true; } catch (e) { return { error: e.message }; }
        },
      },

      // ---------- оверлей (SSE-шина для OBS) ----------
      overlay: {
        push: (payload) => overlay.push(payload),
      },

      // ---------- managed-таймеры (чистятся при остановке модуля) ----------
      setInterval: (fn, ms) => self._addTimer(modName, 'interval', setInterval(safeTimerFn(fn), Math.max(1, Number(ms) || 1))),
      setTimeout: (fn, ms) => self._addTimer(modName, 'timeout', setTimeout(safeTimerFn(fn), Math.max(1, Number(ms) || 1))),

      // ---------- данные и состояние бота ----------
      get state() {
        return {
          counters: self.state?.counters ?? {},
          running: self.state?.running ?? false,
          channels: (self.channels?.list() ?? []).map((c) => c.login), // логины каналов бота
        };
      },

      // ---------- управление собой ----------
      stop: () => self.setEnabled(modName, false),

      // ---------- настройки и логи ----------
      settings: this._config.settings[modName] ?? {},
      saveSettings: () => { this.saveSettings(modName); },
      log: (message, level = 'info') => this.logs.system.push({ level, message: `[${modName}] ${message}` }),
    };
  }
}
