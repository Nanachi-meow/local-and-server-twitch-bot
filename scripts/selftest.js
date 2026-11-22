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

// ---------- встроенные команды: вкл/выкл (панель → settings.builtins.disabled) ----------
ok('встроенные: по умолчанию включены', engine.builtinEnabled('uptime'));
settings.builtins = { disabled: ['uptime'] };
const uptRan = await engine.handleChatMessage({ userId: '11', login: 'x', displayName: 'X', text: '!uptime', badges: [] });
ok('встроенные: выключенная не отвечает', uptRan === false);
const gmRan = await engine.handleChatMessage({ userId: '11', login: 'x', displayName: 'X', text: '!game', badges: [] });
ok('встроенные: соседняя работает', gmRan === true);
const info = engine.builtinInfo();
ok('встроенные: builtinInfo с desc', info.every((b) => b.desc));
ok('встроенные: builtinInfo с enabled', info.find((b) => b.name === '!uptime')?.enabled === false
  && info.find((b) => b.name === '!game')?.enabled === true);
settings.builtins = { disabled: [] }; // возвращаем как было — настройка общая для других движков

// ---------- доступ: набор ролей (allow) вместо одного уровня ----------
engine.upsert({ name: 'танцы', response: '{user} танцует 💃', allow: ['mod', 'vip'], cooldown: 0 });
const tryRole = async (badges, userId) =>
  await engine.handleChatMessage({ userId, login: `u${userId}`, displayName: `U${userId}`, text: '!танцы', badges });
ok('доступ: вип из набора может', await tryRole([{ set_id: 'vip' }], '50') === true);
ok('доступ: мод из набора может', await tryRole([{ set_id: 'moderator' }], '51') === true);
ok('доступ: саб НЕ из набора — нельзя', await tryRole([{ set_id: 'subscriber' }], '52') === false);
ok('доступ: зритель НЕ из набора — нельзя', await tryRole([], '53') === false);
ok('доступ: стример может всегда', await tryRole([], '100') === true);

// legacy level не сломался: иерархия «уровень и выше»
const secRan = await engine.handleChatMessage({ userId: '54', login: 'viewer2', displayName: 'V2', text: '!секрет', badges: [] });
ok('доступ: старый level (моды+) — зрителю нельзя', secRan === false);

// переопределение доступа встроенной (settings.builtins.access)
settings.builtins.access = { so: { allow: ['vip'] } };
const soVip = await engine.handleChatMessage({ userId: '55', login: 'vipguy', displayName: 'VipGuy', text: '!so @target', badges: [{ set_id: 'vip' }] });
ok('доступ: встроенная переопределена — вип может', soVip === true);
const soMod = await engine.handleChatMessage({ userId: '56', login: 'modguy2', displayName: 'ModGuy2', text: '!so @target', badges: [{ set_id: 'moderator' }] });
ok('доступ: встроенная переопределена — мод больше не может', soMod === false);
const soInfo = engine.builtinInfo().find((b) => b.name === '!so');
ok('доступ: builtinInfo отдаёт allow', Array.isArray(soInfo.allow) && soInfo.allow.includes('vip'));
settings.builtins.access = {}; // откат — дефолтные права встроенных
const soModBack = await engine.handleChatMessage({ userId: '56', login: 'modguy2', displayName: 'ModGuy2', text: '!so @target', badges: [{ set_id: 'moderator' }] });
ok('доступ: после отката мод снова может', soModBack === true);

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
  return { status: 200, body: '"lengthSeconds":"213","viewCount":"1000000"' };
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

// ---------- музыка: правила заказов (чс, просмотры, длины, кулдауны, доступ, награда) ----------
const { requestAllowed: songsRequestAllowed, cancelRedemption } = await import('../src/bot/songs.js');

// чёрный список
songsSettings.songs.blacklist = [{ id: 'qqqq1111111', title: 'Запрещённый трек' }];
const blRes = await sm.add({ videoId: 'qqqq1111111', by: 'Vova', byName: 'Vova' });
ok('музыка: чс — трек отклоняется', Boolean(blRes.error) && blRes.error.includes('чёрном списке'));
const blAdd = await sm.blacklistAdd('https://youtu.be/zzzz2222222');
ok('музыка: чс — добавление по ссылке', !blAdd.error && songsSettings.songs.blacklist.some((x) => x.id === 'zzzz2222222'));
const blDup = await sm.blacklistAdd('https://youtu.be/zzzz2222222');
ok('музыка: чс — повтор отклоняется', Boolean(blDup.error));
const blDel = await sm.blacklistRemove('zzzz2222222');
ok('музыка: чс — удаление', !blDel.error && !sm.blacklistHas('zzzz2222222'));
const blBad = await sm.blacklistAdd('не-ссылка');
ok('музыка: чс — не-ссылка отклоняется', Boolean(blBad.error));

// чс выкидывает трек из очереди
await sm.add({ videoId: 'zzzz3333333', by: 'Vova', byName: 'Vova' });
ok('музыка: трек в очереди перед блокировкой', sm.queue.some((s) => s.id === 'zzzz3333333'));
await sm.blacklistAdd('zzzz3333333');
ok('музыка: чс выкидывает трек из очереди', !sm.queue.some((s) => s.id === 'zzzz3333333') && sm.blacklistHas('zzzz3333333'));
sm.blacklistRemove('zzzz3333333');

// минимальные просмотры
songsSettings.songs.minViews = 1_000_001;
const lowViews = await sm.add({ videoId: 'qqq111qqqq2', by: 'Vova', byName: 'Vova' });
ok('музыка: мало просмотров — отклоняется', Boolean(lowViews.error) && lowViews.error.includes('просмотров'));
songsSettings.songs.minViews = 1000;
const okViews = await sm.add({ videoId: 'qqq111qqqq3', by: 'Vova', byName: 'Vova' });
ok('музыка: хватает просмотров — принимается', !okViews.error);
songsSettings.songs.minViews = 0;

