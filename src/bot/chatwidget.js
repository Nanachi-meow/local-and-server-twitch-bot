/**
 * 💬 Чат-виджет: сообщения чата поверх стрима (отдельная страница /chat).
 *
 * Стиль — по образцу StreamElements-виджета: чип юзера с цветом роли,
 * тёмный бабл сообщения, у сабов летает призрак, сообщения вплетаются паутинками.
 *
 * Фильтры: лимит сообщений и скрытие по таймеру — на самой странице;
 * здесь — что пропускать в оверлей (enabled/игноры/команды) и сборка payload:
 * текст режется на безопасные куски (text|emote), страница строит DOM без innerHTML.
 */
import { overlay } from './alerts.js';

/** Роль юзера по бейджам EventSub (channel.chat.message): broadcaster → mod → vip → sub → all. */
export function chatRole(m = {}, broadcasterId = '') {
  if (m?.chatter_user_id && broadcasterId && String(m.chatter_user_id) === String(broadcasterId)) return 'broadcaster';
  const sets = new Set((m?.badges ?? []).map((b) => b?.set_id || b?.setId || b?.id).filter(Boolean));
  if (sets.has('broadcaster')) return 'broadcaster';
  if (sets.has('moderator')) return 'mod';
  if (sets.has('vip')) return 'vip';
  if (sets.has('subscriber') || sets.has('founder')) return 'sub';
  return 'all';
}

export class ChatWidget {
  constructor({ settings } = {}) {
    this.settings = settings; // живой объект: settings.chatWidget
  }

  cfg() { return this.settings?.chatWidget ?? {}; }

  /** Список игноров (ники через запятую, регистр не важен). */
  ignored() {
    return String(this.cfg().ignoredUsers ?? '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }

  /**
   * Чат-сообщение EventSub → (может быть) пуш в оверлей.
   * Возвращает true, если сообщение уехало на страницу /chat.
   */
  handleChat(m = {}, broadcasterId = '') {
    const cfg = this.cfg();
    if (cfg.enabled !== true) return false;
    const login = String(m?.chatter_user_login ?? '').toLowerCase();
    if (this.ignored().includes(login)) return false;
    const text = String(m?.message?.text ?? '');
    if (cfg.hideCommands !== false && text.startsWith('!')) return false;
    overlay.push({
      kind: 'chat',
      user: String(m?.chatter_user_name ?? m?.chatter_user_login ?? login).slice(0, 40),
      login,
      role: chatRole(m, broadcasterId),
      sub: (m?.badges ?? []).some((b) => b?.set_id === 'subscriber' || b?.setId === 'subscriber' || b?.id === 'subscriber'),
      parts: buildParts(m?.message),
    });
    return true;
  }

  /** Тестовое сообщение из панели (кнопки «тест»: all/mod/vip/sub/broadcaster). */
  test({ role = 'all', user = 'Тест', text = 'привет стриму! 👋', sub = null } = {}) {
    if (this.cfg().enabled !== true) return { error: 'виджет выключен' };
    const isSub = sub === null ? ['sub', 'broadcaster'].includes(role) : Boolean(sub);
    overlay.push({
      kind: 'chat',
      user: String(user).slice(0, 40) || 'Тест',
      login: String(user).toLowerCase().slice(0, 40) || 'тест',
      role,
      sub: isSub,
      parts: [{ type: 'text', text: String(text).slice(0, 300) || 'привет стриму! 👋' }],
      test: true,
    });
    return { ok: true };
  }

  /** Пуш настроек на страницу /chat (применяются мгновенно, без ожидания опроса). */
  pushCfg() {
    overlay.push({ kind: 'chatcfg', ...this.cfg() });
  }
}

/**
 * message.fragments → части для рендера: текст и эмоты раздельно.
 * Страница строит DOM из textContent и <img> — пользовательский текст не проходит через innerHTML.
 */
export function buildParts(message = {}) {
  const frags = Array.isArray(message?.fragments) ? message.fragments : null;
  if (!frags) {
    return [{ type: 'text', text: String(message?.text ?? '').slice(0, 500) }];
  }
  const parts = [];
  for (const f of frags) {
    if (!f) continue;
    if (f.type === 'emote' && f.emote?.id) {
      parts.push({ type: 'emote', id: String(f.emote.id).slice(0, 40), name: String(f.text ?? '').slice(0, 40) });
    } else if (f.type === 'text' || f.type === 'mention') {
      const t = String(f.text ?? '');
      if (t) parts.push({ type: 'text', text: t.slice(0, 500) });
    } // cheermote — редкий случай; показываем текстом
  }
  return parts.length ? parts.slice(0, 100) : [{ type: 'text', text: String(message?.text ?? '').slice(0, 500) }];
}
