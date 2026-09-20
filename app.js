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
const MKEYS = ['ca', 'fe', 'k', 'mg', 'zn', 'vd', 'b12', 'vc', 'fol'];
const SRC_LABEL = { cnf: 'CNF', usda: 'USDA', custom: 'My food' };
const parseDb = (d, prefix, src) => d.foods.map(a => ({ id: prefix + a[0], name: a[1], group: d.groups[a[2]] || '', kcal: a[3], p: a[4], c: a[5], f: a[6], fib: a[7], sug: a[8], na: a[9], servings: a[10], per: 100, src, lc: a[1].toLowerCase(), m: a[11] && a[11].length ? Object.fromEntries(MKEYS.map((k, i) => [k, a[11][i] || 0])) : undefined }));
async function loadFoods() {
  const get = async f => { try { const r = await fetch(f); return r.ok ? await r.json() : null; } catch (e) { return null; } };
  const [c, u] = await Promise.all([get('data/cnf.json'), get('data/usda.json')]);
  CNF = c ? parseDb(c, 'c', 'cnf') : []; USDA = u ? parseDb(u, 'u', 'usda') : [];
  FOODS = CNF.concat(USDA);
  if (!FOODS.length) toast('Food database failed to load — check your connection');
}
// ---------- Storage: local cache + Firebase cloud sync ----------
const GOOGLE_CLIENT_ID = '697214158009-bbkc4g24jr4kjharq5da3i5t26b9nfng.apps.googleusercontent.com';
const APP_URL = 'https://mvb1610.github.io/plate-ledger/';
const isStandaloneApp = () => !!navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
const FIREBASE_CONFIG = { apiKey: 'AIzaSyDcRdTEzGJa6YfFgesaefw90mHZZrTvaQo', authDomain: 'plate-ledger-8007d.firebaseapp.com', projectId: 'plate-ledger-8007d', storageBucket: 'plate-ledger-8007d.firebasestorage.app', messagingSenderId: '697214158009', appId: '1:697214158009:web:1189551d41ae8640e9c768' };
const store = {
  lsGet(k) { try { const v = localStorage.getItem('pl:' + k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
  lsSet(k, v) { try { localStorage.setItem('pl:' + k, JSON.stringify(v)); return true; } catch (e) { toast('Could not save — storage is full or blocked'); return false; } },
  lsDel(k) { try { localStorage.removeItem('pl:' + k); } catch (e) {} },
  async get(path) { return this.lsGet(path); },
  async set(path, data) { const ok = this.lsSet(path, data); cloud.push(path, data); return ok; },
  async recentDays(n) {
    const out = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('pl:days/')) out.push(JSON.parse(localStorage.getItem(k))); } } catch (e) {}
    return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, n);
  },
  allKeys() { const ks = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('pl:days/') || k.startsWith('pl:settings/') || k.startsWith('pl:foods/') || k.startsWith('pl:coach/')) ks.push(k); } } catch (e) {} return ks; }
};
// Firestore rejects nested arrays (e.g. servings [['1 cup', 158]]), so inner arrays are wrapped as {__a: [...]} on the way up and unwrapped on the way down.
const fsEnc = v => Array.isArray(v) ? v.map(x => Array.isArray(x) ? { __a: fsEnc(x) } : fsEnc(x)) : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, fsEnc(x)])) : v;
const fsDec = v => Array.isArray(v) ? v.map(fsDec) : (v && typeof v === 'object') ? ('__a' in v && Object.keys(v).length === 1 ? fsDec(v.__a) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fsDec(x)]))) : v;
// Cloud layer. Paths map to Firestore: days/<date> -> users/<uid>/days/<date>; anything else -> users/<uid>/meta/<path with / replaced by _>
const cloud = {
  ready: false, user: null, db: null, auth: null, status: 'off', lastSync: null, unsub: [], listeners: [],
  onChange(fn) { this.listeners.push(fn); },
  emit() { for (const fn of this.listeners) { try { fn(); } catch (e) {} } },
  init() {
    if (!window.firebase) { this.status = 'unavailable'; return; }
    try {
      firebase.initializeApp(FIREBASE_CONFIG);
      this.auth = firebase.auth(); this.db = firebase.firestore();
      try { this.db.settings({ ignoreUndefinedProperties: true }); } catch (e) {}
      try { this.db.enablePersistence({ synchronizeTabs: true }).catch(() => {}); } catch (e) {}
      this.ready = true; this.status = 'signedout';
      this.auth.onAuthStateChanged(u => { this.user = u || null; if (u) this.start(); else this.stop(); this.emit(); });
      this.handleOAuthReturn().catch(() => {});
    } catch (e) { console.warn('firebase init failed', e); this.status = 'unavailable'; }
  },
  ref(path) {
    const base = this.db.collection('users').doc(this.user.uid);
    if (path.startsWith('days/')) return base.collection('days').doc(path.slice(5));
    return base.collection('meta').doc(path.replace(/\//g, '_'));
  },
  push(path, data) {
    if (!this.user || !this.db) return;
    this.status = 'syncing'; this.emit();
    this.ref(path).set(fsEnc(JSON.parse(JSON.stringify(data)))).then(() => { this.status = 'synced'; this.lastSync = Date.now(); this.emit(); })
      .catch(e => { console.warn('cloud push failed', e); this.status = 'error'; this.error = e.code || e.message; this.emit(); });
  },
  async start() {
    // 1) pull everything from the cloud; 2) upload anything only on this device; 3) listen for changes from other devices
    this.status = 'syncing'; this.emit();
    try {
      const base = this.db.collection('users').doc(this.user.uid);
      const [daysSnap, metaSnap] = await Promise.all([base.collection('days').get(), base.collection('meta').get()]);
      const cloudKeys = new Set();
      daysSnap.forEach(d => { cloudKeys.add('days/' + d.id); store.lsSet('days/' + d.id, fsDec(d.data())); });
      metaSnap.forEach(d => { const k = d.id === 'settings_main' ? 'settings/main' : d.id === 'foods_custom' ? 'foods/custom' : d.id === 'foods_recent' ? 'foods/recent' : d.id === 'foods_meals' ? 'foods/meals' : d.id === 'coach_last' ? 'coach/last' : null; if (k) { cloudKeys.add(k); store.lsSet(k, fsDec(d.data())); } });
      // upload local-only records (first sign-in on a device that already has a diary)
      const ups = [];
      for (const k of store.allKeys()) { const path = k.slice(3); if (!cloudKeys.has(path)) { const v = store.lsGet(path); if (v && typeof v === 'object') ups.push(this.ref(path).set(fsEnc(JSON.parse(JSON.stringify(v)))).catch(e => console.warn('upload failed', path, e))); } }
      if (ups.length) await Promise.all(ups);
      this.status = 'synced'; this.lastSync = Date.now();
      // live listeners
      this.stopListeners();
      this.unsub.push(base.collection('days').onSnapshot(snap => { let changed = false; snap.docChanges().forEach(c => { if (c.doc.metadata.hasPendingWrites) return; if (c.type === 'removed') store.lsDel('days/' + c.doc.id); else store.lsSet('days/' + c.doc.id, fsDec(c.doc.data())); delete S.days[c.doc.id]; changed = true; }); if (changed) { this.lastSync = Date.now(); this.emit(); refreshView(); } }, e => { console.warn(e); }));
      this.unsub.push(base.collection('meta').onSnapshot(snap => { let changed = false; snap.docChanges().forEach(c => { if (c.doc.metadata.hasPendingWrites) return; const k = c.doc.id === 'settings_main' ? 'settings/main' : c.doc.id === 'foods_custom' ? 'foods/custom' : c.doc.id === 'foods_recent' ? 'foods/recent' : c.doc.id === 'foods_meals' ? 'foods/meals' : c.doc.id === 'coach_last' ? 'coach/last' : null; if (!k) return; store.lsSet(k, fsDec(c.doc.data())); changed = true; }); if (changed) { reloadStateFromLocal(); this.emit(); refreshView(); } }, e => { console.warn(e); }));
    } catch (e) { console.warn('cloud sync failed', e); this.status = 'error'; this.error = e.code || e.message; }
    reloadStateFromLocal(); S.days = {}; this.emit(); refreshView();
  },
  stopListeners() { for (const u of this.unsub) { try { u(); } catch (e) {} } this.unsub = []; },
  stop() { this.stopListeners(); this.status = this.ready ? 'signedout' : 'unavailable'; },
  async signIn() {
    if (!this.ready) { toast('Cloud sync is not available right now'); return; }
    // Installed iPhone/Android app: Safari blocks Firebase's popup and redirect flows, so go straight to Google and come back here.
    if (isStandaloneApp()) { this.redirectToGoogle(); return; }
    const provider = new firebase.auth.GoogleAuthProvider();
    try { await this.auth.signInWithPopup(provider); }
    catch (e) {
      if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
      this.redirectToGoogle();
    }
  },
  redirectToGoogle() {
    const state = uid(); try { localStorage.setItem('pl:oauth_state', state); } catch (e) {}
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', GOOGLE_CLIENT_ID); u.searchParams.set('redirect_uri', APP_URL); u.searchParams.set('response_type', 'token');
    u.searchParams.set('scope', 'openid email profile'); u.searchParams.set('state', state); u.searchParams.set('prompt', 'select_account');
    location.href = u.toString();
  },
  async handleOAuthReturn() {
    if (!location.hash.includes('access_token=')) return false;
    const p = new URLSearchParams(location.hash.slice(1)); const tok = p.get('access_token'); const st = p.get('state');
    let saved = null; try { saved = localStorage.getItem('pl:oauth_state'); localStorage.removeItem('pl:oauth_state'); } catch (e) {}
    history.replaceState(null, '', location.pathname + location.search);
    if (!tok || (saved && st !== saved)) { toast('Sign-in could not be completed — try again'); return false; }
    try { await this.auth.signInWithCredential(firebase.auth.GoogleAuthProvider.credential(null, tok)); toast('Signed in'); }
    catch (e) { toast('Sign-in failed: ' + (e.code || e.message)); }
    return true;
  },
  async signOut() {
    if (!this.ready) return;
    await this.auth.signOut();
    for (const k of store.allKeys()) { try { localStorage.removeItem(k); } catch (e) {} }
    location.reload();
  }
};
function reloadStateFromLocal() {
  const st = store.lsGet('settings/main'); S.settings = st ? { ...DEFAULTS, ...st } : { ...DEFAULTS };
  const cf = store.lsGet('foods/custom'); S.custom = (cf && cf.items) || []; for (const f of S.custom) f.lc = f.name.toLowerCase();
  const rc = store.lsGet('foods/recent'); S.recent = (rc && rc.items) || [];
  const ml = store.lsGet('foods/meals'); S.meals = (ml && ml.items) || [];
}
function refreshView() { if (document.querySelector('#sheetRoot').children.length) return; ({ today: renderToday, trends: renderTrends, foods: renderFoods, settings: renderSettings })[S.tab || 'today'](); }
// ---------- State ----------
const DEFAULTS = { kcal: 2200, p: 150, c: 230, f: 75, fib: 30, sug: 50, na: 2300, meals: ['Breakfast', 'Lunch', 'Dinner', 'Snacks'], netMode: false };
const S = { settings: { ...DEFAULTS }, date: todayStr(), days: {}, custom: [], recent: [], meals: [], tab: 'today', lastWeight: null };

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
function closeSheet() { if (openAdd.stop) { openAdd.stop(); openAdd.stop = null; } $('#sheetRoot').innerHTML = ''; document.body.style.overflow = ''; }
const field = (label, input) => el('div', { class: 'field' }, el('label', { for: input.id }, label), input);

// ---------- Nutrition helpers ----------
const scaleFood = (food, grams) => { const k = grams / (food.per || 100); const o = { kcal: food.kcal * k, p: food.p * k, c: food.c * k, f: food.f * k, fib: food.fib * k, sug: food.sug * k, na: food.na * k }; if (food.m) { o.m = {}; for (const key in food.m) o.m[key] = (food.m[key] || 0) * k; } return o; };
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
  for (const f of recipeFoods()) { const s = score(f); if (s >= 0) out.push([s + 50, f]); }
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
      el('div', { class: 'mini' }, el('b', {}, r0(t.na) + ' / ' + st.na + ' mg'), 'Sodium')),
    el('div', { class: 'chips', style: 'margin-top:10px' }, el('button', { class: 'chip', onclick: () => suggestMeal(guessMeal()) }, '✨ What should I eat?')));
  if (cloud.ready && !cloud.user) root.append(el('div', { class: 'card', style: 'display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap' },
    el('div', { style: 'flex:1;min-width:200px' }, el('strong', {}, 'Not backed up yet'), el('div', { class: 'hint' }, 'Sign in with Google to keep your diary safe and use it on any device.')),
    el('button', { class: 'btn', style: 'flex:0 0 auto', onclick: () => cloud.signIn() }, 'Sign in with Google')));
  root.append(sum);
  root.append(weekCard(await weekBudget(S.date)));
  for (const meal of st.meals) {
    const es = day.entries.filter(e => e.meal === meal); const mk = es.reduce((a, e) => a + e.kcal, 0);
    const card = el('div', { class: 'card meal' },
      el('header', {}, el('div', {}, el('h3', {}, meal), ' ', el('span', { class: 'kc' }, es.length ? r0(mk) + ' kcal' : '')),
        el('button', { class: 'add', onclick: () => openAdd(meal) }, '+ Add')));
    if (!es.length) {
      const y = await loadDay(addDays(S.date, -1)); const ye = y.entries.filter(e => e.meal === meal);
      card.append(el('div', { class: 'empty' }, 'Nothing logged yet.', ye.length ? el('button', { class: 'chip', style: 'margin-left:8px', onclick: async () => { for (const e of ye) day.entries.push({ ...e, id: uid(), ts: Date.now() }); await saveDay(S.date); renderToday(); toast('Copied ' + ye.length + ' items from yesterday'); } }, 'Copy from yesterday') : null));
    } else card.querySelector('header').append(el('button', { class: 'chip', style: 'margin-left:6px', title: 'Save this meal to log it again with one tap', onclick: () => saveMealFromEntries(meal, es) }, 'Save meal'));
    for (const e of es) card.append(el('button', { class: 'entry', onclick: () => openEntry(e) },
      el('div', { class: 'n' }, e.name, el('span', { class: 'src' }, e.src === 'photo' ? 'photo' : e.src === 'ai' ? 'estimate' : e.src === 'custom' ? 'mine' : e.src === 'cnf' ? 'cnf' : e.src === 'recipe' ? 'recipe' : e.src === 'off' ? 'scanned' : '')),
      el('div', { class: 'd' }, (e.unitLabel === 'g' ? `${r0(e.grams)} g` : `${e.qty} ${e.unitLabel} · ${r0(e.grams)} g`) + ` · P ${r0(e.p)} · C ${r0(e.c)} · F ${r0(e.f)}`),
      el('div', { class: 'k' }, r0(e.kcal))));
    root.append(card);
  }
  root.append(nutrientsCard(day));
  // weight & exercise
  const wtr = weightTrend((await store.recentDays(60)).filter(d => d.weight).sort((a, b) => a.date.localeCompare(b.date)));
  const wx = el('div', { class: 'card stack' },
    el('div', { class: 'section-h' }, el('h2', {}, 'Weight & activity'), el('span', { class: 'hint' }, day.weight ? day.weight + ' kg' : 'no weigh-in')),
    wtr ? el('div', { class: 'hint' }, wtr.text) : null,
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
function guessMeal() { const h = new Date().getHours(); const ms = S.settings.meals; return ms[h < 10 ? 0 : h < 15 ? 1 : h < 21 ? 2 : Math.min(3, ms.length - 1)] || ms[0]; }
function openAdd(meal, mode = 'search', prefill = null) {
  openAdd.prefill = prefill;
  const seg = el('div', { class: 'seg' });
  const body = el('div', { class: 'stack' });
  const modes = [['search', 'Search'], ['scan', 'Scan'], ['meals', 'Meals'], ['photo', 'Photo'], ['describe', 'Describe'], ['custom', 'Quick add']];
  const setMode = m => { if (openAdd.stop) { openAdd.stop(); openAdd.stop = null; } mode = m; seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.m === m)); body.innerHTML = ''; body.append(({ search: viewSearch, scan: viewScan, meals: viewMeals, photo: viewPhoto, describe: viewDescribe, custom: viewQuick })[m](meal)); };
  for (const [m, l] of modes) seg.append(el('button', { 'data-m': m, onclick: () => setMode(m) }, l));
  openSheet('Add to ' + meal, el('div', { class: 'stack' }, seg, body));
  setMode(mode);
}
function viewSearch(meal, onPick) {
  const inp = el('input', { id: 'q', placeholder: 'Search 14,000 foods… e.g. chicken breast grilled', autocomplete: 'off' });
  const res = el('div', { class: 'results' });
  const show = list => { res.innerHTML = ''; for (const f of list) res.append(resRow(f, meal, onPick)); };
  inp.addEventListener('input', () => show(searchFoods(inp.value)));
  setTimeout(() => inp.focus(), 50);
  const wrap = el('div', { class: 'stack' }, el('div', { class: 'search' }, inp));
  if (S.recent.length) { wrap.append(el('div', { class: 'hint' }, 'Recent')); const rr = el('div', { class: 'results' }); for (const f of S.recent.slice(0, 12)) rr.append(resRow(f, meal, onPick)); wrap.append(rr); }
  else wrap.append(el('div', { class: 'hint' }, 'Canadian Nutrient File (Health Canada) and USDA foods, plus your own. Packaged products: snap the Nutrition Facts label under Photo, or save them once under Foods.'));
  wrap.append(res);
  return wrap;
}
function resRow(f, meal, onPick) {
  const sv = f.servings && f.servings[0]; const g = sv ? sv[1] : 100;
  return el('button', { class: 'res', onclick: () => openQuantity(f, meal, null, onPick) },
    el('div', { class: 'n' }, f.name), el('div', { class: 'g' }, (f.src === 'custom' ? 'My food' : f.src === 'recipe' ? 'My recipe' : f.src === 'off' ? 'Scanned' + (f.brand ? ' · ' + f.brand : '') : `${SRC_LABEL[f.src] || ''} · ${f.group}`) + (sv ? ` · ${sv[0]} = ${g} g` : '')),
    el('div', { class: 'k' }, r0(scaleFood(f, g).kcal) + ' kcal'));
}
function openQuantity(food, meal, existing, onPick) {
  const units = [['g', 1], ...(food.servings || []).map(s => [s[0], s[1]])];
  let unitIdx = existing ? Math.max(0, units.findIndex(u => u[0] === existing.unitLabel)) : (units.length > 1 ? 1 : 0);
  const qty = el('input', { id: 'qty', type: 'number', step: 'any', min: '0', inputmode: 'decimal', value: existing ? existing.qty : (unitIdx === 0 ? 100 : 1) });
  const unit = el('select', { id: 'unit' }); units.forEach((u, i) => unit.append(el('option', { value: i, selected: i === unitIdx ? '' : null }, u[0] + (i ? ` (${u[1]} g)` : ''))));
  const mealSel = el('select', { id: 'mealSel' }); S.settings.meals.forEach(m => mealSel.append(el('option', { value: m, selected: m === meal ? '' : null }, m)));
  const prev = el('div', { class: 'preview' }); const grid = el('div');
  const calc = () => { const g = (parseFloat(qty.value) || 0) * units[unit.value][1]; const n = scaleFood(food, g); prev.innerHTML = ''; prev.append(el('div', {}, el('div', { class: 'num big' }, r0(n.kcal) + ' kcal'), el('div', { class: 'hint' }, r0(g) + ' g')), el('div', {})); grid.innerHTML = ''; grid.append(nutGrid(n)); return { g, n }; };
  qty.addEventListener('input', calc); unit.addEventListener('change', calc); calc();
  const body = el('div', { class: 'stack' },
    el('div', {}, el('strong', {}, food.name), el('div', { class: 'hint' }, food.src === 'custom' ? 'My food' : food.src === 'recipe' ? 'My recipe' : food.src === 'off' ? 'Scanned · ' + (food.brand || 'Open Food Facts') : food.group)),
    el('div', { class: 'row' }, field('Amount', qty), field('Unit', unit)), onPick ? null : field('Meal', mealSel), prev, grid);
  const save = el('button', { class: 'btn', onclick: async () => {
    const { g, n } = calc(); if (!g) return;
    const entry = { id: existing ? existing.id : uid(), meal: mealSel.value, name: food.name, foodId: food.id, qty: parseFloat(qty.value), unitLabel: units[unit.value][0], grams: g, ...n, src: food.src || 'usda', ts: Date.now() };
    if (onPick) { onPick(entry); return; }
    const day = await loadDay(S.date);
    if (existing) day.entries = day.entries.map(e => e.id === existing.id ? entry : e); else day.entries.push(entry);
    await saveDay(S.date); pushRecent(food); if (food.src === 'off' && !S.custom.find(f => f.id === food.id)) saveCustom({ ...food, src: 'custom' }); closeSheet(); renderToday(); toast((existing ? 'Updated' : 'Added') + ' · ' + r0(n.kcal) + ' kcal');
  } }, existing ? 'Save changes' : 'Add to diary');
  if (onPick) save.textContent = 'Add ingredient';
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
  if (openAdd.prefill) { note.value = openAdd.prefill; openAdd.prefill = null; }
  wrap.append(field(withPhoto ? 'Note (optional)' : 'What did you eat?', note), withPhoto ? null : el('div', { class: 'chips' }, micButton(note)), el('div', { class: 'row' }, go, stop), status, out);
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
  card.append(list); root.append(mealsCard()); root.append(card);
  root.append(el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Built-in database'), el('div', { class: 'hint' }, `${CNF.length.toLocaleString()} foods from Health Canada's Canadian Nutrient File (2026) and ${USDA.length.toLocaleString()} from the USDA National Nutrient Database (SR28), per 100 g with common serving sizes. CNF entries rank first in search. Packaged products are best added from their label — snap it under Photo, or save it here.`)));
}

// ---------- Barcode scanning (Open Food Facts) ----------
function loadScript(src) { return new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) return res(); const sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = () => rej(new Error('Could not load the barcode library — check your connection.')); document.head.append(sc); }); }
async function lookupBarcode(code) {
  code = String(code).replace(/\D/g, '');
  if (!code) throw new Error('That is not a barcode.');
  const known = S.custom.find(f => f.barcode === code); if (known) return known;
  let j;
  try { const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,product_name_en,product_name_fr,brands,nutriments,serving_size,serving_quantity,quantity`, { headers: { Accept: 'application/json' } }); j = await r.json(); }
  catch (e) { throw new Error('No connection to Open Food Facts. Try again when online, or type the numbers under Quick add.'); }
  if (!j || j.status !== 1 || !j.product) throw new Error(`Barcode ${code} is not in Open Food Facts yet. Snap the Nutrition Facts label under Photo, or type it under Quick add.`);
  const P = j.product, N = P.nutriments || {};
  const sq = parseFloat(P.serving_quantity) || 0;
  const val = k => { let v = N[k + '_100g']; if ((v == null || v === '') && sq && N[k + '_serving'] != null) v = Number(N[k + '_serving']) * 100 / sq; return Number(v) || 0; };
  let kcal = val('energy-kcal'); if (!kcal) { const kj = val('energy-kj') || val('energy'); if (kj) kcal = kj / 4.184; }
  let na = val('sodium') * 1000; if (!na && val('salt')) na = val('salt') * 400;
  const base = (P.product_name_en || P.product_name || P.product_name_fr || 'Product').trim();
  const brand = (P.brands || '').split(',')[0].trim();
  const food = { id: 'b' + code, barcode: code, name: base + (brand && !base.toLowerCase().includes(brand.toLowerCase()) ? ' (' + brand + ')' : ''), brand, per: 100, kcal, p: val('proteins'), c: val('carbohydrates'), f: val('fat'), fib: val('fiber'), sug: val('sugars'), na, servings: sq ? [[(P.serving_size || '1 serving').replace(/\s*\(.*\)\s*$/, ''), Math.round(sq * 10) / 10]] : [], src: 'off' };
  if (!kcal && !food.p && !food.c && !food.f) throw new Error(`Open Food Facts lists "${base}" but has no nutrition numbers for it. Snap the label under Photo instead.`);
  return food;
}
function viewScan(meal) {
  const vid = el('video', { playsinline: '', muted: '', autoplay: '', style: 'width:100%;max-height:44vh;object-fit:cover;border-radius:12px;background:#000' });
  const status = el('div', { class: 'hint' }, 'Starting camera…');
  const manual = el('input', { id: 'bc', inputmode: 'numeric', placeholder: 'e.g. 0628915001235', autocomplete: 'off' });
  const go = el('button', { class: 'btn ghost', style: 'align-self:flex-end', onclick: () => { if (manual.value.trim()) onCode(manual.value.trim()); } }, 'Look up');
  const again = el('button', { class: 'btn ghost', hidden: '', onclick: () => start() }, 'Scan again');
  const wrap = el('div', { class: 'stack' }, vid, status, again, el('div', { class: 'row' }, field('Or type the barcode', manual), go), el('div', { class: 'hint' }, 'Products come from Open Food Facts (free, community-built). Anything you log is saved to My foods so it works offline next time.'));
  let stream = null, timer = 0, reader = null, active = false;
  const stop = () => { active = false; clearInterval(timer); if (reader) { try { reader.reset(); } catch (e) {} reader = null; } if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } vid.srcObject = null; };
  openAdd.stop = stop;
  const onCode = async code => {
    if (!active && !code) return; stop(); if (navigator.vibrate) navigator.vibrate(40);
    status.textContent = 'Looking up ' + code + '…'; again.hidden = true;
    try { const food = await lookupBarcode(code); openQuantity(food, meal); }
    catch (e) { status.textContent = e.message; again.hidden = false; }
  };
  const start = async () => {
    stop(); again.hidden = true; status.textContent = 'Starting camera…';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { status.textContent = 'This browser has no camera access — type the barcode instead.'; return; }
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); vid.srcObject = stream; await vid.play(); }
    catch (e) { status.textContent = 'Camera not available (' + (e.name || e.message) + ') — type the barcode instead.'; return; }
    active = true; status.textContent = 'Point the camera at the barcode.';
    if ('BarcodeDetector' in window) {
      let det; try { det = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] }); } catch (e) { det = new BarcodeDetector(); }
      timer = setInterval(async () => { if (!active || vid.readyState < 2) return; try { const r = await det.detect(vid); if (r && r[0] && r[0].rawValue) onCode(r[0].rawValue); } catch (e) {} }, 250);
    } else {
      try {
        await loadScript('https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js');
        if (!active) return;
        const hints = new Map(); hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E, ZXing.BarcodeFormat.CODE_128]); hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
        reader = new ZXing.BrowserMultiFormatReader(hints, 300);
        reader.decodeFromStream(stream, vid, (result) => { if (result && active) onCode(result.getText()); });
      } catch (e) { status.textContent = e.message || 'Barcode scanning is not available here — type the barcode instead.'; }
    }
  };
  start();
  return wrap;
}