// лимит на юзера: подряд в очереди (perUser), пока один не сыграет — новых нельзя.
// отказ молчаливый: бот не пишет в чат (баллы награды возвращаются)
songsSettings.songs.perUser = 1;
const blocked = await sm.add({ videoId: 'qqq111qqqq4', by: 'Vova', byName: 'Vova' });
ok('музыка: лимит треков юзера подряд — отклоняется', Boolean(blocked.error) && blocked.silent === true);
songsSettings.songs.perUser = 2;

// переименование команды заказа (settings.songs.commandName) — синоим «ср»
settings.songs = { commandName: 'трек' };
const beforeRename = sent.length;
await engine.handleChatMessage({ userId: '60', login: 'renamergirl', displayName: 'RenamerGirl', text: '!трек это-не-ссылка', badges: [] });
ok('музыка: переименованная команда работает', sent.length > beforeRename && sent.at(-1).includes('не похоже'));
await engine.handleChatMessage({ userId: '60', login: 'renamergirl', displayName: 'RenamerGirl', text: '!ср это-не-ссылка', badges: [] });
ok('музыка: старое имя тоже живо (алиас)', sent.at(-1).includes('не похоже'));
delete settings.songs;

// кулдаун заказов на юзера
songsSettings.songs.commandCooldown = 3600;
const coolAdd = await sm.add({ videoId: 'zzz888zzzz8', by: 'Girl', byName: 'Girl' });
ok('музыка: заказ при включённом кулдауне проходит первый раз', !coolAdd.error);
ok('музыка: кулдаун отсчитывается после заказа', sm.orderCooldownLeft('girl') > 0);
ok('музыка: кулдаун не мешает другому юзеру', sm.orderCooldownLeft('vasya') === 0);
songsSettings.songs.commandCooldown = 0;

// доступ: роли, фолловеры, личный список, стример
ok('музыка: доступ — пусто = все', (await songsRequestAllowed({ allow: [] }, { level: 'everyone', login: 'x' })).ok === true);
ok('музыка: доступ — вип из списка', (await songsRequestAllowed({ allow: ['vip'] }, { level: 'vip', login: 'x' })).ok === true);
ok('музыка: доступ — зритель мимо списка', (await songsRequestAllowed({ allow: ['vip'] }, { level: 'everyone', login: 'x' })).ok === false);
ok('музыка: доступ — личный список (без регистра)', (await songsRequestAllowed({ allow: ['vip'], allowUsers: ['Special_Girl'] }, { level: 'everyone', login: 'special_girl' })).ok === true);
ok('музыка: доступ — стример всегда', (await songsRequestAllowed({ allow: [] }, { level: 'broadcaster', login: 'x' })).ok === true);
const fakeFollowHelix = { getFollower: async () => ({ followed_at: new Date().toISOString() }) };
const gateFollower = await songsRequestAllowed({ allow: ['follower'] }, { level: 'everyone', login: 'x', userId: '9', broadcasterId: '100', helix: fakeFollowHelix });
ok('музыка: доступ — фолловер пускается', gateFollower.ok === true && gateFollower.via === 'follower');

// награда канала = заказ музыки: по режиму «reward» ИЛИ по song-маппингу
// (баг: покупки награды молча пропадали, если в музыке стоял способ «командой»)
const { songRewardSource } = await import('../src/bot/songs.js');
ok('музыка: награда с song-маппингом заказывает трек',
  songRewardSource({ requestMode: 'command' }, 'Заказать песню', 'song') === 'mapping');
ok('музыка: награда без song-маппинга и не в режиме reward — игнор',
  songRewardSource({ requestMode: 'command', rewardName: 'заказать песню' }, 'мем', 'say') === null);
ok('музыка: режим reward — совпадение по имени (без регистра)',
  songRewardSource({ requestMode: 'reward', rewardName: 'заказать песню' }, 'ЗАКАЗАТЬ ПЕСНЮ', null) === 'mode');
ok('музыка: режим reward — другое имя награды → нет',
  songRewardSource({ requestMode: 'reward', rewardName: 'заказать песню' }, 'колесо', null) === null);
ok('музыка: пустое имя награды → нет',
  songRewardSource({ requestMode: 'reward', rewardName: 'заказать песню' }, '  ', 'song') === null);

// режим награды: команда перенаправляет
songsSettings.songs.requestMode = 'reward';
songsSettings.songs.rewardName = 'заказать песню';
await engine.handleChatMessage({ userId: '10', login: 'girl', displayName: 'Girl', text: '!ср https://youtu.be/xxx2223334', badges: [] });
ok('музыка: режим награды — команда перенаправляет', sent.at(-1).includes('наград') && sent.at(-1).includes('заказать песню'));
songsSettings.songs.requestMode = 'command';
songsSettings.songs.rewardName = '';

// возврат баллов: отмена редемпции через helix стримера
const refundCalls = [];
const fakeBcHelixRefund = {
  call: async (method, ep, opts) => { refundCalls.push({ method, ep, opts }); return { data: [{ id: 'r1', status: 'CANCELED' }] }; },
};
const refund = await cancelRedemption({ broadcasterId: '100', rewardId: 'rw1', redemptionId: 'r1', helix: fakeBcHelixRefund });
ok('музыка: возврат баллов — CANCELED через helix стримера',
  refund.ok && refundCalls[0]?.method === 'PATCH'
  && refundCalls[0]?.ep === '/channel_points/custom_rewards/redemptions'
  && refundCalls[0]?.opts.body.status === 'CANCELED'
  && refundCalls[0]?.opts.query.reward_id === 'rw1');
const refundBad = await cancelRedemption({ broadcasterId: '', rewardId: 'x', redemptionId: 'y', helix: fakeBcHelixRefund });
ok('музыка: возврат без данных — понятная ошибка', Boolean(refundBad.error));

// тест плеера: первая попытка — рикрол, дальше Bad Apple, счётчик навсегда в файле
const t1 = await sm.test();
ok('музыка: тест плеера — первый раз рикрол', t1.first === true && t1.id === 'dQw4w9WgXcQ');
const t2 = await sm.test();
ok('музыка: тест плеера — дальше Bad Apple', t2.first === false && t2.id === 'FtutLA63Cp8');
const storedTest = JSON.parse(fs.readFileSync(songsFile, 'utf8'));
ok('музыка: тест плеера — счётчик в файле', storedTest.testCount === 2);
songsSettings.songs.enabled = false;
const t3 = await sm.test();
ok('музыка: тест плеера — выключенная музыка не тестируется', Boolean(t3.error));
songsSettings.songs.enabled = true;

