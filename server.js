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
const SECRET = crypto.createHash('sha256').update('hikaya:' + (process.env.SESSION_SECRET || ADMIN_PASSWORD || 'dev')).digest();
const MAX_VIDEO = 20 * 1024 * 1024;

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } })
  : null;

async function init() {
  if (!pool) { console.warn('DATABASE_URL غير موجود'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS series (id TEXT PRIMARY KEY, data JSONB NOT NULL, updated TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS votes (visitor TEXT NOT NULL, key TEXT NOT NULL, idx INT NOT NULL, PRIMARY KEY (visitor, key));
    CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, type TEXT NOT NULL, data BYTEA NOT NULL, created TIMESTAMPTZ DEFAULT now());
  `);
}

const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

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

    if (p === '/api/me') return send(res, 200, { admin: isAdmin(req), ai: !!AI_KEY, db: !!pool });

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
      if (!AI_KEY) return send(res, 503, { error: 'مفتاح الذكاء الاصطناعي غير مضاف في إعدادات Render' });
      const { prompt } = await json(req);
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': AI_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: AI_MODEL, max_tokens: 8000, messages: [{ role: 'user', content: String(prompt).slice(0, 40000) }] })
      });
      const d = await r.json();
      if (!r.ok) return send(res, 502, { error: d?.error?.message || 'خطأ من خدمة الذكاء الاصطناعي' });
      return send(res, 200, { text: (d.content || []).map(c => c.text || '').join('') });
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

    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(INDEX);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('غير موجود');
  } catch (e) {
    console.error(e);
    send(res, e.code === 413 ? 413 : 500, { error: e.code === 413 ? 'الملف أكبر من المسموح (20 ميجا)' : 'خطأ في الخادم' });
  }
});

init().then(() => server.listen(PORT, () => console.log('حكايا تعمل على', PORT))).catch(e => { console.error(e); process.exit(1); });