// ---------- Saved meals & recipes ----------
async function saveMeals() { await store.set('foods/meals', { items: S.meals.map(m => ({ ...m, items: m.items.map(i => ({ ...i, lc: undefined })) })) }); }
const sumItems = items => items.reduce((t, e) => { for (const k of ['kcal', 'p', 'c', 'f', 'fib', 'sug', 'na']) t[k] += e[k] || 0; t.grams += e.grams || 0; if (e.m) { t.m = t.m || {}; for (const k in e.m) t.m[k] = (t.m[k] || 0) + (e.m[k] || 0); } return t; }, { kcal: 0, p: 0, c: 0, f: 0, fib: 0, sug: 0, na: 0, grams: 0 });
function recipeFoods() {
  return S.meals.filter(m => m.type === 'recipe').map(m => { const t = sumItems(m.items); const sv = Math.max(1, m.servings || 1); const per = Math.round(t.grams / sv) || 100;
    return { id: 'r' + m.id, name: m.name, per, kcal: t.kcal / sv, p: t.p / sv, c: t.c / sv, f: t.f / sv, fib: t.fib / sv, sug: t.sug / sv, na: t.na / sv, m: t.m ? Object.fromEntries(Object.entries(t.m).map(([k, v]) => [k, v / sv])) : undefined, servings: [['serving', per]], src: 'recipe', lc: m.name.toLowerCase(), group: 'Recipe' }; });
}
const stripEntry = e => ({ name: e.name, foodId: e.foodId || null, qty: e.qty, unitLabel: e.unitLabel, grams: e.grams, kcal: e.kcal, p: e.p, c: e.c, f: e.f, fib: e.fib || 0, sug: e.sug || 0, na: e.na || 0, src: e.src || 'usda', m: e.m || undefined });
function saveMealFromEntries(meal, es) {
  const name = el('input', { id: 'mn', placeholder: 'e.g. Weekday breakfast', value: meal + ' · ' + fmtDate(S.date) });
  openSheet('Save as meal', el('div', { class: 'stack' }, el('div', { class: 'hint' }, `Saves these ${es.length} items so you can log them again with one tap (Add → Meals).`), field('Name', name)),
    el('button', { class: 'btn', onclick: async () => { S.meals.unshift({ id: uid(), name: name.value.trim() || 'Meal', type: 'meal', items: es.map(stripEntry), created: Date.now() }); await saveMeals(); closeSheet(); toast('Meal saved'); } }, 'Save meal'));
  setTimeout(() => { name.focus(); name.select(); }, 50);
}
async function logSavedMeal(m, meal, mult) {
  const day = await loadDay(S.date); let k = 0;
  for (const it of m.items) { const e = { ...it, id: uid(), meal, ts: Date.now() }; for (const key of ['kcal', 'p', 'c', 'f', 'fib', 'sug', 'na', 'grams']) e[key] = (it[key] || 0) * mult; if (it.m) { e.m = {}; for (const key in it.m) e.m[key] = (it.m[key] || 0) * mult; } e.qty = it.qty ? it.qty * mult : e.grams; k += e.kcal; day.entries.push(e); }
  await saveDay(S.date); closeSheet(); renderToday(); toast('Logged ' + m.name + ' · ' + r0(k) + ' kcal');
}
function mealRow(m, onTap) {
  const t = sumItems(m.items); const sv = m.type === 'recipe' ? Math.max(1, m.servings || 1) : 1;
  return el('button', { class: 'res', onclick: onTap },
    el('div', { class: 'n' }, m.name), el('div', { class: 'g' }, (m.type === 'recipe' ? `Recipe · ${sv} serving${sv > 1 ? 's' : ''} · ` : 'Meal · ') + m.items.length + ' item' + (m.items.length === 1 ? '' : 's') + ` · P ${r0(t.p / sv)} · C ${r0(t.c / sv)} · F ${r0(t.f / sv)}`),
    el('div', { class: 'k' }, r0(t.kcal / sv) + ' kcal'));
}
function viewMeals(meal) {
  const wrap = el('div', { class: 'stack' });
  wrap.append(el('div', { class: 'row' }, el('button', { class: 'btn ghost', onclick: () => openRecipeBuilder({ type: 'meal' }) }, '+ New meal'), el('button', { class: 'btn ghost', onclick: () => openRecipeBuilder({ type: 'recipe' }) }, '+ New recipe')));
  if (!S.meals.length) wrap.append(el('div', { class: 'hint' }, 'No saved meals yet. Log a meal on the Today screen, then tap "Save meal" on it — or build a recipe from ingredients here. Recipes also show up in Search.'));
  const list = el('div', { class: 'results' });
  for (const m of S.meals) list.append(mealRow(m, () => {
    if (m.type === 'recipe') { const f = recipeFoods().find(x => x.id === 'r' + m.id); if (f) openQuantity(f, meal); return; }
    const mealSel = el('select', { id: 'mealSel3' }); S.settings.meals.forEach(x => mealSel.append(el('option', { value: x, selected: x === meal ? '' : null }, x)));
    const mult = el('input', { id: 'mult', type: 'number', step: 'any', min: '0', inputmode: 'decimal', value: 1 });
    const l = el('div', { class: 'list' }); for (const it of m.items) l.append(el('div', { class: 'li' }, el('div', {}, it.name, el('div', { class: 's' }, r0(it.grams) + ' g · ' + r0(it.kcal) + ' kcal'))));
    openSheet(m.name, el('div', { class: 'stack' }, l, el('div', { class: 'row' }, field('Portion (× the saved amount)', mult), field('Meal', mealSel))),
      el('button', { class: 'btn', onclick: () => logSavedMeal(m, mealSel.value, parseFloat(mult.value) || 1) }, 'Log all ' + m.items.length + ' items'));
  }));
  wrap.append(list);
  return wrap;
}
function openRecipeBuilder(rec) {
  rec.items = rec.items || []; rec.type = rec.type || 'recipe';
  const isR = rec.type === 'recipe';
  const name = el('input', { id: 'rn', value: rec.name || '', placeholder: isR ? 'e.g. Chicken curry (whole pot)' : 'e.g. Post-practice snack', oninput: () => rec.name = name.value });
  const sv = el('input', { id: 'rs', type: 'number', min: '1', step: '1', inputmode: 'numeric', value: rec.servings || 1, oninput: () => { rec.servings = parseFloat(sv.value) || 1; paint(); } });
  const list = el('div', { class: 'list' }); const tot = el('div', { class: 'preview' });
  const paint = () => {
    list.innerHTML = '';
    rec.items.forEach((it, i) => list.append(el('div', { class: 'li' }, el('div', {}, it.name, el('div', { class: 's' }, (it.unitLabel === 'g' ? '' : `${it.qty} ${it.unitLabel} · `) + r0(it.grams) + ' g · ' + r0(it.kcal) + ' kcal')),
      el('button', { class: 'del', onclick: () => { rec.items.splice(i, 1); paint(); } }, 'Remove'))));
    if (!rec.items.length) list.append(el('div', { class: 'empty' }, 'No ingredients yet.'));
    const t = sumItems(rec.items); const n = Math.max(1, isR ? (rec.servings || 1) : 1); const per = {}; for (const k in t) per[k] = t[k] / n;
    tot.innerHTML = ''; tot.append(el('div', {}, el('div', { class: 'num big' }, r0(per.kcal) + ' kcal'), el('div', { class: 'hint' }, (isR ? 'per serving · ' : 'total · ') + r0(per.grams) + ' g')), el('div', {}, nutGrid(per)));
  };
  paint();
  const addBtn = el('button', { class: 'btn ghost', onclick: () => {
    openSheet('Add ingredient', viewSearch(null, entry => { rec.items.push(stripEntry(entry)); openRecipeBuilder(rec); }));
    $('#sheetRoot .x').onclick = () => openRecipeBuilder(rec);
  } }, '+ Add ingredient');
  const body = el('div', { class: 'stack' }, field(isR ? 'Recipe name' : 'Meal name', name), isR ? field('Makes how many servings?', sv) : el('div', { class: 'hint' }, 'A saved meal logs all its items at once. Use a recipe instead when you cook a batch and eat portions of it.'), addBtn, list, tot);
  const foot = [];
  if (rec.id) foot.push(el('button', { class: 'btn danger', onclick: async () => { if (!confirm('Delete ' + (rec.name || 'this') + '?')) return; S.meals = S.meals.filter(m => m.id !== rec.id); await saveMeals(); closeSheet(); refreshView(); } }, 'Delete'));
  foot.push(el('button', { class: 'btn', onclick: async () => {
    rec.name = name.value.trim(); if (!rec.name) { toast('Give it a name'); return; } if (!rec.items.length) { toast('Add at least one ingredient'); return; }
    if (isR) rec.servings = Math.max(1, parseFloat(sv.value) || 1);
    if (rec.id) S.meals = S.meals.map(m => m.id === rec.id ? rec : m); else { rec.id = uid(); rec.created = Date.now(); S.meals.unshift(rec); }
    await saveMeals(); closeSheet(); refreshView(); toast('Saved');
  } }, 'Save'));
  openSheet(rec.id ? 'Edit ' + (isR ? 'recipe' : 'meal') : 'New ' + (isR ? 'recipe' : 'meal'), body, foot);
}
function mealsCard() {
  const c = el('div', { class: 'card stack' }, el('div', { class: 'section-h' }, el('h2', {}, 'Meals & recipes'), el('span', { class: 'hint' }, S.meals.length + ' saved')),
    el('div', { class: 'hint' }, 'Recipes are built from ingredients and logged per serving (they appear in Search). Meals are groups of items you log together in one tap.'),
    el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => openRecipeBuilder({ type: 'recipe' }) }, '+ New recipe'), el('button', { class: 'btn ghost', onclick: () => openRecipeBuilder({ type: 'meal' }) }, '+ New meal')));
  const list = el('div', { class: 'results' });
  for (const m of S.meals) list.append(mealRow(m, () => openRecipeBuilder(JSON.parse(JSON.stringify(m)))));
  if (!S.meals.length) list.append(el('div', { class: 'empty' }, 'Nothing saved yet.'));
  c.append(list); return c;
}

