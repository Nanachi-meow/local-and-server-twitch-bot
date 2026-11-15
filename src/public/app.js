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
  if (hash.startsWith('#ok')) {
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

  $('#redirect-uri').textContent = `http://localhost:${st.port}/auth/callback`;

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
const MODE_RU = { text: 'один ответ', variants: 'несколько вариантов', roll: 'рандом-число' };
const MODE_ICON = { text: '💬', variants: '🎲', roll: '#️⃣' };
const cmdMode = (c) => c.mode || (c.type === 'random' ? 'variants' : 'text');
const isFun = (c) => cmdMode(c) !== 'text' || Boolean(c.needsTarget) || c.type === 'rp';
let __cmdCache = [];

async function loadCommands() {
  const { custom, builtins } = await api('/api/commands');
  __cmdCache = custom;
  const body = $('#cmds-body');
  body.innerHTML = custom.map((c) => {
    const mode = cmdMode(c);
    const variants = (c.variants || []).join(' | ');
    const contentCell = mode === 'variants'
      ? `<input class="f-variants" value="${esc(variants)}" maxlength="480" title="варианты через |" />`
      : `<input class="f-response" value="${esc(c.response || '')}" maxlength="480" title="${mode === 'roll' ? 'текст для чисел вне диапазонов' : 'текст ответа'}" ${mode === 'roll' ? 'placeholder="числа вне диапазонов (можно {roll})"' : ''} />`;
    return `
    <tr data-name="${esc(c.name)}">
      <td class="cellname"><code>!${esc(c.name)}</code> <span class="hint">${c.count || 0}×</span></td>
      <td class="celltype"><span class="chip" title="${esc(MODE_RU[mode])}">${MODE_ICON[mode]} ${MODE_RU[mode]}</span>${c.needsTarget ? '<span class="chip">🎯 @ник</span>' : ''}</td>
      <td class="cellresp">${contentCell}${mode === 'roll' ? `<div class="hint">от ${c.rollMin ?? 0} до ${c.rollMax ?? 100}, диапазонов: ${(c.ranges || []).length} — настраивается во вкладке 🎭 Фан</div>` : ''}</td>
      <td class="celllevel">
        <select class="f-level">
          ${['everyone', 'sub', 'vip', 'mod'].map((l) => `<option value="${l}" ${c.level === l ? 'selected' : ''}>${LEVEL_RU[l]}</option>`).join('')}
        </select>
      </td>
      <td class="cellcd"><input class="f-cooldown" type="number" min="0" max="3600" value="${c.cooldown ?? 0}" /></td>
      <td class="cellon"><input class="f-enabled" type="checkbox" ${c.enabled !== false ? 'checked' : ''} /></td>
      <td>
        <button class="act cmd-save">💾</button>
        <button class="act ghost cmd-del">🗑</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="hint">Пока нет кастомных команд — добавь первую!</td></tr>';

  $('#builtins').innerHTML = builtins.map((b) =>
    `<span class="chip" title="${esc(b.label)}">${esc(b.name)} · ${LEVEL_RU[b.level] ?? b.level} · ${esc(b.label)}</span>`
  ).join('');

  renderFanCommands(custom);
}

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

function fanModeFieldsHTML(c, mode) {
  if (mode === 'variants') {
    return `<label class="hint">варианты — по одному на строку (бот выбирает случайно)</label>
      <textarea class="f-variants" rows="4" maxlength="2000" placeholder="шар говорит: да 🔮&#10;шар говорит: нет ❌">${esc((c.variants || []).join('\n'))}</textarea>`;
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
        <label class="hint">доступ
          <select class="f-level">${['everyone', 'sub', 'vip', 'mod'].map((l) => `<option value="${l}" ${c.level === l ? 'selected' : ''}>${LEVEL_RU[l]}</option>`).join('')}</select>
        </label>
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
    const body = {
      ...orig,
      level: row.querySelector('.f-level').value,
      cooldown: Number(row.querySelector('.f-cooldown').value || 0),
      enabled: row.querySelector('.f-enabled').checked,
    };
    if (mode === 'variants' && row.querySelector('.f-variants')) {
      body.variants = row.querySelector('.f-variants').value.split('|').map((s) => s.trim()).filter(Boolean);
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
    const body = {
      ...orig,
      name,
      mode,
      needsTarget: item.querySelector('.f-target').checked,
      chance: Number(item.querySelector('.f-chance').value ?? 100),
      cooldown: Number(item.querySelector('.f-cooldown').value || 0),
      level: item.querySelector('.f-level').value,
      enabled: item.querySelector('.f-enabled').checked,
    };
    if (mode === 'variants') {
      body.variants = item.querySelector('.f-variants').value.split('\n').map((s) => s.trim()).filter(Boolean);
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
  const ph = { text: 'текст ответа — например: {user} обнимает {target} 🤗', variants: 'варианты через | — например: да 🔮 | нет ❌', roll: 'числа вне диапазонов (можно {roll}) — сами диапазоны добавишь в меню' };
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
  if (mode === 'variants') body.variants = content.split('|').map((s) => s.trim()).filter(Boolean);
  else if (mode === 'roll') {
    body.rollMin = Number($('#fan-add-min').value ?? 0);
    body.rollMax = Number($('#fan-add-max').value ?? 100);
    body.response = content; // заглушка; диапазоны добавляются в меню
  } else body.response = content;
  try {
    await api('/api/commands', { method: 'PUT', body: JSON.stringify(body) });
    $('#fan-add-name').value = '';
    $('#fan-add-text').value = '';
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
  const st = await api('/api/settings');
  window.__settings = st;
  const holder = $('#events-list');
  holder.innerHTML = '<div class="evcards"></div>';
  const cards = holder.firstChild;
  for (const [kind, cfg] of Object.entries(st.events)) {
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
      <div class="row">
        <button class="act ev-save">Сохранить</button>
        <button class="act ghost ev-test" data-kind="${kind}">Тест</button>
      </div>
    `;
    cards.appendChild(div);
  }
  $('#so-template').value = st.so?.template ?? '';
  renderAso();
  renderAutoPin();
  renderTimers();
}

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
        }),
      });
      toast('Шаблон сохранён ✅');
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

