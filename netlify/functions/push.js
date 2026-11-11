// Phone alerts: public key for the app, subscribe/unsubscribe a phone, a test alert, and admin announcements.
// Netlify environment variables: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (all three), plus the ones already set.
const A = require('./_lib/auth');
const PUSH = require('./_lib/push');

const J = (event, code, obj) => A.reply(event, code, obj);
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); const arr = (hits.get(key) || []).filter(t => now - t < (windowMs || 3600 * 1000));
  arr.push(now); hits.set(key, arr); if (hits.size > 5000) hits.clear();
  return arr.length > max;
}
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: A.corsHeaders(event), body: '' };
  if (event.httpMethod === 'GET') {
    const h = A.corsHeaders(event); h['Cache-Control'] = 'public, max-age=3600';
    return { statusCode: 200, headers: h, body: JSON.stringify({ key: process.env.VAPID_PUBLIC_KEY || '' }) };
  }
  if (event.httpMethod !== 'POST') return J(event, 405, { error: 'Method not allowed' });

  try {
    let req; try { req = JSON.parse(event.body || '{}'); } catch (e) { return J(event, 400, { error: 'Bad request' }); }
    if (!req || typeof req !== 'object' || Array.isArray(req)) return J(event, 400, { error: 'Bad request' });
    let caller;
    try { caller = await A.getCaller(event); } catch (e) { return J(event, e.message === 'session_expired' ? 401 : 503, { error: e.message === 'session_expired' ? 'session_expired' : 'Please try again' }); }
    if (!caller) return J(event, 401, { error: 'session_expired' });
    const action = String(req.action || '');

    // ── a phone turns alerts on ──
    if (action === 'subscribe') {
      const s = req.subscription || {};
      const endpoint = String(s.endpoint || ''), p256dh = String((s.keys || {}).p256dh || ''), auth = String((s.keys || {}).auth || '');
      if (!/^https:\/\/[^\s"'<>]{10,600}$/.test(endpoint) || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,40}$/.test(auth)) return J(event, 400, { error: 'Bad subscription' });
      if (limited('sub|' + caller.uid, 20)) return J(event, 429, { error: 'Too many requests' });
      await A.supa('push_subscriptions?endpoint=eq.' + encodeURIComponent(endpoint), 'DELETE');
      const ins = await A.supa('push_subscriptions', 'POST', [{ user_id: caller.uid, endpoint, p256dh, auth, user_agent: String(event.headers && (event.headers['user-agent'] || event.headers['User-Agent']) || '').slice(0, 200) }]);
      if (ins.status >= 300) return J(event, 500, { error: 'Could not save' });
      // keep the 5 newest phones per person
      const mine = await A.supa('push_subscriptions?user_id=eq.' + encodeURIComponent(caller.uid) + '&select=id&order=created_at.desc&limit=50', 'GET');
      if (mine.status === 200 && Array.isArray(mine.data) && mine.data.length > 5) {
        const old = mine.data.slice(5).map(x => x.id);
        await A.supa('push_subscriptions?id=in.(' + old.map(encodeURIComponent).join(',') + ')', 'DELETE');
      }
      return J(event, 200, { success: true });
    }

    // ── a phone turns alerts off ──
    if (action === 'unsubscribe') {
      const endpoint = String(req.endpoint || '');
      if (!endpoint || endpoint.length > 700) return J(event, 400, { error: 'Bad request' });
      await A.supa('push_subscriptions?endpoint=eq.' + encodeURIComponent(endpoint) + '&user_id=eq.' + encodeURIComponent(caller.uid), 'DELETE');
      return J(event, 200, { success: true });
    }

    // ── a test alert to your own phones ──
    if (action === 'test') {
      if (limited('test|' + caller.uid, 10)) return J(event, 429, { error: 'Too many requests' });
      const n = await PUSH.pushToUsers([caller.uid], 'test');
      return J(event, 200, { success: true, sent: n });
    }

    // ── admin announcement: bell notice (and phone alert) for a list of members ──
    if (action === 'announce') {
      if (caller.role !== 'admin') return J(event, 403, { error: 'Not allowed' });
      const ids = Array.isArray(req.user_ids) ? [...new Set(req.user_ids.map(String))].filter(x => ID_RE.test(x)) : [];
      const message = String(req.message || '').trim();
      if (!ids.length || ids.length > 2000 || !message) return J(event, 400, { error: 'Missing fields' });
      if (limited('ann|' + caller.uid, 30)) return J(event, 429, { error: 'Too many requests' });
      const text = A.esc(message).slice(0, 600);
      let saved = 0;
      for (let i = 0; i < ids.length; i += 200) {
        const rows = ids.slice(i, i + 200).map(id => ({ user_id: id, message: text, read: false, kind: 'announcement' }));
        const r = await A.supa('notifications', 'POST', rows);
        if (r.status >= 200 && r.status < 300) saved += rows.length;
      }
      let pushed = 0;
      if (req.push !== false) pushed = await PUSH.pushToUsers(ids, 'announcement');
      return J(event, 200, { success: true, saved, phones: pushed });
    }

    return J(event, 400, { error: 'Unknown action' });
  } catch (e) {
    console.log('push error:', e.message);
    return J(event, 500, { error: 'Server error' });
  }
};
