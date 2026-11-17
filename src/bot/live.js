/**
 * Автоопределение начала и конца стрима — единый источник состояния «эфир».
 *
 * Два источника правды, дополняющих друг друга:
 *   1) EventSub stream.online / stream.offline — мгновенно (секунды);
 *   2) периодическая сверка с Helix /streams — страховка: EventSub мог пропустить
 *      событие при переподключении, или бот стартовал посреди эфира.
 *
 * Переходы фиксируются один раз (повторные события и сверки молча обновляют
 * метаданные). Каждый переход пишется в ленту событий и дёргает watcher-колбэк —
 * на нём позже строятся реакции «стрим начался/закончился» (панель, шаблоны, алерты).
 */
export class LiveTracker {
  constructor({ helix, channels, logs, pollMs = 60_000, watcher = null } = {}) {
    this.helix = helix;
    this.channels = channels; // реестр каналов: { list(), loginOf(id) }
    this.logs = logs;
    this.pollMs = Math.max(15_000, Number(pollMs) || 60_000);
    this._watcher = watcher;
    this._byId = new Map(); // broadcasterId → { login, live, startedAt, title, game, seenAt }
    this._timer = null;
  }

  /** Панель/модули подписываются на переходы: watcher(kind, entry), kind = 'online'|'offline'. */
  setWatcher(fn) { this._watcher = typeof fn === 'function' ? fn : null; }

  /** Снимок для /api/state: { [канал]: { live, startedAt, durationMs, title, game } }. */
  snapshot() {
    const out = {};
    for (const entry of this._byId.values()) {
      if (!entry.login) continue;
      out[entry.login] = {
        live: Boolean(entry.live),
        startedAt: entry.startedAt ?? null,
        durationMs: entry.live && entry.startedAt ? Date.now() - entry.startedAt : null,
        title: entry.title ?? '',
        game: entry.game ?? '',
      };
    }
    return out;
  }

  isLive(broadcasterId) {
    return Boolean(this._byId.get(String(broadcasterId))?.live);
  }

  _entry(broadcasterId) {
    const id = String(broadcasterId);
    let entry = this._byId.get(id);
    if (!entry) {
      entry = { login: this.channels?.loginOf?.(id) ?? null, live: false, startedAt: null, title: '', game: '', seenAt: 0 };
      this._byId.set(id, entry);
    } else if (!entry.login) {
      entry.login = this.channels?.loginOf?.(id) ?? entry.login;
    }
    return entry;
  }

  /**
   * Событие stream.online (из EventSub или сверки). meta: { title, game, startedAt }.
   * Возвращает true, если это переход offline→online (стрим начался только что).
   */
  markOnline(broadcasterId, meta = {}) {
    const entry = this._entry(broadcasterId);
    if (meta.title) entry.title = String(meta.title).slice(0, 200);
    if (meta.game) entry.game = String(meta.game).slice(0, 100);
    if (entry.live) return false; // уже в эфире — повторное событие, перехода нет
    const startedAt = Number(meta.startedAt);
    entry.live = true;
    entry.startedAt = Number.isFinite(startedAt) && startedAt > 0 ? startedAt : Date.now();
    this.logs?.events?.push?.({
      kind: 'online',
      channel: entry.login,
      text: `Стрим начался 🟢${entry.title ? ` · ${entry.title}` : ''}`,
    });
    try { this._watcher?.('online', { ...entry }); } catch { /* сторонний код не должен ронять трекер */ }
    return true;
  }

  /** Событие stream.offline. Возвращает true, если это переход online→offline. */
  markOffline(broadcasterId) {
    const entry = this._entry(broadcasterId);
    if (!entry.live) return false;
    const durationMs = entry.startedAt ? Date.now() - entry.startedAt : null;
    entry.live = false;
    entry.startedAt = null;
    entry.title = '';
    entry.game = '';
    this.logs?.events?.push?.({
      kind: 'offline',
      channel: entry.login,
      text: `Стрим закончился 🌙${durationMs ? ` · длился ${Math.round(durationMs / 60_000)} мин` : ''}`,
    });
    try { this._watcher?.('offline', { ...entry }); } catch {}
    return true;
  }

  /**
   * Сверка с Helix по всем каналам бота.
   * quiet=true — первичная инициализация (бот стартовал): состояние ставится молча,
   * «стрим начался» не пишем, ведь он начался без нас.
   */
  async sync({ quiet = false } = {}) {
    const list = this.channels?.list?.() ?? [];
    if (!list.length) return;
    let streams = [];
    try {
      streams = await this.helix.getStreamsByLogins(list.map((c) => c.login));
    } catch {
      return; // Helix недоступен — останемся при текущем состоянии, сверься в следующий раз
    }
    const liveById = new Map(streams.map((s) => [String(s.user_id), s]));
    for (const ch of list) {
      const s = liveById.get(String(ch.id));
      const entry = this._entry(ch.id);
      entry.login = ch.login;
      entry.seenAt = Date.now();
      const meta = s ? {
        title: s.title,
        game: s.game_name,
        startedAt: Date.parse(s.started_at) || Date.now(),
      } : null;
      if (s && !entry.live) {
        if (quiet) {
          // бот поднялся посреди эфира: фиксируем без объявления
          entry.live = true;
          entry.startedAt = meta.startedAt;
          entry.title = meta.title ?? '';
          entry.game = meta.game ?? '';
        } else {
          // EventSub пропустил старт — ловим сверкой
          this.markOnline(ch.id, meta);
        }
      } else if (!s && entry.live) {
        // EventSub пропустил конец — ловим сверкой
        this.markOffline(ch.id);
      } else if (s && entry.live) {
        if (meta.title) entry.title = meta.title;
        if (meta.game) entry.game = meta.game;
      }
    }
  }

  /** Запустить страховочную сверку (раз в pollMs). */
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => { this.sync().catch(() => {}); }, this.pollMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}
