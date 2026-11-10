// Shared helpers: signed session tokens, Supabase REST access, email sending, request helpers.
// The SESSION_SECRET environment variable (set in Netlify) is the only secret used for tokens.
const https = require('https');
const crypto = require('crypto');

const ADMIN_TTL_S = 72 * 3600;      // admins and read-only admins: 3 days, same as members
const MEMBER_TTL_S = 72 * 3600;     // contributors and everyone else: 72 hours
const CODE_TTL_MIN = 10;            // email login code validity
const ALLOWED_ORIGINS = ['https://www.fundova.africa', 'https://fundova.africa', 'https://cooperative.fundova.africa'];

function secret() {
  const s = process.env.SESSION_SECRET || '';
  if (s.length < 32) throw new Error('SESSION_SECRET is missing or too short (use at least 32 random characters)');
  return s;
}
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function ttlFor(role) { return (role === 'admin' || role === 'admin_view') ? ADMIN_TTL_S : MEMBER_TTL_S; }

function signToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { uid: String(user.id), role: user.role, email: String(user.email || '').toLowerCase(), iat: now, exp: now + ttlFor(user.role) };
  const p = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', secret()).update(p).digest());
  return { token: p + '.' + sig, exp: payload.exp };
}

function verifyToken(token) {
  try {
    if (!token || typeof token !== 'string' || token.length > 2000) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const expect = crypto.createHmac('sha256', secret()).update(parts[0]).digest();
    const got = unb64u(parts[1]);
    if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return null;
    const payload = JSON.parse(unb64u(parts[0]).toString('utf8'));
    if (!payload || !payload.uid || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) { return null; }
}

function bearer(event) {
  const h = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

function hashCode(email, code) {
  return crypto.createHmac('sha256', secret()).update(String(email).toLowerCase() + ':' + String(code)).digest('hex');
}
function newCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'utf8'), y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function clientIp(event) {
  const h = event.headers || {};
  return h['x-nf-client-connection-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

// Who is calling: checks the signed token, then confirms the account is still open.
// Returns {uid, role, email}, or null when there is no token. Throws 'session_expired' for a bad or closed one.
async function getCaller(event) {
  const tok = bearer(event);
  if (!tok) return null;
  const p = verifyToken(tok);
  if (!p) throw new Error('session_expired');
  const r = await module.exports.supa('users?id=eq.' + encodeURIComponent(p.uid) + '&select=id,role,status,email&limit=1', 'GET');
  const row = (r.status === 200 && Array.isArray(r.data) && r.data[0]) || null;
  if (!row || row.status === 'revoked' || row.status === 'closed') throw new Error('session_expired');
  return { uid: String(row.id), role: row.role, email: String(row.email || '').toLowerCase() };
}

function corsHeaders(event) {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin' };
  if (ALLOWED_ORIGINS.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  }
  return h;
}
function reply(event, statusCode, obj) { return { statusCode, headers: corsHeaders(event), body: typeof obj === 'string' ? obj : JSON.stringify(obj) }; }

// ── Supabase REST (service role) ──
function supa(path, method, body) {
  return new Promise((resolve, reject) => {
    const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !key) return reject(new Error('Supabase env missing'));
    const u = new URL(base.replace(/\/$/, '') + '/rest/v1/' + path);
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=representation' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: method || 'GET', headers }, (res) => {
      let out = ''; res.on('data', c => out += c);
      res.on('end', () => {
        let parsed = null; try { parsed = out ? JSON.parse(out) : null; } catch (e) { parsed = out; }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Supabase timeout')));
    if (data) req.write(data);
    req.end();
  });
}

// ── Resend ──
function sendResend(to, subject, html) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ from: 'Fundova <no-reply@fundova.africa>', to: [to], subject, html });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Resend timeout')));
    req.write(payload); req.end();
  });
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

module.exports = {
  ADMIN_TTL_S, MEMBER_TTL_S, CODE_TTL_MIN, ALLOWED_ORIGINS,
  signToken, verifyToken, bearer, hashCode, newCode, safeEqualHex, clientIp,
  corsHeaders, reply, supa, sendResend, esc, EMAIL_RE, ttlFor, getCaller
};
