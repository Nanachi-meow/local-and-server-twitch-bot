/* Панель управления: ванильный JS, поллинг раз в 2 секунды. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}ч ${m}м` : `${m}м ${s % 60}с`;
}

let toastTimer = null;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${isError ? 'err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

// Не даём опросу состояния затирать поля настроек, пока их заполняют
let settingsFormTouched = false;
['cfg-client-id', 'cfg-client-secret', 'cfg-port'].forEach((id) => {
  const el = document.getElementById(id);
  el?.addEventListener('input', () => { settingsFormTouched = true; });
});

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ---------------- вкладки ----------------

$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab').forEach((b) => b.classList.remove('active'));
    $$('.tabpane').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// подвкладки внутри вкладки (Команды → Кастомные / Встроенные)
$$('.subtab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const pane = btn.closest('.tabpane');
    if (!pane) return;
    pane.querySelectorAll('.subtab').forEach((b) => b.classList.remove('active'));
    pane.querySelectorAll('[id^="sub-"]').forEach((d) => d.classList.add('hidden'));
    btn.classList.add('active');
    const target = pane.querySelector(`#sub-${btn.dataset.subtab}`);
    if (target) target.classList.remove('hidden');
  });
});
document.addEventListener('click', (e) => {
  const link = e.target.closest('.goto-tab');
  if (!link) return;
  e.preventDefault();
  const btn = $(`.tab[data-tab="${link.dataset.tab}"]`);
  if (btn) btn.click();
});

// ---------------- hash-баннеры ----------------

function handleHash() {
  const hash = decodeURIComponent(location.hash || '');
  if (!hash) return;
  const banner = $('#banner');
  if (hash.startsWith('#ok:broadcaster')) {
    banner.textContent = '✅ Стример залогинен — бот видит списания наград канала.';
    banner.className = 'banner ok';
  } else if (hash.startsWith('#ok')) {
    banner.textContent = '✅ Успех! Бот залогинен.';
    banner.className = 'banner ok';
  } else if (hash.startsWith('#err:')) {
    banner.textContent = `❌ ${hash.slice(5)}`;
    banner.className = 'banner err';
  }
  setTimeout(() => banner.classList.add('hidden'), 15000);
  history.replaceState(null, '', location.pathname);
}

// ---------------- логи ----------------

const lastIds = { chat: 0, events: 0, system: 0 };

function appendLog(container, html, isAtBottom) {
  const div = document.createElement('div');
  div.className = 'row';
  div.innerHTML = html;
  container.appendChild(div);
  while (container.children.length > 250) container.removeChild(container.firstChild);
  if (isAtBottom) container.scrollTop = container.scrollHeight;
}

function atBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function renderLogs(data) {
  const chatEl = $('#log-chat');
  const chatBottom = atBottom(chatEl);
  for (const m of data.chat) {
    const lvl = m.level && m.level !== 'everyone' ? `<span class="lvl">(${esc(m.level)})</span>` : '';
    const ch = m.channel ? `<span class="ch">#${esc(m.channel)}</span>` : '';
    appendLog(chatEl, `<span class="time">${fmtTime(m.ts)}</span>${ch}<span class="who">${esc(m.user || m.login)}</span>${lvl}${esc(m.text)}`, chatBottom);
  }
  const evEl = $('#log-events');
  const evBottom = atBottom(evEl);
  for (const l of data.events) {
    const ch = l.channel ? ` <span class="ch">#${esc(l.channel)}</span>` : '';
    appendLog(evEl, `<span class="time">${fmtTime(l.ts)}</span><span class="kind">[${esc(l.kind)}]</span>${ch} ${esc(l.text)}`, evBottom);
  }
  // системные — в общую ленту событий, серым
  for (const l of data.system) {
    const cls = l.level === 'error' ? 'error' : '';
    appendLog(evEl, `<span class="time">${fmtTime(l.ts)}</span><span class="${cls}">⚙︎ ${esc(l.message)}</span>`, evBottom);
  }
  lastIds.chat = data.chat.length ? data.chat[data.chat.length - 1].id : lastIds.chat;
  lastIds.events = data.events.length ? data.events[data.events.length - 1].id : lastIds.events;
  lastIds.system = data.system.length ? data.system[data.system.length - 1].id : lastIds.system;
}

function renderChannelChips(list) {
  const el = $('#cfg-channels');
  if (!el) return;
  const key = list.join(',');
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  el.innerHTML = list.length
    ? list.map((c) => `<span class="chip ok" data-login="${esc(c)}">#${esc(c)} <b class="ch-x" title="убрать канал">✕</b></span>`).join('')
    : '<span class="chip err">каналы не добавлены</span>';
}

async function saveChannels(newList, { allowEmpty = false } = {}) {
  if (!newList.length && !allowEmpty) { toast('Нужен хотя бы один канал', true); return false; }
  await api('/api/config', { method: 'POST', body: JSON.stringify({ channels: newList }) });
  toast('Каналы обновлены — бот перенастраивается ✅');
  return true;
}

$('#channel-add-btn').addEventListener('click', async () => {
  const input = $('#cfg-channel-add');
  const val = input.value.trim().replace(/^@/, '').toLowerCase();
  if (!val) return;
  const cur = (window.__state?.config?.channels ?? []).filter(Boolean);
  if (cur.includes(val)) { toast('Такой канал уже в списке', true); return; }
  if (cur.length >= 10) { toast('Максимум 10 каналов', true); return; }
  try {
    if (await saveChannels([...cur, val])) input.value = '';
  } catch (e) { toast(e.message, true); }
});

$('#cfg-channels').addEventListener('click', async (e) => {
  const chip = e.target.closest('.chip[data-login]');
  if (!chip) return;
  if (!confirm(`Убрать канал #${chip.dataset.login}?`)) return;
  const cur = (window.__state?.config?.channels ?? []).filter(Boolean);
  try { await saveChannels(cur.filter((c) => c !== chip.dataset.login)); } catch (err) { toast(err.message, true); }
});

function qaChannel() {
  const sel = $('#qa-channel');
  return sel && sel.value ? sel.value : undefined;
}

// ---------------- статус ----------------

function setChip(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = `chip ${cls || ''}`;
}

function renderState(st) {
  const { auth: a, runtime: rt, configured } = st;

  const chans = st.config?.channels ?? [];
  setChip('#chip-config',
    chans.length ? `каналы: ${chans.map((c) => '@' + c).join(' ')}` : 'каналы не заданы',
    chans.length ? 'ok' : 'err');
  setChip('#chip-auth', a.login ? 'бот: ' + a.login : 'нет входа', a.login ? (a.status === 'ok' ? 'ok' : 'warn') : 'warn');
  const subsOk = Object.values(rt.eventsub?.subStatus || {}).filter((s) => s === 'ok').length;
  const subsTotal = Object.keys(rt.eventsub?.subStatus || {}).length;
  setChip('#chip-conn',
    rt.eventsub?.connected ? `чат подключен (${subsOk}/${subsTotal || '?'} подписок)` : 'чат отключен',
    rt.eventsub?.connected ? 'ok' : 'err');
  $('#chip-version').textContent = `v${st.version}`;

  const onboarding = $('#onboarding');
  if (configured && a.login && rt.eventsub?.connected) {
    onboarding.classList.add('hidden');
  } else {
    onboarding.classList.remove('hidden');
    $('#step1').style.opacity = configured ? '.55' : '';
    $('#step2').style.opacity = configured ? '.55' : '';
    $('#step3').style.opacity = a.login ? '.55' : '';
    $('#step4').style.opacity = rt.eventsub?.connected ? '.55' : '';
  }

  // статистика
  $('#st-uptime').textContent = fmtDuration(st.now - st.startedAt);
  $('#st-msg').textContent = st.counters.messagesSeen ?? 0;
  $('#st-cmd').textContent = st.counters.commandsRun ?? 0;
  $('#st-follow').textContent = st.counters.follow ?? 0;
  $('#st-raid').textContent = st.counters.raid ?? 0;
  $('#st-sub').textContent = st.counters.sub ?? 0;

  const uriBot = $('#redirect-uri');
  if (uriBot) uriBot.textContent = `http://localhost:${st.port}/auth/callback`;
  const uriBc = $('#redirect-uri-broadcaster');
  if (uriBc) uriBc.textContent = `http://localhost:${st.port}/auth/broadcaster/callback`;

  // настройки: обновляем поля только если их не редактируют прямо сейчас
  if (!settingsFormTouched) {
    $('#cfg-client-id').value = st.config.clientId || '';
    $('#cfg-port').value = st.port;
  }
  $('#cfg-secret-hint').textContent = st.config.clientSecret ? '(уже сохранён)' : '';

  // список каналов (чипы), предупреждение про аккаунт бота
  renderChannelChips(chans);
  $('#channel-self-warn').classList.toggle('hidden', !(a.login && chans.includes(a.login)));

  // селектор канала для быстрых действий: пересобираем только при изменении списка
  const sel = $('#qa-channel');
  const selKey = chans.join(',');
  if (sel.dataset.key !== selKey) {
    const prev = sel.value;
    sel.innerHTML = chans.length
      ? chans.map((c) => `<option value="${esc(c)}">#${esc(c)}</option>`).join('')
      : '<option value="">каналов нет</option>';
    if (chans.includes(prev)) sel.value = prev;
    sel.dataset.key = selKey;
  }
  $('#auth-login').classList.toggle('hidden', !configured);
  $('#auth-info').innerHTML = a.login
    ? `Вход выполнен: <b>${esc(a.login)}</b>${a.expiresAt ? ` · токен истекает ${new Date(a.expiresAt).toLocaleString('ru-RU')}` : ''}`
    : '';

  // «👑 Награды канала»: статус второго входа (стримером)
  const bc = st.broadcaster ?? {};
  $('#broadcaster-login').classList.toggle('hidden', Boolean(bc.login));
  $('#broadcaster-logout').classList.toggle('hidden', !bc.login);
  $('#broadcaster-info').innerHTML = bc.login
    ? `Вход как стример: <b>${esc(bc.login)}</b>${bc.expiresAt ? ` · токен истекает ${new Date(bc.expiresAt).toLocaleString('ru-RU')}` : ''} — списания наград видны`
    : 'Стример не залогинен — без этого бот не видит списания наград канала.';

  if (rt.lastError) {
    setChip('#chip-conn', 'ошибка', 'err');
  }

  window.__state = st;
}

// ---------------- быстрый опрос ----------------

let pollBusy = false;
async function poll() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const [st, logsData] = await Promise.all([
      api('/api/state'),
      api(`/api/logs?chat=${lastIds.chat}&events=${lastIds.events}&system=${lastIds.system}`),
    ]);
    renderState(st);
    renderLogs(logsData);
  } catch (e) {
    // панель недоступна — покажем один раз
  } finally {
    pollBusy = false;
  }
}

// ---------------- команды ----------------

const LEVEL_RU = { everyone: 'все', sub: 'сабы', vip: 'vip', mod: 'моды', broadcaster: 'стример' };

// ---------------- доступ: набор ролей (контекстное меню) ----------------

const ACCESS_ROLES = [
  ['everyone', '🎭 все'],
  ['sub', '💜 сабы'],
  ['vip', '💎 випы'],
  ['mod', '🛡 моды'],
];
const ACCESS_ORDER = { everyone: 0, sub: 1, vip: 2, mod: 3, broadcaster: 4 };

function accessSummary(allow, level) {
  const a = (Array.isArray(allow) ? allow : []).filter(Boolean);
  if (a.length) {
    return [...a].sort((x, y) => (ACCESS_ORDER[x] ?? 9) - (ACCESS_ORDER[y] ?? 9))
      .map((r) => LEVEL_RU[r] ?? r).join(' + ');
  }
  const l = level || 'everyone';
  return l === 'everyone' ? 'все' : `${LEVEL_RU[l] ?? l}+`;
}

/** HTML кнопки выбора доступа. kind: 'custom' (сохранение через 💾) или 'builtin' (применяется сразу). */
function accessBtnHTML(kind, cmdOrName, level, allow) {
  const allowStr = (Array.isArray(allow) ? allow : []).filter(Boolean).join(',');
  const attrs = kind === 'builtin'
    ? `data-kind="builtin" data-cmd="${esc(String(cmdOrName).replace(/^!/, ''))}"`
    : 'data-kind="custom"';
  return `<button class="act ghost apicker-btn" ${attrs} data-level="${esc(level || 'everyone')}" data-allow="${esc(allowStr)}" title="кому можно использовать — ткни чтобы выбрать">${esc(accessSummary(allow, level))}</button>`;
}