// ---------- Weight trend & target calculator ----------
function movingAvg(weights) {
  return weights.map(w => { const t = new Date(w.date).getTime(); const win = weights.filter(x => { const d = (t - new Date(x.date).getTime()) / 864e5; return d >= 0 && d < 7; }); return { date: w.date, avg: win.reduce((a, x) => a + x.weight, 0) / win.length }; });
}
function weightTrend(weights) {
  if (weights.length < 4) return null;
  const ma = movingAvg(weights); const last = ma[ma.length - 1]; const t1 = new Date(last.date).getTime();
  const start = ma.find(x => (t1 - new Date(x.date).getTime()) / 864e5 <= 28); if (!start || start === last) return null;
  const days = (t1 - new Date(start.date).getTime()) / 864e5; if (days < 6) return null;
  const rate = (last.avg - start.avg) / days * 7; const st = S.settings;
  let text = `Trend ${rate > 0 ? '+' : ''}${rate.toFixed(2)} kg/week over ${r0(days)} days · 7-day average ${last.avg.toFixed(1)} kg.`;
  if (st.goalWeight) {
    const diff = st.goalWeight - last.avg;
    if (Math.abs(diff) < 0.3) text += ' You are at your goal weight.';
    else if (diff * rate > 0 && Math.abs(rate) > 0.03) { const d = new Date(t1 + diff / rate * 7 * 864e5); text += ` At this pace you reach ${st.goalWeight} kg around ${d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' })}.`; }
    else text += ` ${Math.abs(diff).toFixed(1)} kg to go to ${st.goalWeight} kg — the trend is ${Math.abs(rate) <= 0.03 ? 'flat' : 'moving the other way'}.`;
  }
  return { rate, avg: last.avg, text };
}
const ACT_LEVELS = [['1.2', 'Sedentary — desk job, little exercise'], ['1.375', 'Lightly active — 1–3 workouts a week'], ['1.55', 'Moderately active — 3–5 workouts a week'], ['1.725', 'Very active — 6–7 workouts a week'], ['1.9', 'Athlete or physical job']];
const GOAL_RATES = [['-0.75', 'Lose 0.75 kg a week (aggressive)'], ['-0.5', 'Lose 0.5 kg a week'], ['-0.25', 'Lose 0.25 kg a week (gentle)'], ['0', 'Maintain weight'], ['0.25', 'Gain 0.25 kg a week']];
function calculatorCard(st, save) {
  const pr = st.profile || {};
  const sel = (id, opts, cur) => { const s = el('select', { id }); opts.forEach(([v, l]) => s.append(el('option', { value: v, selected: String(cur) === v ? '' : null }, l))); return s; };
  const sex = sel('p_sex', [['m', 'Male'], ['f', 'Female']], pr.sex || 'm');
  const age = el('input', { id: 'p_age', type: 'number', inputmode: 'numeric', value: pr.age || '', placeholder: 'years' });
  const ht = el('input', { id: 'p_ht', type: 'number', inputmode: 'numeric', value: pr.height || '', placeholder: 'cm' });
  const wt = el('input', { id: 'p_wt', type: 'number', step: '0.1', inputmode: 'decimal', value: pr.weight || S.lastWeight || '', placeholder: 'kg' });
  const act = sel('p_act', ACT_LEVELS, pr.act || '1.375');
  const rate = sel('p_rate', GOAL_RATES, pr.rate || '-0.5');
  const goal = el('input', { id: 'p_goal', type: 'number', step: '0.1', inputmode: 'decimal', value: st.goalWeight || '', placeholder: 'kg (optional)' });
  const out = el('div', { class: 'preview' }); const note = el('div', { class: 'hint' });
  let plan = null;
  const calc = () => {
    const a = parseFloat(age.value), h = parseFloat(ht.value), w = parseFloat(wt.value); plan = null; out.innerHTML = '';
    if (!(a > 0 && h > 0 && w > 0)) { note.textContent = 'Fill in age, height and weight to get a suggestion.'; return; }
    const bmr = 10 * w + 6.25 * h - 5 * a + (sex.value === 'm' ? 5 : -161); const tdee = bmr * parseFloat(act.value);
    const r = parseFloat(rate.value); let kcal = tdee + r * 7700 / 7; const floor = sex.value === 'm' ? 1500 : 1200; const floored = kcal < floor; if (floored) kcal = floor;
    const p = Math.round(Math.min(2.2, Math.max(1.6, r < 0 ? 2.0 : 1.7)) * w); const f = Math.round(kcal * 0.28 / 9); const c = Math.max(50, Math.round((kcal - p * 4 - f * 9) / 4)); const fib = Math.round(kcal / 1000 * 14);
    plan = { kcal: Math.round(kcal / 10) * 10, p, c, f, fib };
    out.append(el('div', {}, el('div', { class: 'num big' }, plan.kcal + ' kcal'), el('div', { class: 'hint' }, `maintenance ≈ ${r0(tdee)} kcal`)), el('div', {}, el('div', { class: 'nutgrid' }, el('span', {}, el('b', {}, p + ' g'), 'Protein'), el('span', {}, el('b', {}, c + ' g'), 'Carbs'), el('span', {}, el('b', {}, f + ' g'), 'Fat'), el('span', {}, el('b', {}, fib + ' g'), 'Fibre'))));
    note.textContent = (floored ? `Capped at ${floor} kcal — going lower is not advisable without medical supervision. ` : '') + `Mifflin-St Jeor BMR ${r0(bmr)} kcal × activity ${act.value}${r ? `, ${r > 0 ? '+' : ''}${r0(r * 7700 / 7)} kcal/day for ${r > 0 ? 'gaining' : 'losing'} ${Math.abs(r)} kg/week` : ''}. Protein ${r < 0 ? '2.0' : '1.7'} g/kg, fat 28% of calories, carbs the rest. Re-run every few kilos.`;
  };
  [sex, age, ht, wt, act, rate].forEach(i => i.addEventListener('input', calc)); calc();
  goal.addEventListener('change', async () => { st.goalWeight = parseFloat(goal.value) || null; await save(); toast('Goal weight saved'); });
  const apply = el('button', { class: 'btn', onclick: async () => { if (!plan) { toast('Fill in age, height and weight first'); return; }
    Object.assign(st, plan); st.profile = { sex: sex.value, age: parseFloat(age.value), height: parseFloat(ht.value), weight: parseFloat(wt.value), act: act.value, rate: rate.value }; st.goalWeight = parseFloat(goal.value) || null;
    await save(); renderSettings(); toast('Targets updated'); } }, 'Use these targets');
  return el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Target calculator'),
    el('div', { class: 'hint' }, 'Suggests daily targets from your body and goal. Applying overwrites the targets above.'),
    el('div', { class: 'row' }, field('Sex', sex), field('Age', age)), el('div', { class: 'row' }, field('Height (cm)', ht), field('Weight (kg)', wt)),
    field('Activity', act), field('Goal', rate), field('Goal weight', goal), out, note, apply);
}

