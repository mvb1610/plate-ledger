(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  return n;
};
const r0 = x => Math.round(x || 0);
const r1 = x => Math.round((x || 0) * 10) / 10;
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); const dt = new Date(y, m - 1, d + n); return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0'); };
const fmtDate = s => { const t = todayStr(); if (s === t) return 'Today'; if (s === addDays(t, -1)) return 'Yesterday'; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' }); };

// ---------- Food database (loaded from data/*.json) ----------
let FOODS = [], CNF = [], USDA = [];
const SRC_LABEL = { cnf: 'CNF', usda: 'USDA', custom: 'My food' };
const parseDb = (d, prefix, src) => d.foods.map(a => ({ id: prefix + a[0], name: a[1], group: d.groups[a[2]] || '', kcal: a[3], p: a[4], c: a[5], f: a[6], fib: a[7], sug: a[8], na: a[9], servings: a[10], per: 100, src, lc: a[1].toLowerCase() }));
async function loadFoods() {
  const get = async f => { try { const r = await fetch(f); return r.ok ? await r.json() : null; } catch (e) { return null; } };
  const [c, u] = await Promise.all([get('data/cnf.json'), get('data/usda.json')]);
  CNF = c ? parseDb(c, 'c', 'cnf') : []; USDA = u ? parseDb(u, 'u', 'usda') : [];
  FOODS = CNF.concat(USDA);
  if (!FOODS.length) toast('Food database failed to load — check your connection');
}
// ---------- Storage (this device only) ----------
const store = {
  mode: 'local',
  lsGet(k) { try { const v = localStorage.getItem('pl:' + k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
  lsSet(k, v) { try { localStorage.setItem('pl:' + k, JSON.stringify(v)); return true; } catch (e) { toast('Could not save — storage is full or blocked'); return false; } },
  async get(path) { return this.lsGet(path); },
  async set(path, data) { return this.lsSet(path, data); },
  async recentDays(n) {
    const out = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('pl:days/')) out.push(JSON.parse(localStorage.getItem(k))); } } catch (e) {}
    return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, n);
  },
  allKeys() { const ks = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('pl:') && k !== 'pl:tab') ks.push(k); } } catch (e) {} return ks; }
};
// ---------- State ----------
const DEFAULTS = { kcal: 2200, p: 150, c: 230, f: 75, fib: 30, sug: 50, na: 2300, meals: ['Breakfast', 'Lunch', 'Dinner', 'Snacks'], netMode: false };
const S = { settings: { ...DEFAULTS }, date: todayStr(), days: {}, custom: [], recent: [], tab: 'today', lastWeight: null };

const emptyDay = date => ({ date, entries: [], weight: null, exercise: [] });
async function loadDay(date) {
  if (!S.days[date]) S.days[date] = (await store.get('days/' + date)) || emptyDay(date);
  return S.days[date];
}
async function saveDay(date) { const d = S.days[date]; d.date = date; await store.set('days/' + date, d); }
const totals = day => day.entries.reduce((t, e) => { for (const k of ['kcal', 'p', 'c', 'f', 'fib', 'sug', 'na']) t[k] += e[k] || 0; return t; }, { kcal: 0, p: 0, c: 0, f: 0, fib: 0, sug: 0, na: 0 });
const burned = day => (day.exercise || []).reduce((t, x) => t + (x.kcal || 0), 0);

// ---------- Toast & sheet ----------
let toastT;
function toast(msg) { const r = $('#toastRoot'); r.innerHTML = ''; r.append(el('div', { class: 'toast' }, msg)); clearTimeout(toastT); toastT = setTimeout(() => r.innerHTML = '', 2200); }
function openSheet(title, body, footer) {
  closeSheet();
  const bg = el('div', { class: 'sheet-bg', onclick: e => { if (e.target === bg) closeSheet(); } });
  const sh = el('div', { class: 'sheet', role: 'dialog', 'aria-label': title },
    el('div', { class: 'hd' }, el('h2', {}, title), el('button', { class: 'x', 'aria-label': 'Close', onclick: closeSheet }, '✕')),
    el('div', { class: 'bd' }, body),
    footer ? el('div', { class: 'ft' }, footer) : null);
  bg.append(sh); $('#sheetRoot').append(bg);
  document.body.style.overflow = 'hidden';
  return sh;
}
function closeSheet() { $('#sheetRoot').innerHTML = ''; document.body.style.overflow = ''; }
const field = (label, input) => el('div', { class: 'field' }, el('label', { for: input.id }, label), input);

// ---------- Nutrition helpers ----------
const scaleFood = (food, grams) => { const k = grams / (food.per || 100); return { kcal: food.kcal * k, p: food.p * k, c: food.c * k, f: food.f * k, fib: food.fib * k, sug: food.sug * k, na: food.na * k }; };
const nutGrid = n => el('div', { class: 'nutgrid' },
  el('span', {}, el('b', {}, r1(n.p) + ' g'), 'Protein'), el('span', {}, el('b', {}, r1(n.c) + ' g'), 'Carbs'),
  el('span', {}, el('b', {}, r1(n.f) + ' g'), 'Fat'), el('span', {}, el('b', {}, r1(n.fib) + ' g'), 'Fibre'),
  el('span', {}, el('b', {}, r1(n.sug) + ' g'), 'Sugar'), el('span', {}, el('b', {}, r0(n.na) + ' mg'), 'Sodium'));

// ---------- Search ----------
function searchFoods(q) {
  q = q.trim().toLowerCase(); if (!q) return [];
  const toks = q.split(/[\s,]+/).filter(Boolean).map(t => t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t);
  const score = f => {
    let s = 0;
    for (const t of toks) { const i = f.lc.indexOf(t); if (i < 0) return -1; s += i === 0 ? 30 : (f.lc[i - 1] === ' ' || f.lc[i - 1] === ',' ? 12 : 4); }
    return s - f.lc.length * 0.08 - (f.lc.split(',').length - 1) * 1.5;
  };
  const out = [];
  for (const f of S.custom) { const s = score(f); if (s >= 0) out.push([s + 50, f]); }
  for (const f of FOODS) { const s = score(f); if (s >= 0) out.push([s + (f.src === 'cnf' ? 2 : 0), f]); }
  return out.sort((a, b) => b[0] - a[0]).slice(0, 40).map(x => x[1]);
}