// управление тест-треком: пауза/скип/стоп работают и на нём (очередь пустая)
ok('музыка: раскладка плеера едет в state/SSE (для живой настройки)', (() => {
  songsSettings.songs.playerCfg = { scale: 55, marqueeWidth: 150, backdrop: true };
  const stt = sm.state();
  songsSettings.songs.playerCfg = undefined;
  return stt.playerCfg?.scale === 55 && stt.playerCfg.marqueeWidth === 150 && stt.playerCfg.backdrop === true;
})());
const smTest = new SongsManager({
  logs, settings: songsSettings,
  dataFile: path.join(process.env.BOT_DATA_DIR, 'songs-test.json'),
  fetcher: fakeFetcher,
});
const tStart = await smTest.test();
ok('музыка: тест на пустой очереди стартует', tStart.first === true && smTest.testing?.id === 'dQw4w9WgXcQ');
const tpause = smTest.control('pause');
ok('музыка: пауза во время теста', tpause.ok === true && tpause.testing === true);
const tresume = smTest.control('resume');
ok('музыка: продолжение теста', tresume.ok === true && tresume.testing === true);
const tskip = smTest.skip();
ok('музыка: скип во время теста останавливает его', tskip.ok === true && smTest.testing === null);
const tno = smTest.control('pause');
ok('музыка: после теста — нечего паузить', Boolean(tno.error));
// реальный заказ вытесняет тест
await smTest.test();
const realOrder = await smTest.add({ videoId: 'realtrack111', by: 'Girl', byName: 'Girl' });
ok('музыка: реальный заказ вытесняет тест', !realOrder.error && smTest.current?.id === 'realtrack111' && smTest.testing === null);

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

// оверлей-виджет шатаута: событие с аватаром и текстом уходит в шину
const { overlay: overlaySo } = await import('../src/bot/alerts.js');
const soOv = [];
overlaySo.clients.add({ write: (s) => soOv.push(String(s)) });
await processor3.autoShoutoutFor('200', { login: 'friend', text: 'Визит {target}!' }, { force: true });
ok('шатаут-оверлей: событие в шине', soOv.some((s) => s.includes('"kind":"shoutout"') && s.includes('Визит Friend!')));
ok('шатаут-оверлей: аватар передаётся (гиф или png)', soOv.some((s) => s.includes('"avatar"')));
ok('шатаут-оверлей: баннер канала передаётся', soOv.some((s) => s.includes('"banner"')));
overlaySo.clients.clear();

// ---------- «Слово дня»: выбирается само — самое частое слово чата ----------
const wodSettings = {
  events: {},
  wordOfDay: { enabled: true, corner: 'top-right', rotate: -4, color: '#ffffff', bg: '#0c0a19', opacity: 75, radius: 14 },
};
const processorWod = new EventProcessor({
  helix: fakeHelixSo, auth: fakeAuth, logs, settings: wodSettings, state: { counters: {} },
  channels: registry,
  wodFile: path.join(process.env.BOT_DATA_DIR, 'wordofday-test.json'),
});
processorWod._wod = { date: new Date().toISOString().slice(0, 10), stats: {}, word: '', count: 0 };
await processorWod.onChatMessage({ broadcaster_user_id: '200', chatter_user_id: 'a', chatter_user_login: 'girl', chatter_user_name: 'Girl', message: { text: 'кот кот серый кот подошёл' } });
ok('слово дня: самое частое выбирается', processorWod.wodState().word === 'кот');
ok('слово дня: счётчик = сколько раз написали', processorWod.wodState().count === 3);
await processorWod.onChatMessage({ broadcaster_user_id: '200', chatter_user_id: 'b', chatter_user_login: 'boy', chatter_user_name: 'Boy', message: { text: 'пёс ПЁС пёс!! кот' } });
ok('слово дня: пока лидер держится (кот 4 > пёс 3)', processorWod.wodState().word === 'кот' && processorWod.wodState().count === 4);
await processorWod.onChatMessage({ broadcaster_user_id: '200', chatter_user_id: 'b2', chatter_user_login: 'boy2', chatter_user_name: 'Boy2', message: { text: 'пёс и ещё пёс' } });
ok('слово дня: обгон — слово меняется', processorWod.wodState().word === 'пёс' && processorWod.wodState().count === 5);
await processorWod.onChatMessage({ broadcaster_user_id: '200', chatter_user_id: 'c', chatter_user_login: 'user', chatter_user_name: 'U', message: { text: '!ср https://youtu.be/x' } });
ok('слово дня: команды не считаются', processorWod.wodState().word === 'пёс' && processorWod.wodState().count === 5);
await processorWod.onChatMessage({ broadcaster_user_id: '200', chatter_user_id: 'd', chatter_user_login: 'testbot', chatter_user_name: 'TestBot', message: { text: 'пёс' } });
ok('слово дня: сообщения бота не считаются', processorWod.wodState().count === 5);
wodSettings.wordOfDay.enabled = false;
await processorWod.onChatMessage({ broadcaster_user_id: '200', chatter_user_id: 'e', chatter_user_login: 'zz', chatter_user_name: 'Z', message: { text: 'зебра зебра' } });
ok('слово дня: выключенный виджет не считает', processorWod.wodState().word === 'пёс');
wodSettings.wordOfDay.enabled = true;
const wodOv = [];
overlaySo.clients.add({ write: (s) => wodOv.push(String(s)) });
await processorWod.onChatMessage({ broadcaster_user_id: '200', chatter_user_id: 'f', chatter_user_login: 'ww', chatter_user_name: 'W', message: { text: 'Пёс' } });
ok('слово дня: событие уходит на оверлей', wodOv.some((s) => s.includes('"kind":"wordofday"') && s.includes('"count":6')));
const reset = processorWod.resetWordOfDay();
ok('слово дня: сброс обнуляет', reset.word === '' && reset.count === 0);
overlaySo.clients.clear();

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