// ---------- Micronutrients ----------
// key, label, unit, daily target [male, female] (Health Canada / IOM DRIs for adults)
const MICROS = [['ca', 'Calcium', 'mg', [1000, 1000]], ['fe', 'Iron', 'mg', [8, 18]], ['k', 'Potassium', 'mg', [3400, 2600]], ['mg', 'Magnesium', 'mg', [420, 320]], ['zn', 'Zinc', 'mg', [11, 8]], ['vd', 'Vitamin D', 'µg', [20, 20]], ['b12', 'Vitamin B12', 'µg', [2.4, 2.4]], ['vc', 'Vitamin C', 'mg', [90, 75]], ['fol', 'Folate', 'µg', [400, 400]]];
const microTarget = k => { const m = MICROS.find(x => x[0] === k); const f = (S.settings.profile || {}).sex === 'f'; return m ? m[3][f ? 1 : 0] : 0; };
const microTotals = entries => { const t = {}; let known = 0; for (const e of entries) { if (e.m) { known++; for (const k in e.m) t[k] = (t[k] || 0) + (e.m[k] || 0); } } return { t, known, total: entries.length }; };
const fmtMicro = (k, v) => k === 'ca' || k === 'k' || k === 'mg' || k === 'fol' ? r0(v) : Math.round(v * 10) / 10;
function nutrientsCard(day) {
  const { t, known, total } = microTotals(day.entries);
  const open = (() => { try { return localStorage.getItem('pl:micro_open') === '1'; } catch (e) { return false; } })();
  const body = el('div', { class: 'stack', hidden: open ? null : '' });
  for (const [k, label, unit] of MICROS) { const tg = microTarget(k); const v = t[k] || 0; const pct = tg ? Math.min(v / tg, 1) * 100 : 0;
    body.append(el('div', { class: 'macro' }, el('div', { class: 'lbl' }, el('span', {}, label), el('b', {}, fmtMicro(k, v) + ' / ' + tg + ' ' + unit)), el('div', { class: 'bar' }, el('i', { style: 'width:' + pct + '%;background:' + (pct >= 100 ? 'var(--accent)' : pct >= 50 ? 'var(--c)' : 'var(--over)') })))); }
  body.append(el('div', { class: 'hint' }, total ? (known === total ? 'From the food database (CNF/USDA). Estimates from photos and quick-add foods don’t carry vitamins and minerals.' : `${known} of ${total} items have vitamin/mineral data — photo estimates, scanned and quick-add foods don’t.`) : 'Log foods from the database to see vitamins and minerals.'));
  const tog = el('button', { class: 'chip', onclick: () => { body.hidden = !body.hidden; tog.textContent = body.hidden ? 'Show' : 'Hide'; try { localStorage.setItem('pl:micro_open', body.hidden ? '0' : '1'); } catch (e) {} } }, open ? 'Hide' : 'Show');
  const low = MICROS.filter(([k]) => total && (t[k] || 0) < microTarget(k) * 0.5).map(m => m[1]);
  return el('div', { class: 'card stack' }, el('div', { class: 'section-h' }, el('h2', {}, 'Vitamins & minerals'), tog), !body.hidden ? null : el('div', { class: 'hint' }, total ? (low.length ? 'Under half target so far: ' + low.slice(0, 4).join(', ') + (low.length > 4 ? '…' : '') : 'On track across the board.') : 'Log foods to see them.'), body);
}

