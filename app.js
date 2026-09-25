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

// ---------- Constants ----------
const PROJECT = 'plate-ledger-8007d';
const API_KEY = 'AIzaSyDcRdTEzGJa6YfFgesaefw90mHZZrTvaQo'; // public web key, restricted to this site
const GOOGLE_CLIENT_ID = '697214158009-bbkc4g24jr4kjharq5da3i5t26b9nfng.apps.googleusercontent.com';
const APP_URL = 'https://mvb1610.github.io/plate-ledger/';
const FS_ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const META = { settings_main: 'settings/main', foods_custom: 'foods/custom', foods_recent: 'foods/recent', foods_meals: 'foods/meals', coach_last: 'coach/last' };
const SYNCED = /^(days|settings|foods|coach)\//; // everything else in localStorage stays on this device

// ---------- Food database: fetched after the first screen is up; rows stay as compact arrays ----------
const MKEYS = ['ca', 'fe', 'k', 'mg', 'zn', 'vd', 'b12', 'vc', 'fol'];
const SRC_LABEL = { cnf: 'CNF', usda: 'USDA', custom: 'My food' };
const DB = { ready: false, rows: [], lc: [], nc: null, src: null, groups: [{}, {}], count: [0, 0], byId: null, promise: null };
function loadFoods() {
  if (DB.promise) return DB.promise;
  DB.promise = (async () => {
    const get = async f => { try { const r = await fetch(f); return r.ok ? await r.json() : null; } catch (e) { return null; } };
    const pause = () => new Promise(r => setTimeout(r, 0)); // keep taps responsive while 14,000 foods load
    const c = await get('data/cnf.json'); await pause();
    const u = await get('data/usda.json'); await pause();
    const parts = [[c, 0], [u, 1]].filter(p => p[0] && Array.isArray(p[0].foods));
    let n = 0; for (const [d] of parts) n += d.foods.length;
    const rows = new Array(n), lc = new Array(n), nc = new Uint8Array(n), src = new Uint8Array(n);
    let i = 0;
    for (const [d, s] of parts) for (const a of d.foods) {
      const l = String(a[1]).toLowerCase(); let k = 0, j = -1; while ((j = l.indexOf(',', j + 1)) >= 0) k++;
      rows[i] = a; lc[i] = l; nc[i] = k > 255 ? 255 : k; src[i] = s; i++;
    }
    Object.assign(DB, { rows, lc, nc, src, groups: [c && c.groups || {}, u && u.groups || {}], count: [c && c.foods ? c.foods.length : 0, u && u.foods ? u.foods.length : 0], byId: null, ready: n > 0 });
    if (!n) { DB.promise = null; toast('Food database failed to load — check your connection'); }
    return DB;
  })();
  return DB.promise;
}
function foodFromRow(i) {
  const a = DB.rows[i], s = DB.src[i];
  return { id: (s ? 'u' : 'c') + a[0], name: a[1], group: DB.groups[s][a[2]] || '', kcal: a[3], p: a[4], c: a[5], f: a[6], fib: a[7], sug: a[8], na: a[9], servings: a[10] || [], mi: a[11] && a[11].length ? a[11] : undefined, per: 100, src: s ? 'usda' : 'cnf', lc: DB.lc[i] };
}
function foodById(id) {
  if (!DB.ready || !id) return null;
  if (!DB.byId) { DB.byId = new Map(); for (let i = 0; i < DB.rows.length; i++) DB.byId.set((DB.src[i] ? 'u' : 'c') + DB.rows[i][0], i); }
  const i = DB.byId.get(id); return i === undefined ? null : foodFromRow(i);
}
const microOf = f => f.m || (f.mi && f.mi.length ? Object.fromEntries(MKEYS.map((k, i) => [k, f.mi[i] || 0])) : null);

// ---------- Local store: localStorage is the working copy; the cloud is the backup and the bridge between devices ----------
const store = {
  days: new Set(),    // dates that have a day document on this device
  evicted: new Set(), // old days trimmed off this device to free space (they're still in the cloud)
  init() {
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('pl:days/')) this.days.add(k.slice(8)); } } catch (e) {}
    const ev = this.lsGet('sync/evicted'); if (Array.isArray(ev)) for (const d of ev) if (!this.days.has(d)) this.evicted.add(d);
  },
  raw(k) { try { return localStorage.getItem('pl:' + k); } catch (e) { return null; } },
  lsGet(k) { const v = this.raw(k); if (!v) return null; try { return JSON.parse(v); } catch (e) { return null; } },
  // Write one key. If storage is full, trim old days that are safely in the cloud — never days on/after `floor`
  // (default: keep the last 120 days if possible, then 30, then 7), never unsynced edits.
  put(k, json, floor) {
    const write = () => { try { localStorage.setItem('pl:' + k, json); } catch (e) { return false; } if (k.startsWith('days/')) { const d = k.slice(5); this.days.add(d); if (this.evicted.delete(d)) this.saveEvicted(); } return true; };
    if (write()) return true;
    for (const before of floor ? [floor] : [-120, -30, -7].map(n => addDays(todayStr(), n))) while (this.makeRoom(k, before)) if (write()) return true;
    return false;
  },
  lsSet(k, v) { return this.put(k, JSON.stringify(v)); },
  lsDel(k) { try { localStorage.removeItem('pl:' + k); } catch (e) {} if (k.startsWith('days/')) this.days.delete(k.slice(5)); },
  // A user edit: saved on this device immediately, uploaded in the background.
  set(path, data) {
    const prev = this.raw(path);
    if (SYNCED.test(path) && data && typeof data === 'object') { const rev = revOf(prev); data = { ...data }; if (rev) data._rev = rev; else delete data._rev; } // which cloud version this edit is based on
    const json = JSON.stringify(data);
    if (prev === json) return true;
    if (!this.put(path, json)) { toast('Could not save on this device — storage is full'); return false; }
    if (SYNCED.test(path)) sync.markDirty(path, prev);
    return true;
  },
  syncedKeys() { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('pl:') && SYNCED.test(k.slice(3))) out.push(k.slice(3)); } } catch (e) {} return out; },
  allKeys() { return this.syncedKeys().map(k => 'pl:' + k); },
  usage() { let n = 0; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('pl:')) n += k.length + (localStorage.getItem(k) || '').length; } } catch (e) {} return n * 2; },
  makeRoom(forKey, before) {
    if (!auth.user) return false;
    const dirty = sync.dirtyMap();
    const drop = [...this.days].filter(d => d < before && 'days/' + d !== forKey && !dirty['days/' + d] && (this.raw('days/' + d) || '').includes('"_rev":')).sort().slice(0, 30); // has a cloud version
    if (!drop.length) return false;
    for (const d of drop) { try { localStorage.removeItem('pl:days/' + d); } catch (e) {} this.days.delete(d); this.evicted.add(d); delete S.days[d]; }
    this.saveEvicted(); return true;
  },
  saveEvicted() { try { localStorage.setItem('pl:sync/evicted', JSON.stringify([...this.evicted])); } catch (e) {} },
  // Days from the last n calendar days (and any future-dated ones), newest first. Cost grows with n, not with diary size.
  recentDays(n) {
    const from = addDays(todayStr(), -(n - 1)), out = [];
    for (const d of this.days) if (d >= from) { const x = dayLocal(d); if (x) out.push(x); }
    return out.sort((a, b) => b.date.localeCompare(a.date));
  },
  async allDays() {
    const out = []; for (const d of this.days) { const x = dayLocal(d); if (x) out.push(x); }
    if (this.evicted.size && auth.user) {
      try { const { docs } = await fsQuery('days', 0); for (const doc of docs) if (this.evicted.has(doc.id)) out.push(doc.data); }
      catch (e) { toast('Some older days are only in the cloud and could not be fetched'); }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }
};
function revOf(raw) { if (!raw) return null; try { return JSON.parse(raw)._rev || null; } catch (e) { return null; } }
function wipeLocal() {
  const ks = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('pl:') && (SYNCED.test(k.slice(3)) || k.startsWith('pl:sync/'))) ks.push(k); } } catch (e) {}
  for (const k of ks) { try { localStorage.removeItem(k); } catch (e) {} }
  store.days.clear(); store.evicted.clear(); S.days = {}; reloadStateFromLocal();
}

