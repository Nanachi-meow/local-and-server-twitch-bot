import { COMMANDS_FILE, SETTINGS_FILE, loadJson, saveJson } from '../store.js';
import { renderTemplate, fmtDuration, humanizeSince } from './render.js';
import { HelixError } from '../twitch/helix.js';
import { overlay } from './alerts.js';

export const LEVELS = { everyone: 0, sub: 1, vip: 2, mod: 3, broadcaster: 4 };

export const RESERVED = new Set([
  'commands', 'help', 'so', 'pin', 'unpin', 'announce', 'uptime', 'game', 'title',
  'followage', 'addcmd', 'editcmd', 'delcmd', 'bot',
  'колесо', 'мем', 'цитата', 'сказать', 'сцена', 'сцены',
  'ср', 'песня', 'очередь', 'скип', 'музыка',
]);

const NAME_RE = /^!?[A-Za-zА-Яа-яЁё0-9_\-]{1,32}$/;

export function levelValue(level) {
  return LEVELS[level] ?? 0;
}

export function userLevel(badges = [], userId, broadcasterId) {
  if (userId && broadcasterId && String(userId) === String(broadcasterId)) return 'broadcaster';
  const sets = new Set((badges || []).map((b) => b.set_id || b.setId || b.id));
  if (sets.has('broadcaster')) return 'broadcaster';
  if (sets.has('moderator')) return 'mod';
  if (sets.has('vip')) return 'vip';
  if (sets.has('subscriber') || sets.has('founder')) return 'sub';
  return 'everyone';
}

function defaultCommands() {
  return [
    {
      name: 'social',
      response: 'Все ссылки — в описании канала! Апни стримеру лайк, если было весело {user}',
      level: 'everyone',
      cooldown: 10,
      enabled: true,
      count: 0,
    },
  ];
}

/**
 * Движок команд: встроенные + кастомные (data/commands.json).
 * Мультиканальный: каждое сообщение несёт broadcasterId канала, ответ уходит в тот же канал.
 */
export class CommandEngine {
  constructor({ helix, auth, logs, settings, state, channels = null }) {
    this.helix = helix;
    this.auth = auth;
    this.logs = logs;
    this.settings = settings; // живой объект настроек (index.js)
    this.state = state;
    this.channels = channels; // реестр каналов: { get(id), loginOf(id) }
    this.ctx = { broadcasterId: null, channel: '' }; // запасной контекст для тестов/панели
    this.custom = (loadJson(COMMANDS_FILE, null) ?? defaultCommands()).map((c) => this.normalizeCommand(c));
    this._cool = new Map();
    this._dirty = false;
  }

  setContext(ctx) {
    Object.assign(this.ctx, ctx);
  }

  setChannels(channels) {
    this.channels = channels;
  }

  setModules(modules) {
    this.modules = modules;
  }

  setQuotes(quotes) {
    this.quotes = quotes;
  }

  setObs(obs) {
    this.obs = obs;
  }

  setSongs(songs) {
    this.songs = songs;
  }

  // ---------------- хранилище ----------------

  list() {
    return this.custom;
  }

  /** Схема команды: mode (text|variants|roll), needsTarget, rollMin/rollMax, ranges[], chance. Легаси type/action конвертируются. */
  normalizeCommand(cmd) {
    const legacyType = cmd?.type;
    const mode = ['text', 'variants', 'roll'].includes(cmd?.mode)
      ? cmd.mode
      : (legacyType === 'random' ? 'variants' : 'text'); // старые: rp и text -> текст, random -> варианты
    const chance = (cmd?.chance === undefined || cmd?.chance === null || cmd?.chance === '')
      ? 100
      : Math.max(0, Math.min(100, Number.isFinite(Number(cmd.chance)) ? Number(cmd.chance) : 100));
    const rollMin = Number.isFinite(Number(cmd?.rollMin)) ? Number(cmd.rollMin) : 0;
    const rollMax = Number.isFinite(Number(cmd?.rollMax)) ? Number(cmd.rollMax) : 100;
    return {
      name: String(cmd?.name || ''),
      mode,
      allow: [...new Set((Array.isArray(cmd?.allow) ? cmd.allow : [])
        .map((r) => String(r).toLowerCase())
        .filter((r) => LEVELS[r] !== undefined && r !== 'broadcaster'))], // строгий набор ролей; пустой = старое правило «уровень и выше»
      // ответ-одиночка (и заглушка для рандом-числа); старое РП-«действие» переезжает сюда
      response: String(cmd?.response || cmd?.action || '').trim().slice(0, 480),
      variants: (Array.isArray(cmd?.variants) ? cmd.variants : [])
        .map((v) => String(v || '').trim().slice(0, 480))
        .filter(Boolean)
        .slice(0, 20),
      rollMin: Math.max(0, Math.min(1_000_000, rollMin)),
      rollMax: Math.max(rollMin, Math.min(1_000_000, Math.max(0, rollMax))),
      ranges: (Array.isArray(cmd?.ranges) ? cmd.ranges : [])
        .map((r) => ({
          from: Math.max(0, Math.min(1_000_000, Math.floor(Number(r?.from) || 0))),
          to: Math.max(0, Math.min(1_000_000, Math.floor(Number(r?.to) || 0))),
          text: String(r?.text || '').trim().slice(0, 480),
        }))
        .filter((r) => r.text && r.to >= r.from)
        .slice(0, 20),
      chance,
      needsTarget: Boolean(cmd?.needsTarget),
      level: LEVELS[cmd?.level] ? cmd.level : 'everyone',
      cooldown: Math.max(0, Math.min(3600, Number(cmd?.cooldown) || 0)),
      enabled: cmd?.enabled !== false,
      count: Number(cmd?.count) || 0,
    };
  }

  validateCustom(cmd) {
    const name = String(cmd?.name || '').toLowerCase().replace(/^!/, '');
    if (!NAME_RE.test(`!${name}`)) return { error: 'Имя команды: 1–32 символа, буквы/цифры/_/- (без пробелов)' };
    if (RESERVED.has(name)) return { error: `Имя "!${name}" зарезервировано за встроенной командой` };
    let value;
    try {
      value = this.normalizeCommand(cmd);
      value.name = name;
    } catch {
      return { error: 'Команда заполнена криво' };
    }
    if (value.mode === 'variants' && !value.variants.length) {
      return { error: 'Режиму «несколько вариантов» нужен хотя бы один вариант' };
    }
    if (value.mode === 'roll' && !value.response) {
      return { error: 'Режиму «рандом-число» нужен текст-заглушка для чисел вне диапазонов (используй {roll})' };
    }
    if (value.mode === 'text' && !value.response) {
      return { error: 'Нужен текст ответа' };
    }
    return { value };
  }