// ---------- Weekly budget (calorie banking) ----------
const weekStartOf = ds => { const [y, m, d] = ds.split('-').map(Number); const dt = new Date(y, m - 1, d); const dow = (dt.getDay() + 6) % 7; return addDays(ds, -dow); };
async function weekBudget(date) {
  const st = S.settings; const start = weekStartOf(date); const days = []; for (let i = 0; i < 7; i++) days.push(addDays(start, i));
  const idx = days.indexOf(date); let past = 0, pastLogged = 0;
  for (let i = 0; i < idx; i++) { const d = await loadDay(days[i]); if (d.entries.length) { past += totals(d).kcal - (st.netMode ? burned(d) : 0); pastLogged++; } else past += st.kcal; }
  const today = await loadDay(date); const todayK = totals(today).kcal - (st.netMode ? burned(today) : 0);
  const budget = st.kcal * 7; const remainingDays = 7 - idx; const allowance = (budget - past) / remainingDays; const bank = st.kcal * idx - past;
  return { start, idx, past, pastLogged, todayK, budget, remainingDays, allowance, bank, todayLeft: allowance - todayK };
}
function weekCard(wb) {
  const st = S.settings; const over = wb.allowance < st.kcal * 0.7;
  const line = wb.idx === 0 ? `New week. Budget ${r0(wb.budget).toLocaleString()} kcal for 7 days.` : `${wb.bank >= 0 ? r0(wb.bank).toLocaleString() + ' kcal banked' : r0(-wb.bank).toLocaleString() + ' kcal over'} from ${wb.idx} day${wb.idx > 1 ? 's' : ''} → ${r0(wb.allowance).toLocaleString()} kcal/day for the remaining ${wb.remainingDays} day${wb.remainingDays > 1 ? 's' : ''}` + (wb.pastLogged < wb.idx ? ` (${wb.idx - wb.pastLogged} unlogged day${wb.idx - wb.pastLogged > 1 ? 's' : ''} counted at target)` : '') + '.';
  const pct = Math.min(1, Math.max(0, (wb.past + wb.todayK) / wb.budget)) * 100;
  return el('div', { class: 'card stack' }, el('div', { class: 'section-h' }, el('h2', {}, 'This week'), el('span', { class: 'hint' }, `${r0(wb.past + wb.todayK).toLocaleString()} / ${r0(wb.budget).toLocaleString()} kcal`)),
    el('div', { class: 'bar' }, el('i', { class: over ? 'over' : '', style: 'width:' + pct + '%' })),
    el('div', { class: 'hint' }, line), over ? el('div', { class: 'hint' }, 'Tip: a weekly budget lets a big day be balanced by lighter ones — no need to “make it up” all at once.') : null);
}