// одно меню на всю панель: открывается у кнопки, живёт пока не ткнешь мимо
const apickerMenu = $('#apicker-menu');
let apickerTarget = null;

function openAccessMenu(btn) {
  apickerTarget = btn;
  const level = btn.dataset.level || 'everyone';
  const allow = (btn.dataset.allow || '').split(',').map((s) => s.trim()).filter(Boolean);
  const checked = allow.length ? allow : [level];
  apickerMenu.innerHTML = `
    ${ACCESS_ROLES.map(([r, label]) => `
      <label><input type="checkbox" data-role="${r}" ${checked.includes(r) ? 'checked' : ''} /> ${label}</label>
    `).join('')}
    <div class="ap-note hint">👑 Владелец канала может всегда. Пусто — действует уровень «${esc(LEVEL_RU[level] ?? level)} и выше».</div>
  `;
  apickerMenu.classList.remove('hidden');
  const rect = btn.getBoundingClientRect();
  const menuRect = apickerMenu.getBoundingClientRect();
  let top = rect.bottom + 6;
  if (top + menuRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - menuRect.height - 6);
  apickerMenu.style.top = `${top}px`;
  apickerMenu.style.left = `${Math.min(rect.left, window.innerWidth - menuRect.width - 8)}px`;
}

function closeAccessMenu() {
  apickerMenu.classList.add('hidden');
  apickerTarget = null;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.apicker-btn');
  if (btn) {
    e.preventDefault();
    if (apickerTarget === btn) { closeAccessMenu(); return; }
    openAccessMenu(btn);
    return;
  }
  if (!e.target.closest('#apicker-menu')) closeAccessMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAccessMenu(); });

apickerMenu.addEventListener('change', async (e) => {
  if (!e.target.dataset?.role || !apickerTarget) return;
  const btn = apickerTarget;
  const role = e.target.dataset.role;
  let roles = [...apickerMenu.querySelectorAll('input[data-role]:checked')].map((i) => i.dataset.role);
  if (role === 'everyone' && e.target.checked) roles = ['everyone']; // «все» включает остальных
  else if (e.target.checked && roles.includes('everyone') && role !== 'everyone') {
    roles = roles.filter((r) => r !== 'everyone'); // выбрали конкретную роль — «все» снимается
  }
  // перерисовать галочки согласно логике выше
  apickerMenu.querySelectorAll('input[data-role]').forEach((i) => { i.checked = roles.includes(i.dataset.role); });
  btn.dataset.allow = roles.join(',');
  btn.textContent = roles.length ? accessSummary(roles) : accessSummary([], btn.dataset.level);

  if (btn.dataset.kind === 'builtin' && btn.dataset.cmd) {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ builtins: { access: { [btn.dataset.cmd]: { allow: roles } } } }),
      });
      toast(`!${btn.dataset.cmd}: доступ — ${roles.length ? accessSummary(roles) : 'по умолчанию'}`);
    } catch (err) {
      toast(err.message, true);
    }
  }
  // кастомные: сохраняется кнопкой 💾 строки (как остальные поля)
});
const MODE_RU = { text: 'один ответ', variants: 'несколько вариантов', roll: 'рандом-число' };
const MODE_ICON = { text: '💬', variants: '🎲', roll: '#️⃣' };
const cmdMode = (c) => c.mode || (c.type === 'random' ? 'variants' : 'text');
const isFun = (c) => cmdMode(c) !== 'text' || Boolean(c.needsTarget) || c.type === 'rp';
let __cmdCache = [];

async function loadCommands() {
  const { custom, builtins } = await api('/api/commands');
  closeAccessMenu(); // таблица перерисовалась — старая кнопка могла исчезнуть
  __cmdCache = custom;
  const body = $('#cmds-body');
  body.innerHTML = custom.map((c) => {
    const mode = cmdMode(c);
    const variants = c.variants || [];
    const contentCell = mode === 'variants'
      ? variantsListHTML(c)
      : `<input class="f-response" value="${esc(c.response || '')}" maxlength="480" title="${mode === 'roll' ? 'текст для чисел вне диапазонов' : 'текст ответа'}" ${mode === 'roll' ? 'placeholder="числа вне диапазонов (можно {roll})"' : ''} />`;
    return `
    <tr data-name="${esc(c.name)}">
      <td class="cellname"><code>!${esc(c.name)}</code> <span class="hint">${c.count || 0}×</span></td>
      <td class="celltype"><span class="chip" title="${esc(MODE_RU[mode])}">${MODE_ICON[mode]} ${MODE_RU[mode]}</span>${c.needsTarget ? '<span class="chip">🎯 @ник</span>' : ''}</td>
      <td class="cellresp">${contentCell}${mode === 'roll' ? `<div class="hint">от ${c.rollMin ?? 0} до ${c.rollMax ?? 100}, диапазонов: ${(c.ranges || []).length} — меню в 🎭 Фан-командах ниже</div>` : ''}</td>
      <td class="celllevel">${accessBtnHTML('custom', c.name, c.level, c.allow)}</td>
      <td class="cellcd"><input class="f-cooldown" type="number" min="0" max="3600" value="${c.cooldown ?? 0}" /></td>
      <td class="cellon"><input class="f-enabled" type="checkbox" ${c.enabled !== false ? 'checked' : ''} /></td>
      <td>
        <button class="act cmd-save">💾</button>
        <button class="act ghost cmd-del">🗑</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="hint">Пока нет кастомных команд — добавь первую!</td></tr>';

  $('#builtins-body').innerHTML = builtins.map((b) => `
    <tr data-name="${esc(String(b.name).replace(/^!/, ''))}" class="${b.enabled ? '' : 'off'}">
      <td class="cellname"><code>${esc(b.name)}</code></td>
      <td class="cellresp"><span title="${esc(b.label)}">${esc(b.desc || b.label)}</span></td>
      <td class="celllevel">${accessBtnHTML('builtin', b.name, b.level, b.allow)}</td>
      <td class="cellon"><input class="b-enabled" type="checkbox" ${b.enabled ? 'checked' : ''} /></td>
    </tr>`).join('') || '<tr><td colspan="4" class="hint">Встроенных команд нет 🤷</td></tr>';

  renderFanCommands(custom);
}

// выключение/включение встроенной команды: панель шлёт полный список выключенных имён
$('#builtins-body').addEventListener('change', async (e) => {
  if (!e.target.classList.contains('b-enabled')) return;
  const row = e.target.closest('tr');
  const name = row?.dataset.name || '';
  const checkbox = e.target;
  checkbox.disabled = true;
  try {
    const disabled = $$('#builtins-body tr[data-name]')
      .filter((r) => !r.querySelector('.b-enabled')?.checked)
      .map((r) => r.dataset.name);
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ builtins: { disabled } }) });
    row.classList.toggle('off', !checkbox.checked);
    toast(`!${name} ${checkbox.checked ? 'включена' : 'выключена'}`);
  } catch (err) {
    toast(err.message, true);
    checkbox.checked = !checkbox.checked; // откат
  } finally {
    checkbox.disabled = false;
  }
});

// ---------------- цитаты (карточка на вкладке «Команды») ----------------

async function loadQuotes() {
  const { quotes } = await api('/api/quotes?limit=100');
  $('#quotes-body').innerHTML = quotes.map((q) => `
    <tr data-id="${q.id}">
      <td class="cellcd">#${q.id}</td>
      <td class="cellresp">${esc(q.text)}<div class="hint">${fmtTime(q.at)}</div></td>
      <td class="cellname">${esc(q.by || '—')}</td>
      <td><button class="act ghost q-del" title="удалить цитату">🗑</button></td>
    </tr>`).join('')
    || '<tr><td colspan="4" class="hint">Цитат пока нет — добавь первую или сохрани из чата: !цитата добавить текст (мод+)</td></tr>';
}

$('#quote-add-btn').addEventListener('click', async () => {
  const text = $('#quote-add-text').value.trim();
  if (!text) { toast('Напиши текст цитаты', true); return; }
  try {
    const { quote } = await api('/api/quotes', { method: 'POST', body: JSON.stringify({ text }) });
    $('#quote-add-text').value = '';
    toast(`Цитата #${quote.id} добавлена ✅`);
    loadQuotes().catch(() => {});
  } catch (e) { toast(e.message, true); }
});

$('#quotes-refresh').addEventListener('click', async () => {
  try { await loadQuotes(); toast('Список цитат обновлён'); }
  catch (e) { toast(e.message, true); }
});

$('#quotes-body').addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-id]');
  if (!row || !e.target.classList.contains('q-del')) return;
  const id = Number(row.dataset.id);
  if (!confirm(`Удалить цитату #${id}?`)) return;
  try {
    await api(`/api/quotes?id=${id}`, { method: 'DELETE' });
    toast(`Цитата #${id} удалена 🗑`);
    loadQuotes().catch(() => {});
  } catch (err) { toast(err.message, true); }
});

// ---------------- фан-команды (вкладка «🎭 Фан») ----------------