// ---------- автоопределение начала/конца стрима (LiveTracker) ----------
const { LiveTracker } = await import('../src/bot/live.js');
const liveBefore = logs.events.items.length;
const liveWatch = [];
const fakeHelixLive = {
  // alpha в эфире, beta нет — для сверки
  getStreamsByLogins: async (logins) => (logins.includes('alpha')
    ? [{ user_id: '100', user_login: 'alpha', started_at: new Date(Date.now() - 1800_000).toISOString(), title: 'Весёлый стрим', game_name: 'Just Chatting' }]
    : []),
};
const tracker = new LiveTracker({ helix: fakeHelixLive, channels: registry, logs, watcher: (k, e) => liveWatch.push([k, e.login]) });

ok('эфир: переход в online — true', tracker.markOnline('100', { title: 'Весёлый стрим', game: 'Just Chatting', startedAt: Date.now() - 600_000 }) === true);
ok('эфир: повторное online — не переход', tracker.markOnline('100', {}) === false);
ok('эфир: isLive/snapshot', tracker.isLive('100') && tracker.snapshot().alpha.live === true && tracker.snapshot().alpha.title === 'Весёлый стрим');
ok('эфир: длительность считается', (tracker.snapshot().alpha.durationMs ?? 0) > 500_000);
ok('эфир: watcher получил online', liveWatch.some(([k, l]) => k === 'online' && l === 'alpha'));
const onlineLogs = logs.events.items.slice(liveBefore).filter((l) => l.kind === 'online');
ok('эфир: «начался» в ленте один раз', onlineLogs.length === 1 && onlineLogs[0].text.includes('Весёлый стрим'));

ok('эфир: переход в offline — true', tracker.markOffline('100') === true);
ok('эфир: повторное offline — не переход', tracker.markOffline('100') === false);
ok('эфир: watcher получил offline', liveWatch.some(([k, l]) => k === 'offline' && l === 'alpha'));
ok('эфир: после offline не live и без длительности', tracker.isLive('100') === false && tracker.snapshot().alpha.live === false);
const offlineLogs = logs.events.items.slice(liveBefore).filter((l) => l.kind === 'offline');
ok('эфир: «закончился» в ленте с длительностью', offlineLogs.length === 1 && offlineLogs[0].text.includes('мин'));

// тихая первичная сверка: бот поднялся посреди эфира — состояние есть, «начался» НЕ пишется
const tracker2 = new LiveTracker({ helix: fakeHelixLive, channels: registry, logs });
await tracker2.sync({ quiet: true });
ok('эфир: тихая сверка ставит состояние', tracker2.isLive('100') && tracker2.snapshot().alpha.title === 'Весёлый стрим');
ok('эфир: тихая сверка молчит в ленте', logs.events.items.slice(liveBefore).every((l) => l.kind !== 'online' || l.text.includes('Весёлый')));
ok('эфир: тихая сверка видит и оффлайн-канал', tracker2.isLive('200') === false);

// страховочная сверка ловит пропущенный EventSub (transition без quiet)
const tracker3 = new LiveTracker({ helix: fakeHelixLive, channels: registry, logs });
tracker3.markOnline('200', {}); // beta «в эфире» по нашим данным, Helix говорит: нет
await tracker3.sync();
ok('эфир: сверка ловит пропущенный конец', tracker3.isLive('200') === false);

// обработчики EventProcessor гоняют трекер
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
  "  async start(api) { globalThis.__mtestStarted = (globalThis.__mtestStarted || 0) + 1; api.setInterval(() => { globalThis.__mtestTicks = (globalThis.__mtestTicks || 0) + 1; }, 2); },",
  "  async stop(api) { globalThis.__mtestStopped = (globalThis.__mtestStopped || 0) + 1; api.store.save(); },",
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

// lifecycle + managed-таймеры: start вызван, interval зарегистрирован и тикает
await new Promise((r) => setTimeout(r, 30));
const ticksAfterStart = globalThis.__mtestTicks;
ok('модуль: lifecycle start вызван, managed interval тикает',
  globalThis.__mtestStarted === 1 && ticksAfterStart > 0 && (mm._timers.get('mtest')?.length ?? 0) >= 1);

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

await mm.setEnabled('mtest', false);
await new Promise((r) => setTimeout(r, 40));
ok('модуль: lifecycle stop вызван, managed interval очищен',
  globalThis.__mtestStopped === 1 && globalThis.__mtestTicks === ticksAfterStart && !mm._timers.has('mtest'));
const sentModBefore = sentMod.length;
await mm.dispatch('channel.chat.message', { broadcaster_user_id: '200', chatter_user_id: '9', message: { text: '!модпеченька' } });
ok('модуль: выключенный молчит', sentMod.length === sentModBefore && mm.findCommand('модфакт') === null);
mm.setEnabled('mtest', true);

// перехват chat.message: модуль-блокировщик + перезагрузка, чтобы бот его подхватил
fs.writeFileSync(path.join(modsDir, 'mblock.js'), [
  "export default {",
  "  name: 'mblock',",
  "  description: 'перехват чата для теста',",
  "  events: { 'chat.message': async () => false },",
  "};",
].join('\n'), 'utf8');

await mm.reload();
ok('модуль: reload живой', mm.list().some((m) => m.name === 'mtest' && !m.error));

const blockedRes = await mm.dispatch('channel.chat.message', { broadcaster_user_id: '200', chatter_user_id: '5', message: { text: 'перехвачено' } });
ok('перехват: return false из хука chat.message блокирует событие', blockedRes === false);

await mm.setEnabled('mblock', false);
const passRes = await mm.dispatch('channel.chat.message', { broadcaster_user_id: '200', chatter_user_id: '5', message: { text: 'не блокировано' } });
ok('перехват: без блок-хука событие проходит', passRes !== false);

mm.stop();

