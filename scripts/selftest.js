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

// ---------- баллы канала ----------
const { PointsManager } = await import('../src/bot/points.js');
const fakeHelixPts = {
  sendMessage: async (b) => { sent.push(b.text); return { message_id: 'm' }; },
  getStreamByLogin: async (login) => (login === 'alpha' ? { started_at: new Date().toISOString(), game_name: 'G', title: 'T' } : null),
  getChatters: async () => [{ login: 'vasya', name: 'Vasya' }, { login: 'petya', name: 'Petya' }],
  getUserByLogin: async (login) => (String(login).toLowerCase() === 'неведомыйник' ? null : ({ id: '55', login, display_name: login })),
};
const ptsSettings = {
  events: {},
  points: { enabled: true, intervalMin: 10, amount: 10, perMessage: 1 },
  wheel: { enabled: true, minBet: 10, maxBet: 1000, cooldown: 0, items: [{ label: 'x2', weight: 10, multiplier: 2 }] },
  memShop: { enabled: true, items: [{ name: 'ричка', price: 150, text: '🐭 {user} запустил РИЧКУ!', sound: '', enabled: true }] },
};
const ptsDataFile = path.join(process.env.BOT_DATA_DIR, 'points.json');
const pts = new PointsManager({ helix: fakeHelixPts, auth: fakeAuth, logs, settings: ptsSettings, channels: registry, dataFile: ptsDataFile });
engine.setPoints(pts);

pts.add('petya', 500, 'Petya');
ok('баллы: add/balance', pts.balance('petya') === 500);
ok('баллы: spend не пускает больше имеющегося', !pts.spend('petya', 600) && pts.spend('petya', 100) && pts.balance('petya') === 400);
const tr = await pts.transfer('petya', 'Vova', 50, 'Vova');
ok('баллы: перевод работает', tr.ok && pts.balance('petya') === 350 && pts.balance('vova') === 50);

await pts.accrueTick();
ok('баллы: начисление зрителям живого канала (бота не считаем)', pts.balance('vasya') === 10 && pts.balance('petya') === 360);
pts.noteMessage('vasya', 'Vasya');
ok('баллы: бонус за сообщение', pts.balance('vasya') === 11);
ok('баллы: топ сортирует', pts.top(2)[0].login === 'petya');
pts.saveNow();
ok('баллы: файл сохраняется', JSON.parse(fs.readFileSync(ptsDataFile, 'utf8')).petya.points === 360);

await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!баллы', badges: [] });
ok('баллы: !баллы отвечает балансом', sent.at(-1).includes('360') && sent.at(-1).includes('@petya'));
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!топ', badges: [] });
ok('баллы: !топ отвечает списком', sent.at(-1).startsWith('Топ баллов:'));
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!перевести @vova 50', badges: [] });
ok('баллы: !перевести списывает и начисляет', pts.balance('petya') === 310 && pts.balance('vova') === 100);
await engine.handleChatMessage({ userId: '9', login: 'modguy', displayName: 'ModGuy', text: '!дать @petya 500', badges: [{ set_id: 'moderator' }] });
ok('баллы: !дать (мод+) работает', pts.balance('petya') === 810);

// колесо: единственный вариант x2 — детерминированно
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!колесо 100', badges: [] });
ok('колесо: x2 удваивает ставку', pts.balance('petya') === 910 && sent.at(-1).includes('выигрыш x2'));
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!колесо 5', badges: [] });
ok('колесо: минимальная ставка отсекается', sent.at(-1).includes('минимальная ставка'));

// мем-магазин
overlay.clients.add({ write: (s) => ovCaptured.push(String(s)) });
ovCaptured.length = 0;
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!мем', badges: [] });
ok('мем: без названия — список', sent.at(-1).includes('Мем-магазин') && sent.at(-1).includes('ричка'));
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!мем ричка', badges: [] });
ok('мем: покупка списывает баллы', pts.balance('petya') === 910 - 150);
ok('мем: алерт ушёл в оверлей с текстом', ovCaptured.some((s) => s.includes('"kind":"meme"') && s.includes('Petya запустил РИЧКУ')));
pts.add('vasya', 5, 'Vasya');
await engine.handleChatMessage({ userId: '7', login: 'vasya', displayName: 'Vasya', text: '!мем ричка', badges: [] });
ok('мем: не хватает баллов — отказ', sent.at(-1).includes('меньше') && pts.balance('vasya') === 16);

