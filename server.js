// حكايا — خادم الموقع المستقل
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-5-5';
// محرك سعودي AI (Qwen مباشرة من Alibaba Cloud) — نفس مفتاح موقع سعودي AI
// محرك سعودي AI: نفس إعدادات موقع سعودي AI — إما Qwen مباشر (QWEN_API_KEY) أو SAUDI_BUILD_URL/KEY/MODEL (مثل OpenRouter)
const QWEN_DIRECT = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '';
const QWEN_KEY = QWEN_DIRECT || process.env.SAUDI_BUILD_KEY || '';
const QWEN_BASE = (QWEN_DIRECT ? (process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1') : (process.env.SAUDI_BUILD_URL || 'https://openrouter.ai/api/v1')).replace(/\/+$/, '');
const QWEN_MODEL = QWEN_DIRECT ? (process.env.QWEN_MODEL || 'qwen3.7-plus') : (process.env.SAUDI_BUILD_MODEL || 'qwen/qwen3.6-plus');
const SECRET = crypto.createHash('sha256').update('hikaya:' + (process.env.SESSION_SECRET || ADMIN_PASSWORD || 'dev')).digest();
const MAX_VIDEO = 20 * 1024 * 1024;
// توليد الفيديو عبر OpenRouter (نفس مفتاح سعودي AI)
const OR_KEY = process.env.OPENROUTER_API_KEY || (/openrouter\.ai/.test(process.env.SAUDI_BUILD_URL || 'https://openrouter.ai') ? process.env.SAUDI_BUILD_KEY || '' : '');
// أفضل جودة وبشر واقعيين: Veo 3.1 Fast (جودة Veo بتكلفة أقل ~0.12$/ث). للجودة القصوى: VIDEO_MODEL=google/veo-3.1
const VIDEO_MODEL = process.env.VIDEO_MODEL || 'google/veo-3.1-fast';
// صور الشخصيات والإطار الأول للقطة (لثبات الشكل): Gemini Flash Image عبر OpenRouter
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'google/gemini-3.1-flash-image';
async function dataUrlOf(id) {
  const r = await pool.query('SELECT type, data FROM videos WHERE id=$1', [id]);
  if (!r.rows.length || !/^image\//.test(r.rows[0].type)) return null;
  return 'data:' + r.rows[0].type + ';base64,' + r.rows[0].data.toString('base64');
}
async function genImage(prompt, refIds, aspect) {
  const content = [{ type: 'text', text: prompt }];
  for (const id of (refIds || []).slice(0, 4)) { const u = await dataUrlOf(id); if (u) content.push({ type: 'image_url', image_url: { url: u } }); }
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + OR_KEY, 'content-type': 'application/json', 'X-Title': 'Hikaya' },
    body: JSON.stringify({ model: IMAGE_MODEL, modalities: ['image', 'text'], image_config: { aspect_ratio: aspect || '9:16' }, messages: [{ role: 'user', content }] })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('image', r.status, JSON.stringify(d).slice(0, 400)); throw Object.assign(new Error(r.status === 402 ? 'رصيد OpenRouter ما يكفي' : (d?.error?.message || 'تعذر توليد الصورة')), { status: r.status }); }
  const url = d.choices?.[0]?.message?.images?.[0]?.image_url?.url || '';
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/s.exec(url);
  if (!m) { console.error('image no data', JSON.stringify(d).slice(0, 300)); throw new Error('النموذج ما رجّع صورة، جرّب مرة ثانية'); }
  const id = crypto.randomBytes(9).toString('hex');
  await pool.query('INSERT INTO videos(id,type,data) VALUES($1,$2,$3)', [id, m[1], Buffer.from(m[2], 'base64')]);
  console.log('image saved', id, 'refs', content.length - 1);
  return id;
}
const VIDEO_RES = process.env.VIDEO_RESOLUTION || '1080p';
const VIDEO_SECS = Number(process.env.VIDEO_SECONDS || 8);

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } })
  : null;

