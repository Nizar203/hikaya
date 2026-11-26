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
const VIDEO_MODEL = process.env.VIDEO_MODEL || 'alibaba/wan-3.0';
const VIDEO_RES = process.env.VIDEO_RESOLUTION || '720p';
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

    if (p === '/api/video/start' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'للمدير فقط' });
      if (!OR_KEY) return send(res, 503, { error: 'مفتاح OpenRouter غير مضاف (SAUDI_BUILD_KEY)' });
      const { prompt, resolution, duration } = await json(req);
      const secs = Number.isInteger(duration) && duration >= 2 && duration <= 30 ? duration : VIDEO_SECS;
      const res2 = ['480p', '720p', '1080p'].includes(resolution) ? resolution : VIDEO_RES;
      if (typeof prompt !== 'string' || prompt.length < 10) return send(res, 400, { error: 'أمر اللقطة فاضي، اكتب المشاهد أول' });
      const r = await fetch('https://openrouter.ai/api/v1/videos', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + OR_KEY, 'content-type': 'application/json', 'X-Title': 'Hikaya' },
        body: JSON.stringify({ model: VIDEO_MODEL, prompt: prompt.slice(0, 4000), duration: secs, resolution: res2, aspect_ratio: '9:16', generate_audio: true })
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