const RP_PRESETS = [
  { mode: 'text', name: 'обнять', d: '{user} крепко обнимает {target} 🤗' },
  { mode: 'text', name: 'поцеловать', d: '{user} чмокает {target} в щёчку 😘' },
  { mode: 'text', name: 'погладить', d: '{user} гладит {target} по голове 🫶' },
  { mode: 'text', name: 'накормить', d: '{user} угощает {target} пельмешками 🥟' },
  { mode: 'text', name: 'уложить', d: '{user} кутает {target} в пледик: всё, спать! 😴' },
  { mode: 'text', name: 'ударить', d: '{user} отвесила {target} лёгкий подзатыльник 💢' },
  {
    mode: 'roll', name: 'хорни', roll: [0, 100], fallback: '{user} хорни на {roll}% 🤔',
    ranges: [
      [0, 10, '{user} хорни на {roll}% — вы почти не хорни 😌'],
      [11, 39, '{user} хорни на {roll}% — уже хорни 🙈'],
      [40, 60, '{user} хорни на {roll}% — очень хорни 😳'],
      [61, 89, '{user} хорни на {roll}% — срочно остудитесь 🧊'],
      [90, 99, '{user} хорни на {roll}% — СРОЧНО остудитесь 🧊🥵'],
      [100, 100, '{user} хорни на 100% — вы слишком хорни 🔥'],
    ],
  },
  {
    mode: 'roll', name: 'совместимость', roll: [0, 100], fallback: '{user} и {target} совместимы на {roll}% 🤷',
    ranges: [
      [0, 20, '{user} и {target} совместимы на {roll}% — нет химии 💔'],
      [21, 50, '{user} и {target} совместимы на {roll}% — есть искра ✨'],
      [51, 80, '{user} и {target} совместимы на {roll}% — любовь-морковь 💘'],
      [81, 100, '{user} и {target} совместимы на {roll}% — созданы друг для друга 💍'],
    ],
  },
  { mode: 'variants', name: 'шар', d: 'шар говорит: да 🔮|шар говорит: нет ❌|шар говорит: определённо 💯|шар говорит: спроси позже 🤷' },
];

function rangeRowHTML(r = {}) {
  return `
    <div class="rr">
      <input class="rr-from" type="number" min="0" max="1000000" value="${r.from ?? 0}" title="число от" />
      <span class="hint">—</span>
      <input class="rr-to" type="number" min="0" max="1000000" value="${r.to ?? 0}" title="число до" />
      <input class="rr-text" value="${esc(r.text || '')}" maxlength="480" placeholder="ответ (можно {roll}, {user}, {target})" />
      <button class="act ghost rr-del" title="убрать диапазон">✕</button>
    </div>`;
}

function variantRowHTML(v = '') {
  return `
    <div class="vr">
      <input class="f-variant" value="${esc(v)}" maxlength="480" placeholder="вариант ответа — можно {user}, {target}, {random:1-100}" />
      <button class="act ghost v-del" title="убрать вариант">✕</button>
    </div>`;
}

/** Варианты: построчный редактор, свёрнутый в одну строку «вариантов: N» — разворачивается для правки. */
function variantsListHTML(c) {
  const list = c?.variants || [];
  const preview = list.length
    ? `${esc(String(list[0]).slice(0, 60))}${list[0].length > 60 || list.length > 1 ? '…' : ''}`
    : 'пусто';
  const extra = list.length > 1 ? ` <span class="hint">и ещё ${list.length - 1}</span>` : '';
  return `
    <details class="rp-sub">
      <summary>🎲 вариантов: ${list.length} — ${preview}${extra}</summary>
      <div class="f-variants-list">
        ${list.map((v) => variantRowHTML(v)).join('')}
        <button class="act ghost v-add">+ вариант</button>
      </div>
    </details>`;
}

// добавить/убрать вариант — работает в таблице, в фан-меню и в форме создания (делегирование)
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('v-del')) {
    e.target.closest('.vr')?.remove();
    return;
  }
  if (e.target.classList.contains('v-add')) {
    const list = e.target.closest('.f-variants-list');
    if (!list) return;
    e.target.insertAdjacentHTML('beforebegin', variantRowHTML(''));
    const rows = list.querySelectorAll('.vr input.f-variant');
    rows[rows.length - 1]?.focus();
  }
});

/** Собрать варианты из построчного редактора. */
function collectVariants(root) {
  return [...(root?.querySelectorAll('.f-variant') ?? [])].map((i) => i.value.trim()).filter(Boolean);
}

function fanModeFieldsHTML(c, mode) {
  if (mode === 'variants') {
    return `<label class="hint">варианты — по одному в строке, бот выбирает случайно</label>
      ${variantsListHTML(c)}`;
  }
  if (mode === 'roll') {
    const ranges = (c.ranges || []).map((r) => rangeRowHTML(r)).join('') || '<p class="hint">диапазонов пока нет — жми «+ диапазон» (пример: 1 — «почти не хорни», 40-50 — «очень хорни»)</p>';
    return `
      <div class="rp-row">
        <label class="hint">число от <input class="f-min" type="number" min="0" max="1000000" value="${c.rollMin ?? 0}" /></label>
        <label class="hint">до <input class="f-max" type="number" min="0" max="1000000" value="${c.rollMax ?? 100}" /></label>
        <span class="hint">в текстах доступна переменная <code>{roll}</code> — выпавшее число</span>
      </div>
      <label class="hint">ответы по диапазонам чисел</label>
      <div class="rp-ranges" data-ranges>${ranges}
        <button class="act ghost f-range-add">+ диапазон</button>
      </div>
      <label class="hint">числа вне диапазонов → <input class="f-response" value="${esc(c.response || '')}" maxlength="480" placeholder="текст-заглушка (можно {roll})" /></label>`;
  }
  return `<label class="hint">текст ответа</label>
    <input class="f-response" value="${esc(c.response || '')}" maxlength="480" placeholder="{user} обнимает {target} 🤗" />`;
}

function fanItemHTML(c) {
  const mode = cmdMode(c);
  return `
  <details class="rp-item" data-name="${esc(c.name)}">
    <summary>
      <code>!${esc(c.name)}</code>
      <span class="chip" title="${esc(MODE_RU[mode])}">${MODE_ICON[mode]} ${MODE_RU[mode]}</span>
      ${c.needsTarget ? '<span class="chip">🎯 нужен @ник</span>' : ''}
      <span class="hint">${c.count || 0}×</span>
    </summary>
    <div class="rp-config">
      <div class="rp-row">
        <label class="hint">режим
          <select class="f-mode">${Object.entries(MODE_RU).map(([v, l]) => `<option value="${v}"${mode === v ? ' selected' : ''}>${MODE_ICON[v]} ${l}</option>`).join('')}</select>
        </label>
        <label class="hint"><input class="f-target" type="checkbox" ${c.needsTarget ? 'checked' : ''} /> 🎯 нужен @ник</label>
        <label class="hint">шанс % <input class="f-chance" type="number" min="0" max="100" value="${c.chance ?? 100}" title="0 — молчит всегда, 100 — отвечает всегда" /></label>
        <label class="hint">кулдаун, сек <input class="f-cooldown" type="number" min="0" max="3600" value="${c.cooldown ?? 0}" /></label>
        <label class="hint">доступ ${accessBtnHTML('custom', c.name, c.level, c.allow)}</label>
        <label class="hint"><input class="f-enabled" type="checkbox" ${c.enabled !== false ? 'checked' : ''} /> вкл</label>
      </div>
      <div class="f-mode-fields">${fanModeFieldsHTML(c, mode)}</div>
      <div class="rp-row">
        <button class="act f-test" title="написать сейчас в канал из «Быстрых действий» (при шансе <100 может молчать)">Тест</button>
        <button class="act f-save">💾 Сохранить</button>
        <button class="act ghost f-del">🗑 Удалить</button>
      </div>
    </div>
  </details>`;
}

function renderFanCommands(custom) {
  const fun = custom.filter(isFun);
  $('#fan-list').innerHTML = fun.map((c) => fanItemHTML(c)).join('') || '<p class="hint">Фан-команд нет — создай выше или ткни готовый шаблон 👇</p>';
  $('#fan-presets').innerHTML = RP_PRESETS.map((p, i) =>
    `<span class="chip preset" data-preset="${i}" title="${esc(p.d || p.fallback || '')}">${MODE_ICON[p.mode]} !${esc(p.name)}</span>`
  ).join('');
}

