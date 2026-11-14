import { renderTemplate, fmtDuration } from './render.js';

/**
 * Периодические сообщения (таймеры). Режимы срабатывания:
 *   time     — раз в N минут (как раньше);
 *   messages — после N сообщений в чате канала;
 *   and      — И время, И сообщения;
 *   or       — ИЛИ время, ИЛИ сообщения.
 * Счётчик сообщений и таймстамп последнего выхода ведутся для каждого канала
 * отдельно; сообщения самого бота не считаются.
 */
export class TimerRunner {
  constructor({ helix, auth, logs, settings, channels }) {
    this.helix = helix;
    this.auth = auth;
    this.logs = logs;
    this.settings = settings; // живой объект настроек из index.js
    this.channels = channels;
    this._last = new Map(); // `${timerId}:${channelId}` -> ts последнего выхода
    this._msgSince = new Map(); // `${timerId}:${channelId}` -> сообщений с последнего выхода
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    // тик раз в 20 секунд — точности по минутам более чем достаточно
    this._timer = setInterval(() => this.tick().catch(() => {}), 20_000);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** После запуска/перенастройки бот считает, что всё уже «стрельнуло» — первый выход через полный интервал. */
  touchAll() {
    const now = Date.now();
    for (const t of this._items()) {
      for (const ch of this.channels?.list() ?? []) {
        const key = `${t.id}:${ch.id}`;
        this._last.set(key, now);
        this._msgSince.set(key, 0);
      }
    }
  }

  /** Сообщение чата: копим счётчики таймеров этого канала. Свои сообщения не считаем. */
  noteChat(event) {
    const chId = String(event?.broadcaster_user_id || '');
    const who = String(event?.chatter_user_id || '');
    if (!chId) return;
    if (who && who === String(this.auth?.tokens?.userId || '')) return;
    for (const t of this.settings?.timers?.items ?? []) {
      if (t?.enabled === false) continue; // выключенные не копим (после включения — с нуля)
      const key = `${t.id}:${chId}`;
      this._msgSince.set(key, (this._msgSince.get(key) || 0) + 1);
    }
  }

  _items() {
    const cfg = this.settings?.timers;
    if (!cfg?.enabled) return [];
    return (cfg.items || []).filter(
      (t) => t.enabled !== false && t.text && Number(t.intervalMinutes) >= 1,
    );
  }

  /** Выполнено ли условие выхода конкретного таймера в конкретном канале. */
  _shouldFire({ t, key, now }) {
    const mode = t.mode || 'time';
    const need = Math.max(1, Number(t.minMessages) || 1);
    const msgs = this._msgSince.get(key) || 0;
    if (mode === 'messages') return msgs >= need;
    const interval = Math.max(1, Number(t.intervalMinutes) || 5) * 60_000;
    const byTime = now - (this._last.get(key) || 0) >= interval;
    if (mode === 'and') return byTime && msgs >= need;
    if (mode === 'or') return byTime || msgs >= need;
    return byTime; // 'time'
  }

  async tick() {
    const items = this._items();
    if (!items.length || !this.channels?.list().length) return;
    const cfg = this.settings?.timers ?? {};
    const onlyLive = cfg.onlyWhenLive !== false;
    const now = Date.now();
    for (const ch of this.channels.list()) {
      for (const t of items) {
        const key = `${t.id}:${ch.id}`;
        // первого касания ещё не было — арминг: ждём полного интервала/порога
        if (!this._last.has(key)) {
          this._last.set(key, now);
          this._msgSince.set(key, 0);
          continue;
        }
        if (!this._shouldFire({ t, key, now })) continue;
        if (onlyLive) {
          const stream = await this.helix.getStreamByLogin(ch.login).catch(() => null);
          if (!stream) continue; // канал оффлайн — молчим, счётчики не сбрасываем
        }
        this._last.set(key, now); // фиксируем ДО отправки — не плодим дублей при ошибке
        this._msgSince.set(key, 0);
        await this.fireOne(ch, t);
      }
    }
  }

  async fireOne(ch, t) {
    const vars = {
      channel: ch.login,
      user: 'таймер',
      target: '',
      target_login: '',
      args: '',
    };
    try {
      const stream = await this.helix.getStreamByLogin(ch.login);
      vars.uptime = stream ? fmtDuration(Date.now() - Date.parse(stream.started_at)) : 'оффлайн';
      vars.game = stream ? stream.game_name : '—';
      vars.title = stream ? stream.title : '—';
    } catch {}
    const text = renderTemplate(t.text, vars).slice(0, 480);
    if (!text) return;
    try {
      await this.helix.sendMessage({
        broadcasterId: ch.id,
        senderId: this.auth.tokens?.userId,
        text,
      });
      this.logs.events.push({
        kind: 'таймер',
        channel: ch.login,
        text: t.name ? `[${t.name}] ${text}` : text,
      });
    } catch (e) {
      this.logs.system.push({
        level: 'error',
        message: `Таймер «${t.name || t.id}» (#${ch.login}): ${e.message}`,
      });
    }
  }

  /** Кнопка «Тест»: написать сообщение этого таймера сейчас, в выбранный канал. */
  async test(timerId, channelLogin) {
    const t = (this.settings?.timers?.items || []).find((x) => x.id === timerId);
    if (!t) throw new Error('Таймер не найден');
    const ch = channelLogin ? this.channels.byLogin(channelLogin) : this.channels.list()[0];
    if (!ch) throw new Error('Канал не найден в списке каналов бота');
    const key = `${t.id}:${ch.id}`;
    this._last.set(key, Date.now());
    this._msgSince.set(key, 0);
    await this.fireOne(ch, t);
    return { tested: t.id, channel: ch.login };
  }
}
