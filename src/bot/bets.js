/**
 * Ставки на исходы (тотализатор) и дуэли на баллы канала.
 *
 * Менеджер НЕ списывает и не хранит баллы: он ведёт протокол (кто, сколько
 * и на какой вариант) и считает, кому сколько причитается. Деньгами командуют
 * команды через PointsManager:
 *   • !ставить — успешный place() записывается в протокол, затем команда
 *     списывает баллы (points.spend); если списать не вышло — unplace() откатывает запись;
 *   • !итог — resolve() возвращает выплаты [{login, amount}], команда платит их points.add;
 *   • таймаут — closeExpired() возвращает список возвратов [{login, amount}],
 *     их возвращает вызвавший; тик из start() по таймеру делает это сам.
 */
export class BetsManager {
  constructor({ logs, settings }) {
    this.logs = logs;
    this.settings = settings; // живой объект настроек (settings.bets)
    this.points = null; // PointsManager для авто-возвратов (вешается через setPoints)
    this._pools = new Map();    // channelId -> активная ставка
    this._duels = new Map();    // channelId -> ждущий вызов на дуэль
    this._duelLast = new Map(); // login -> ts последней дуэли (кулдаун)
    this._timer = null;
  }

  setPoints(points) {
    this.points = points;
  }

  // ---------------- настройки/утилиты ----------------

  /** Текущие настройки ставок: settings.bets поверх дефолтов. */
  cfg() {
    return {
      enabled: true,
      fee: 0,
      durationSec: 300,
      minBet: 10,
      maxBet: 1000,
      duelCooldown: 60,
      ...(this.settings?.bets ?? {}),
    };
  }

  _key(id) { return String(id ?? ''); }
  _loginOf(login) { return String(login || '').toLowerCase().replace(/^@/, ''); }
  _dur(sec) { return Math.max(10, Math.min(3600, Math.round(Number(sec) || 300))); }
  _sum(bets) { return bets.reduce((s, b) => s + b.amount, 0); }
  _pot(pool) { return pool.options.reduce((s, o) => s + this._sum(o.bets), 0); }

  // ---------------- тотализатор ----------------

  active(channelId) {
    return this._pools.get(this._key(channelId)) ?? null;
  }

  /** Краткое состояние активной ставки — для вывода в чат. */
  status(channelId) {
    const pool = this.active(channelId);
    if (!pool) return null;
    return {
      question: pool.question,
      pot: this._pot(pool),
      secondsLeft: Math.max(0, Math.ceil((pool.expiresAt - Date.now()) / 1000)),
      options: pool.options.map((o, i) => ({
        index: i + 1,
        label: o.label,
        total: this._sum(o.bets),
        bets: o.bets.length,
      })),
    };
  }

  /** Открыть тотализатор: 2–6 вариантов, один активный пул на канал. */
  open({ channelId, question, options }) {
    const cfg = this.cfg();
    if (cfg.enabled === false) return { error: 'ставки выключены' };
    const ch = this._key(channelId);
    if (!ch) return { error: 'не указан канал' };
    if (this._pools.has(ch)) return { error: 'ставка уже открыта — подведи итог: !итог <номер>' };
    const labels = (Array.isArray(options) ? options : [])
      .map((o) => String(o ?? '').trim().slice(0, 60))
      .filter(Boolean);
    if (labels.length < 2 || labels.length > 6) return { error: 'нужно от 2 до 6 вариантов' };
    const q = String(question ?? '').trim().slice(0, 200);
    if (!q) return { error: 'нужен вопрос' };
    const durationSec = this._dur(cfg.durationSec);
    this._pools.set(ch, {
      channelId: ch,
      question: q,
      options: labels.map((label) => ({ label, bets: [] })),
      openedAt: Date.now(),
      expiresAt: Date.now() + durationSec * 1000,
    });
    this.logs.system.push({ level: 'info', message: `Ставки: открыта «${q}» (${labels.length} варианта, ${durationSec} сек)` });
    return { question: q, options: labels, durationSec };
  }