// ---------- фиксы по ревью критика ----------
// колесо без весов не жжёт ставку
const savedWheelCfg = ptsSettings.wheel;
ptsSettings.wheel = { enabled: true, minBet: 10, maxBet: 1000, cooldown: 0, items: [{ label: 'пусто', weight: 0, multiplier: 0 }] };
pts.add('petya', 100, 'Petya');
const petyaBeforeZeroWheel = pts.balance('petya');
const spinBroken = pts.spin('petya', 'Petya', 50);
ok('критик: колесо без весов — отказ без списания', Boolean(spinBroken.error) && pts.balance('petya') === petyaBeforeZeroWheel);
ptsSettings.wheel = savedWheelCfg;

// бонусы за сообщения гейтятся, бот сам себе не капает
ptsSettings.points.enabled = false;
pts.noteMessage('girl', 'Girl');
ok('критик: выключенные баллы не капают за сообщения', pts.balance('girl') === 0);
ptsSettings.points.enabled = true;
pts.noteMessage('testbot', 'Bot');
ok('критик: сам бот не начисляет себе баллы', pts.balance('testbot') === 0);
pts.noteMessage('girl', 'Girl');
ok('критик: сообщение зрителя капает', pts.balance('girl') === 1);

// Infinity не ломает кошелёк
pts.add('petya', Infinity, 'Petya');
pts.add('petya', NaN, 'Petya');
ok('критик: !дать 1e400 не делает баланс бесконечным', Number.isFinite(pts.balance('petya')));

// перевод несуществующему отклонён, кошелёк не создаётся
const badTr = await pts.transfer('petya', 'неведомыйник', 10);
ok('критик: перевод на несуществующий ник — отказ', badTr.ok === false && !pts.store['неведомыйник']);

// мем при закрытом оверлее — баллы не списаны
overlay.clients.clear();
const balBeforeMemeNoOverlay = pts.balance('petya');
const memeFail = pts.buyMeme('petya', 'Petya', 'ричка');
ok('критик: мем без открытого оверлея — отказ без списания', Boolean(memeFail.error) && pts.balance('petya') === balBeforeMemeNoOverlay);
overlay.clients.add({ write: (s) => ovCaptured.push(String(s)) });

// мем-магазин: кулдаун покупок (критик)
pts.settings.memShop.cooldown = 60;
const memeOk1 = pts.buyMeme('petya', 'Petya', 'ричка');
ok('критик: мем-магазин — первая покупка проходит', !memeOk1.error);
const memeCd = pts.buyMeme('petya', 'Petya', 'ричка');
ok('критик: мем-магазин — кулдаун держит повтор', Boolean(memeCd.error) && memeCd.error.includes('подожди'));
pts.settings.memShop.cooldown = 0;

// критик: saveNow баллов тоже репортит срыв записи (файл на месте каталога)
const blockerDir = path.join(process.env.BOT_DATA_DIR, 'pts-blocked');
fs.writeFileSync(blockerDir, 'x', 'utf8');
const ptsBad = new PointsManager({ helix: fakeHelixPts, auth: fakeAuth, logs, settings: ptsSettings, channels: registry, dataFile: path.join(blockerDir, 'points.json') });
ptsBad.add('x9', 5, 'X9');
ptsBad.saveNow();
ok('критик: срыв записи баллов виден в системной ленте', logs.system.items.some((l) => String(l?.message || '').includes('не записались баллы')) && ptsBad._dirty);
fs.rmSync(blockerDir, { force: true });

pts.stop();

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
const { loadSettings, normalizeTts, mergeTts } = await import('../src/bot/commands.js');
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

// ---------- ставки и дуэли ----------
const { BetsManager } = await import('../src/bot/bets.js');
const betsCfg = {
  events: {},
  points: { enabled: true, intervalMin: 10, amount: 10, perMessage: 0 },
  bets: { enabled: true, fee: 0, durationSec: 300, minBet: 10, maxBet: 1000, duelCooldown: 0 },
};
const pts2 = new PointsManager({ helix: fakeHelixPts, auth: fakeAuth, logs, settings: betsCfg, channels: registry, dataFile: path.join(process.env.BOT_DATA_DIR, 'points-bets.json') });
const bets = new BetsManager({ logs, settings: betsCfg });
bets.setPoints(pts2);
engine.setPoints(pts2);
engine.setBets(bets);
pts2.add('vasya', 1000, 'Vasya');
pts2.add('petya', 1000, 'Petya');
pts2.add('vova', 500, 'Vova');
pts2.add('masha', 40, 'Masha');