$('#cmds-body').addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-name]');
  if (!row) return;
  const name = row.dataset.name;
  if (e.target.classList.contains('cmd-del')) {
    if (!confirm(`Удалить команду !${name}?`)) return;
    try {
      await api(`/api/commands?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast(`Команда !${name} удалена`);
      loadCommands();
    } catch (err) { toast(err.message, true); }
  }
  if (e.target.classList.contains('cmd-save')) {
    const orig = __cmdCache.find((c) => c.name === name) ?? { name };
    const mode = cmdMode(orig);
    // сохраняем поверх исходника: режимы/диапазоны/таргет не теряются
    const accessBtn = row.querySelector('.apicker-btn');
    const body = {
      ...orig,
      level: accessBtn?.dataset.level || orig.level || 'everyone',
      allow: (accessBtn?.dataset.allow || '').split(',').map((s) => s.trim()).filter(Boolean),
      cooldown: Number(row.querySelector('.f-cooldown').value || 0),
      enabled: row.querySelector('.f-enabled').checked,
    };
    if (mode === 'variants') {
      body.variants = collectVariants(row);
    }
    if (row.querySelector('.f-response')) body.response = row.querySelector('.f-response').value;
    try {
      await api('/api/commands', { method: 'PUT', body: JSON.stringify(body) });
      toast(`Команда !${name} сохранена`);
      loadCommands();
    } catch (err) { toast(err.message, true); }
  }
});

$('#add-btn').addEventListener('click', async () => {
  const body = {
    name: $('#add-name').value,
    mode: 'text',
    response: $('#add-content').value,
    level: $('#add-level').value,
    cooldown: Number($('#add-cooldown').value || 0),
    enabled: true,
  };
  try {
    await api('/api/commands', { method: 'PUT', body: JSON.stringify(body) });
    $('#add-name').value = '';
    $('#add-content').value = '';
    toast('Команда добавлена ✅');
    loadCommands();
  } catch (e) { toast(e.message, true); }
});

// --- обработчики фан-студии ---

// смена режима внутри меню — пересобрать поля, сохранив раскрытость
$('#fan-list').addEventListener('change', (e) => {
  const item = e.target.closest('.rp-item[data-name]');
  if (!item || !e.target.classList.contains('f-mode')) return;
  const cmd = __cmdCache.find((c) => c.name === item.dataset.name);
  if (!cmd) return;
  const wasOpen = item.open;
  item.outerHTML = fanItemHTML({ ...cmd, mode: e.target.value });
  const fresh = document.querySelector(`#fan-list .rp-item[data-name="${cmd.name}"]`);
  if (fresh) fresh.open = wasOpen;
});

$('#fan-list').addEventListener('click', async (e) => {
  const item = e.target.closest('.rp-item[data-name]');
  if (!item) return;
  const name = item.dataset.name;
  const orig = __cmdCache.find((c) => c.name === name) ?? { name };
  if (e.target.classList.contains('rr-del')) { e.target.closest('.rr')?.remove(); return; }
  if (e.target.classList.contains('f-range-add')) {
    item.querySelector('[data-ranges]')?.insertAdjacentHTML('beforeend', rangeRowHTML({}));
    return;
  }
  if (e.target.classList.contains('f-del')) {
    if (!confirm(`Удалить команду !${name}?`)) return;
    try {
      await api(`/api/commands?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast(`Команда !${name} удалена`);
      loadCommands();
    } catch (err) { toast(err.message, true); }
    return;
  }
  if (e.target.classList.contains('f-test')) {
    try {
      await api('/api/actions/cmdtest', { method: 'POST', body: JSON.stringify({ name, channel: qaChannel() }) });
      toast('Отправлено — глянь чат');
    } catch (err) { toast(err.message, true); }
    return;
  }
  if (e.target.classList.contains('f-save')) {
    const mode = item.querySelector('.f-mode')?.value || cmdMode(orig);
    const accessBtn = item.querySelector('.apicker-btn');
    const body = {
      ...orig,
      name,
      mode,
      needsTarget: item.querySelector('.f-target').checked,
      chance: Number(item.querySelector('.f-chance').value ?? 100),
      cooldown: Number(item.querySelector('.f-cooldown').value || 0),
      level: accessBtn?.dataset.level || orig.level || 'everyone',
      allow: (accessBtn?.dataset.allow || '').split(',').map((s) => s.trim()).filter(Boolean),
      enabled: item.querySelector('.f-enabled').checked,
    };
    if (mode === 'variants') {
      body.variants = collectVariants(item);
    } else if (mode === 'roll') {
      body.rollMin = Number(item.querySelector('.f-min').value ?? 0);
      body.rollMax = Number(item.querySelector('.f-max').value ?? 100);
      body.ranges = [...item.querySelectorAll('.rr')].map((rr) => ({
        from: Number(rr.querySelector('.rr-from').value || 0),
        to: Number(rr.querySelector('.rr-to').value || 0),
        text: rr.querySelector('.rr-text').value.trim(),
      })).filter((r) => r.text);
      body.response = item.querySelector('.f-response').value;
    } else {
      body.response = item.querySelector('.f-response').value;
    }
    try {
      await api('/api/commands', { method: 'PUT', body: JSON.stringify(body) });
      toast(`!${name} сохранена ✅`);
      loadCommands();
    } catch (err) { toast(err.message, true); }
  }
});

// форма создания фан-команды
$('#fan-add-mode').addEventListener('change', () => {
  const mode = $('#fan-add-mode').value;
  $('#fan-add-min').classList.toggle('hidden', mode !== 'roll');
  $('#fan-add-max').classList.toggle('hidden', mode !== 'roll');
  $('#fan-add-text').classList.toggle('hidden', mode === 'variants');
  $('#fan-add-variants').classList.toggle('hidden', mode !== 'variants');
  if (mode === 'variants' && !$('#fan-add-variants .f-variant')) {
    $('#fan-add-variants .f-variants-list').insertAdjacentHTML('afterbegin', variantRowHTML(''));
  }
  const ph = { text: 'текст ответа — например: {user} обнимает {target} 🤗', roll: 'числа вне диапазонов (можно {roll}) — сами диапазоны добавишь в меню' };
  $('#fan-add-text').placeholder = ph[mode] || ph.text;
});

$('#fan-add-btn').addEventListener('click', async () => {
  const mode = $('#fan-add-mode').value;
  const content = $('#fan-add-text').value;
  const body = {
    name: $('#fan-add-name').value,
    mode,
    needsTarget: $('#fan-add-target').checked,
    level: 'everyone',
    cooldown: 5,
    chance: 100,
    enabled: true,
  };
  if (mode === 'variants') {
    body.variants = collectVariants($('#fan-add-variants'));
    if (!body.variants.length) { toast('Добавь хотя бы один вариант (кнопка «+ вариант»)', true); return; }
  }
  else if (mode === 'roll') {
    body.rollMin = Number($('#fan-add-min').value ?? 0);
    body.rollMax = Number($('#fan-add-max').value ?? 100);
    body.response = content; // заглушка; диапазоны добавляются в меню
  } else body.response = content;
  try {
    await api('/api/commands', { method: 'PUT', body: JSON.stringify(body) });
    $('#fan-add-name').value = '';
    $('#fan-add-text').value = '';
    const vl = $('#fan-add-variants .f-variants-list');
    if (vl) {
      vl.querySelectorAll('.vr').forEach((r) => r.remove());
      vl.insertAdjacentHTML('afterbegin', variantRowHTML(''));
    }
    toast('Команда создана ✅ Раскрыл её в списке — донастрой');
    loadCommands();
    const fresh = document.querySelector(`#fan-list .rp-item[data-name="${String(body.name).toLowerCase().replace(/^!/, '')}"]`);
    if (fresh) fresh.open = true;
  } catch (e) { toast(e.message, true); }
});

$('#fan-presets').addEventListener('click', async (e) => {
  const chip = e.target.closest('.chip[data-preset]');
  if (!chip) return;
  const p = RP_PRESETS[Number(chip.dataset.preset)];
  try {
    const { custom } = await api('/api/commands');
    if (custom.some((c) => c.name === p.name)) {
      toast(`!${p.name} уже есть — правь её в списке`, true);
      return;
    }
    const body = { name: p.name, mode: p.mode, needsTarget: false, level: 'everyone', cooldown: 5, chance: 100, enabled: true };
    if (p.mode === 'text') body.response = p.d;
    else if (p.mode === 'variants') body.variants = p.d.split('|').map((s) => s.trim()).filter(Boolean);
    else {
      body.rollMin = p.roll[0];
      body.rollMax = p.roll[1];
      body.ranges = p.ranges.map(([from, to, text]) => ({ from, to, text }));
      body.response = p.fallback;
    }
    await api('/api/commands', { method: 'PUT', body: JSON.stringify(body) });
    toast(`!${p.name} добавлена ✅ Раскрой и правь под себя`);
    loadCommands();
  } catch (err) { toast(err.message, true); }
});

// ---------------- события ----------------

const KIND_RU = { follow: 'Новый фоллоу', raid: 'Рейд', sub: 'Новая подписка', resub: 'Продление подписки', subgift: 'Подаренная подписка' };

async function loadSettings() {
  const [st, media] = await Promise.all([api('/api/settings'), api('/api/media')]);
  window.__settings = st;
  __mediaFiles = media.files ?? [];
  const holder = $('#events-list');
  holder.innerHTML = '<div class="evcards"></div>';
  const cards = holder.firstChild;
  for (const [kind, cfg] of Object.entries(st.events)) {
    const a = st.alerts?.[kind] ?? {};
    const div = document.createElement('div');
    div.className = 'evcard';
    div.dataset.kind = kind;
    div.innerHTML = `
      <h3>${KIND_RU[kind] ?? kind}</h3>
      <input type="text" class="f-template" value="${esc(cfg.template)}" maxlength="400" />
      <label>режим
        <select class="f-mode">
          <option value="chat" ${cfg.mode === 'chat' ? 'selected' : ''}>текст бота</option>
          <option value="announce" ${cfg.mode === 'announce' ? 'selected' : ''}>анонс (${esc(cfg.color)})</option>
        </select>
      </label>
      <label>цвет анонса
        <select class="f-color">
          ${['purple', 'primary', 'blue', 'green', 'orange'].map((c) => `<option value="${c}" ${cfg.color === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
      </label>
      <label><input type="checkbox" class="f-pin" ${cfg.pin ? 'checked' : ''} /> закрепить на 20 минут (для режима «текст»)</label>
      <label><input type="checkbox" class="f-enabled" ${cfg.enabled ? 'checked' : ''} /> реакция включена</label>
      <button class="act ghost a-open" title="медиа, звук, громкость алерта на оверлее">${alertSummaryHTML(a, kind)}</button>
      <div class="row">
        <button class="act ev-save">Сохранить</button>
        <button class="act ghost ev-test" data-kind="${kind}">Тест чата</button>
      </div>
    `;
    cards.appendChild(div);
  }
  renderMediaFiles();
  $('#so-template').value = st.so?.template ?? '';
  renderAso();
  renderAutoPin();
  renderTimers();
  renderObs();
  renderRedemptions();
}

// однострочный статус алерта на кнопке карточки: клик = открыть модалку
function alertSummaryHTML(a = {}, kind = '') {
  const on = a.enabled !== false;
  const media = a.media ? `🎬 ${a.media}` : 'эмодзи';
  const sound = a.sound ? `🔊 ${a.sound}` : 'без звука';
  const dur = `${a.duration ?? 6}с`;
  return `⚙ Алерт — ${on ? `${media} · ${sound} · ${dur}` : 'выключен'}`;
}

// перечитать поля карточки и переписать текст кнопки «⚙ Алерт»
function refreshAlertSummary(card) {
  const btn = card.querySelector('.a-open');
  if (!btn) return;
  btn.innerHTML = alertSummaryHTML(window.__settings?.alerts?.[card.dataset.kind] ?? {}, card.dataset.kind);
}

// «＋ загрузить файл…» прямо в селектах медиа/звука (внутри модалки)
const ALERT_UPLOAD_ACCEPT = {
  media: 'video/mp4,video/webm,video/quicktime,video/ogg,image/gif,image/apng,image/png,image/webp,image/jpeg,image/svg+xml',
  sound: 'audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/flac',
};
async function alertPickAndUpload(kind) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = ALERT_UPLOAD_ACCEPT[kind] || '*/*';
  const file = await new Promise((resolve) => {
    inp.onchange = () => resolve(inp.files?.[0] ?? null);
    inp.click();
  });
  if (!file) return null;
  const r = await fetch(`/api/media/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  if (!__mediaFiles.includes(file.name)) __mediaFiles.push(file.name);
  __mediaFiles.sort();
  renderMediaFiles();
  toast(`«${file.name}» загружен ✅`);
  return file.name;
}

// ---------------- модалка «настройка алерта» ----------------

const AM_EMOJI = { follow: '💜', sub: '🎉', resub: '💖', subgift: '🎁', raid: '🚀' };
const AM_SUB = { follow: 'новый фолловер', sub: 'новая подписка', resub: 'продление подписки', subgift: 'подаренная подписка', raid: 'рейд на канал' };
const amModal = $('#alert-modal');
let amKind = null;
let amPreviewSound = false; // звук видео в превью: переживает перерисовки, сбрасывается при открытии модалки

function amSelOptions(kind, cur, empty) {
  const list = __mediaFiles.filter((f) => (kind === 'media' ? VISUAL_EXT : AUDIO_EXT).includes(fileExt(f)));
  return [`<option value="">${empty}</option>`,
    ...list.map((f) => `<option value="${esc(f)}" ${cur === f ? 'selected' : ''}>${esc(f)}</option>`),
    '<option value="__upload__">＋ загрузить файл…</option>'].join('');
}

function openAlertModal(kind) {
  amKind = kind;
  amPreviewSound = false; // звук превью по умолчанию выключен
  const a = window.__settings?.alerts?.[kind] ?? {};
  $('#am-title').textContent = `📺 Алерт — ${KIND_RU[kind] ?? kind}`;
  $('#am-enabled').checked = a.enabled !== false;
  $('#am-template').value = a.template || '';
  $('#am-media').innerHTML = amSelOptions('media', a.media || '', '— без медиа (эмодзи) —');
  $('#am-sound').innerHTML = amSelOptions('sound', a.sound || '', '— без звука —');
  $('#am-volume').value = a.soundVolume ?? 85;
  $('#am-volume-val').textContent = String(a.soundVolume ?? 85);
  $('#am-duration').value = a.duration ?? 6;
  amUpdatePreview();
  amModal.classList.remove('hidden');
}

function closeAlertModal() {
  amModal.classList.add('hidden');
  amKind = null;
  amModal.querySelector('video')?.pause?.();
}

// живое превью плашки — как она выглядит в оверлее
function amUpdatePreview() {
  const box = $('#am-preview');
  const kind = amKind || 'follow';
  const enabled = $('#am-enabled').checked;
  if (!enabled) {
    box.innerHTML = '<span class="hint">алерт выключен — на оверлее ничего не покажется</span>';
    return;
  }
  const media = $('#am-media').value;
  let mediaHTML = `<div class="am-emoji">${AM_EMOJI[kind] || '✨'}</div>`;
  if (media) {
    const src = `/media/${encodeURIComponent(media)}`;
    if (fileExt(media) && ['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(fileExt(media))) {
      mediaHTML = `<div class="am-media"><video src="${src}" autoplay loop muted playsinline></video></div>`;
    } else if (!AUDIO_EXT.includes(fileExt(media))) {
      mediaHTML = `<div class="am-media"><img src="${src}" alt=""></div>`;
    }
  }
  const text = $('#am-template').value || 'текст плашки…';
  const isVideo = media && ['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(fileExt(media));
  box.innerHTML = `<div class="am-alert am-k-${kind}">${mediaHTML}
    <div class="am-text">${esc(text)}<small>${AM_SUB[kind] || ''}</small></div></div>
    ${isVideo ? `<button class="act ghost am-hear-btn">${amPreviewSound ? '🔇 выключить звук' : '🔊 включить звук превью'}</button>` : ''}`;
  amApplyPreviewSound();
}

// применить состояние звука превью к текущему видео + кнопке
function amApplyPreviewSound() {
  const vid = $('#am-preview video');
  if (vid) {
    vid.muted = !amPreviewSound;
    if (amPreviewSound) vid.volume = Math.max(0.001, Math.min(1, Number($('#am-volume').value) / 100));
    vid.title = 'клик — включить/выключить звук';
    vid.style.cursor = 'pointer';
  }
}

function amTogglePreviewSound() {
  amPreviewSound = !amPreviewSound;
  amApplyPreviewSound();
  const btn = $('#am-preview .am-hear-btn');
  if (btn) btn.textContent = amPreviewSound ? '🔇 выключить звук' : '🔊 включить звук превью';
}

// клик по кнопке «🔊 включить звук превью» или по самому видео — звук с выбранной громкостью
$('#am-preview').addEventListener('click', (e) => {
  if (e.target.closest('.am-hear-btn') || e.target.tagName === 'VIDEO') amTogglePreviewSound();
});

// громкость меняется — если звук превью уже включён, подтягиваем сразу
$('#am-volume').addEventListener('input', () => {
  $('#am-volume-val').textContent = $('#am-volume').value;
  if (amPreviewSound) amApplyPreviewSound();
});

function amRefreshCard() {
  const card = document.querySelector(`#events-list .evcard[data-kind="${amKind}"]`);
  if (card) refreshAlertSummary(card);
}

$('#events-list').addEventListener('click', (e) => {
  if (e.target.closest('.a-open')) openAlertModal(e.target.closest('.evcard')?.dataset.kind);
});

// живое обновление превью при правке любого поля
['am-enabled', 'am-template', 'am-media', 'am-sound', 'am-duration'].forEach((id) => {
  $('#' + id).addEventListener('change', () => {
    // «＋ загрузить файл…»: выбираем файл, грузим, подставляем в селект
    if ((id === 'am-media' || id === 'am-sound') && $('#' + id).value === '__upload__') {
      const sel = $('#' + id);
      sel.value = '';
      const field = id === 'am-media' ? 'media' : 'sound';
      alertPickAndUpload(field)
        .then((name) => {
          if (!name) return;
          if (![...sel.options].some((o) => o.value === name)) {
            sel.querySelector('option[value="__upload__"]').insertAdjacentHTML('beforebegin', `<option value="${esc(name)}">${esc(name)}</option>`);
          }
          sel.value = name;
          amUpdatePreview();
        })
        .catch((err) => toast(err.message, true));
      return;
    }
    amUpdatePreview();
  });
});
$('#am-template').addEventListener('input', amUpdatePreview);
$('#am-play').addEventListener('click', () => {
  const name = $('#am-sound').value;
  if (!name) { toast('Сначала выбери звук (или загрузи — «＋ загрузить файл…»)', true); return; }
  try {
    const a = new Audio(`/media/${encodeURIComponent(name)}?t=${Date.now()}`);
    a.volume = Math.max(0, Math.min(1, Number($('#am-volume').value) / 100)) || 0.001;
    a.play().catch(() => toast('Браузер не дал проиграть — ткни ещё раз', true));
  } catch { /* ничего страшного */ }
});

$('#am-save').addEventListener('click', async () => {
  if (!amKind) return;
  const alert = {
    enabled: $('#am-enabled').checked,
    template: $('#am-template').value,
    media: $('#am-media').value,
    sound: $('#am-sound').value,
    soundVolume: Math.max(0, Math.min(100, Number($('#am-volume').value) || 0)),
    duration: Math.max(2, Math.min(20, Number($('#am-duration').value) || 6)),
  };
  try {
    const s = await putSettings({ alerts: { [amKind]: alert } });
    amRefreshCard();
    closeAlertModal();
    toast('Алерт сохранён ✅');
  } catch (err) { toast(err.message, true); }
});

$('#am-test').addEventListener('click', async () => {
  if (!amKind) return;
  try {
    await api('/api/actions/overlaytest', { method: 'POST', body: JSON.stringify({ kind: amKind }) });
    toast('Алерт отправлен — смотри оверлей (страница должна быть открыта)');
  } catch (err) { toast(err.message, true); }
});

$('#am-close').addEventListener('click', closeAlertModal);
amModal.addEventListener('click', (e) => { if (e.target === amModal) closeAlertModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !amModal.classList.contains('hidden')) closeAlertModal(); });

$('#events-list').addEventListener('click', async (e) => {
  const card = e.target.closest('.evcard');
  if (!card) return;
  const kind = card.dataset.kind;
  if (e.target.classList.contains('ev-save')) {
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          events: {
            [kind]: {
              template: card.querySelector('.f-template').value,
              mode: card.querySelector('.f-mode').value,
              color: card.querySelector('.f-color').value,
              pin: card.querySelector('.f-pin').checked,
              enabled: card.querySelector('.f-enabled').checked,
            },
          },
          // алерты настраиваются в модалке (кнопка «⚙ Алерт») — туда их и сохраняем
        }),
      });
      toast('Событие сохранено ✅');
    } catch (err) { toast(err.message, true); }
  }
  if (e.target.classList.contains('ev-test')) {
    try {
      await api('/api/actions/test', { method: 'POST', body: JSON.stringify({ kind, channel: qaChannel() }) });
      toast('Тест отправлен в чат — смотри ленту событий');
    } catch (err) { toast(err.message, true); }
  }
});

$('#so-save').addEventListener('click', async () => {
  try {
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ so: { template: $('#so-template').value } }),
    });
    toast('Шаблон шатаута сохранён ✅');
  } catch (e) { toast(e.message, true); }
});