// ---------- модули: ПОЛНЫЙ API (helix/store/obs/overlay/timers/lifecycle/async-команды) ----------
// грузим НАСТОЯЩИЕ модули из папки проекта: example.js + vip-activity.js
const { fileURLToPath } = await import('node:url');
const realModulesDir = fileURLToPath(new URL('../modules', import.meta.url));
const storeDirApi = path.join(process.env.BOT_DATA_DIR, 'module-store-api');

const helixApiCalls = [];
const sentApi = [];
const fakeHelixApi = {
  call: async (method, p, { query, body } = {}) => {
    helixApiCalls.push({ method, path: p, query, body });
    if (method === 'GET' && p === '/channels/vips') {
      return { data: [
        { user_id: '55', user_login: 'sleepy', user_name: 'Sleepy' },
        { user_id: '66', user_login: 'active', user_name: 'Active' },
      ] };
    }
    if (method === 'DELETE' && p === '/channels/vips') return { data: [] };
    if (method === 'GET' && p === '/users') return { data: [{ id: '42', login: query?.login, display_name: 'Vasya', created_at: '2020-01-01T00:00:00Z' }] };
    return { data: [] };
  },
  sendMessage: async (b) => { sentApi.push({ ...b }); return { message_id: 'api-m' }; },
  getUserByLogin: async (login) => ({ id: '55', login, display_name: login }),
  getStreamByLogin: async () => null,
  shoutout: async () => ({}),
  announce: async () => ({}),
};
const fakeBcHelix = {
  call: async (method, p, opts = {}) => {
    helixApiCalls.push({ method, path: `bc:${p}`, query: opts?.query });
    return { via: 'broadcaster' };
  },
};
const obsSceneCalls = [];
const fakeObsApi = {
  async setCurrentProgramScene(name) { obsSceneCalls.push(name); },
  async getSceneList() { return { scenes: ['Стрим', 'BRB'], current: 'Стрим' }; },
  async setSceneItemEnabled(scene, source, visible) { obsSceneCalls.push([scene, source, visible]); },
};

const mm2 = new ModuleManager({
  dir: realModulesDir,
  configFile: path.join(process.env.BOT_DATA_DIR, 'modules-api.json'),
  storeDir: storeDirApi,
  helix: fakeHelixApi,
  auth: fakeAuth,
  logs,
  channels: registry,
  settings: { proxy: { enabled: false, url: '' } },
  state: { running: true, counters: { messagesSeen: 5 } },
  obs: fakeObsApi,
  broadcasterAuth: { tokens: { accessToken: 'bc-token', userId: '7' } },
  broadcasterHelix: fakeBcHelix,
});

// примеры теперь по умолчанию выключены (enabled: false в их def) —
// как это будет у свежего юзера; включаем явно, как делает панель
const mmDef = new ModuleManager({
  dir: realModulesDir,
  configFile: path.join(process.env.BOT_DATA_DIR, 'modules-defaults.json'),
  storeDir: path.join(process.env.BOT_DATA_DIR, 'store-def'),
  helix: fakeHelixApi, auth: fakeAuth, logs, channels: registry,
});
await mmDef.load();
ok('модули: встроенные примеры по умолчанию выключены',
  mmDef.list().find((m) => m.name === 'example')?.enabled === false
  && mmDef.list().find((m) => m.name === 'vip-activity')?.enabled === false);

mm2._config.enabled.example = true;
mm2._config.enabled['vip-activity'] = true;
await mm2.load();
const exInfo = mm2.list().find((m) => m.name === 'example');
const vipInfo = mm2.list().find((m) => m.name === 'vip-activity');
ok('модули-примеры: example.js и vip-activity.js грузятся без ошибок',
  Boolean(exInfo && !exInfo.error && vipInfo && !vipInfo.error));
ok('модули: lifecycle start вызван (example и vip-activity)',
  logs.system.items.some((l) => String(l?.message || '').includes('example загружен'))
  && logs.system.items.some((l) => String(l?.message || '').includes('vip-activity: запущен')));
ok('модули: managed interval зарегистрирован через api.setInterval в start',
  (mm2._timers.get('example')?.length ?? 0) >= 1);

// async-команды модулей через движок команд
const engine3 = new CommandEngine({ helix: fakeHelixApi, auth: fakeAuth, logs, settings, state: { counters: {} } });
engine3.setChannels(registry);
engine3.setModules(mm2);
await engine3.handleChatMessage({ broadcasterId: '200', userId: '7', login: 'vasya', displayName: 'Vasya', text: '!факт', badges: [] });
ok('модули: строковая команда из example.js', sentApi.at(-1)?.text === 'Vasya, котики мурчат 🐱');
await engine3.handleChatMessage({ broadcasterId: '200', userId: '7', login: 'vasya', displayName: 'Vasya', text: '!профиль @sleepy', badges: [] });
ok('модули: async-команда дёргает api.helix.get',
  helixApiCalls.some((c) => c.method === 'GET' && c.path === '/users' && c.query?.login === 'sleepy'));
ok('модули: async-команда отвечает через api.say в канал команды',
  sentApi.at(-1)?.text === 'Vasya — ID 42, создан 2020-01-01' && sentApi.at(-1)?.broadcasterId === '200');
await engine3.handleChatMessage({ broadcasterId: '200', userId: '7', login: 'vasya', displayName: 'Vasya', text: '!счёт', badges: [] });
ok('модули: store.get/set — счётчик вызовов', sentApi.at(-1)?.text === '!счёт вызван 1 раз(а)');
await engine3.handleChatMessage({ broadcasterId: '200', userId: '8', login: 'petya', displayName: 'Petya', text: '!счёт', badges: [] });
ok('модули: store инкрементируется между вызовами', sentApi.at(-1)?.text === '!счёт вызван 2 раз(а)');

// хук chat.message из example.js
await mm2.dispatch('channel.chat.message', { broadcaster_user_id: '200', chatter_user_id: '9', chatter_user_login: 'ping', chatter_user_name: 'Ping', message: { text: '!пинг' } });
ok('модули: хук chat.message example-модуля отвечает', sentApi.at(-1)?.text === 'понг от example-модуля!');