// ---------- Today screen ----------
function ringSvg(pct, over) {
  const r = 44, C = 2 * Math.PI * r, p = Math.min(pct, 1);
  return el('div', { class: 'ring', html:
    `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--surface2)" stroke-width="9"/>
     <circle cx="50" cy="50" r="${r}" fill="none" stroke="${over ? 'var(--over)' : 'var(--accent)'}" stroke-width="9" stroke-linecap="round"
       stroke-dasharray="${(C * p).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 50 50)"/></svg>` });
}
function macroRow(cls, label, val, target, unit = 'g') {
  const pct = target ? Math.min(val / target, 1) * 100 : 0;
  return el('div', { class: 'macro ' + cls },
    el('div', { class: 'lbl' }, el('span', {}, label), el('b', {}, r0(val) + ' / ' + target + ' ' + unit)),
    el('div', { class: 'bar' }, el('i', { class: val > target ? 'over' : '', style: 'width:' + pct + '%' })));
}
async function renderToday() {
  const root = $('#scr-today'); root.innerHTML = '';
  const day = await loadDay(S.date); const t = totals(day); const st = S.settings;
  const goal = st.kcal + (st.netMode ? burned(day) : 0);
  const left = goal - t.kcal;
  const ring = ringSvg(goal ? t.kcal / goal : 0, left < 0);
  ring.append(el('div', { class: 'mid' }, el('div', { class: 'num big' }, r0(Math.abs(left))), el('div', { class: 'sub' }, left < 0 ? 'over' : 'left')));
  const sum = el('div', { class: 'card' },
    el('div', { class: 'summary' }, ring, el('div', { class: 'macros' },
      macroRow('k', 'Calories', t.kcal, goal, 'kcal'), macroRow('p', 'Protein', t.p, st.p), macroRow('c', 'Carbs', t.c, st.c), macroRow('f', 'Fat', t.f, st.f))),
    el('div', { class: 'minis' },
      el('div', { class: 'mini' }, el('b', {}, r0(t.fib) + ' / ' + st.fib + ' g'), 'Fibre'),
      el('div', { class: 'mini' }, el('b', {}, r0(t.sug) + ' / ' + st.sug + ' g'), 'Sugar'),
      el('div', { class: 'mini' }, el('b', {}, r0(t.na) + ' / ' + st.na + ' mg'), 'Sodium')));
  root.append(sum);
  for (const meal of st.meals) {
    const es = day.entries.filter(e => e.meal === meal); const mk = es.reduce((a, e) => a + e.kcal, 0);
    const card = el('div', { class: 'card meal' },
      el('header', {}, el('div', {}, el('h3', {}, meal), ' ', el('span', { class: 'kc' }, es.length ? r0(mk) + ' kcal' : '')),
        el('button', { class: 'add', onclick: () => openAdd(meal) }, '+ Add')));
    if (!es.length) card.append(el('div', { class: 'empty' }, 'Nothing logged yet.'));
    for (const e of es) card.append(el('button', { class: 'entry', onclick: () => openEntry(e) },
      el('div', { class: 'n' }, e.name, el('span', { class: 'src' }, e.src === 'photo' ? 'photo' : e.src === 'ai' ? 'estimate' : e.src === 'custom' ? 'mine' : e.src === 'cnf' ? 'cnf' : '')),
      el('div', { class: 'd' }, (e.unitLabel === 'g' ? `${r0(e.grams)} g` : `${e.qty} ${e.unitLabel} · ${r0(e.grams)} g`) + ` · P ${r0(e.p)} · C ${r0(e.c)} · F ${r0(e.f)}`),
      el('div', { class: 'k' }, r0(e.kcal))));
    root.append(card);
  }
  // weight & exercise
  const wx = el('div', { class: 'card stack' },
    el('div', { class: 'section-h' }, el('h2', {}, 'Weight & activity'), el('span', { class: 'hint' }, day.weight ? day.weight + ' kg' : 'no weigh-in')),
    el('div', { class: 'row' },
      el('button', { class: 'btn ghost', onclick: () => openWeight(day) }, day.weight ? 'Edit weight' : 'Log weight'),
      el('button', { class: 'btn ghost', onclick: () => openExercise(day) }, '+ Activity')));
  if ((day.exercise || []).length) {
    const l = el('div', { class: 'list' });
    for (const x of day.exercise) l.append(el('div', { class: 'li' }, el('div', {}, x.name, el('div', { class: 's' }, (x.min ? x.min + ' min · ' : '') + r0(x.kcal) + ' kcal burned')),
      el('button', { class: 'del', onclick: async () => { day.exercise = day.exercise.filter(y => y.id !== x.id); await saveDay(S.date); renderToday(); } }, 'Remove')));
    wx.append(l);
    if (st.netMode) wx.append(el('div', { class: 'hint' }, `Net goal today: ${r0(goal)} kcal (target + ${r0(burned(day))} burned)`));
  }
  root.append(wx);
  $('#dateLabel').textContent = fmtDate(S.date);
}

