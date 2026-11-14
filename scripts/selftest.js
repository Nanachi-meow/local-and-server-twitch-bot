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
  getUserByLogin: async (login) => ({ id: '55', login, display_name: login }),
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
const tr = pts.transfer('petya', 'Vova', 50, 'Vova');
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
pts.stop();

console.log(`\nВсе ${passed} тестов прошли ✅`);
fs.rmSync(process.env.BOT_DATA_DIR, { recursive: true, force: true });
process.exit(0);