// lifecycle stop: store сохраняется на диск, managed-таймеры чистятся
await mm2.setEnabled('example', false);
ok('модули: stop сохраняет store в data/module-store/<имя>.json', (() => {
  const f = path.join(storeDirApi, 'example.json');
  return fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')).count === 2;
})());
ok('модули: managed interval очищен при stop', !mm2._timers.has('example'));
ok('модули: storageKeys в реестре — панель видит хранилище модуля',
  mm2.list().find((m) => m.name === 'example')?.storageKeys.includes('count') === true);

// vip-activity: активный юзер пишет в чат (его VIP трогать нельзя)
await mm2.dispatch('channel.chat.message', { broadcaster_user_id: '200', chatter_user_id: '66', chatter_user_login: 'active', chatter_user_name: 'Active', message: { text: 'я активный, не снимайте VIP!' } });

// vip-activity: сухой прогон (dryRun=true — только предупреждение)
const vipLogsBefore = logs.system.items.length;
await mm2._fire('tick', { now: Date.now() });
ok('vip-activity: dryRun — предупреждение без снятия', logs.system.items.slice(vipLogsBefore)
  .some((l) => String(l?.message || '').includes('Sleepy неактивен') && String(l?.message || '').includes('dryRun')));
ok('vip-activity: dryRun — DELETE не вызывается', !helixApiCalls.some((c) => c.method === 'DELETE'));

// vip-activity: боевой прогон (dryRun=false)
mm2.updateSettings('vip-activity', { dryRun: false, scanMinutes: 0 });
const ovBus = (await import('../src/bot/alerts.js')).overlay;
ovBus.clients.clear();
const ovVip = [];
ovBus.clients.add({ write: (s) => ovVip.push(String(s)) });
await mm2._fire('tick', { now: Date.now() });
ok('vip-activity: снимает VIP у неактивного',
  helixApiCalls.some((c) => c.method === 'DELETE' && c.path === '/channels/vips' && c.query?.user_id === '55'));
ok('vip-activity: активного не трогает', !helixApiCalls.some((c) => c.method === 'DELETE' && c.query?.user_id === '66'));
ok('модули: overlay.push кидает алерт из модуля в шину', ovVip.some((s) => s.includes('"kind":"meme"') && s.includes('потерял VIP')));
ovBus.clients.clear();

// данные и состояние
const vipApi = mm2.apiFor('vip-activity');
ok('модули: api.state — счётчики, статус и каналы бота',
  vipApi.state.running === true && vipApi.state.counters.messagesSeen === 5
  && vipApi.state.channels.join(',') === 'alpha,beta');
ok('модули: api.channels() отдаёт полные объекты каналов',
  Array.isArray(vipApi.channels()) && vipApi.channels().some((c) => c.id === '200' && c.login === 'beta'));

// Helix токеном стримера
const bcRes = await vipApi.broadcaster.helix.get('/channel_points/custom_rewards', { broadcaster_id: '100' });
ok('модули: api.broadcaster.helix ходит токеном стримера',
  helixApiCalls.some((c) => c.path === 'bc:/channel_points/custom_rewards') && bcRes?.via === 'broadcaster');
const noBcApi = mm.apiFor('mtest');
const noBc = await noBcApi.broadcaster.helix.get('/anything');
ok('модули: api.broadcaster.helix без входа стримера — понятная ошибка', noBc?.error === 'стример не залогинен');

// OBS из модулей
ok('модули: api.obs.getScenes отдаёт сцены', (await vipApi.obs.getScenes())?.scenes?.[0] === 'Стрим');
await vipApi.obs.setScene('BRB');
await vipApi.obs.toggleSource('Стрим', 'Webcam', false);
ok('модули: api.obs.setScene/toggleSource вызываются',
  obsSceneCalls[0] === 'BRB' && JSON.stringify(obsSceneCalls[1]) === JSON.stringify(['Стрим', 'Webcam', false]));
ok('модули: api.obs без OBS — понятная ошибка', (await noBcApi.obs.getScenes())?.error === 'OBS не подключён');

// api.stop(): модуль выключает сам себя и сохраняет store
await vipApi.stop();
ok('модули: api.stop() выключает модуль и сохраняет его store', (() => {
  const f = path.join(storeDirApi, 'vip-activity.json');
  const saved = fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8'));
  return Boolean(saved && saved['last:66'] && mm2.list().find((m) => m.name === 'vip-activity')?.enabled === false);
})());


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
settings.wheel = { enabled: true, mode: 'command', cooldown: 60, items: [{ label: '💥 мимо', weight: 0 }, { label: '💎 ДЖЕКПОТ', weight: 10 }] };
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!колесо', badges: [] });
ok('колесо: спин — исход из таблицы весов', sent.at(-1).includes('ДЖЕКПОТ')
  && ovFree.some((s) => s.includes('"kind":"wheel"') && s.includes('Petya')));
ok('колесо: снапшот секторов уходит виджету-рулетке', ovFree.some((s) => s.includes('"sectors"') && s.includes('ДЖЕКПОТ')));
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!колесо', badges: [] });
ok('колесо: кулдаун держит повтор', sent.at(-1).includes('охлади'));
settings.wheel.cooldown = 0;
// в режиме награды команда перенаправляет
settings.wheel.mode = 'reward';
settings.wheel.rewardName = 'колесо';
await engine.handleChatMessage({ userId: '8', login: 'petya', displayName: 'Petya', text: '!колесо', badges: [] });
ok('колесо: mode=reward — команда подсказывает награду', sent.at(-1).includes('наградой канала'));
settings.wheel.mode = 'command';

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

