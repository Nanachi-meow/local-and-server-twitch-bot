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

/**
 * Дизайн-тема чат-виджета: единая санитизация для сервера (патч настроек),
 * панели (импорт файла) и тестов. Формат файла — см. docs/CHAT-THEME-SPEC.md.
 * Декоративные приблуды (призраки/паутинки/бумага/ромб) по умолчанию ВЫКЛЮЧЕНЫ —
 * база чистая; «хэллоуин» — просто одна из тем, собирается в конструкторе.
 */
export const THEME_DEFAULTS = {
  name: 'чистая',
  // компоновка (px сцены 1920×1080)
  x: 40, y: 40,           // отступ слева / снизу
  maxWidth: 80,           // макс. ширина колонки, %
  gap: 24,                // промежуток между сообщениями, px
  scale: 100,             // масштаб, %
  // шрифт
  fontFamily: '', fontSize: 16,
  // чип юзера
  chipBg: '#a6a9d3', chipColor: '#f0e7e5', chipRadius: 20,
  chipCase: true,         // ВЕРХНИЙ РЕГИСТР ника
  gem: false,             // ромб слева от чипа
  // бабл сообщения
  msgBg: '#141520', msgColor: '#a6a9d3',
  msgBorder: '#6a6d98', msgBorderWidth: 2,
  msgRadius: 15,
  msgPaper: false,        // «сложенная бумага» позади бабла
  // цвета ролей
  colorBroadcaster: '#f1592a', colorModerator: '#edb872', colorVip: '#a672ed',
  // декор
  ghost: false,           // призрак у сабов
  webs: false,            // паутинки
  subStar: true,          // звёздочка саба на чипе
  // анимация появления
  animIn: 'scale',        // scale | slide | fade
};

/** Санитизация темы: принимает theme-объект или файл-обёртку {format, version, name, theme}. */
export function normalizeTheme(raw = {}) {
  const src = raw && typeof raw === 'object' && raw.theme && typeof raw.theme === 'object' ? raw.theme : raw ?? {};
  const hex = (v, dflt) => (/^#[0-9a-f]{3,8}$/i.test(String(v)) ? String(v).slice(0, 9) : dflt);
  const num = (v, min, max, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : dflt;
  };
  return {
    name: String(src.name ?? '').slice(0, 40) || THEME_DEFAULTS.name,
    x: num(src.x, 0, 1600, THEME_DEFAULTS.x),
    y: num(src.y, 0, 1000, THEME_DEFAULTS.y),
    maxWidth: num(src.maxWidth, 20, 100, THEME_DEFAULTS.maxWidth),
    gap: num(src.gap, 0, 120, THEME_DEFAULTS.gap),
    scale: num(src.scale, 25, 300, THEME_DEFAULTS.scale),
    fontFamily: String(src.fontFamily ?? '').slice(0, 80),
    fontSize: num(src.fontSize, 10, 60, THEME_DEFAULTS.fontSize),
    chipBg: hex(src.chipBg, THEME_DEFAULTS.chipBg),
    chipColor: hex(src.chipColor, THEME_DEFAULTS.chipColor),
    chipRadius: num(src.chipRadius, 0, 60, THEME_DEFAULTS.chipRadius),
    chipCase: src.chipCase !== false,
    gem: src.gem === true,
    msgBg: hex(src.msgBg, THEME_DEFAULTS.msgBg),
    msgColor: hex(src.msgColor, THEME_DEFAULTS.msgColor),
    msgBorder: hex(src.msgBorder, THEME_DEFAULTS.msgBorder),
    msgBorderWidth: num(src.msgBorderWidth, 0, 12, THEME_DEFAULTS.msgBorderWidth),
    msgRadius: num(src.msgRadius, 0, 60, THEME_DEFAULTS.msgRadius),
    msgPaper: src.msgPaper === true,
    colorBroadcaster: hex(src.colorBroadcaster, THEME_DEFAULTS.colorBroadcaster),
    colorModerator: hex(src.colorModerator, THEME_DEFAULTS.colorModerator),
    colorVip: hex(src.colorVip, THEME_DEFAULTS.colorVip),
    ghost: src.ghost === true,
    webs: src.webs === true,
    subStar: src.subStar !== false,
    animIn: ['scale', 'slide', 'fade'].includes(src.animIn) ? src.animIn : 'scale',
  };
}
