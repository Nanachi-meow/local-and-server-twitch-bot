import { loadJson, saveJson } from '../store.js';
import { SONGS_FILE } from '../store.js';
import { overlay } from './alerts.js';
import { httpGet } from './proxy.js';

const VID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Тест-треки плеера: первая попытка рикроллит, дальше — Bad Apple (счётчик навсегда в data/songs.json). */
const TEST_TRACKS = {
  first: { id: 'dQw4w9WgXcQ', title: 'Rick Astley — Never Gonna Give You Up' },
  next: { id: 'FtutLA63Cp8', title: 'Bad Apple!!' },
};

/** Вытащить ID видео из любых ссылок YouTube (youtu.be, watch?v=, shorts, music, live, голый ID). */
export function parseVideoId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (VID_RE.test(raw)) return raw;
  const m = raw
    .match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function fetchVideoInfo(videoId, proxy, fetcher = httpGet) {
  const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://youtu.be/${videoId}`)}&format=json`;
  const r = await fetcher(oembed, proxy);
  if (r.status !== 200) {
    throw new Error(r.status === 401 || r.status === 403 || r.status === 404 ? 'видео не найдено или недоступно' : `YouTube ответил HTTP ${r.status}`);
  }
  let title = '';
  let author = '';
  try {
    const j = JSON.parse(r.body);
    title = j.title || '';
    author = j.author_name || '';
  } catch { throw new Error('YouTube прислал неожиданный ответ'); }

  // длина и просмотры — со страницы просмотра (без API-ключей)
  let duration = 0;
  let viewCount = 0;
  try {
    const page = await fetcher(`https://www.youtube.com/watch?v=${videoId}&hl=ru`, proxy);
    const html = String(page.body || '');
    const m = html.match(/"lengthSeconds"\s*:\s*"?(\d{1,6})/);
    if (m) duration = Number(m[1]);
    const vc = html.match(/"viewCount"\s*:\s*"?(\d+)/);
    if (vc) viewCount = Number(vc[1]);
  } catch {}
  return { title, author, duration, viewCount };
}

/**
 * Очередь заказов музыки: хранение в data/songs.json, события в оверлей (kind 'sr'),
 * деньги/economy — на стороне команд (points), менеджер только про очередь.
 * Пушит события: op: 'update' (очередь/текущая изменилась), 'play', 'stop', 'pause', 'resume'.
 */
export class SongsManager {
  constructor({ logs, settings, dataFile = SONGS_FILE, fetcher = httpGet }) {
    this.logs = logs;
    this.settings = settings; // живой объект настроек (songs*, proxy*)
    this.dataFile = dataFile;
    this.fetcher = fetcher;
    const stored = loadJson(this.dataFile, null) ?? {};
    this.queue = Array.isArray(stored.queue) ? stored.queue : [];
    this.history = Array.isArray(stored.history) ? stored.history : [];
    this.current = stored.current ?? null;
    this.paused = Boolean(stored.paused);
    this.testCount = Number(stored.testCount) || 0; // сколько раз жали «Тест плеера»
    this.testing = null; // { id, title } — играет тест-трек (мимо очереди)
    this._dirty = false;
    this._lastOrder = new Map(); // login -> ts последнего успешного заказа (кулдаун)
  }

  cfg() {
    return this.settings?.songs ?? {};
  }

  saveNow() {
    try {
      saveJson(this.dataFile, {
        queue: this.queue,
        history: this.history.slice(-50),
        current: this.current,
        paused: this.paused,
        testCount: this.testCount || 0,
      });
      this._dirty = false;
    } catch (e) {
      this.logs?.system?.push?.({ level: 'error', message: `не записалась очередь музыки на диск: ${e.message}` });
    }
  }

  _emit(op, extra = {}) {
    overlay.push({ kind: 'sr', op, ...this.state(), ...extra });
  }

  state() {
    return {
      current: this.current,
      queue: this.queue.slice(0, 20),
      paused: this.paused,
      testing: this.testing ? { title: this.testing.title } : null,
      enabled: Boolean(this.cfg().enabled),
      volume: this.cfg().volume ?? 60,
      nowTemplate: this.cfg().nowTemplate || '♪ {title} (заказ {by})',
      playerCfg: this.cfg().playerCfg ?? null,
    };
  }

  /** Добавить трек в очередь. Валидация длины/просмотров/чс/лимитов — здесь, баллы — в команде/награде. */
  async add({ videoId, by, byName }) {
    const cfg = this.cfg();
    if (!cfg.enabled) return { error: 'музыка выключена' };
    const id = String(videoId || '');
    const byLogin = String(by || '').toLowerCase();
    const maxLen = Math.max(0, Number(cfg.maxLenSec ?? 600));
    const perUser = Math.max(1, Number(cfg.perUser ?? 2));
    const userMax = Math.max(0, Number(cfg.userMaxLengthSec ?? 0));
    const minViews = Math.max(0, Number(cfg.minViews ?? 0));
    if (!id) return { error: 'не поняла ссылку — пришли ссылку на ролик YouTube' };
    if (this.blacklistHas(id)) return { error: 'этот трек в чёрном списке канала 🚫' };
    if (!this.current && !this.queue.length) {
      // очередь пуста — этот трек станет текущим, лимиты на «текущий» не считаем
    } else {
      if (this.queue.some((x) => x.id === id) || this.current?.id === id) return { error: 'этот трек уже в очереди' };
      const mine = this.queue.filter((x) => String(x.by).toLowerCase() === byLogin).length;
      if (mine >= perUser) return { error: `у тебя уже ${mine} ${mine === 1 ? 'трек' : 'трека'} в очереди — дождись` };
    }
    let title = '';
    let author = '';
    let duration = 0;
    let viewCount = 0;
    try {
      const info = await fetchVideoInfo(id, this.settings?.proxy, this.fetcher);
      title = info.title;
      author = info.author;
      duration = info.duration;
      viewCount = info.viewCount;
    } catch (e) {
      return { error: `не смогла узнать трек: ${e.message}` };
    }
    if (!title) return { error: 'не смогла узнать название — видео недоступно?' };
    if (maxLen && (!duration || duration > maxLen)) {
      return { error: !duration
        ? 'не смогла узнать длину видео — попробуй другое'
        : `слишком длинно (${duration} сек > лимита ${maxLen})` };
    }
    if (minViews && (!viewCount || viewCount < minViews)) {
      return { error: !viewCount
        ? 'не смогла узнать просмотры видео — попробуй другое'
        : `мало просмотров (${viewCount} < ${minViews}) 📉` };
    }
    // суммарная длина треков этого юзера (очередь + его текущий + новый)
    if (userMax) {
      const mineSec = [...this.queue, this.current]
        .filter((x) => x && String(x.by).toLowerCase() === byLogin)
        .reduce((s, x) => s + (Number(x.duration) || 0), 0);
      if (mineSec + duration > userMax) {
        return { error: `твои треки уже ${Math.round(mineSec / 60)} мин, этот ещё ${Math.round(duration / 60)} — лимит ${Math.round(userMax / 60)} мин ⏳` };
      }
    }
    const song = { id, title, author, duration, viewCount, by: byLogin, byName: byName || byLogin, at: Date.now() };
    this.testing = null; // настоящий заказ вытесняет тест-трек
    if (!this.current) {
      this.current = song;
      this._emit('play');
    } else {
      this.queue.push(song);
      this._emit('update');
    }
    this._dirty = true;
    this.saveNow();
    this._lastOrder.set(byLogin, Date.now()); // отсчёт кулдауна между заказами
    // карта не растёт вечно
    if (this._lastOrder.size > 500) {
      const cut = Date.now() - 86_400_000;
      for (const [k, ts] of this._lastOrder) if (ts < cut) this._lastOrder.delete(k);
    }
    return { song, position: this.current?.id === id ? 0 : this.queue.length };
  }

  /** Видео закончилось (сообщает плеер с /music). */
  ended() {
    this.testing = null; // смена трека в эфире гасит тест
    if (!this.current) {
      this._emit('stop'); // пустая очередь: всё равно сообщаем — плеер сбрасывает UI
      return { stopped: true };
    }
    this.history.push(this.current);
    this._dirty = true;
    const next = this.queue.shift();
    this.current = next ?? null;
    this.saveNow();
    if (next) this._emit('play');
    else this._emit('stop');
    return { next: Boolean(next) };
  }

  skip() {
    // играет тест-трек — скип = остановить тест
    if (!this.current) {
      if (this.testing) {
        this.testing = null;
        this._emitTest('stop');
        return { ok: true, testing: true };
      }
      return { error: 'сейчас ничего не играет' };
    }
    return this.ended();
  }

  clear() {
    this.queue = [];
    this._dirty = true;
    this.saveNow();
    this._emit('update');
    return { cleared: true };
  }

  control(op) {
    if (op === 'pause') {
      // играет тест-трек (очередь пустая) — паузим его
      if (!this.current && this.testing) { this._emitTest('pause'); return { ok: true, testing: true }; }
      if (!this.current) return { error: 'нечего паузить' };
      this.paused = true;
      this._emit('pause');
    } else if (op === 'resume') {
      if (!this.current && this.testing) { this._emitTest('resume'); return { ok: true, testing: true }; }
      this.paused = false;
      this._emit('resume');
    } else if (op === 'stop') {
      this.current = null;
      this.queue = [];
      this.paused = false;
      if (this.testing) { this.testing = null; this._emitTest('stop'); }
      this._dirty = true;
      this.saveNow();
      this._emit('stop');
    } else {
      return { error: `неизвестное действие: ${op}` };
    }
    this._dirty = true;
    this.saveNow();
    return { ok: true };
  }

  removeAt(index) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= this.queue.length) return { error: 'нет такого номера в очереди' };
    this.queue.splice(i, 1);
    this._dirty = true;
    this.saveNow();
    this._emit('update');
    return { ok: true };
  }

  // ---------------- чёрный список треков ----------------

  /** Трек в чёрном списке? (settings.songs.blacklist: [{ id, title }]) */
  blacklistHas(id) {
    const list = Array.isArray(this.cfg().blacklist) ? this.cfg().blacklist : [];
    return list.some((x) => x && x.id === String(id));
  }

  /** Добавить трек в ЧС по ссылке; выкидывает его из очереди/эфира. Возвращает { blacklisted, title } | { error }. */
  async blacklistAdd(url) {
    const id = parseVideoId(url);
    if (!id) return { error: 'это не похоже на ссылку YouTube' };
    const cfg = this.cfg();
    if (!Array.isArray(cfg.blacklist)) cfg.blacklist = [];
    if (this.blacklistHas(id)) return { error: 'этот трек уже в чёрном списке' };
    let title = '';
    try {
      const info = await fetchVideoInfo(id, this.settings?.proxy, this.fetcher);
      title = info.title || '';
    } catch { /* название не критично — оставим пустым */ }
    cfg.blacklist.push({ id, title });
    // выкидываем из очереди
    const qi = this.queue.findIndex((x) => x.id === id);
    if (qi >= 0) { this.queue.splice(qi, 1); this._dirty = true; }
    // играет сейчас — скипаем
    const wasCurrent = this.current?.id === id;
    if (wasCurrent) this.current = this.queue.shift() ?? null;
    if (qi >= 0 || wasCurrent) {
      this.saveNow();
      this._emit(wasCurrent ? 'play' : 'update');
    }
    return { blacklisted: id, title };
  }

  /** Убрать трек из ЧС (id). */
  blacklistRemove(id) {
    const cfg = this.cfg();
    if (!Array.isArray(cfg.blacklist)) return { error: 'чёрный список пуст' };
    const i = cfg.blacklist.findIndex((x) => x && x.id === String(id));
    if (i < 0) return { error: 'нет такого трека в чёрном списке' };
    const [removed] = cfg.blacklist.splice(i, 1);
    this._emit('update');
    return { removed };
  }

  // ---------------- кулдаун заказов ----------------

  /** Сколько секунд юзеру осталось ждать до следующего заказа (0 = можно). */
  orderCooldownLeft(by) {
    const cd = Math.max(0, Number(this.cfg().commandCooldown ?? 0));
    if (!cd) return 0;
    const last = this._lastOrder.get(String(by || '').toLowerCase()) || 0;
    if (!last) return 0;
    return Math.max(0, Math.ceil((cd * 1000 - (Date.now() - last)) / 1000));
  }

  /**
   * «Тест плеера»: пушит специальное событие srtest — все плееры (OBS /music и превью в панели)
   * проигрывают трек, НЕ трогая очередь/текущий трек. Первая попытка в жизни бота — рикрол,
   * дальше — Bad Apple. Счётчик навсегда в data/songs.json.
   * Управление тестом: control('pause'/'resume'/'stop') и skip() тоже рулят тестом.
   */
  test() {
    const cfg = this.cfg();
    if (!cfg.enabled) return { error: 'музыка выключена 🎵❌' };
    this.testCount = (Number(this.testCount) || 0) + 1;
    this.saveNow();
    const track = this.testCount === 1 ? TEST_TRACKS.first : TEST_TRACKS.next;
    this.testing = { id: track.id, title: track.title };
    this._emitTest('play', { volume: cfg.volume ?? 60 });
    return { id: track.id, title: track.title, first: this.testCount === 1 };
  }

  /** Событие управления тестом (srtest): play/pause/resume/stop. */
  _emitTest(op, extra = {}) {
    overlay.push({
      kind: 'srtest',
      op,
      ...(this.testing ? { id: this.testing.id, title: this.testing.title } : {}),
      ...extra,
    });
  }
}