  /** Записать ставку в протокол. optionIndex — номер варианта, 1..N (как в чате). */
  place({ channelId, login, name = '', optionIndex, amount }) {
    const cfg = this.cfg();
    if (cfg.enabled === false) return { error: 'ставки выключены' };
    const pool = this._pools.get(this._key(channelId));
    if (!pool) return { error: 'сейчас нет открытой ставки' };
    const idx = Number(optionIndex);
    if (!Number.isInteger(idx)) return { error: 'номер варианта — целое число' };
    if (idx < 1 || idx > pool.options.length) return { error: `номер варианта — от 1 до ${pool.options.length}` };
    const n = Number(amount);
    if (!Number.isInteger(n)) return { error: 'сумма ставки — целое число' };
    if (n <= 0) return { error: 'укажи сумму ставки' };
    const min = Math.max(1, Number(cfg.minBet) || 10);
    const max = Math.max(min, Number(cfg.maxBet) || 1000);
    if (n < min) return { error: `минимальная ставка ${min}` };
    if (n > max) return { error: `максимальная ставка ${max}` };
    if (Date.now() >= pool.expiresAt) return { error: 'время ставки уже вышло' };
    const opt = pool.options[idx - 1];
    opt.bets.push({ login: this._loginOf(login), name: String(name || '').trim().slice(0, 40), amount: n });
    return {
      question: pool.question,
      amount: n,
      optionIndex: idx,
      option: opt.label,
      optionTotal: this._sum(opt.bets),
      pot: this._pot(pool),
      secondsLeft: Math.max(0, Math.ceil((pool.expiresAt - Date.now()) / 1000)),
    };
  }

  /** Откатить последнюю запись игрока на варианте (баллы так и не списались). */
  unplace({ channelId, login, optionIndex }) {
    const pool = this._pools.get(this._key(channelId));
    if (!pool) return { error: 'нет открытой ставки' };
    const idx = Number(optionIndex);
    if (!Number.isInteger(idx)) return { error: 'номер варианта — целое число' };
    const opt = pool.options[idx - 1];
    if (!opt) return { error: 'нет такого варианта' };
    const key = this._loginOf(login);
    for (let i = opt.bets.length - 1; i >= 0; i--) {
      if (opt.bets[i].login === key) {
        opt.bets.splice(i, 1);
        return { optionIndex: idx };
      }
    }
    return { error: 'запись не найдена' };
  }

