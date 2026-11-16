/* Самотест без сети: шаблоны, уровни доступа, движок команд, события. */
process.env.BOT_DATA_DIR = `${process.env.TEMP || '/tmp'}/twitch-bot-selftest-${Date.now()}`;

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const { renderTemplate, plural, fmtDuration, humanizeSince } = await import('../src/bot/render.js');
const { CommandEngine, userLevel, RESERVED } = await import('../src/bot/commands.js');
const { EventProcessor } = await import('../src/bot/events.js');
const { logs } = await import('../src/logs.js');

let passed = 0;
function ok(name, cond) {
  if (!cond) throw new Error(`ТЕСТ ПРОВАЛЕН: ${name}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ---------------- рендер шаблонов ----------------
ok('шаблон {user}', renderTemplate('Привет, {user}!', { user: 'Вася' }) === 'Привет, Вася!');
ok('неизвестная переменная убирается', renderTemplate('а {nope} б', {}) === 'а  б');
const rnd = renderTemplate('{random:1-3}', {});
ok('random в диапазоне', ['1', '2', '3'].includes(rnd));
ok('plural 1 день', plural(1, ['день', 'дня', 'дней']) === 'день');
ok('plural 2 дня', plural(2, ['день', 'дня', 'дней']) === 'дня');
ok('plural 5 дней', plural(5, ['день', 'дня', 'дней']) === 'дней');
ok('fmtDuration', fmtDuration(65 * 60_000) === '1 час 5 минут');
ok('humanizeSince (1 день назад)', /1 день/.test(humanizeSince(new Date(Date.now() - 86_400_000).toISOString())));

// ---------- уровни доступа ----------
ok('уровень: модератор', userLevel([{ set_id: 'moderator' }], '5', '100') === 'mod');
ok('уровень: броадкастер по id', userLevel([], '100', '100') === 'broadcaster');
ok('уровень: вип', userLevel([{ set_id: 'vip' }]) === 'vip');
ok('уровень: саб', userLevel([{ set_id: 'subscriber' }]) === 'sub');
ok('уровень: все', userLevel([]) === 'everyone');

// ---------- движок команд ----------
const sent = [];
const fakeHelix = {
  sendMessage: async ({ text }) => { sent.push(text); return { message_id: `m-${sent.length}` }; },
  getStreamByLogin: async () => null,
  getUserByLogin: async (login) => ({ id: '42', login, display_name: login }),
  getFollower: async () => null,
  shoutout: async () => ({}),
  getPinned: async () => null,
  pinMessage: async () => ({}),
  unpinMessage: async () => ({}),
  announce: async ({ text }) => { sent.push(text); },
};
const fakeAuth = { tokens: { userId: '1', login: 'testbot' } };
const settings = { events: {}, so: { template: 'GO {target}' } };
const state = { counters: {} };

const engine = new CommandEngine({ helix: fakeHelix, auth: fakeAuth, logs, settings, state });
engine.setContext({ broadcasterId: '100', botUserId: '1', channel: 'mychannel' });

engine.upsert({ name: 'привет', response: 'Привет, {user}!', level: 'everyone', cooldown: 30 });

await engine.handleChatMessage({ userId: '7', login: 'vasya', displayName: 'Vasya', text: '!привет', badges: [] });
ok('кастомная команда сработала', sent.at(-1) === 'Привет, Vasya!');
await engine.handleChatMessage({ userId: '7', login: 'vasya', displayName: 'Vasya', text: '!привет', badges: [] });
ok('кулдаун держит', sent.at(-1) === 'Привет, Vasya!');
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!привет', badges: [] });
ok('другой пользователь не под кулдауном', sent.at(-1) === 'Привет, Petya!');

engine.upsert({ name: 'секрет', response: 'только для модов', level: 'mod', cooldown: 0 });
const before = sent.length;
await engine.handleChatMessage({ userId: '9', login: 'viewer', displayName: 'Viewer', text: '!секрет', badges: [] });
ok('обычному зрителю нельзя', sent.length === before);
await engine.handleChatMessage({ userId: '9', login: 'modguy', displayName: 'ModGuy', text: '!секрет', badges: [{ set_id: 'moderator' }] });
ok('моду можно', sent.at(-1) === 'только для модов');

// свои сообщения бот не обрабатывает
const beforeSelf = sent.length;
await engine.handleChatMessage({ userId: '1', login: 'testbot', displayName: 'Bot', text: '!привет', badges: [] });
ok('игнор собственных сообщений', sent.length === beforeSelf);

// addcmd через чат
await engine.handleChatMessage({ userId: '9', login: 'modguy', displayName: 'ModGuy', text: '!addcmd !дискорд Древний: {user}', badges: [{ set_id: 'moderator' }] });
ok('addcmd через чат', engine.custom.some((c) => c.name === 'дискорд' && c.response === 'Древний: {user}'));
await engine.handleChatMessage({ userId: '10', login: 'girl', displayName: 'Girl', text: '!дискорд', badges: [] });
ok('новая команда отвечает', sent.at(-1) === 'Древний: Girl');

// delcmd
await engine.handleChatMessage({ userId: '9', login: 'modguy', displayName: 'ModGuy', text: '!delcmd !дискорд', badges: [{ set_id: 'moderator' }] });
ok('delcmd через чат', !engine.custom.some((c) => c.name === 'дискорд'));

// зарезервированное имя нельзя
let threw = false;
try { engine.upsert({ name: 'so', response: 'хак' }); } catch { threw = true; }
ok('зарезервированное имя отклонено', threw);
ok('RESERVED содержит pin', RESERVED.has('pin'));

// встроенная команда !uptime (оффлайн)
await engine.handleChatMessage({ userId: '11', login: 'x', displayName: 'X', text: '!uptime', badges: [] });
ok('uptime при оффлайне', sent.at(-1).includes('оффлайн'));

// ---------- типы команд: РП и рандом ----------
engine.upsert({ name: 'обнять', type: 'rp', action: '{user} крепко обнимает {target} 🤗', level: 'everyone', cooldown: 0 });
await engine.handleChatMessage({ userId: '7', login: 'vasya', displayName: 'Vasya', text: '!обнять @petya', badges: [] });
ok('рп: действие на цель', sent.at(-1) === 'Vasya крепко обнимает petya 🤗');
await engine.handleChatMessage({ userId: '7', login: 'vasya', displayName: 'Vasya', text: '!обнять', badges: [] });
ok('рп: без цели — действие на самого себя', sent.at(-1) === 'Vasya крепко обнимает Vasya 🤗');

engine.upsert({ name: 'хорни', type: 'random', variants: ['{user} хорни на {random:0-100}% 😳'], chance: 100, level: 'everyone', cooldown: 0 });
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!хорни', badges: [] });
ok('рандом: подстановка процента', /^Petya хорни на \d+% 😳$/.test(sent.at(-1)));

engine.upsert({ name: 'кубик', type: 'random', variants: ['выпал орёл', 'выпала решка'], chance: 100, level: 'everyone', cooldown: 0 });
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!кубик', badges: [] });
ok('рандом: ответ из списка вариантов', ['выпал орёл', 'выпала решка'].includes(sent.at(-1)));

engine.upsert({ name: 'мимик', type: 'random', variants: ['попался!'], chance: 0, level: 'everyone', cooldown: 0 });
const beforeMimic = sent.length;
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!мимик', badges: [] });
await engine.handleChatMessage({ userId: '9', login: 'modguy', displayName: 'ModGuy', text: '!мимик', badges: [] });
ok('рандом: шанс 0% — бот молчит', sent.length === beforeMimic);

let rpThrew = false;
try { engine.upsert({ name: 'пнуть', type: 'rp', level: 'everyone' }); } catch { rpThrew = true; }
ok('рп: без описания действия — ошибка валидации', rpThrew);
let rndThrew = false;
try { engine.upsert({ name: 'пустышка', type: 'random', level: 'everyone' }); } catch { rndThrew = true; }
ok('рандом: без вариантов — ошибка валидации', rndThrew);

// старые команды без типа остаются текстовыми
const legacy = engine.custom.find((c) => c.name === 'секрет');
ok('легаси-команда без типа — как текст', legacy && (legacy.type || 'text') === 'text');

// счётчик вызовов не теряется при сохранении из панели (upsert без count)
const privet = engine.custom.find((c) => c.name === 'привет');
privet.count = 41;
engine.upsert({ name: 'привет', response: 'Привет, {user}!', level: 'everyone', cooldown: 30 });
ok('счётчик вызовов живёт при редактировании', engine.custom.find((c) => c.name === 'привет').count === 41);

// ---------- фан-команды: условие «нужен @ник» и рандом-число ----------
engine.upsert({ name: 'тестпуск', mode: 'text', needsTarget: true, response: '{user} пускает {target} в Infinity', cooldown: 0, level: 'everyone' });
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!тестпуск', badges: [] });
ok('таргет: без @ник — подсказка', sent.at(-1) === 'укажи ник: !тестпуск @ник');
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!тестпуск @маша', badges: [] });
ok('таргет: с @ник — работает', sent.at(-1) === 'Petya пускает маша в Infinity');

engine.upsert({ name: 'тестселф', mode: 'text', response: '{user} гладит {target}', cooldown: 0, level: 'everyone' });
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!тестселф', badges: [] });
ok('без аргумента {target} = сам вызвавший', sent.at(-1) === 'Petya гладит Petya');

// рандом-число: ролл фиксирован (rollMin = rollMax = 42) — проверки точные
engine.upsert({
  name: 'тестхорни', mode: 'roll', rollMin: 42, rollMax: 42,
  ranges: [
    { from: 40, to: 50, text: '{user} хорни на {roll}% — очень хорни 😳' },
    { from: 90, to: 99, text: '{user} хорни на {roll}% — срочно остудитесь 🧊' },
  ],
  response: '{user} хорни на {roll}% — среднячок',
  cooldown: 0, level: 'everyone',
});
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!тестхорни', badges: [] });
ok('рандом-число: диапазон 40-50 ловит 42', sent.at(-1) === 'Petya хорни на 42% — очень хорни 😳');

engine.upsert({
  name: 'тестмимо', mode: 'roll', rollMin: 42, rollMax: 42,
  ranges: [{ from: 90, to: 100, text: 'срочно остудитесь 🧊' }],
  response: '{user} хорни на {roll}% — среднячок',
  cooldown: 0, level: 'everyone',
});
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!тестмимо', badges: [] });
ok('рандом-число: непокрытое число — заглушка', sent.at(-1) === 'Petya хорни на 42% — среднячок');

engine.upsert({ name: 'тестмолчун2', mode: 'text', response: 'шу', chance: 0, cooldown: 0, level: 'everyone' });
const silentBefore = sent.length;
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!тестмолчун2', badges: [] });
ok('текст с шансом 0% молчит', sent.length === silentBefore);

// миграция: старое РП-«действие» переезжает в response
const hugCmd = engine.custom.find((c) => c.name === 'обнять');
ok('легаси рп: action переехал в response', hugCmd.mode === 'text' && hugCmd.response === '{user} крепко обнимает {target} 🤗');
// миграция: старые type:'random' стали mode:'variants'
const hornyCmd = engine.custom.find((c) => c.name === 'хорни');
ok('легаси random: стал variants', hornyCmd.mode === 'variants' && hornyCmd.variants.length === 1);

// ---------- музыка: заказы YouTube (бесплатные — баллов больше нет) ----------
const { parseVideoId, SongsManager } = await import('../src/bot/songs.js');
ok('музыка: parseVideoId youtu.be', parseVideoId('https://youtu.be/dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
ok('музыка: parseVideoId watch?v= с параметрами', parseVideoId('https://www.youtube.com/watch?t=42&v=abc12345678') === 'abc12345678');
ok('музыка: parseVideoId shorts и голый ID', parseVideoId('https://youtube.com/shorts/aabbccdde11') === 'aabbccdde11' && parseVideoId('dQw4w9WgXcQ') === 'dQw4w9WgXcQ');
ok('музыка: parseVideoId мусор → null', parseVideoId('https://twitch.tv/x') === null && parseVideoId('') === null && parseVideoId('привет') === null);

const songsSettings = {
  events: {},
  songs: { enabled: true, maxLenSec: 600, perUser: 2, volume: 60, nowTemplate: '♪ {title} — заказал {by}' },
};
const songsFile = path.join(process.env.BOT_DATA_DIR, 'songs.json');
const fakeFetcher = async (url) => {
  if (url.includes('oembed')) {
    if (url.includes('badvideo000')) return { status: 404, body: '' };
    return { status: 200, body: JSON.stringify({ title: 'Never Gonna Give You Up', author_name: 'Rick Astley' }) };
  }
  // watch page
  if (url.includes('longvideo000')) return { status: 200, body: '"lengthSeconds":"99999"' };
  return { status: 200, body: '"lengthSeconds":"213"' };
};
const sm = new SongsManager({ logs, settings: songsSettings, dataFile: songsFile, fetcher: fakeFetcher });
engine.setSongs(sm);

const sr = await sm.add({ videoId: 'dQw4w9WgXcQ', by: 'Petya', byName: 'Petya' });
ok('музыка: первый заказ сразу играет', !sr.error && sm.current?.id === 'dQw4w9WgXcQ' && sr.position === 0);
const dup = await sm.add({ videoId: 'dQw4w9WgXcQ', by: 'Vasya', byName: 'Vasya' });
ok('музыка: дубликат отклоняется', Boolean(dup.error));
await sm.add({ videoId: 'abc12345678', by: 'Petya', byName: 'Petya' });
await sm.add({ videoId: 'aabbccdde11', by: 'Petya', byName: 'Petya' });
ok('музыка: лимит на юзера в очереди', sm.queue.length === 2);
const long = await sm.add({ videoId: 'longvideo000', by: 'Vova', byName: 'Vova' });
ok('музыка: длинный трек отклоняется', Boolean(long.error) && long.error.includes('длинно'));
const bad = await sm.add({ videoId: 'badvideo000', by: 'Vova', byName: 'Vova' });
ok('музыка: несуществующее видео отклоняется', Boolean(bad.error));

sm.ended();
ok('музыка: ended продвигает очередь', sm.current?.id === 'abc12345678' && sm.history.length === 1);
sm.control('pause');
ok('музыка: пауза', sm.paused === true);
sm.control('resume');
ok('музыка: снята с паузы', sm.paused === false);
sm.saveNow();
const storedSongs = JSON.parse(fs.readFileSync(songsFile, 'utf8'));
ok('музыка: очередь сохраняется в файл', Array.isArray(storedSongs.queue) && storedSongs.queue.length === 1 && storedSongs.current?.id === 'abc12345678');

// команды через движок: заказ бесплатный (цена теперь живёт в самой награде на Twitch)
await engine.handleChatMessage({ userId: '10', login: 'girl', displayName: 'Girl', text: '!ср https://youtu.be/qwer1234567', badges: [] });
ok('музыка: !ср заказ бесплатный', sent.at(-1).includes('в очереди') && sm.queue.some((s) => s.by === 'girl'));
await engine.handleChatMessage({ userId: '10', login: 'girl', displayName: 'Girl', text: '!ср это-не-ссылка', badges: [] });
ok('музыка: не-ссылка отклоняется', sent.at(-1).includes('не похоже'));
await engine.handleChatMessage({ userId: '10', login: 'girl', displayName: 'Girl', text: '!очередь', badges: [] });
ok('музыка: !очередь отвечает', sent.at(-1).startsWith('🎵'));
await engine.handleChatMessage({ userId: '9', login: 'modguy', displayName: 'ModGuy', text: '!скип', badges: [{ set_id: 'moderator' }] });
ok('музыка: !скип (мод+) работает', sent.at(-1).includes('скипнут'));

let srNameThrew = false;
try { engine.upsert({ name: 'ср', response: 'хак' }); } catch { srNameThrew = true; }
ok('музыка: имена зарезервированы', srNameThrew && RESERVED.has('ср') && RESERVED.has('музыка'));

// ---------- события ----------
const evSettings = {
  events: {
    follow: { enabled: true, mode: 'chat', color: 'purple', pin: false, template: '💜 {user} с нами!' },
    raid: { enabled: false, mode: 'chat', color: 'purple', pin: false, template: '🚀 {user}' },
  },
  so: { template: 'go' },
};
const processor = new EventProcessor({ helix: fakeHelix, auth: fakeAuth, logs, settings: evSettings, state: Object.assign(state, { counters: {} }) });
processor.setContext({ broadcasterId: '100', channel: 'mychannel' });

await processor.fire('follow', { user: 'NewGirl' });
ok('follow отправляет шаблон', sent.at(-1) === '💜 NewGirl с нами!');
await processor.fire('raid', { user: 'Raider' });
ok('отключённый рейд не пишет в чат', sent.at(-1) === '💜 NewGirl с нами!');
await processor.test('raid');
ok('тест рейда принудительно отправляет', sent.at(-1) === '🚀 ТестРейдер');

// дедуп рейдов
const raidsBefore = state.counters.raid || 0;
await processor.onRaid({ user: 'R', login: 'rr', viewers: 5, toId: '100' });
await processor.onRaid({ user: 'R', login: 'rr', viewers: 5, toId: '100' });
ok('дедуп рейдов', state.counters.raid === raidsBefore + 1);
await processor.onRaid({ user: 'X', login: 'xx', viewers: 5, toId: '777' });
ok('чужой рейд игнорируется', state.counters.raid === raidsBefore + 1);

// ---------- мультиканальность ----------
const sentM = [];
const fakeHelixM = {
  sendMessage: async (b) => { sentM.push(b); return { message_id: 'm' }; },
  getStreamByLogin: async () => null,
  getUserByLogin: async (login) => ({ id: '42', login, display_name: login }),
  getFollower: async () => null,
};
const registry = {
  _m: new Map([['100', { id: '100', login: 'alpha' }], ['200', { id: '200', login: 'beta' }]]),
  get(id) { return this._m.get(String(id)) ?? null; },
  loginOf(id) { return this._m.get(String(id))?.login ?? null; },
  byLogin(login) { const key = String(login || '').toLowerCase(); return this.list().find((c) => c.login === key) ?? null; },
  list() { return [...this._m.values()]; },
};
const engineM = new CommandEngine({ helix: fakeHelixM, auth: fakeAuth, logs, settings, state: { counters: {} } });
engineM.setChannels(registry);
engineM.upsert({ name: 'привет', response: 'канал {channel}, от {user}', level: 'everyone', cooldown: 0 });
await engineM.handleChatMessage({ broadcasterId: '200', userId: '7', login: 'vova', displayName: 'Vova', text: '!привет', badges: [] });
ok('мультиканал: ответ ушёл в канал-источник (beta)', sentM.at(-1)?.broadcasterId === '200');
ok('мультиканал: {channel} = канал-источник', sentM.at(-1)?.text === 'канал beta, от Vova');
await engineM.handleChatMessage({ broadcasterId: '100', userId: '7', login: 'vova', displayName: 'Vova', text: '!привет', badges: [] });
ok('мультиканал: другой канал (alpha)', sentM.at(-1)?.broadcasterId === '100' && sentM.at(-1)?.text === 'канал alpha, от Vova');

const evSettings2 = { events: { follow: { enabled: true, mode: 'chat', color: 'purple', pin: false, template: '{channel}: привет, {user}' } } };
const processor2 = new EventProcessor({ helix: fakeHelixM, auth: fakeAuth, logs, settings: evSettings2, state: { counters: {} }, channels: registry });
await processor2.onFollow({ broadcaster_user_id: '200', user_name: 'N', user_login: 'n' });
ok('событие уходит в правильный канал', sentM.at(-1)?.broadcasterId === '200' && sentM.at(-1)?.text === 'beta: привет, N');
await processor2.onFollow({ broadcaster_user_id: '777', user_name: 'X', user_login: 'x' });
ok('чужой фоллоу игнорируется', sentM.at(-1)?.broadcasterId === '200');

// ---------- автошатауты ----------
const sentSo = [];
const soCalls = [];
const fakeHelixSo = {
  sendMessage: async (b) => { sentSo.push(b); return { message_id: 'm' }; },
  shoutout: async (q) => { soCalls.push(q); return {}; },
  getUserByLogin: async (login) => ({ id: '55', login, display_name: 'Friend' }),
  getStreamByLogin: async () => null,
};
const soSettings = {
  events: {},
  autoShoutouts: {
    enabled: true,
    cooldownMinutes: 240,
    defaultTemplate: 'def → {target_login}',
    users: [{ login: 'friend', text: 'Привет, {target}! → twitch.tv/{target_login}' }],
  },
};
const processor3 = new EventProcessor({ helix: fakeHelixSo, auth: fakeAuth, logs, settings: soSettings, state: { counters: {} }, channels: registry });
await processor3.onChatMessage({ broadcaster_user_id: '200', chatter_user_id: '55', chatter_user_login: 'friend', chatter_user_name: 'Friend', message: { text: 'всем привет!' }, badges: [] });
ok('автошатаут: текст ушел в чат', sentSo.at(-1)?.text === 'Привет, Friend! → twitch.tv/friend');
ok('автошатаут: настоящая карточка через API', soCalls.length === 1 && soCalls[0].fromId === '200' && soCalls[0].toUserId === '55');
await processor3.onChatMessage({ broadcaster_user_id: '200', chatter_user_id: '55', chatter_user_login: 'friend', chatter_user_name: 'Friend', message: { text: 'ещё сообщение' }, badges: [] });
ok('автошатаут: кулдаун держит', soCalls.length === 1 && sentSo.length === 1);
await processor3.onChatMessage({ broadcaster_user_id: '200', chatter_user_id: '9', chatter_user_login: 'stranger', chatter_user_name: 'Stranger', message: { text: 'привет' }, badges: [] });
ok('автошатаут: человек не из списка не триггерит', soCalls.length === 1 && sentSo.length === 1);
await processor3.autoShoutoutFor('200', { login: 'friend', text: '' }, { force: true });
ok('автошатаут: принудительный тест берёт дефолтный шаблон', sentSo.at(-1)?.text === 'def → friend');

// ---------- автозакреп ----------
const sentPin = [];
const pinCalls = [];
const fakeHelixPin = {
  sendMessage: async (b) => { sentPin.push({ ...b }); return { message_id: 'pin-1' }; },
  pinMessage: async (q) => { pinCalls.push(q); },
  getUserByLogin: async (login) => ({ id: '55', login, display_name: login }),
  getStreamByLogin: async () => null,
};
const pinSettings = {
  events: {},
  autoShoutouts: { enabled: false, users: [] },
  autoPin: { enabled: true, mode: 'stream', template: 'закреп {channel}' },
};
const processor4 = new EventProcessor({ helix: fakeHelixPin, auth: fakeAuth, logs, settings: pinSettings, state: { counters: {} }, channels: registry });
await processor4.onStreamOnline({ broadcaster_user_id: '200' });
ok('автозакреп: сообщение ушло', sentPin.at(-1)?.text === 'закреп beta' && sentPin.at(-1)?.broadcasterId === '200');
ok('автозакреп: режим «до конца стрима» (без duration)', pinCalls.length === 1 && pinCalls[0].messageId === 'pin-1' && pinCalls[0].durationSeconds === undefined);
sentPin.length = 0;
pinCalls.length = 0;
pinSettings.autoPin.mode = '20';
await processor4.onStreamOnline({ broadcaster_user_id: '100' });
ok('автозакреп: режим «20 минут» закрепляет pin:true', sentPin.at(-1)?.pin === true && pinCalls.length === 0);
sentPin.length = 0;
pinSettings.autoPin.enabled = false;
await processor4.onStreamOnline({ broadcaster_user_id: '100' });
ok('автозакреп: выключен — молчит', sentPin.length === 0 && pinCalls.length === 0);

// ---------- таймеры (периодические сообщения) ----------
const sentT = [];
const fakeHelixT = {
  sendMessage: async (b) => { sentT.push({ ...b }); return { message_id: 'm' }; },
  getStreamByLogin: async (login) => (login === 'alpha'
    ? { started_at: new Date(Date.now() - 3600_000).toISOString(), game_name: 'Just Chatting', title: 'Title' }
    : null),
};
const timerSettings = {
  timers: {
    enabled: true,
    onlyWhenLive: true,
    items: [
      { id: 't1', name: 'Соцсети', text: 'Привет из {channel}! Игра: {game}, стрим уже {uptime}', intervalMinutes: 5, minMessages: 5, mode: 'time', enabled: true },
      { id: 't2', name: 'Выключенный', text: 'это не должно прийти', intervalMinutes: 1, minMessages: 1, mode: 'time', enabled: false },
    ],
  },
};
const { TimerRunner } = await import('../src/bot/timers.js');
const runner = new TimerRunner({ helix: fakeHelixT, auth: fakeAuth, logs, settings: timerSettings, channels: registry });

// «перемотка времени»: сдвигаем ts последнего выхода назад (все таймеры или конкретный id)
const ff = (r, ms, id = '') => {
  for (const k of [...r._last.keys()]) {
    if (!id || k.startsWith(`${id}:`)) r._last.set(k, r._last.get(k) - ms);
  }
};

await runner.tick();
ok('таймер: первый тик только армит (без мгновенного спама)', sentT.length === 0);
await runner.tick();
ok('таймер: без прошествия интервала молчит', sentT.length === 0);
ff(runner, 10 * 60_000); // прошло 10 минут ≥ интервал 5
await runner.tick();
ok('таймер: отправка только в живой канал', sentT.length === 1 && sentT[0].broadcasterId === '100' && sentT[0].text.includes('Привет из alpha!'));
ok('таймер: переменные стрима подставлены', sentT[0].text.includes('Just Chatting') && sentT[0].text.includes('1 час'));
ok('таймер: выключенный отдельно — молчит', !sentT.some((m) => m.text.includes('это не должно прийти')));
await runner.tick();
ok('таймер: интервал держит повтор', sentT.length === 1);

runner.touchAll(); // как после перезапуска/перенастройки
await runner.tick();
ok('таймер: после перенастройки ждёт интервал заново', sentT.length === 1);
timerSettings.timers.onlyWhenLive = false;
ff(runner, 10 * 60_000);
await runner.tick();
ok('таймер: без проверки live — все каналы', sentT.length === 3 && sentT[1].broadcasterId === '100' && sentT[2].broadcasterId === '200' && sentT[2].text.includes('Привет из beta!'));

timerSettings.timers.enabled = false;
await runner.tick();
ok('таймер: общий выключатель глушит всё', sentT.length === 3);
timerSettings.timers.enabled = true;

await runner.test('t1', 'beta');
ok('таймер: тест-кнопка пишет в выбранный канал', sentT.at(-1).broadcasterId === '200' && sentT.at(-1).text.includes('Привет из beta!'));
let timerTestThrew = false;
try { await runner.test('nope', 'beta'); } catch { timerTestThrew = true; }
ok('таймер: несуществующий id — ошибка', timerTestThrew);

// ---------- таймеры: режимы «по времени / по сообщениям / и / или» ----------
const sentModes = [];
const fakeHelixModes = {
  sendMessage: async (b) => { sentModes.push({ ...b }); return { message_id: 'm' }; },
  getStreamByLogin: async () => ({ started_at: new Date(Date.now() - 3600_000).toISOString(), game_name: 'G', title: 'T' }),
};
const modeSettings = {
  timers: {
    enabled: true,
    onlyWhenLive: false,
    items: [
      { id: 'msgt', name: 'по сообщениям', text: 'бум {channel}', intervalMinutes: 30, minMessages: 3, mode: 'messages', enabled: true },
      { id: 'andt', name: 'и', text: 'анд {channel}', intervalMinutes: 30, minMessages: 2, mode: 'and', enabled: true },
      { id: 'ort', name: 'или', text: 'ор {channel}', intervalMinutes: 30, minMessages: 2, mode: 'or', enabled: true },
    ],
  },
};
const mr = new TimerRunner({ helix: fakeHelixModes, auth: fakeAuth, logs, settings: modeSettings, channels: registry });
const note = (chId, who) => mr.noteChat({ broadcaster_user_id: chId, chatter_user_id: who });

await mr.tick(); // арминг всех трёх
note('100', '7'); note('100', '8'); // 2 сообщения в alpha
await mr.tick();
ok('режим «или»: стреляет по сообщениям, не дожидаясь времени', sentModes.filter((m) => m.text === 'ор alpha').length === 1);
ok('режим «по сообщениям»: ждёт порог (3 из 2)', !sentModes.some((m) => m.text.startsWith('бум')));
ok('режим «и»: ждёт и время, и сообщения', !sentModes.some((m) => m.text.startsWith('анд')));
ok('режимы: в канале без сообщений никто не стреляет', !sentModes.some((m) => m.text.endsWith(' beta')));

note('100', '9'); // третье сообщение
await mr.tick();
ok('режим «по сообщениям»: сработал на 3-м сообщении', sentModes.filter((m) => m.text === 'бум alpha').length === 1);
ok('режим «или»: счётчик сброшен после выхода', sentModes.filter((m) => m.text === 'ор alpha').length === 1);

ff(mr, 31 * 60_000, 'andt'); // минул интервал 30 минут (только у «и»)
await mr.tick();
ok('режим «и»: сработал, когда и время, и сообщения', sentModes.filter((m) => m.text === 'анд alpha').length === 1);

const beforeOwn = sentModes.length;
note('100', '1'); note('100', '1'); note('100', '1'); note('100', '1'); note('100', '1'); // сам бот (id 1)
await mr.tick();
ok('сообщения самого бота не считаются', sentModes.length === beforeOwn);

note('200', '7'); note('200', '8'); // активность в другом канале
await mr.tick();
ok('режимы: счётчики по каждому каналу отдельно', sentModes.filter((m) => m.text === 'ор beta').length === 1 && !sentModes.some((m) => m.text === 'бум beta'));

// ---------- модули ----------
const modsDir = path.join(process.env.BOT_DATA_DIR, 'modules');
fs.mkdirSync(modsDir, { recursive: true });
fs.writeFileSync(path.join(modsDir, 'mtest.js'), [
  "export default {",
  "  name: 'mtest',",
  "  description: 'тестовый',",
  "  settings: { chill: 5, включен: true },",
  "  commands: { 'модфакт': '{user} — модный факт!', 'модхорни': { mode: 'roll', rollMin: 42, rollMax: 42, response: '{user} хорни на {roll}% (модуль)' } },",
  "  events: {",
  "    'chat.message': async (m, api) => { if (m.message.text === '!модпеченька') await api.say('печенька от модуля'); },",
  "    'follow': async (ev, api) => { api.log(`follow:${ev.user_name}`); },",
  "    'sub': async (ev, api) => { api.log(`sub:${ev.chatter_user_name}`); },",
  "    'redemption': async (ev, api) => { api.log(`redemption:${ev?.reward?.title}`); },",
  "  },",
  "};",
].join('\n'), 'utf8');
fs.writeFileSync(path.join(modsDir, 'mbroken.js'), "throw new Error('бум при загрузке');\n", 'utf8');

const { ModuleManager } = await import('../src/bot/modules.js');
const sentMod = [];
const fakeHelixMod = {
  sendMessage: async (b) => { sentMod.push({ ...b }); return { message_id: 'm' }; },
  getUserByLogin: async (login) => ({ id: '55', login, display_name: login }),
  shoutout: async () => ({}),
  announce: async () => ({}),
  getStreamByLogin: async () => null,
};
const modsConfigFile = path.join(process.env.BOT_DATA_DIR, 'modules.json');
const mm = new ModuleManager({ dir: modsDir, configFile: modsConfigFile, helix: fakeHelixMod, auth: fakeAuth, logs, channels: registry });

await mm.load();
const mInfo = mm.list().find((m) => m.name === 'mtest');
const brokenInfo = mm.list().find((m) => m.name === 'mbroken');
ok('модуль: загрузился', Boolean(mInfo && !mInfo.error));
ok('модуль: сломанный помечен ошибкой и не мешает остальным', Boolean(brokenInfo?.error) && !mInfo?.error);
ok('модуль: настройки по умолчанию', mInfo.settings.chill === 5 && mInfo.settings.включен === true);

engine.setModules(mm);
await engine.handleChatMessage({ userId: '7', login: 'vasya', displayName: 'Vasya', text: '!модфакт', badges: [] });
ok('модуль: декларативная команда через движок', sent.at(-1) === 'Vasya — модный факт!');
await engine.handleChatMessage({ userId: '7', login: 'vasya', displayName: 'Vasya', text: '!модхорни', badges: [] });
ok('модуль: рандом-число из схемы модуля', sent.at(-1) === 'Vasya хорни на 42% (модуль)');

await mm.dispatch('channel.chat.message', { broadcaster_user_id: '200', chatter_user_id: '9', message: { text: '!модпеченька' } });
ok('модуль: хук chat.message пишет в канал события', sentMod.at(-1)?.broadcasterId === '200' && sentMod.at(-1)?.text === 'печенька от модуля');

await mm.dispatch('channel.follow', { broadcaster_user_id: '200', user_name: 'N' });
ok('модуль: хук follow дёргается', logs.system.items.some((l) => String(l?.message || '').includes('follow:N')));
await mm.dispatch('channel.chat.notification', { broadcaster_user_id: '200', notice_type: 'sub', chatter_user_name: 'P' });
ok('модуль: хук sub выводится из уведомления', logs.system.items.some((l) => String(l?.message || '').includes('sub:P')));

await mm.dispatch('channel.channel_points_custom_reward_redemption.add', {
  broadcaster_user_id: '200', user_login: 'n', user_name: 'N', user_input: 'хай', reward: { id: 'r1', title: 'мем' },
});
ok('модуль: хук redemption (награда канала) дёргается', logs.system.items.some((l) => String(l?.message || '').includes('redemption:мем')));

mm.updateSettings('mtest', { chill: 10 });
const storedMods = JSON.parse(fs.readFileSync(modsConfigFile, 'utf8'));
ok('модуль: настройки сохраняются в файл', storedMods.settings.mtest.chill === 10);

mm.setEnabled('mtest', false);
const sentModBefore = sentMod.length;
await mm.dispatch('channel.chat.message', { broadcaster_user_id: '200', chatter_user_id: '9', message: { text: '!модпеченька' } });
ok('модуль: выключенный молчит', sentMod.length === sentModBefore && mm.findCommand('модфакт') === null);
mm.setEnabled('mtest', true);

await mm.reload();
ok('модуль: reload живой', mm.list().some((m) => m.name === 'mtest' && !m.error));
mm.stop();

// ---------- алерты оверлея: fire() пушит в шину ----------
const { overlay } = await import('../src/bot/alerts.js');
const ovCaptured = [];
overlay.clients.add({ write: (s) => ovCaptured.push(String(s)) });
await processor.fire('follow', { user: 'N' }, { broadcasterId: '200' });
ok('алерт: follow уходит в шину оверлея', ovCaptured.some((s) => s.includes('"kind":"follow"') && s.includes('"user":"N"')));
await processor2.onRaid({ user: 'R', login: 'rr', viewers: 5, toId: '100' });
ok('алерт: raid уходит в шину оверлея', ovCaptured.some((s) => s.includes('"kind":"raid"')));
overlay.clients.clear();

// ---------- бесплатные фан-команды: колесо, мемы, говорилка (баллов больше нет) ----------
const ovFree = [];
overlay.clients.clear();
overlay.clients.add({ write: (s) => ovFree.push(String(s)) });

// настройки живого объекта движка: колесо с единственным «весомым» вариантом — детерминировано
settings.wheel = { enabled: true, cooldown: 60, items: [{ label: '💥 мимо', weight: 0 }, { label: '💎 ДЖЕКПОТ', weight: 10 }] };
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!колесо', badges: [] });
ok('колесо: бесплатный спин — исход из таблицы весов', sent.at(-1).includes('ДЖЕКПОТ')
  && ovFree.some((s) => s.includes('"kind":"wheel"') && s.includes('Petya')));
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!колесо', badges: [] });
ok('колесо: кулдаун держит повтор', sent.at(-1).includes('охлади'));
settings.wheel.cooldown = 0;

// мемы: бесплатно, список — только включённые, текст с {user} в оверлей
settings.memShop = {
  enabled: true, cooldown: 0,
  items: [{ name: 'ричка', text: '🐭 {user} запустил РИЧКУ!', sound: '', enabled: true }, { name: 'скрытый', text: 'не виден', sound: '', enabled: false }],
};
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!мем', badges: [] });
ok('мем: без названия — список включённых', sent.at(-1).includes('ричка') && !sent.at(-1).includes('скрытый'));
ovFree.length = 0;
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!мем ричка', badges: [] });
ok('мем: бесплатный алерт уходит в оверлей', ovFree.some((s) => s.includes('"kind":"meme"') && s.includes('Petya запустил РИЧКУ'))
  && sent.at(-1).includes('полетел'));
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!мем нетакого', badges: [] });
ok('мем: незнакомое название — список', sent.at(-1).includes('Мемы:'));

// говорилка: бесплатная, но с фильтрами и кулдауном
settings.say = { enabled: true, cooldown: 60, blocked: ['кринж'] };
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!сказать', badges: [] });
ok('сказать: без текста — подсказка', sent.at(-1).includes('Использование: !сказать'));
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!сказать это кринж', badges: [] });
ok('сказать: запрещённое слово — отказ', sent.at(-1).includes('запрещённое'));
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: `!сказать ${'а'.repeat(201)}`, badges: [] });
ok('сказать: длиннее 200 символов — отказ', sent.at(-1).includes('200'));
ovFree.length = 0;
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!сказать привет чат', badges: [] });
ok('сказать: бесплатная озвучка уходит в оверлей', ovFree.some((s) => s.includes('"kind":"meme"') && s.includes('🗣 Petya: привет чат')));
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!сказать ещё фраза', badges: [] });
ok('сказать: кулдаун держит повтор', sent.at(-1).includes('через'));
ovFree.length = 0;
await engine.handleChatMessage({ userId: '10', login: 'girl', displayName: 'Girl', text: '!сказать я girl', badges: [] });
ok('сказать: другой зритель не под кулдауном', ovFree.some((s) => s.includes('🗣 Girl: я girl')));
let sayNameThrew = false;
try { engine.upsert({ name: 'сказать', response: 'хак' }); } catch { sayNameThrew = true; }
ok('сказать: имя зарезервировано за встроенной', sayNameThrew && RESERVED.has('сказать'));

// удалённые команды баллов: имена освобождены под кастомные
ok('баллы: команды удалены, имена свободны', !RESERVED.has('баллы') && !RESERVED.has('топ')
  && !RESERVED.has('перевести') && !RESERVED.has('дуэль') && !RESERVED.has('заказ'));

// ---------- редемпшн-роутер (награды канала Twitch) ----------
const { RedemptionRouter, REDEMPTION_ACTIONS } = await import('../src/bot/redemptions.js');
const redSettings = {
  redemptions: {
    enabled: true,
    cooldown: 30,
    mappings: [
      { rewardName: 'заказать песню', action: 'song', enabled: true },
      { rewardName: 'мем', action: 'meme', enabled: false },
    ],
  },
};
const rr = new RedemptionRouter({ logs, settings: redSettings });
ok('награды: справочник действий на месте', REDEMPTION_ACTIONS.includes('song') && REDEMPTION_ACTIONS.includes('command'));
ok('награды: match без учёта регистра', rr.match('Заказать Песню')?.action === 'song');
ok('награды: выключенный мэппинг не матчится', rr.match('мем') === null);
ok('награды: незнакомая награда не матчится', rr.match('такой нет') === null);

ovFree.length = 0;
const evCount = logs.events.items.length;
const r1 = rr.handle({ broadcaster_user_id: '100', user_login: 'petya', user_name: 'Petya', user_input: 'привет', reward: { id: 'r1', title: 'Заказать песню' } });
ok('награды: замапленная — лог + оверлей', r1.pushed === true && r1.action === 'song');
ok('награды: строка в ленте событий', logs.events.items.length === evCount + 1 && logs.events.items.at(-1).text.includes('Заказать песню'));
ok('награды: оверлей получает kind redemption', ovFree.some((s) => s.includes('"kind":"redemption"') && s.includes('Petya')));

const r2 = rr.handle({ broadcaster_user_id: '100', user_login: 'petya', user_name: 'Petya', user_input: '', reward: { id: 'r1', title: 'Заказать песню' } });
ok('награды: кулдаун на юзера держит второй пуш', r2.cooldown === true && r2.pushed === undefined);
const r3 = rr.handle({ broadcaster_user_id: '100', user_login: 'girl', user_name: 'Girl', user_input: '', reward: { id: 'r1', title: 'Заказать песню' } });
ok('награды: другой юзер не под кулдауном', r3.pushed === true);
const r4 = rr.handle({ broadcaster_user_id: '100', user_login: 'vova', user_name: 'Vova', user_input: 'ой', reward: { id: 'r2', title: 'мем' } });
ok('награды: незамапленная — только лог, без оверлея', r4.pushed === undefined && !r4.error);
redSettings.redemptions.enabled = false;
const r5 = rr.handle({ broadcaster_user_id: '100', user_login: 'x', user_name: 'X', user_input: '', reward: { id: 'r1', title: 'Заказать песню' } });
ok('награды: выключенный роутер молчит', r5.ignored === true);
redSettings.redemptions.enabled = true;
const rBad = rr.handle(null);
ok('награды: мусорное событие не роняет роутер', typeof rBad === 'object' && !rBad.error);

// ---------- BroadcasterAuth: структура без сети ----------
const { BroadcasterAuth, BROADCASTER_SCOPES } = await import('../src/twitch/broadcaster-auth.js');
const bca = new BroadcasterAuth({ clientId: 'cid', clientSecret: 'cs' });
ok('стример: класс создаётся, методы на месте', ['load', 'persist', 'logout', 'beginAuth', 'checkState',
  'exchangeCode', 'refresh', 'validate', 'ensureValid', 'autoRefresh', 'stopAutoRefresh', 'updateClient']
  .every((m) => typeof bca[m] === 'function'));
ok('стример: скоупы для наград канала', BROADCASTER_SCOPES.includes('channel:read:redemptions')
  && BROADCASTER_SCOPES.includes('user:read:chat'));
ok('стример: redirect на /auth/broadcaster/callback', bca.redirectUri(8080) === 'http://localhost:8080/auth/broadcaster/callback');
const beginUrl = new URL(bca.beginAuth(8080));
ok('стример: beginAuth ведёт на authorize с нужными скоупами',
  beginUrl.origin + beginUrl.pathname === 'https://id.twitch.tv/oauth2/authorize'
  && beginUrl.searchParams.get('scope').includes('channel:read:redemptions')
  && beginUrl.searchParams.get('redirect_uri') === 'http://localhost:8080/auth/broadcaster/callback');
const bcState = beginUrl.searchParams.get('state');
ok('стример: state проверяется', bca.checkState('nope') === false && bca.checkState(bcState) === true);
bca.tokens = { accessToken: 'x' };
bca.updateClient({ clientId: 'другой' });
ok('стример: смена Client ID сбрасывает токены', bca.tokens === null && bca.status === 'none');
bca.tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, userId: '7', login: 'streamer', scopes: BROADCASTER_SCOPES };
bca.persist();
const bca2 = new BroadcasterAuth({ clientId: 'cid', clientSecret: 'cs' });
ok('стример: токены переживают перезапуск (data/broadcaster-tokens.json)', bca2.load()?.login === 'streamer' && bca2.status === 'ok');
bca2.logout();
ok('стример: logout чистит файл и статус', bca2.tokens === null && bca2.load() === null);
bca.logout();


// ---------- цитаты ----------
const { QuotesManager } = await import('../src/bot/quotes.js');
const quotesFile = path.join(process.env.BOT_DATA_DIR, 'quotes.json');
const qm = new QuotesManager({ dataFile: quotesFile, logs });
engine.setQuotes(qm);

const q1 = qm.add('ModGuy', 'Никогда не сдавайся');
const q2 = qm.add('modguy', 'Сначала учись, потом учи');
ok('цитаты: add возвращает запись', q1.id === 1 && q1.text === 'Никогда не сдавайся' && q1.by === 'modguy' && q1.at > 0);
ok('цитаты: нумерация авто', q2.id === 2);
ok('цитаты: byId находит', qm.byId(1).text === 'Никогда не сдавайся');
ok('цитаты: byId отсутствующего — null', qm.byId(42) === null);
ok('цитаты: поиск без учёта регистра', qm.search('СДАВАЙСЯ').length === 1 && qm.search('СДАВАЙСЯ')[0].id === 1);
ok('цитаты: поиск без совпадений — пусто', qm.search('пельмени').length === 0);
const removed = qm.remove(2);
ok('цитаты: удаление возвращает запись и гасит номер', removed?.id === 2 && qm.byId(2) === null && qm.remove(2) === null);
ok('цитаты: random с единственной цитатой детерминирован', qm.random()?.id === 1 && qm.random()?.text === 'Никогда не сдавайся');
ok('цитаты: random пустого хранилища — null', new QuotesManager({ dataFile: path.join(process.env.BOT_DATA_DIR, 'quotes-empty.json') }).random() === null);
ok('цитаты: list для панели (по id, курсор afterId)', qm.list().length === 1 && qm.list({ afterId: 1 }).length === 0);
qm.saveNow();
ok('цитаты: автосейв в data/quotes.json', JSON.parse(fs.readFileSync(quotesFile, 'utf8'))[0].text === 'Никогда не сдавайся');

// команды !цитата через движок
await engine.handleChatMessage({ userId: '10', login: 'girl', displayName: 'Girl', text: '!цитата', badges: [] });
ok('цитата: !цитата — случайная (с единственной детерминирована)', sent.at(-1) === 'Цитата #1: Никогда не сдавайся');
await engine.handleChatMessage({ userId: '10', login: 'girl', displayName: 'Girl', text: '!цитата 1', badges: [] });
ok('цитата: !цитата N по номеру', sent.at(-1) === 'Цитата #1: Никогда не сдавайся');
await engine.handleChatMessage({ userId: '10', login: 'girl', displayName: 'Girl', text: '!цитата 99', badges: [] });
ok('цитата: несуществующий номер — сообщение об ошибке', sent.at(-1) === 'Цитаты #99 нет 🤷');
await engine.handleChatMessage({ userId: '9', login: 'modguy', displayName: 'ModGuy', text: '!цитата добавить Жизнь прекрасна', badges: [{ set_id: 'moderator' }] });
ok('цитата: добавить модом — отвечает номером', sent.at(-1) === 'Цитата #3 добавлена ✅' && qm.byId(3).text === 'Жизнь прекрасна');
await engine.handleChatMessage({ userId: '10', login: 'girl', displayName: 'Girl', text: '!цитата добавить хак', badges: [] });
ok('цитата: обычному зрителю добавить нельзя', sent.at(-1).includes('только модераторы') && qm.search('хак').length === 0);
await engine.handleChatMessage({ userId: '10', login: 'girl', displayName: 'Girl', text: '!цитата поиск ЖИЗНЬ', badges: [] });
ok('цитата: !цитата поиск находит без регистра', sent.at(-1) === 'Цитата #3: Жизнь прекрасна');
await engine.handleChatMessage({ userId: '9', login: 'modguy', displayName: 'ModGuy', text: '!цитата удалить 3', badges: [{ set_id: 'moderator' }] });
ok('цитата: удалить модом', sent.at(-1) === 'Цитата #3 удалена 🗑' && qm.byId(3) === null);

// критик: сбой записи на диск (EBUSY/EPERM) — saveNow не бросает, пишет ошибку в системную ленту, _dirty не гаснет
const goodQuotesFile = qm.dataFile;
const quotesBlocker = path.join(process.env.BOT_DATA_DIR, 'blocker-not-a-dir');
fs.writeFileSync(quotesBlocker, 'x', 'utf8'); // файл на месте каталога — mkdirSync в saveJson упадёт
qm.dataFile = path.join(quotesBlocker, 'nested', 'quotes.json'); // «недоступный путь»
const diskFailQuote = qm.add('modguy', 'Проверка диска'); // add живёт даже при сбойной записи
let saveFailThrew = false;
try { qm.saveNow(); } catch { saveFailThrew = true; }
const dirtyStillTrue = qm._dirty === true; // флаг не погасился — следующий saveNow попытается снова
const saveFailLogged = logs.system.items.some((l) => l?.level === 'error' && String(l?.message || '').includes('не записались цитаты'));
qm.dataFile = goodQuotesFile; // путь починен
qm.remove(diskFailQuote.id); // хвост дописывается
ok('цитаты: сбой записи диска — ошибка в системную ленту, _dirty живёт; после починки — дописывает',
  diskFailQuote.id === 4 && !saveFailThrew && dirtyStillTrue && saveFailLogged
  && qm._dirty === false && JSON.parse(fs.readFileSync(goodQuotesFile, 'utf8')).length === 1);
fs.rmSync(quotesBlocker, { force: true });

let quoteReservedThrew = false;
try { engine.upsert({ name: 'цитата', response: 'хак' }); } catch { quoteReservedThrew = true; }
ok('цитата: имя зарезервировано за встроенной', quoteReservedThrew && RESERVED.has('цитата'));

// ---------- TTS-озвучка оверлея: дефолты и нормализация ----------
const { loadSettings, normalizeTts, mergeTts, normalizeEventList, mergeEventList } = await import('../src/bot/commands.js');
const ttsDef = loadSettings().alerts.tts;
ok('tts: дефолты в loadSettings (alerts.tts)', ttsDef.enabled === false && ttsDef.rate === 1 && ttsDef.volume === 1 && ttsDef.voiceName === '');

const ntts = normalizeTts({ enabled: 1, rate: 10, volume: -1, voiceName: `  ${'Г'.repeat(100)}` });
ok('tts: normalizeTts клампит rate/volume и режет имя голоса', ntts.enabled === true && ntts.rate === 2 && ntts.volume === 0 && ntts.voiceName.length === 80 && ntts.voiceName.startsWith('Г'));

ok('tts: мусор и пустой объект → дефолты, volume 0 не превращается в 1',
  normalizeTts().enabled === false && normalizeTts(undefined).rate === 1
  && normalizeTts({ rate: 'abc', volume: 'x' }).volume === 1
  && normalizeTts({ volume: 0 }).volume === 0);

fs.mkdirSync(process.env.BOT_DATA_DIR, { recursive: true });
const ttsSettingsFile = path.join(process.env.BOT_DATA_DIR, 'settings.json');
fs.writeFileSync(ttsSettingsFile, JSON.stringify({ alerts: { tts: { enabled: true, rate: 1.5, volume: 0.3, voiceName: 'Milena' } } }), 'utf8');
const ttsStored = loadSettings().alerts.tts;
ok('tts: сохранённые значения переопределяют дефолты (merge)', ttsStored.enabled === true && ttsStored.rate === 1.5 && ttsStored.volume === 0.3 && ttsStored.voiceName === 'Milena');
fs.rmSync(ttsSettingsFile, { force: true });

// фикс критика: частичный патч не должен затирать сохранённый voiceName
const phantomCur = { enabled: true, rate: 1.5, volume: 0.3, voiceName: 'Milena' };
const partialPatch = mergeTts(phantomCur, { volume: 0.2 });
ok('tts: mergeTts частичный патч держит voiceName и остальное', partialPatch.voiceName === 'Milena' && partialPatch.rate === 1.5 && partialPatch.enabled === true && partialPatch.volume === 0.2);
const garbagePatch = mergeTts(phantomCur, 'мусор');
ok('tts: mergeTts мусорный патч не меняет текущие значения', garbagePatch.enabled === true && garbagePatch.voiceName === 'Milena' && garbagePatch.rate === 1.5 && garbagePatch.volume === 0.3);

// ---------- список событий оверлея: alerts.eventList (дефолты и нормализация) ----------
const elDef = loadSettings().alerts.eventList;
ok('event list: дефолты в loadSettings (alerts.eventList)', elDef.enabled === false && elDef.size === 5);

ok('event list: normalizeEventList клампит размер и чинит мусор',
  normalizeEventList({ enabled: 1, size: 99 }).enabled === true && normalizeEventList({ size: 99 }).size === 20
  && normalizeEventList({ size: 'x' }).size === 5 && normalizeEventList().enabled === false);

const elCur = { enabled: true, size: 8 };
const elPartial = mergeEventList(elCur, { enabled: false });
const elGarbage = mergeEventList(elCur, 'мусор');
ok('event list: mergeEventList частичный патч держит size, мусор не меняет ничего',
  elPartial.enabled === false && elPartial.size === 8
  && elGarbage.enabled === true && elGarbage.size === 8);

// ---------- loadSettings: дефолты наград (балльные секции исчезли) ----------
ok('награды: дефолты в loadSettings', loadSettings().redemptions.enabled === true
  && loadSettings().redemptions.cooldown === 30
  && loadSettings().redemptions.mappings.length === 4);
ok('награды: дефолтный мэппинг «заказать песню» → song',
  loadSettings().redemptions.mappings[0].rewardName === 'заказать песню'
  && loadSettings().redemptions.mappings[0].action === 'song');
ok('награды: сохранённые настройки мержатся поверх дефолтов', (() => {
  fs.mkdirSync(process.env.BOT_DATA_DIR, { recursive: true });
  const f = path.join(process.env.BOT_DATA_DIR, 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ redemptions: { cooldown: 15 } }), 'utf8');
  const r = loadSettings();
  fs.rmSync(f, { force: true });
  return r.redemptions.cooldown === 15 && r.redemptions.mappings.length === 4;
})());
ok('баллы: секции points/bets исчезли из настроек', loadSettings().points === undefined
  && loadSettings().bets === undefined
  && loadSettings().songs.price === undefined);


// ---------- OBS-клиент (obs-websocket 5): чистые функции протокола ----------
const {
  ObsClient, buildIdentifyAuth, buildIdentify, parseMessage, parseRequestResponse,
  buildRequest, reconnectDelay,
} = await import('../src/bot/obs.js');

// эталон посчитан руками по формуле v5: base64(sha256(base64(sha256(pw+salt))+challenge))
ok('obs: auth-строка по формуле v5 совпадает с эталоном',
  buildIdentifyAuth('секретныйПароль', 'ПлоВаяСоль', 'СамоИспытание') === '/SIFubuKS1yYHief6BjnaYgWx01PnV1TzcskWu1xMOc=');
ok('obs: Identify при challenge+пароле несёт ту же auth-строку, rpcVersion 1',
  buildIdentify({ password: 'секретныйПароль', authentication: { challenge: 'СамоИспытание', salt: 'ПлоВаяСоль' } }).d.authentication === '/SIFubuKS1yYHief6BjnaYgWx01PnV1TzcskWu1xMOc='
  && buildIdentify({ password: 'секретныйПароль', authentication: { challenge: 'СамоИспытание', salt: 'ПлоВаяСоль' } }).d.rpcVersion === 1);
ok('obs: без challenge (аутентификация на сервере выключена) Identify без authentication',
  buildIdentify({ password: 'секретныйПароль', authentication: null }).d.authentication === undefined);
ok('obs: challenge есть, пароль пуст — authentication не отправляем',
  buildIdentify({ password: '', authentication: { challenge: 'c', salt: 's' } }).d.authentication === undefined);

const helloMsg = parseMessage('{"op":"Hello","d":{"rpcVersion":1,"authentication":{"challenge":"c","salt":"s"}}}');
ok('obs: parseMessage разбирает Hello', helloMsg?.op === 'Hello' && helloMsg.d.authentication.salt === 's');
ok('obs: parseMessage мусор и не-объекты → null', parseMessage('не json') === null && parseMessage('{}') === null && parseMessage(null) === null);

const okR = parseRequestResponse({ op: 'RequestResponse', d: { requestType: 'GetSceneList', requestId: 'r1', requestStatus: { result: true, code: 100 }, responseData: { scenes: [{ sceneName: 'Стрим' }] } } });
const errR = parseRequestResponse({ op: 'RequestResponse', d: { requestType: 'SetCurrentProgramScene', requestId: 'r2', requestStatus: { result: false, code: 'SceneNotFound', comment: 'No scene was found' } } });
ok('obs: parseRequestResponse успех и провал', okR.ok === true && okR.id === 'r1' && okR.data.scenes[0].sceneName === 'Стрим'
  && errR.ok === false && errR.code === 'SceneNotFound' && errR.comment === 'No scene was found');
ok('obs: parseRequestResponse чужой op → null', parseRequestResponse({ op: 'Event', d: {} }) === null);

const reqF = buildRequest('GetVersion', undefined, 'req-42');
const reqD = buildRequest('SetCurrentProgramScene', { sceneName: 'БРБ' }, 'req-43');
ok('obs: buildRequest строит фрейм (requestData нет — поля нет)',
  reqF.op === 'Request' && reqF.d.requestType === 'GetVersion' && reqF.d.requestId === 'req-42' && !('requestData' in reqF.d)
  && reqD.d.requestData.sceneName === 'БРБ');
ok('obs: бэкофф реконнекта 5→10→20, кэп 60 с',
  reconnectDelay(0) === 5000 && reconnectDelay(1) === 10000 && reconnectDelay(2) === 20000 && reconnectDelay(20) === 60000);

ok('obs: дефолты в loadSettings', loadSettings().obs.enabled === false
  && loadSettings().obs.host === '127.0.0.1' && loadSettings().obs.port === 4455 && loadSettings().obs.password === '');

// ---------- OBS: диспетчер сообщений и запросы (фейковый ws, без сети) ----------
const obsUnit = new ObsClient({ logs, settings: { obs: { password: 'секретныйПароль' } } });
obsUnit._ws = { readyState: 1, sent: [], send(x) { this.sent.push(String(x)); } };

obsUnit._onRaw(JSON.stringify({
  op: 'Hello',
  d: { obsWebSocketVersion: '5.4.2', rpcVersion: 1, authentication: { challenge: 'СамоИспытание', salt: 'ПлоВаяСоль' } },
}));
ok('obs: на Hello отвечаем Identify с эталонной авторизацией', (() => {
  const m = JSON.parse(obsUnit._ws.sent.at(-1));
  return m.op === 'Identify' && m.d.authentication === '/SIFubuKS1yYHief6BjnaYgWx01PnV1TzcskWu1xMOc=';
})());

obsUnit._onRaw(JSON.stringify({ op: 'Identified', d: { negotiatedRpcVersion: 1 } }));
ok('obs: Identified → статус connected', obsUnit.status === 'connected');

const listPromise = obsUnit.getSceneList();
const sentReq = JSON.parse(obsUnit._ws.sent.at(-1));
ok('obs: getSceneList шлёт Request с requestType и requestId',
  sentReq.op === 'Request' && sentReq.d.requestType === 'GetSceneList' && sentReq.d.requestId);
obsUnit._onRaw(JSON.stringify({
  op: 'RequestResponse',
  d: {
    requestType: 'GetSceneList', requestId: sentReq.d.requestId,
    requestStatus: { result: true, code: 100 },
    responseData: { currentProgramSceneName: 'Стрим', scenes: [{ sceneName: 'Стрим' }, { sceneName: 'БРБ' }] },
  },
}));
const sceneList = await listPromise;
ok('obs: ответ сопоставлен по requestId и распарсен', sceneList.current === 'Стрим' && sceneList.scenes.join(',') === 'Стрим,БРБ');

const obsTout = new ObsClient({ logs, settings: { obs: {} } });
obsTout._ws = { readyState: 1, send() {} };
let timeoutErr = '';
try { await obsTout._request('GetSceneList', undefined, 20); } catch (e) { timeoutErr = e.message; }
ok('obs: запрос без ответа отваливается по таймауту, pending чист', timeoutErr.includes('таймаут') && obsTout._pending.size === 0);

let noWsErr = '';
try { await new ObsClient({ logs, settings: { obs: {} } })._request('GetSceneList'); } catch (e) { noWsErr = e.message; }
ok('obs: запрос без соединения — понятная ошибка', noWsErr.includes('OBS не подключён'));
let offErr = '';
try { await new ObsClient({ logs, settings: { obs: {} } }).getSceneList(); } catch (e) { offErr = e.message; }
ok('obs: getSceneList без соединения ругается по-русски', offErr.includes('OBS не подключён'));

// ---------- OBS: встроенные команды !сцена / !сцены ----------
const obsCalls = [];
const fakeObs = {
  async getSceneList() { return { scenes: ['Стрим', 'БРБ', 'Конец'], current: 'Стрим' }; },
  async setCurrentProgramScene(name) { obsCalls.push(name); },
};
engine.setObs(fakeObs);

let obsReservedThrew = false;
try { engine.upsert({ name: 'сцена', response: 'хак' }); } catch { obsReservedThrew = true; }
ok('obs: !сцена зарезервирована за встроенной', obsReservedThrew && RESERVED.has('сцена') && RESERVED.has('сцены'));

await engine.handleChatMessage({ userId: '9', login: 'modguy', displayName: 'ModGuy', text: '!сцены', badges: [{ set_id: 'moderator' }] });
ok('obs: !сцены перечисляет сцены и текущую', sent.at(-1).includes('Сцены OBS') && sent.at(-1).includes('БРБ') && sent.at(-1).includes('сейчас: Стрим'));

await engine.handleChatMessage({ userId: '10', login: 'girl', displayName: 'Girl', text: '!сцена БРБ', badges: [] });
ok('obs: !сцена доступна только модам', obsCalls.length === 0);

await engine.handleChatMessage({ userId: '9', login: 'modguy', displayName: 'ModGuy', text: '!сцена БРБ', badges: [{ set_id: 'moderator' }] });
ok('obs: !сцена переключает сцену OBS', obsCalls[0] === 'БРБ' && sent.at(-1).includes('Сцена переключена'));

await engine.handleChatMessage({ userId: '9', login: 'modguy', displayName: 'ModGuy', text: '!сцена', badges: [{ set_id: 'moderator' }] });
ok('obs: !сцена без имени подсказывает и перечисляет сцены', sent.at(-1).includes('Использование') && sent.at(-1).includes('Стрим'));

fakeObs.setCurrentProgramScene = async () => { throw new Error('SceneNotFound: нет такой сцены'); };
await engine.handleChatMessage({ userId: '9', login: 'modguy', displayName: 'ModGuy', text: '!сцена Кухня', badges: [{ set_id: 'moderator' }] });
ok('obs: ошибка переключения подсказывает доступные сцены', sent.at(-1).includes('не вышло') && sent.at(-1).includes('есть сцены'));


console.log(`\nВсе ${passed} тестов прошли ✅`);
fs.rmSync(process.env.BOT_DATA_DIR, { recursive: true, force: true });
process.exit(0);
