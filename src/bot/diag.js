/**
 * Файл-диагностика: data/diag.log — системные сообщения последних ДВУХ запусков.
 *
 * Зачем: юзер шлёт файл — видно всю картину запуска (ошибки сети, авторизации,
 * подключения) без доступа к его панели.
 *
 * Без личной информации: ники (@login → @***), токены/секреты (client_secret,
 * access_token, длинные hex/base64-подобные строки), query-параметры URL.
 * Имена каналов бота оставляются — без них не разобрать «каналы не найдены».
 *
 * Ротация: при старте в файле остаётся только прошлый запуск + начинается новый.
 * Пишутся только system-сообщения (не чат) + падения процесса.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../store.js';

const DIAG_FILE = path.join(DATA_DIR, 'diag.log');
const RUN_MARK = '=== ЗАПУСК';

/** Логин → частичная маска: k***a (видно, что за канал, но ник не светится). */
function maskLogin(ln) {
  const s = String(ln || '');
  return s.length <= 2 ? s : `${s[0]}***${s.at(-1)}`;
}

/** Убрать личное из строки лога. */
export function diagSanitize(text) {
  return String(text ?? '')
    // ники: «@ логин» в любом месте
    .replace(/@[A-Za-z0-9_]{2,}/g, '@***')
    // секреты по имени ключа
    .replace(/\b(client_secret|client-secret|access_token|refresh_token|password|token)\b([=:]\s*)(\S+)/gi, '$1$2***')
    // query-параметры URL (могут содержать коды авторизации)
    .replace(/\?[^ \t"']{8,}/g, '?***')
    // длинные hex (oauth-токены, id сессий)
    .replace(/\b[0-9a-f]{24,}\b/gi, '***')
    // oauth-подобные base64url-простыни (JWT и т.п.)
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, (m) => (m.length >= 40 ? '***' : m))
    // id сессий EventSub и uuid-подобные (с дефисами, ≥16 символов)
    .replace(/\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b/g, (m) => (m.length >= 16 ? '***' : m))
    // id EventSub-сессий (base64-подобные, даже без дефисов): «сессия X)» — X в ***
    .replace(/(сесси[яию][\s:])([A-Za-z0-9_-]{12,})/gi, '$1***')
    // логины бота/стримера/каналов: частичная маска (сохраняет диагностическую ценность)
    .replace(/(Бот)\s+([A-Za-z0-9_]{2,})/g, (m, p, ln) => `${p} ${maskLogin(ln)}`)
    .replace(/((?:найден|вход)[^:\n]*:\s*)([A-Za-z0-9_]+)/gi, (m, p, ln) => p + maskLogin(ln))
    .replace(/(подключается к каналам:\s*)(.+)/gi, (m, p, list) => p + list.split(/,\s*/).map((w) => w.trim()).map(maskLogin).join(', '));
}

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** Начало запуска: оставить в файле только прошлый запуск, начать новый раздел. */
export function diagStart({ version = '' } = {}) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    let runs = [];
    try {
      const raw = fs.readFileSync(DIAG_FILE, 'utf8');
      const marks = [...raw.matchAll(/^=== ЗАПУСК.*$/gm)].map((m) => m.index);
      // пары «заголовок + тело», маркеры не съедаем — версия запуска нужна в файле
      for (let i = 0; i < marks.length; i++) {
        const body = raw.slice(marks[i], i + 1 < marks.length ? marks[i + 1] : raw.length).trim();
        if (body) runs.push(body);
      }
    } catch { /* первый запуск — файла нет */ }
    const prev = runs.at(-1) ?? null; // всё старше прошлого запуска — выбрасываем
    const head = `${RUN_MARK} ${stamp()} | v${version} | node ${process.version} | ${process.platform}`;
    // маркер пишем с \n\n до и после — параграфом, чтобы парсер не склеил секции
    fs.writeFileSync(DIAG_FILE, `${[prev, head].filter(Boolean).join('\n\n')}\n`, 'utf8');
  } catch { /* диск недоступен — диагностика не должна ронять бота */ }
}

/** Одна строка в файл (санитизированная). */
export function diagLog(level, message) {
  try {
    fs.appendFileSync(DIAG_FILE, `${stamp()} [${String(level || 'info')}] ${diagSanitize(message)}\n`, 'utf8');
  } catch { /* никогда не роняем бот из-за лога */ }
}

/**
 * Подключить к системному логу: всё, что попадает в logs.system, дублируется
 * в файл-диагностику. Плюс несъедобные падения процесса.
 */
export function diagAttach(logs) {
  const orig = logs.system.push.bind(logs.system);
  logs.system.push = (entry) => {
    try { diagLog(entry?.level ?? 'info', entry?.message ?? ''); } catch {}
    return orig(entry);
  };
  process.on('uncaughtException', (e) => {
    diagLog('error', `ПАДЕНИЕ ПРОЦЕССА: ${e?.message ?? e}`);
  });
  process.on('unhandledRejection', (e) => {
    diagLog('error', `Необработанный отказ промиса: ${e?.message ?? e}`);
  });
}
