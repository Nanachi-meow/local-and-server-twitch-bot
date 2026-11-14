import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MODULES_DIR, MODULES_CONFIG_FILE, loadJson, saveJson } from '../store.js';

/** События Twitch → дружелюбные ключи хуков модулей. */
const HOOK_ALIASES = {
  'channel.chat.message': 'chat.message',
  'channel.chat.notification': 'chat.notification',
  'channel.follow': 'follow',
  'channel.raid': 'raid',
  'stream.online': 'stream.online',
  'stream.offline': 'stream.offline',
};

/** Из chat.notification выводим понятные хуки подписок. */
const NOTICE_HOOKS = { sub: 'sub', resub: 'resub', sub_gift: 'subgift' };

/**
 * Модули-плагины: файлы .js в папке modules/. Каждый экспортирует объект:
 *   {
 *     name: 'имя',                  // опционально, дефолт = имя файла
 *     description: 'что делает',
 *     settings: { ключ: значение }, // настройки по умолчанию (панель даёт править)
 *     commands: {                   // команды модуля (как кастомные, но живут в файле)
 *       'факт': '{user}, котики мурчат 🐱',          // строка = простой ответ
 *       'хорни': { mode: 'roll', rollMin: 0, rollMax: 100, ... },  // или полная схема
 *     },
 *     events: {                     // хуки: async (событие, api) => {}
 *       'chat.message': async (m, api) => { ... },
 *       'sub': async (ev, api) => { ... },
 *     },
 *   }
 * Ошибка в модуле не роняет бота: грузится с ошибкой/логируется, остальные живут.
 * Изменения файлов подхватываются сами (fs.watch + панель кнопкой «Перезагрузить»).
 */
export class ModuleManager {
  constructor({ dir = MODULES_DIR, configFile = MODULES_CONFIG_FILE, helix, auth, logs, channels }) {
    this.dir = dir;
    this.configFile = configFile;
    this.helix = helix;
    this.auth = auth;
    this.logs = logs;
    this.channels = channels;
    this._mods = []; // { name, file, def, error }
    this._timer = null;
    this._watcher = null;
    this._watchTimer = null;
    this._config = loadJson(this.configFile, null) ?? { enabled: {}, settings: {} };
    if (typeof this._config.enabled !== 'object' || !this._config.enabled) this._config.enabled = {};
    if (typeof this._config.settings !== 'object' || !this._config.settings) this._config.settings = {};
  }

  // ---------------- загрузка ----------------

  async load() {
    this._mods = [];
    if (!fs.existsSync(this.dir)) return this.list();
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
      } catch (e) {
        this._mods.push({ name: path.basename(file, '.js'), file, def: null, error: e.message });
      }
    }
    saveJson(this.configFile, this._config);
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
    }, 20_000);
    try {
      if (fs.existsSync(this.dir)) {
        this._watcher = fs.watch(this.dir, () => {
          clearTimeout(this._watchTimer);
          this._watchTimer = setTimeout(() => { this.reload().catch(() => {}); }, 500);
        });
      }
    } catch {} // watch недоступен — не страшно, есть кнопка в панели
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    clearTimeout(this._watchTimer);
    try { this._watcher?.close(); } catch {}
    this._watcher = null;
  }

  // ---------------- состояние ----------------

  isEnabled(name) {
    return this._config.enabled[name] !== false;
  }

  setEnabled(name, enabled) {
    this._config.enabled[name] = Boolean(enabled);
    saveJson(this.configFile, this._config);
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
    }));
  }

  // ---------------- команды модулей ----------------

  /** Найти команду, объявленную модулями (включёнными). Возвращает схему как у кастомных команд. */
  findCommand(commandName) {
    for (const { name, def, error } of this._mods) {
      if (!def || error || !this.isEnabled(name)) continue;
      const raw = def.commands?.[commandName];
      if (raw === undefined) continue;
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
        level: ['everyone', 'sub', 'vip', 'mod'].includes(spec.level) ? spec.level : 'everyone',
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

  async dispatch(twitchType, event) {
    const key = HOOK_ALIASES[twitchType];
    if (!key) return;
    await this._fire(key, event);
    if (key === 'chat.notification') {
      const notice = String(event?.notice_type || '').replace(/^shared_chat_/, '');
      const derived = NOTICE_HOOKS[notice];
      if (derived) await this._fire(derived, event);
    }
  }

  async _fire(hookKey, event) {
    for (const { name, def, error } of this._mods) {
      if (!def || error || !this.isEnabled(name)) continue;
      const hook = def.events?.[hookKey];
      if (typeof hook !== 'function') continue;
      try {
        await hook(event, this._apiFor(name, event));
      } catch (e) {
        this.logs.system.push({ level: 'error', message: `Модуль «${name}» (${hookKey}): ${e.message}` });
      }
    }
  }

  /** API, доступный хукам модуля. api.channel — канал события (или основной). */
  _apiFor(modName, event) {
    const chLogin = event?.broadcaster_user_id
      ? (this.channels?.loginOf?.(event.broadcaster_user_id) ?? null)
      : null;
    const self = this;
    const resolve = (channel) => {
      const login = channel ?? chLogin ?? self.channels?.list()?.[0]?.login;
      return self.channels?.byLogin?.(String(login || '').toLowerCase()) ?? self.channels?.list()[0] ?? null;
    };
    const clip = (t) => String(t ?? '').slice(0, 480);
    return {
      get channel() { return chLogin; },
      channels: () => (this.channels?.list() ?? []).map((c) => c.login),
      say: async (text, { channel } = {}) => {
        const ch = resolve(channel);
        if (!ch || !text) return;
        await this.helix.sendMessage({ broadcasterId: ch.id, senderId: this.auth.tokens?.userId, text: clip(text) });
        this.logs.events.push({ kind: `модуль ${modName}`, channel: ch.login, text: clip(text).slice(0, 200) });
      },
      announce: async (text, { color = 'purple', channel } = {}) => {
        const ch = resolve(channel);
        if (!ch || !text) return;
        const safe = ['primary', 'blue', 'green', 'orange', 'purple'].includes(color) ? color : 'purple';
        await this.helix.announce({ broadcasterId: ch.id, moderatorId: this.auth.tokens?.userId, text: clip(text), color: safe });
      },
      pin: async (text, { channel } = {}) => {
        const ch = resolve(channel);
        if (!ch || !text) return;
        await this.helix.sendMessage({ broadcasterId: ch.id, senderId: this.auth.tokens?.userId, text: clip(text), pin: true });
      },
      shoutout: async (login, { channel } = {}) => {
        const ch = resolve(channel);
        const who = String(login || '').replace(/^@/, '').toLowerCase();
        if (!ch || !who) return;
        const user = await this.helix.getUserByLogin(who);
        if (!user) return;
        await this.helix.shoutout({ fromId: ch.id, toUserId: user.id });
      },
      settings: this._config.settings[modName] ?? {},
      saveSettings: () => { this.saveSettings(modName); },
      log: (message, level = 'info') => this.logs.system.push({ level, message: `[${modName}] ${message}` }),
    };
  }
}