// ---------------- баллы ----------------

let __mediaList = [];

async function loadPointsTab() {
  const [pts, st, media] = await Promise.all([api('/api/points'), api('/api/settings'), api('/api/media')]);
  __mediaList = media.files ?? [];
  const p = st.points ?? {};
  $('#pts-enabled').checked = Boolean(p.enabled);
  $('#pts-interval').value = p.intervalMin ?? 10;
  $('#pts-amount').value = p.amount ?? 10;
  $('#pts-permsg').value = p.perMessage ?? 1;

  $('#pts-top').innerHTML = (pts.top ?? []).map((r, i) => `
    <tr><td>${i + 1}</td><td class="cellname">${esc(r.name || r.login)}</td>
    <td>${r.points} 💎</td><td>${r.watchedMin ?? 0}</td></tr>`).join('')
    || '<tr><td colspan="4" class="hint">Пока никто не накопил — баллы капают, когда ты стримишь и идёт чат</td></tr>';

  // колесо
  const w = st.wheel ?? {};
  $('#wh-enabled').checked = Boolean(w.enabled);
  $('#wh-min').value = w.minBet ?? 10;
  $('#wh-max').value = w.maxBet ?? 1000;
  $('#wh-cd').value = w.cooldown ?? 60;
  $('#wh-body').innerHTML = (w.items ?? []).map((it) => `
    <tr class="wh-row">
      <td class="cellresp"><input class="wh-label" value="${esc(it.label)}" maxlength="60" /></td>
      <td class="cellcd"><input class="wh-weight" type="number" min="0" max="100" step="0.5" value="${it.weight}" /></td>
      <td class="cellcd"><input class="wh-mult" type="number" min="0" max="100" step="0.5" value="${it.multiplier}" /></td>
      <td><button class="act ghost wh-del">🗑</button></td>
    </tr>`).join('') || '<tr><td colspan="4" class="hint">вариантов нет — добавь ниже</td></tr>';

  // мем-магазин
  const m = st.memShop ?? {};
  $('#ms-enabled').checked = Boolean(m.enabled);
  const soundOpts = (files) => ['<option value="">— без звука —</option>',
    ...(files ?? []).map((f) => `<option value="${esc(f)}">${esc(f)}</option>`)].join('');
  $('#ms-body').innerHTML = (m.items ?? []).map((it) => `
    <tr class="ms-row">
      <td class="cellname"><input class="ms-name" value="${esc(it.name)}" maxlength="32" /></td>
      <td class="cellresp"><input class="ms-text" value="${esc(it.text || '')}" maxlength="200" /></td>
      <td class="cellcd"><input class="ms-price" type="number" min="0" value="${it.price ?? 100}" /></td>
      <td class="cellcd"><select class="ms-sound">${soundOpts(__mediaList)}</select></td>
      <td class="cellon"><input class="ms-enabled" type="checkbox" ${it.enabled !== false ? 'checked' : ''} /></td>
      <td><button class="act ghost ms-del">🗑</button></td>
    </tr>`).join('') || '<tr><td colspan="6" class="hint">мемов нет — добавь ниже</td></tr>';
  // выбранные звуки подставим после рендера
  document.querySelectorAll('#ms-body .ms-row').forEach((row, i) => {
    const sel = row.querySelector('.ms-sound');
    sel.value = (m.items ?? [])[i]?.sound || '';
  });
}

