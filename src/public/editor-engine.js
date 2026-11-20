/* ═══════════════════════════════════════════════════════════════════════════
 *  EditorEngine — обобщённый движок редактора раскладки.
 *  Архитектура 1:1 с редактора виджета музыки (плейер, вкладка «Музыка»):
 *    сцена 1920×1080 (k = width/1920), объекты {id,type,x,y,w,h,opacity,z},
 *    z-сортировка, одиночное/shift/рамка выделение, групповое перетаскивание
 *    (магнит считается по объекту, за который взялся; прилипание переносится
 *    всей группе), синий пунктир = ось сцены, оранжевый = центр/край соседа,
 *    ctrl+z/y история, ctrl+c/x/v буфер, слои, чипся объектов, панель свойств.
 *
 *  Виджет подключается КОНФИГОМ (см. templates/editor/README.md):
 *    EditorEngine.create({ stage, chips, props, objects, k, onChange,
 *      hotkeyGate, onDblclick, types: { <имя>: { label, render, props,
 *      bind, resize, handles, copyable } } })
 *
 *  Тип объекта:
 *    label       — подпись в чипсах
 *    render(o, div, api)  — наполнить div содержимым (заполняет только
 *                            внутренности; позицию/размер/прозрачность/грань
 *                            движок ставит сам, единообразно для всех)
 *    props(o) → html      — поля свойств (движок сам добавит группу-вариант)
 *    bind(o, api)          — повесить слушатели на поля из props
 *    resize(o, start, dx, dy) — как меняются w/h за уголок (по умолчанию +dx/+dy)
 *    handles: [{ selector, drag(o, api, ev) }] — свои хэндлы прямо в объекте
 *    copyable             — можно ли копировать/вырезать (default true)
 *  api для хуков: k, selected(), scenes(ev)->{sx,sy}, dx(ev), dy(ev),
 *    rerender(), refreshProps(), push(), pushThrottled(), changed(),
 *    hint(text) — бейдж-подсказка над объектом на время жеста
 * ═══════════════════════════════════════════════════════════════════════════ */