/**
 * Кому можно заказывать музыку (общее для команды и награды).
 * roles: everyone/sub/vip/follower/mod/broadcaster; стример может всегда;
 * allowUsers — персональный белый список ников. level — роль из чата (у награды нет бейджей).
 */
export async function requestAllowed(cfg = {}, { level = 'everyone', login, userId, broadcasterId, helix } = {}) {
  const allow = Array.isArray(cfg.allow) ? cfg.allow.filter(Boolean) : [];
  const allowUsers = (Array.isArray(cfg.allowUsers) ? cfg.allowUsers : []).map((u) => String(u).toLowerCase());
  const who = String(login || '').toLowerCase();
  if (level === 'broadcaster') return { ok: true };
  if (who && allowUsers.includes(who)) return { ok: true, via: 'list' };
  if (!allow.length || allow.includes('everyone')) return { ok: true };
  if (level && level !== 'everyone' && allow.includes(level)) return { ok: true };
  if (allow.includes('follower') && userId && broadcasterId && helix) {
    try {
      const f = await helix.getFollower({ broadcasterId, userId });
      if (f) return { ok: true, via: 'follower' };
    } catch { /* проверка фоллоу не удалась — не пускаем */ }
  }
  return { ok: false };
}

/**
 * Отменить списание награды канала — Twitch вернёт зрителю баллы.
 * Нужен токен стримера со скоупом channel:manage:redemptions (helix = Helix с broadcaster-токеном).
 */
export async function cancelRedemption({ broadcasterId, rewardId, redemptionId, helix }) {
  if (!broadcasterId || !rewardId || !redemptionId || !helix) return { error: 'недостаточно данных для возврата баллов' };
  const json = await helix.call('PATCH', '/channel_points/custom_rewards/redemptions', {
    query: {
      broadcaster_id: broadcasterId,
      reward_id: rewardId,
      id: redemptionId,
    },
    body: { status: 'CANCELED' },
  });
  return { ok: true, redemption: json?.data?.[0] ?? null };
}