$('#pts-refresh').addEventListener('click', () => loadPointsTab().catch(() => {}));

$('#pts-save').addEventListener('click', async () => {
  try {
    await putSettings({
      points: {
        enabled: $('#pts-enabled').checked,
        intervalMin: Number($('#pts-interval').value) || 10,
        amount: Number($('#pts-amount').value) || 10,
        perMessage: Number($('#pts-permsg').value) || 0,
      },
    });
    toast('Баллы сохранены ✅');
  } catch (e) { toast(e.message, true); }
});

function collectWheel() {
  const items = [...document.querySelectorAll('#wh-body .wh-row')].map((row) => ({
    label: row.querySelector('.wh-label').value,
    weight: Number(row.querySelector('.wh-weight').value) || 0,
    multiplier: Number(row.querySelector('.wh-mult').value) || 0,
  })).filter((it) => it.label.trim());
  return {
    enabled: $('#wh-enabled').checked,
    minBet: Number($('#wh-min').value) || 10,
    maxBet: Number($('#wh-max').value) || 1000,
    cooldown: Number($('#wh-cd').value) || 60,
    items,
  };
}

$('#wh-add').addEventListener('click', () => {
  $('#wh-body').insertAdjacentHTML('beforeend', `
    <tr class="wh-row">
      <td class="cellresp"><input class="wh-label" placeholder="💎 x50" maxlength="60" /></td>
      <td class="cellcd"><input class="wh-weight" type="number" min="0" max="100" step="0.5" value="1" /></td>
      <td class="cellcd"><input class="wh-mult" type="number" min="0" max="100" step="0.5" value="2" /></td>
      <td><button class="act ghost wh-del">🗑</button></td>
    </tr>`);
});

$('#wh-save').addEventListener('click', async () => {
  try {
    await putSettings({ wheel: collectWheel() });
    toast('Колесо сохранено ✅');
  } catch (e) { toast(e.message, true); }
});

$('#wh-body').addEventListener('click', (e) => {
  if (e.target.classList.contains('wh-del')) e.target.closest('tr')?.remove();
});

function collectMemShop() {
  const items = [...document.querySelectorAll('#ms-body .ms-row')].map((row) => ({
    name: row.querySelector('.ms-name').value,
    text: row.querySelector('.ms-text').value,
    price: Number(row.querySelector('.ms-price').value) || 0,
    sound: row.querySelector('.ms-sound').value,
    enabled: row.querySelector('.ms-enabled').checked,
  })).filter((it) => it.name.trim());
  return { enabled: $('#ms-enabled').checked, items };
}

$('#ms-add').addEventListener('click', () => {
  $('#ms-body').insertAdjacentHTML('beforeend', `
    <tr class="ms-row">
      <td class="cellname"><input class="ms-name" placeholder="мем" maxlength="32" /></td>
      <td class="cellresp"><input class="ms-text" placeholder="🎬 {user} запустил мемивую штуку!" maxlength="200" /></td>
      <td class="cellcd"><input class="ms-price" type="number" min="0" value="100" /></td>
      <td class="cellcd"><select class="ms-sound">${'<option value="">— без звука —</option>' + __mediaList.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('')}</select></td>
      <td class="cellon"><input class="ms-enabled" type="checkbox" checked /></td>
      <td><button class="act ghost ms-del">🗑</button></td>
    </tr>`);
});

$('#ms-save').addEventListener('click', async () => {
  try {
    await putSettings({ memShop: collectMemShop() });
    toast('Мем-магазин сохранён ✅');
  } catch (e) { toast(e.message, true); }
});

$('#ms-body').addEventListener('click', (e) => {
  if (e.target.classList.contains('ms-del')) e.target.closest('tr')?.remove();
});

// ---------------- оверлей (алерты для OBS) ----------------

const OV_KINDS = [
  ['follow', '💜 Фоллоу'],
  ['sub', '🎉 Саб'],
  ['resub', '💖 Продление'],
  ['subgift', '🎁 Подарок'],
  ['raid', '🚀 Рейд'],
];

let __mediaFiles = [];