// ---------- Sign-in: Google OAuth → Firebase Auth REST (no SDK) ----------
function readSdkSession() { // sign-ins made by app versions ≤ 1.3 live in the Firebase SDK's IndexedDB
  return new Promise(res => {
    let done = false; const finish = v => { if (!done) { done = true; res(v); } };
    setTimeout(() => finish(null), 3000);
    if (!window.indexedDB) return finish(null);
    let req; try { req = indexedDB.open('firebaseLocalStorageDb'); } catch (e) { return finish(null); }
    req.onupgradeneeded = () => { try { req.transaction.abort(); } catch (e) {} finish(null); }; // didn't exist: don't create it
    req.onerror = () => finish(null);
    req.onsuccess = () => {
      const db = req.result;
      try {
        if (!db.objectStoreNames.contains('firebaseLocalStorage')) { db.close(); return finish(null); }
        const all = db.transaction('firebaseLocalStorage', 'readonly').objectStore('firebaseLocalStorage').getAll();
        all.onsuccess = () => { db.close(); const rec = (all.result || []).find(r => r && typeof r.fbase_key === 'string' && r.fbase_key.startsWith('firebase:authUser:') && r.value && r.value.uid); finish(rec ? rec.value : null); };
        all.onerror = () => { db.close(); finish(null); };
      } catch (e) { try { db.close(); } catch (e2) {} finish(null); }
    };
  });
}
const auth = {
  user: null, checked: false, expired: false, refreshing: null,
  load() { this.user = store.lsGet('auth'); this.checked = !!(this.user || store.raw('auth_checked')); },
  save() { if (this.user) store.put('auth', JSON.stringify(this.user)); else store.lsDel('auth'); },
  markChecked() { this.checked = true; store.put('auth_checked', '1'); },
  begin(user) {
    const st = store.lsGet('sync/state');
    if (st && st.uid && st.uid !== user.uid) wipeLocal(); // someone else's diary was on this device
    this.user = user; this.expired = false; this.save(); this.markChecked();
  },
  async token(force) {
    const u = this.user; if (!u) throw { code: 'auth', message: 'Signed out' };
    if (!force && u.idToken && u.exp - 120000 > Date.now()) return u.idToken;
    if (!this.refreshing) this.refreshing = (async () => {
      let r, j = {};
      try {
        r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(u.refreshToken) });
        j = await r.json().catch(() => ({}));
      } catch (e) { throw { code: 'offline', message: 'No connection' }; }
      if (!r.ok) {
        const msg = (j.error && j.error.message) || 'HTTP ' + r.status;
        if (/TOKEN_EXPIRED|INVALID_REFRESH_TOKEN|USER_DISABLED|USER_NOT_FOUND|INVALID_GRANT|MISSING_REFRESH_TOKEN/.test(msg)) { this.expire(); throw { code: 'auth', message: msg }; }
        throw { code: 'http', message: msg };
      }
      if (this.user !== u) throw { code: 'auth', message: 'Signed out' };
      u.idToken = j.id_token; if (j.refresh_token) u.refreshToken = j.refresh_token; u.exp = Date.now() + (+j.expires_in || 3600) * 1000; this.save();
      return u.idToken;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  },
  expire() { this.user = null; this.expired = true; this.save(); sync.set('signedout'); refreshView(); },
  signIn() {
    const state = uid(); try { localStorage.setItem('pl:oauth_state', state); } catch (e) {}
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', GOOGLE_CLIENT_ID); u.searchParams.set('redirect_uri', APP_URL); u.searchParams.set('response_type', 'token');
    u.searchParams.set('scope', 'openid email profile'); u.searchParams.set('state', state); u.searchParams.set('prompt', 'select_account');
    location.href = u.toString();
  },
  async handleOAuthReturn() {
    const p = new URLSearchParams(location.hash.slice(1)); const tok = p.get('access_token'), st = p.get('state');
    let saved = null; try { saved = localStorage.getItem('pl:oauth_state'); localStorage.removeItem('pl:oauth_state'); } catch (e) {}
    history.replaceState(null, '', location.pathname + location.search);
    if (!tok || (saved && st !== saved)) { toast('Sign-in could not be completed — try again'); return false; }
    try {
      const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ postBody: 'access_token=' + encodeURIComponent(tok) + '&providerId=google.com', requestUri: 'http://localhost', returnSecureToken: true }) }); // same request the Firebase SDK makes
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.idToken) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
      this.begin({ uid: j.localId, email: j.email || '', name: j.displayName || j.fullName || j.email || 'Signed in', idToken: j.idToken, refreshToken: j.refreshToken, exp: Date.now() + (+j.expiresIn || 3600) * 1000 });
      toast('Signed in'); return true;
    } catch (e) { toast('Sign-in failed: ' + (e.message || e)); return false; }
  },
  async migrateFromSdk() {
    const v = await readSdkSession(); const t = v && v.stsTokenManager;
    if (!v || !v.uid || !t || !t.refreshToken) return false;
    this.begin({ uid: v.uid, email: v.email || '', name: v.displayName || v.email || 'Signed in', idToken: t.accessToken || '', refreshToken: t.refreshToken, exp: +t.expirationTime || 0 });
    return true;
  },
  signOut() {
    this.user = null; this.save(); wipeLocal(); this.markChecked();
    try { indexedDB.deleteDatabase('firebaseLocalStorageDb'); } catch (e) {}
    location.reload();
  }
};