// ---------- файл-диагностика: 2 запуска, без личного ----------
{
  const { diagSanitize, diagStart, diagLog, diagAttach } = await import('../src/bot/diag.js');
  ok('диагностика: @ники затёрты', diagSanitize('Ошибка входа: @cumsya_bot не отвечает') === 'Ошибка входа: @*** не отвечает');
  ok('диагностика: токены затёрты', diagSanitize('refresh_token=abc123secret_key_here').includes('***') && !diagSanitize('refresh_token=abc123secret_key_here').includes('secret_key_here'));
  ok('диагностика: query-параметры затёрты', diagSanitize('GET https://twitch.tv/api?code=abcdef123456&state=xyz').includes('?***'));
  ok('диагностика: длинные hex затёрты', !diagSanitize('сессия 0123456789abcdef0123456789abcdef').includes('0123456789abcdef0123456789abcdef'));
  ok('диагностика: обычный текст цел', diagSanitize('Не удалось запустить: fetch failed') === 'Не удалось запустить: fetch failed');
  ok('диагностика: логины частично замаскированы', diagSanitize('Бот nanachi_nya_bot подключается к каналам: krolik_nya, cumsya').includes('n***t') && diagSanitize('Бот nanachi_nya_bot подключается к каналам: krolik_nya, cumsya').includes('k***a'));
  // ротация двух запусков
  diagStart({ version: '1.0.0' });
  diagLog('info', 'запуск один');
  diagStart({ version: '2.0.0' });
  diagLog('error', 'запуск два');
  const d1 = fs.readFileSync(path.join(process.env.BOT_DATA_DIR, 'diag.log'), 'utf8');
  ok('диагностика: в файле оба запуска', d1.includes('запуск один') && d1.includes('запуск два'));
  ok('диагностика: версия запуска записана', d1.includes('v1.0.0') && d1.includes('v2.0.0'));
  diagStart({ version: '3.0.0' });
  diagLog('info', 'запуск три');
  const d2 = fs.readFileSync(path.join(process.env.BOT_DATA_DIR, 'diag.log'), 'utf8');
  ok('диагностика: третий запуск вытеснил первый (хранятся 2)', d2.includes('запуск два') && d2.includes('запуск три') && !d2.includes('запуск один'));
  // перехват системного лога
  const fakeLogs = { system: { push: (e) => {} } };
  diagAttach(fakeLogs);
  fakeLogs.system.push({ level: 'warn', message: 'Возврат баллов не удался (@krolik_nya)' });
  const d3 = fs.readFileSync(path.join(process.env.BOT_DATA_DIR, 'diag.log'), 'utf8');
  ok('диагностика: системный лог льётся в файл (санитизированным)', d3.includes('Возврат баллов не удался') && d3.includes('@***') && !d3.includes('krolik_nya'));
}

