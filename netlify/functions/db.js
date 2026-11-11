// Database gateway. The browser never talks to the database directly: every request comes here,
// must carry a signed session token (except a few public actions), and is checked against policy.js.
const crypto = require('crypto');
const A = require('./_lib/auth');
const P = require('./_lib/policy');
const PUSH = require('./_lib/push');

// remember who is who for a minute, so a revoked or closed account is cut off quickly
const userCache = new Map();
async function currentUserRow(uid) {
  const hit = userCache.get(uid);
  if (hit && hit.t > Date.now()) return hit.row;
  // A failed lookup (database busy or slow) is NOT the same as "no such user": never sign someone out because of it.
  let r = null;
  for (let i = 0; i < 3; i++) {
    try { r = await A.supa(`users?id=eq.${encodeURIComponent(uid)}&select=id,role,status,email&limit=1`, 'GET'); } catch (e) { r = null; }
    if (r && r.status === 200 && Array.isArray(r.data)) break;
    await new Promise(res => setTimeout(res, 150 * (i + 1)));
  }
  if (!r || r.status !== 200 || !Array.isArray(r.data)) { console.log('USER_LOOKUP_FAILED', r && r.status); const e = new Error('lookup_failed'); throw e; }
  const row = r.data[0] || null;
  userCache.set(uid, { row, t: Date.now() + 60 * 1000 });
  if (userCache.size > 2000) userCache.clear();
  return row;
}

// light per-visitor limit on the two public forms (best effort; resets when the function restarts)
const pubHits = new Map();
function publicLimited(ip, key) {
  const now = Date.now(), k = ip + '|' + key;
  const arr = (pubHits.get(k) || []).filter(t => now - t < 3600 * 1000);
  arr.push(now); pubHits.set(k, arr);
  if (pubHits.size > 5000) pubHits.clear();
  return arr.length > 15;
}

const pushHits = new Map();
function pushLimited(uid) {
  const now = Date.now(); const arr = (pushHits.get(uid) || []).filter(t => now - t < 60 * 1000);
  arr.push(now); pushHits.set(uid, arr); if (pushHits.size > 500) pushHits.clear();
  return arr.length > 120;
}

function stripPin(x) {
  if (Array.isArray(x)) return x.map(stripPin);
  if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x)) if (k !== 'pin') o[k] = stripPin(x[k]); return o; }
  return x;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: A.corsHeaders(event), body: '' };
  if (event.httpMethod !== 'POST') return A.reply(event, 405, { error: 'Method not allowed' });
  try {
    if ((event.body || '').length > 1500000) return A.reply(event, 413, { error: 'Too large' });
    let req;
    try { req = JSON.parse(event.body || '{}'); } catch (e) { return A.reply(event, 400, { error: 'Bad request' }); }
    const method = String(req.method || 'GET').toUpperCase();
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { return A.reply(event, 400, { error: 'Bad body' }); } }

    // who is asking
    const tok = A.bearer(event);
    let user = null;
    if (tok) {
      const payload = A.verifyToken(tok);
      if (!payload) return A.reply(event, 401, { error: 'session_expired' });
      const row = await currentUserRow(payload.uid);
      if (!row || row.status === 'revoked' || row.status === 'closed') return A.reply(event, 401, { error: 'session_expired' });
      user = { uid: String(row.id), role: row.role, email: row.email };
    }

    const ownerOf = async (table, id) => {
      if (!/^[a-z_]+$/.test(table) || !/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) return null;
      const r = await A.supa(`${table}?id=eq.${encodeURIComponent(id)}&select=user_id&limit=1`, 'GET');
      return (r.status === 200 && Array.isArray(r.data) && r.data[0] && String(r.data[0].user_id)) || null;
    };

    const v = await P.authorize({ user, method, path: req.path, body, ownerOf });
    if (!v.ok) {
      const parsed = P.parsePath(String(req.path || '')) || {};
      console.log('POLICY_DENY', JSON.stringify({ role: user && user.role, uid: user && user.uid, table: parsed.table, method, reason: v.reason }));
      return A.reply(event, v.status || 403, { error: v.status === 401 ? 'session_expired' : 'Not allowed' });
    }
    if (!user) {
      const parsed = P.parsePath(req.path);
      if (method === 'POST' && publicLimited(A.clientIp(event), parsed.table)) return A.reply(event, 429, { error: 'Too many requests. Please try again later.' });
    }

    // the PIN column is never written or read through this gateway
    let outBody = v.body;
    const parsed = P.parsePath(v.path);
    if (outBody && parsed.table === 'users') {
      const rs = Array.isArray(outBody) ? outBody : [outBody];
      for (const r of rs) { delete r.pin; if (method === 'POST') r.pin = crypto.randomBytes(9).toString('base64url'); }
    }

    const r = await A.supa(v.path, method, outBody == null ? null : outBody);
    let data = stripPin(r.data);
    if (v.countOnly && Array.isArray(data)) data = data.map(() => ({}));
    // an admin writing a bell notice for someone else also buzzes that person's phone (members never can)
    if (user && user.role === 'admin' && method === 'POST' && parsed.table === 'notifications' && r.status >= 200 && r.status < 300 && Array.isArray(outBody ? (Array.isArray(outBody) ? outBody : [outBody]) : null)) {
      try {
        const rowsIn = Array.isArray(outBody) ? outBody : [outBody];
        const ids = [...new Set(rowsIn.map(x => String(x.user_id || '')).filter(x => x && x !== user.uid))];
        const kind = (rowsIn.find(x => x.kind) || {}).kind;
        if (ids.length && ids.length <= 50 && !pushLimited(user.uid)) await PUSH.pushToUsers(ids, PUSH.HINTS[kind] ? kind : 'general');
      } catch (e) { console.log('push after notice failed:', e.message); }
    }
    // same reply shape the app already expects: {status, data}
    return A.reply(event, 200, { status: r.status, data: data == null ? null : data });
  } catch (e) {
    console.log('db error:', e.message);
    return A.reply(event, 500, { error: 'Server error' });
  }
};