  upsert(cmd) {
    const check = this.validateCustom(cmd);
    if (check.error) throw new Error(check.error);
    const value = check.value;
    const existing = this.custom.findIndex((c) => c.name === value.name);
    if (existing >= 0) {
      value.count = value.count || this.custom[existing].count || 0; // счётчик не теряется при сохранении из панели
      this.custom[existing] = { ...this.custom[existing], ...value };
    } else this.custom.push(value);
    this.save();
    return value;
  }

  remove(name) {
    const key = String(name || '').toLowerCase().replace(/^!/, '');
    const idx = this.custom.findIndex((c) => c.name === key);
    if (idx < 0) throw new Error(`Команда "!${key}" не найдена`);
    const [removed] = this.custom.splice(idx, 1);
    this.save();
    return removed;
  }

  save() {
    saveJson(COMMANDS_FILE, this.custom);
    this._dirty = false;
  }

  flushCounters() {
    // критик: ошибка файловой системы не должна ронять бота
    if (!this.custom.some((c) => c.count > 0)) return;
    try { saveJson(COMMANDS_FILE, this.custom); } catch {}
    // критик: кулдаун-карта растёт вечно — подметаем протухшие (макс. кулдаун 3600с)
    const cut = Date.now() - 3_600_000;
    for (const [k, ts] of this._cool) if (ts < cut) this._cool.delete(k);
  }

  /** Эффективный доступ команды: allow (набор ролей) сильнее level (иерархия).
   *  Владелец канала может всё. Пустой allow = действует level. */
  canUse(cmd, userRole, { builtinName = null } = {}) {
    if (userRole === 'broadcaster') return true;
    let level;
    let allow = null;
    if (builtinName) {
      const b = this.builtins[builtinName] ?? {};
      const ov = this.settings?.builtins?.access?.[builtinName] ?? {};
      level = (LEVELS[ov.level] !== undefined && ov.level) ? ov.level : (b.level ?? 'everyone');
      allow = Array.isArray(ov.allow) ? ov.allow : null;
    } else {
      level = cmd?.level ?? 'everyone';
      allow = Array.isArray(cmd?.allow) ? cmd.allow : null;
    }
    if (allow?.length) return allow.map(String).includes(userRole);
    return levelValue(userRole) >= levelValue(level);
  }

  // ---------------- обработка сообщений чата ----------------

  /** Обработка сообщения чата. */
  async handleChatMessage({ broadcasterId, userId, login, displayName, text, badges } = {}) {
    this.state.counters.messagesSeen = (this.state.counters.messagesSeen || 0) + 1;
    const trimmed = String(text || '').trim();
    if (!trimmed.startsWith('!')) return false;
    if (login === this.auth.tokens?.login) return false; // свои сообщения не обрабатываем
    const bId = broadcasterId ?? this.ctx.broadcasterId;
    const channelLogin = this.channels?.loginOf(bId) ?? this.ctx.channel;
    const parts = trimmed.slice(1).split(/\s+/);
    const name = (parts[0] || '').toLowerCase();
    const args = parts.slice(1);
    if (!name) return false;

    const custom = this.custom.find((c) => c.name === name && c.enabled !== false);
    // команда музыки может быть переименована в панели (settings.songs.commandName) — синоним «ср»
    const songCmd = String(this.settings?.songs?.commandName || 'ср').toLowerCase().replace(/^!/, '');
    const lookup = name !== 'ср' && name === songCmd ? 'ср' : name;
    const builtin = this.builtinEnabled(lookup) ? this.builtins[lookup] : null;
    // команда от модуля — если ни кастомной, ни встроенной нет; кастомная всегда сильнее
    const modCmd = (!custom && !builtin && this.modules) ? this.modules.findCommand(name) : null;
    const cmd = custom ?? builtin ?? modCmd;
    if (!cmd) return false;

    const userLevelName = userLevel(badges, userId, bId);
    const session = {
      broadcasterId: bId,
      channel: channelLogin,
      userId,
      login,
      displayName: displayName || login,
      level: userLevelName, // уровень вызвавшего — для субкоманд со своей проверкой прав (!цитата добавить, !ставка открыть)
    };
    if (!this.canUse(cmd, userLevelName, { builtinName: builtin ? lookup : null })) {
      return false; // молча игнорируем тех, кому нельзя
    }

    // кулдаун (кастомные и модульные команды)
    if ((custom || modCmd) && (cmd.cooldown ?? 0) > 0) {
      const key = custom ? `${bId}:${custom.name}:${userId}` : `${bId}:mod:${name}:${userId}`;
      const last = this._cool.get(key) || 0;
      if (Date.now() - last < cmd.cooldown * 1000) return false;
      this._cool.set(key, Date.now());
    }

    this.state.counters.commandsRun = (this.state.counters.commandsRun || 0) + 1;

    if (custom || modCmd) {
      // команда-функция модуля: async (session, args, api) => {} — полный доступ к API
      if (modCmd?.type === 'function') {
        const api = this.modules?.apiFor(modCmd.source, {
          broadcaster_user_id: session.broadcasterId,
          chatter_user_id: session.userId,
          chatter_user_login: session.login,
          chatter_user_name: session.displayName,
        });
        try {
          await modCmd.fn(session, args, api);
        } catch (e) {
          this.logs?.system?.push?.({ level: 'error', message: `Команда «!${name}» (модуль «${modCmd.source}»): ${e.message}` });
          await this.say(session, `Ошибка в команде модуля: ${e.message}`.slice(0, 400));
        }
        return true;
      }
      if (custom) {
        custom.count = (custom.count || 0) + 1;
        this._dirty = true;
      }

      // условие активации: команда про второго пользователя — без @ник только подсказка
      const selfName = session.displayName || session.login;
      const rawTarget = args[0] ? args[0].replace(/^@/, '') : '';
      if (cmd.needsTarget && !rawTarget) {
        await this.say(session, `укажи ник: !${cmd.name} @ник`);
        return true;
      }

      // шанс срабатывания (для любого режима): не повезло — молчим (кулдаун уже списан)
      const chance = Math.max(0, Math.min(100, Number(cmd.chance ?? 100)));
      if (Math.random() * 100 >= chance) return true;

      const vars = await this.templateVars({ session, args });
      vars.target = rawTarget || selfName; // без аргумента действие на самого себя
      vars.target_login = vars.target.toLowerCase();

      const mode = cmd.mode || 'text';
      let text = '';
      if (mode === 'variants') {
        const list = (cmd.variants || []).filter(Boolean);
        text = list[Math.floor(Math.random() * list.length)] || cmd.response || '';
      } else if (mode === 'roll') {
        const min = Math.max(0, Number(cmd.rollMin ?? 0) || 0);
        const max = Math.max(min, Number(cmd.rollMax ?? 100) || 100);
        const roll = min + Math.floor(Math.random() * (max - min + 1));
        const range = (cmd.ranges || []).find((r) => roll >= r.from && roll <= r.to);
        text = range?.text || cmd.response || '';
        vars.roll = roll;
      } else {
        text = cmd.response || '';
      }
      await this.say(session, renderTemplate(text, vars));
    } else {
      try {
        await builtin.run(session, args);
      } catch (e) {
        await this.say(session, this.humanizeError(e));
      }
    }
    return true;
  }