  /** Закрыть ставку: победители (winnerIndex, 1..N) делят банк пропорционально ставкам.
   *  Если на победителя не поставил никто (pot>0) — банк не сгорает: в refunds уходят возвраты всем. */
  resolve({ channelId, winnerIndex }) {
    const cfg = this.cfg();
    const pool = this._pools.get(this._key(channelId));
    if (!pool) return { error: 'ставка не открыта' };
    const idx = Number(winnerIndex);
    if (!Number.isInteger(idx)) return { error: 'номер варианта — целое число' };
    if (idx < 1 || idx > pool.options.length) return { error: `номер варианта — от 1 до ${pool.options.length}` };
    const pot = this._pot(pool);
    const winner = pool.options[idx - 1];
    const result = {
      question: pool.question,
      winnerIndex: idx,
      winner: winner.label,
      pot,
      fee: Math.max(0, Math.min(10, Number(cfg.fee) || 0)),
      payouts: [],
    };
    this._pools.delete(this._key(channelId));
    if (!winner.bets.length) {
      if (pot > 0) {
        // опечатка мода не должна стоить зрителям баллов: банк не сгорает — возвращаем все ставки
        const byLogin = new Map();
        for (const o of pool.options) {
          for (const b of o.bets) {
            const cur = byLogin.get(b.login) ?? { login: b.login, amount: 0 };
            cur.amount += b.amount;
            byLogin.set(b.login, cur);
          }
        }
        result.refunds = [...byLogin.values()];
      }
      this.logs.system.push({ level: 'info', message: `Ставки: «${pool.question}» — итог «${winner.label}», победителей нет — возвратов: ${result.refunds?.length ?? 0}` });
      return result;
    }
    const prizePool = Math.floor((pot * (100 - result.fee)) / 100);
    // доли по логинам (один человек мог ставить несколько раз)
    const byLogin = new Map();
    for (const b of winner.bets) {
      const cur = byLogin.get(b.login) ?? { login: b.login, name: b.name, stake: 0 };
      cur.stake += b.amount;
      byLogin.set(b.login, cur);
    }
    const stake = this._sum(winner.bets);
    const shares = [...byLogin.values()].map((w) => ({
      login: w.login,
      name: w.name,
      stake: w.stake,
      amount: Math.floor((prizePool * w.stake) / stake),
    }));
    // остаток от округления раздаём сверху вниз по ставке
    let rest = prizePool - shares.reduce((s, w) => s + w.amount, 0);
    for (const w of [...shares].sort((a, b) => b.stake - a.stake)) {
      if (rest <= 0) break;
      w.amount += 1;
      rest -= 1;
    }
    result.prizePool = prizePool;
    result.payouts = shares.map((w) => ({ login: w.login, amount: w.amount }));
    result.top = [...shares].sort((a, b) => b.amount - a.amount);
    this.logs.system.push({ level: 'info', message: `Ставки: «${pool.question}» — итог «${winner.label}», банк ${pot} → выплачено ${result.payouts.length} игрокам` });
    return result;
  }

  /** Закрыть всё просроченное; вернуть список возвратов [{login, amount}]. */
  closeExpired(nowDbg) {
    const now = nowDbg ?? Date.now();
    const refunds = [];
    for (const [ch, pool] of [...this._pools]) {
      if (now < pool.expiresAt) continue;
      const byLogin = new Map();
      for (const o of pool.options) {
        for (const b of o.bets) {
          const cur = byLogin.get(b.login) ?? { login: b.login, amount: 0 };
          cur.amount += b.amount;
          byLogin.set(b.login, cur);
        }
      }
      this._pools.delete(ch);
      this.logs.system.push({ level: 'info', message: `Ставки: «${pool.question}» закрыта по времени — возвратов: ${byLogin.size}` });
      refunds.push(...byLogin.values());
    }
    for (const [ch, duel] of [...this._duels]) {
      if (now < duel.expiresAt) continue;
      this._duels.delete(ch);
      this.logs.system.push({ level: 'info', message: `Дуэль ${duel.from.login} → @${duel.to} не принята — ставка возвращается` });
      refunds.push({ login: duel.from.login, amount: duel.amount });
    }
    return refunds;
  }

  // ---------------- дуэли ----------------

  pendingDuel(channelId) {
    return this._duels.get(this._key(channelId)) ?? null;
  }

