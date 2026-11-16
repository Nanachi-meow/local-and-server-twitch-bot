import { COMMANDS_FILE, SETTINGS_FILE, loadJson, saveJson } from '../store.js';
import { renderTemplate, fmtDuration, humanizeSince, plural } from './render.js';
import { HelixError } from '../twitch/helix.js';
import { overlay } from './alerts.js';

export const LEVELS = { everyone: 0, sub: 1, vip: 2, mod: 3, broadcaster: 4 };

export const RESERVED = new Set([
  'commands', 'help', 'so', 'pin', 'unpin', 'announce', 'uptime', 'game', 'title',
  'followage', 'addcmd', 'editcmd', 'delcmd', 'bot',
  'баллы', 'топ', 'дать', 'перевести', 'колесо', 'мем', 'цитата',
  'ставка', 'ставить', 'итог', 'дуэль', 'сцена', 'сцены',
  'сказать', 'заказ', 'заказы',
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

  setPoints(points) {
    this.points = points;
  }

  setQuotes(quotes) {
    this.quotes = quotes;
  }

  setBets(bets) {
    this.bets = bets;
  }

  setObs(obs) {
    this.obs = obs;
  }

  setServices(services) {
    this.services = services;
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
      cost: Math.max(0, Math.min(100_000, Math.round(Number(cmd?.cost) || 0))), // цена в баллах, 0 = бесплатно
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

  // ---------------- обработка сообщений чата ----------------

  /** Обработка сообщения чата. opts.skipCost — не списывать цену (тест из панели). */
  async handleChatMessage({ broadcasterId, userId, login, displayName, text, badges }, opts = {}) {
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
    const builtin = this.builtins[name];
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
    const needLevel = custom ? custom.level : (builtin ? builtin.level : modCmd.level);
    if (levelValue(userLevelName) < levelValue(needLevel)) {
      return false; // молча игнорируем тех, кому нельзя
    }

    // кулдаун (кастомные и модульные команды)
    if ((custom || modCmd) && (cmd.cooldown ?? 0) > 0) {
      const key = custom ? `${bId}:${custom.name}:${userId}` : `${bId}:mod:${name}:${userId}`;
      const last = this._cool.get(key) || 0;
      if (Date.now() - last < cmd.cooldown * 1000) return false;
      this._cool.set(key, Date.now());
    }

    // цена команды в баллах (кастомные и модульные): списываем ДО выполнения.
    // Не хватило — молчаливый отказ, счётчики вызовов не двигаются.
    // PointsManager нет — цену игнорируем (команда бесплатно).
    if (!opts?.skipCost && (custom || modCmd) && (cmd.cost ?? 0) > 0 && this.points) {
      if (!this.points.spend(login, cmd.cost)) return false;
    }

    this.state.counters.commandsRun = (this.state.counters.commandsRun || 0) + 1;

    if (custom || modCmd) {
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

  // ---------------- встроенные команды ----------------

  get builtins() {
    const engine = this;
    return {
      commands: {
        level: 'everyone', label: 'список команд',
        async run(session) {
          const names = engine.custom.filter((c) => c.enabled !== false).map((c) => `!${c.name}`);
          const modNames = (engine.modules?.commandNames() ?? []).map((n) => `!${n}`);
          const base = ['!so', '!uptime', '!game', '!followage'];
          const all = [...base, ...names, ...modNames].join(', ');
          await engine.say(session, `Команды: ${all}`.slice(0, 480));
        },
      },
      help: {
        level: 'everyone', label: 'список команд',
        async run(session, args) { return engine.builtins.commands.run(session, args); },
      },
      uptime: {
        level: 'everyone', label: 'сколько стрим идёт',
        async run(session, args) {
          const vars = await engine.templateVars({ session, args });
          await engine.say(session, vars.uptime === 'оффлайн'
            ? `@${vars.user}, канал сейчас оффлайн 💤`
            : `Стрим идёт уже ${vars.uptime} ⏱`);
        },
      },
      game: {
        level: 'everyone', label: 'что стримится',
        async run(session, args) {
          const vars = await engine.templateVars({ session, args });
          await engine.say(session, `Сейчас стримится: ${vars.game} | ${vars.title}`);
        },
      },
      title: {
        level: 'everyone', label: 'название стрима',
        async run(session, args) {
          const vars = await engine.templateVars({ session, args });
          await engine.say(session, `Название стрима: ${vars.title}`);
        },
      },
      so: {
        level: 'mod', label: 'шатаут: !so <ник> (мод+)',
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
          await engine.say(session, renderTemplate(template, vars));
        },
      },
      pin: {
        level: 'mod', label: 'закрепить: !pin <текст> (мод+)',
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
        level: 'mod', label: 'снять закреп (мод+)',
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
        level: 'mod', label: 'анонс: !announce <цвет> <текст> (мод+)',
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
        level: 'everyone', label: 'сколько ты с нами: !followage [ник]',
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

      // ---------- баллы канала ----------
      баллы: {
        level: 'everyone', label: 'баллы: !баллы [ник]',
        async run(session, args) {
          if (!engine.points) { await engine.say(session, 'Баллы не настроены'); return; }
          const who = (args[0] || session.login).replace(/^@/, '').toLowerCase();
          const bal = engine.points.balance(who);
          const known = engine.points.store[who];
          await engine.say(session, who === session.login
            ? `@${session.login}, у тебя ${bal} ${plural(bal, ['балл', 'балла', 'баллов'])} 💎`
            : `${known?.name || who}: ${bal} ${plural(bal, ['балл', 'балла', 'баллов'])} 💎`);
        },
      },
      топ: {
        level: 'everyone', label: 'топ богачей канала',
        async run(session) {
          if (!engine.points) { await engine.say(session, 'Баллы не настроены'); return; }
          const rows = engine.points.top(5);
          if (!rows.length) { await engine.say(session, 'Пока никто не накопил баллов — сиди в чате, они капают за просмотр 💎'); return; }
          const text = rows.map((r, i) => `${i + 1}. ${r.login} — ${r.points}`).join(' | ');
          await engine.say(session, `Топ баллов: ${text} 💎`);
        },
      },
      дать: {
        level: 'mod', label: 'выдать баллы: !дать @ник N (мод+)',
        async run(session, args) {
          if (!engine.points) { await engine.say(session, 'Баллы не настроены'); return; }
          const to = (args[0] || '').replace(/^@/, '').toLowerCase();
          const n = Number(args[1]) || 0;
          if (!to || n <= 0) { await engine.say(session, 'Использование: !дать @ник сколько'); return; }
          engine.points.add(to, n);
          await engine.say(session, `@${session.login} выдал(а) ${to} ${n} ${plural(n, ['балл', 'балла', 'баллов'])} 💎`);
        },
      },
      перевести: {
        level: 'everyone', label: 'передать баллы: !перевести @ник N',
        async run(session, args) {
          if (!engine.points) { await engine.say(session, 'Баллы не настроены'); return; }
          const to = (args[0] || '').replace(/^@/, '');
          const n = Number(args[1]) || 0;
          if (!to || n <= 0) { await engine.say(session, 'Использование: !перевести @ник сколько'); return; }
          const r = await engine.points.transfer(session.login, to, n);
          if (!r.ok) { await engine.say(session, `@${session.login}, не вышло: ${r.error}`); return; }
          await engine.say(session, `@${session.login} перевёл(а) ${n} ${plural(n, ['балл', 'балла', 'баллов'])} → @${r.to} 💎 (осталось ${r.balance})`);
        },
      },

      // ---------- колесо-рулетка за баллы ----------
      колесо: {
        level: 'everyone', label: 'рулетка: !колесо N — крути на баллы',
        async run(session, args) {
          if (!engine.points) { await engine.say(session, 'Баллы не настроены'); return; }
          const cfg = engine.points.settings?.wheel ?? {};
          const bet = Number(args[0]) || 0;
          if (bet <= 0) { await engine.say(session, `Использование: !колесо ставка (от ${cfg.minBet ?? 10} до ${cfg.maxBet ?? 1000}) 🎡`); return; }
          const r = engine.points.spin(session.login, session.displayName, bet);
          if (r.error) { await engine.say(session, `@${session.login}, ${r.error}`); return; }
          overlay.push({ kind: 'wheel', channel: null, user: session.displayName || session.login, text: `${session.displayName || session.login}: ${r.item.label}` });
          const verdict = r.multiplier === 0
            ? 'ставка сгорела 💥'
            : r.multiplier === 1
              ? 'ставка вернулась 🙂'
              : `выигрыш x${r.multiplier}! 🎉`;
          await engine.say(session, `🎡 ${session.displayName || session.login} поставил(а) ${r.bet} → ${r.item.label} — ${verdict} (баланс: ${engine.points.balance(session.login)})`);
        },
      },

      // ---------- мем-магазин за баллы ----------
      мем: {
        level: 'everyone', label: 'купить мем-алерт: !мем [название]',
        async run(session, args) {
          if (!engine.points) { await engine.say(session, 'Баллы не настроены'); return; }
          const r = engine.points.buyMeme(session.login, session.displayName, args[0] ?? '');
          if (r.error) { await engine.say(session, `@${session.login}, ${r.error}`); return; }
          if (r.list) {
            await engine.say(session, `Мем-магазин: ${r.list.slice(0, 6).join(' · ') || 'пусто'}. Покупка: !мем название 💎`);
            return;
          }
          await engine.say(session, `@${session.login} купил(а) «${r.item.name}» за ${r.price} ${plural(r.price, ['балл', 'балла', 'баллов'])} — смотри стрим! 🎬 (осталось: ${engine.points.balance(session.login)})`);
        },
      },

      // ---------- говорилка: TTS за баллы ----------
      сказать: {
        level: 'everyone', label: 'TTS за баллы: !сказать <текст>',
        async run(session, args) {
          if (!engine.points) { await engine.say(session, 'Баллы не настроены'); return; }
          const cfg = {
            enabled: true,
            price: 50,
            cooldown: 60, // сек между фразами одного зрителя
            blocked: [], // запрещённые слова (по подстроке, без учёта регистра)
            ...(engine.settings?.say ?? {}),
          };
          const text = args.join(' ').trim();
          if (!cfg.enabled) { await engine.say(session, 'Говорилка сейчас выключена 🙅'); return; }
          if (!text) {
            await engine.say(session, `Использование: !сказать <текст> — озвучу на стриме за ${cfg.price} ${plural(cfg.price, ['балл', 'балла', 'баллов'])} 🔊`);
            return;
          }
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
          if (!overlay.clients.size) {
            await engine.say(session, 'Оверлей не открыт (добавь его в OBS или открой в браузере) — баллы не списаны');
            return;
          }
          if (cfg.price > 0 && !engine.points.spend(session.login, cfg.price)) {
            await engine.say(session, `@${session.login}, нужно ${cfg.price} ${plural(cfg.price, ['балл', 'балла', 'баллов'])}, а у тебя меньше`);
            return;
          }
          engine._cool.set(key, Date.now());
          const who = session.displayName || session.login;
          overlay.push({ kind: 'meme', channel: null, user: who, text: `🗣 ${who}: ${text}`, sound: '' });
          await engine.say(session, `🔊 @${session.login}, озвучено за ${cfg.price} ${plural(cfg.price, ['балл', 'балла', 'баллов'])} (осталось: ${engine.points.balance(session.login)})`);
        },
      },

      // ---------- магазин услуг (redemption store) ----------
      заказ: {
        level: 'everyone', label: 'заказать услугу: !заказ <название>',
        async run(session, args) {
          if (!engine.points) { await engine.say(session, 'Баллы не настроены'); return; }
          if (!engine.services) { await engine.say(session, 'Магазин услуг не настроен'); return; }
          const r = engine.services.order({ login: session.login, name: session.displayName, serviceName: args[0] ?? '' });
          if (r.error) { await engine.say(session, `@${session.login}, ${r.error}`); return; }
          if (r.list) {
            await engine.say(session, `Услуги: ${r.list.slice(0, 6).join(' · ') || 'пока пусто — настроь в панели'}. Заказ: !заказ название 💎`);
            return;
          }
          await engine.say(session, `🛎 @${session.login}, заказ «${r.order.service}» принят за ${r.price} ${plural(r.price, ['балл', 'балла', 'баллов'])} — ждём выполнения (баланс: ${engine.points.balance(session.login)})`);
        },
      },
      заказы: {
        level: 'mod', label: 'ждущие заказы: !заказы (мод+)',
        async run(session) {
          if (!engine.services) { await engine.say(session, 'Магазин услуг не настроен'); return; }
          const list = engine.services.pending();
          if (!list.length) { await engine.say(session, 'Ждущих заказов нет 🎉'); return; }
          const rows = list.slice(0, 8).map((o) => `#${o.id} ${o.service} — @${o.login}`);
          await engine.say(session, (`🛎 Ждут выполнения: ${rows.join(' · ')}`).slice(0, 480));
        },
      },

      // ---------- цитаты канала ----------
      цитата: {
        level: 'everyone', label: 'цитата: !цитата [N] · поиск · добавить (мод+) · удалить (мод+)',
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

      // ---------- ставки на исходы и дуэли за баллы ----------
      ставка: {
        level: 'everyone', label: 'тотализатор: !ставка — текущая; !ставка открыть <вопрос> <в1|в2> (мод+)',
        async run(session, args) {
          if (!engine.bets) { await engine.say(session, 'Ставки не настроены'); return; }
          const ch = session.broadcasterId;
          if ((args[0] || '').toLowerCase() === 'открыть') {
            if (levelValue(session.level ?? 'everyone') < LEVELS.mod) {
              await engine.say(session, 'ставки открывать могут только моды 🛡');
              return;
            }
            // вопрос — всё до последнего токена с «|» (токен с «|» — список вариантов)
            const tokens = args.slice(1).join(' ').trim().split(/\s+/).filter(Boolean);
            let qTokens = tokens;
            let optToken = '';
            for (let i = tokens.length - 1; i >= 0; i--) {
              if (tokens[i].includes('|')) { optToken = tokens[i]; qTokens = tokens.slice(0, i); break; }
            }
            const labels = optToken.split('|').map((s) => s.trim()).filter(Boolean);
            const r = engine.bets.open({ channelId: ch, question: qTokens.join(' ').trim(), options: labels });
            if (r.error) {
              await engine.say(session, `@${session.login}, ${r.error}. Пример: !ставка открыть кто победит Али|Боби|Ничья`.slice(0, 480));
              return;
            }
            const cfg = engine.bets.cfg();
            const list = r.options.map((label, i) => `${i + 1}) ${label}`).join(' ');
            await engine.say(session, (`📈 Ставка открыта: «${r.question}» — ${list}. Ставить: !ставить сумма номер (${cfg.minBet}–${cfg.maxBet}), на всё ${r.durationSec} сек`).slice(0, 480));
            return;
          }
          const st = engine.bets.status(ch);
          if (!st) {
            await engine.say(session, 'Сейчас нет открытой ставки. Моды открывают: !ставка открыть <вопрос> <вариант1|вариант2>');
            return;
          }
          const list = st.options.map((o) => `${o.index}) ${o.label} (${o.total})`).join(' · ');
          await engine.say(session, (`📊 Ставка: «${st.question}» — ${list} — банк ${st.pot}, осталось ${st.secondsLeft} сек. Ставить: !ставить сумма номер`).slice(0, 480));
        },
      },
      ставить: {
        level: 'everyone', label: 'поставить баллы: !ставить <сумма> <номер варианта>',
        async run(session, args) {
          if (!engine.bets || !engine.points) { await engine.say(session, 'Ставки не настроены'); return; }
          const n = Number(args[0]) || 0;
          const idx = Number(args[1]) || 0;
          if (n <= 0 || idx <= 0) { await engine.say(session, 'Использование: !ставить <сколько> <номер варианта> — например: !ставить 100 1'); return; }
          if (!Number.isInteger(n)) { await engine.say(session, `@${session.login}, сумма ставки — целое число`); return; }
          if (!Number.isInteger(idx)) { await engine.say(session, `@${session.login}, номер варианта — целое число`); return; }
          const r = engine.bets.place({ channelId: session.broadcasterId, login: session.login, name: session.displayName, optionIndex: idx, amount: n });
          if (r.error) { await engine.say(session, `@${session.login}, ${r.error}`); return; }
          if (!engine.points.spend(session.login, r.amount)) {
            engine.bets.unplace({ channelId: session.broadcasterId, login: session.login, optionIndex: r.optionIndex }); // запись откатываем, баллы не тронуты
            await engine.say(session, `@${session.login}, не хватает баллов`);
            return;
          }
          await engine.say(session, `✅ ${session.displayName || session.login} поставил(а) ${r.amount} ${plural(r.amount, ['балл', 'балла', 'баллов'])} на «${r.option}» (вариант ${r.optionIndex}) — банк: ${r.optionTotal}, всего: ${r.pot}, осталось ${r.secondsLeft} сек`);
        },
      },
      итог: {
        level: 'mod', label: 'подвести итог ставки: !итог <номер> (мод+)',
        async run(session, args) {
          if (!engine.bets || !engine.points) { await engine.say(session, 'Ставки не настроены'); return; }
          const idx = Number(args[0]) || 0;
          if (!Number.isInteger(idx)) { await engine.say(session, `@${session.login}, номер варианта — целое число`); return; }
          if (!idx) {
            const st = engine.bets.status(session.broadcasterId);
            await engine.say(session, st
              ? `Активная ставка: «${st.question}» — варианты: ${st.options.map((o) => o.index).join(', ')}. Закрыть: !итог <номер>`
              : 'Сейчас нет открытой ставки');
            return;
          }
          const r = engine.bets.resolve({ channelId: session.broadcasterId, winnerIndex: idx });
          if (r.error) { await engine.say(session, `@${session.login}, ${r.error}`); return; }
          for (const p of r.payouts) engine.points.add(p.login, p.amount);
          for (const ref of r.refunds ?? []) engine.points.add(ref.login, ref.amount);
          if (!r.payouts.length) {
            await engine.say(session, (r.refunds ?? []).length
              ? `🏁 Исход: «${r.winner}» — ставка закрыта без победителя, баллы возвращены 🙂`
              : `🏁 Исход: «${r.winner}» — ставок не было, банк пуст`);
            return;
          }
          const top = (r.top ?? []).slice(0, 3).map((w, i) => `${i + 1}. ${w.name || w.login} +${w.amount}`).join(' · ');
          await engine.say(session, (`🏁 Исход: «${r.winner}» — банк ${r.pot}${r.fee ? ` (комиссия ${r.fee}%)` : ''}. Победители: ${top} 🎉`).slice(0, 480));
        },
      },
      дуэль: {
        level: 'everyone', label: 'дуэль на баллы: !дуэль @ник N (принять — той же, снять — !дуэль отмена)',
        async run(session, args) {
          if (!engine.bets || !engine.points) { await engine.say(session, 'Ставки не настроены'); return; }
          const ch = session.broadcasterId;
          // «!дуэль отмена»: снять ждущий вызов может инициатор или моды
          if ((args[0] || '').trim().toLowerCase() === 'отмена') {
            const du = engine.bets.pendingDuel(ch);
            if (!du) { await engine.say(session, 'Сейчас никто никого не вызывает — отменять нечего 🙂'); return; }
            const isInitiator = du.from.login === String(session.login).toLowerCase();
            const isMod = levelValue(session.level ?? 'everyone') >= LEVELS.mod;
            if (!isInitiator && !isMod) {
              await engine.say(session, `@${session.login}, отменить вызов может ${du.from.name || du.from.login} или моды`);
              return;
            }
            engine.bets.cancelChallenge({ channelId: ch });
            engine.points.add(du.from.login, du.amount);
            await engine.say(session, `⚔️ Дуэль ${du.from.name || du.from.login} → @${du.to} отменена${isMod && !isInitiator ? ' модами' : ''}, ставка ${du.amount} вернулась к ${du.from.name || du.from.login} 🙂`);
            return;
          }
          const targetRaw = (args[0] || '').trim();
          const n = Number(args[1]) || 0;
          if (!targetRaw || n <= 0) {
            const du = engine.bets.pendingDuel(ch);
            await engine.say(session, du
              ? `${du.from.name || du.from.login} вызывает @${du.to} на ${du.amount}! @${du.to}, прими: !дуэль @${du.from.login} ${du.amount} ⚔️`
              : 'Использование: !дуэль @ник сумма — вызов на дуэль (баллы списываются сразу; снять можно: !дуэль отмена)');
            return;
          }
          if (!Number.isInteger(n)) { await engine.say(session, `@${session.login}, сумма дуэли — целое число`); return; }
          const target = targetRaw.replace(/^@/, '').toLowerCase();
          const pending = engine.bets.pendingDuel(ch);
          // если вызванный зовут нас — это принятие вызова, а не новый вызов
          if (pending && pending.to === String(session.login).toLowerCase()) {
            if (target !== pending.from.login || n !== pending.amount) {
              await engine.say(session, `@${session.login}, тебя вызвал(а) ${pending.from.name || pending.from.login} на ${pending.amount} — прими ровно так: !дуэль @${pending.from.login} ${pending.amount} ⚔️`);
              return;
            }
            if (engine.points.balance(session.login) < pending.amount) {
              engine.bets.cancelChallenge({ channelId: ch });
              engine.points.add(pending.from.login, pending.amount); // отказ — возврат вызвавшему
              await engine.say(session, `у @${session.login} не хватает баллов — дуэль отменена, ставка ${pending.amount} вернулась к ${pending.from.name || pending.from.login} 🙂`);
              return;
            }
            const r = engine.bets.accept({ channelId: ch, login: session.login, name: session.displayName });
            if (r.error) { await engine.say(session, `@${session.login}, ${r.error}`); return; }
            if (!engine.points.spend(session.login, r.amount)) {
              engine.points.add(r.from.login, r.amount); // страховка: дуэль уже снята, возвращаем ставку
              await engine.say(session, `у @${session.login} не хватает баллов — дуэль отменена, ставка вернулась к ${r.from.name || r.from.login} 🙂`);
              return;
            }
            engine.points.add(r.winnerLogin, r.prize);
            const winName = r.winner === 'a' ? (r.from.name || r.from.login) : (r.to.name || r.to.login);
            await engine.say(session, `⚔️ Дуэль: ${r.from.name || r.from.login} против ${r.to.name || r.to.login} на ${r.amount} — победил ${winName}! +${r.prize} ${plural(r.prize, ['балл', 'балла', 'баллов'])}`);
            return;
          }
          // новый вызов: жертва должна существовать на Twitch — баллы не списываем в пустоту
          const victim = await engine.helix.getUserByLogin(target).catch(() => null);
          if (!victim) { await engine.say(session, `@${session.login}, не нашла на Twitch пользователя "${target}" 🤷`); return; }
          const r = engine.bets.challenge({ channelId: ch, fromLogin: session.login, fromName: session.displayName, toLogin: target, amount: n });
          if (r.error) { await engine.say(session, `@${session.login}, ${r.error}`); return; }
          if (!engine.points.spend(session.login, r.amount)) {
            engine.bets.cancelChallenge({ channelId: ch }); // вызов не состоялся
            await engine.say(session, `@${session.login}, не хватает баллов на вызов`);
            return;
          }
          await engine.say(session, `⚔️ ${session.displayName || session.login} вызывает @${r.to} на дуэль на ${r.amount} ${plural(r.amount, ['балл', 'балла', 'баллов'])}! @${r.to}, принимай: !дуэль @${session.login} ${r.amount}`);
        },
      },
      // ---------- OBS: сцены и источники ----------
      сцена: {
        level: 'mod', label: 'сменить сцену OBS: !сцена <имя> (мод+)',
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
        level: 'mod', label: 'список сцен OBS (мод+)',
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
        level: 'mod', label: 'добавить: !addcmd !имя <ответ> (мод+)',
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
        level: 'mod', label: 'изменить: !editcmd !имя <новый ответ> (мод+)',
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
        level: 'mod', label: 'удалить: !delcmd !имя (мод+)',
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
        level: 'everyone', label: 'кто я',
        async run(session) {
          await engine.say(session, 'Я локальный бот, живу на компе стримера. Настройки на её стороне 😎 Никаких облаков!');
        },
      },
    };
  }

  builtinInfo() {
    return Object.entries(this.builtins).map(([name, b]) => ({
      name: `!${name}`,
      level: b.level,
      label: b.label,
      builtin: true,
    }));
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
      follow: { enabled: true, template: '💜 {user} зафолловил(а) канал!', sound: '', duration: 5 },
      sub: { enabled: true, template: '🎉 {user} оформил(а) подписку!', sound: '', duration: 6 },
      resub: { enabled: true, template: '💖 {user} продлил(а) подписку — уже {months} мес.!', sound: '', duration: 6 },
      subgift: { enabled: true, template: '🎁 {user} дарит подписку → {recipient}!', sound: '', duration: 6 },
      raid: { enabled: true, template: '🚀 РЕЙД от {user}! {viewers} зрителей с нами!', sound: '', duration: 7 },
      meme: { enabled: true, duration: 6 },
      wheel: { enabled: true, duration: 5 },
      eventList: { enabled: false, size: 5 }, // список последних событий в углу оверлея
      tts: { enabled: false, rate: 1, volume: 1, voiceName: '' },
      ...(stored.alerts ?? {}),
    },
    points: {
      enabled: true,
      intervalMin: 10, // раз в столько минут — опрос чаттеров
      amount: 10,      // столько баллов за интервал просмотра
      perMessage: 1,   // бонус за сообщение в чате (0 = выкл)
      ...(stored.points ?? {}),
    },
    wheel: {
      enabled: true,
      minBet: 10,
      maxBet: 1000,
      cooldown: 60, // сек между спинами одного юзера
      items: [
        { label: '💥 мимо', weight: 50, multiplier: 0 },
        { label: '🙂 возврат ставки', weight: 20, multiplier: 1 },
        { label: '✌️ x2', weight: 18, multiplier: 2 },
        { label: '🔥 x3', weight: 8, multiplier: 3 },
        { label: '🚀 x5', weight: 3.5, multiplier: 5 },
        { label: '💎 ДЖЕКПОТ x10', weight: 0.5, multiplier: 10 },
      ],
      ...(stored.wheel ?? {}),
    },
    memShop: {
      enabled: true,
      cooldown: 30, // сек между покупками одного зрителя (критик: без капа — спам алертами/TTS)
      items: [
        { name: 'ричка', price: 150, text: '🐭 {user} запустил РИЧКУ!', sound: '', enabled: true },
        { name: 'жаба', price: 200, text: '🐸 {user} напустил жабу в чат!', sound: '', enabled: true },
        { name: 'кринж', price: 100, text: '😬 {user} оплатил сеанс кринжа', sound: '', enabled: true },
        { name: 'пирамида', price: 300, text: '🔺 {user} построил пирамиду за баллы', sound: '', enabled: true },
      ],
      ...(stored.memShop ?? {}),
    },
    bets: {
      enabled: true,    // тотализатор и дуэли
      fee: 0,           // комиссия с банка при выплатах, % (0–10)
      durationSec: 300, // сколько живёт ставка (и сколько ждёт ответа дуэль)
      minBet: 10,
      maxBet: 1000,
      duelCooldown: 60, // сек между дуэлями одного юзера
      ...(stored.bets ?? {}),
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
      price: 50,      // баллов за фразу
      cooldown: 60,   // сек между фразами одного зрителя
      blocked: ['спам', 'реклама'], // запрещённые слова (подстрока) — заполняет стример
      ...(stored.say ?? {}),
    },
  };
}