// ---------- Add food sheet ----------
function openAdd(meal, mode = 'search') {
  const seg = el('div', { class: 'seg' });
  const body = el('div', { class: 'stack' });
  const modes = [['search', 'Search'], ['photo', 'Photo'], ['describe', 'Describe'], ['custom', 'Quick add']];
  const setMode = m => { mode = m; seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === m)); body.innerHTML = ''; body.append(({ search: viewSearch, photo: viewPhoto, describe: viewDescribe, custom: viewQuick })[m](meal)); };
  for (const [m, l] of modes) seg.append(el('button', { 'data-m': m, onclick: () => setMode(m) }, l));
  openSheet('Add to ' + meal, el('div', { class: 'stack' }, seg, body));
  setMode(mode);
}
function viewSearch(meal) {
  const inp = el('input', { id: 'q', placeholder: 'Search 14,000 foods… e.g. chicken breast grilled', autocomplete: 'off' });
  const res = el('div', { class: 'results' });
  const show = list => { res.innerHTML = ''; for (const f of list) res.append(resRow(f, meal)); };
  inp.addEventListener('input', () => show(searchFoods(inp.value)));
  setTimeout(() => inp.focus(), 50);
  const wrap = el('div', { class: 'stack' }, el('div', { class: 'search' }, inp));
  if (S.recent.length) { wrap.append(el('div', { class: 'hint' }, 'Recent')); const rr = el('div', { class: 'results' }); for (const f of S.recent.slice(0, 12)) rr.append(resRow(f, meal)); wrap.append(rr); }
  else wrap.append(el('div', { class: 'hint' }, 'Canadian Nutrient File (Health Canada) and USDA foods, plus your own. Packaged products: snap the Nutrition Facts label under Photo, or save them once under Foods.'));
  wrap.append(res);
  return wrap;
}
function resRow(f, meal) {
  const sv = f.servings && f.servings[0]; const g = sv ? sv[1] : 100;
  return el('button', { class: 'res', onclick: () => openQuantity(f, meal) },
    el('div', { class: 'n' }, f.name), el('div', { class: 'g' }, (f.src === 'custom' ? 'My food' : `${SRC_LABEL[f.src] || ''} · ${f.group}`) + (sv ? ` · ${sv[0]} = ${g} g` : '')),
    el('div', { class: 'k' }, r0(scaleFood(f, g).kcal) + ' kcal'));
}
function openQuantity(food, meal, existing) {
  const units = [['g', 1], ...(food.servings || []).map(s => [s[0], s[1]])];
  let unitIdx = existing ? Math.max(0, units.findIndex(u => u[0] === existing.unitLabel)) : (units.length > 1 ? 1 : 0);
  const qty = el('input', { id: 'qty', type: 'number', step: 'any', min: '0', inputmode: 'decimal', value: existing ? existing.qty : (unitIdx === 0 ? 100 : 1) });
  const unit = el('select', { id: 'unit' }); units.forEach((u, i) => unit.append(el('option', { value: i, selected: i === unitIdx ? '' : null }, u[0] + (i ? ` (${u[1]} g)` : ''))));
  const mealSel = el('select', { id: 'mealSel' }); S.settings.meals.forEach(m => mealSel.append(el('option', { value: m, selected: m === meal ? '' : null }, m)));
  const prev = el('div', { class: 'preview' }); const grid = el('div');
  const calc = () => { const g = (parseFloat(qty.value) || 0) * units[unit.value][1]; const n = scaleFood(food, g); prev.innerHTML = ''; prev.append(el('div', {}, el('div', { class: 'num big' }, r0(n.kcal) + ' kcal'), el('div', { class: 'hint' }, r0(g) + ' g')), el('div', {})); grid.innerHTML = ''; grid.append(nutGrid(n)); return { g, n }; };
  qty.addEventListener('input', calc); unit.addEventListener('change', calc); calc();
  const body = el('div', { class: 'stack' },
    el('div', {}, el('strong', {}, food.name), el('div', { class: 'hint' }, food.src === 'custom' ? 'My food' : food.group)),
    el('div', { class: 'row' }, field('Amount', qty), field('Unit', unit)), field('Meal', mealSel), prev, grid);
  const save = el('button', { class: 'btn', onclick: async () => {
    const { g, n } = calc(); if (!g) return;
    const day = await loadDay(S.date);
    const entry = { id: existing ? existing.id : uid(), meal: mealSel.value, name: food.name, foodId: food.id, qty: parseFloat(qty.value), unitLabel: units[unit.value][0], grams: g, ...n, src: food.src || 'usda', ts: Date.now() };
    if (existing) day.entries = day.entries.map(e => e.id === existing.id ? entry : e); else day.entries.push(entry);
    await saveDay(S.date); pushRecent(food); closeSheet(); renderToday(); toast((existing ? 'Updated' : 'Added') + ' · ' + r0(n.kcal) + ' kcal');
  } }, existing ? 'Save changes' : 'Add to diary');
  openSheet(existing ? 'Edit entry' : 'How much?', body, save);
}
async function pushRecent(food) {
  S.recent = [food, ...S.recent.filter(f => f.id !== food.id)].slice(0, 30);
  await store.set('foods/recent', { items: S.recent.map(f => ({ ...f, lc: undefined })) });
}

// ---------- Claude estimation via the Anthropic API ----------
const EST_PROMPT = (note) => `You are a careful nutritionist estimating what someone ate. ${note ? 'The person says: "' + note.replace(/"/g, "'") + '". ' : ''}
If an image is attached it shows either (a) a plate/meal, (b) a packaged product, or (c) a Nutrition Facts label.
- For a meal: list each distinct food, estimate the portion in grams using plate, cutlery and hand-size cues, and give nutrition for that portion. Be realistic about restaurant portions and cooking oil.
- For a Nutrition Facts label: return ONE item named after the product with the label's per-serving values and grams = the serving size shown. If it is a Canadian label, serving values are per the stated serving.
- For a packaged product without a visible label: estimate a typical serving.
Reply with ONLY this JSON, no prose:
{"items":[{"name":"short food name","grams":120,"kcal":250,"protein":20,"carbs":10,"fat":12,"fibre":2,"sugar":3,"sodium":300,"confidence":"high|medium|low"}],"notes":"one sentence on the main assumption"}
Units: grams for protein/carbs/fat/fibre/sugar, milligrams for sodium, kcal for energy. Use numbers only (no strings) for numeric fields.`;