// ---------- Adaptive expenditure (compare what you ate with how your weight moved) ----------
async function expenditureEstimate() {
  const days = (await store.recentDays(35)).filter(d => d.date >= addDays(todayStr(), -28) && d.date < todayStr()).sort((a, b) => a.date.localeCompare(b.date));
  const logged = days.filter(d => d.entries.length >= 1 && totals(d).kcal >= 600);
  const weights = days.filter(d => d.weight);
  if (logged.length < 10 || weights.length < 6) return { ok: false, reason: `Needs at least 10 fully logged days and 6 weigh-ins in the last 4 weeks (have ${logged.length} and ${weights.length}).` };
  const span = (new Date(weights[weights.length - 1].date) - new Date(weights[0].date)) / 864e5; if (span < 13) return { ok: false, reason: 'Weigh-ins need to span at least two weeks.' };
  const ma = movingAvg(weights); const rate = (ma[ma.length - 1].avg - ma[0].avg) / span * 7; // kg/week
  const avgIntake = logged.reduce((a, d) => a + totals(d).kcal, 0) / logged.length;
  const observed = avgIntake - rate * 7700 / 7;
  const pr = S.settings.profile || {}; let formula = null;
  if (pr.age && pr.height) { const w = ma[ma.length - 1].avg; formula = (10 * w + 6.25 * pr.height - 5 * pr.age + (pr.sex === 'f' ? -161 : 5)) * parseFloat(pr.act || 1.375); }
  const conf = Math.min(1, (logged.length / 21) * Math.min(1, span / 21)); // 0..1
  const tdee = formula ? conf * observed + (1 - conf) * formula : observed;
  return { ok: true, tdee: Math.round(tdee / 10) * 10, observed: Math.round(observed), formula: formula && Math.round(formula), avgIntake: Math.round(avgIntake), rate, logged: logged.length, weighIns: weights.length, span: Math.round(span), conf };
}
function makePlan(kcal, w, r, sex) {
  const floor = sex === 'f' ? 1200 : 1500; if (kcal < floor) kcal = floor;
  const p = Math.round(Math.min(2.2, Math.max(1.6, r < 0 ? 2.0 : 1.7)) * w); const f = Math.round(kcal * 0.28 / 9); const c = Math.max(50, Math.round((kcal - p * 4 - f * 9) / 4)); const fib = Math.round(kcal / 1000 * 14);
  return { kcal: Math.round(kcal / 10) * 10, p, c, f, fib };
}
async function applyAdaptive(est, silent) {
  const st = S.settings; const pr = st.profile || {}; const r = parseFloat(pr.rate || 0); const w = pr.weight || S.lastWeight || 80;
  const plan = makePlan(est.tdee + r * 7700 / 7, w, r, pr.sex); const old = st.kcal; Object.assign(st, plan); st.lastAdjust = todayStr(); st.tdee = est.tdee;
  await store.set('settings/main', st); if (!silent) toast(`Target ${old} → ${plan.kcal} kcal`); return plan;
}
async function adaptiveCard() {
  const st = S.settings; const est = await expenditureEstimate(); const pr = st.profile || {};
  const c = el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Adaptive maintenance'));
  if (!est.ok) { c.append(el('div', { class: 'hint' }, 'Works out what you really burn by comparing what you ate with how your weight moved. ' + est.reason)); return c; }
  const r = parseFloat(pr.rate || 0); const suggested = makePlan(est.tdee + r * 7700 / 7, pr.weight || S.lastWeight || 80, r, pr.sex);
  c.append(el('div', { class: 'preview' }, el('div', {}, el('div', { class: 'num big' }, est.tdee.toLocaleString() + ' kcal'), el('div', { class: 'hint' }, 'estimated daily burn')), el('div', {}, el('div', { class: 'hint' }, `You averaged ${est.avgIntake.toLocaleString()} kcal/day over ${est.logged} logged days while your weight trend moved ${est.rate > 0 ? '+' : ''}${est.rate.toFixed(2)} kg/week.`))),
    el('div', { class: 'hint' }, `Observed burn ${est.observed.toLocaleString()} kcal` + (est.formula ? ` blended ${r0(est.conf * 100)}% with the formula estimate (${est.formula.toLocaleString()}); more logged days = more weight on real data.` : '. Fill in the target calculator under Settings to blend with a formula estimate.') + ` Suggested target for “${(GOAL_RATES.find(g => g[0] === (pr.rate || '0')) || ['', 'maintain'])[1].toLowerCase()}”: ${suggested.kcal} kcal (current ${st.kcal}).`));
  const auto = el('input', { type: 'checkbox', id: 'autoAdj', checked: st.autoAdjust ? '' : null }); auto.addEventListener('change', async () => { st.autoAdjust = auto.checked; await store.set('settings/main', st); toast(auto.checked ? 'Targets will update every week' : 'Auto-adjust off'); });
  c.append(el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { await applyAdaptive(est); renderTrends(); } }, 'Use ' + suggested.kcal + ' kcal')), el('label', { class: 'hint' }, auto, ' Adjust my targets automatically every week', st.lastAdjust ? ` (last: ${st.lastAdjust})` : ''));
  return c;
}
async function maybeAutoAdjust() {
  const st = S.settings; if (!st.autoAdjust) return; if (st.lastAdjust && addDays(st.lastAdjust, 7) > todayStr()) return;
  const est = await expenditureEstimate(); if (!est.ok) return; const old = st.kcal; const plan = await applyAdaptive(est, true);
  if (plan.kcal !== old) toast(`Weekly check-in: target ${old} → ${plan.kcal} kcal (burn ≈ ${est.tdee})`); refreshView();
}

// ---------- Voice input ----------
function micButton(target) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return el('span', { class: 'hint' }, 'Tip: tap the microphone key on your keyboard to dictate.');
  let rec = null; const b = el('button', { class: 'chip', type: 'button' }, '🎤 Speak');
  b.onclick = () => {
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = 'en-CA'; rec.interimResults = true; rec.continuous = false; const base = target.value ? target.value.trim() + ' ' : '';
    rec.onresult = e => { let t = ''; for (const r of e.results) t += r[0].transcript; target.value = base + t; };
    rec.onend = () => { rec = null; b.textContent = '🎤 Speak'; target.dispatchEvent(new Event('input')); };
    rec.onerror = e => { toast(e.error === 'not-allowed' ? 'Microphone access was blocked' : 'Could not hear that — try again'); };
    try { rec.start(); b.textContent = '■ Stop'; } catch (e) { rec = null; }
  };
  return b;
}