  // ---------------- переменные шаблонов ----------------

  async templateVars({ session, args = [], targetLogin = null, extra = {} }) {
    const target = targetLogin ?? (args[0] ? args[0].replace(/^@/, '') : '');
    let vars = {
      user: session.displayName || session.login,
      target,
      target_login: target.toLowerCase(),
      args: args.join(' '),
      channel: session.channel,
      count: 0,
      ...extra,
    };
    try {
      const stream = await this.helix.getStreamByLogin(session.channel);
      vars.uptime = stream ? fmtDuration(Date.now() - Date.parse(stream.started_at)) : 'оффлайн';
      vars.game = stream ? stream.game_name : '—';
      vars.title = stream ? stream.title : '—';
    } catch {
      vars.uptime = '?';
      vars.game = '?';
      vars.title = '?';
    }
    return vars;
  }

  // ---------------- отправка ----------------

  async say(session, text, { pin = false } = {}) {
    if (!text || !session?.broadcasterId) return;
    await this.helix.sendMessage({
      broadcasterId: session.broadcasterId,
      senderId: this.auth.tokens?.userId,
      text,
      pin,
    });
  }

  humanizeError(e) {
    if (e instanceof HelixError) {
      if (e.status === 429) return 'Слишком часто — Twitch просит притормозить (шатаут можно раз в 2 минуты, закреп — тоже ограничен)';
      if (e.status === 403) return 'Бот должен быть модератором канала, чтобы это делать (напиши: /mod ' + (this.auth.tokens?.login || 'имя_бота') + ')';
      return `Twitch ответил: ${e.message}`;
    }
    return `Ошибка: ${e.message}`;
  }

  // ---------------- кручение колеса (общая логика для команды и награды) ----------------

  /** Выбрать сектор по весам. Возвращает { picked, index, sectors } или null. */
  pickWheel() {
    const cfg = this.settings?.wheel ?? {};
    const items = (Array.isArray(cfg.items) ? cfg.items : [])
      .filter((x) => x && String(x.label || '').trim() && Number(x.weight) > 0);
    if (!items.length) return null;
    const total = items.reduce((s, x) => s + Number(x.weight), 0);
    let roll = Math.random() * total;
    let picked = items[items.length - 1];
    let index = items.length - 1;
    for (const [i, it] of items.entries()) {
      roll -= Number(it.weight);
      if (roll <= 0) { picked = it; index = i; break; }
    }
    const colorPalette = ['#8b5cf6', '#22c55e', '#eab308', '#38bdf8', '#f97316', '#ec4899', '#14b8a6', '#a855f7'];
    const sectors = items.map((it, idx) => ({ label: it.label, weight: Number(it.weight), color: it.color || colorPalette[idx % colorPalette.length] }));
    return { picked, index, sectors };
  }

  /** Кулдаун на юзера (общий для команды/награды). true = можно. */
  wheelCooldownOk(key) {
    const cfg = this.settings?.wheel ?? {};
    const cd = Math.max(0, Math.min(3600, Number(cfg.cooldown) || 0));
    const k = `${key}:wheel`;
    const last = engine._cool.get(k) || 0;
    if (cd && Date.now() - last < cd * 1000) return false;
    if (cd) engine._cool.set(k, Date.now());
    return true;
  }

  // ---------------- встроенные команды ----------------

  /** Встроенная команда включена? (settings.builtins.disabled — список выключенных имён) */
  builtinEnabled(name) {
    const list = this.settings?.builtins?.disabled;
    if (!Array.isArray(list)) return true;
    return !list.map(String).includes(String(name));
  }

