// POST {email, code} -> {token, exp, user}. The PIN is never returned.
const A = require('./_lib/auth');

const BAD = (event) => A.reply(event, 400, { error: 'That code is not valid or has expired. Please request a new one.' });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: A.corsHeaders(event), body: '' };
  if (event.httpMethod !== 'POST') return A.reply(event, 405, { error: 'Method not allowed' });
  try {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) { return A.reply(event, 400, { error: 'Bad request' }); }
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').trim();
    if (!A.EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) return BAD(event);

    const nowIso = new Date().toISOString();
    const r = await A.supa(`login_codes?email=eq.${encodeURIComponent(email)}&used=eq.false&expires_at=gt.${encodeURIComponent(nowIso)}&code_hash=not.is.null&select=*&order=created_at.desc&limit=1`, 'GET');
    const row = (r.status === 200 && Array.isArray(r.data) && r.data[0]) || null;
    if (!row) return BAD(event);
    if ((row.attempts || 0) >= 5) {
      await A.supa(`login_codes?id=eq.${row.id}`, 'PATCH', { used: true });
      return BAD(event);
    }
    if (!A.safeEqualHex(row.code_hash, A.hashCode(email, code))) {
      const n = (row.attempts || 0) + 1;
      await A.supa(`login_codes?id=eq.${row.id}`, 'PATCH', { attempts: n, used: n >= 5 });
      return BAD(event);
    }
    // consume exactly once (guards against two simultaneous requests using the same code)
    const claim = await A.supa(`login_codes?id=eq.${row.id}&used=eq.false`, 'PATCH', { used: true });
    if (!(claim.status === 200 && Array.isArray(claim.data) && claim.data.length === 1)) return BAD(event);

    const u = await A.supa(`users?email=eq.${encodeURIComponent(email)}&select=*&limit=1`, 'GET');
    const user = (u.status === 200 && Array.isArray(u.data) && u.data[0]) || null;
    if (!user) return BAD(event);
    if (user.status === 'revoked') return A.reply(event, 403, { error: 'Your account access has been revoked. Please contact the administrator.' });
    if (user.status === 'closed') return A.reply(event, 403, { error: 'This account has been closed. Please contact the administrator if you believe this is a mistake.' });

    const { token, exp } = A.signToken(user);
    const { pin, ...safe } = user;
    return A.reply(event, 200, { token, exp, user: safe });
  } catch (e) {
    console.log('auth-verify error:', e.message);
    return A.reply(event, 500, { error: 'Could not sign you in. Please try again.' });
  }
};