// ---------------- OBS (obs-websocket 5) ----------------

function renderObs() {
  const o = window.__settings?.obs;
  if (!o) return;
  $('#obs-enabled').checked = Boolean(o.enabled);
  $('#obs-host').value = o.host ?? '127.0.0.1';
  $('#obs-port').value = o.port ?? 4455;
  $('#obs-password').value = '';
  $('#obs-result').textContent = '';
}

$('#obs-save').addEventListener('click', async () => {
  const host = String($('#obs-host').value).trim();
  const port = Number($('#obs-port').value);
  if (!host) { toast('Укажи хост OBS (обычно 127.0.0.1)', true); return; }
  if (!Number.isInteger(port) || port < 1 || port > 65535) { toast('Порт OBS — целое число 1–65535', true); return; }
  const obs = { enabled: $('#obs-enabled').checked, host, port };
  if ($('#obs-password').value) obs.password = $('#obs-password').value; // пустое поле — не затираем сохранённый пароль
  try {
    await putSettings({ obs });
    renderObs();
    toast('Настройки OBS сохранены ✅');
  } catch (e) { toast(e.message, true); }
});

$('#obs-test').addEventListener('click', async () => {
  const btn = $('#obs-test');
  const out = $('#obs-result');
  btn.disabled = true;
  out.textContent = 'Проверяю связь с OBS…';
  try {
    const body = { host: String($('#obs-host').value).trim(), port: Number($('#obs-port').value) || 4455 };
    if ($('#obs-password').value) body.password = $('#obs-password').value;
    const r = await api('/api/actions/obstest', { method: 'POST', body: JSON.stringify(body) });
    const scenes = Array.isArray(r.scenes) ? r.scenes.join(', ') : '—';
    out.textContent = `✅ OBS на связи${r.current ? ` — сейчас сцена: ${r.current}` : ''}. Сцены: ${scenes}`;
  } catch (e) {
    out.textContent = `❌ ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ---------------- автошатауты ----------------

function renderAso() {
  const a = window.__settings?.autoShoutouts;
  if (!a) return;
  $('#aso-enabled').checked = Boolean(a.enabled);
  $('#aso-cooldown').value = a.cooldownMinutes ?? 240;
  $('#aso-default').value = a.defaultTemplate ?? '';
  const body = $('#aso-body');
  body.innerHTML = (a.users ?? []).map((u) => `
    <tr data-login="${esc(u.login)}">
      <td class="cellname"><b>@${esc(u.login)}</b></td>
      <td class="cellresp"><input class="aso-text" value="${esc(u.text || '')}" maxlength="400" /></td>
      <td>
        <button class="act aso-test" title="проверить прямо сейчас">Тест</button>
        <button class="act aso-save-row" title="сохранить текст">💾</button>
        <button class="act ghost aso-del" title="убрать из списка">🗑</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="3" class="hint">Список пуст — добавь стримеров ниже</td></tr>';
}

function currentAsoUsers() {
  return (window.__settings?.autoShoutouts?.users ?? []).map((u) => ({ ...u }));
}

async function putSettings(patch) {
  const st = await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
  window.__settings = st;
  renderAso();
  renderAutoPin();
  renderTimers();
  renderRedemptions();
  return st; // важно: модалка алерта и другие вызовы кладут это в window.__settings
}

$('#aso-save').addEventListener('click', async () => {
  try {
    await putSettings({
      autoShoutouts: {
        enabled: $('#aso-enabled').checked,
        cooldownMinutes: Number($('#aso-cooldown').value) || 240,
        defaultTemplate: $('#aso-default').value,
      },
    });
    toast('Автошатауты сохранены ✅');
  } catch (e) { toast(e.message, true); }
});

$('#aso-add-btn').addEventListener('click', async () => {
  const login = $('#aso-add-login').value.trim().replace(/^@/, '').toLowerCase();
  if (!login) return;
  const users = currentAsoUsers();
  if (users.some((u) => u.login === login)) { toast('Уже в списке', true); return; }
  if (users.length >= 50) { toast('Максимум 50 человек', true); return; }
  users.push({ login, text: $('#aso-add-text').value.trim() });
  try {
    await putSettings({ autoShoutouts: { users } });
    $('#aso-add-login').value = '';
    $('#aso-add-text').value = '';
    toast('Стример добавлен ✅');
  } catch (e) { toast(e.message, true); }
});

$('#aso-body').addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-login]');
  if (!row) return;
  const login = row.dataset.login;
  try {
    if (e.target.classList.contains('aso-del')) {
      if (!confirm(`Убрать @${login} из автошатаутов?`)) return;
      await putSettings({ autoShoutouts: { users: currentAsoUsers().filter((u) => u.login !== login) } });
      toast('Убрано 🗑');
    } else if (e.target.classList.contains('aso-save-row')) {
      const text = row.querySelector('.aso-text').value;
      const users = currentAsoUsers().map((u) => (u.login === login ? { ...u, text } : u));
      await putSettings({ autoShoutouts: { users } });
      toast('Текст сохранён ✅');
    } else if (e.target.classList.contains('aso-test')) {
      await api('/api/actions/autosotest', { method: 'POST', body: JSON.stringify({ login, channel: qaChannel() }) });
      toast('Тест: шатаут отправлен (если лимиты Twitch сейчас позволяют)');
    }
  } catch (err) { toast(err.message, true); }
});

