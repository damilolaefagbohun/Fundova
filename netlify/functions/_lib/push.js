// Phone alerts (web push) for Fundova. No npm packages needed.
// Netlify environment variables: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:you@example.com)
// Alerts are always short and generic on the lock screen. Amounts and details stay inside the app.
const crypto = require('crypto');
const A = require('./auth');

const b64u = b => Buffer.from(b).toString('base64url');
const unb64u = s => Buffer.from(String(s), 'base64url');

function vapidKey() {
  const pub = unb64u(process.env.VAPID_PUBLIC_KEY || ''), d = process.env.VAPID_PRIVATE_KEY || '';
  if (pub.length !== 65 || pub[0] !== 4 || !d) throw new Error('VAPID keys are not set');
  return { pub, key: crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d }, format: 'jwk' }) };
}

function vapidHeader(endpoint) {
  const { pub, key } = vapidKey();
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: process.env.VAPID_SUBJECT || 'mailto:support@fundova.africa' }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${b64u(pub)}`;
}

// RFC 8291 (aes128gcm content encoding)
function encrypt(plain, p256dh, authSecret) {
  const ua = unb64u(p256dh), auth = unb64u(authSecret);
  if (ua.length !== 65 || ua[0] !== 4) throw new Error('bad p256dh');
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(ua);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]), 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const data = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plain), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, data]);
}

async function sendOne(sub, payload) {
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { Authorization: vapidHeader(sub.endpoint), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal' },
    body: encrypt(JSON.stringify(payload), sub.p256dh, sub.auth)
  });
  return res.status;
}

// What each kind of notice says on the lock screen. Short, generic, hints at the topic.
const HINTS = {
  withdrawal: 'an update on your withdrawal',
  withdrawal_approved: 'your withdrawal was approved. Funds arrive in under 24 hours.',
  payment: 'a payment was recorded on your account',
  investment: 'an update on your investment',
  deal: 'an update on your deal',
  profile: 'an update on your profile',
  kyc: 'a reminder about your KYC details',
  referral: 'you earned a referral bonus',
  food: 'an update on your food scheme',
  ajo: 'an update on your savings group',
  birthday: 'a birthday wish for you',
  announcement: 'a new announcement for you',
  coordinator: 'you are now a coordinator',
  general: 'you have a new notification',
  // admin alerts
  admin_signup: 'a new signup application',
  admin_withdrawal: 'a new withdrawal request',
  admin_profile: 'a profile update to review',
  admin_investment: 'a new investment reservation',
  admin_deal: 'a new deal submission',
  admin_kyc: 'a KYC update to review',
  admin_coordinator: 'a new coordinator application',
  test: 'phone alerts are on'
};
const hintFor = (kind) => 'Fundova: ' + (HINTS[kind] || HINTS.general);

async function subsFor(uids) {
  const ids = [...new Set((uids || []).map(String))].filter(x => /^[A-Za-z0-9_-]{1,64}$/.test(x));
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const r = await A.supa('push_subscriptions?user_id=in.(' + chunk.map(encodeURIComponent).join(',') + ')&select=id,user_id,endpoint,p256dh,auth&limit=2000', 'GET');
    if (r.status === 200 && Array.isArray(r.data)) out.push(...r.data);
  }
  return out;
}

// Send to every registered phone of these people. Returns how many phones accepted it.
// Dead phones (the browser says the subscription is gone) are removed.
async function pushToUsers(uids, kind, url) {
  try { vapidKey(); } catch (e) { return 0; }
  const subs = await subsFor(uids);
  if (!subs.length) return 0;
  const payload = { title: 'Fundova', body: hintFor(kind), url: url || '/', tag: 'fundova-' + (kind || 'general') };
  let ok = 0; const dead = [];
  for (let i = 0; i < subs.length; i += 20) {
    const batch = subs.slice(i, i + 20);
    const res = await Promise.all(batch.map(s => sendOne(s, payload).catch(() => 'error')));
    res.forEach((st, j) => { if (st === 201 || st === 200 || st === 202) ok++; else if (st === 404 || st === 410) dead.push(batch[j].id); });
  }
  if (dead.length) {
    try { await A.supa('push_subscriptions?id=in.(' + dead.map(encodeURIComponent).join(',') + ')', 'DELETE'); } catch (e) { /* best effort */ }
  }
  return ok;
}

async function adminIds() {
  const r = await A.supa('users?role=eq.admin&select=id&limit=50', 'GET');
  return (r.status === 200 && Array.isArray(r.data)) ? r.data.map(x => String(x.id)) : [];
}

async function userIdByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!A.EMAIL_RE.test(e)) return null;
  const r = await A.supa('users?email=eq.' + encodeURIComponent(e) + '&select=id,status&limit=1', 'GET');
  const row = (r.status === 200 && Array.isArray(r.data) && r.data[0]) || null;
  return row && row.status !== 'revoked' && row.status !== 'closed' ? String(row.id) : null;
}

// Writes the notice into the bell (message is plain text; the app shows it, so it is escaped here).
async function addBellNotice(uid, message, kind) {
  const r = await A.supa('notifications', 'POST', [{ user_id: uid, message: A.esc(message).slice(0, 600), read: false, kind: kind || 'general' }]);
  return r.status >= 200 && r.status < 300;
}

module.exports = { pushToUsers, adminIds, userIdByEmail, addBellNotice, hintFor, HINTS, subsFor, _encrypt: encrypt, _vapidHeader: vapidHeader };