let betsNameThrew = false;
try { engine.upsert({ name: 'дуэль', response: 'хак' }); } catch { betsNameThrew = true; }
ok('ставки: !дуэль зарезервирована', betsNameThrew);

// открытие пула
const op = bets.open({ channelId: '777', question: 'Кто чемпион?', options: ['Али', 'Боби'] });
ok('ставки: открытие пула', !op.error && bets.active('777')?.question === 'Кто чемпион?' && op.options.length === 2 && op.durationSec === 300);
ok('ставки: одна активная ставка на канал', Boolean(bets.open({ channelId: '777', question: 'x', options: ['а', 'б'] }).error));
ok('ставки: один вариант — отказ', Boolean(bets.open({ channelId: '778', question: 'x', options: ['а'] }).error));
ok('ставки: семь вариантов — отказ', Boolean(bets.open({ channelId: '778', question: 'x', options: ['1', '2', '3', '4', '5', '6', '7'] }).error));

// лимиты и валидация place
ok('ставки: ниже минимума — отказ', Boolean(bets.place({ channelId: '777', login: 'vasya', amount: 5, optionIndex: 1 }).error));
ok('ставки: выше максимума — отказ', Boolean(bets.place({ channelId: '777', login: 'vasya', amount: 1001, optionIndex: 1 }).error));
ok('ставки: несуществующий вариант — отказ', Boolean(bets.place({ channelId: '777', login: 'vasya', amount: 100, optionIndex: 3 }).error));
ok('ставки: без открытой ставки — отказ', Boolean(bets.place({ channelId: '999', login: 'vasya', amount: 100, optionIndex: 1 }).error));

// протокол пишется, менеджер баллы не трогает
bets.place({ channelId: '777', login: 'vasya', amount: 300, optionIndex: 1 });
bets.place({ channelId: '777', login: 'petya', amount: 700, optionIndex: 1 });
bets.place({ channelId: '777', login: 'vova', amount: 100, optionIndex: 2 });
ok('ставки: протокол записан, баллы не списаны', pts2.balance('vasya') === 1000 && bets.active('777').options[0].bets.length === 2 && bets.active('777').options[1].bets.length === 1);

// итог: пропорциональная выплата и комиссия
betsCfg.bets.fee = 10;
const res = bets.resolve({ channelId: '777', winnerIndex: 1 });
ok('итог: пропорциональная выплата при fee=10', !res.error && res.pot === 1100 && res.prizePool === 990
  && res.payouts.find((p) => p.login === 'vasya').amount === 297
  && res.payouts.find((p) => p.login === 'petya').amount === 693);
ok('итог: пул закрыт', bets.active('777') === null);
ok('итог: повторный итог — отказа нет ставки', Boolean(bets.resolve({ channelId: '777', winnerIndex: 1 }).error));

// ставка мимо: банк не сгорает — ставки возвращаются
bets.open({ channelId: '886', question: 'Доживём?', options: ['да', 'нет'] });
bets.place({ channelId: '886', login: 'vova', amount: 100, optionIndex: 2 });
ok('ставки: дробный номер варианта — отказ', Boolean(bets.place({ channelId: '886', login: 'vasya', amount: 100, optionIndex: 1.5 }).error));
const res2 = bets.resolve({ channelId: '886', winnerIndex: 1 });
ok('итог: победителя нет — банк не сгорает, ставки возвращаются', !res2.error && res2.payouts.length === 0 && res2.pot === 100
  && res2.refunds.length === 1 && res2.refunds[0].login === 'vova' && res2.refunds[0].amount === 100);

// таймаут: ручной closeExpired с возвратом ставок
bets.open({ channelId: '777', question: 'Дождь?', options: ['да', 'нет'] });
bets.place({ channelId: '777', login: 'vova', amount: 200, optionIndex: 1 });
pts2.spend('vova', 200); // списание сделала команда
const refunds = bets.closeExpired(Date.now() + 10 * 60_000);
ok('таймаут: closeExpired вернул список возвратов', refunds.length === 1 && refunds[0].login === 'vova' && refunds[0].amount === 200);
ok('таймаут: пул закрыт', bets.active('777') === null);
for (const ref of refunds) pts2.add(ref.login, ref.amount);
ok('таймаут: вызывающий вернул баллы', pts2.balance('vova') === 500);

