import { renderTemplate } from './render.js';
import { HelixError } from '../twitch/helix.js';

export const EVENT_KINDS = ['follow', 'raid', 'sub', 'resub', 'subgift'];

const TEST_VARS = {
  follow: { user: 'ТестовыйФолловер' },
  raid: { user: 'ТестРейдер', viewers: 42 },
  sub: { user: 'ТестовыйСаббер' },
  resub: { user: 'ТестовыйСаббер', months: 12 },
  subgift: { user: 'ТестовыйДаритель', recipient: 'ТестовыйДруг' },
};

/**
 * Обработка входящих EventSub-событий: чат, уведомления (сабы/рейды), фоллоу.
 * Мультиканальная: каждое событие несёт broadcaster_user_id — реакция уходит в тот же канал.
 */
export class EventProcessor {
  constructor({ helix, auth, logs, settings, state, channels = null }) {
    this.helix = helix;
    this.auth = auth;
    this.logs = logs;
    /** @type {import('./commands.js').CommandEngine} */
    this.commands = null;
    this.settings = settings; // живой объект настроек из index.js
    this.state = state;
    this.channels = channels; // реестр каналов
    this.ctx = { broadcasterId: null, channel: '' }; // запасной контекст (панель/тесты)
    this._recentRaids = new Map(); // `${channelId}:${login}` -> ts
    this._recentFollows = new Map();
    this._autoSo = new Map(); // автошатауты: `${channelId}:${login}` -> ts
  }

  setContext(ctx) {
    Object.assign(this.ctx, ctx);
  }

  setChannels(channels) {
    this.channels = channels;
  }

  setCommands(engine) {
    this.commands = engine;
  }

  _isOurChannel(bId) {
    if (!bId) return false;
    if (this.channels) return Boolean(this.channels.get(bId));
    return String(bId) === String(this.ctx.broadcasterId);
  }

  async dispatch(type, event) {
    switch (type) {
      case 'channel.chat.message':
        await this.onChatMessage(event);
        break;
      case 'channel.chat.notification':
        await this.onChatNotification(event);
        break;
      case 'channel.follow':
        await this.onFollow(event);
        break;
      case 'channel.raid':
        await this.onRaid({
          user: event?.from_broadcaster_user_name,
          login: event?.from_broadcaster_user_login,
          viewers: event?.viewers,
          toId: event?.to_broadcaster_user_id,
        });
        break;
      case 'stream.online':
        await this.onStreamOnline(event);
        break;
      case 'stream.offline':
        await this.onStreamOffline(event);
        break;
      default:
        break;
    }
  }

  // ---------------- чат ----------------

  async onChatMessage(m) {
    const bId = m?.broadcaster_user_id;
    const channel = this._isOurChannel(bId) ? (this.channels?.loginOf(bId) ?? null) : null;
    this.logs.chat.push({
      channel,
      login: m?.chatter_user_login,
      user: m?.chatter_user_name,
      text: m?.message?.text ?? '',
      level: userLevelBadge(m, bId),
    });
    try {
      // автошатаут: человек из списка написал сообщение → приветственная карточка
      await this.maybeAutoShoutout(m);
    } catch (e) {
      this.logs.system.push({ level: 'error', message: `Автошатаут не сработал: ${e.message}` });
    }
    try {
      await this.commands?.handleChatMessage({
        broadcasterId: bId,
        userId: m?.chatter_user_id,
        login: m?.chatter_user_login,
        displayName: m?.chatter_user_name,
        text: m?.message?.text ?? '',
        badges: m?.badges ?? [],
      });
    } catch (e) {
      this.logs.system.push({ level: 'error', message: `Ошибка обработки сообщения: ${e.message}` });
    }
  }

  // ---------------- уведомления чата (сабы, рейды и т.п.) ----------------

  async onChatNotification(n) {
    const bId = n?.broadcaster_user_id;
    if (!this._isOurChannel(bId)) return;
    const channel = this.channels?.loginOf(bId) ?? this.ctx.channel;
    const chatter = n?.chatter_user_name || 'кто-то';
    let notice = (n?.notice_type || '').replace(/^shared_chat_/, '');

    if (notice === 'raid' && n?.raid) {
      await this.onRaid({
        user: n.raid.user_name || chatter,
        login: n.raid.user_login,
        viewers: n.raid.viewer_count ?? 0,
        toId: bId,
      });
      return;
    }
    if (notice === 'unraid') {
      this.logs.events.push({ kind: 'unraid', channel, text: `${chatter} отменил(а) рейд` });
      return;
    }
    if (notice === 'sub' && n?.sub) {
      this.state.counters.sub = (this.state.counters.sub || 0) + 1;
      await this.fire('sub', { user: chatter }, { broadcasterId: bId });
      return;
    }
    if (notice === 'resub' && n?.resub) {
      this.state.counters.sub = (this.state.counters.sub || 0) + 1;
      await this.fire('resub', { user: chatter, months: n.resub.cumulative_months ?? 0 }, { broadcasterId: bId });
      return;
    }
    if (notice === 'sub_gift' && n?.sub_gift) {
      this.state.counters.sub = (this.state.counters.sub || 0) + 1;
      await this.fire('subgift', {
        user: chatter,
        recipient: n.sub_gift.recipient_user_name || 'зрителю',
      }, { broadcasterId: bId });
      return;
    }
    if (notice === 'community_sub_gift' && n?.community_sub_gift) {
      this.logs.events.push({
        kind: 'subgift', channel,
        text: `${chatter} подарил(а) ${n.community_sub_gift.count ?? '?'} подписок сообществу!`,
      });
      return;
    }
    // всё остальное — просто в ленту событий
    if (n?.system_message) {
      this.logs.events.push({ kind: notice || 'notice', channel, text: n.system_message });
    }
  }