const MODELS = [['claude-sonnet-5', 'Claude Sonnet 5 (best accuracy)'], ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5 (fastest, cheapest)']];
const blobToB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch (e) {}
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) { try { return JSON.parse(m[1]); } catch (e) {} }
  const a = text.indexOf('{'), b = text.lastIndexOf('}'); if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) {} }
  return null;
}
async function askClaude(prompt, blob, signal) {
  const key = (S.settings.apiKey || '').trim();
  if (!key) throw { code: 'no_key' };
  const content = [];
  if (blob) content.push({ type: 'image', source: { type: 'base64', media_type: blob.type || 'image/jpeg', data: await blobToB64(blob) } });
  content.push({ type: 'text', text: prompt });
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: S.settings.model || MODELS[0][0], max_tokens: 1200, messages: [{ role: 'user', content }] }) });
  } catch (e) { if (e.name === 'AbortError') throw { code: 'cancelled' }; throw { code: 'network', message: e.message }; }
  if (!res.ok) { let msg = ''; try { msg = (await res.json()).error?.message || ''; } catch (e) {} throw { code: res.status === 401 ? 'bad_key' : res.status === 429 ? 'rate_limited' : res.status === 400 && /credit|billing/i.test(msg) ? 'no_credit' : 'http', message: msg || String(res.status) }; }
  const j = await res.json();
  const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const data = parseJsonLoose(text);
  if (!data) throw { code: 'invalid_json', text };
  return data;
}
const AI_ERR = { no_key: 'Add your Anthropic API key under Settings first.', bad_key: 'That API key was rejected — check it under Settings.', no_credit: 'Your Anthropic account has no credit — top up at console.anthropic.com.', rate_limited: 'Too many requests — wait a moment and try again.', network: 'No connection to the Anthropic API. Check your internet.', invalid_json: 'Claude did not return a usable estimate. Try again, or add a note.', cancelled: 'Stopped.' };

function estimateView(meal, { withPhoto }) {
  const wrap = el('div', { class: 'stack' });
  if (!(S.settings.apiKey || '').trim()) wrap.append(el('div', { class: 'warn' }, 'Photo and text estimates need an Anthropic API key. Add it once under Settings → Claude.'));
  let blob = null; let ctl = null;
  const note = el('textarea', { id: 'note', placeholder: withPhoto ? 'Optional: anything the photo can’t show — "large bowl", "no dressing", "second helping"' : 'e.g. Tim Hortons medium double-double and a whole-wheat everything bagel with cream cheese' });
  const status = el('div', { class: 'status' });
  const out = el('div');
  const go = el('button', { class: 'btn', onclick: run }, withPhoto ? 'Estimate from photo' : 'Estimate');
  const stop = el('button', { class: 'btn ghost', hidden: '', onclick: () => ctl && ctl.abort() }, 'Stop');
  if (withPhoto) {
    const drop = el('div', { class: 'photo-drop' });
    const pickBtns = () => [el('button', { onclick: () => { $('#photoInput').value = ''; $('#photoInput').click(); } }, 'Take photo'), el('button', { onclick: () => { $('#fileInput').value = ''; $('#fileInput').click(); } }, 'Choose file')];
    const setImg = async file => {
      if (!file) return; blob = await downscale(file);
      drop.innerHTML = ''; const img = el('img', { alt: 'Selected meal photo' }); img.src = URL.createObjectURL(blob); drop.append(img, el('div', { class: 'row' }, pickBtns()));
      go.disabled = false;
    };
    $('#photoInput').onchange = e => setImg(e.target.files[0]); $('#fileInput').onchange = e => setImg(e.target.files[0]);
    drop.append(el('div', {}, 'Snap the plate from above, or the Nutrition Facts label of a package.'), el('div', { class: 'row' }, pickBtns()));
    drop.addEventListener('dragover', e => e.preventDefault()); drop.addEventListener('drop', e => { e.preventDefault(); setImg(e.dataTransfer.files[0]); });
    go.disabled = true;
    wrap.append(drop);
  }
  wrap.append(field(withPhoto ? 'Note (optional)' : 'What did you eat?', note), el('div', { class: 'row' }, go, stop), status, out);
  async function run() {
    if (!withPhoto && !note.value.trim()) { note.focus(); return; }
    ctl = new AbortController(); go.disabled = true; stop.hidden = false; out.innerHTML = '';
    status.innerHTML = ''; status.append(el('span', { class: 'spin' }), 'Claude is looking at ' + (withPhoto ? 'the photo…' : 'your description…'));
    try {
      const data = await askClaude(EST_PROMPT(note.value.trim()), withPhoto ? blob : null, ctl.signal);
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) throw { code: 'invalid_json' };
      status.innerHTML = ''; if (data.notes) status.append('Note: ' + data.notes);
      out.append(reviewEstimate(items, meal, withPhoto ? 'photo' : 'ai'));
    } catch (e) {
      status.innerHTML = ''; status.append(AI_ERR[e.code] || ('Something went wrong (' + (e.message || e.code || 'error') + '). Try again.'));
      if (e.code === 'no_key' || e.code === 'bad_key') status.append(' ', el('button', { class: 'chip', onclick: () => { closeSheet(); showTab('settings'); } }, 'Open Settings'));
    } finally { go.disabled = false; stop.hidden = true; }
  }
  return wrap;
}
const viewPhoto = meal => estimateView(meal, { withPhoto: true });
const viewDescribe = meal => estimateView(meal, { withPhoto: false });