// ---------- Cloud sync: Firestore REST, incremental by server timestamp, durable upload queue, three-way merge ----------
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  switch (typeof v) {
    case 'boolean': return { booleanValue: v };
    case 'number': return !isFinite(v) ? { nullValue: null } : Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER ? { integerValue: String(v) } : { doubleValue: v };
    case 'string': return { stringValue: v };
    case 'object':
      if (Array.isArray(v)) return { arrayValue: v.length ? { values: v.map(x => Array.isArray(x) ? { mapValue: { fields: { __a: enc(x) } } } : enc(x)) } : {} }; // Firestore can't nest arrays directly
      return { mapValue: { fields: encFields(v) } };
  }
  return { nullValue: null };
}
function encFields(o) { const f = {}; for (const k in o) if (o[k] !== undefined && k !== '_u' && k !== '_rev') f[k] = enc(o[k]); return f; }
function dec(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('mapValue' in v) { const f = v.mapValue.fields || {}, ks = Object.keys(f); if (ks.length === 1 && ks[0] === '__a') return dec(f.__a); const o = {}; for (const k of ks) o[k] = dec(f[k]); return o; }
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('timestampValue' in v) return tsParse(v.timestampValue);
  return null;
}
const tsParse = s => { const t = Date.parse(String(s).replace(/(\.\d{3})\d+/, '$1')); return isFinite(t) ? t : 0; }; // Firestore sends µs; Safari only parses ms
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined && k !== '_rev' && k !== '_u').sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
const sameVal = (a, b) => canon(a) === canon(b);
const sameRaw = (raw, obj) => { try { return canon(JSON.parse(raw)) === canon(obj); } catch (e) { return false; } }; // stored JSON text vs a value
const fsPath = path => path.startsWith('days/') ? 'days/' + path.slice(5) : 'meta/' + path.replace(/\//g, '_');
function fromDoc(doc) {
  const parts = doc.name.split('/'), id = parts.pop(), coll = parts.pop();
  const data = dec({ mapValue: { fields: doc.fields || {} } }) || {}; delete data._u; data._rev = doc.updateTime;
  return { path: coll === 'days' ? 'days/' + id : META[id] || null, id, coll, data };
}
async function fsFetch(url, body, opts = {}) {
  const payload = body ? JSON.stringify(body) : undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const tok = await auth.token(attempt > 0);
    let r;
    try { r = await fetch(url, { method: body ? 'POST' : 'GET', headers: body ? { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' } : { Authorization: 'Bearer ' + tok }, body: payload, keepalive: !!(opts.keepalive && payload && payload.length < 60000) }); }
    catch (e) { throw { code: 'offline', message: 'No connection' }; }
    if (r.status === 401 && attempt === 0) continue;
    if (r.status === 404 && opts.allow404) return null;
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      const err = (Array.isArray(j) ? j[0] && j[0].error : j && j.error) || {};
      const conflict = r.status === 409 || /FAILED_PRECONDITION|ALREADY_EXISTS|ABORTED/.test(err.status || '');
      throw { code: r.status === 401 ? 'auth' : conflict ? 'conflict' : 'http', status: r.status, message: err.message || err.status || 'HTTP ' + r.status };
    }
    return j;
  }
}
async function fsQuery(coll, sinceMs) {
  const q = { from: [{ collectionId: coll }] };
  if (sinceMs) q.where = { fieldFilter: { field: { fieldPath: '_u' }, op: 'GREATER_THAN', value: { timestampValue: new Date(sinceMs).toISOString() } } };
  const res = await fsFetch(`${FS_ROOT}/users/${auth.user.uid}:runQuery`, { structuredQuery: q });
  let readTime = 0; const docs = [];
  for (const x of Array.isArray(res) ? res : []) {
    if (x.error) throw { code: 'http', message: x.error.message || x.error.status };
    if (x.readTime) readTime = Math.max(readTime, tsParse(x.readTime));
    if (x.document) docs.push(fromDoc(x.document));
  }
  return { docs, readTime };
}
function fsCommit(writes, keepalive) {
  const base = `projects/${PROJECT}/databases/(default)/documents/users/${auth.user.uid}/`;
  return fsFetch(`${FS_ROOT}:commit`, { writes: writes.map(w => ({ update: { name: base + fsPath(w.path), fields: encFields(w.data) }, updateTransforms: [{ fieldPath: '_u', setToServerValue: 'REQUEST_TIME' }], currentDocument: w.data._rev ? { updateTime: w.data._rev } : { exists: false } })) }, { keepalive });
}
const keyOf = x => x && x.id != null ? 'id:' + x.id : canon(x);
function mergeList(base, local, remote, prefer) { // three-way merge of lists of {id,…}
  const B = new Map((base || []).map(x => [keyOf(x), x])), R = new Map((remote || []).map(x => [keyOf(x), x]));
  const out = [], seen = new Set();
  for (const l of local || []) {
    const k = keyOf(l); seen.add(k); const r = R.get(k), b = B.get(k);
    if (r) out.push(b && sameVal(l, b) ? r : b && sameVal(r, b) ? l : prefer(l, r));
    else if (!b || !sameVal(l, b)) out.push(l); // added here (or edited here after the other device removed it)
  }
  for (const r of remote || []) {
    const k = keyOf(r); if (seen.has(k)) continue; const b = B.get(k);
    if (!b || !sameVal(r, b)) out.push(r); // added on the other device (or edited there after this one removed it)
  }
  return out;
}
const newer = (l, r) => (r.ts || 0) > (l.ts || 0) ? r : l;
function mergeDoc(path, base, local, remote) {
  if (!remote) return local;
  const b = base || {};
  if (path.startsWith('days/')) {
    const m = { ...remote, ...local };
    m.entries = mergeList(b.entries, local.entries, remote.entries, newer).sort((x, y) => (x.ts || 0) - (y.ts || 0));
    m.exercise = mergeList(b.exercise, local.exercise, remote.exercise, l => l);
    m.weight = sameVal(local.weight ?? null, b.weight ?? null) ? (remote.weight ?? null) : local.weight;
    return m;
  }
  if (path === 'foods/custom' || path === 'foods/meals') return { ...remote, ...local, items: mergeList(b.items, local.items, remote.items, l => l) };
  if (path === 'foods/recent') return local;
  const out = {}; // settings & small docs: per field, keep whichever side changed it
  for (const k of new Set([...Object.keys(remote), ...Object.keys(local)])) out[k] = k in local && !sameVal(local[k] ?? null, b[k] ?? null) ? local[k] : k in remote ? remote[k] : local[k];
  return out;
}
const sync = {
  status: 'idle', error: '', lastSync: 0, lastPull: 0, subs: new Set(), busy: null, queued: null, retryT: 0, retryMs: 0, pushT: 0,
  on(fn) { this.subs.add(fn); return () => this.subs.delete(fn); },
  set(status, error) { this.status = status; this.error = error || ''; for (const fn of [...this.subs]) { try { fn(); } catch (e) {} } },
  state() { return store.lsGet('sync/state') || {}; },
  needFull() { const st = this.state(); return !st.v || !auth.user || st.uid !== auth.user.uid || !st.cursor || Date.now() - (st.lastFull || 0) > 7 * 864e5; },
  everSynced() { const st = this.state(); return !!(st.v && auth.user && st.uid === auth.user.uid); },
  dirtyMap() { return store.lsGet('sync/dirty') || {}; },
  pending() { return Object.keys(this.dirtyMap()).length; },
  saveDirty(d) { store.put('sync/dirty', JSON.stringify(d)); },
  markDirty(path, prevJson) {
    const d = this.dirtyMap();
    if (!(path in d)) { if (prevJson != null) store.put('sync/base/' + path, prevJson); else store.lsDel('sync/base/' + path); } // remember the last shared version
    d[path] = (d[path] || 0) + 1; this.saveDirty(d);
    if (auth.user) { clearTimeout(this.pushT); this.pushT = setTimeout(() => this.run({ pull: false }), 700); }
  },
  clean(path) { const d = this.dirtyMap(); if (path in d) { delete d[path]; this.saveDirty(d); } try { localStorage.removeItem('pl:sync/base/' + path); } catch (e) {} },
  async flush(keepalive) {
    const d = this.dirtyMap(), writes = [];
    for (const p of Object.keys(d)) {
      const raw = store.raw(p); let data = null;
      try { data = raw == null ? null : JSON.parse(raw); } catch (e) {}
      if (!data || typeof data !== 'object') { this.clean(p); continue; }
      writes.push({ path: p, data, raw, seq: d[p] });
    }
    for (let i = 0; i < writes.length; i += 100) {
      const chunk = writes.slice(i, i + 100);
      const res = await fsCommit(chunk, keepalive), results = (res && res.writeResults) || [];
      const cur = this.dirtyMap();
      chunk.forEach((w, k) => {
        if (results[k] && results[k].updateTime) this.setRev(w.path, results[k].updateTime);
        if (cur[w.path] === w.seq) { delete cur[w.path]; try { localStorage.removeItem('pl:sync/base/' + w.path); } catch (e) {} }
        else store.put('sync/base/' + w.path, w.raw); // edited again mid-upload: what we sent is the shared version now
      });
      this.saveDirty(cur);
    }
    return writes.length;
  },
  async pull(full) {
    const st = this.state(), since = full ? 0 : st.cursor || 0;
    const [days, meta] = await Promise.all([fsQuery('days', since), fsQuery('meta', since)]);
    let changed = false; const seen = new Set();
    const docs = meta.docs.concat(days.docs.sort((a, b) => b.id.localeCompare(a.id))); // settings first, then newest days first (matters if space runs out)
    for (const doc of docs) { if (!doc.path) continue; seen.add(doc.path); if (this.apply(doc.path, doc.data)) changed = true; }
    if (!since) { // complete listing: anything only on this device gets uploaded
      const d = this.dirtyMap(); let add = false;
      for (const k of store.syncedKeys()) if (!seen.has(k) && !(k in d)) { d[k] = 1; add = true; }
      if (add) this.saveDirty(d);
    }
    const rt = days.readTime && meta.readTime ? Math.min(days.readTime, meta.readTime) : 0;
    store.put('sync/state', JSON.stringify({ v: 2, uid: auth.user.uid, cursor: rt ? rt - 60000 : st.cursor || 0, lastFull: since ? st.lastFull || 0 : Date.now() }));
    this.lastPull = Date.now();
    return changed;
  },
  setRev(path, rev) {
    const raw = store.raw(path); if (!raw) return;
    try { const o = JSON.parse(raw); if (o._rev === rev) return; o._rev = rev; store.put(path, JSON.stringify(o)); } catch (e) { return; }
    if (path.startsWith('days/') && S.days[path.slice(5)]) S.days[path.slice(5)]._rev = rev;
  },
  apply(path, remote) {
    const localRaw = store.raw(path);
    if (!(path in this.dirtyMap())) { // nothing pending here: take the cloud's version
      if (localRaw != null && sameRaw(localRaw, remote)) { this.setRev(path, remote._rev); return false; }
      this.keep(path, remote); return true;
    }
    let local = null, base = null;
    try { local = localRaw ? JSON.parse(localRaw) : null; } catch (e) {}
    if (!local) { this.keep(path, remote); this.clean(path); return true; }
    try { base = JSON.parse(localStorage.getItem('pl:sync/base/' + path) || 'null'); } catch (e) {}
    if (!base && path === 'settings/main') base = DEFAULTS; // both sides started from the defaults
    const merged = mergeDoc(path, base, local, remote); merged._rev = remote._rev; const mj = JSON.stringify(merged);
    store.put('sync/base/' + path, JSON.stringify(remote));
    let changed = false;
    if (mj !== localRaw) { this.keep(path, merged, mj); changed = true; }
    if (sameVal(merged, remote)) this.clean(path);
    return changed;
  },
  keep(path, data, json) {
    const ok = store.put(path, json || JSON.stringify(data), path.startsWith('days/') ? path.slice(5) : undefined); // an old day from the cloud never pushes out a newer one
    if (!path.startsWith('days/')) return;
    const date = path.slice(5);
    if (!ok) { store.lsDel(path); store.evicted.add(date); store.saveEvicted(); } // no room on this device: the cloud copy is fetched when that day is opened
    const cur = S.days[date]; if (cur) { for (const k of Object.keys(cur)) delete cur[k]; Object.assign(cur, data); cur.entries = cur.entries || []; cur.exercise = cur.exercise || []; cur.date = date; }
  },
  async fetchDay(date) { const j = await fsFetch(`${FS_ROOT}/users/${auth.user.uid}/days/${date}`, null, { allow404: true }); return j ? fromDoc(j).data : null; },
  run(opts = {}) {
    if (!auth.user) return Promise.resolve();
    const want = { pull: opts.pull !== false, full: !!opts.full };
    if (this.busy) { const q = this.queued || (this.queued = { pull: false, full: false }); q.pull = q.pull || want.pull; q.full = q.full || want.full; return this.busy; }
    this.busy = (async () => {
      clearTimeout(this.retryT); clearTimeout(this.pushT);
      this.set('syncing');
      try {
        let changed = false;
        if (want.pull) changed = await this.pull(want.full || this.needFull());
        for (let attempt = 0; ; attempt++) {
          try { await this.flush(opts.keepalive); break; }
          catch (e) { if (e.code !== 'conflict' || attempt >= 3) throw e; changed = (await this.pull(attempt >= 1 || this.needFull())) || changed; } // another device got there first: merge and retry
        }
        this.retryMs = 0; this.lastSync = Date.now(); this.set('synced');
        if (!store.raw('sync/cleaned')) { store.put('sync/cleaned', '1'); for (const n of ['firestore/[DEFAULT]/plate-ledger-8007d/main', 'firebase-heartbeat-database', 'firebaseLocalStorageDb']) { try { indexedDB.deleteDatabase(n); } catch (e) {} } } // leftovers of the old Firebase SDK
        if (changed) { reloadStateFromLocal(); refreshView(); }
      } catch (e) {
        if (e && e.code === 'auth') this.set('signedout');
        else {
          this.set(e && e.code === 'offline' ? 'offline' : 'error', e && e.message);
          this.retryMs = Math.min(300000, (this.retryMs || 7500) * 2);
          this.retryT = setTimeout(() => this.run(), this.retryMs);
        }
      } finally {
        this.busy = null;
        if (this.queued) { const q = this.queued; this.queued = null; this.run(q); }
      }
    })();
    return this.busy;
  }
};

function reloadStateFromLocal() {
  const st = store.lsGet('settings/main'); S.settings = st ? { ...DEFAULTS, ...st } : { ...DEFAULTS };
  const cf = store.lsGet('foods/custom'); S.custom = (cf && cf.items) || []; for (const f of S.custom) f.lc = String(f.name || '').toLowerCase();
  const rc = store.lsGet('foods/recent'); S.recent = (rc && rc.items) || [];
  const ml = store.lsGet('foods/meals'); S.meals = (ml && ml.items) || []; recipeCache = null;
}
const sheetOpen = () => !!document.querySelector('#sheetRoot').children.length;
let refreshPending = false;
function refreshView() {
  const a = document.activeElement;
  if (sheetOpen() || (a && a.matches && a.matches('input,textarea,select') && a.closest('.screen'))) { refreshPending = true; return; } // don't yank the screen away mid-edit
  refreshPending = false;
  ({ today: renderToday, trends: renderTrends, foods: renderFoods, settings: renderSettings })[S.tab || 'today']();
}
// ---------- State ----------
const DEFAULTS = { kcal: 2200, p: 150, c: 230, f: 75, fib: 30, sug: 50, na: 2300, meals: ['Breakfast', 'Lunch', 'Dinner', 'Snacks'], netMode: false };
const S = { settings: { ...DEFAULTS }, date: todayStr(), days: {}, custom: [], recent: [], meals: [], tab: 'today', lastWeight: null };
let recipeCache = null;

const emptyDay = date => ({ date, entries: [], weight: null, exercise: [] });
function dayLocal(date) {
  let d = S.days[date]; if (d) return d;
  if (!store.days.has(date)) return null;
  d = store.lsGet('days/' + date); if (!d || typeof d !== 'object') return null;
  d.entries = d.entries || []; d.exercise = d.exercise || []; d.date = date;
  return (S.days[date] = d);
}
async function loadDay(date) {
  const d = dayLocal(date); if (d) return d;
  if (store.evicted.has(date) && auth.user) { // trimmed off this device earlier; fetch it back from the cloud
    try { const r = await sync.fetchDay(date); if (r) { r.entries = r.entries || []; r.exercise = r.exercise || []; r.date = date; return (S.days[date] = r); } store.evicted.delete(date); store.saveEvicted(); }
    catch (e) { const stub = emptyDay(date); stub._stub = true; return stub; } // offline: read-only placeholder, not cached
  }
  return (S.days[date] = emptyDay(date));
}
const rnd = (v, p) => typeof v === 'number' && isFinite(v) ? Math.round(v * p) / p : v;
const sig3 = v => typeof v === 'number' && isFinite(v) && v !== 0 ? +v.toPrecision(3) : v;
function compactEntry(e) { // 155.00000000000003 → 155; roughly halves what a diary day takes on disk and on the wire
  for (const k of ['kcal', 'grams', 'na']) if (k in e) e[k] = rnd(e[k], 10);
  for (const k of ['p', 'c', 'f', 'fib', 'sug']) if (k in e) e[k] = rnd(e[k], 100);
  if (typeof e.qty === 'number') e.qty = rnd(e.qty, 1000);
  if (e.m) for (const k in e.m) e.m[k] = sig3(e.m[k]);
  for (const k in e) if (e[k] === undefined) delete e[k];
  return e;
}
async function saveDay(date) {
  const d = S.days[date];
  if (!d || d._stub) { toast('This day is stored in the cloud — connect to the internet to edit it'); return false; }
  d.date = date; d.entries = d.entries || []; for (const e of d.entries) compactEntry(e);
  return store.set('days/' + date, d);
}
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
function closeSheet() { if (openAdd.stop) { openAdd.stop(); openAdd.stop = null; } $('#sheetRoot').innerHTML = ''; document.body.style.overflow = ''; if (refreshPending) setTimeout(() => { if (refreshPending) refreshView(); }, 0); }
const field = (label, input) => el('div', { class: 'field' }, el('label', { for: input.id }, label), input);

// ---------- Nutrition helpers ----------
const scaleFood = (food, grams) => { const k = grams / (food.per || 100); const o = { kcal: food.kcal * k, p: food.p * k, c: food.c * k, f: food.f * k, fib: food.fib * k, sug: food.sug * k, na: food.na * k }; const mm = microOf(food); if (mm) { o.m = {}; for (const key in mm) o.m[key] = (mm[key] || 0) * k; } return o; };
const nutGrid = n => el('div', { class: 'nutgrid' },
  el('span', {}, el('b', {}, r1(n.p) + ' g'), 'Protein'), el('span', {}, el('b', {}, r1(n.c) + ' g'), 'Carbs'),
  el('span', {}, el('b', {}, r1(n.f) + ' g'), 'Fat'), el('span', {}, el('b', {}, r1(n.fib) + ' g'), 'Fibre'),
  el('span', {}, el('b', {}, r1(n.sug) + ' g'), 'Sugar'), el('span', {}, el('b', {}, r0(n.na) + ' mg'), 'Sodium'));

// ---------- Search ----------
function searchFoods(q, limit = 30) {
  q = q.trim().toLowerCase(); if (!q) return [];
  const toks = q.split(/[\s,]+/).filter(Boolean).map(t => t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t);
  const top = []; // best matches so far, highest score first
  const offer = (s, x) => { if (top.length === limit && s <= top[limit - 1][0]) return; let i = top.length; while (i > 0 && top[i - 1][0] < s) i--; top.splice(i, 0, [s, x]); if (top.length > limit) top.pop(); };
  const score = lc => { let s = 0; for (const t of toks) { const i = lc.indexOf(t); if (i < 0) return -1; const p = i ? lc.charCodeAt(i - 1) : 0; s += i === 0 ? 30 : p === 32 || p === 44 ? 12 : 4; } return s; };
  const commas = lc => { let k = 0, j = -1; while ((j = lc.indexOf(',', j + 1)) >= 0) k++; return k; };
  for (const f of S.custom) { const lc = f.lc || ''; const s = score(lc); if (s >= 0) offer(s + 50 - lc.length * 0.08 - commas(lc) * 1.5, f); }
  for (const f of recipeFoods()) { const s = score(f.lc); if (s >= 0) offer(s + 50 - f.lc.length * 0.08 - commas(f.lc) * 1.5, f); }
  if (DB.ready && q.replace(/[\s,]/g, '').length >= 2) { // one letter matches nearly everything: wait for the second
    const { lc, nc, src } = DB, prev = searchFoods.last, hits = [];
    const visit = i => { const s = score(lc[i]); if (s >= 0) { hits.push(i); offer(s - lc[i].length * 0.08 - nc[i] * 1.5 + (src[i] ? 0 : 2), i); } };
    if (prev && prev.rows === DB.rows && q.startsWith(prev.q)) { for (const i of prev.hits) visit(i); } // typing more only narrows the matches
    else for (let i = 0; i < lc.length; i++) visit(i);
    searchFoods.last = { q, rows: DB.rows, hits: Int32Array.from(hits) };
  }
  return top.map(x => typeof x[1] === 'number' ? foodFromRow(x[1]) : x[1]);
}

// ---------- Today screen ----------
function ringSvg(pct, over) {
  const r = 44, C = 2 * Math.PI * r, p = Math.min(pct, 1);
  return el('div', { class: 'ring', html:
    `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--surface2)" stroke-width="9"/>
     ${p > 0 ? `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${over ? 'var(--over)' : 'var(--accent)'}" stroke-width="9" stroke-linecap="round"
       stroke-dasharray="${(C * p).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 50 50)"/>` : ''}</svg>` });
}
function macroRow(cls, label, val, target, unit = 'g') {
  const pct = target ? Math.min(val / target, 1) * 100 : 0;
  return el('div', { class: 'macro ' + cls },
    el('div', { class: 'lbl' }, el('span', {}, label), el('b', {}, r0(val) + ' / ' + target + ' ' + unit)),
    el('div', { class: 'bar' }, el('i', { class: val > target ? 'over' : '', style: 'width:' + pct + '%' })));
}
const renderGen = { today: 0, trends: 0 };
async function renderToday() {
  const gen = ++renderGen.today; const root = document.createDocumentFragment(); S.shownToday = S.date === todayStr();
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
  if (auth.checked && !auth.user) root.append(el('div', { class: 'card', style: 'display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap' },
    el('div', { style: 'flex:1;min-width:200px' }, el('strong', {}, auth.expired ? 'Signed out' : 'Not backed up yet'), el('div', { class: 'hint' }, auth.expired ? 'Sign in again to keep your diary syncing — nothing on this device is lost.' : 'Sign in with Google to keep your diary safe and use it on any device.')),
    el('button', { class: 'btn', style: 'flex:0 0 auto', onclick: () => auth.signIn() }, 'Sign in with Google')));
  if (day._stub) root.append(el('div', { class: 'warn' }, 'This day is saved in the cloud but couldn’t be loaded — connect to the internet to see or edit it.'));
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
  const wtr = weightTrend(store.recentDays(60).filter(d => d.weight).sort((a, b) => a.date.localeCompare(b.date)));
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
  if (gen !== renderGen.today) return;
  $('#scr-today').replaceChildren(root);
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
  const inp = el('input', { id: 'q', placeholder: 'Search 14,000 foods… e.g. chicken breast grilled', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'search' });
  const res = el('div', { class: 'results' });
  let seq = 0, frame = 0;
  const show = async () => {
    frame = 0; const my = ++seq, q = inp.value;
    if (q.trim() && !DB.ready) { res.replaceChildren(el('div', { class: 'hint' }, 'Loading the food database…')); await loadFoods(); if (my !== seq) return; }
    const list = searchFoods(q);
    res.replaceChildren(...list.map(f => resRow(f, meal, onPick)));
    if (q.trim() && !list.length) res.append(el('div', { class: 'empty' }, 'No matches — try fewer or shorter words, or add it under Quick add.'));
  };
  inp.addEventListener('input', () => { if (!frame) frame = requestAnimationFrame(show); });
  loadFoods();
  setTimeout(() => inp.focus(), 50);
  const wrap = el('div', { class: 'stack' }, el('div', { class: 'search' }, inp));
  const intro = el('div', { class: 'stack', style: 'gap:6px' }); // recent foods until you start typing
  if (S.recent.length) { intro.append(el('div', { class: 'hint' }, 'Recent')); const rr = el('div', { class: 'results' }); for (const f of S.recent.slice(0, 12)) rr.append(resRow(f, meal, onPick)); intro.append(rr); }
  else intro.append(el('div', { class: 'hint' }, 'Canadian Nutrient File (Health Canada) and USDA foods, plus your own. Packaged products: scan the barcode, snap the Nutrition Facts label under Photo, or save them once under Foods.'));
  inp.addEventListener('input', () => { intro.hidden = !!inp.value.trim(); });
  wrap.append(intro, res);
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
    const what = withPhoto ? 'the photo' : 'your description', label = el('span', {}, 'Claude is looking at ' + what + '…'), t0 = Date.now();
    status.innerHTML = ''; status.append(el('span', { class: 'spin' }), label);
    const tick = setInterval(() => { const sec = Math.round((Date.now() - t0) / 1000); if (sec >= 3) label.textContent = `Claude is looking at ${what}… ${sec} s`; }, 1000);
    try {
      const data = await askClaude(EST_PROMPT(note.value.trim()), withPhoto ? blob : null, ctl.signal);
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) throw { code: 'invalid_json' };
      status.innerHTML = ''; if (data.notes) status.append('Note: ' + data.notes);
      out.append(reviewEstimate(items, meal, withPhoto ? 'photo' : 'ai'));
    } catch (e) {
      status.innerHTML = ''; status.append(AI_ERR[e.code] || ('Something went wrong (' + (e.message || e.code || 'error') + '). Try again.'));
      if (e.code === 'no_key' || e.code === 'bad_key') status.append(' ', el('button', { class: 'chip', onclick: () => { closeSheet(); showTab('settings'); } }, 'Open Settings'));
    } finally { clearInterval(tick); go.disabled = false; stop.hidden = true; }
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
    const bmp = await createImageBitmap(file); const max = 1024; /* plenty for portions and labels; about half the upload of 1400 px */ const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(b => res(b || file), 'image/jpeg', 0.82));
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
  for (const f of S.custom) list.append(el('div', { class: 'li' }, el('button', { class: 'entry', style: 'padding:0;border:0', onclick: () => { const form = foodForm(f); openSheet('Edit food', form, [el('button', { class: 'btn danger', onclick: async () => { S.custom = S.custom.filter(x => x.id !== f.id); await store.set('foods/custom', { items: S.custom.map(x => ({ ...x, lc: undefined })) }); closeSheet(); renderFoods(); } }, 'Delete'), el('button', { class: 'btn', onclick: async () => { await saveCustom(form.read()); closeSheet(); renderFoods(); toast('Saved'); } }, 'Save')]); } },
    el('div', { class: 'n' }, f.name), el('div', { class: 'd' }, `${r0(f.kcal)} kcal per ${f.per} g · P ${r1(f.p)} · C ${r1(f.c)} · F ${r1(f.f)}`))));
  if (!S.custom.length) list.append(el('div', { class: 'empty' }, 'No saved foods yet.'));
  card.append(list); root.append(mealsCard()); root.append(card);
  root.append(el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Built-in database'), el('div', { class: 'hint' }, `${DB.ready ? DB.count[0].toLocaleString() : 'About 5,900'} foods from Health Canada's Canadian Nutrient File (2026) and ${DB.ready ? DB.count[1].toLocaleString() : '8,400'} from the USDA National Nutrient Database (SR28), per 100 g with common serving sizes. CNF entries rank first in search. Packaged products are best added from their label — snap it under Photo, or save it here.`)));
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
async function saveMeals() { recipeCache = null; await store.set('foods/meals', { items: S.meals.map(m => ({ ...m, items: m.items.map(i => ({ ...i, lc: undefined })) })) }); }
const sumItems = items => items.reduce((t, e) => { for (const k of ['kcal', 'p', 'c', 'f', 'fib', 'sug', 'na']) t[k] += e[k] || 0; t.grams += e.grams || 0; if (e.m) { t.m = t.m || {}; for (const k in e.m) t.m[k] = (t.m[k] || 0) + (e.m[k] || 0); } return t; }, { kcal: 0, p: 0, c: 0, f: 0, fib: 0, sug: 0, na: 0, grams: 0 });
function recipeFoods() {
  if (recipeCache) return recipeCache;
  return recipeCache = S.meals.filter(m => m.type === 'recipe').map(m => { const t = sumItems(m.items); const sv = Math.max(1, m.servings || 1); const per = Math.round(t.grams / sv) || 100;
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
function movingAvg(weights) { // 7-day trailing average; weights sorted oldest first
  const ts = weights.map(w => Date.parse(w.date)), out = []; let j = 0, sum = 0;
  for (let i = 0; i < weights.length; i++) { sum += weights[i].weight; while (ts[i] - ts[j] >= 7 * 864e5) sum -= weights[j++].weight; out.push({ date: weights[i].date, avg: sum / (i - j + 1) }); }
  return out;
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
  if (plan.kcal !== old) { toast(`Weekly check-in: target ${old} → ${plan.kcal} kcal (burn ≈ ${est.tdee})`); refreshView(); }
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
const HEALTH_SHORTCUT = 'Plate Ledger to Health';
async function sendDayToHealth(date) {
  const day = await loadDay(date); const t = totals(day); if (!day.entries.length) { toast('Nothing logged for ' + fmtDate(date)); return; }
  const payload = `date:${date},kcal:${r0(t.kcal)},protein:${r1(t.p)},carbs:${r1(t.c)},fat:${r1(t.f)},fibre:${r1(t.fib)},sugar:${r1(t.sug)},sodium:${r0(t.na)}` + (day.weight ? `,weight:${day.weight}` : '');
  location.href = 'shortcuts://run-shortcut?name=' + encodeURIComponent(HEALTH_SHORTCUT) + '&input=text&text=' + encodeURIComponent(payload);
}
async function handleHealthUrl() {
  const th = (location.hash + location.search).match(/tohealth(?:=(\d{4}-\d{2}-\d{2}))?/);
  if (th) { history.replaceState(null, '', location.pathname); await sendDayToHealth(th[1] || addDays(todayStr(), -1)); return true; }
  const m = (location.hash + location.search).match(/health=([^&]+)/); if (!m) return false;

  history.replaceState(null, '', location.pathname);
  const kv = {}; for (const part of decodeURIComponent(m[1]).split(',')) { const [k, v] = part.split(':'); if (k && v !== undefined) kv[k.trim().toLowerCase()] = v.trim(); }
  let date = kv.date && /^\d{4}-\d{2}-\d{2}$/.test(kv.date) ? kv.date : todayStr(); const day = await loadDay(date); const done = [];
  const w = parseFloat(kv.weight); if (w > 20 && w < 400) { day.weight = Math.round(w * 10) / 10; done.push(day.weight + ' kg'); }
  const a = parseFloat(kv.active); if (a > 0 && a < 6000) { day.exercise = (day.exercise || []).filter(x => x.src !== 'health'); day.exercise.push({ id: uid(), name: 'Apple Health · active energy' + (kv.steps ? ` · ${parseInt(kv.steps).toLocaleString()} steps` : ''), min: 0, kcal: Math.round(a), src: 'health' }); done.push(Math.round(a) + ' kcal active'); }
  if (done.length) { await saveDay(date); toast('From Apple Health (' + fmtDate(date) + '): ' + done.join(', ')); }
  return true;
}
function healthCard() {
  const url = APP_URL + '#health=weight:84.6,active:520,steps:9100,date:' + todayStr();
  const code = t => el('code', { style: 'font-size:12px' }, t);
  return el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Apple Health'),
    el('div', { class: 'hint' }, 'A web app can’t talk to Apple Health directly, so the Shortcuts app is the bridge in both directions. Full step-by-step instructions are in the chat where this app was built; the short version:'),
    el('div', {}, el('b', {}, 'Plate Ledger → Health'), el('div', { class: 'hint' }, 'Tap the button below (or open ', code(APP_URL + '#tohealth'), ' from a nightly Shortcut automation). It hands yesterday’s totals to a Shortcut named “', HEALTH_SHORTCUT, '”, which logs Dietary Energy, Protein, Carbs, Fat, Fibre, Sugar and Sodium into Health.')),
    el('div', { class: 'row' }, el('button', { class: 'btn ghost', onclick: () => sendDayToHealth(S.date) }, 'Send ' + fmtDate(S.date) + ' to Health'), el('button', { class: 'btn ghost', onclick: () => sendDayToHealth(addDays(todayStr(), -1)) }, 'Send yesterday')),
    el('div', {}, el('b', {}, 'Health → Plate Ledger'), el('div', { class: 'hint' }, 'A morning Shortcut automation opens a link like the one below with your latest weight and yesterday’s active calories; the app files them into that day.')),
    el('div', { class: 'row', style: 'align-items:center' }, el('code', { style: 'flex:1;font-size:12px;overflow-wrap:anywhere;user-select:all' }, url), el('button', { class: 'btn ghost', style: 'flex:0 0 auto', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(url).then(() => toast('Copied')); } }, 'Copy')),
    el('div', { class: 'hint' }, 'Because Shortcuts opens links in Safari rather than the home-screen app, sign in with Google in Safari once too — the cloud keeps both in sync.'));
}

// ---------- Entry edit ----------
function openEntry(e) {
  const food = { id: e.foodId, name: e.name, per: e.grams || 100, kcal: e.kcal, p: e.p, c: e.c, f: e.f, fib: e.fib, sug: e.sug, na: e.na, m: e.m, servings: e.unitLabel !== 'g' ? [[e.unitLabel, e.grams / (e.qty || 1)]] : [], src: e.src };
  const base = S.custom.find(f => f.id === e.foodId) || foodById(e.foodId) || food;
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
  const gen = ++renderGen.trends; const root = document.createDocumentFragment();
  const days = store.recentDays(90); const byDate = {}; for (const d of days) byDate[d.date] = d;
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
  if (gen !== renderGen.trends) return;
  $('#scr-trends').replaceChildren(root);
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
  const keyStatus = el('div', { class: 'hint' }, st.apiKey ? (auth.user ? 'Key saved to your account (private to you) — it works on all your signed-in devices.' : 'Key saved on this device.') : 'No key yet.');
  const saveKey = el('button', { class: 'btn', onclick: async () => { st.apiKey = key.value.trim(); st.model = model.value; await save(); keyStatus.textContent = 'Testing the key…'; try { const r = await askClaude('Reply with only this JSON: {"ok":true}', null); keyStatus.textContent = r && r.ok ? 'Key works — photo and text estimates are on.' : 'Key saved; unexpected reply, but the request went through.'; } catch (e) { keyStatus.textContent = AI_ERR[e.code] || ('Could not verify: ' + (e.message || e.code)); } } }, 'Save & test');
  root.append(el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Claude (photo & text estimates)'),
    el('div', { class: 'hint' }, 'Estimates call the Anthropic API directly from this device with your own key. Get one at console.anthropic.com → API keys; add a few dollars of credit. A photo estimate costs roughly 1–3 ¢.'),
    field('Anthropic API key', key), el('div', { class: 'chips' }, show), field('Model', model), saveKey, keyStatus));
  // Data
  const imp = el('input', { type: 'file', accept: 'application/json', hidden: '' });
  imp.onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text()); let n = 0;
      for (const [k, v] of Object.entries(j)) {
        const path = k.slice(3); if (!k.startsWith('pl:') || !SYNCED.test(path) || !v || typeof v !== 'object') continue;
        if (path === 'settings/main' && !v.apiKey && S.settings.apiKey) v.apiKey = S.settings.apiKey; // backups never contain the key
        if (store.set(path, v)) n++;
      }
      S.days = {}; reloadStateFromLocal(); toast('Restored ' + n + ' records'); refreshView();
    } catch (err) { toast('That file is not a Plate Ledger backup'); }
  };
  root.append(el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Data'),
    el('div', { class: 'hint' }, auth.user ? 'Your diary is saved to your Google account (private to you) and kept on this device for speed and offline use. Backups are optional now.' : 'Until you sign in, your diary lives only in this browser on this device — clearing website data would erase it.'),
    el('div', { class: 'row' }, el('button', { class: 'btn ghost', onclick: exportCsv }, 'Export CSV'), el('button', { class: 'btn ghost', onclick: exportBackup }, 'Backup (JSON)')),
    el('button', { class: 'btn ghost', onclick: () => imp.click() }, 'Restore from backup'), imp,
    el('div', { class: 'hint' }, `Food database: ${DB.ready ? DB.count[0].toLocaleString() + ' Canadian Nutrient File + ' + DB.count[1].toLocaleString() + ' USDA foods' : 'loading in the background'}. On this device: ${(store.usage() / 1048576).toFixed(1)} MB. Version ${APP_VERSION} (build ${BUILD.slice(0, 7)}).`)));
  root.append(healthCard());
}
function accountCard() {
  const c = el('div', { class: 'card stack' }, el('h2', { style: 'font-size:16px' }, 'Cloud sync'));
  if (!auth.user) {
    c.append(el('div', { class: 'hint' }, auth.expired ? 'You were signed out. Sign in again to keep syncing — everything on this device is kept.' : 'Sign in with your Google account to keep your diary safe and synced across your phone and computer. Nobody else can see your data.'),
      el('button', { class: 'btn', onclick: () => auth.signIn() }, 'Sign in with Google'));
    return c;
  }
  const line = el('div', { class: 'hint' });
  const plural = n => n + ' change' + (n === 1 ? '' : 's');
  const paint = () => {
    const n = sync.pending(), s = sync.status;
    line.textContent = s === 'syncing' ? 'Syncing…'
      : s === 'offline' ? (n ? `Offline — ${plural(n)} will upload when you’re back online.` : 'Offline — everything is saved on this device.')
      : s === 'error' ? `Sync problem: ${sync.error || 'unknown'}. Your data is safe on this device${n ? ` (${plural(n)} waiting)` : ''}.`
      : n ? `${plural(n)} waiting to upload…` : sync.lastSync ? 'Synced ' + new Date(sync.lastSync).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : 'Up to date';
  };
  paint(); const off = sync.on(() => { if (!line.isConnected) { off(); return; } paint(); });
  c.append(el('div', {}, el('strong', {}, auth.user.name || auth.user.email), el('div', { class: 'hint' }, auth.user.email)), line,
    el('div', { class: 'row' },
      el('button', { class: 'btn ghost', onclick: () => sync.run({ full: true }) }, 'Sync now'),
      el('button', { class: 'btn ghost', onclick: () => { const n = sync.pending(); if (confirm((n ? `${plural(n)} haven’t uploaded yet and will be lost. ` : '') + 'Sign out? Your diary stays safe in your Google account and is removed from this device until you sign in again.')) auth.signOut(); } }, 'Sign out')));
  return c;
}
function downloadText(filename, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = filename; document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function exportCsv() {
  const days = await store.allDays(); const rows = [['date', 'meal', 'food', 'qty', 'unit', 'grams', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'fibre_g', 'sugar_g', 'sodium_mg', 'source']];
  for (const d of days) { for (const e of d.entries || []) rows.push([d.date, e.meal, e.name, e.qty, e.unitLabel, r0(e.grams), r0(e.kcal), r1(e.p), r1(e.c), r1(e.f), r1(e.fib), r1(e.sug), r0(e.na), e.src]); if (d.weight) rows.push([d.date, 'weight', '', d.weight, 'kg', '', '', '', '', '', '', '', '', '']); for (const x of d.exercise || []) rows.push([d.date, 'activity', x.name, x.min, 'min', '', -r0(x.kcal), '', '', '', '', '', '', '']); }
  downloadText('plate-ledger-' + todayStr() + '.csv', rows.map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\n'), 'text/csv');
}
function exportBackup() {
  const j = {}; for (const k of store.allKeys()) { try { j[k] = JSON.parse(localStorage.getItem(k)); delete j[k]._rev; } catch (e) {} }
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
const APP_VERSION = '1.4.0', BUILD = '__BUILD__';
function reloadForUpdate() { if (S.reloading) return; S.reloading = true; location.reload(); }
function registerSW() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!had || S.reloading) return; // first install: this page is already current
    S.updateReady = true;
    if (performance.now() < 15000 && !sheetOpen()) reloadForUpdate(); // just opened: swap to the new version now; otherwise when the app is next hidden
  });
  navigator.serviceWorker.register('sw.js').then(reg => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
}
function rollDate() { if (S.shownToday && S.date !== todayStr()) { S.date = todayStr(); refreshView(); } } // left open overnight
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (auth.user && sync.pending()) sync.run({ pull: false, keepalive: true });
    if (S.updateReady) reloadForUpdate();
  } else {
    rollDate();
    if (auth.user && Date.now() - sync.lastPull > 15000) sync.run();
  }
});
window.addEventListener('online', () => { if (auth.user) sync.run(); });
setInterval(() => { if (auth.user && document.visibilityState === 'visible' && Date.now() - sync.lastPull > 170000) sync.run(); }, 60000);
document.addEventListener('focusout', () => { if (refreshPending) setTimeout(() => { if (refreshPending) refreshView(); }, 250); });
window.addEventListener('storage', e => { // another tab of the app changed something
  if (!e.key || !e.key.startsWith('pl:')) return;
  const k = e.key.slice(3);
  if (k.startsWith('days/')) {
    const d = k.slice(5);
    if (e.newValue == null) { store.days.delete(d); delete S.days[d]; }
    else { store.days.add(d); const cur = S.days[d]; if (cur) { try { const v = JSON.parse(e.newValue); for (const x of Object.keys(cur)) delete cur[x]; Object.assign(cur, v); cur.entries = cur.entries || []; cur.exercise = cur.exercise || []; } catch (er) { delete S.days[d]; } } }
  } else if (k === 'auth') auth.load();
  else if (/^(settings|foods|coach)\//.test(k)) reloadStateFromLocal();
  else return;
  clearTimeout(S.storageT); S.storageT = setTimeout(refreshView, 150);
});
(async () => {
  store.init(); auth.load(); reloadStateFromLocal();
  const t = todayStr(); for (let i = 0; i < 30 && !S.lastWeight; i++) { const d = dayLocal(addDays(t, -i)); if (d && d.weight) S.lastWeight = d.weight; }
  let tab = 'today'; try { tab = localStorage.getItem('pl:tab') || 'today'; } catch (e) {}
  const oauth = location.hash.includes('access_token=');
  if (await handleHealthUrl()) tab = 'today';
  showTab(tab); // the first screen comes straight from this device — no network, no SDK
  setTimeout(async () => {
    registerSW();
    if (oauth) { if (await auth.handleOAuthReturn()) refreshView(); }
    else if (!auth.user && !auth.checked) { try { await auth.migrateFromSdk(); } catch (e) {} auth.markChecked(); refreshView(); } // one-time carry-over of sign-ins from app versions ≤ 1.3
    if (auth.user) sync.run();
    maybeAutoAdjust();
    setTimeout(loadFoods, 300);
  }, 0);
})();
if (location.hostname === 'localhost' || window.__plTest) window.__pl = { S, store, sync, auth, DB, searchFoods, loadFoods, mergeDoc, mergeList, enc, dec, sameVal, compactEntry, loadDay, saveDay, dayLocal, downscale }; // test hook (never on the live site)
})();