  // ---------------- фоллоу и рейды ----------------

  async onFollow(e) {
    const bId = e?.broadcaster_user_id;
    if (!this._isOurChannel(bId)) return;
    const channel = this.channels?.loginOf(bId) ?? this.ctx.channel;
    const login = e?.user_login || e?.user_name || '';
    const now = Date.now();
    const key = `${bId}:${login}`;
    const last = this._recentFollows.get(key) || 0;
    if (now - last < 60_000) return; // дедуп
    this._recentFollows.set(key, now);
    this.state.counters.follow = (this.state.counters.follow || 0) + 1;
    this.logs.events.push({ kind: 'follow', channel, text: `Новый фоллоу: ${e?.user_name || login}` });
    await this.fire('follow', { user: e?.user_name || login }, { broadcasterId: bId });
  }

  async onRaid({ user, login, viewers, toId }) {
    if (!this._isOurChannel(toId)) return;
    const channel = this.channels?.loginOf(toId) ?? this.ctx.channel;
    const now = Date.now();
    const key = `${toId}:${login || user}`;
    const last = this._recentRaids.get(key) || 0;
    if (now - last < 90_000) return; // дедуп channel.raid + chat.notification
    this._recentRaids.set(key, now);
    this.state.counters.raid = (this.state.counters.raid || 0) + 1;
    this.logs.events.push({
      kind: 'raid', channel,
      text: `РЕЙД от ${user}${viewers ? ` с ${viewers} зрителями` : ''}!`,
    });
    await this.fire('raid', { user, viewers: viewers ?? 0 }, { broadcasterId: toId });
  }

  // ---------------- отправка сообщений о событиях ----------------