// тик по таймауту сам возвращает баллы через PointsManager
bets.open({ channelId: '777', question: 'Тик?', options: ['да', 'нет'] });
bets.place({ channelId: '777', login: 'masha', amount: 20, optionIndex: 1 });
pts2.spend('masha', 20);
bets.active('777').expiresAt = Date.now() - 1;
bets._tick();
ok('таймаут: тик сам возвращает баллы и закрывает пул', pts2.balance('masha') === 40 && bets.active('777') === null);

// настоящий тик: ставка реально истекает по durationSec (минимальная длительность — 10 сек)
betsCfg.bets.durationSec = 10;
bets.open({ channelId: '777', question: 'Ждём?', options: ['да', 'нет'] });
bets.place({ channelId: '777', login: 'vova', amount: 30, optionIndex: 1 });
pts2.spend('vova', 30);
await new Promise((resolve) => setTimeout(resolve, 10_300));
bets._tick();
ok('таймаут: настоящий _tick закрывает истёкшую по durationSec ставку', pts2.balance('vova') === 500 && bets.active('777') === null);
betsCfg.bets.durationSec = 300;

// ставочные команды в чате
await engine.handleChatMessage({ userId: '7', login: 'vasya', displayName: 'Vasya', text: '!ставка открыть Проверка А|Б', badges: [] });
ok('ставки (чат): открывать могут только моды', sent.at(-1).includes('моды') && bets.active('100') === null);
await engine.handleChatMessage({ userId: '9', login: 'modguy', displayName: 'ModGuy', text: '!ставка открыть Кто первый умрёт Али|Боби', badges: [{ set_id: 'moderator' }] });
ok('ставки (чат): открытие перечисляет варианты', sent.at(-1).includes('Кто первый умрёт') && sent.at(-1).includes('1) Али'));
await engine.handleChatMessage({ userId: '7', login: 'vasya', displayName: 'Vasya', text: '!ставка', badges: [] });
ok('ставки (чат): !ставка показывает вопрос и остаток секунд', sent.at(-1).includes('Кто первый умрёт') && sent.at(-1).includes('осталось'));
await engine.handleChatMessage({ userId: '7', login: 'vasya', displayName: 'Vasya', text: '!ставить 300 1', badges: [] });
ok('ставки (чат): !ставить списывает баллы', pts2.balance('vasya') === 700 && sent.at(-1).includes('Али'));
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!ставить 700 1', badges: [] });
await engine.handleChatMessage({ userId: '10', login: 'vova', displayName: 'Vova', text: '!ставить 100 2', badges: [] });
ok('ставки (чат): несколько ставок приняты', pts2.balance('petya') === 300 && pts2.balance('vova') === 400);
const st100 = bets.status('100');
ok('ставки (чат): банк по вариантам', st100.options[0].total === 1000 && st100.options[1].total === 100 && st100.pot === 1100);
await engine.handleChatMessage({ userId: '11', login: 'masha', displayName: 'Masha', text: '!ставить 50 1', badges: [] });
ok('ставки (чат): мало баллов — отказ', sent.at(-1).includes('не хватает') && pts2.balance('masha') === 40);
const pool100 = bets.active('100');
ok('ставки (чат): отказ не попал в протокол', pool100.options[0].bets.length === 2 && !pool100.options[0].bets.some((b) => b.login === 'masha'));
await engine.handleChatMessage({ userId: '11', login: 'masha', displayName: 'Masha', text: '!ставить 5 1', badges: [] });
ok('ставки (чат): минимальная ставка из настроек', sent.at(-1).includes('минимальная'));
await engine.handleChatMessage({ userId: '7', login: 'vasya', displayName: 'Vasya', text: '!ставить 100 1.5', badges: [] });
ok('ставки (чат): дробный номер варианта — отказ без записи', sent.at(-1).includes('целое')
  && pts2.balance('vasya') === 700 && bets.active('100').options[0].bets.length === 2);