// ---------- Claude coach ----------
async function coachData(nDays) {
  const t = todayStr(); const out = []; const st = S.settings;
  for (let i = nDays; i >= 1; i--) { const ds = addDays(t, -i); const d = await loadDay(ds); if (!d.entries.length && !d.weight) continue; const tt = totals(d); const mt = microTotals(d.entries);
    out.push({ date: ds, kcal: r0(tt.kcal), protein: r0(tt.p), carbs: r0(tt.c), fat: r0(tt.f), fibre: r0(tt.fib), sugar: r0(tt.sug), sodium: r0(tt.na), weight: d.weight || undefined, activity_kcal: burned(d) || undefined, meals: st.meals.map(m => ({ meal: m, items: d.entries.filter(e => e.meal === m).map(e => e.name + ' ' + r0(e.kcal) + 'kcal') })).filter(m => m.items.length), low_micros: MICROS.filter(([k]) => mt.known && (mt.t[k] || 0) < microTarget(k) * 0.5).map(m => m[1]) }); }
  return { targets: { kcal: st.kcal, protein: st.p, carbs: st.c, fat: st.f, fibre: st.fib, sugar: st.sug, sodium: st.na, goal_weight: st.goalWeight || undefined, goal: (GOAL_RATES.find(g => g[0] === ((st.profile || {}).rate || '0')) || ['', ''])[1] }, days: out };
}
const COACH_PROMPT = data => `You are a supportive, evidence-based nutrition coach reviewing one person's food diary for the past week. Be specific and practical, refer to actual foods they logged, and keep a warm, non-judgmental tone. Do not give medical advice. Data (JSON): ${JSON.stringify(data)}
Reply with ONLY this JSON: {"headline":"one sentence overall verdict","wins":["2-3 specific things that went well"],"fixes":["2-3 specific, easy changes for next week, each naming a food or meal"],"pattern":"one sentence about a pattern you noticed (timing, weekends, a meal that is consistently low/high)","next_week":"one clear focus for next week"}`;
function coachCard() {
  const c = el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Weekly review by Claude'));
  const out = el('div', { class: 'stack' }); const last = store.lsGet('coach/last');
  const paint = r => { out.innerHTML = ''; if (!r) return; out.append(el('div', {}, el('strong', {}, r.headline || '')), el('div', { class: 'hint' }, 'Review of the week to ' + (r.date || '')));
    const sec = (title, items) => { if (!items || !items.length) return; out.append(el('div', {}, el('b', {}, title)), el('ul', { style: 'margin:4px 0 0 18px;padding:0' }, ...items.map(x => el('li', { style: 'margin:3px 0' }, x)))); };
    sec('What went well', r.wins); sec('Easy fixes', r.fixes); if (r.pattern) out.append(el('div', {}, el('b', {}, 'Pattern'), ' ', r.pattern)); if (r.next_week) out.append(el('div', { class: 'warn' }, 'Focus for next week: ' + r.next_week)); };
  paint(last);
  const status = el('div', { class: 'hint' });
  const go = el('button', { class: 'btn', onclick: async () => { if (!(S.settings.apiKey || '').trim()) { status.textContent = AI_ERR.no_key; return; } go.disabled = true; status.innerHTML = ''; status.append(el('span', { class: 'spin' }), 'Claude is reading your week…');
    try { const data = await coachData(7); if (data.days.length < 3) throw { code: 'few', message: 'Log at least 3 days first.' }; const r = await askClaude(COACH_PROMPT(data), null); r.date = todayStr(); await store.set('coach/last', r); paint(r); status.textContent = ''; }
    catch (e) { status.textContent = AI_ERR[e.code] || e.message || 'Something went wrong.'; } finally { go.disabled = false; } } }, last ? 'Run a new review' : 'Review my week');
  c.append(el('div', { class: 'hint' }, 'Sends the last 7 days of your diary (foods, totals, weight — nothing else) to Claude with your own API key and gets back what worked, what to fix, and one focus for next week.'), out, go, status);
  return c;
}
const SUGGEST_PROMPT = (ctx) => `You are a practical nutrition coach. Suggest what this person could eat next. Context (JSON): ${JSON.stringify(ctx)}
Rules: fit within the remaining calories and macro gaps for today (prioritise the macro furthest behind, usually protein), prefer foods they have eaten before or saved when sensible, keep it realistic for a home kitchen in Ontario, and give real portion sizes.
Reply with ONLY this JSON: {"suggestions":[{"name":"short dish name with portions","grams":350,"kcal":520,"protein":40,"carbs":45,"fat":18,"fibre":6,"sugar":5,"sodium":600,"why":"one short sentence"}]} with exactly 3 suggestions ordered by fit.`;
async function suggestMeal(meal) {
  const day = await loadDay(S.date); const st = S.settings; const t = totals(day); const goal = st.kcal + (st.netMode ? burned(day) : 0);
  const ctx = { meal, remaining: { kcal: r0(goal - t.kcal), protein: r0(st.p - t.p), carbs: r0(st.c - t.c), fat: r0(st.f - t.f), fibre: r0(st.fib - t.fib) }, eaten_today: day.entries.map(e => e.name), saved_foods: S.custom.slice(0, 25).map(f => f.name), recipes: S.meals.filter(m => m.type === 'recipe').slice(0, 15).map(m => m.name), recent: S.recent.slice(0, 15).map(f => f.name), time: new Date().getHours() };
  const status = el('div', { class: 'status' }); const out = el('div', { class: 'stack' });
  openSheet('What should I eat?', el('div', { class: 'stack' }, el('div', { class: 'hint' }, `${ctx.remaining.kcal} kcal and ${ctx.remaining.protein} g protein left today.`), status, out));
  if (!(st.apiKey || '').trim()) { status.textContent = AI_ERR.no_key; return; }
  status.append(el('span', { class: 'spin' }), 'Claude is thinking…');
  try { const r = await askClaude(SUGGEST_PROMPT(ctx), null); status.textContent = '';
    for (const s of (r.suggestions || []).slice(0, 3)) {
      const n = { kcal: +s.kcal || 0, p: +s.protein || 0, c: +s.carbs || 0, f: +s.fat || 0, fib: +s.fibre || 0, sug: +s.sugar || 0, na: +s.sodium || 0 };
      out.append(el('div', { class: 'card stack', style: 'background:var(--surface2)' }, el('div', {}, el('strong', {}, s.name), el('div', { class: 'hint' }, s.why || '')), el('div', { class: 'hint' }, `${r0(n.kcal)} kcal · P ${r0(n.p)} · C ${r0(n.c)} · F ${r0(n.f)}`),
        el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { const d = await loadDay(S.date); d.entries.push({ id: uid(), meal, name: s.name, qty: r0(+s.grams || 0) || 1, unitLabel: s.grams ? 'g' : 'serving', grams: +s.grams || 0, ...n, src: 'ai', ts: Date.now() }); await saveDay(S.date); closeSheet(); renderToday(); toast('Logged · ' + r0(n.kcal) + ' kcal'); } }, 'Log this'), el('button', { class: 'btn ghost', onclick: () => openAdd(meal, 'describe', s.name) }, 'Adjust first'))));
    }
  } catch (e) { status.textContent = AI_ERR[e.code] || ('Something went wrong (' + (e.message || e.code) + ').'); }
}

// ---------- Apple Health / Shortcuts hand-off ----------
// A Shortcut opens https://mvb1610.github.io/plate-ledger/#health=weight:84.6,active:520,steps:9100,date:2026-09-20
async function handleHealthUrl() {
  const m = (location.hash + location.search).match(/health=([^&]+)/); if (!m) return false;
  history.replaceState(null, '', location.pathname);
  const kv = {}; for (const part of decodeURIComponent(m[1]).split(',')) { const [k, v] = part.split(':'); if (k && v !== undefined) kv[k.trim().toLowerCase()] = v.trim(); }
  let date = kv.date && /^\d{4}-\d{2}-\d{2}$/.test(kv.date) ? kv.date : todayStr(); const day = await loadDay(date); const done = [];
  const w = parseFloat(kv.weight); if (w > 20 && w < 400) { day.weight = Math.round(w * 10) / 10; done.push(day.weight + ' kg'); }
  const a = parseFloat(kv.active); if (a > 0 && a < 6000) { day.exercise = (day.exercise || []).filter(x => x.src !== 'health'); day.exercise.push({ id: uid(), name: 'Apple Health · active energy' + (kv.steps ? ` · ${parseInt(kv.steps).toLocaleString()} steps` : ''), min: 0, kcal: Math.round(a), src: 'health' }); done.push(Math.round(a) + ' kcal active'); }
  if (done.length) { await saveDay(date); S.date = date; toast('From Apple Health (' + fmtDate(date) + '): ' + done.join(', ')); }
  return true;
}
function healthCard() {
  const url = APP_URL + '#health=weight:84.6,active:520,steps:9100,date:' + todayStr();
  return el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Apple Health (via Shortcuts)'),
    el('div', { class: 'hint' }, 'A web app can’t read Apple Health directly, but the Shortcuts app can and can hand the numbers to Plate Ledger through a link. One-time setup on your iPhone, then it runs by itself every morning:'),
    el('ol', { style: 'margin:0 0 0 18px;padding:0;font-size:14px;line-height:1.5' },
      el('li', {}, 'Open the link below once in Safari and sign in with Google there too (Safari and the home-screen app keep separate storage; the cloud joins them).'),
      el('li', {}, 'Shortcuts → Automation → + → Time of Day, 7:00, Daily → Run immediately.'),
      el('li', {}, 'Add action “Find Health Samples” (Weight, latest, limit 1) → “Get Details of Health Sample” (Value). Add “Find Health Samples” (Active Energy, Start Date is yesterday, group by day, Sum).'),
      el('li', {}, 'Add “Text”: ', el('code', {}, 'https://mvb1610.github.io/plate-ledger/#health=weight:[Weight],active:[Active Energy],date:[Yesterday formatted yyyy-MM-dd]'), ' — insert the variables.'),
      el('li', {}, 'Add “Open URLs” with that text. Done — each morning yesterday’s weigh-in and active calories land in your diary and sync everywhere.')),
    el('div', { class: 'hint' }, 'Format: ', el('code', {}, 'weight' ), ' in kg, ', el('code', {}, 'active'), ' in kcal, ', el('code', {}, 'steps'), ' optional, ', el('code', {}, 'date'), ' optional (defaults to today). Example:'),
    el('div', { class: 'row' }, el('input', { readonly: '', value: url, style: 'flex:1;font-size:12px' }), el('button', { class: 'btn ghost', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(url).then(() => toast('Copied')); } }, 'Copy')),
    el('div', { class: 'hint' }, 'Android: the same link works from Tasker/MacroDroid with Health Connect.'));
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
    (() => { const tr = weightTrend(weights); return el('div', { class: 'kpi' }, el('b', {}, tr ? (tr.rate > 0 ? '+' : '') + tr.rate.toFixed(2) : wChange === null ? '—' : (wChange > 0 ? '+' : '') + r1(wChange) + ' kg'), tr ? 'kg/week trend' : weights.length > 1 ? `since ${weights[0].date.slice(5)}` : 'weight trend'); })()));
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
    s += `<polygon points="${px(weights[0].date)},${H - padB} ${pts} ${px(weights[weights.length - 1].date)},${H - padB}" fill="var(--accent)" opacity=".10"/><polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.4" opacity=".55" stroke-linejoin="round"/>`;
    const ma = movingAvg(weights); if (ma.length > 1) s += `<polyline points="${ma.map(w => `${px(w.date).toFixed(1)},${py(w.avg).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--ink)" stroke-width="2.4" stroke-linejoin="round"/>`;
    if (st.goalWeight && st.goalWeight >= lo && st.goalWeight <= hi) s += `<line x1="${padL}" x2="${W - 8}" y1="${py(st.goalWeight)}" y2="${py(st.goalWeight)}" stroke="var(--ink)" stroke-dasharray="4 4" stroke-width="1"/><text x="${W - 10}" y="${py(st.goalWeight) - 4}" text-anchor="end">goal ${st.goalWeight}</text>`;
    const lw = weights[weights.length - 1]; s += `<circle cx="${px(lw.date)}" cy="${py(lw.weight)}" r="4" fill="var(--accent)"/><text x="${px(lw.date) - 6}" y="${py(lw.weight) - 8}" text-anchor="end">${lw.weight} kg</text>`;
    s += `<text x="${padL}" y="${H - 8}">${weights[0].date}</text><text x="${W - 8}" y="${H - 8}" text-anchor="end">${lw.date}</text></svg>`;
    wc.append(el('div', { html: s }));
    wc.append(el('div', { class: 'legend' }, el('span', {}, el('i', { style: 'background:var(--accent);opacity:.55' }), 'daily weigh-ins'), el('span', {}, el('i', { style: 'background:var(--ink)' }), '7-day trend')));
    const tr = weightTrend(weights); if (tr) wc.append(el('div', { class: 'hint' }, tr.text));
  }
  root.append(wc);
  root.append(await adaptiveCard());
  root.append(coachCard());
  root.append(microWeekCard(days));
  // macro split
  const mt = logged.length ? last14.filter(x => x.logged).map(x => totals(byDate[x.ds])) : [];
  if (mt.length) { const m = mt.reduce((a, t) => ({ p: a.p + t.p, c: a.c + t.c, f: a.f + t.f }), { p: 0, c: 0, f: 0 }); const kc = m.p * 4 + m.c * 4 + m.f * 9 || 1;
    root.append(el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Macro split · 14 days'),
      el('div', { class: 'bar', style: 'height:14px;display:flex' }, el('i', { style: `width:${m.p * 4 / kc * 100}%;background:var(--p);border-radius:0` }), el('i', { style: `width:${m.c * 4 / kc * 100}%;background:var(--c);border-radius:0` }), el('i', { style: `width:${m.f * 9 / kc * 100}%;background:var(--f);border-radius:0` })),
      el('div', { class: 'legend' }, el('span', {}, el('i', { style: 'background:var(--p)' }), `Protein ${r0(m.p * 4 / kc * 100)}%`), el('span', {}, el('i', { style: 'background:var(--c)' }), `Carbs ${r0(m.c * 4 / kc * 100)}%`), el('span', {}, el('i', { style: 'background:var(--f)' }), `Fat ${r0(m.f * 9 / kc * 100)}%`))));
  }
}