  async fire(kind, vars = {}, { force = false, broadcasterId } = {}) {
    const bId = broadcasterId ?? this.ctx.broadcasterId;
    const channel = this.channels?.loginOf(bId) ?? this.ctx.channel;
    const cfg = this.settings?.events?.[kind];
    const text = cfg ? renderTemplate(cfg.template, { channel, ...vars }) : '';
    if (!cfg || (!cfg.enabled && !force)) {
      if (cfg) this.logs.events.push({ kind, channel, text: `[отключено] ${text}` });
      return;
    }
    // тестовые события тоже попадают в ленту
    if (force) this.logs.events.push({ kind, channel, text: `[тест] ${text}` });
    if (!text) return;
    try {
      if (cfg.mode === 'announce') {
        await this.helix.announce({
          broadcasterId: bId,
          moderatorId: this.auth.tokens?.userId,
          text,
          color: cfg.color || 'purple',
        });
      } else {
        await this.helix.sendMessage({
          broadcasterId: bId,
          senderId: this.auth.tokens?.userId,
          text,
          pin: Boolean(cfg.pin),
        });
      }
    } catch (e) {
      const message = e instanceof HelixError && e.status === 403
        ? 'нет прав (бот должен быть модератором канала)'
        : e.message;
      this.logs.system.push({ level: 'error', message: `Событие ${kind}${channel ? ` (#${channel})` : ''} не отправлено: ${message}` });
    }
  }

  /** Кнопка «Тест» в панели: прогоняем событие с подставными данными. */
  async test(kind, overrides = {}, opts = {}) {
    const vars = { ...(TEST_VARS[kind] ?? { user: 'Тест' }), ...overrides };
    await this.fire(kind, vars, { force: true, broadcasterId: opts.broadcasterId ?? this.ctx.broadcasterId });
  }

  // ---------------- стрим начал шанс / закончился ----------------

  async onStreamOnline(e) {
    const bId = e?.broadcaster_user_id;
    if (!this._isOurChannel(bId)) return;
    const channel = this.channels?.loginOf(bId) ?? this.ctx.channel;
    this.logs.events.push({ kind: 'online', channel, text: 'Стрим начался! 🟢' });
    await this.autoPin(bId);
  }

  async onStreamOffline(e) {
    const bId = e?.broadcaster_user_id;
    if (!this._isOurChannel(bId)) return;
    const channel = this.channels?.loginOf(bId) ?? this.ctx.channel;
    // закреп Twitch снимается сам по окончании стрима
    this.logs.events.push({ kind: 'offline', channel, text: 'Стрим закончился 🌙' });
  }

  /**
   * Автозакреп: отправить сообщение и закрепить в чате.
   * mode 'stream' — закреп «до конца стрима» (официальный режим Twitch),
   * mode '20' — закреп на 20 минут (pin:true прямо в отправке).
   */
  async autoPin(broadcasterId) {
    const cfg = this.settings?.autoPin;
    if (!cfg?.enabled) return null;
    const channel = this.channels?.loginOf(broadcasterId) ?? this.ctx.channel;
    const text = renderTemplate(cfg.template || '', { channel });
    if (!text) return null;
    try {
      if (cfg.mode === '20') {
        await this.helix.sendMessage({
          broadcasterId,
          senderId: this.auth.tokens?.userId,
          text,
          pin: true,
        });
      } else {
        const sent = await this.helix.sendMessage({
          broadcasterId,
          senderId: this.auth.tokens?.userId,
          text,
        });
        if (!sent?.message_id) return null;
        await this.helix.pinMessage({
          broadcasterId,
          moderatorId: this.auth.tokens?.userId,
          messageId: sent.message_id,
          // durationSeconds не передаём — Twitch закрепит «до конца стрима»
        });
      }
      this.logs.events.push({ kind: 'автозакреп', channel, text });
      return text;
    } catch (e) {
      const message = e.status === 403 ? 'нет прав (бот должен быть модератором канала)' : e.message;
      this.logs.system.push({ level: 'error', message: `Автозакреп${channel ? ` (#${channel})` : ''}: ${message}` });
      return null;
    }
  }

  // ---------------- автошатауты ----------------

  /** Человек из списка написал в чат → сам кидаем шатаут с его кастомным текстом. */
  async maybeAutoShoutout(m) {
    const cfg = this.settings?.autoShoutouts;
    if (!cfg?.enabled || !Array.isArray(cfg?.users) || !cfg.users.length) return;
    const bId = m?.broadcaster_user_id;
    if (!this._isOurChannel(bId)) return;
    const login = String(m?.chatter_user_login || '').toLowerCase();
    if (!login || login === this.auth.tokens?.login) return;
    const entry = cfg.users.find((u) => String(u?.login || '').toLowerCase() === login);
    if (!entry) return;
    await this.autoShoutoutFor(bId, entry);
  }

  async autoShoutoutFor(broadcasterId, entry, { force = false } = {}) {
    const cfg = this.settings?.autoShoutouts ?? {};
    const login = String(entry?.login || '').toLowerCase();
    const key = `${broadcasterId}:${login}`;
    if (!force) {
      const cd = Math.max(1, Number(cfg.cooldownMinutes) || 240) * 60_000;
      const last = this._autoSo.get(key) || 0;
      if (Date.now() - last < cd) return;
    }
    this._autoSo.set(key, Date.now());
    const channel = this.channels?.loginOf(broadcasterId) ?? this.ctx.channel;

    let user = null;
    try {
      user = await this.helix.getUserByLogin(login);
    } catch {}
    const displayName = user?.display_name || login;

    // 1) настоящая карточка шатаута (best-effort — лимиты Twitch: раз в 2 мин, одному человеку раз в час)
    if (user) {
      try {
        await this.helix.shoutout({
          fromId: broadcasterId,
          toUserId: user.id,
          moderatorId: this.auth.tokens?.userId,
        });
      } catch (e) {
        const why = e.status === 429
          ? 'Twitch разрешает шатаут раз в 2 минуты (одному человеку — раз в час)'
          : (e.status === 403 ? 'бот не модератор канала' : e.message);
        this.logs.system.push({ level: 'warn', message: `Автошатаут ${login}: карточка не отправлена — ${why}` });
      }
    }

    // 2) строка с кастомным текстом
    const template = (String(entry?.text || '').trim()) || cfg.defaultTemplate
      || 'Стример {target} у нас в чате! Поддержим: twitch.tv/{target_login} ❤️';
    const text = renderTemplate(template, {
      channel,
      user: displayName,
      target: displayName,
      target_login: login,
    });
    try {
      await this.helix.sendMessage({
        broadcasterId,
        senderId: this.auth.tokens?.userId,
        text,
      });
      this.logs.events.push({ kind: 'автошатаут', channel, text });
    } catch (e) {
      this.logs.system.push({ level: 'error', message: `Автошатаут ${login}: текст не отправлен — ${e.message}` });
    }
  }
}

function userLevelBadge(m, broadcasterId) {
  const badges = m?.badges ?? [];
  const sets = new Set(badges.map((b) => b.set_id || b.setId || b.id));
  if (m?.chatter_user_id && broadcasterId && String(m.chatter_user_id) === String(broadcasterId)) return 'broadcaster';
  if (sets.has('broadcaster')) return 'broadcaster';
  if (sets.has('moderator')) return 'mod';
  if (sets.has('vip')) return 'vip';
  if (sets.has('subscriber') || sets.has('founder')) return 'sub';
  return 'everyone';
}