const sentItogGuard = sent.length;
await engine.handleChatMessage({ userId: '7', login: 'vasya', displayName: 'Vasya', text: '!итог 1', badges: [] });
ok('ставки (чат): !итог доступен только модам', sent.length === sentItogGuard && bets.active('100') !== null);
await engine.handleChatMessage({ userId: '9', login: 'modguy', displayName: 'ModGuy', text: '!итог 1.5', badges: [{ set_id: 'moderator' }] });
ok('ставки (чат): дробный итог — отказ, ставка жива', sent.at(-1).includes('целое') && bets.active('100') !== null);
await engine.handleChatMessage({ userId: '9', login: 'modguy', displayName: 'ModGuy', text: '!итог 1', badges: [{ set_id: 'moderator' }] });
ok('ставки (чат): !итог платит победителям (fee=10%)', pts2.balance('vasya') === 997 && pts2.balance('petya') === 993);
ok('ставки (чат): !итог пишет топ победителей', sent.at(-1).includes('Petya') && sent.at(-1).includes('693') && sent.at(-1).includes('297'));
ok('ставки (чат): после итога пул закрыт', bets.active('100') === null);

// исход без победителя: банк не сгорает — баллы возвращаются
await engine.handleChatMessage({ userId: '9', login: 'modguy', displayName: 'ModGuy', text: '!ставка открыть Кто проспорит А|Б', badges: [{ set_id: 'moderator' }] });
await engine.handleChatMessage({ userId: '10', login: 'vova', displayName: 'Vova', text: '!ставить 100 2', badges: [] });
ok('ставки (чат): вторая ставка принята', pts2.balance('vova') === 300);
await engine.handleChatMessage({ userId: '9', login: 'modguy', displayName: 'ModGuy', text: '!итог 1', badges: [{ set_id: 'moderator' }] });
ok('ставки (чат): победителя нет — баллы возвращены, банк не сгорел', sent.at(-1).includes('возвращены') && pts2.balance('vova') === 400 && bets.active('100') === null);
betsCfg.bets.fee = 0;

// дуэли (канал 200 — отдельный от ставок)
const duelMsg = (uid, login, name, text) => engine.handleChatMessage({ broadcasterId: '200', userId: uid, login, displayName: name, text, badges: [] });
// цель вызова валидируется через хеликс: подменяем на фейк, знающий «неведомыйник»
const duelsHelixSave = engine.helix;
engine.helix = { ...fakeHelix, getUserByLogin: fakeHelixPts.getUserByLogin };
bets._rollWinner = () => ({ winner: 'a' }); // исход фиксирован
await duelMsg('7', 'vasya', 'Vasya', '!дуэль @petya 100');
ok('дуэль: вызов списывает у вызвавшего сразу', pts2.balance('vasya') === 897 && sent.at(-1).includes('вызыва'));
ok('дуэль: вызов записан', bets.pendingDuel('200')?.from?.login === 'vasya' && bets.pendingDuel('200')?.to === 'petya' && bets.pendingDuel('200').amount === 100);
await duelMsg('8', 'petya', 'Petya', '!дуэль @vasya 50');
ok('дуэль: чужая сумма — подсказка, ничего не списано', sent.at(-1).includes('100') && pts2.balance('petya') === 993 && Boolean(bets.pendingDuel('200')));
await duelMsg('8', 'petya', 'Petya', '!дуэль @vasya 100');
ok('дуэль: победа вызвавшего (winner a)', pts2.balance('petya') === 893 && pts2.balance('vasya') === 1097 && sent.at(-1).includes('победил'));
ok('дуэль: после дуэли вызов снят', bets.pendingDuel('200') === null);

bets._rollWinner = () => ({ winner: 'b' });
await duelMsg('10', 'vova', 'Vova', '!дуэль @vasya 50');
await duelMsg('7', 'vasya', 'Vasya', '!дуэль @vova 50');
ok('дуэль: победа принимающего (winner b)', pts2.balance('vova') === 350 && pts2.balance('vasya') === 1147);

await duelMsg('10', 'vova', 'Vova', '!дуэль @masha 100');
await duelMsg('11', 'masha', 'Masha', '!дуэль @vova 100');
ok('дуэль: у соперника нет баллов — отказ с возвратом вызвавшему', sent.at(-1).includes('не хватает') && pts2.balance('vova') === 350 && bets.pendingDuel('200') === null);

await duelMsg('11', 'masha', 'Masha', '!дуэль @petya 100');
ok('дуэль: без баллов вызвать нельзя', sent.at(-1).includes('не хватает') && pts2.balance('masha') === 40 && bets.pendingDuel('200') === null);

await duelMsg('7', 'vasya', 'Vasya', '!дуэль @vasya 100');
ok('дуэль: сам с собой — нельзя', sent.at(-1).includes('самого себя') && bets.pendingDuel('200') === null && pts2.balance('vasya') === 1147);
await duelMsg('7', 'vasya', 'Vasya', '!дуэль @неведомыйник 500');
ok('дуэль: несуществующий ник — отказ без списания', sent.at(-1).includes('не нашла') && pts2.balance('vasya') === 1147 && bets.pendingDuel('200') === null);

