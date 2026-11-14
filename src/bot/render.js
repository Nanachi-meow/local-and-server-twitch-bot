/** Подстановка переменных в текст: {user}, {target}, {uptime}, {random:1-10} и т.д. */
export function renderTemplate(text, vars) {
  return String(text ?? '')
    .replace(/\{random:(\d+)-(\d+)\}/g, (_, a, b) => {
      const lo = Math.max(0, parseInt(a, 10) || 0);
      const hi = Math.max(lo, parseInt(b, 10) || lo);
      return String(lo + Math.floor(Math.random() * (hi - lo + 1)));
    })
    .replace(/\{(\w+)\}/g, (_, key) => (vars[key] !== undefined && vars[key] !== null ? String(vars[key]) : ''));
}

/** Русская плюрализация: plural(5, ['день','дня','дней']) => 'дней' */
export function plural(n, forms) {
  const abs = Math.abs(n) % 100;
  const n1 = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

/** 'ч 2 м 05' → pretty '2 ч 5 м' */
export function fmtDuration(ms) {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const minutes = totalMin % 60;
  const parts = [];
  if (days) parts.push(`${days} ${plural(days, ['день', 'дня', 'дней'])}`);
  if (hours) parts.push(`${hours} ${plural(hours, ['час', 'часа', 'часов'])}`);
  if (minutes || !parts.length) parts.push(`${minutes} ${plural(minutes, ['минута', 'минуты', 'минут'])}`);
  return parts.join(' ');
}

/** Возраст фоллоу в человекочитаемом виде. */
export function humanizeSince(isoString) {
  const then = Date.parse(isoString);
  if (Number.isNaN(then)) return 'неизвестно';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days < 1) return 'меньше дня';
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);
  if (years >= 1) {
    const rest = months % 12;
    return rest ? `${years} ${plural(years, ['год', 'года', 'лет'])} ${rest} ${plural(rest, ['месяц', 'месяца', 'месяцев'])}` : `${years} ${plural(years, ['год', 'года', 'лет'])}`;
  }
  if (months >= 1) {
    const rest = days % 30;
    return rest ? `${months} ${plural(months, ['месяц', 'месяца', 'месяцев'])} ${rest} ${plural(rest, ['день', 'дня', 'дней'])}` : `${months} ${plural(months, ['месяц', 'месяца', 'месяцев'])}`;
  }
  return `${days} ${plural(days, ['день', 'дня', 'дней'])}`;
}