  get builtins() {
    const engine = this;
    return {
      commands: {
        level: 'everyone', label: 'список команд', desc: 'все команды списком',
        async run(session) {
          const names = engine.custom.filter((c) => c.enabled !== false).map((c) => `!${c.name}`);
          const modNames = (engine.modules?.commandNames() ?? []).map((n) => `!${n}`);
          const songCmd = String(engine.settings?.songs?.commandName || 'ср').toLowerCase().replace(/^!/, '');
          const base = ['so', 'uptime', 'game', 'followage', songCmd]
            .filter((n) => engine.builtinEnabled(n))
            .map((n) => `!${n}`);
          const all = [...base, ...names, ...modNames].join(', ');
          await engine.say(session, `Команды: ${all}`.slice(0, 480));
        },
      },
      help: {
        level: 'everyone', label: 'список команд', desc: 'то же, что !commands',
        async run(session, args) { return engine.builtins.commands.run(session, args); },
      },
      uptime: {
        level: 'everyone', label: 'сколько стрим идёт', desc: 'сколько идёт стрим',
        async run(session, args) {
          const vars = await engine.templateVars({ session, args });
          await engine.say(session, vars.uptime === 'оффлайн'
            ? `@${vars.user}, канал сейчас оффлайн 💤`
            : `Стрим идёт уже ${vars.uptime} ⏱`);
        },
      },
      game: {
        level: 'everyone', label: 'что стримится', desc: 'что сейчас стримится',
        async run(session, args) {
          const vars = await engine.templateVars({ session, args });
          await engine.say(session, `Сейчас стримится: ${vars.game} | ${vars.title}`);
        },
      },
      title: {
        level: 'everyone', label: 'название стрима', desc: 'название стрима',
        async run(session, args) {
          const vars = await engine.templateVars({ session, args });
          await engine.say(session, `Название стрима: ${vars.title}`);
        },
      },
      so: {
        level: 'mod', label: 'шатаут: !so <ник> (мод+)', desc: 'шатаут стримера',
        async run(session, args) {
          const target = (args[0] || '').replace(/^@/, '');
          if (!target) { await engine.say(session, 'Использование: !so <ник стримера>'); return; }
          const user = await engine.helix.getUserByLogin(target);
          if (!user) { await engine.say(session, `Не нашла на Twitch пользователя "${target}" 🤷`); return; }
          try {
            await engine.helix.shoutout({
              fromId: session.broadcasterId,
              toUserId: user.id,
              moderatorId: engine.auth.tokens?.userId,
            });
          } catch (e) {
            await engine.say(session, engine.humanizeError(e));
            return;
          }
          const vars = await engine.templateVars({
            session, args, targetLogin: user.login, extra: { target: user.display_name },
          });
          const template = engine.settings.so?.template || 'Залетайте поддержать {target}: twitch.tv/{target_login} ❤️';
          const rendered = renderTemplate(template, vars);
          // оверлей-виджет шатаута: аватарка/баннер + текст (аватар и баннер отдаёт Helix, gif тоже покажется)
          overlay.push({
            kind: 'shoutout',
            channel: session.channel,
            login: user.login,
            user: user.display_name,
            avatar: String(user.profile_image_url || ''),
            banner: String(user.offline_image_url || ''),
            text: rendered,
          });
          await engine.say(session, rendered);
        },
      },
      pin: {
        level: 'mod', label: 'закрепить: !pin <текст> (мод+)', desc: 'закрепить текст',
        async run(session, args) {
          const text = args.join(' ').trim();
          if (!text) { await engine.say(session, 'Использование: !pin <текст> — закреплю на 20 минут'); return; }
          try {
            await engine.say(session, text, { pin: true });
          } catch (e) {
            await engine.say(session, engine.humanizeError(e));
          }
        },
      },
      unpin: {
        level: 'mod', label: 'снять закреп (мод+)', desc: 'снять закреп',
        async run(session) {
          try {
            const pinned = await engine.helix.getPinned({
              broadcasterId: session.broadcasterId,
              moderatorId: engine.auth.tokens?.userId,
            });
            if (!pinned?.message_id) { await engine.say(session, 'Сейчас ничего не закреплено'); return; }
            await engine.helix.unpinMessage({
              broadcasterId: session.broadcasterId,
              moderatorId: engine.auth.tokens?.userId,
              messageId: pinned.message_id,
            });
            await engine.say(session, 'Закреп снят ✅');
          } catch (e) {
            await engine.say(session, engine.humanizeError(e));
          }
        },
      },
      announce: {
        level: 'mod', label: 'анонс: !announce <цвет> <текст> (мод+)', desc: 'цветной анонс',
        async run(session, args) {
          const colors = ['blue', 'green', 'orange', 'purple', 'primary'];
          let color = engine.settings.announceColor || 'purple';
          if (args[0] && colors.includes(args[0].toLowerCase())) {
            color = args.shift().toLowerCase();
          }
          const text = args.join(' ').trim();
          if (!text) { await engine.say(session, 'Использование: !announce [цвет: blue|green|orange|purple|primary] <текст>'); return; }
          try {
            await engine.helix.announce({
              broadcasterId: session.broadcasterId,
              moderatorId: engine.auth.tokens?.userId,
              text,
              color,
            });
          } catch (e) {
            await engine.say(session, engine.humanizeError(e));
          }
        },
      },
      followage: {
        level: 'everyone', label: 'сколько ты с нами: !followage [ник]', desc: 'сколько ты с нами',
        async run(session, args) {
          const targetLogin = (args[0] || session.login).replace(/^@/, '');
          const user = await engine.helix.getUserByLogin(targetLogin);
          if (!user) { await engine.say(session, `Не нашла пользователя "${targetLogin}" 🤷`); return; }
          const follower = await engine.helix.getFollower({
            broadcasterId: session.broadcasterId,
            userId: user.id,
          });
          if (!follower) {
            await engine.say(session, `${user.display_name} ещё не фолловит канал — самое время! 💜`);
            return;
          }
          await engine.say(session, `${user.display_name} с нами уже ${humanizeSince(follower.followed_at)}! 💜`);
        },
      },

      // ---------- баллы канала removed: награды Twitch не позволяют перекидывать очки программно ----------
      // ---------- колесо (бесплатное: просто случайный исход в оверлей) ----------
      колесо: {
        level: 'everyone', label: 'колесо: !колесо — случайный исход', desc: 'крутить колесо',
        async run(session) {
          const cfg = engine.settings?.wheel ?? {};
          if (cfg.mode === 'off') return;
          if (cfg.mode !== 'command') {
            if (cfg.rewardName) {
              await engine.say(session, `Колесо крутится наградой канала «${cfg.rewardName}» 🎡`);
            }
            return;
          }
          if (cfg.enabled === false) { await engine.say(session, 'Колесо сейчас выключено 🙅'); return; }
          const items = (Array.isArray(cfg.items) ? cfg.items : [])
            .filter((x) => x && String(x.label || '').trim() && Number(x.weight) > 0);
          if (!items.length) { await engine.say(session, 'Колесо не настроено: нет вариантов с весом 🤷'); return; }
          const cd = Math.max(0, Math.min(3600, Number(cfg.cooldown) || 0));
          const key = `${session.broadcasterId}:wheel:${session.userId}`;
          const last = engine._cool.get(key) || 0;
          if (cd && Date.now() - last < cd * 1000) {
            const left = Math.ceil((cd * 1000 - (Date.now() - last)) / 1000);
            await engine.say(session, `@${session.login}, охлади пыл — следующее вращение через ${left} сек`);
            return;
          }
          if (cd) engine._cool.set(key, Date.now());
          const who = session.displayName || session.login;
          const spin = engine.pickWheel();
          if (!spin) { await engine.say(session, 'Колесо не настроено: нет вариантов с весом 🤷'); return; }
          overlay.push({
            kind: 'wheel',
            channel: null,
            user: who,
            text: `${who}: ${spin.picked.label}`,
            label: spin.picked.label,
            index: spin.index,
            sectors: spin.sectors,
          });
          await engine.say(session, `🎡 ${who} крутил(а) колесо → ${spin.picked.label}`);
        },
      },

      // ---------- мем-алерты (бесплатные) ----------
      мем: {
        level: 'everyone', label: 'мем-алерт: !мем [название]', desc: 'показать мем',
        async run(session, args) {
          const cfg = engine.settings?.memShop ?? {};
          if (cfg.enabled === false) { await engine.say(session, 'Мем-алерты сейчас выключены 🙅'); return; }
          const items = (Array.isArray(cfg.items) ? cfg.items : [])
            .filter((x) => x && x.enabled !== false && String(x.name || '').trim());
          const wanted = String(args[0] ?? '').trim().toLowerCase();
          const item = wanted ? items.find((x) => String(x.name).toLowerCase() === wanted) : null;
          if (!item) {
            const names = items.map((x) => x.name);
            await engine.say(session, `Мемы: ${names.slice(0, 8).join(' · ') || 'пока пусто — заполни data/settings.json'}. Показать: !мем название 🎬`.slice(0, 480));
            return;
          }
          const cd = Math.max(0, Math.min(3600, Number(cfg.cooldown) || 0));
          const key = `${session.broadcasterId}:meme:${session.userId}`;
          const last = engine._cool.get(key) || 0;
          if (cd && Date.now() - last < cd * 1000) {
            const left = Math.ceil((cd * 1000 - (Date.now() - last)) / 1000);
            await engine.say(session, `@${session.login}, мемы не чаще — подожди ${left} сек`);
            return;
          }
          if (cd) engine._cool.set(key, Date.now());
          const who = session.displayName || session.login;
          overlay.push({
            kind: 'meme',
            channel: null,
            user: who,
            text: String(item.text || 'мем 🎉').replaceAll('{user}', who),
            sound: String(item.sound || ''),
          });
          engine.logs?.events?.push?.({ text: `${who} показал(а) мем «${item.name}»` });
          await engine.say(session, `🎬 @${session.login}, мем «${item.name}» полетел в оверлей!`);
        },
      },

      // ---------- говорилка: TTS-фраза в оверлей (бесплатно) ----------
      сказать: {
        level: 'everyone', label: 'TTS-озвучка: !сказать <текст>', desc: 'озвучить текст',
        async run(session, args) {
          const cfg = {
            enabled: true,
            cooldown: 60, // сек между фразами одного зрителя
            blocked: [], // запрещённые слова (по подстроке, без учёта регистра)
            ...(engine.settings?.say ?? {}),
          };
          const text = args.join(' ').trim();
          if (!cfg.enabled) { await engine.say(session, 'Говорилка сейчас выключена 🙅'); return; }
          if (!text) { await engine.say(session, 'Использование: !сказать <текст> — озвучу на стриме 🔊'); return; }
          if (text.length > 200) {
            await engine.say(session, `@${session.login}, текст слишком длинный — максимум 200 символов (у тебя ${text.length})`);
            return;
          }
          const lower = text.toLowerCase();
          const bad = (Array.isArray(cfg.blocked) ? cfg.blocked : []).find((w) => w && lower.includes(String(w).toLowerCase()));
          if (bad) {
            await engine.say(session, `@${session.login}, тут запрещённое слово — скажи что-нибудь другое 🤫`);
            return;
          }
          const cd = Math.max(0, Math.min(3600, Number(cfg.cooldown) || 0));
          const key = `${session.broadcasterId}:say:${session.userId}`;
          const last = engine._cool.get(key) || 0;
          if (cd && Date.now() - last < cd * 1000) {
            const left = Math.ceil((cd * 1000 - (Date.now() - last)) / 1000);
            await engine.say(session, `@${session.login}, охлади пыл — следующая фраза через ${left} сек`);
            return;
          }
          if (cd) engine._cool.set(key, Date.now());
          const who = session.displayName || session.login;
          overlay.push({ kind: 'meme', channel: null, user: who, text: `🗣 ${who}: ${text}`, sound: '' });
          await engine.say(session, `🔊 @${session.login}, озвучено`);
        },
      },

      // ---------- музыка: заказы YouTube (бесплатные; за баллы канала — отдельной фазой) ----------
      ср: {
        level: 'everyone', label: 'заказ музыки: !ср <ссылка>', desc: 'заказать песню',
        async run(session, args) {
          if (!engine.songs) { await engine.say(session, 'Плеер не настроен'); return; }
          const cfg = engine.songs.cfg();
          if (!cfg.enabled) { await engine.say(session, 'Музыка сейчас выключена 🎵❌'); return; }
          // способ приёма заказов: только через награду канала
          if (cfg.requestMode === 'reward') {
            const rn = cfg.rewardName || 'заказать песню';
            await engine.say(session, `Заказы музыки — через награду канала «${rn}» за баллы 🎵`);
            return;
          }
          if (!args[0]) {
            const st = engine.songs.state();
            if (!st.current) { await engine.say(session, 'Сейчас ничего не играет. Заказ: !ср <ссылка на YouTube> 🎵'); return; }
            const q = st.queue.length;
            let line = `🎵 Сейчас: ${st.current.title}`;
            line += q ? ` · в очереди: ${q}` : ' · очередь пустая';
            line += st.paused ? ' · на паузе' : '';
            await engine.say(session, line.slice(0, 480));
            return;
          }
          // кому можно заказывать (стример — всегда; роли/фолловеры/личный список)
          const { requestAllowed } = await import('./songs.js');
          const gate = await requestAllowed(cfg, {
            level: session.level, login: session.login, userId: session.userId,
            broadcasterId: session.broadcasterId, helix: engine.helix,
          });
          if (!gate.ok) {
            const names = { everyone: 'все', sub: 'сабы', vip: 'випы', follower: 'фолловеры', mod: 'моды', broadcaster: 'стример' };
            const roles = (Array.isArray(cfg.allow) ? cfg.allow : []).map((r) => names[r] ?? r).join(', ');
            await engine.say(session, `Заказывать музыку могут: ${roles || 'все'} 🎵`);
            return;
          }
          // кулдаун на юзера между заказами
          const left = engine.songs.orderCooldownLeft(session.login);
          if (left > 0) {
            await engine.say(session, `@${session.login}, следующий заказ через ${left} сек ⏳`);
            return;
          }
          const { parseVideoId } = await import('./songs.js');
          const videoId = parseVideoId(args[0]);
          if (!videoId) { await engine.say(session, `@${session.login}, это не похоже на ссылку YouTube. Пример: !ср https://youtu.be/dQw4w9WgXcQ`); return; }
          const r = await engine.songs.add({ videoId, by: session.login, byName: session.displayName });
          if (r.error) {
            if (!r.silent) await engine.say(session, `@${session.login}, ${r.error}`);
            return;
          }
          const pos = r.position === 0 ? 'включаю сейчас! 🎵' : `в очереди на ${r.position}-м месте`;
          await engine.say(session, `🎵 ${r.song.title} — ${pos}`.slice(0, 480));
        },
      },
      песня: {
        level: 'everyone', label: 'то же, что !ср', desc: 'то же, что !ср',
        async run(session, args) { return engine.builtins['ср'].run(session, args); },
      },
      очередь: {
        level: 'everyone', label: 'очередь музыки', desc: 'очередь заказов',
        async run(session) {
          if (!engine.songs) { await engine.say(session, 'Плеер не настроен'); return; }
          const st = engine.songs.state();
          if (!st.queue.length) { await engine.say(session, 'Очередь пустая — заказывай: !ср <ссылка> 🎵'); return; }
          const list = st.queue.slice(0, 4).map((s, i) => `${i + 1}. ${s.title}`).join(' | ');
          await engine.say(session, `🎵 Очередь (${st.queue.length}): ${list}`.slice(0, 480));
        },
      },
      скип: {
        level: 'mod', label: 'пропустить трек (мод+)', desc: 'скипнуть трек',
        async run(session) {
          if (!engine.songs) { await engine.say(session, 'Плеер не настроен'); return; }
          const r = engine.songs.skip();
          if (r.error) { await engine.say(session, r.error); return; }
          const nextTitle = r.next ? '' : ' (очередь пустая)';
          await engine.say(session, `⏭ Трек скипнут${nextTitle}`);
        },
      },
      музыка: {
        level: 'everyone', label: 'управление: !музыка пауза|прод|стоп (мод+)', desc: 'пауза/стоп музыки',
        async run(session, args) {
          if (!engine.songs) { await engine.say(session, 'Плеер не настроен'); return; }
          const sub = String(args[0] || '').toLowerCase();
          if (!['пауза', 'прод', 'стоп'].includes(sub)) {
            await engine.say(session, 'Управление: !ср <ссылка> — заказ · !очередь · !скип / !музыка пауза|прод|стоп (мод+)');
            return;
          }
          if (levelValue(session.level || 'everyone') < LEVELS.mod) { await engine.say(session, 'Управлять музыкой могут только моды 🛡'); return; }
          const r = engine.songs.control(sub === 'прод' ? 'resume' : sub === 'пауза' ? 'pause' : 'stop');
          if (r.error) { await engine.say(session, r.error); return; }
          await engine.say(session, sub === 'пауза' ? '⏸ Музыка на паузе' : sub === 'прод' ? '▶️ Продолжаем' : '⏹ Музыка остановлена, очередь очищена');
        },
      },

      // ---------- цитаты канала ----------
      цитата: {
        level: 'everyone', label: 'цитата: !цитата [N] · поиск · добавить (мод+) · удалить (мод+)', desc: 'цитаты канала',
        async run(session, args) {
          if (!engine.quotes) { await engine.say(session, 'Цитаты не настроены'); return; }
          const q = engine.quotes;
          const fmt = (item) => `Цитата #${item.id}: ${item.text}`;
          const isMod = levelValue(session.level || 'everyone') >= levelValue('mod');
          const sub = String(args[0] || '').toLowerCase();

          if (!args[0]) { // случайная
            const item = q.random();
            await engine.say(session, item
              ? fmt(item)
              : 'Пока ни одной цитаты 🤷 Моды добавляют: !цитата добавить <текст>');
            return;
          }
          if (/^\d+$/.test(String(args[0]))) { // по номеру
            const item = q.byId(Number(args[0]));
            await engine.say(session, item ? fmt(item) : `Цитаты #${args[0]} нет 🤷`);
            return;
          }
          if (sub === 'поиск') {
            const query = args.slice(1).join(' ').trim();
            if (!query) { await engine.say(session, 'Использование: !цитата поиск <текст>'); return; }
            const found = q.search(query).slice(0, 3);
            await engine.say(session, found.length
              ? found.map(fmt).join(' · ').slice(0, 480)
              : `По запросу «${query}» ничего не нашла 🤷`);
            return;
          }
          if (sub === 'добавить') {
            if (!isMod) { await engine.say(session, 'Добавлять цитаты могут только модераторы 🤷'); return; }
            const text = args.slice(1).join(' ').trim();
            if (!text) { await engine.say(session, 'Использование: !цитата добавить <текст>'); return; }
            const item = q.add(session.login, text);
            await engine.say(session, `Цитата #${item.id} добавлена ✅`);
            return;
          }
          if (sub === 'удалить') {
            if (!isMod) { await engine.say(session, 'Удалять цитаты могут только модераторы 🤷'); return; }
            const target = String(args[1] || '');
            if (!/^\d+$/.test(target)) { await engine.say(session, 'Использование: !цитата удалить N'); return; }
            const item = q.remove(Number(target));
            await engine.say(session, item ? `Цитата #${item.id} удалена 🗑` : `Цитаты #${target} нет 🤷`);
            return;
          }
          await engine.say(session, 'Использование: !цитата [N] · !цитата поиск <текст> · !цитата добавить <текст> (мод+) · !цитата удалить N (мод+)');
        },
      },

      // ---------- OBS: сцены и источники ----------
      сцена: {
        level: 'mod', label: 'сменить сцену OBS: !сцена <имя> (мод+)', desc: 'сменить сцену OBS',
        async run(session, args) {
          if (!engine.obs) { await engine.say(session, 'OBS-интеграция не настроена'); return; }
          const name = args.join(' ').trim();
          if (!name) {
            let hint = 'Использование: !сцена <имя сцены>';
            try {
              const list = await engine.obs.getSceneList();
              if (list.scenes.length) hint += ` — доступные: ${list.scenes.join(', ')}`;
            } catch { /* OBS недоступен — подсказка и так понятна */ }
            await engine.say(session, hint.slice(0, 480));
            return;
          }
          try {
            await engine.obs.setCurrentProgramScene(name);
            await engine.say(session, `🎬 Сцена переключена: ${name}`);
          } catch (e) {
            let hint = `@${session.login}, не вышло: ${e.message}`;
            try {
              const list = await engine.obs.getSceneList();
              if (list.scenes.length) hint += ` — есть сцены: ${list.scenes.join(', ')}`;
            } catch { /* второй отказ OBS не должен глушить первый ответ */ }
            await engine.say(session, hint.slice(0, 480));
          }
        },
      },
      сцены: {
        level: 'mod', label: 'список сцен OBS (мод+)', desc: 'сцены OBS списком',
        async run(session) {
          if (!engine.obs) { await engine.say(session, 'OBS-интеграция не настроена'); return; }
          try {
            const list = await engine.obs.getSceneList();
            if (!list.scenes.length) { await engine.say(session, 'В OBS нет ни одной сцены 🤷'); return; }
            await engine.say(session, `🎬 Сцены OBS: ${list.scenes.join(', ')}${list.current ? ` — сейчас: ${list.current}` : ''}`.slice(0, 480));
          } catch (e) {
            await engine.say(session, `@${session.login}, не вышло: ${e.message}`);
          }
        },
      },
      addcmd: {
        level: 'mod', label: 'добавить: !addcmd !имя <ответ> (мод+)', desc: 'создать команду',
        async run(session, args) {
          const name = (args[0] || '').toLowerCase();
          const response = args.slice(1).join(' ').trim();
          if (!name || !response) { await engine.say(session, 'Использование: !addcmd !имя <текст ответа>. Пример: !addcmd !соцсети Все ссылки в шапке!'); return; }
          try {
            engine.upsert({ name, response, level: 'everyone', cooldown: 5 });
            await engine.say(session, `Команда !${name.replace(/^!/, '')} добавлена ✅`);
          } catch (e) {
            await engine.say(session, e.message);
          }
        },
      },
      editcmd: {
        level: 'mod', label: 'изменить: !editcmd !имя <новый ответ> (мод+)', desc: 'изменить команду',
        async run(session, args) {
          const name = (args[0] || '').toLowerCase();
          const response = args.slice(1).join(' ').trim();
          if (!name || !response) { await engine.say(session, 'Использование: !editcmd !имя <новый текст ответа>'); return; }
          const existing = engine.custom.find((c) => `!${c.name}` === name || c.name === name.replace(/^!/, ''));
          if (!existing) { await engine.say(session, `Команды ${name} нет — добавь сначала через !addcmd`); return; }
          try {
            engine.upsert({ ...existing, response });
            await engine.say(session, `Команда ${name} обновлена ✅`);
          } catch (e) {
            await engine.say(session, e.message);
          }
        },
      },
      delcmd: {
        level: 'mod', label: 'удалить: !delcmd !имя (мод+)', desc: 'удалить команду',
        async run(session, args) {
          const name = (args[0] || '').toLowerCase();
          if (!name) { await engine.say(session, 'Использование: !delcmd !имя'); return; }
          try {
            engine.remove(name);
            await engine.say(session, `Команда ${name} удалена 🗑`);
          } catch (e) {
            await engine.say(session, e.message);
          }
        },
      },
      bot: {
        level: 'everyone', label: 'кто я', desc: 'кто такой бот',
        async run(session) {
          await engine.say(session, 'Я локальный бот, работаю с ПК стримера. Ссылка на проект — https://github.com/Nanachi-meow/local-and-server-twitch-bot');
        },
      },
    };
  }