// кулдаун дуэлей на юзера (свежий игрок без истории дуэлей)
betsCfg.bets.duelCooldown = 60;
pts2.add('kolya', 1000, 'Kolya');
await duelMsg('12', 'kolya', 'Kolya', '!дуэль @vova 100');
ok('дуэль: вызов с кулдауном проходит', Boolean(bets.pendingDuel('200')) && pts2.balance('kolya') === 900);
const cancelled = bets.cancelChallenge({ channelId: '200' });
pts2.add(cancelled.from.login, cancelled.amount); // сняли вызов и вернули ставку
await duelMsg('12', 'kolya', 'Kolya', '!дуэль @masha 30');
ok('дуэль: кулдаун держит повторный вызов', sent.at(-1).includes('через') && bets.pendingDuel('200') === null && pts2.balance('kolya') === 1000);
betsCfg.bets.duelCooldown = 0;

// подметание старых кулдаунов: Map _duelLast не растёт вечно
bets._duelLast.set('ghost', Date.now() - 2 * 3_600_000);
bets._tick();
ok('дуэль: кулдауны старше часа подметаются', !bets._duelLast.has('ghost') && bets._duelLast.size > 0);

// вызов без ответа истекает — возврат
await duelMsg('10', 'vova', 'Vova', '!дуэль @petya 100');
ok('дуэль: вызов записан', Boolean(bets.pendingDuel('200')));
const duelRefunds = bets.closeExpired(Date.now() + 10 * 60_000);
ok('дуэль: истёкший вызов возвращает ставку', duelRefunds.length === 1 && duelRefunds[0].login === 'vova' && duelRefunds[0].amount === 100);
pts2.add('vova', 100);
ok('дуэль: баланс восстановлен после истечения', pts2.balance('vova') === 350 && bets.pendingDuel('200') === null);

// «!дуэль отмена»: снять вызов может инициатор или моды
await duelMsg('12', 'kolya', 'Kolya', '!дуэль @vova 25');
ok('дуэль: вызов записан (для отмены)', Boolean(bets.pendingDuel('200')) && pts2.balance('kolya') === 975);
await duelMsg('11', 'masha', 'Masha', '!дуэль отмена');
ok('дуэль: посторонний не может отменить вызов', sent.at(-1).includes('моды') && Boolean(bets.pendingDuel('200')) && pts2.balance('kolya') === 975);
await duelMsg('12', 'kolya', 'Kolya', '!дуэль отмена');
ok('дуэль: инициатор отменил вызов, ставка вернулась', bets.pendingDuel('200') === null && pts2.balance('kolya') === 1000);
await duelMsg('12', 'kolya', 'Kolya', '!дуэль @masha 20');
await engine.handleChatMessage({ broadcasterId: '200', userId: '9', login: 'modguy', displayName: 'ModGuy', text: '!дуэль отмена', badges: [{ set_id: 'moderator' }] });
ok('дуэль: мод может отменить чужой вызов', bets.pendingDuel('200') === null && pts2.balance('kolya') === 1000);
await duelMsg('7', 'vasya', 'Vasya', '!дуэль отмена');
ok('дуэль: без вызова — отменять нечего', sent.at(-1).includes('нечего') && bets.pendingDuel('200') === null);
engine.helix = duelsHelixSave; // возвращаем исходный фейк-хеликс

// stop: активные ставки и вызовы возвращают баллы, а не пропадают
bets.open({ channelId: '777', question: 'Стоп?', options: ['да', 'нет'] });
bets.place({ channelId: '777', login: 'petya', amount: 50, optionIndex: 2 });
pts2.spend('petya', 50);
bets.challenge({ channelId: '300', fromLogin: 'vova', fromName: 'Vova', toLogin: 'petya', amount: 40 });
pts2.spend('vova', 40);
bets.start();
const timerWas = bets._timer !== null;
bets.stop();
ok('ставки: stop возвращает баллы живых ставок и вызовов', timerWas && bets._timer === null
  && pts2.balance('petya') === 893 && pts2.balance('vova') === 350
  && bets.active('777') === null && bets.pendingDuel('300') === null);

console.log(`\nВсе ${passed} тестов прошли ✅`);
fs.rmSync(process.env.BOT_DATA_DIR, { recursive: true, force: true });
process.exit(0);