async function loadOverlaySettings() {
  const [st, media] = await Promise.all([api('/api/settings'), api('/api/media')]);
  const a = st.alerts ?? {};
  __mediaFiles = media.files ?? [];
  $('#ov-url').value = `${location.origin}/overlay`;
  $('#ov-open').href = `${location.origin}/overlay?test=follow`;
  $('#ov-enabled').checked = Boolean(a.enabled);
  const body = $('#ov-body');
  body.innerHTML = OV_KINDS.map(([kind, label]) => {
    const c = a[kind] ?? {};
    const soundOptions = ['<option value="">— без звука —</option>',
      ...__mediaFiles.map((f) => `<option value="${esc(f)}" ${c.sound === f ? 'selected' : ''}>${esc(f)}</option>`)].join('');
    return `
    <tr data-kind="${kind}">
      <td class="cellname">${label}</td>
      <td class="cellresp"><input class="o-template" value="${esc(c.template || '')}" maxlength="200" /></td>
      <td class="cellcd"><select class="o-sound">${soundOptions}</select></td>
      <td class="cellcd"><input class="o-duration" type="number" min="2" max="20" value="${c.duration ?? 5}" /></td>
      <td class="cellon"><input class="o-enabled" type="checkbox" ${c.enabled ? 'checked' : ''} /></td>
      <td><button class="act o-test" title="показать в открытом оверлее">Тест</button></td>
    </tr>`;
  }).join('');
  // TTS-блок «🔊 Озвучка»
  const tts = a.tts ?? {};
  $('#tts-enabled').checked = Boolean(tts.enabled);
  $('#tts-rate').value = tts.rate ?? 1;
  $('#tts-volume').value = tts.volume ?? 1;
  fillTtsVoices(String(tts.voiceName ?? ''));
}

// список голосов берём из браузера панели (Web Speech API), русские — первыми
function ttsVoices() {
  try { return window.speechSynthesis?.getVoices?.() ?? []; } catch { return []; }
}

function fillTtsVoices(selected = '') {
  const sel = $('#tts-voice');
  if (!sel) return;
  const voices = ttsVoices();
  const hint = $('#tts-hint');
  const opt = (v) => `<option value="${esc(v.name)}" ${v.name === selected ? 'selected' : ''}>${esc(v.name)}</option>`;
  let html = '<option value="">— по умолчанию (первый русский) —</option>';
  if (voices.length) {
    const ru = voices.filter((v) => /^ru/i.test(String(v.lang || '')));
    const other = voices.filter((v) => !/^ru/i.test(String(v.lang || '')));
    html += (ru.length ? `<optgroup label="Русские">${ru.map(opt).join('')}</optgroup>` : '')
      + (other.length ? `<optgroup label="Остальные">${other.map(opt).join('')}</optgroup>` : '');
    // голос сохранён из другого браузера — держим значение, чтобы не потерялся при сохранении
    if (selected && !voices.some((v) => v.name === selected)) {
      html += `<option value="${esc(selected)}" selected>${esc(selected)} (нет в этом браузере)</option>`;
    }
    if (hint) hint.textContent = '';
  } else if (hint) {
    hint.textContent = 'speechSynthesis' in window ? 'голоса ещё грузятся — обновится само…' : 'браузер не поддерживает синтез речи';
  }
  sel.innerHTML = html;
}

if ('speechSynthesis' in window) {
  speechSynthesis.addEventListener?.('voiceschanged', () => fillTtsVoices($('#tts-voice')?.value ?? ''));
}

$('#ov-copy').addEventListener('click', async () => {
  const v = $('#ov-url').value;
  try { await navigator.clipboard.writeText(v); toast('Скопировано ✅'); }
  catch { $('#ov-url').select(); toast('Выделила поле — Ctrl+C', true); }
});

// сбор alerts ЦЕЛИКОМ (события + TTS) — один PUT сохраняет и то, и другое
function collectAlerts() {
  const alerts = { enabled: $('#ov-enabled').checked };
  document.querySelectorAll('#ov-body tr[data-kind]').forEach((row) => {
    alerts[row.dataset.kind] = {
      enabled: row.querySelector('.o-enabled').checked,
      template: row.querySelector('.o-template').value,
      sound: row.querySelector('.o-sound').value,
      duration: Number(row.querySelector('.o-duration').value) || 5,
    };
  });
  const rate = Number($('#tts-rate').value);
  const volume = Number($('#tts-volume').value);
  alerts.tts = {
    enabled: $('#tts-enabled').checked,
    rate: Number.isFinite(rate) ? rate : 1,
    volume: Number.isFinite(volume) ? volume : 1, // 0 (тихо) валиден — не подменяем единицей
    voiceName: $('#tts-voice').value,
  };
  return alerts;
}

$('#ov-save').addEventListener('click', async () => {
  try {
    await putSettings({ alerts: collectAlerts() });
    toast('Алерты сохранены ✅');
  } catch (e) { toast(e.message, true); }
});

$('#tts-save').addEventListener('click', async () => {
  try {
    await putSettings({ alerts: collectAlerts() });
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

$('#ov-body').addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-kind]');
  if (!row || !e.target.classList.contains('o-test')) return;
  try {
    await api('/api/actions/overlaytest', { method: 'POST', body: JSON.stringify({ kind: row.dataset.kind }) });
    toast('Алерт отправлен — смотри оверлей (страница должна быть открыта)');
  } catch (err) { toast(err.message, true); }
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
loadPointsTab().catch(() => {});
poll();
setInterval(poll, 2000);