function reviewEstimate(items, meal, src) {
  const rows = items.map(it => {
    const g = Math.max(1, Number(it.grams) || 100);
    const per = k => (Number(it[k]) || 0) / g; // per gram
    return { name: String(it.name || 'Food'), grams: g, conf: it.confidence || '', on: true, pg: { kcal: per('kcal'), p: per('protein'), c: per('carbs'), f: per('fat'), fib: per('fibre'), sug: per('sugar'), na: per('sodium') } };
  });
  const list = el('div', { class: 'est' }); const tot = el('div', { class: 'preview' });
  const mealSel = el('select', { id: 'mealSel2' }); S.settings.meals.forEach(m => mealSel.append(el('option', { value: m, selected: m === meal ? '' : null }, m)));
  const calc = () => { let k = 0, n = { kcal: 0, p: 0, c: 0, f: 0, fib: 0, sug: 0, na: 0 }; for (const r of rows) if (r.on) for (const key in n) n[key] += r.pg[key] * r.grams; tot.innerHTML = ''; tot.append(el('div', {}, el('div', { class: 'num big' }, r0(n.kcal) + ' kcal'), el('div', { class: 'hint' }, rows.filter(r => r.on).length + ' items')), el('div', {}, nutGrid(n))); list.querySelectorAll('.k').forEach((kEl, i) => kEl.textContent = rows[i].on ? r0(rows[i].pg.kcal * rows[i].grams) : '—'); };
  rows.forEach((r, i) => {
    const chk = el('input', { type: 'checkbox', checked: '', id: 'ck' + i, onchange: () => { r.on = chk.checked; calc(); } });
    const g = el('input', { type: 'number', inputmode: 'decimal', value: r.grams, 'aria-label': 'grams', oninput: () => { r.grams = Math.max(0, parseFloat(g.value) || 0); calc(); } });
    list.append(el('div', { class: 'it' }, el('label', { class: 'n', for: 'ck' + i }, chk, ' ', r.name, el('small', {}, `P ${r1(r.pg.p * r.grams)} · C ${r1(r.pg.c * r.grams)} · F ${r1(r.pg.f * r.grams)}` + (r.conf ? ' · ' + r.conf + ' confidence' : ''))), el('div', {}, g, el('span', { class: 'hint' }, ' g')), el('div', { class: 'k' })));
  });
  calc();
  const add = el('button', { class: 'btn', onclick: async () => {
    const day = await loadDay(S.date); let k = 0;
    for (const r of rows) if (r.on && r.grams > 0) { const n = {}; for (const key in r.pg) n[key] = r.pg[key] * r.grams; k += n.kcal; day.entries.push({ id: uid(), meal: mealSel.value, name: r.name, qty: r0(r.grams), unitLabel: 'g', grams: r.grams, ...n, src, ts: Date.now() }); }
    await saveDay(S.date); closeSheet(); renderToday(); toast('Logged ' + r0(k) + ' kcal');
  } }, 'Log these');
  return el('div', { class: 'stack' }, el('div', { class: 'hint' }, 'Adjust grams or untick anything wrong. Values scale with grams.'), list, tot, field('Meal', mealSel), add);
}
async function downscale(file) {
  try {
    const bmp = await createImageBitmap(file); const max = 1400; const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(b => res(b || file), 'image/jpeg', 0.88));
  } catch (e) { return file; }
}