async function init() {
  if (!pool) { console.warn('DATABASE_URL غير موجود'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS series (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS votes (visitor TEXT NOT NULL, key TEXT NOT NULL, idx INT NOT NULL, PRIMARY KEY (visitor, key));
    CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, type TEXT NOT NULL, data BYTEA NOT NULL, created TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pass TEXT NOT NULL, coins INT NOT NULL DEFAULT 0, vip_until TIMESTAMPTZ, last_checkin DATE, created TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS unlocks (uid TEXT NOT NULL, sid TEXT NOT NULL, n INT NOT NULL, at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (uid, sid, n));
    CREATE TABLE IF NOT EXISTS progress (uid TEXT NOT NULL, sid TEXT NOT NULL, n INT NOT NULL, at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (uid, sid));
    CREATE TABLE IF NOT EXISTS favs (uid TEXT NOT NULL, sid TEXT NOT NULL, at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (uid, sid));
    CREATE TABLE IF NOT EXISTS stats (sid TEXT PRIMARY KEY, views INT NOT NULL DEFAULT 0);
  `);
}

const STUDIO = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const WATCH = fs.readFileSync(path.join(__dirname, 'public', 'watch.html'));
const WELCOME_COINS = Number(process.env.WELCOME_COINS || 50);
const CHECKIN_COINS = Number(process.env.CHECKIN_COINS || 10);

function sign(v) { return v + '.' + crypto.createHmac('sha256', SECRET).update(v).digest('base64url'); }
function unsign(s) {
  if (!s || !s.includes('.')) return null;
  const v = s.slice(0, s.lastIndexOf('.'));
  const a = Buffer.from(sign(v)), b = Buffer.from(s);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? v : null;
}
function cookies(req) {
  const o = {};
  for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return o;
}
const isAdmin = req => unsign(cookies(req).hk_admin) === 'admin';
const userId = req => { const v = unsign(cookies(req).hk_u); return v && v.startsWith('u:') ? v.slice(2) : null; };
const hashPass = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
const checkPass = (pw, stored) => { const [salt, h] = String(stored).split(':'); const a = Buffer.from(hashPass(pw, salt).split(':')[1], 'hex'), b = Buffer.from(h || '', 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const userCookie = id => `hk_u=${encodeURIComponent(sign('u:' + id))}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure`;
const isVip = u => u && u.vip_until && new Date(u.vip_until) > new Date();
async function getUser(req) { const id = userId(req); if (!id) return null; const r = await pool.query('SELECT * FROM users WHERE id=$1', [id]); return r.rows[0] || null; }
function visitor(req, res) {
  let v = unsign(cookies(req).hk_v);
  if (!v) { v = crypto.randomBytes(12).toString('hex'); res.setHeader('Set-Cookie', `hk_v=${encodeURIComponent(sign(v))}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure`); }
  return v;
}
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
function body(req, limit = 1024 * 1024) {
  return new Promise((ok, bad) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { bad(Object.assign(new Error('too_big'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', bad);
  });
}
const json = async req => JSON.parse((await body(req)).toString() || '{}');

// نسخة عامة: فقط المنشور، بدون الحلقات غير المنشورة
function publicView(s) {
  if (!s.published) return null;
  const eps = (s.episodes || []).filter(e => e.published);
  if (!eps.length) return null;
  return { ...s, episodes: eps };
}

// نسخة المشاهد على طريقة NetShort: الحلقات المقفلة تظهر بعنوانها وملخصها فقط
const strip = sc => ({ place: sc.place, action: sc.action, lines: sc.lines, video: sc.video || null });
function catalogView(s, unlocked, vip) {
  const pv = publicView(s); if (!pv) return null;
  const free = Number.isInteger(s.freeEps) ? s.freeEps : 5, price = Number.isInteger(s.epPrice) ? s.epPrice : 10;
  const cover = s.cover || (s.characters || []).find(c => c.hero && c.img)?.img || (s.characters || []).find(c => c.img)?.img || null;
  return {
    id: s.id, title: s.title, logline: s.logline, genre: s.genre, heroes: s.heroes, featured: !!s.featured, cover, free, price,
    characters: (s.characters || []).map(c => ({ name: c.name, role: c.role, hero: !!c.hero, img: c.img || null })),
    episodes: pv.episodes.map(e => {
      const open = e.n <= free || vip || unlocked.has(s.id + '__' + e.n);
      return { n: e.n, title: e.title, summary: e.summary, locked: !open, poll: open ? e.poll : null, cliffhanger: open ? e.cliffhanger : null,
        video: open ? (e.video || null) : null, scenes: open ? (e.scenes || []).map(strip) : [], thumb: (e.scenes || []).find(x => x.frame)?.frame || null };
    })
  };
}

// محدد بسيط للطلبات
const hits = new Map();
function limited(key, max, ms) {
  const now = Date.now(), h = (hits.get(key) || []).filter(t => now - t < ms);
  h.push(now); hits.set(key, h);
  return h.length > max;
}

async function counts() {
  const r = await pool.query('SELECT key, idx, count(*)::int AS c FROM votes GROUP BY key, idx');
  const o = {};
  for (const x of r.rows) (o[x.key] ||= {})[x.idx] = x.c;
  return o;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/healthz') return send(res, 200, { ok: true });

    if (p === '/api/me') return send(res, 200, { video: !!OR_KEY, admin: isAdmin(req), ai: !!(AI_KEY || QWEN_KEY), engines: { saudi: !!QWEN_KEY, claude: !!AI_KEY }, db: !!pool });

    if (p === '/api/login' && req.method === 'POST') {
      if (limited('login:' + req.socket.remoteAddress, 8, 15 * 60e3)) return send(res, 429, { error: 'محاولات كثيرة' });
      const { password } = await json(req);
      const ok = ADMIN_PASSWORD && typeof password === 'string' && password.length === ADMIN_PASSWORD.length &&
        crypto.timingSafeEqual(Buffer.from(password), Buffer.from(ADMIN_PASSWORD));
      if (!ok) return send(res, 401, { error: 'كلمة السر غلط' });
      return send(res, 200, { ok: true }, { 'Set-Cookie': `hk_admin=${encodeURIComponent(sign('admin'))}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure` });
    }
    if (p === '/api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'hk_admin=; Path=/; Max-Age=0' });

    if (!pool && p.startsWith('/api/')) return send(res, 503, { error: 'قاعدة البيانات غير مربوطة' });

    // ===== المشاهدون =====
    if (p === '/api/catalog' && req.method === 'GET') {
      const u = await getUser(req);
      const un = new Set(u ? (await pool.query('SELECT sid, n FROM unlocks WHERE uid=$1', [u.id])).rows.map(x => x.sid + '__' + x.n) : []);
      const r = await pool.query('SELECT s.data, COALESCE(t.views,0) AS views FROM series s LEFT JOIN stats t ON t.sid = s.id ORDER BY s.updated DESC');
      return send(res, 200, { series: r.rows.map(x => { const c = catalogView(x.data, un, isVip(u)); if (c) c.views = x.views; return c; }).filter(Boolean) });
    }
    if (p === '/api/u/register' && req.method === 'POST') {
      if (limited('reg:' + req.socket.remoteAddress, 10, 3600e3)) return send(res, 429, { error: 'محاولات كثيرة' });
      const { name, email, password } = await json(req);
      const em = String(email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return send(res, 400, { error: 'البريد غير صحيح' });
      if (String(password || '').length < 6) return send(res, 400, { error: 'كلمة السر 6 أحرف على الأقل' });
      const nm = String(name || '').trim().slice(0, 40) || em.split('@')[0];
      const id = crypto.randomBytes(9).toString('hex');
      try { await pool.query('INSERT INTO users(id,email,name,pass,coins) VALUES($1,$2,$3,$4,$5)', [id, em, nm, hashPass(String(password)), WELCOME_COINS]); }
      catch (e) { return send(res, 409, { error: 'البريد مسجل من قبل، سجّل دخول' }); }
      return send(res, 200, { ok: true, welcome: WELCOME_COINS }, { 'Set-Cookie': userCookie(id) });
    }
    if (p === '/api/u/login' && req.method === 'POST') {
      if (limited('ulogin:' + req.socket.remoteAddress, 20, 15 * 60e3)) return send(res, 429, { error: 'محاولات كثيرة' });
      const { email, password } = await json(req);
      const r = await pool.query('SELECT id, pass FROM users WHERE email=$1', [String(email || '').trim().toLowerCase()]);
      if (!r.rows.length || !checkPass(String(password || ''), r.rows[0].pass)) return send(res, 401, { error: 'البريد أو كلمة السر غلط' });
      return send(res, 200, { ok: true }, { 'Set-Cookie': userCookie(r.rows[0].id) });
    }
    if (p === '/api/u/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'hk_u=; Path=/; Max-Age=0' });
    if (p === '/api/u/me' && req.method === 'GET') {
      const u = await getUser(req);
      if (!u) return send(res, 200, { user: null });
      const [pr, fv] = await Promise.all([pool.query('SELECT sid, n FROM progress WHERE uid=$1 ORDER BY at DESC LIMIT 20', [u.id]), pool.query('SELECT sid FROM favs WHERE uid=$1 ORDER BY at DESC', [u.id])]);
      const today = new Date().toISOString().slice(0, 10);
      return send(res, 200, { user: { name: u.name, email: u.email, coins: u.coins, vip: isVip(u), vipUntil: u.vip_until, checkedToday: u.last_checkin && new Date(u.last_checkin).toISOString().slice(0, 10) === today }, progress: pr.rows, favs: fv.rows.map(x => x.sid), checkin: CHECKIN_COINS });
    }
    if (p === '/api/u/checkin' && req.method === 'POST') {
      const id = userId(req); if (!id) return send(res, 401, { error: 'سجّل دخول أول' });
      const r = await pool.query("UPDATE users SET coins = coins + $2, last_checkin = CURRENT_DATE WHERE id=$1 AND (last_checkin IS NULL OR last_checkin < CURRENT_DATE) RETURNING coins", [id, CHECKIN_COINS]);
      if (!r.rows.length) return send(res, 400, { error: 'أخذت مكافأة اليوم، ارجع بكرة' });
      return send(res, 200, { coins: r.rows[0].coins, added: CHECKIN_COINS });
    }
    if (p === '/api/u/unlock' && req.method === 'POST') {
      const id = userId(req); if (!id) return send(res, 401, { error: 'سجّل دخول أول' });
      const { sid, n } = await json(req);
      const sr = await pool.query('SELECT data FROM series WHERE id=$1', [String(sid || '')]);
      const s = sr.rows[0]?.data; if (!s || !s.published) return send(res, 404, { error: 'المسلسل غير موجود' });
      const ep = (s.episodes || []).find(e => e.n === n && e.published); if (!ep) return send(res, 404, { error: 'الحلقة غير موجودة' });
      const price = Number.isInteger(s.epPrice) ? s.epPrice : 10;
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const had = await c.query('SELECT 1 FROM unlocks WHERE uid=$1 AND sid=$2 AND n=$3', [id, s.id, n]);
        if (had.rows.length) { await c.query('ROLLBACK'); return send(res, 200, { ok: true }); }
        const u = await c.query('UPDATE users SET coins = coins - $2 WHERE id=$1 AND coins >= $2 RETURNING coins', [id, price]);
        if (!u.rows.length) { await c.query('ROLLBACK'); return send(res, 402, { error: 'رصيدك ما يكفي', need: price }); }
        await c.query('INSERT INTO unlocks(uid,sid,n) VALUES($1,$2,$3)', [id, s.id, n]);
        await c.query('COMMIT');
        return send(res, 200, { ok: true, coins: u.rows[0].coins });
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    }
    if (p === '/api/u/progress' && req.method === 'POST') {
      const { sid, n } = await json(req);
      if (typeof sid !== 'string' || !/^[a-z0-9]{4,40}$/i.test(sid) || !Number.isInteger(n)) return send(res, 400, { error: 'بيانات غير صالحة' });
      if (!limited('view:' + req.socket.remoteAddress + sid + n, 1, 600e3)) await pool.query('INSERT INTO stats(sid,views) VALUES($1,1) ON CONFLICT(sid) DO UPDATE SET views = stats.views + 1', [sid]);
      const id = userId(req);
      if (id) await pool.query('INSERT INTO progress(uid,sid,n,at) VALUES($1,$2,$3,now()) ON CONFLICT(uid,sid) DO UPDATE SET n=$3, at=now()', [id, sid, n]);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/u/fav' && req.method === 'POST') {
      const id = userId(req); if (!id) return send(res, 401, { error: 'سجّل دخول أول' });
      const { sid, on } = await json(req);
      if (typeof sid !== 'string' || !/^[a-z0-9]{4,40}$/i.test(sid)) return send(res, 400, { error: 'بيانات غير صالحة' });
      if (on) await pool.query('INSERT INTO favs(uid,sid) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, sid]); else await pool.query('DELETE FROM favs WHERE uid=$1 AND sid=$2', [id, sid]);
      return send(res, 200, { ok: true });
    }
    // ===== إدارة المشاهدين =====
    if (p === '/api/admin/users' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'للمدير فقط' });
      const r = await pool.query('SELECT id, name, email, coins, vip_until, created FROM users ORDER BY created DESC LIMIT 500');
      const t = await pool.query('SELECT count(*)::int AS users, COALESCE(sum(coins),0)::int AS coins FROM users');
      const un = await pool.query('SELECT count(*)::int AS c FROM unlocks');
      return send(res, 200, { users: r.rows, totals: { ...t.rows[0], unlocks: un.rows[0].c } });
    }
    if (p === '/api/admin/grant' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'للمدير فقط' });
      const { uid, coins, vipDays } = await json(req);
      const c = Number.isInteger(coins) ? Math.max(-100000, Math.min(100000, coins)) : 0, d = Number.isInteger(vipDays) ? Math.max(0, Math.min(3650, vipDays)) : 0;
      const r = await pool.query("UPDATE users SET coins = GREATEST(0, coins + $2), vip_until = CASE WHEN $3::int > 0 THEN GREATEST(COALESCE(vip_until, now()), now()) + ($3::int || ' days')::interval ELSE vip_until END WHERE id=$1 RETURNING coins, vip_until", [String(uid || ''), c, d]);
      if (!r.rows.length) return send(res, 404, { error: 'المستخدم غير موجود' });
      return send(res, 200, r.rows[0]);
    }

    if (p === '/api/series' && req.method === 'GET') {
      const r = await pool.query('SELECT data FROM series ORDER BY updated DESC');
      const all = r.rows.map(x => x.data);
      return send(res, 200, { series: isAdmin(req) ? all : all.map(publicView).filter(Boolean) });
    }
    const m = p.match(/^\/api\/series\/([a-z0-9]{4,40})$/i);
    if (m) {
      if (!isAdmin(req)) return send(res, 403, { error: 'للمدير فقط' });
      if (req.method === 'PUT') {
        const s = JSON.parse((await body(req, 2 * 1024 * 1024)).toString());
        s.id = m[1];
        await pool.query('INSERT INTO series(id,data,updated) VALUES($1,$2,now()) ON CONFLICT(id) DO UPDATE SET data=$2, updated=now()', [m[1], s]);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        await pool.query('DELETE FROM series WHERE id=$1', [m[1]]);
        await pool.query('DELETE FROM votes WHERE key LIKE $1', [m[1] + '\\_\\_%']);
        return send(res, 200, { ok: true });
      }
    }

    if (p === '/api/votes' && req.method === 'GET') {
      const v = visitor(req, res);
      const mine = await pool.query('SELECT key, idx FROM votes WHERE visitor=$1', [v]);
      return send(res, 200, { counts: await counts(), mine: Object.fromEntries(mine.rows.map(x => [x.key, x.idx])) });
    }
    if (p === '/api/vote' && req.method === 'POST') {
      const v = visitor(req, res);
      if (limited('vote:' + req.socket.remoteAddress, 60, 60e3)) return send(res, 429, { error: 'انتظر قليلاً' });
      const { key, idx } = await json(req);
      if (typeof key !== 'string' || !/^[a-z0-9]{4,40}__\d{1,2}$/i.test(key) || !Number.isInteger(idx) || idx < 0 || idx > 5) return send(res, 400, { error: 'تصويت غير صالح' });
      await pool.query('INSERT INTO votes(visitor,key,idx) VALUES($1,$2,$3) ON CONFLICT(visitor,key) DO UPDATE SET idx=$3', [v, key, idx]);
      const mine = await pool.query('SELECT key, idx FROM votes WHERE visitor=$1', [v]);
      return send(res, 200, { counts: await counts(), mine: Object.fromEntries(mine.rows.map(x => [x.key, x.idx])) });
    }

    if (p === '/api/ai' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'للمدير فقط' });
      const { prompt, engine } = await json(req);
      const bad = k => k && /[^\x21-\x7e]/.test(k);
      if (bad(QWEN_KEY) || bad(AI_KEY)) return send(res, 500, { error: 'المفتاح المحفوظ في Render فيه نقاط أو رموز مخفية (•) بدل المفتاح الحقيقي. انسخ المفتاح الأصلي من مصدره والصقه من جديد' + (bad(QWEN_KEY) ? ' في مفتاح سعودي AI' : '') + (bad(AI_KEY) ? ' في ANTHROPIC_API_KEY' : '') });
      const text = String(prompt).slice(0, 40000);
      const useSaudi = engine === 'saudi' ? true : engine === 'claude' ? false : !!QWEN_KEY;
      if (useSaudi) {
        if (!QWEN_KEY) return send(res, 503, { error: 'مفتاح سعودي AI غير مضاف (SAUDI_BUILD_KEY أو QWEN_API_KEY) في إعدادات Render' });
        const r = await fetch(QWEN_BASE + '/chat/completions', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + QWEN_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: QWEN_MODEL, max_tokens: 16000,
            messages: [{ role: 'system', content: 'أنت سعودي AI، كاتب مسلسلات. أجب بـ JSON صالح فقط بدون أي شرح أو علامات كود.' }, { role: 'user', content: text }],
            ...(QWEN_DIRECT ? { enable_thinking: false } : { reasoning: { enabled: false, exclude: true } })
          })
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { console.error('saudi engine', r.status, JSON.stringify(d).slice(0, 500)); return send(res, 502, { error: r.status === 402 ? 'رصيد OpenRouter ما يكفي، اشحن الرصيد من openrouter.ai/settings/credits' : (d?.error?.message || 'خطأ من محرك سعودي AI') }); }
        const out = d.choices?.[0]?.message?.content || '';
        console.log('saudi engine ok', QWEN_MODEL, 'chars', out.length, 'finish', d.choices?.[0]?.finish_reason);
        if (!out.trim()) return send(res, 502, { error: 'محرك سعودي AI رجّع رد فاضي (' + (d.choices?.[0]?.finish_reason || d?.error?.message || 'بدون سبب') + ')، جرّب مرة ثانية' });
        return send(res, 200, { text: out, engine: 'saudi' });
      }
      if (!AI_KEY) return send(res, 503, { error: 'مفتاح Claude غير مضاف (ANTHROPIC_API_KEY) في إعدادات Render' });
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: AI_MODEL, max_tokens: 8000, messages: [{ role: 'user', content: text }] })
      });
      const d = await r.json();
      if (!r.ok) return send(res, 502, { error: d?.error?.message || 'خطأ من خدمة الذكاء الاصطناعي' });
      return send(res, 200, { text: (d.content || []).map(c => c.text || '').join(''), engine: 'claude' });
    }

    if (p === '/api/image' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'للمدير فقط' });
      if (!OR_KEY) return send(res, 503, { error: 'مفتاح OpenRouter غير مضاف (SAUDI_BUILD_KEY)' });
      const { prompt, refs, aspect } = await json(req);
      if (typeof prompt !== 'string' || prompt.length < 5) return send(res, 400, { error: 'وصف الصورة فاضي' });
      const ids = Array.isArray(refs) ? refs.filter(x => /^[a-f0-9]{18}$/.test(x)) : [];
      try { return send(res, 200, { id: await genImage(prompt.slice(0, 6000), ids, ['9:16', '3:4', '1:1'].includes(aspect) ? aspect : '9:16') }); }
      catch (e) { return send(res, e.status === 402 ? 402 : 502, { error: e.message }); }
    }

    if (p === '/api/video/start' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'للمدير فقط' });
      if (!OR_KEY) return send(res, 503, { error: 'مفتاح OpenRouter غير مضاف (SAUDI_BUILD_KEY)' });
      const { prompt, resolution, duration, firstFrame } = await json(req);
      // Veo يقبل فقط 4/6/8 ثواني للقطة؛ نماذج أخرى (wan) تقبل حتى 30
      let secs = Number.isInteger(duration) && duration >= 2 && duration <= 30 ? duration : VIDEO_SECS;
      if (/veo/i.test(VIDEO_MODEL)) secs = secs >= 8 ? 8 : secs >= 6 ? 6 : 4;
      const res2 = ['480p', '720p', '1080p'].includes(resolution) ? resolution : VIDEO_RES;
      if (typeof prompt !== 'string' || prompt.length < 10) return send(res, 400, { error: 'أمر اللقطة فاضي، اكتب المشاهد أول' });
      const r = await fetch('https://openrouter.ai/api/v1/videos', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + OR_KEY, 'content-type': 'application/json', 'X-Title': 'Hikaya' },
        body: JSON.stringify({ model: VIDEO_MODEL, prompt: prompt.slice(0, 4000), duration: secs, resolution: res2, aspect_ratio: '9:16', generate_audio: true,
          ...(typeof firstFrame === 'string' && /^[a-f0-9]{18}$/.test(firstFrame) ? { frame_images: [{ type: 'image_url', image_url: { url: 'https://' + req.headers.host + '/v/' + firstFrame }, frame_type: 'first_frame' }] } : {}) })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.id) { console.error('video start', r.status, JSON.stringify(d).slice(0, 400)); return send(res, r.status === 402 ? 402 : 502, { error: r.status === 402 ? (d?.error?.metadata?.reason === 'in_flight_budget_exhausted' ? 'فيه فيديوهات قيد التوليد تحجز الرصيد، انتظر لين تخلص' : 'رصيد OpenRouter ما يكفي، اشحن الرصيد من openrouter.ai/settings/credits') : (d?.error?.message || ('تعذر بدء الفيديو ' + r.status)) }); }
      console.log('video start', d.id);
      return send(res, 200, { job: d.id, status: d.status || 'pending' });
    }
    if (p === '/api/video/status' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'للمدير فقط' });
      const job = url.searchParams.get('job') || '';
      if (!/^[\w-]{4,120}$/.test(job)) return send(res, 400, { error: 'رقم مهمة غير صالح' });
      const r = await fetch('https://openrouter.ai/api/v1/videos/' + job, { headers: { Authorization: 'Bearer ' + OR_KEY } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return send(res, 502, { error: d?.error?.message || ('تعذر متابعة الفيديو ' + r.status) });
      if (d.status === 'completed') {
        const c = await fetch('https://openrouter.ai/api/v1/videos/' + job + '/content?index=0', { headers: { Authorization: 'Bearer ' + OR_KEY } });
        if (!c.ok) return send(res, 200, { status: 'in_progress', progress: 99 });
        const buf = Buffer.from(await c.arrayBuffer());
        const id = crypto.randomBytes(9).toString('hex');
        await pool.query('INSERT INTO videos(id,type,data) VALUES($1,$2,$3)', [id, 'video/mp4', buf]);
        console.log('video saved', job, id, buf.length, 'cost', d.usage?.cost);
        return send(res, 200, { status: 'completed', videoId: id, cost: d.usage?.cost });
      }
      if (['failed', 'cancelled', 'expired'].includes(d.status)) return send(res, 200, { status: d.status, error: (d.error && (d.error.message || d.error)) || d.status });
      return send(res, 200, { status: d.status || 'pending', progress: d.progress ?? null, detail: d.status_detail || '' });
    }

    if (p === '/api/upload' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'للمدير فقط' });
      const type = String(req.headers['content-type'] || '');
      if (!/^video\/(mp4|webm|quicktime)$/.test(type)) return send(res, 400, { error: 'ارفع فيديو mp4 أو webm' });
      const data = await body(req, MAX_VIDEO);
      const id = crypto.randomBytes(9).toString('hex');
      await pool.query('INSERT INTO videos(id,type,data) VALUES($1,$2,$3)', [id, type, data]);
      return send(res, 200, { id });
    }

    const vm = p.match(/^\/v\/([a-f0-9]{18})$/);
    if (vm) {
      const r = await pool.query('SELECT type, data FROM videos WHERE id=$1', [vm[1]]);
      if (!r.rows.length) { res.writeHead(404); return res.end(); }
      const { type, data } = r.rows[0], size = data.length;
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' };
      if (range) {
        let s = range[1] ? +range[1] : size - +range[2], e = range[1] && range[2] ? +range[2] : size - 1;
        if (!range[1]) e = size - 1;
        if (s >= size || s < 0 || e < s) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        e = Math.min(e, size - 1);
        res.writeHead(206, { ...head, 'Content-Range': `bytes ${s}-${e}/${size}`, 'Content-Length': e - s + 1 });
        return res.end(data.subarray(s, e + 1));
      }
      res.writeHead(200, { ...head, 'Content-Length': size });
      return res.end(data);
    }

    if (p === '/studio' || p === '/studio/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(STUDIO);
    }
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(WATCH);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('غير موجود');
  } catch (e) {
    console.error(e);
    send(res, e.code === 413 ? 413 : 500, { error: e.code === 413 ? 'الملف أكبر من المسموح (20 ميجا)' : 'خطأ في الخادم' });
  }
});

init().then(() => server.listen(PORT, () => console.log('حكايا تعمل على', PORT))).catch(e => { console.error(e); process.exit(1); });