  builtinInfo() {
    return Object.entries(this.builtins).map(([name, b]) => {
      const ov = this.settings?.builtins?.access?.[name] ?? {};
      return {
        name: `!${name}`,
        level: (LEVELS[ov.level] !== undefined && ov.level) ? ov.level : b.level,
        allow: Array.isArray(ov.allow) ? ov.allow : [],
        label: b.label,
        desc: b.desc || b.label,
        enabled: this.builtinEnabled(name),
        builtin: true,
      };
    });
  }
}

/** Нормализация настроек TTS-озвучки оверлея: enabled булево, rate 0.5–2, volume 0–1, имя голоса до 80 символов. */
export function normalizeTts(t = {}) {
  const rate = Number(t?.rate);
  const volume = Number(t?.volume);
  return {
    enabled: Boolean(t?.enabled),
    rate: Number.isFinite(rate) ? Math.max(0.5, Math.min(2, rate)) : 1,
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1,
    voiceName: String(t?.voiceName ?? '').trim().slice(0, 80),
  };
}

/**
 * Слияние TTS-патча из панели с текущим значением и нормализация.
 * Частичный патч (только volume) не затирает остальные поля — в т.ч. voiceName
 * («фантомный» голос, которого нет в списке браузера, должен переживать сохранение).
 * Мусорный патч (не объект) не меняет текущее значение.
 */