// ---------- Quick add / custom foods ----------
function foodForm(existing) {
  const f = existing || {};
  const mk = (id, label, val, extra = {}) => field(label, el('input', { id, type: 'number', step: 'any', inputmode: 'decimal', value: val ?? '', ...extra }));
  const name = el('input', { id: 'fname', value: f.name || '', placeholder: 'e.g. PC Blue Menu Greek yogurt' });
  const per = el('input', { id: 'fper', type: 'number', step: 'any', inputmode: 'decimal', value: f.per || 100 });
  const svName = el('input', { id: 'fsv', value: f.servings && f.servings[0] ? f.servings[0][0] : '', placeholder: 'e.g. 1 container' });
  const form = el('div', { class: 'stack' }, field('Name', name),
    el('div', { class: 'row' }, field('Values are per (g)', per), field('Serving name (optional)', svName)),
    el('div', { class: 'row' }, mk('fk', 'kcal', f.kcal), mk('fp', 'Protein g', f.p), mk('fc', 'Carbs g', f.c), mk('ff', 'Fat g', f.f)),
    el('div', { class: 'row' }, mk('ffib', 'Fibre g', f.fib), mk('fsug', 'Sugar g', f.sug), mk('fna', 'Sodium mg', f.na)));
  form.read = () => { const g = parseFloat(per.value) || 100; const v = id => parseFloat($('#' + id, form).value) || 0; return { id: f.id || 'c' + uid(), name: name.value.trim() || 'Custom food', per: g, kcal: v('fk'), p: v('fp'), c: v('fc'), f: v('ff'), fib: v('ffib'), sug: v('fsug'), na: v('fna'), servings: svName.value.trim() ? [[svName.value.trim(), g]] : [], src: 'custom' }; };
  return form;
}
function viewQuick(meal) {
  const form = foodForm();
  const saveChk = el('input', { type: 'checkbox', id: 'saveCustom', checked: '' });
  const btn = el('button', { class: 'btn', onclick: async () => { const food = form.read(); if (saveChk.checked) await saveCustom(food); openQuantity(food, meal); } }, 'Next: amount');
  return el('div', { class: 'stack' }, el('div', { class: 'hint' }, 'Type the numbers off a label, per 100 g or per serving.'), form, el('label', { class: 'hint' }, saveChk, ' Save to my foods for next time'), btn);
}
async function saveCustom(food) { S.custom = [food, ...S.custom.filter(f => f.id !== food.id)]; for (const f of S.custom) f.lc = f.name.toLowerCase(); await store.set('foods/custom', { items: S.custom.map(f => ({ ...f, lc: undefined })) }); }
function renderFoods() {
  const root = $('#scr-foods'); root.innerHTML = '';
  const card = el('div', { class: 'card stack' }, el('div', { class: 'section-h' }, el('h2', {}, 'My foods'), el('span', { class: 'hint' }, S.custom.length + ' saved')),
    el('div', { class: 'hint' }, 'Packaged products, recipes and restaurant items you eat often. They show first in search.'),
    el('button', { class: 'btn', onclick: () => { const form = foodForm(); openSheet('New food', form, el('button', { class: 'btn', onclick: async () => { await saveCustom(form.read()); closeSheet(); renderFoods(); toast('Saved'); } }, 'Save food')); } }, '+ New food'));
  const list = el('div', { class: 'list' });
  for (const f of S.custom) list.append(el('div', { class: 'li' }, el('button', { class: 'entry', style: 'padding:0;border:0', onclick: () => { const form = foodForm(f); openSheet('Edit food', form, [el('button', { class: 'btn danger', onclick: async () => { S.custom = S.custom.filter(x => x.id !== f.id); await store.set('foods/custom', { items: S.custom }); closeSheet(); renderFoods(); } }, 'Delete'), el('button', { class: 'btn', onclick: async () => { await saveCustom(form.read()); closeSheet(); renderFoods(); toast('Saved'); } }, 'Save')]); } },
    el('div', { class: 'n' }, f.name), el('div', { class: 'd' }, `${r0(f.kcal)} kcal per ${f.per} g · P ${r1(f.p)} · C ${r1(f.c)} · F ${r1(f.f)}`))));
  if (!S.custom.length) list.append(el('div', { class: 'empty' }, 'No saved foods yet.'));
  card.append(list); root.append(card);
  root.append(el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Built-in database'), el('div', { class: 'hint' }, `${CNF.length.toLocaleString()} foods from Health Canada's Canadian Nutrient File (2026) and ${USDA.length.toLocaleString()} from the USDA National Nutrient Database (SR28), per 100 g with common serving sizes. CNF entries rank first in search. Packaged products are best added from their label — snap it under Photo, or save it here.`)));
}

// ---------- Entry edit ----------
function openEntry(e) {
  const food = { id: e.foodId, name: e.name, per: e.grams, kcal: e.kcal, p: e.p, c: e.c, f: e.f, fib: e.fib, sug: e.sug, na: e.na, servings: e.unitLabel !== 'g' ? [[e.unitLabel, e.grams / (e.qty || 1)]] : [], src: e.src };
  const base = S.custom.find(f => f.id === e.foodId) || FOODS.find(f => f.id === e.foodId) || food;
  const day = S.days[S.date];
  const del = el('button', { class: 'btn danger', onclick: async () => { day.entries = day.entries.filter(x => x.id !== e.id); await saveDay(S.date); closeSheet(); renderToday(); toast('Removed'); } }, 'Delete');
  openQuantity(base, e.meal, e);
  $('#sheetRoot .ft').prepend(del);
}

// ---------- Weight & exercise ----------
function openWeight(day) {
  const w = el('input', { id: 'w', type: 'number', step: '0.1', inputmode: 'decimal', value: day.weight || '', placeholder: 'kg' });
  openSheet('Weigh-in · ' + fmtDate(S.date), field('Weight (kg)', w), el('button', { class: 'btn', onclick: async () => { day.weight = parseFloat(w.value) || null; await saveDay(S.date); closeSheet(); renderToday(); } }, 'Save'));
  setTimeout(() => w.focus(), 50);
}
const ACT = [['Walking (brisk)', 4.5], ['Running', 10], ['Cycling', 7], ['Volleyball', 5], ['Strength training', 5], ['Swimming', 7.5], ['Hiking', 6.5], ['Yard work', 4.5]];
function openExercise(day) {
  const name = el('input', { id: 'xn', placeholder: 'Activity' }); const min = el('input', { id: 'xm', type: 'number', inputmode: 'numeric', placeholder: 'min' }); const kc = el('input', { id: 'xk', type: 'number', inputmode: 'numeric', placeholder: 'kcal' });
  const chips = el('div', { class: 'chips' });
  const lastW = day.weight || S.lastWeight || 80;
  for (const [n, met] of ACT) chips.append(el('button', { class: 'chip', onclick: () => { name.value = n; name.dataset.met = met; est(); } }, n));
  const est = () => { const met = parseFloat(name.dataset.met); const m = parseFloat(min.value); if (met && m) kc.value = r0(met * lastW * m / 60); };
  min.addEventListener('input', est);
  openSheet('Add activity', el('div', { class: 'stack' }, chips, field('Activity', name), el('div', { class: 'row' }, field('Minutes', min), field('Calories burned', kc)), el('div', { class: 'hint' }, `Burn estimate uses MET × ${lastW} kg body weight. Edit the number if your watch says otherwise.`)),
    el('button', { class: 'btn', onclick: async () => { if (!name.value.trim()) return; day.exercise = day.exercise || []; day.exercise.push({ id: uid(), name: name.value.trim(), min: parseFloat(min.value) || 0, kcal: parseFloat(kc.value) || 0 }); await saveDay(S.date); closeSheet(); renderToday(); } }, 'Add'));
}

// ---------- Trends ----------
async function renderTrends() {
  const root = $('#scr-trends'); root.innerHTML = '';
  const days = await store.recentDays(90); const byDate = {}; for (const d of days) byDate[d.date] = d;
  const t = todayStr(); const st = S.settings;
  const last14 = []; for (let i = 13; i >= 0; i--) { const ds = addDays(t, -i); const d = byDate[ds]; last14.push({ ds, kcal: d ? totals(d).kcal : 0, logged: !!(d && d.entries.length) }); }
  const logged = last14.filter(x => x.logged); const avg = logged.length ? logged.reduce((a, x) => a + x.kcal, 0) / logged.length : 0;
  const last7 = last14.slice(-7).filter(x => x.logged); const avg7 = last7.length ? last7.reduce((a, x) => a + x.kcal, 0) / last7.length : 0;
  const weights = days.filter(d => d.weight).sort((a, b) => a.date.localeCompare(b.date));
  const wChange = weights.length > 1 ? weights[weights.length - 1].weight - weights[0].weight : null;
  root.append(el('div', { class: 'kpis' },
    el('div', { class: 'kpi' }, el('b', {}, r0(avg7) || '—'), '7-day avg kcal'),
    el('div', { class: 'kpi' }, el('b', {}, r0(avg) || '—'), '14-day avg kcal'),
    el('div', { class: 'kpi' }, el('b', {}, wChange === null ? '—' : (wChange > 0 ? '+' : '') + r1(wChange) + ' kg'), weights.length > 1 ? `since ${weights[0].date.slice(5)}` : 'weight trend')));
  // calories chart
  const W = 560, H = 200, padL = 36, padB = 24, padT = 10; const maxK = Math.max(st.kcal * 1.25, ...last14.map(x => x.kcal)) || 1;
  const bw = (W - padL - 8) / 14; const y = v => padT + (H - padT - padB) * (1 - v / maxK);
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Calories per day, last 14 days">`;
  for (const g of [0.25, 0.5, 0.75, 1]) { const v = maxK * g; svg += `<line x1="${padL}" x2="${W - 8}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${padL - 4}" y="${y(v) + 3}" text-anchor="end">${r0(v)}</text>`; }
  last14.forEach((x, i) => { const bx = padL + i * bw + 3; const h = H - padB - y(x.kcal); svg += `<rect x="${bx}" y="${y(x.kcal)}" width="${bw - 6}" height="${Math.max(0, h)}" rx="3" fill="${x.kcal > st.kcal ? 'var(--over)' : 'var(--accent)'}" opacity="${x.logged ? 1 : .25}"/>`; if (i % 2 === 1) svg += `<text x="${bx + (bw - 6) / 2}" y="${H - 8}" text-anchor="middle">${x.ds.slice(8)}</text>`; });
  svg += `<line x1="${padL}" x2="${W - 8}" y1="${y(st.kcal)}" y2="${y(st.kcal)}" stroke="var(--ink)" stroke-dasharray="4 4" stroke-width="1.2"/><text x="${W - 10}" y="${y(st.kcal) - 4}" text-anchor="end">target ${st.kcal}</text></svg>`;
  root.append(el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Calories · last 14 days'), el('div', { html: svg }), el('div', { class: 'legend' }, el('span', {}, el('i', { style: 'background:var(--accent)' }), 'under target'), el('span', {}, el('i', { style: 'background:var(--over)' }), 'over target'))));
  // weight chart
  const wc = el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Weight · last 90 days'));
  if (weights.length < 2) wc.append(el('div', { class: 'hint' }, 'Log a few weigh-ins from the Today screen to see the trend.'));
  else {
    const lo = Math.floor(Math.min(...weights.map(w => w.weight)) - 1), hi = Math.ceil(Math.max(...weights.map(w => w.weight)) + 1);
    const x0 = new Date(weights[0].date).getTime(), x1 = new Date(weights[weights.length - 1].date).getTime() || x0 + 1;
    const px = d => padL + (W - padL - 12) * ((new Date(d).getTime() - x0) / Math.max(1, x1 - x0)); const py = v => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight trend">`;
    for (let v = lo; v <= hi; v += Math.max(1, Math.round((hi - lo) / 4))) s += `<line x1="${padL}" x2="${W - 8}" y1="${py(v)}" y2="${py(v)}" stroke="var(--line)"/><text x="${padL - 4}" y="${py(v) + 3}" text-anchor="end">${v}</text>`;
    const pts = weights.map(w => `${px(w.date).toFixed(1)},${py(w.weight).toFixed(1)}`).join(' ');
    s += `<polygon points="${px(weights[0].date)},${H - padB} ${pts} ${px(weights[weights.length - 1].date)},${H - padB}" fill="var(--accent)" opacity=".12"/><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round"/>`;
    const lw = weights[weights.length - 1]; s += `<circle cx="${px(lw.date)}" cy="${py(lw.weight)}" r="4" fill="var(--accent)"/><text x="${px(lw.date) - 6}" y="${py(lw.weight) - 8}" text-anchor="end">${lw.weight} kg</text>`;
    s += `<text x="${padL}" y="${H - 8}">${weights[0].date}</text><text x="${W - 8}" y="${H - 8}" text-anchor="end">${lw.date}</text></svg>`;
    wc.append(el('div', { html: s }));
  }
  root.append(wc);
  // macro split
  const mt = logged.length ? last14.filter(x => x.logged).map(x => totals(byDate[x.ds])) : [];
  if (mt.length) { const m = mt.reduce((a, t) => ({ p: a.p + t.p, c: a.c + t.c, f: a.f + t.f }), { p: 0, c: 0, f: 0 }); const kc = m.p * 4 + m.c * 4 + m.f * 9 || 1;
    root.append(el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Macro split · 14 days'),
      el('div', { class: 'bar', style: 'height:14px;display:flex' }, el('i', { style: `width:${m.p * 4 / kc * 100}%;background:var(--p);border-radius:0` }), el('i', { style: `width:${m.c * 4 / kc * 100}%;background:var(--c);border-radius:0` }), el('i', { style: `width:${m.f * 9 / kc * 100}%;background:var(--f);border-radius:0` })),
      el('div', { class: 'legend' }, el('span', {}, el('i', { style: 'background:var(--p)' }), `Protein ${r0(m.p * 4 / kc * 100)}%`), el('span', {}, el('i', { style: 'background:var(--c)' }), `Carbs ${r0(m.c * 4 / kc * 100)}%`), el('span', {}, el('i', { style: 'background:var(--f)' }), `Fat ${r0(m.f * 9 / kc * 100)}%`))));
  }
}

// ---------- Settings ----------
function renderSettings() {
  const root = $('#scr-settings'); root.innerHTML = ''; const st = S.settings;
  const save = async () => { await store.set('settings/main', st); };
  const mk = (k, label, unit) => { const i = el('input', { id: 's_' + k, type: 'number', inputmode: 'numeric', value: st[k] }); i.addEventListener('change', async () => { st[k] = parseFloat(i.value) || DEFAULTS[k]; await save(); toast('Targets saved'); }); return field(label + ' (' + unit + ')', i); };
  const net = el('input', { type: 'checkbox', id: 'net', checked: st.netMode ? '' : null }); net.addEventListener('change', async () => { st.netMode = net.checked; await save(); });
  root.append(el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Daily targets'),
    el('div', { class: 'row' }, mk('kcal', 'Calories', 'kcal'), mk('p', 'Protein', 'g')), el('div', { class: 'row' }, mk('c', 'Carbs', 'g'), mk('f', 'Fat', 'g')),
    el('div', { class: 'row' }, mk('fib', 'Fibre', 'g'), mk('sug', 'Sugar', 'g'), mk('na', 'Sodium', 'mg')),
    el('label', { class: 'hint' }, net, ' Add calories burned by logged activity to the daily goal'),
    el('div', { class: 'hint' }, 'Rule of thumb for a moderately active adult: maintenance ≈ 30–33 kcal per kg body weight; protein 1.6–2.2 g/kg if training.')));
  // Claude / API key
  const key = el('input', { id: 'apiKey', type: 'password', autocomplete: 'off', placeholder: 'sk-ant-…', value: st.apiKey || '' });
  const show = el('button', { class: 'chip', onclick: () => { key.type = key.type === 'password' ? 'text' : 'password'; show.textContent = key.type === 'password' ? 'Show' : 'Hide'; } }, 'Show');
  const model = el('select', { id: 'model' }); MODELS.forEach(([v, l]) => model.append(el('option', { value: v, selected: (st.model || MODELS[0][0]) === v ? '' : null }, l)));
  const keyStatus = el('div', { class: 'hint' }, st.apiKey ? 'Key saved on this device only.' : 'No key yet.');
  const saveKey = el('button', { class: 'btn', onclick: async () => { st.apiKey = key.value.trim(); st.model = model.value; await save(); keyStatus.textContent = 'Testing the key…'; try { const r = await askClaude('Reply with only this JSON: {"ok":true}', null); keyStatus.textContent = r && r.ok ? 'Key works — photo and text estimates are on.' : 'Key saved; unexpected reply, but the request went through.'; } catch (e) { keyStatus.textContent = AI_ERR[e.code] || ('Could not verify: ' + (e.message || e.code)); } } }, 'Save & test');
  root.append(el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Claude (photo & text estimates)'),
    el('div', { class: 'hint' }, 'Estimates call the Anthropic API directly from this device with your own key. Get one at console.anthropic.com → API keys; add a few dollars of credit. A photo estimate costs roughly 1–3 ¢.'),
    field('Anthropic API key', key), el('div', { class: 'chips' }, show), field('Model', model), saveKey, keyStatus));
  // Data
  const imp = el('input', { type: 'file', accept: 'application/json', hidden: '' });
  imp.onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const j = JSON.parse(await f.text()); let n = 0; for (const [k, v] of Object.entries(j)) if (k.startsWith('pl:')) { localStorage.setItem(k, JSON.stringify(v)); n++; } toast('Restored ' + n + ' records'); location.reload(); } catch (err) { toast('That file is not a Plate Ledger backup'); } };
  root.append(el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Data'),
    el('div', { class: 'hint' }, 'Your diary lives in this browser on this device — nobody else can see it. Back it up now and then; clearing website data would erase it.'),
    el('div', { class: 'row' }, el('button', { class: 'btn ghost', onclick: exportCsv }, 'Export CSV'), el('button', { class: 'btn ghost', onclick: exportBackup }, 'Backup (JSON)')),
    el('button', { class: 'btn ghost', onclick: () => imp.click() }, 'Restore from backup'), imp,
    el('div', { class: 'hint' }, `Food database: ${CNF.length.toLocaleString()} Canadian Nutrient File + ${USDA.length.toLocaleString()} USDA foods. Version ${APP_VERSION}.`)));
}
function downloadText(filename, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = filename; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function exportCsv() {
  const days = await store.recentDays(5000); const rows = [['date', 'meal', 'food', 'qty', 'unit', 'grams', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'fibre_g', 'sugar_g', 'sodium_mg', 'source']];
  for (const d of days.sort((a, b) => a.date.localeCompare(b.date))) { for (const e of d.entries) rows.push([d.date, e.meal, e.name, e.qty, e.unitLabel, r0(e.grams), r0(e.kcal), r1(e.p), r1(e.c), r1(e.f), r1(e.fib), r1(e.sug), r0(e.na), e.src]); if (d.weight) rows.push([d.date, 'weight', '', d.weight, 'kg', '', '', '', '', '', '', '', '', '']); for (const x of d.exercise || []) rows.push([d.date, 'activity', x.name, x.min, 'min', '', -r0(x.kcal), '', '', '', '', '', '', '']); }
  downloadText('plate-ledger-' + todayStr() + '.csv', rows.map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\n'), 'text/csv');
}
function exportBackup() {
  const j = {}; for (const k of store.allKeys()) { try { j[k] = JSON.parse(localStorage.getItem(k)); } catch (e) {} }
  if (j['pl:settings/main']) { j['pl:settings/main'] = { ...j['pl:settings/main'], apiKey: '' }; }
  downloadText('plate-ledger-backup-' + todayStr() + '.json', JSON.stringify(j), 'application/json');
}
// ---------- Navigation ----------
const TITLES = { today: 'Today', trends: 'Trends', foods: 'Foods', settings: 'Settings' };
function showTab(tab) {
  S.tab = tab; document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  for (const t of Object.keys(TITLES)) $('#scr-' + t).hidden = t !== tab;
  $('#screenTitle').textContent = TITLES[tab]; $('#datenav').hidden = tab !== 'today';
  ({ today: renderToday, trends: renderTrends, foods: renderFoods, settings: renderSettings })[tab]();
  try { localStorage.setItem('pl:tab', tab); } catch (e) {}
}
document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('#prevDay').onclick = () => { S.date = addDays(S.date, -1); renderToday(); };
$('#nextDay').onclick = () => { S.date = addDays(S.date, 1); renderToday(); };
$('#dateLabel').onclick = () => { const i = el('input', { id: 'dp', type: 'date', value: S.date }); openSheet('Go to date', field('Date', i), [el('button', { class: 'btn ghost', onclick: () => { S.date = todayStr(); closeSheet(); renderToday(); } }, 'Today'), el('button', { class: 'btn', onclick: () => { if (i.value) S.date = i.value; closeSheet(); renderToday(); } }, 'Go')]); };

// ---------- Boot ----------
const APP_VERSION = '1.0.0';
(async () => {
  const st = store.lsGet('settings/main'); if (st) S.settings = { ...DEFAULTS, ...st };
  const cf = store.lsGet('foods/custom'); S.custom = (cf && cf.items) || []; for (const f of S.custom) f.lc = f.name.toLowerCase();
  const rc = store.lsGet('foods/recent'); S.recent = (rc && rc.items) || [];
  const recent = await store.recentDays(30); const lw = recent.find(d => d.weight); if (lw) S.lastWeight = lw.weight;
  let tab = 'today'; try { tab = localStorage.getItem('pl:tab') || 'today'; } catch (e) {}
  showTab(tab);
  await loadFoods();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
})();