// ---------------- автозакреп ----------------

function renderAutoPin() {
  const ap = window.__settings?.autoPin;
  if (!ap) return;
  $('#ap-enabled').checked = Boolean(ap.enabled);
  $('#ap-mode').value = ap.mode ?? 'stream';
  $('#ap-template').value = ap.template ?? '';
}

$('#ap-save').addEventListener('click', async () => {
  try {
    await putSettings({
      autoPin: {
        enabled: $('#ap-enabled').checked,
        mode: $('#ap-mode').value,
        template: $('#ap-template').value,
      },
    });
    toast('Автозакреп сохранён ✅');
  } catch (e) { toast(e.message, true); }
});

$('#ap-test').addEventListener('click', async () => {
  try {
    await api('/api/actions/autopintest', { method: 'POST', body: JSON.stringify({ channel: qaChannel() }) });
    toast('Отправлено и закреплено — глянь чат 📌');
  } catch (e) { toast(e.message, true); }
});

// ---------------- таймеры (периодические сообщения) ----------------

const TIMER_MODES = [
  ['time', 'по времени'],
  ['messages', 'по сообщениям'],
  ['and', 'и время, и сообщения'],
  ['or', 'или время, или сообщения'],
];

function renderTimers() {
  const t = window.__settings?.timers;
  if (!t) return;
  $('#t-enabled').checked = Boolean(t.enabled);
  $('#t-onlylive').checked = t.onlyWhenLive !== false;
  const body = $('#t-body');
  body.innerHTML = (t.items ?? []).map((x) => `
    <tr data-id="${esc(x.id)}">
      <td class="cellname"><input class="t-name" value="${esc(x.name || '')}" maxlength="40" /></td>
      <td class="cellresp"><input class="t-text" value="${esc(x.text || '')}" maxlength="400" /></td>
      <td class="cellcd"><input class="t-interval" type="number" min="1" max="720" value="${x.intervalMinutes ?? 15}" title="минут между выходами" /></td>
      <td class="cellcd"><input class="t-minmsg" type="number" min="1" max="1000" value="${x.minMessages ?? 5}" title="сколько сообщений в чате ждать" /></td>
      <td class="cellmode"><select class="t-mode">${TIMER_MODES.map(([v, l]) => `<option value="${v}"${(x.mode || 'time') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
      <td class="cellon"><input class="t-enabled" type="checkbox" ${x.enabled !== false ? 'checked' : ''} /></td>
      <td>
        <button class="act t-test" title="написать сейчас в выбранный канал">Тест</button>
        <button class="act t-save-row" title="сохранить">💾</button>
        <button class="act ghost t-del" title="удалить">🗑</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="7" class="hint">Таймеров нет — добавь первый ниже</td></tr>';
}

function currentTimers() {
  return (window.__settings?.timers?.items ?? []).map((x) => ({ ...x }));
}

$('#t-save').addEventListener('click', async () => {
  try {
    await putSettings({
      timers: {
        enabled: $('#t-enabled').checked,
        onlyWhenLive: $('#t-onlylive').checked,
      },
    });
    toast('Таймеры сохранены ✅');
  } catch (e) { toast(e.message, true); }
});

$('#t-add-btn').addEventListener('click', async () => {
  const text = $('#t-add-text').value.trim();
  if (!text) { toast('Нужен текст сообщения', true); return; }
  const items = currentTimers();
  if (items.length >= 30) { toast('Максимум 30 таймеров', true); return; }
  items.push({
    id: crypto.randomUUID?.() ?? `t${Date.now()}`,
    name: $('#t-add-name').value.trim(),
    text,
    intervalMinutes: Number($('#t-add-interval').value) || 15,
    minMessages: Number($('#t-add-minmsg').value) || 5,
    mode: $('#t-add-mode').value,
    enabled: true,
  });
  try {
    await putSettings({ timers: { items } });
    $('#t-add-name').value = '';
    $('#t-add-text').value = '';
    toast('Таймер добавлен ✅ Первый выход — через указанный интервал');
  } catch (e) { toast(e.message, true); }
});

$('#t-body').addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-id]');
  if (!row) return;
  const id = row.dataset.id;
  try {
    if (e.target.classList.contains('t-del')) {
      if (!confirm('Удалить этот таймер?')) return;
      await putSettings({ timers: { items: currentTimers().filter((x) => x.id !== id) } });
      toast('Таймер удалён 🗑');
    } else if (e.target.classList.contains('t-save-row')) {
      const items = currentTimers().map((x) => (x.id === id ? {
        ...x,
        name: row.querySelector('.t-name').value,
        text: row.querySelector('.t-text').value,
        intervalMinutes: Number(row.querySelector('.t-interval').value) || 5,
        minMessages: Number(row.querySelector('.t-minmsg').value) || 5,
        mode: row.querySelector('.t-mode').value,
        enabled: row.querySelector('.t-enabled').checked,
      } : x));
      await putSettings({ timers: { items } });
      toast('Таймер сохранён ✅');
    } else if (e.target.classList.contains('t-test')) {
      await api('/api/actions/timertest', { method: 'POST', body: JSON.stringify({ id, channel: qaChannel() }) });
      toast('Отправлено в выбранный канал — глянь чат');
    }
  } catch (err) { toast(err.message, true); }
});

// ---------------- награды канала (Channel Points) ----------------

const RW_ACTIONS = [
  ['song', '🎵 песня'],
  ['meme', '🎬 мем'],
  ['wheel', '🎡 колесо'],
  ['say', '🗣 TTS'],
  ['command', '⌨️ команда'],
];