function microWeekCard(days) {
  const t = todayStr(); const recent = days.filter(d => d.date > addDays(t, -8) && d.date <= t && d.entries.length);
  const c = el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Vitamins & minerals · 7-day average'));
  if (!recent.length) { c.append(el('div', { class: 'hint' }, 'Nothing logged this week yet.')); return c; }
  const acc = {}; let known = 0, total = 0; for (const d of recent) { const mt = microTotals(d.entries); known += mt.known; total += mt.total; for (const k in mt.t) acc[k] = (acc[k] || 0) + mt.t[k]; }
  const low = [], ok = [];
  for (const [k, label, unit] of MICROS) { const avg = (acc[k] || 0) / recent.length; const tg = microTarget(k); const pct = tg ? avg / tg * 100 : 0; (pct < 70 ? low : ok).push({ k, label, unit, avg, pct }); }
  const row = x => el('div', { class: 'macro' }, el('div', { class: 'lbl' }, el('span', {}, x.label), el('b', {}, fmtMicro(x.k, x.avg) + ' ' + x.unit + ' · ' + r0(x.pct) + '%')), el('div', { class: 'bar' }, el('i', { style: 'width:' + Math.min(100, x.pct) + '%;background:' + (x.pct >= 100 ? 'var(--accent)' : x.pct >= 70 ? 'var(--c)' : 'var(--over)') })));
  if (low.length) c.append(el('div', { class: 'warn' }, 'Consistently under 70% of target: ' + low.map(x => x.label).join(', ') + '.'), ...low.map(row)); else c.append(el('div', { class: 'hint' }, 'Everything tracked is at or near target — nice.'));
  if (ok.length) c.append(el('div', { class: 'hint' }, 'On track: ' + ok.map(x => x.label + ' ' + r0(x.pct) + '%').join(' · ')));
  c.append(el('div', { class: 'hint' }, `Based on ${recent.length} logged day${recent.length > 1 ? 's' : ''}; ${total ? r0(known / total * 100) : 0}% of items carried vitamin/mineral data (database foods do, photo estimates and quick-adds don’t).`));
  return c;
}
// ---------- Settings ----------
function renderSettings() {
  const root = $('#scr-settings'); root.innerHTML = ''; const st = S.settings;
  const save = async () => { await store.set('settings/main', st); };
  const mk = (k, label, unit) => { const i = el('input', { id: 's_' + k, type: 'number', inputmode: 'numeric', value: st[k] }); i.addEventListener('change', async () => { st[k] = parseFloat(i.value) || DEFAULTS[k]; await save(); toast('Targets saved'); }); return field(label + ' (' + unit + ')', i); };
  const net = el('input', { type: 'checkbox', id: 'net', checked: st.netMode ? '' : null }); net.addEventListener('change', async () => { st.netMode = net.checked; await save(); });
  root.append(accountCard());
  root.append(el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Daily targets'),
    el('div', { class: 'row' }, mk('kcal', 'Calories', 'kcal'), mk('p', 'Protein', 'g')), el('div', { class: 'row' }, mk('c', 'Carbs', 'g'), mk('f', 'Fat', 'g')),
    el('div', { class: 'row' }, mk('fib', 'Fibre', 'g'), mk('sug', 'Sugar', 'g'), mk('na', 'Sodium', 'mg')),
    el('label', { class: 'hint' }, net, ' Add calories burned by logged activity to the daily goal'),
    el('div', { class: 'hint' }, 'Rule of thumb for a moderately active adult: maintenance ≈ 30–33 kcal per kg body weight; protein 1.6–2.2 g/kg if training.')));
  root.append(calculatorCard(st, save));
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
    el('div', { class: 'hint' }, cloud.user ? 'Your diary is saved to your Google account (private to you) and cached on this device. Backups are optional now.' : 'Until you sign in, your diary lives only in this browser on this device — clearing website data would erase it.'),
    el('div', { class: 'row' }, el('button', { class: 'btn ghost', onclick: exportCsv }, 'Export CSV'), el('button', { class: 'btn ghost', onclick: exportBackup }, 'Backup (JSON)')),
    el('button', { class: 'btn ghost', onclick: () => imp.click() }, 'Restore from backup'), imp,
    el('div', { class: 'hint' }, `Food database: ${CNF.length.toLocaleString()} Canadian Nutrient File + ${USDA.length.toLocaleString()} USDA foods. Version ${APP_VERSION}.`)));
  root.append(healthCard());
}
function accountCard() {
  const c = el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Cloud sync'));
  if (!cloud.ready) { c.append(el('div', { class: 'hint' }, 'Cloud sync is not available in this view (offline or blocked). Your data is still saved on this device.')); return c; }
  if (!cloud.user) {
    c.append(el('div', { class: 'hint' }, 'Sign in with your Google account to keep your diary safe and synced across your phone and computer. Nobody else can see your data.'),
      el('button', { class: 'btn', onclick: () => cloud.signIn() }, 'Sign in with Google'));
  } else {
    const st = el('div', { class: 'hint' });
    const paint = () => { st.textContent = cloud.status === 'syncing' ? 'Syncing…' : cloud.status === 'error' ? 'Sync problem: ' + (cloud.error || 'unknown') + ' — data is still saved on this device.' : cloud.lastSync ? 'Synced ' + new Date(cloud.lastSync).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : 'Synced'; };
    paint(); cloud.onChange(paint);
    c.append(el('div', {}, el('strong', {}, cloud.user.displayName || cloud.user.email), el('div', { class: 'hint' }, cloud.user.email)), st,
      el('button', { class: 'btn ghost', onclick: () => { if (confirm('Sign out? Your diary stays safe in your Google account, but will be removed from this device until you sign in again.')) cloud.signOut(); } }, 'Sign out'));
  }
  return c;
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
const APP_VERSION = '1.3.0';
(async () => {
  reloadStateFromLocal();
  cloud.init();
  const recent = await store.recentDays(30); const lw = recent.find(d => d.weight); if (lw) S.lastWeight = lw.weight;
  let tab = 'today'; try { tab = localStorage.getItem('pl:tab') || 'today'; } catch (e) {}
  if (await handleHealthUrl()) tab = 'today';
  showTab(tab);
  maybeAutoAdjust();
  await loadFoods();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
})();
