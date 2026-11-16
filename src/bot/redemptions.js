import { overlay } from './alerts.js';

/** Действия редемпций — пока справочные (диспетчеризация отдельной фазой). */
export const REDEMPTION_ACTIONS = ['song', 'meme', 'wheel', 'say', 'command'];

/**
 * Роутер наград канала Twitch (Channel Points).
 *
 * Принимает событие EventSub `channel.channel_points_custom_reward_redemption.add`,
 * матчит название награды по таблице mappings из настроек и:
 *   • пишет строку в ленту событий панели (все списания);
 *   • для заматченных наград пушит алерт в оверлей (kind: 'redemption').
 *
 * Подписка на событие возможна только с токеном владельца канала —
 * см. «Вход как стример» (BroadcasterAuth) и подписку via 'broadcaster' в index.js.
 *
 * Настройки (settings.redemptions):
 *   enabled   — роутер вообще работает;
 *   cooldown  — сек между overlay-алертами одного зрителя (анти-спам, лог ведётся всегда);
 *   mappings  — [{ rewardName, action, enabled }] — action пока справочное поле.
 */
export class RedemptionRouter {
  constructor({ logs, settings }) {
    this.logs = logs;
    this.settings = settings; // живой объект настроек (settings.redemptions)
    this._lastSeen = new Map(); // login -> ts последнего overlay-пуша
  }

  cfg() {
    return {
      enabled: true,
      cooldown: 30,
      ...(this.settings?.redemptions ?? {}),
    };
  }

  /** Мэппинг по названию награды (без учёта регистра и висячих пробелов). */
  match(rewardName) {
    const wanted = String(rewardName ?? '').trim().toLowerCase();
    if (!wanted) return null;
    const list = Array.isArray(this.cfg().mappings) ? this.cfg().mappings : [];
    return list.find((m) => m && m.enabled !== false
      && String(m.rewardName ?? '').trim().toLowerCase() === wanted) ?? null;
  }

  /** Кулдаун на юзера: не чаще раза в cooldown сек (оверлей). */
  _cooldownOk(login, cd) {
    if (!cd) return true;
    const key = String(login || '').toLowerCase();
    const last = this._lastSeen.get(key) || 0;
    if (Date.now() - last < cd * 1000) return false;
    this._lastSeen.set(key, Date.now());
    // карта не растёт вечно: подметаем записи старше суток
    if (this._lastSeen.size > 500) {
      const cut = Date.now() - 86_400_000;
      for (const [k, ts] of this._lastSeen) if (ts < cut) this._lastSeen.delete(k);
    }
    return true;
  }

  /**
   * Обработка события редемпции из EventSub. Возвращает { logged, pushed, cooldown, action }.
   * Ошибок не бросает — стример не должен терять остальные события из-за кривой награды.
   */
  handle(event) {
    try {
      return this._handle(event);
    } catch (e) {
      this.logs?.system?.push?.({ level: 'error', message: `Награда канала: не обработана — ${e.message}` });
      return { error: e.message };
    }
  }

  _handle(event) {
    const cfg = this.cfg();
    if (!cfg.enabled) return { ignored: true };
    // нормализация события Twitch (поля raw и вложенные — на случай расширения)
    const r = {
      rewardId: event?.reward?.id ?? event?.reward_id ?? null,
      rewardName: String(event?.reward?.title ?? event?.reward_name ?? '').trim().slice(0, 100),
      userLogin: String(event?.user_login ?? '').toLowerCase(),
      userName: String(event?.user_name ?? ''),
      input: String(event?.user_input ?? '').trim().slice(0, 300),
      broadcasterId: event?.broadcaster_user_id ?? null,
    };
    const mapping = this.match(r.rewardName);
    const who = r.userName || r.userLogin || 'кто-то';
    const line = `${who} активировал(а) награду «${r.rewardName}»${r.input ? `: ${r.input}` : ''}`;
    // в ленту панели — каждое списание, даже незамапленное
    this.logs?.events?.push?.({ kind: 'награда', channel: null, text: line });

    if (!mapping) return { logged: true };
    // оверлей — только замапленные награды и не чаще кулдауна
    const cd = Math.max(0, Math.min(3600, Number(cfg.cooldown) || 0));
    if (!this._cooldownOk(r.userLogin, cd)) return { logged: true, cooldown: true };

    overlay.push({
      kind: 'redemption',
      channel: null,
      user: who,
      reward: r.rewardName,
      text: line,
      input: r.input,
      sound: '',
    });
    return { logged: true, pushed: true, action: mapping.action };
  }
}