function renderRedemptions() {
  const st = window.__settings?.redemptions;
  if (!st) return;
  $('#rw-cooldown').value = st.cooldown ?? 30;
  $('#rw-enabled').checked = st.enabled !== false;
  $('#rw-body').innerHTML = (st.mappings ?? []).map((m) => `
    <tr class="rw-row" data-action="${esc(m.action ?? 'song')}">
      <td class="cellresp"><input class="rw-name" value="${esc(m.rewardName ?? '')}" maxlength="100" placeholder="как награда называется на Twitch" /></td>
      <td class="cellmode"><select class="rw-action">${RW_ACTIONS.map(([v, l]) => `<option value="${v}"${m.action === v ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
      <td class="cellon"><input class="rw-enabled" type="checkbox" ${m.enabled !== false ? 'checked' : ''} /></td>
      <td><button class="act ghost rw-del" title="убрать награду">🗑</button></td>
    </tr>`).join('') || '<tr><td colspan="4" class="hint">наград нет — добавь ниже (название должно совпадать с наградой на Twitch)</td></tr>';
}

function collectRedemptions() {
  const mappings = [...document.querySelectorAll('#rw-body .rw-row')].map((row) => ({
    rewardName: row.querySelector('.rw-name').value.trim(),
    action: row.querySelector('.rw-action').value,
    enabled: row.querySelector('.rw-enabled').checked,
  })).filter((m) => m.rewardName);
  return {
    enabled: $('#rw-enabled').checked,
    cooldown: Number($('#rw-cooldown').value) || 30,
    mappings,
  };
}

$('#rw-save').addEventListener('click', async () => {
  try {
    await putSettings({ redemptions: collectRedemptions() });
    renderRedemptions();
    toast('Награды канала сохранены ✅');
  } catch (e) { toast(e.message, true); }
});

$('#rw-add').addEventListener('click', () => {
  $('#rw-body').insertAdjacentHTML('beforeend', `
    <tr class="rw-row">
      <td class="cellresp"><input class="rw-name" placeholder="${esc($('#rw-add-name').value.trim() || 'заказать песню')}" maxlength="100" /></td>
      <td class="cellmode"><select class="rw-action">${RW_ACTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></td>
      <td class="cellon"><input class="rw-enabled" type="checkbox" checked /></td>
      <td><button class="act ghost rw-del">🗑</button></td>
    </tr>`);
  $('#rw-add-name').value = '';
});

$('#rw-body').addEventListener('click', (e) => {
  if (e.target.classList.contains('rw-del')) e.target.closest('tr')?.remove();
});

$('#rw-add-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#rw-add').click();
});

$('#rw-test').addEventListener('click', async () => {
  try {
    await api('/api/actions/redemptiontest', { method: 'POST', body: '{}' });
    toast('Тестовая награда отправлена — смотри оверлей (страница должна быть открыта)');
  } catch (e) { toast(e.message, true); }
});

$('#broadcaster-logout').addEventListener('click', async () => {
  if (!confirm('Сбросить токен стримера? Бот перестанет видеть списания наград.')) return;
  try {
    await api('/api/broadcaster/logout', { method: 'POST' });
    toast('Токен стримера сброшен');
    poll();
  } catch (e) { toast(e.message, true); }
});

$('#redirect-uri-broadcaster')?.addEventListener('click', (e) => {
  navigator.clipboard?.writeText(e.target.textContent).then(() => toast('Redirect URL скопирован'));
});

// ---------------- оверлей (глобальные настройки) ----------------
// алерты КОНКРЕТНЫХ событий настраиваются в их карточках: вкладка «События»

let __mediaFiles = [];
// разделение файлов по типу: для колонок «Звук» и «Медиа»
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'flac'];
const VISUAL_EXT = ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'gif', 'apng', 'png', 'webp', 'jpg', 'jpeg', 'svg'];
const fileExt = (n) => String(n || '').split('.').pop().toLowerCase();
const fileKind = (n) => {
  const e = fileExt(n);
  if (AUDIO_EXT.includes(e)) return 'звук';
  if (VISUAL_EXT.includes(e)) return 'медиа';
  return 'файл';
};

// семафор: вкладка Оверлей отрисовала актуальные настройки сервера.
// До этого «Сохранить» держим заблокированным — иначе соберём алерты из
// пустого DOM и молча выключим все алерты и TTS (панель свежая, бот перезапускался).
let __overlayLoaded = false;

async function loadOverlaySettings() {
  const [st, media] = await Promise.all([api('/api/settings'), api('/api/media')]);
  const a = st.alerts ?? {};
  window.__settings = st; // свежие значения по умолчанию для TTS-голоса (не DOM-дефолт)
  __mediaFiles = media.files ?? [];
  $('#ov-url').value = `${location.origin}/overlay`;
  $('#ov-open').href = `${location.origin}/overlay?test=follow`;
  $('#ov-enabled').checked = Boolean(a.enabled);
  $('#ov-eventlist').checked = Boolean(a.eventList?.enabled);
  renderMediaFiles();
  // TTS-блок «🔊 Озвучка»
  const tts = a.tts ?? {};
  $('#tts-enabled').checked = Boolean(tts.enabled);
  $('#tts-rate').value = tts.rate ?? 1;
  $('#tts-volume').value = tts.volume ?? 1;
  fillTtsVoices(String(tts.voiceName ?? ''));
  __overlayLoaded = true; // настройки отрисованы — теперь можно собирать и слать
}

// списочек файлов алертов: чипы с типом и кнопкой удаления
function renderMediaFiles() {
  const box = $('#media-files');
  if (!box) return;
  box.innerHTML = __mediaFiles.map((f) =>
    `<span class="chip">${esc(f)} · ${fileKind(f)} <button class="act ghost m-del" data-name="${esc(f)}" title="удалить файл">✕</button></span>`
  ).join('') || '<span class="hint">Пока пусто — загрузи первый файл выше или кинь в папку overlay-media/</span>';
}

$('#media-files').addEventListener('click', async (e) => {
  const btn = e.target.closest('.m-del');
  if (!btn) return;
  const name = btn.dataset.name;
  if (!confirm(`Удалить файл «${name}»?`)) return;
  try {
    await api(`/api/media?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    toast(`Файл «${name}» удалён`);
    loadSettings(); // перерисовать карточки событий (селекты медиа/звука) и чипы файлов
  } catch (err) { toast(err.message, true); }
});

$('#media-upload').addEventListener('click', async () => {
  const input = $('#media-file');
  const file = input?.files?.[0];
  if (!file) { toast('Сначала выбери файл', true); return; }
  $('#media-up-hint').textContent = 'загружаю…';
  try {
    const r = await fetch(`/api/media/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    input.value = '';
    $('#media-up-hint').textContent = '';
    toast(`«${file.name}» загружен ✅`);
    loadSettings(); // перерисовать карточки событий (селекты медиа/звука) и чипы файлов
  } catch (err) {
    $('#media-up-hint').textContent = '';
    toast(err.message, true);
  }
});

// список голосов берём из браузера панели (Web Speech API), русские — первыми
function ttsVoices() {
  try { return window.speechSynthesis?.getVoices?.() ?? []; } catch { return []; }
}

// сохранённый в настройках голос — единственный источник правды для дефолта,
// DOM-дефолт (пустая опция «— по умолчанию —») значение не затирает
function storedTtsVoice() {
  try { return String(window.__settings?.alerts?.tts?.voiceName ?? ''); } catch { return ''; }
}

function fillTtsVoices(selected = '') {
  const sel = $('#tts-voice');
  if (!sel) return;
  // значением по умолчанию всегда — сохранённое из настроек, а не DOM-дефолт
  const want = String(selected || storedTtsVoice());
  const voices = ttsVoices();
  const hint = $('#tts-hint');
  const opt = (v) => `<option value="${esc(v.name)}" ${v.name === want ? 'selected' : ''}>${esc(v.name)}</option>`;
  let html = '<option value="">— по умолчанию (первый русский) —</option>';
  if (voices.length) {
    const ru = voices.filter((v) => /^ru/i.test(String(v.lang || '')));
    const other = voices.filter((v) => !/^ru/i.test(String(v.lang || '')));
    html += (ru.length ? `<optgroup label="Русские">${ru.map(opt).join('')}</optgroup>` : '')
      + (other.length ? `<optgroup label="Остальные">${other.map(opt).join('')}</optgroup>` : '');
    if (hint) hint.textContent = '';
  } else if (hint) {
    hint.textContent = 'speechSynthesis' in window ? 'голоса ещё грузятся — обновится само…' : 'браузер не поддерживает синтез речи';
  }
  // фантом: текущее имя из настроек держим в списке ВСЕГДА (и при пустом списке),
  // иначе первый «Сохранить» ушёл бы с voiceName:'' и настройка молча потерялась
  if (want && !voices.some((v) => v.name === want)) {
    html += `<option value="${esc(want)}" selected>текущий: ${esc(want)} (нет в этом браузере)</option>`;
  }
  sel.innerHTML = html;
}

if ('speechSynthesis' in window) {
  // при поздней загрузке списка: выбранное пользователем в DOM — сохраняем,
  // иначе берём сохранённое из настроек (никогда — пустой DOM-дефолт)
  speechSynthesis.addEventListener?.('voiceschanged', () => fillTtsVoices($('#tts-voice')?.value || storedTtsVoice()));
}

$('#ov-copy').addEventListener('click', async () => {
  const v = $('#ov-url').value;
  try { await navigator.clipboard.writeText(v); toast('Скопировано ✅'); }
  catch { $('#ov-url').select(); toast('Выделила поле — Ctrl+C', true); }
});

// сбор ГЛОБАЛЬНОЙ части alerts (общий выключатель + TTS): один PUT на кнопках
// вкладки «Оверлей». Алерты конкретных событий сохраняются их карточками
// на вкладке «События». Пока настройки вкладки не загружены — null: не шлём
// ничего (иначе молча выключились бы ВСЕ алерты).
function collectAlerts() {
  if (!__overlayLoaded) return null;
  const alerts = { enabled: $('#ov-enabled').checked };
  const rate = Number($('#tts-rate').value);
  const volume = Number($('#tts-volume').value);
  alerts.tts = {
    enabled: $('#tts-enabled').checked,
    rate: Number.isFinite(rate) ? rate : 1,
    volume: Number.isFinite(volume) ? volume : 1, // 0 (тихо) валиден — не подменяем единицей
    voiceName: $('#tts-voice').value,
  };
  // список событий (Event List): size живёт своей жизнью, панель шлёт только enabled
  alerts.eventList = { enabled: $('#ov-eventlist').checked };
  return alerts;
}

$('#ov-save').addEventListener('click', async () => {
  const alerts = collectAlerts();
  if (!alerts) { toast('Настройки алертов ещё не загрузились — секунду…', true); return; }
  try {
    await putSettings({ alerts });
    toast('Алерты сохранены ✅');
  } catch (e) { toast(e.message, true); }
});

$('#tts-save').addEventListener('click', async () => {
  const alerts = collectAlerts();
  if (!alerts) { toast('Настройки ещё не загрузились — секунду…', true); return; }
  try {
    await putSettings({ alerts });
    toast('Озвучка сохранена ✅');
  } catch (e) { toast(e.message, true); }
});

// произнести тестовую фразу локально, без запроса к серверу
$('#tts-test').addEventListener('click', () => {
  if (!('speechSynthesis' in window)) { toast('Этот браузер не умеет синтез речи', true); return; }
  try {
    const u = new SpeechSynthesisUtterance('Тест озвучки: Няшка оформила подписку на канал!');
    const name = $('#tts-voice').value;
    const v = (name ? ttsVoices().find((x) => x.name === name) : ttsVoices().find((x) => /^ru/i.test(String(x.lang || '')))) || null;
    if (v) { u.voice = v; u.lang = v.lang || 'ru-RU'; }
    const rate = Number($('#tts-rate').value);
    const volume = Number($('#tts-volume').value);
    u.rate = Number.isFinite(rate) ? Math.max(0.5, Math.min(2, rate)) : 1;
    u.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
    speechSynthesis.cancel(); // повторное нажатие не копит проверки
    speechSynthesis.speak(u);
  } catch { toast('Не удалось произнести — синтез речи недоступен', true); }
});

// ---------------- музыка (заказы YouTube) ----------------

async function loadSongsTab() {
  const st = await api('/api/songs');
  const s = (await api('/api/settings')).songs ?? {};
  $('#music-url').textContent = `${location.origin}/music`;
  $('#music-url-field').value = `${location.origin}/music`;
  $('#music-open').href = `${location.origin}/music`;
  $('#sg-enabled').checked = Boolean(s.enabled);
  $('#sg-maxlen').value = s.maxLenSec ?? 600;
  $('#sg-peruser').value = s.perUser ?? 2;
  $('#sg-volume').value = s.volume ?? 60;
  $('#sg-template').value = s.nowTemplate ?? '♪ {title} — заказал {by}';
  $('#sg-current').innerHTML = st.current
    ? `▶ <b>${esc(st.current.title)}</b> — заказал ${esc(st.current.byName || st.current.by)}${st.paused ? ' · <b>на паузе</b>' : ''}`
    : 'Ничего не играет';
  $('#sg-body').innerHTML = (st.queue ?? []).map((song, i) => `
    <tr data-index="${i}">
      <td>${i + 1}</td>
      <td class="cellresp">${esc(song.title)}</td>
      <td class="cellname">${esc(song.byName || song.by)}</td>
      <td><button class="act ghost sg-remove" title="убрать из очереди">🗑</button></td>
    </tr>`).join('') || '<tr><td colspan="4" class="hint">Очередь пуста</td></tr>';
}

$('#music-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#music-url-field').value); toast('Скопировано ✅'); }
  catch { $('#music-url-field').select(); toast('Выделила поле — Ctrl+C', true); }
});

$('#sg-save').addEventListener('click', async () => {
  try {
    await putSettings({
      songs: {
        enabled: $('#sg-enabled').checked,
        maxLenSec: Number($('#sg-maxlen').value) || 600,
        perUser: Number($('#sg-peruser').value) || 2,
        volume: Number($('#sg-volume').value) || 60,
        nowTemplate: $('#sg-template').value,
      },
    });
    toast('Настройки музыки сохранены ✅');
  } catch (e) { toast(e.message, true); }
});

$('#sg-skip').addEventListener('click', async () => {
  try { await api('/api/actions/srnext', { method: 'POST', body: '{}' }); toast('Трек скипнут ⏭'); loadSongsTab(); }
  catch (e) { toast(e.message, true); }
});

$('#sg-pause').addEventListener('click', () => api('/api/actions/srcontrol', { method: 'POST', body: JSON.stringify({ op: 'pause' }) }).then(() => loadSongsTab()).catch((e) => toast(e.message, true)));
$('#sg-resume').addEventListener('click', () => api('/api/actions/srcontrol', { method: 'POST', body: JSON.stringify({ op: 'resume' }) }).then(() => loadSongsTab()).catch((e) => toast(e.message, true)));
$('#sg-stop').addEventListener('click', () => {
  if (!confirm('Остановить музыку и очистить очередь?')) return;
  api('/api/actions/srcontrol', { method: 'POST', body: JSON.stringify({ op: 'stop' }) }).then(() => loadSongsTab()).catch((e) => toast(e.message, true));
});
$('#sg-refresh').addEventListener('click', () => loadSongsTab().catch(() => {}));

$('#sg-body').addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-index]');
  if (!row || !e.target.classList.contains('sg-remove')) return;
  try {
    await api('/api/songs', { method: 'POST', body: JSON.stringify({ op: 'remove', index: Number(row.dataset.index) }) });
    toast('Убрано из очереди');
    loadSongsTab();
  } catch (err) { toast(err.message, true); }
});

// ---------------- прокси (под-вкладка в Настройках) ----------------

async function loadProxySettings() {
  const p = (await api('/api/settings')).proxy ?? {};
  $('#proxy-enabled').checked = Boolean(p.enabled);
  $('#proxy-url').value = p.url ?? '';
}

$('#proxy-save').addEventListener('click', async () => {
  try {
    await putSettings({
      proxy: { enabled: $('#proxy-enabled').checked, url: $('#proxy-url').value.trim() },
    });
    toast('Прокси сохранён ✅');
  } catch (e) { toast(e.message, true); }
});

$('#proxy-test').addEventListener('click', async () => {
  toast('Проверяю связь…');
  try {
    const r = await api('/api/actions/proxytest', { method: 'POST', body: '{}' });
    toast(`✅ ${r.via} — YouTube доступен («${r.sample}»)`);
  } catch (e) { toast(`❌ ${e.message}`, true); }
});

// ---------------- модули ----------------

async function loadModules() {
  const { modules } = await api('/api/modules');
  $('#modules-count').textContent = modules.length ? `модулей: ${modules.length}` : 'модулей нет';
  const box = $('#modules-list');
  box.innerHTML = modules.map((m) => {
    const settingsRows = Object.entries(m.settings ?? {}).map(([k, v]) => {
      if (typeof v === 'boolean') {
        return `<label class="hint"><input class="m-set" data-key="${esc(k)}" type="checkbox" ${v ? 'checked' : ''} /> ${esc(k)}</label>`;
      }
      return `<label class="hint">${esc(k)} <input class="m-set" data-key="${esc(k)}" type="${typeof v === 'number' ? 'number' : 'text'}" value="${esc(String(v))}" style="width:170px" /></label>`;
    }).join('') || '<p class="hint">настроек нет — модуль может объявить их в поле settings</p>';
    return `
    <details class="rp-item" data-name="${esc(m.name)}">
      <summary>
        <code>${esc(m.name)}</code>
        ${m.error ? '<span class="chip">💥 не загрузился</span>' : `<span class="chip">${m.enabled ? '✅ вкл' : '⏸ выкл'}</span>`}
        <span class="hint">${esc(m.description || '')}</span>
      </summary>
      <div class="rp-config">
        ${m.error ? `<p class="hint">💥 ${esc(m.error)}</p>` : `
        <div class="rp-row">
          <label class="hint"><input class="m-enabled" type="checkbox" ${m.enabled ? 'checked' : ''} /> включен</label>
        </div>
        <label class="hint">команды: ${m.commands.map((c) => `<code>!${esc(c)}</code>`).join(' ') || '—'}</label>
        <label class="hint">события: ${m.hooks.map((h) => `<code>${esc(h)}</code>`).join(' ') || '—'}</label>
        <label class="hint">настройки (хранятся в data/modules.json)</label>
        <div class="rp-row">${settingsRows}</div>
        <div class="rp-row">
          <button class="act m-save">💾 Сохранить настройки</button>
        </div>`}
      </div>
    </details>`;
  }).join('') || '<p class="hint">Модулей нет. Кинь .js-файл в папку modules/ (формат — в README) или правь example.js.</p>';
}

$('#modules-reload').addEventListener('click', async () => {
  try {
    await api('/api/actions/modulesreload', { method: 'POST', body: '{}' });
    toast('Модули перечитаны ✅');
    loadModules();
  } catch (e) { toast(e.message, true); }
});

$('#modules-list').addEventListener('change', async (e) => {
  const item = e.target.closest('.rp-item[data-name]');
  if (!item || !e.target.classList.contains('m-enabled')) return;
  try {
    await api('/api/modules', { method: 'PUT', body: JSON.stringify({ name: item.dataset.name, enabled: e.target.checked }) });
    toast(`Модуль ${e.target.checked ? 'включён' : 'выключен'}`);
    loadModules();
  } catch (err) { toast(err.message, true); }
});

$('#modules-list').addEventListener('click', async (e) => {
  const item = e.target.closest('.rp-item[data-name]');
  if (!item || !e.target.classList.contains('m-save')) return;
  const settings = {};
  item.querySelectorAll('.m-set').forEach((inp) => {
    settings[inp.dataset.key] = inp.type === 'checkbox' ? inp.checked : (inp.type === 'number' ? Number(inp.value) : inp.value);
  });
  try {
    await api('/api/modules', { method: 'PUT', body: JSON.stringify({ name: item.dataset.name, settings }) });
    toast('Настройки модуля сохранены ✅');
    loadModules();
  } catch (err) { toast(err.message, true); }
});

// ---------------- настройки ----------------

$('#cfg-save').addEventListener('click', async () => {
  const body = {
    clientId: $('#cfg-client-id').value.trim(),
    port: Number($('#cfg-port').value) || undefined,
  };
  const secret = $('#cfg-client-secret').value.trim();
  if (secret) body.clientSecret = secret;
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
    settingsFormTouched = false; // поля снова можно синхронизировать с сервером
    $('#cfg-client-secret').value = '';
    toast('Настройки сохранены ✅ Теперь войди как бот, если ещё не');
    poll();
  } catch (e) { toast(e.message, true); }
});

$('#auth-logout').addEventListener('click', async () => {
  if (!confirm('Сбросить токен бота? Нужно будет войти заново.')) return;
  try {
    await api('/api/logout', { method: 'POST' });
    toast('Токен сброшен');
    poll();
  } catch (e) { toast(e.message, true); }
});

// ---------------- быстрые действия ----------------

document.addEventListener('click', async (e) => {
  const actBtn = e.target.closest('[data-act]');
  const testBtn = e.target.closest('[data-test]');
  if (!actBtn && !testBtn) return;

  if (testBtn) {
    try {
      await api('/api/actions/test', { method: 'POST', body: JSON.stringify({ kind: testBtn.dataset.test, channel: qaChannel() }) });
      toast('Тестовое событие отправлено — смотри чат');
    } catch (err) { toast(err.message, true); }
    return;
  }

  const act = actBtn.dataset.act;
  try {
    if (act === 'say') {
      const text = $('#qa-say').value.trim();
      if (!text) return;
      await api('/api/actions/say', { method: 'POST', body: JSON.stringify({ text, channel: qaChannel() }) });
      $('#qa-say').value = '';
      toast('Отправлено ✅');
    } else if (act === 'announce') {
      const text = $('#qa-announce').value.trim();
      if (!text) return;
      await api('/api/actions/announce', { method: 'POST', body: JSON.stringify({ text, color: $('#qa-announce-color').value, channel: qaChannel() }) });
      $('#qa-announce').value = '';
      toast('Анонс отправлен ✅');
    } else if (act === 'pin') {
      const text = $('#qa-pin').value.trim();
      if (!text) return;
      await api('/api/actions/pin', { method: 'POST', body: JSON.stringify({ text, duration: Number($('#qa-pin-duration').value), channel: qaChannel() }) });
      $('#qa-pin').value = '';
      toast('Закреплено 📌');
    } else if (act === 'unpin') {
      await api('/api/actions/unpin', { method: 'POST', body: JSON.stringify({ channel: qaChannel() }) });
      toast('Закреп снят');
    } else if (act === 'so') {
      const target = $('#qa-so').value.trim();
      if (!target) return;
      await api('/api/actions/so', { method: 'POST', body: JSON.stringify({ target, channel: qaChannel() }) });
      $('#qa-so').value = '';
      toast('Шатаут отправлен 📣');
    }
  } catch (err) { toast(err.message, true); }
});

$('#redirect-uri').addEventListener('click', (e) => {
  navigator.clipboard?.writeText(e.target.textContent).then(() => toast('Redirect URL скопирован'));
});

// ---------------- запуск ----------------

handleHash();
loadCommands().catch(() => {});
loadSettings().catch(() => {});
loadModules().catch(() => {});
loadOverlaySettings().catch(() => {});
loadSongsTab().catch(() => {});
loadProxySettings().catch(() => {});
loadQuotes().catch(() => {});
poll();
setInterval(poll, 2000);