export function mergeTts(cur = {}, patch = {}) {
  const merged = patch && typeof patch === 'object'
    ? { ...(cur ?? {}), ...patch }
    : { ...(cur ?? {}) };
  return normalizeTts(merged);
}

/** Нормализация настроек списка событий оверлея (alerts.eventList): вкл + размер 1–20. */
export function normalizeEventList(e = {}) {
  const size = Number(e?.size);
  return {
    enabled: Boolean(e?.enabled),
    size: Number.isFinite(size) ? Math.max(1, Math.min(20, Math.floor(size))) : 5,
  };
}

/**
 * Слияние eventList-патча из панели с текущим значением (по образцу mergeTts):
 * частичный патч (только enabled) не затирает size, мусорный патч не меняет ничего.
 */
export function mergeEventList(cur = {}, patch = {}) {
  const merged = patch && typeof patch === 'object'
    ? { ...(cur ?? {}), ...patch }
    : { ...(cur ?? {}) };
  return normalizeEventList(merged);
}

export function loadSettings() {
  const stored = loadJson(SETTINGS_FILE, {}) ?? {};
  const events = {};
  const defaults = {
    follow: { enabled: true, mode: 'chat', color: 'purple', pin: false, template: '💜 {user} зафолловил(а) канал — добро пожаловать в семью!' },
    raid: { enabled: true, mode: 'chat', color: 'purple', pin: false, template: '🚀 РЕЙД от {user}! {viewers} зрителей с нами — располагайтесь ❤️' },
    sub: { enabled: true, mode: 'chat', color: 'purple', pin: false, template: '🎉 {user} оформил(а) подписку! Спасибо за поддержку!' },
    resub: { enabled: true, mode: 'chat', color: 'purple', pin: false, template: '💜 {user} продлил(а) подписку — уже {months} мес. с нами! Спасибо!' },
    subgift: { enabled: true, mode: 'chat', color: 'purple', pin: false, template: '🎁 {user} дарит подписку → {recipient}! Щедрость уровня бог!' },
  };
  for (const [kind, def] of Object.entries(defaults)) {
    events[kind] = { ...def, ...(stored.events?.[kind] ?? {}) };
  }
  return {
    events,
    so: { template: 'Залетайте поддержать {target}: twitch.tv/{target_login} ❤️', ...(stored.so ?? {}) },
    announceColor: stored.announceColor || 'purple',
    autoShoutouts: {
      enabled: true,
      cooldownMinutes: 240,
      defaultTemplate: 'Стример {target} у нас в чате! Поддержим: twitch.tv/{target_login} ❤️',
      users: [],
      ...(stored.autoShoutouts ?? {}),
    },
    // оверлей-виджет автошатаута: аватарка + текст, раскладка как у плеера музыки
    shoutoutOverlay: {
      v: 1,
      duration: 10,       // сколько висит плашка, сек
      objects: [],        // пусто = дефолт: аватар сверху, текст ниже
      ...(stored.shoutoutOverlay ?? {}),
    },
    // «Слово дня»: слово выбирается само — самое частое в чате; раскладка редактором
    wordOfDay: {
      enabled: false,
      objects: [],        // v2: объекты (надпись/слово/счётчик/подложка/картинки); пусто = дефолт-карточка
      ...(stored.wordOfDay ?? {}),
    },
    autoPin: {
      enabled: true,
      mode: 'stream', // 'stream' = до конца стрима, '20' = 20 минут
      template: 'Добро пожаловать на стрим! 🎮 Правила: без спама и токсичности vibes. Соцсети — в шапке канала 💜',
      ...(stored.autoPin ?? {}),
    },
    timers: {
      enabled: true,
      onlyWhenLive: true, // писать периодические сообщения только в эфире
      items: [
        // пример — по умолчанию выключен, чтобы не спамить без спроса
        { id: 'sample-social', name: 'Соцсети', text: 'Подпишись на соцсети стримера — ссылки в шапке канала 💜', intervalMinutes: 15, minMessages: 5, mode: 'time', enabled: false },
      ],
      ...(stored.timers ?? {}),
    },
    alerts: {
      enabled: true,
      follow: { enabled: true, template: '💜 {user} зафолловил(а) канал!', sound: '', soundVolume: 85, media: '', duration: 5 },
      sub: { enabled: true, template: '🎉 {user} оформил(а) подписку!', sound: '', soundVolume: 85, media: '', duration: 6 },
      resub: { enabled: true, template: '💖 {user} продлил(а) подписку — уже {months} мес.!', sound: '', soundVolume: 85, media: '', duration: 6 },
      subgift: { enabled: true, template: '🎁 {user} дарит подписку → {recipient}!', sound: '', soundVolume: 85, media: '', duration: 6 },
      raid: { enabled: true, template: '🚀 РЕЙД от {user}! {viewers} зрителей с нами!', sound: '', soundVolume: 85, media: '', duration: 7 },
      meme: { enabled: true, duration: 6 },
      wheel: { enabled: true, duration: 5 },
      eventList: { enabled: false, size: 5 }, // список последних событий в углу оверлея
      tts: { enabled: false, rate: 1, volume: 1, voiceName: '' },
      ...(stored.alerts ?? {}),
    },
    redemptions: {
      enabled: true,
      cooldown: 30, // сек между overlay-алертами одного зрителя (лог ведётся всегда)
      mappings: [
        { rewardName: 'заказать песню', action: 'song', enabled: true },
        { rewardName: 'мем', action: 'meme', enabled: true },
        { rewardName: 'колесо', action: 'wheel', enabled: true },
        { rewardName: 'говорить', action: 'say', enabled: true },
      ],
      ...(stored.redemptions ?? {}),
    },
    wheel: {
      enabled: true,
      mode: 'reward', // 'reward' (наградой канала — главное) | 'command' (!колесо) | 'off'
      rewardName: 'колесо', // название награды-запуска
      cooldown: 60, // сек между вращениями одного юзера
      items: [
        { label: '💥 мимо', weight: 50 },
        { label: '🎊 приз', weight: 25 },
        { label: '✨ супер-приз', weight: 15 },
        { label: '💎 ДЖЕКПОТ', weight: 10 },
      ],
      overlay: {  // раскладка виджета-рулетки (1920×1080, редактор в панели)
        x: 760, y: 340, size: 400,      // центр и диаметр колеса, px сцены
        duration: 8,                    // сколько висит результат после остановки, сек
        spinSound: '',                  // файл из overlay-media (тик при вращении)
        winnerTemplate: '🏆 {user} → {label}',
      },
      ...(stored.wheel ?? {}),
    },
    memShop: {
      enabled: true,
      cooldown: 30, // сек между мемами одного зрителя (критик: без капа — спам алертами/TTS)
      items: [
        { name: 'ричка', text: '🐭 {user} запустил РИЧКУ!', sound: '', enabled: true },
        { name: 'жаба', text: '🐸 {user} напустил жабу в чат!', sound: '', enabled: true },
        { name: 'кринж', text: '😬 {user} устраивает сеанс кринжа', sound: '', enabled: true },
        { name: 'пирамида', text: '🔺 {user} построил пирамиду!', sound: '', enabled: true },
      ],
      ...(stored.memShop ?? {}),
    },
    obs: {
      enabled: false,     // OBS-интеграция (obs-websocket 5)
      host: '127.0.0.1',  // где стоит OBS (почти всегда локально)
      port: 4455,         // порт WebSocket-сервера OBS
      password: '',       // пароль из «Настройки WebSocket-сервера» OBS (хранится локально)
      ...(stored.obs ?? {}),
    },
    say: {
      enabled: true,
      cooldown: 60,   // сек между фразами одного зрителя
      blocked: ['спам', 'реклама'], // запрещённые слова (подстрока) — заполняет стример
      ...(stored.say ?? {}),
    },
    builtins: {
      disabled: [], // имена выключенных встроенных команд (панель: вкладка «Команды → Встроенные»)
      access: {}, // доступ встроенных: { [имя]: { level?, allow: [роли] } } — сильнее дефолтного level
      ...(stored.builtins ?? {}),
    },
    songs: (() => {
      const s = {
        enabled: true,
        maxLenSec: 600,  // длиннее — не принимаем
        perUser: 2,      // максимум треков юзера в очереди подряд
        volume: 60,      // громкость плеера (0–100) — применяется в /music
        nowTemplate: '♪ {title} — заказал {by}', // что показывать на оверлее
        requestMode: 'command', // 'command' (через !ср) | 'reward' (наградой за баллы)
        rewardName: '',        // название награды-заказа (для requestMode='reward')
        commandCooldown: 0,    // сек между заказами одного зрителя (0 = без кулдауна)
        commandName: 'ср',     // имя команды заказа — меняется в панели (синоим «ср»)
        refundOnReject: true,  // возвращать баллы, если трек не подошёл (чс/длина/просмотры/доступ)
        refundOnLimit: true,   // возвращать баллы при исчерпанном лимите юзера
        minViews: 0,           // минимум просмотров у трека (0 = не проверять)
        allow: [],             // кому можно заказывать: everyone/sub/vip/follower/mod/broadcaster (пусто = все)
        allowUsers: [],        // персональный белый список ников
        blacklist: [],         // чёрный список треков: [{ id, title }]
        playerCfg: {           // раскладка-оверлей OBS-плеера (редактор: Музыка → «📐 Раскладка»)
          v: 2,                 // v2 = объекты: видео/строка/подложка/свои картинки, всё в px сцены 1920×1080
          objects: [],           // пусто = редактор/OBS-страница строят дефолт (микро-экран + строка ниже)
        },
        ...(stored.songs ?? {}),
      };
      delete s.userMaxLengthSec; // миграция: лимит «суммарной длины» заменён на perUser (штук подряд)
      return s;
    })(),
    proxy: {
      enabled: false, // не настроен — все запросы напрямую
      url: '',        // http://127.0.0.1:8080 (только http-прокси)
      ...(stored.proxy ?? {}),
    },
  };
}