  /** Вызвать на дуэль: списание у вызвавшего делает команда сразу после этого. */
  challenge({ channelId, fromLogin, fromName = '', toLogin, amount }) {
    const cfg = this.cfg();
    if (cfg.enabled === false) return { error: 'ставки выключены' };
    const ch = this._key(channelId);
    const from = this._loginOf(fromLogin);
    const to = this._loginOf(toLogin);
    if (!ch || !from) return { error: 'не поняли, кто вызывает' };
    if (!to) return { error: 'укажи ник: !дуэль @ник сумма' };
    if (to === from) return { error: 'нельзя вызвать самого себя' };
    const waiting = this._duels.get(ch);
    if (waiting) {
      return { error: `сначала закончится дуэль ${waiting.from.name || waiting.from.login} → @${waiting.to} (${waiting.amount})` };
    }
    const n = Number(amount);
    if (!Number.isInteger(n)) return { error: 'сумма дуэли — целое число' };
    if (n <= 0) return { error: 'укажи ставку: !дуэль @ник сумма' };
    const min = Math.max(1, Number(cfg.minBet) || 10);
    const max = Math.max(min, Number(cfg.maxBet) || 1000);
    if (n < min) return { error: `минимальная ставка ${min}` };
    if (n > max) return { error: `максимальная ставка ${max}` };
    const cd = Math.max(0, Number(cfg.duelCooldown) || 0);
    const last = this._duelLast.get(from) || 0;
    if (cd && Date.now() - last < cd * 1000) {
      const left = Math.ceil((cd * 1000 - (Date.now() - last)) / 1000);
      return { error: `охлади пыл — следующая дуэль через ${left} сек` };
    }
    this._duels.set(ch, {
      channelId: ch,
      from: { login: from, name: String(fromName || '').trim().slice(0, 40) || from },
      to,
      amount: n,
      createdAt: Date.now(),
      expiresAt: Date.now() + this._dur(cfg.durationSec) * 1000,
    });
    this._duelLast.set(from, Date.now());
    return { amount: n, to };
  }

  /** Снять ждущий вызов (откат/отказ) — возвращает дуэль или null. */
  cancelChallenge({ channelId }) {
    const ch = this._key(channelId);
    const duel = this._duels.get(ch);
    if (!duel) return null;
    this._duels.delete(ch);
    this.logs.system.push({ level: 'info', message: `Дуэль ${duel.from.login} → @${duel.to} снята (возврат ${duel.amount})` });
    return duel;
  }

  /**
   * Принять вызов (вызвать может только обещанный: duel.to === login).
   * Сумму и противника сверяет команда по pendingDuel(); списание у принявшего
   * и выплату победителю (add на 2N) тоже делает команда по результату.
   */
  accept({ channelId, login, name = '' }) {
    const ch = this._key(channelId);
    const duel = this._duels.get(ch);
    const who = this._loginOf(login);
    if (!duel) return { error: 'тебя никто не вызывал' };
    if (duel.to !== who) return { error: `сначала закончится вызов к @${duel.to}` };
    this._duels.delete(ch);
    this._duelLast.set(who, Date.now());
    const roll = this._rollWinner();
    const aWon = roll.winner === 'a';
    const res = {
      amount: duel.amount,
      prize: duel.amount * 2,
      from: duel.from,
      to: { login: who, name: String(name || '').trim().slice(0, 40) || who },
      winner: aWon ? 'a' : 'b',
      winnerLogin: aWon ? duel.from.login : who,
      loserLogin: aWon ? who : duel.from.login,
    };
    this.logs.system.push({ level: 'info', message: `Дуэль: ${duel.from.login} против ${who} — победил ${res.winnerLogin}` });
    return res;
  }

  /** Монетка 50/50: 'a' — вызывающий, 'b' — принимающий. Тесты подменяют метод. */
  _rollWinner() {
    return Math.random() < 0.5 ? { winner: 'a' } : { winner: 'b' };
  }

  // ---------------- жизненный цикл ----------------

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), 5_000);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    // открытые ставки и дуэли не должны пропасть вместе с ботом — вернём всё
    this._give(this.closeExpired(Number.MAX_SAFE_INTEGER), 'остановка бота');
  }

  _tick() {
    // кулдауны дуэлей не копятся вечно: подметаем записи старше часа
    const now = Date.now();
    for (const [login, ts] of [...this._duelLast]) {
      if (now - ts > 3_600_000) this._duelLast.delete(login);
    }
    this._give(this.closeExpired(), 'время вышло');
  }

  _give(refunds, reason) {
    for (const r of refunds) {
      if (this.points) this.points.add(r.login, r.amount);
      this.logs.system.push({ level: 'info', message: `Возврат баллов (${reason}): @${r.login} +${r.amount}` });
    }
  }
}