window.EditorEngine = (() => {
  const SNAP = 14; // зона магнита, px сцены

  function create(cfg) {
    const stage = cfg.stage;
    if (!stage) throw new Error('EditorEngine: нет stage');
    const types = cfg.types || {};
    const el = (sel) => document.querySelector(sel);
    const chipsEl = cfg.chips;
    const propsEl = cfg.props;

    // ---------- состояние ----------
    let objects = cfg.objects; // живой массив (владелец — виджет)
    let sel = -1;
    const selSet = new Set();
    let clipboard = [];
    let hint = null; // { x, y, text } — плашка-подсказка на жест

    // ---------- история ----------
    const hist = [];
    const redoStack = [];
    let lastPush = 0;
    function push() {
      hist.push(JSON.stringify(objects));
      if (hist.length > 60) hist.shift();
      redoStack.length = 0;
      lastPush = Date.now();
    }
    function pushThrottled() { if (Date.now() - lastPush > 600) push(); }
    function undo() {
      if (!hist.length) return false;
      redoStack.push(JSON.stringify(objects));
      const next = JSON.parse(hist.pop());
      objects.length = 0;
      objects.push(...next);
      selSet.clear();
      sel = -1;
      changed(); render(); renderProps();
      return true;
    }
    function redo() {
      if (!redoStack.length) return false;
      hist.push(JSON.stringify(objects));
      const next = JSON.parse(redoStack.pop());
      objects.length = 0;
      objects.push(...next);
      selSet.clear();
      sel = -1;
      changed(); render(); renderProps();
      return true;
    }

    function changed() { cfg.onChange?.(); }

    // ---------- рендер сцены ----------
    const k = () => cfg.k();

    function typeOf(o) { return types[o?.type] || null; }

    function render() {
      const kk = k();
      stage.innerHTML = '';
      const sorted = objects.map((o, i) => ({ o, i })).sort((a, b) => (a.o.z ?? 0) - (b.o.z ?? 0));
      for (const { o, i } of sorted) {
        const t = typeOf(o);
        const div = document.createElement('div');
        div.className = `plp-obj plp-${o.type}${selSet.has(i) ? ' sel' : ''}`;
        div.dataset.i = i;
        div.style.left = `${o.x * kk}px`;
        div.style.top = `${o.y * kk}px`;
        div.style.width = `${Math.max(4, o.w) * kk}px`;
        div.style.height = `${Math.max(4, o.h) * kk}px`;
        div.style.opacity = String(Math.max(0, Math.min(1, (o.opacity ?? 100) / 100)));
        if (o.borderWidth) div.style.border = `${o.borderWidth * kk}px solid ${o.borderColor || '#8b5cf6'}`;
        try { t?.render?.(o, div, api); } catch { /* виджетский рендер не должен ронять движок */ }
        if (selSet.size === 1 && i === sel && (t?.resizable ?? true)) {
          const h = document.createElement('div');
          h.className = 'plp-resize';
          div.appendChild(h);
        }
        stage.appendChild(div);
      }
      // подсказка над сценой (когда виджет её попросил)
      if (hint) {
        const hb = document.createElement('div');
        hb.className = 'wh-angle-badge';
        hb.textContent = hint.text;
        hb.style.left = `${hint.x * kk}px`;
        hb.style.top = `${hint.y * kk}px`;
        stage.appendChild(hb);
      }
    }

    function setHint(h) { hint = h; render(); }
    function clearHint() { if (hint) { hint = null; render(); } }

    // ---------- магнит ----------
    function targetsFor(excludeSet) {
      const others = objects.filter((_, j) => !excludeSet.has(j));
      const flatX = [{ pos: 960, kind: 'scene' }];
      const flatY = [{ pos: 540, kind: 'scene' }];
      for (const t of others) {
        flatX.push({ pos: t.x, kind: 'obj' }, { pos: t.x + t.w / 2, kind: 'obj' }, { pos: t.x + t.w, kind: 'obj' });
        flatY.push({ pos: t.y, kind: 'obj' }, { pos: t.y + t.h / 2, kind: 'obj' }, { pos: t.y + t.h, kind: 'obj' });
      }
      return { flatX, flatY };
    }
    function bestAnchor(anchors, targets) {
      let best = null;
      for (const a of anchors) for (const t of targets) {
        const d = t.pos - a;
        if (Math.abs(d) <= SNAP && (best === null || Math.abs(d) < Math.abs(best.shift))) best = { shift: d, target: t };
      }
      return best;
    }

    let guideV = null, guideH = null;
    function guides() {
      stage.querySelectorAll('.plp-guide').forEach((g) => g.remove());
      const kk = k();
      if (guideV) {
        const g = document.createElement('div');
        g.className = `plp-guide plp-guide-v ${guideV.kind === 'scene' ? 'plp-g-scene' : 'plp-g-obj'}`;
        g.style.left = `${guideV.pos * kk}px`;
        stage.appendChild(g);
      }
      if (guideH) {
        const g = document.createElement('div');
        g.className = `plp-guide plp-guide-h ${guideH.kind === 'scene' ? 'plp-g-scene' : 'plp-g-obj'}`;
        g.style.top = `${guideH.pos * kk}px`;
        stage.appendChild(g);
      }
    }
    function clearGuides() { guideV = guideH = null; stage.querySelectorAll('.plp-guide').forEach((g) => g.remove()); }

    // ---------- драг/ресайз/рамка/хэндлы ----------
    let mode = null; // 'move' | 'resize' | 'band' | 'custom'
    let idx = -1;
    let grabX = 0, grabY = 0;
    let starts = null;
    let band = null;
    let bandShift = false;
    let moved = false;
    let handle = null;

    const dxOf = (e) => (e.clientX - grabX) / k();
    const dyOf = (e) => (e.clientY - grabY) / k();
    const scene = (e) => {
      const r = stage.getBoundingClientRect();
      return { sx: (e.clientX - r.left) / k(), sy: (e.clientY - r.top) / k() };
    };

    stage.addEventListener('pointerdown', (e) => {
      if (cfg.hotkeyGate && !cfg.hotkeyGate()) { /* всё равно разрешаем мышку — горячие клавиши гейтятся отдельно */ }
      const objEl = e.target.closest('.plp-obj');
      grabX = e.clientX; grabY = e.clientY;
      moved = false;
      stage.setPointerCapture?.(e.pointerId);

      if (!objEl) {
        mode = 'band';
        bandShift = e.shiftKey;
        band = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
        clearGuides();
        e.preventDefault();
        return;
      }

      idx = Number(objEl.dataset.i);
      const o = objects[idx];
      const t = typeOf(o);
      sel = idx;
      if (e.shiftKey) {
        if (selSet.has(idx)) selSet.delete(idx);
        else selSet.add(idx);
      } else if (!selSet.has(idx)) {
        selSet.clear();
        selSet.add(idx);
      }
      if (!selSet.size) selSet.add(idx);

      // свои хэндлы типа (стрелки, ручки — всё, что виджет нарисовал в объекте)
      let hnd = null;
      for (const h of (t?.handles ?? [])) {
        if (e.target.closest(h.selector)) { hnd = h; break; }
      }
      const resizeHandle = e.target.closest('.plp-resize');

      push(); // снимок до жеста — для ctrl+z
      if (hnd) {
        mode = 'custom';
        handle = hnd;
        hnd.drag?.(o, api, e, 'start');
      } else if (resizeHandle && selSet.size === 1 && (t?.resizable ?? true)) {
        mode = 'resize';
      } else {
        mode = 'move';
      }
      starts = new Map();
      for (const i of selSet) starts.set(i, { ...objects[i] });
      render();
      renderProps();
      e.preventDefault();
    });

    stage.addEventListener('pointermove', (e) => {
      if (!mode) return;
      moved = true;

      if (mode === 'band') {
        const r = stage.getBoundingClientRect();
        const x0 = Math.min(grabX, e.clientX) - r.left;
        const y0 = Math.min(grabY, e.clientY) - r.top;
        const x1 = Math.max(grabX, e.clientX) - r.left;
        const y1 = Math.max(grabY, e.clientY) - r.top;
        band = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        stage.querySelectorAll('.plp-band').forEach((b) => b.remove());
        const b = document.createElement('div');
        b.className = 'plp-band';
        b.style.left = `${band.x}px`; b.style.top = `${band.y}px`;
        b.style.width = `${band.w}px`; b.style.height = `${band.h}px`;
        stage.appendChild(b);
        return;
      }

      if (mode === 'custom') {
        handle?.drag?.(objects[idx], api, e, 'move');
        return;
      }

      const dx = dxOf(e);
      const dy = dyOf(e);

      if (mode === 'move') {
        const anchor = starts.get(idx);
        if (!anchor) return;
        const rawX = anchor.x + dx;
        const rawY = anchor.y + dy;
        const { flatX, flatY } = targetsFor(selSet);
        const gx = bestAnchor([rawX, rawX + anchor.w / 2, rawX + anchor.w], flatX);
        const gy = bestAnchor([rawY, rawY + anchor.h / 2, rawY + anchor.h], flatY);
        guideV = gx ? gx.target : null;
        guideH = gy ? gy.target : null;
        const shiftX = (gx ? gx.shift : 0);
        const shiftY = (gy ? gy.shift : 0);
        for (const [i, s] of starts) {
          const o = objects[i];
          o.x = Math.round(Math.max(-500, Math.min(2500, s.x + dx + shiftX)));
          o.y = Math.round(Math.max(-500, Math.min(2500, s.y + dy + shiftY)));
        }
      } else if (mode === 'resize') {
        const o = objects[idx];
        const s = starts.get(idx);
        const t = typeOf(o);
        if (t?.resize) t.resize(o, s, dx, dy);
        else {
          o.w = Math.round(Math.max(20, Math.min(2500, s.w + dx)));
          o.h = Math.round(Math.max(20, Math.min(2500, s.h + dy)));
        }
      }
      changed();
      render();
      renderProps();
      guides(); // после innerHTML-перерисовки
    });

    function stop() {
      if (mode === 'band') {
        stage.querySelectorAll('.plp-band').forEach((b) => b.remove());
        if (!moved && !bandShift) {
          selSet.clear();
          sel = -1;
        } else if (band && (band.w > 3 || band.h > 3)) {
          if (!bandShift) selSet.clear();
          const kk = k();
          for (const [i, o] of objects.entries()) {
            const r = { x: o.x * kk, y: o.y * kk, w: o.w * kk, h: o.h * kk };
            if (r.x < band.x + band.w && r.x + r.w > band.x && r.y < band.y + band.h && r.y + r.h > band.y) selSet.add(i);
          }
          if (selSet.size) sel = [...selSet].at(-1);
        }
        render();
        renderProps();
      }
      if (mode === 'custom' && handle) handle.drag?.(objects[idx], api, null, 'end');
      mode = null;
      starts = null;
      band = null;
      handle = null;
      clearGuides();
      clearHint();
    }
    stage.addEventListener('pointerup', stop);
    stage.addEventListener('pointercancel', stop);

    stage.addEventListener('dblclick', (e) => {
      const objEl = e.target.closest('.plp-obj');
      if (!objEl) return;
      const o = objects[Number(objEl.dataset.i)];
      cfg.onDblclick?.(o, e);
    });

    // поля свойств: снимок истории при первом касании
    propsEl?.addEventListener('pointerdown', pushThrottled);

    // ---------- чипсы ----------
    function renderChips() {
      if (!chipsEl) return;
      chipsEl.innerHTML = objects.map((o, i) => {
        const t = typeOf(o);
        return `<span class="chip${selSet.has(i) ? ' sel' : ''}" data-i="${i}">${t?.label ?? o.type}${o.type === 'image' && o.image ? ` · ${o.image}` : ''}</span>`;
      }).join('') || '<span class="hint">объектов нет</span>';
    }
    chipsEl?.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip[data-i]');
      if (!chip) return;
      const i = Number(chip.dataset.i);
      if (e.shiftKey) {
        if (selSet.has(i)) selSet.delete(i);
        else selSet.add(i);
        sel = selSet.has(i) ? i : sel;
      } else {
        selSet.clear();
        selSet.add(i);
        sel = i;
      }
      render();
      renderProps();
    });

    // ---------- свойства ----------
    function renderProps() {
      renderChips();
      if (!propsEl) return;
      if (!selSet.size) {
        propsEl.innerHTML = '<p class="hint">Клик — выделить объект · shift+клик — несколько · потяни по пустому месту — рамка, как на рабочем столе.<br>Хоткеи: <b>ctrl+z</b> отменить · <b>ctrl+y</b> вернуть · <b>ctrl+c/x/v</b> копировать/вырезать/вставить.</p>' + (cfg.propsHint || '');
        return;
      }
      if (selSet.size > 1) {
        const o = objects[sel];
        propsEl.innerHTML = `
          <p class="hint">выделено: ${selSet.size} — тащатся вместе, магнит считается по тому, за который взялся</p>
          <label>прозрачность всем
            <div class="am-sound-row"><input type="range" class="ee-op" min="0" max="100" value="${o?.opacity ?? 100}" /><span class="hint ee-op-val">${o?.opacity ?? 100}%</span></div>
          </label>
          <div class="rp-row">
            <button class="act ghost ee-zup" title="поднять всем">▲ слой</button>
            <button class="act ghost ee-zdown" title="опустить всем">▼ слой</button>
            ${[...selSet].every((i) => (types[objects[i].type]?.copyable ?? true)) ? '<button class="act ghost ee-del">🗑 удалить выбранное</button>' : '<span class="hint">некоторые объекты — одни на виджет, не удаляются</span>'}
          </div>`;
        propsEl.querySelector('.ee-op')?.addEventListener('input', (ev) => {
          const v = Number(ev.target.value);
          propsEl.querySelector('.ee-op-val').textContent = `${v}%`;
          for (const i of selSet) objects[i].opacity = v;
          render();
        });
        propsEl.querySelector('.ee-zup')?.addEventListener('click', () => {
          for (const i of selSet) objects[i].z = Math.min(30, (objects[i].z ?? 1) + 1);
          changed(); render(); renderProps();
        });
        propsEl.querySelector('.ee-zdown')?.addEventListener('click', () => {
          for (const i of selSet) objects[i].z = Math.max(0, (objects[i].z ?? 1) - 1);
          changed(); render(); renderProps();
        });
        propsEl.querySelector('.ee-del')?.addEventListener('click', () => {
          push();
          for (let i = objects.length - 1; i >= 0; i--) if (selSet.has(i)) objects.splice(i, 1);
          selSet.clear();
          sel = -1;
          changed(); render(); renderProps();
        });
        return;
      }
      const o = objects[sel];
      if (!o) { propsEl.innerHTML = ''; return; }
      const t = typeOf(o);
      propsEl.innerHTML = (t?.props?.(o) ?? '') + `
        <div class="rp-row">
          <label class="hint">слой: </label>
          <button class="act ghost ee-zup" title="поднять слой">▲</button>
          <span class="hint">z=${o.z ?? 1}</span>
          <button class="act ghost ee-zdown" title="опустить слой">▼</button>
          ${(t?.copyable ?? true) ? '<button class="act ghost ee-del" title="удалить">🗑 Удалить</button>' : '<span class="hint">один на виджет — не удаляется</span>'}
        </div>`;
      try { t?.bind?.(o, api); } catch { /* виджетский bind не должен ронять движок */ }
      propsEl.querySelector('.ee-zup')?.addEventListener('click', () => { o.z = Math.min(30, (o.z ?? 1) + 1); changed(); render(); renderProps(); });
      propsEl.querySelector('.ee-zdown')?.addEventListener('click', () => { o.z = Math.max(0, (o.z ?? 1) - 1); changed(); render(); renderProps(); });
      propsEl.querySelector('.ee-del')?.addEventListener('click', () => {
        push();
        objects.splice(sel, 1);
        sel = Math.max(0, sel - 1);
        selSet.clear();
        if (objects[sel]) selSet.add(sel);
        changed(); render(); renderProps();
      });
    }

    // ---------- копирование ----------
    function copyableSel() { return [...selSet].filter((i) => types[objects[i].type]?.copyable ?? true); }
    function copy(cut = false) {
      const sel2 = copyableSel();
      if (!sel2.length) return false;
      clipboard = sel2.map((i) => JSON.parse(JSON.stringify(objects[i])));
      if (cut) {
        push();
        for (let i = objects.length - 1; i >= 0; i--) if (selSet.has(i)) objects.splice(i, 1);
        selSet.clear();
        sel = -1;
        changed(); render(); renderProps();
      }
      return true;
    }
    function paste() {
      if (!clipboard.length) return false;
      push();
      const pasted = [];
      for (const [n, o] of clipboard.entries()) {
        const c = { ...o, x: o.x + 30, y: o.y + 30 };
        c.id = `${c.type}-${Date.now()}-${n}`;
        objects.push(c);
        pasted.push(objects.length - 1);
      }
      selSet.clear();
      pasted.forEach((i) => selSet.add(i));
      sel = pasted.at(-1);
      changed(); render(); renderProps();
      return true;
    }

    // ---------- хоткеи ----------
    document.addEventListener('keydown', (e) => {
      if (cfg.hotkeyGate && !cfg.hotkeyGate()) return;
      if (e.target.closest('input, textarea, select')) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = String(e.key || '').toLowerCase();
      if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
      else if (key === 'c') { e.preventDefault(); copy(); }
      else if (key === 'x') { e.preventDefault(); copy(true); }
      else if (key === 'v') { e.preventDefault(); paste(); }
    });

    // ---------- api ----------
    const api = {
      k,
      selected: () => objects[sel] ?? null,
      dxOf, dyOf, scene,
      rerender: () => { render(); renderProps(); },
      renderOnly: render,
      renderProps,
      push, pushThrottled, changed,
      setHint, clearHint,
      select: (i) => { selSet.clear(); if (objects[i]) selSet.add(i); sel = i; render(); renderProps(); },
      getSelection: () => new Set(selSet),
      undo, redo,
    };

    return api;
  }

  return { create };
})();