// ---------- таймер донатона ----------
{
  const { DonaTimer, toRub } = await import('../src/bot/donatimer.js');
  const dtLogs = { events: { push: () => {} }, system: { push: () => {} } };
  const dtSettings = { donaTimer: { enabled: true, baseMinutes: 100, pricePerMinute: 50 }, donations: {} };

  ok('донатон: toRub 100 USD → 9200₽ (курс 92)', toRub(100, 'USD') === 9200 && toRub(100, 'USD') > 9000);
  ok('донатон: toRub рубли не конвертирует', toRub(100, 'RUB') === 100 && toRub(100) === 100);
  ok('донатон: toRub мусорная сумма → 0', toRub('мусор', 'RUB') === 0 && toRub(NaN, 'USD') === 0);

  // на паузе secondsLeft() отдаёт замороженное значение из стора и не тикает
  const dt = new DonaTimer({ logs: dtLogs, settings: dtSettings });
  dt._load({});
  ok('донатон: свежий экземпляр — running=false, секунды на нуле',
    dt.state().running === false && dt.secondsLeft() === 0);
  dt._load({ pausedAtSec: 100 * 60 }); // как после перезапуска бота во время паузы
  await new Promise((r) => setTimeout(r, 30));
  ok('донатон: таймер на паузе хранит свои 100×60 сек и не тикает',
    dt.secondsLeft() === 100 * 60 && dt.secondsLeft() === dt.secondsLeft());

  dt.onStreamStart();
  ok('донатон: onStreamStart → running, время ≈ база (5990–6000)',
    dt.state().running === true && dt.secondsLeft() >= 5990 && dt.secondsLeft() <= 6000);

  const addFirst = dt.addDonation({ id: 'd1', amount: 100, currency: 'RUB' });
  const addDup = dt.addDonation({ id: 'd1', amount: 100, currency: 'RUB' });
  ok('донатон: донат засчитан, дубль по тому же id — нет',
    addFirst === true && addDup === false && dt.state().totalRub === 100);

  dt.onStreamStart(); // новый стрим: счётчики этого стрима обнуляются
  dt.addDonation({ id: 'd2', amount: 100, currency: 'RUB' });
  const sDonated = dt.secondsLeft();
  ok('донатон: донат 100₽ при цене 50₽/мин добавляет ~120 сек',
    sDonated > 6000 && sDonated - 6000 >= 100 && sDonated - 6000 <= 121);

  const sBefore = dt.secondsLeft();
  ok('донатон: addManualSec(-60) убавляет время', dt.addManualSec(-60).ok === true && dt.secondsLeft() < sBefore);
  ok('донатон: addManualSec(0/мусор) → ошибка', dt.addManualSec(0).error && dt.addManualSec('мусор').error);

  dt.onStreamEnd();
  const sFrozen = dt.secondsLeft();
  await new Promise((r) => setTimeout(r, 30));
  ok('донатон: onStreamEnd → пауза, секунды заморожены',
    dt.state().running === false && dt.secondsLeft() === sFrozen);

  const enBefore = dt.state().enabled;
  dtSettings.donaTimer.enabled = false;
  ok('донатон: state().enabled следует за живой настройкой', enBefore === true && dt.state().enabled === false);

  const rubBefore = dt.state().totalRub;
  ok('донатон: addManualDonation с нулём/мусором → ошибка, сумма не растёт',
    dt.addManualDonation({ amount: 0 }).error && dt.addManualDonation({ amount: 'мусор' }).error
    && dt.state().totalRub === rubBefore);
  ok('донатон: addManualDonation валидной суммой → true',
    dt.addManualDonation({ amount: 100, name: 'тест' }) === true && dt.state().totalRub === rubBefore + 100);

  const dtZero = new DonaTimer({ logs: dtLogs, settings: { donaTimer: { enabled: true, baseMinutes: 0, pricePerMinute: 50 }, donations: {} } });
  dtZero.onStreamStart();
  ok('донатон: нулевая база без донатов → почти ноль сразу', dtZero.secondsLeft() <= 1);

  // ---------- установить время ровно (поля ч/мин/сек панели) ----------
  const dtSet = new DonaTimer({ logs: dtLogs, settings: { donaTimer: { enabled: true, baseMinutes: 10, pricePerMinute: 50 }, donations: {} } });
  dtSet.onStreamStart();
  dtSet.setRemainingSec(90);
  await new Promise((r) => setTimeout(r, 30));
  ok('донатон: setRemainingSec на тикающем → осталось ~90 сек (донаты не откатились)',
    dtSet.state().running === true && Math.abs(dtSet.secondsLeft() - 90) <= 2);
  dtSet.setRemainingSec(0);
  ok('донатон: setRemainingSec(0) на тикающем → ноль', dtSet.secondsLeft() <= 1);
  dtSet.setRemainingSec(90); // обратно — delta считается от факта
  ok('донатон: повторный set с нуля работает (delta от текущего)',
    Math.abs(dtSet.secondsLeft() - 90) <= 2);
  const dtPaused = new DonaTimer({ logs: dtLogs, settings: { donaTimer: { enabled: true, baseMinutes: 10, pricePerMinute: 50 }, donations: {} } });
  dtPaused._load({ pausedAtSec: 600 });
  dtPaused.setRemainingSec(3725); // 1ч 2м 5с
  ok('донатон: setRemainingSec на паузе → pausedAtSec ровно 3725',
    dtPaused.secondsLeft() === 3725 && dtPaused.state().running === false);
  dtSet.stop();

  // ---------- baseSeconds: стартовое время с секундами ----------
  const dtSec = new DonaTimer({ logs: dtLogs, settings: { donaTimer: { enabled: true, baseMinutes: 0, baseSeconds: 30, pricePerMinute: 50 }, donations: {} } });
  dtSec.onStreamStart();
  const secLeft = dtSec.secondsLeft();
  ok('донатон: baseSeconds учитывается (0 мин + 30 сек → ~30, не 0 и не 1800)',
    secLeft <= 30 && secLeft >= 25);
  dtSec.stop();

  // ---------- webhook: HMAC-SHA256 подпись ----------
  const { verifyWebhookSignature } = await import('../src/bot/donatimer.js');
  const { createHmac } = await import('node:crypto');
  const SECRET = 'test-secret-123';
  const body = JSON.stringify({ id: 777, amountInRub: 250, username: 'Валера', message: 'продли стрим!' });
  const goodHex = createHmac('sha256', SECRET).update(body).digest('hex');
  ok('донатон-webhook: валидная подпись hex → true', verifyWebhookSignature(body, SECRET, goodHex));
  ok('донатон-webhook: формат sha256=<hex> (X-Hub-Signature) → true', verifyWebhookSignature(body, SECRET, `sha256=${goodHex}`));
  ok('донатон-webhook: чужая/битая подпись → false', verifyWebhookSignature(body, SECRET, 'a'.repeat(64)) === false);
  ok('донатон-webhook: без секрета или подписи → false', verifyWebhookSignature(body, '', goodHex) === false && verifyWebhookSignature(body, SECRET, '') === false);
  ok('донатон-webhook: не-hex мусор → false', verifyWebhookSignature(body, SECRET, 'zzzz') === false);

  const whSettings = { donaTimer: { enabled: true, baseMinutes: 10, pricePerMinute: 50 }, donations: { donatex: { enabled: true, token: '', webhookSecret: SECRET } } };
  const wh = new DonaTimer({ logs: dtLogs, settings: whSettings });
  wh.onStreamStart();
  const wh1 = wh.handleWebhook({ source: 'donatex', rawBody: body, signature: goodHex });
  ok('донатон-webhook: валидный донат засчитан (added=1, totalRub=250)',
    wh1.ok === true && wh1.added === 1 && wh.state().totalRub === 250);
  const wh2 = wh.handleWebhook({ source: 'donatex', rawBody: body, signature: goodHex });
  ok('донатон-webhook: повторный тот же донат — идемпотентность (added=0)',
    wh2.ok === true && wh2.added === 0 && wh.state().totalRub === 250);
  const whBad = wh.handleWebhook({ source: 'donatex', rawBody: body, signature: 'b'.repeat(64) });
  ok('донатон-webhook: плохая подпись → error, сумма не растёт', whBad.error === 'bad signature' && wh.state().totalRub === 250);
  // подпись считается от СЫРОГО тела — для «не-JSON» тела нужна своя валидная подпись
  const badJsonBody = 'не json';
  const badJsonSig = createHmac('sha256', SECRET).update(badJsonBody).digest('hex');
  const whJson = wh.handleWebhook({ source: 'donatex', rawBody: badJsonBody, signature: badJsonSig });
  ok('донатон-webhook: валидно подписанный мусор (не-JSON) → error', whJson.error === 'bad json');
  const whOff = new DonaTimer({ logs: dtLogs, settings: { donaTimer: { enabled: false }, donations: { donatex: { webhookSecret: SECRET } } } });
  ok('донатон-webhook: выключенный таймер отклоняет донат', whOff.handleWebhook({ source: 'donatex', rawBody: body, signature: goodHex }).error === 'timer disabled');
  wh.stop();

  // ---------- объектная раскладка ----------
  const objSettings = { donaTimer: { enabled: true, objects: [{ id: 'clock-9', type: 'clock', x: 10, y: 20, w: 300, h: 80, opacity: 100, z: 4, fontSize: 60 }] }, donations: {} };
  const dtObj = new DonaTimer({ logs: dtLogs, settings: objSettings });
  const stObj = dtObj.state();
  ok('донатон: state().objects отдаёт объекты раскладки из настроек',
    Array.isArray(stObj.objects) && stObj.objects.length === 1 && stObj.objects[0].type === 'clock');
  dtObj.stop();

  dt.stop();
  dtZero.stop();
}

console.log(`\nВсе ${passed} тестов прошли ✅`);
fs.rmSync(process.env.BOT_DATA_DIR, { recursive: true, force: true });
process.exit(0);
