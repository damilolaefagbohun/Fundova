// POST {email} -> emails a 6-digit sign-in code. Always answers {ok:true} so it can't be used to find out who is a member.
const A = require('./_lib/auth');

const ok = (event, extra) => A.reply(event, 200, Object.assign({ ok: true }, extra || {}));

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: A.corsHeaders(event), body: '' };
  if (event.httpMethod !== 'POST') return A.reply(event, 405, { error: 'Method not allowed' });
  try {
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (e) { return A.reply(event, 400, { error: 'Bad request' }); }
    const email = String(body.email || '').trim().toLowerCase();
    if (!email || email.length > 200 || !A.EMAIL_RE.test(email)) return A.reply(event, 400, { error: 'Please enter a valid email address.' });

    const ip = A.clientIp(event);
    const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const minAgo = Date.now() - 60 * 1000;

    // Rate limits (checked on every request, member or not, so they reveal nothing)
    const ipRows = await A.supa(`login_codes?ip=eq.${encodeURIComponent(ip)}&created_at=gt.${encodeURIComponent(hourAgo)}&select=id`, 'GET');
    if (ipRows.status === 200 && Array.isArray(ipRows.data) && ipRows.data.length >= 25) {
      return A.reply(event, 429, { error: 'Too many attempts. Please try again later.' });
    }
    const emRows = await A.supa(`login_codes?email=eq.${encodeURIComponent(email)}&created_at=gt.${encodeURIComponent(hourAgo)}&select=id,created_at&order=created_at.desc`, 'GET');
    const recent = (emRows.status === 200 && Array.isArray(emRows.data)) ? emRows.data : [];
    if (recent.length >= 5) return ok(event);
    if (recent.length && new Date(recent[0].created_at).getTime() > minAgo) return ok(event);

    const u = await A.supa(`users?email=eq.${encodeURIComponent(email)}&select=id,name,email,role,status&limit=1`, 'GET');
    const user = (u.status === 200 && Array.isArray(u.data) && u.data[0]) || null;
    const eligible = user && user.status !== 'revoked' && user.status !== 'closed';

    const code = A.newCode();
    const expires = new Date(Date.now() + A.CODE_TTL_MIN * 60 * 1000).toISOString();
    await A.supa('login_codes', 'POST', { email, ip, code_hash: eligible ? A.hashCode(email, code) : null, expires_at: expires, used: !eligible, attempts: 0 });

    if (eligible) {
      const first = A.esc(String(user.name || '').split(' ')[0] || 'there');
      const html = `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px 24px;background:#fff">
        <div style="text-align:center;margin-bottom:24px"><img src="https://www.fundova.africa/logo.png" alt="Fundova" style="width:60px;height:60px;border-radius:12px"></div>
        <h2 style="color:#1a1a1a;margin-bottom:8px">Your sign-in code</h2>
        <p style="color:#555;line-height:1.7">Hi ${first}, use this code to sign in to Fundova.</p>
        <div style="background:#0D3D2A;border-radius:12px;padding:1.5rem;text-align:center;margin:1.5rem 0">
          <div style="font-size:40px;font-weight:800;color:#C9961A;letter-spacing:10px">${code}</div>
          <div style="font-size:12px;color:#aaa;margin-top:8px">Valid for ${A.CODE_TTL_MIN} minutes</div>
        </div>
        <p style="color:#555;line-height:1.7">If you did not try to sign in, ignore this email. Your account is safe.</p>
        <p style="color:#888;font-size:12px">Never share this code with anyone, including Fundova staff.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
        <p style="color:#bbb;font-size:11px;text-align:center">${new Date().getFullYear()} Fundova Limited</p></div>`;
      await A.sendResend(email, 'Your Fundova sign-in code', html);
    }
    // tidy: drop old rows now and then
    if (Math.random() < 0.05) {
      A.supa(`login_codes?created_at=lt.${encodeURIComponent(new Date(Date.now() - 3 * 86400 * 1000).toISOString())}`, 'DELETE').catch(() => {});
    }
    return ok(event);
  } catch (e) {
    console.log('auth-request error:', e.message);
    return A.reply(event, 500, { error: 'Could not send the code. Please try again.' });
  }
};
