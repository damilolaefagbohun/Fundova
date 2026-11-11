const A = require('./_lib/auth');
const PUSH = require('./_lib/push');

const SITE_URL = 'https://www.fundova.africa';
const ADMIN_EMAIL = 'fundovamultipurposecooperative@gmail.com';

const sendResendEmail = A.sendResend;

function wrap(content) {
  return `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px 24px;background:#fff">
    <div style="text-align:center;margin-bottom:24px">
      <img src="${SITE_URL}/logo.png" alt="Fundova" style="width:60px;height:60px;border-radius:12px">
    </div>
    ${content}
    <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
    <p style="color:#888;font-size:12px;margin-bottom:4px">Questions? WhatsApp us on <strong>08035257262</strong> or Instagram <strong>@fundova_cooperative</strong>.</p>
    <p style="color:#bbb;font-size:11px;text-align:center">${new Date().getFullYear()} Fundova Limited. All rights reserved.</p>
  </div>`;
}

function btn(label, url) {
  return `<div style="text-align:center;margin:20px 0">
    <a href="${url}" style="display:inline-block;background:#1D9E75;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">${label}</a>
  </div>`;
}

function pill(text, color) {
  const colors = { green: '#065F46|#D1FAE5', yellow: '#856404|#FFF3CD', red: '#991B1B|#FEE2E2', blue: '#185FA5|#E6F1FB' };
  const [tc, bg] = (colors[color] || colors.green).split('|');
  return `<span style="display:inline-block;background:${bg};color:${tc};font-size:12px;font-weight:600;padding:3px 10px;border-radius:20px">${text}</span>`;
}

// who may send which kind of email
const PUBLIC_TYPES = ['admin_new_signup'];
const ADMIN_ONLY = ['approval','payment','withdrawal_approved','withdrawal_rejected','investment_approved','investment_payment_confirmed','investment_cancelled','investment_refund_approved','deal_featured','deal_approved','deal_rejected','profile_approved','coordinator_approved','kyc_reminder','birthday','birthday_wish','broadcast','announcement'];
const ANY_SIGNED_IN = ['admin_withdrawal_request','admin_profile_update_request','admin_investment_reservation','admin_deal_submission','admin_kyc_update','admin_coordinator_application','contributor_action','nok_welcome','group_invitation'];
const SELF_ONLY_FOR_MEMBERS = ['contributor_action'];   // members may only email themselves with these

// ── phone alerts instead of email ──
// These used to be emails. Now they go to the person's bell and phone. If the person has no account, the email is still sent.
const NOTICE_TYPES = {
  payment:                      { kind: 'payment',    text: b => `A payment of ${money(b.amount)} was recorded on your account${b.date ? ' (' + b.date + ')' : ''}.` },
  withdrawal_approved:          { kind: 'withdrawal_approved', text: b => `Your withdrawal of ${money(b.amount)} was approved. Funds arrive in under 24 hours.` },
  withdrawal_rejected:          { kind: 'withdrawal', text: b => `Your withdrawal request of ${money(b.amount)} was not approved. Please contact support if you have questions.` },
  investment_approved:          { kind: 'investment', text: b => `Your investment${b.investment ? ' in ' + b.investment : ''} was approved.` },
  investment_payment_confirmed: { kind: 'investment', text: b => `Your payment${b.investment ? ' for ' + b.investment : ''} was confirmed.` },
  investment_cancelled:         { kind: 'investment', text: b => `Your investment reservation${b.investment ? ' for ' + b.investment : ''} was cancelled.` },
  investment_refund_approved:   { kind: 'investment', text: b => `Your refund${b.investment ? ' for ' + b.investment : ''} was approved.` },
  deal_featured:                { kind: 'deal',       text: b => `Your deal${b.deal ? ' "' + b.deal + '"' : ''} is now featured.` },
  deal_approved:                { kind: 'deal',       text: b => `Your deal${b.deal ? ' "' + b.deal + '"' : ''} was approved.` },
  deal_rejected:                { kind: 'deal',       text: b => `Your deal${b.deal ? ' "' + b.deal + '"' : ''} was not approved.` },
  profile_approved:             { kind: 'profile',    text: () => 'Your profile update was approved.' },
  coordinator_approved:         { kind: 'coordinator', text: () => 'Congratulations, you are now a group coordinator.' },
  kyc_reminder:                 { kind: 'kyc',        text: () => 'Please complete your KYC details to unlock withdrawals. Open your dashboard and choose "Update profile & KYC".' }
};
const ADMIN_PUSH_TYPES = { admin_new_signup: 'admin_signup', admin_withdrawal_request: 'admin_withdrawal', admin_profile_update_request: 'admin_profile', admin_investment_reservation: 'admin_investment', admin_deal_submission: 'admin_deal', admin_kyc_update: 'admin_kyc', admin_coordinator_application: 'admin_coordinator' };
const money = v => { const n = Number(v); return isFinite(n) ? '₦' + n.toLocaleString('en-NG') : 'an amount'; };
const plain = v => String(v == null ? '' : v).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const hits = new Map();
function limited(key, max) {
  const now = Date.now(); const arr = (hits.get(key) || []).filter(t => now - t < 3600 * 1000);
  arr.push(now); hits.set(key, arr); if (hits.size > 5000) hits.clear();
  return arr.length > max;
}
const J = (event, code, obj) => A.reply(event, code, obj);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: A.corsHeaders(event), body: '' };
  if (event.httpMethod !== 'POST') return J(event, 405, { error: 'Method not allowed' });

  try {
    let raw;
    try { raw = JSON.parse(event.body || '{}'); } catch (e) { return J(event, 400, { error: 'Bad request' }); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return J(event, 400, { error: 'Bad request' });
    const type = raw.type || 'approval';
    if (typeof type !== 'string') return J(event, 400, { error: 'Bad request' });

    // ── who is asking ──
    const ip = A.clientIp(event);
    let caller = null;
    const tok = A.bearer(event);
    if (tok) {
      const p = A.verifyToken(tok);
      if (!p) return J(event, 401, { error: 'session_expired' });
      const r = await A.supa('users?id=eq.' + encodeURIComponent(p.uid) + '&select=id,role,status,email&limit=1', 'GET');
      if (r.status !== 200 || !Array.isArray(r.data)) return J(event, 503, { error: 'Please try again' });
      const row = r.data[0] || null;
      if (!row || row.status === 'revoked' || row.status === 'closed') return J(event, 401, { error: 'session_expired' });
      caller = { uid: String(row.id), role: row.role, email: String(row.email || '').toLowerCase() };
    }
    const isAdmin = !!caller && caller.role === 'admin';
    if (PUBLIC_TYPES.includes(type)) {
      if (!caller && limited('pub|' + ip, 10)) return J(event, 429, { error: 'Too many requests' });
    } else if (!caller) {
      return J(event, 401, { error: 'session_expired' });
    } else if (ADMIN_ONLY.includes(type)) {
      const ownTest = (type === 'broadcast' || type === 'announcement') && String(raw.to || '').toLowerCase() === caller.email;
      if (!isAdmin && !ownTest) return J(event, 403, { error: 'Not allowed' });
    } else if (ANY_SIGNED_IN.includes(type)) {
      if (SELF_ONLY_FOR_MEMBERS.includes(type) && !isAdmin && String(raw.to || '').toLowerCase() !== caller.email) return J(event, 403, { error: 'Not allowed' });
      if (!isAdmin && limited('u|' + caller.uid + '|' + type, 30)) return J(event, 429, { error: 'Too many requests' });
    } else {
      return J(event, 400, { error: 'Unknown email type' });
    }

    // ── clean the input: anything typed by a person is escaped before it goes into the email ──
    const body = {};
    for (const k of Object.keys(raw)) body[k] = typeof raw[k] === 'string' ? A.esc(raw[k]).slice(0, 5000) : raw[k];
    if (raw.to !== undefined) {
      const t = String(raw.to).trim();
      if (!A.EMAIL_RE.test(t) || t.length > 200) return J(event, 400, { error: 'Invalid recipient' });
      body.to = t;
    }
    if (raw.image_url) {
      body.image_url = /^https:\/\/[^\s"'<>]+$/.test(String(raw.image_url)) && String(raw.image_url).length < 1000 ? A.esc(raw.image_url) : '';
    }

    // ── legacy internal "broadcast" emails: the bell already carries these, so no email goes out ──
    if (type === 'broadcast') return J(event, 200, { success: true, skipped: true });

    // ── contributor self-actions: bell only (no email, no phone alert) ──
    if (type === 'contributor_action') {
      const uid = await PUSH.userIdByEmail(body.to);
      if (uid) { await PUSH.addBellNotice(uid, plain(body.title) + (body.detail ? ': ' + plain(body.detail) : ''), 'general'); return J(event, 200, { success: true, bell: true }); }
    }

    // ── admin alerts: phones first; email only if no admin phone is registered ──
    if (ADMIN_PUSH_TYPES[type]) {
      try {
        const ids = await PUSH.adminIds();
        const n = ids.length ? await PUSH.pushToUsers(ids, ADMIN_PUSH_TYPES[type]) : 0;
        if (n > 0) return J(event, 200, { success: true, phones: n });
      } catch (e) { console.log('admin push failed:', e.message); }
    }

    // ── member notices: bell + phone instead of email ──
    if (NOTICE_TYPES[type] && body.to) {
      const def = NOTICE_TYPES[type];
      const uid = await PUSH.userIdByEmail(body.to);
      if (uid) {
        const b2 = {}; for (const k of Object.keys(body)) b2[k] = plain(body[k]);
        await PUSH.addBellNotice(uid, def.text(b2), def.kind);
        const phones = await PUSH.pushToUsers([uid], def.kind);
        return J(event, 200, { success: true, bell: true, phones });
      }
    }

    let to, subject, html;

    // ── APPROVAL ──
    if (type === 'approval') {
      to = body.to; const name = body.name;
      if (!to || !name) return J(event, 400, { error: 'Missing fields' });
      subject = 'Welcome to Fundova — Your account is ready!';
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">Welcome to Fundova, ${name}!</h2>
        <p style="color:#555;line-height:1.7">Your account has been approved. You are all set to start your savings journey.</p>
        <div style="background:#F0FDF8;border:1px solid #BBF7D0;border-radius:10px;padding:16px;margin:16px 0">
          <div style="font-size:11px;color:#065F46;font-weight:600;text-transform:uppercase;margin-bottom:10px">How to sign in</div>
          <div style="font-size:14px;margin-bottom:6px"><span style="color:#555">Your email:</span> <strong>${to}</strong></div>
          <div style="font-size:13px;color:#555;line-height:1.7">There is no password or PIN to remember. Enter your email on the sign-in page and we will email you a 6-digit code each time you sign in.</div>
        </div>
        <div style="background:#FFF8E6;border:1px solid #FDEFC3;border-radius:10px;padding:16px;margin-bottom:16px">
          <div style="font-size:12px;font-weight:600;color:#856404;margin-bottom:8px">Getting started</div>
          <div style="font-size:13px;color:#555;line-height:2">
            <strong>1. Sign in</strong> at ${SITE_URL} with your email. A code will be sent to you.<br>
            <strong>2. Explore your dashboard</strong> — see everything Fundova offers.<br>
            <strong>3. Complete your KYC</strong> — this keeps your withdrawals ready whenever you need them.<br>
            <strong>4. Create a Savings Box</strong> — give your money a destination.<br>
            <strong>5. Start saving!</strong> Pay into your account below and earn 10% ROI per annum.
          </div>
        </div>
        <div style="background:#f5f5f3;border-radius:10px;padding:14px;margin-bottom:16px;font-size:13px;line-height:1.8">
          <strong>Bank:</strong> First City Monument Bank (FCMB) &nbsp;|&nbsp; <strong>Account:</strong> 2009239208 &nbsp;|&nbsp; <strong>Name:</strong> Fundova Multipurpose Cooperative Society Ltd
        </div>
        ${btn('Sign in to Fundova', SITE_URL)}
        <p style="color:#aaa;font-size:12px;font-style:italic;text-align:center">Save small small before your salary go disappear small small!</p>
      `);

    // ── PAYMENT ──
    } else if (type === 'payment') {
      to = body.to; const name = body.name; const amount = body.amount; const date = body.date;
      if (!to || !name || !amount || !date) return J(event, 400, { error: 'Missing fields' });
      subject = 'Payment recorded — Fundova';
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">Payment recorded</h2>
        <p style="color:#555;line-height:1.7">Dear ${name}, we have successfully recorded the following payment:</p>
        <div style="background:#F0FDF8;border:1px solid #BBF7D0;border-radius:10px;padding:20px;text-align:center;margin:16px 0">
          <div style="font-size:12px;color:#065F46;font-weight:600;text-transform:uppercase;margin-bottom:6px">Amount recorded</div>
          <div style="font-size:32px;font-weight:700;color:#0F6E56">&#x20A6;${amount}</div>
          <div style="font-size:13px;color:#888;margin-top:6px">Date: ${date}</div>
        </div>
        <p style="color:#666;font-size:13px">Your interest starts accruing from the payment date every weekday automatically.</p>
        ${btn('View my dashboard', SITE_URL)}
      `);

    // ── WITHDRAWAL APPROVED ──
    } else if (type === 'withdrawal_approved') {
      to = body.to; const name = body.name; const amount = body.amount;
      subject = 'Withdrawal approved — Fundova';
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">Withdrawal approved ${pill('Approved', 'green')}</h2>
        <p style="color:#555;line-height:1.7">Dear ${name}, your withdrawal request of <strong>&#x20A6;${Number(amount).toLocaleString('en-NG', {minimumFractionDigits:2})}</strong> has been approved.</p>
        <p style="color:#666;font-size:13px;line-height:1.7">The funds will be processed to your registered bank account. Please allow 1-2 business days for the transfer to reflect.</p>
        ${btn('View my dashboard', SITE_URL)}
      `);

    // ── WITHDRAWAL REJECTED ──
    } else if (type === 'withdrawal_rejected') {
      to = body.to; const name = body.name; const amount = body.amount;
      subject = 'Withdrawal request update — Fundova';
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">Withdrawal request update ${pill('Not approved', 'red')}</h2>
        <p style="color:#555;line-height:1.7">Dear ${name}, your withdrawal request of <strong>&#x20A6;${Number(amount).toLocaleString('en-NG', {minimumFractionDigits:2})}</strong> could not be approved at this time.</p>
        <p style="color:#666;font-size:13px">Please contact us on WhatsApp at 08035257262 for more information.</p>
        ${btn('View my dashboard', SITE_URL)}
      `);

    // ── INVESTMENT APPROVED ──
    } else if (type === 'investment_approved') {
      to = body.to; const name = body.name; const investment = body.investment; const units = body.units; const amount = body.amount; const payment_method = body.payment_method;
      subject = 'Investment reservation approved — Fundova';
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">Reservation approved ${pill('Approved', 'green')}</h2>
        <p style="color:#555;line-height:1.7">Dear ${name}, your reservation of <strong>${units} unit${units!==1?'s':''}</strong> in <strong>${investment}</strong> has been approved.</p>
        ${payment_method === 'savings' ? `
        <div style="background:#E6F1FB;border:1px solid #BFDBFE;border-radius:10px;padding:14px;margin:16px 0;font-size:13px;color:#1E40AF">
          <strong>Payment method: From savings balance</strong><br>Your funds will be deducted from your savings balance when admin confirms. No action needed.
        </div>` : `
        <div style="background:#FFF8E6;border:1px solid #FDEFC3;border-radius:10px;padding:14px;margin:16px 0;font-size:13px">
          <strong>Action required — please make payment within 48 hours</strong><br><br>
          Amount: <strong>&#x20A6;${Number(amount).toLocaleString('en-NG', {minimumFractionDigits:2})}</strong><br>
          Bank: First City Monument Bank (FCMB) &nbsp;|&nbsp; Account: 2009239208 &nbsp;|&nbsp; Name: Fundova Multipurpose Cooperative Society Ltd<br><br>
          Use your name as reference. Then log in and click "I have made payment".
        </div>`}
        ${btn('View my investments', SITE_URL)}
      `);

    // ── INVESTMENT PAYMENT CONFIRMED ──
    } else if (type === 'investment_payment_confirmed') {
      to = body.to; const name = body.name; const investment = body.investment; const units = body.units;
      subject = 'Investment confirmed — Fundova';
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">Payment confirmed ${pill('Active', 'green')}</h2>
        <p style="color:#555;line-height:1.7">Dear ${name}, your payment for <strong>${units} unit${units!==1?'s':''}</strong> in <strong>${investment}</strong> has been confirmed. Your units are now active!</p>
        <p style="color:#666;font-size:13px">You will receive your share of monthly income automatically credited to your savings balance.</p>
        ${btn('View my portfolio', SITE_URL)}
      `);

    // ── INVESTMENT CANCELLED ──
    } else if (type === 'investment_cancelled') {
      to = body.to; const name = body.name; const investment = body.investment;
      subject = 'Investment reservation cancelled — Fundova';
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">Reservation cancelled ${pill('Cancelled', 'red')}</h2>
        <p style="color:#555;line-height:1.7">Dear ${name}, your reservation in <strong>${investment}</strong> has been cancelled.</p>
        <p style="color:#666;font-size:13px">Please contact us on WhatsApp at 08035257262 for more information.</p>
        ${btn('View Fundova', SITE_URL)}
      `);

    // ── INVESTMENT REFUND APPROVED ──
    } else if (type === 'investment_refund_approved') {
      to = body.to; const name = body.name; const investment = body.investment;
      subject = 'Investment refund approved — Fundova';
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">Refund approved ${pill('Approved', 'green')}</h2>
        <p style="color:#555;line-height:1.7">Dear ${name}, your refund request for <strong>${investment}</strong> has been approved. The amount has been credited back to your savings balance.</p>
        ${btn('View my dashboard', SITE_URL)}
      `);

    // ── DEAL FEATURED ──
    } else if (type === 'deal_featured') {
      to = body.to; const name = body.name; const deal = body.deal;
      subject = 'Your deal is now featured — Fundova';
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">Your deal is live! ${pill('Featured', 'green')}</h2>
        <p style="color:#555;line-height:1.7">Dear ${name}, your deal <strong>${deal}</strong> is now featured on Fundova and visible to all members and visitors.</p>
        ${btn('View deals', SITE_URL)}
      `);

    // ── DEAL APPROVED ──
    } else if (type === 'deal_approved') {
      to = body.to; const name = body.name; const deal = body.deal;
      subject = 'Your deal has been approved — Fundova';
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">Deal approved ${pill('Approved', 'blue')}</h2>
        <p style="color:#555;line-height:1.7">Dear ${name}, your deal <strong>${deal}</strong> has been approved and may be featured soon.</p>
        ${btn('View Fundova', SITE_URL)}
      `);

    // ── DEAL REJECTED ──
    } else if (type === 'deal_rejected') {
      to = body.to; const name = body.name; const deal = body.deal;
      subject = 'Deal submission update — Fundova';
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">Deal not approved ${pill('Not approved', 'red')}</h2>
        <p style="color:#555;line-height:1.7">Dear ${name}, your deal submission <strong>${deal}</strong> was not approved. Please contact us for more information.</p>
        ${btn('Contact us on WhatsApp', 'https://wa.me/2348035257262')}
      `);

    // ── PROFILE APPROVED ──
    } else if (type === 'profile_approved') {
      to = body.to; const name = body.name;
      subject = 'Profile updated — Fundova';
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">Profile updated ${pill('Approved', 'green')}</h2>
        <p style="color:#555;line-height:1.7">Dear ${name}, your profile update request has been approved. Your details have been updated on Fundova.</p>
        ${btn('View my profile', SITE_URL)}
      `);

    // ── COORDINATOR APPROVED ──
    } else if (type === 'coordinator_approved') {
      to = body.to; const name = body.name;
      subject = 'You are now a Fundova coordinator!';
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">Coordinator approved! ${pill('Active', 'green')}</h2>
        <p style="color:#555;line-height:1.7">Congratulations ${name}! Your coordinator application has been approved. You can now create and manage savings groups on Fundova.</p>
        <p style="color:#666;font-size:13px">Log in to your dashboard to create your first group.</p>
        ${btn('Create my first group', SITE_URL)}
      `);

    // ── ADMIN NEW SIGNUP ──
    } else if (type === 'admin_new_signup') {
      to = ADMIN_EMAIL;
      const applicant_name = body.name; const applicant_email = body.applicant_email;
      subject = 'New signup application — Fundova';
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">New signup application</h2>
        <p style="color:#555;line-height:1.7">A new application has been submitted on Fundova:</p>
        <div style="background:#f5f5f3;border-radius:10px;padding:14px;margin:16px 0;font-size:14px;line-height:1.8">
          <strong>Name:</strong> ${applicant_name}<br>
          <strong>Email:</strong> ${applicant_email}
        </div>
        ${btn('Review application', SITE_URL)}
      `);

    // ── ADMIN: WITHDRAWAL REQUEST ──
    } else if (type === 'admin_withdrawal_request') {
      to = ADMIN_EMAIL;
      const member_name = body.name; const amount = body.amount; const note = body.note;
      subject = `Withdrawal request — ₦${Number(amount).toLocaleString('en-NG')} from ${member_name}`;
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">New withdrawal request ${pill('Pending', 'yellow')}</h2>
        <p style="color:#555;line-height:1.7">${member_name} has requested a withdrawal:</p>
        <div style="background:#FFF8E6;border:1px solid #FDEFC3;border-radius:10px;padding:20px;text-align:center;margin:16px 0">
          <div style="font-size:12px;color:#856404;font-weight:600;text-transform:uppercase;margin-bottom:6px">Amount requested</div>
          <div style="font-size:32px;font-weight:700;color:#856404">&#x20A6;${Number(amount).toLocaleString('en-NG', {minimumFractionDigits:2})}</div>
        </div>
        ${note ? `<p style="color:#666;font-size:13px"><strong>Note:</strong> ${note}</p>` : ''}
        ${btn('Review in admin dashboard', SITE_URL)}
      `);

    // ── ADMIN: PROFILE UPDATE REQUEST ──
    } else if (type === 'admin_profile_update_request') {
      to = ADMIN_EMAIL;
      const member_name = body.name; const bank_changed = body.bank_changed;
      subject = bank_changed ? `⚠️ Bank details change requested — ${member_name}` : `Profile update requested — ${member_name}`;
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">Profile update request ${bank_changed?pill('Includes bank change', 'red'):pill('Pending', 'yellow')}</h2>
        <p style="color:#555;line-height:1.7">${member_name} has requested a profile update${bank_changed?', <strong>including a change to their bank details</strong>':''}.</p>
        ${bank_changed ? `<div style="background:#FEE2E2;border:1px solid #FCA5A5;border-radius:10px;padding:14px;margin:16px 0;font-size:13px;color:#991B1B">Bank detail changes affect where withdrawal funds go — please verify this request carefully before approving.</div>` : ''}
        ${btn('Review in admin dashboard', SITE_URL)}
      `);

    // ── ADMIN: INVESTMENT RESERVATION ──
    } else if (type === 'admin_investment_reservation') {
      to = ADMIN_EMAIL;
      const member_name = body.name; const investment_title = body.investment_title; const units = body.units;
      subject = `New investment reservation — ${investment_title}`;
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">New investment reservation ${pill('Pending', 'yellow')}</h2>
        <p style="color:#555;line-height:1.7">${member_name} has reserved <strong>${units} unit${units!=1?'s':''}</strong> of <strong>${investment_title}</strong>.</p>
        ${btn('Review in admin dashboard', SITE_URL)}
      `);

    // ── ADMIN: DEAL SUBMISSION ──
    } else if (type === 'admin_deal_submission') {
      to = ADMIN_EMAIL;
      const member_name = body.name; const deal_title = body.deal_title;
      subject = `New deal submitted — ${deal_title}`;
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">New deal submission ${pill('Pending', 'yellow')}</h2>
        <p style="color:#555;line-height:1.7">${member_name} has submitted a new deal for the marketplace: <strong>${deal_title}</strong>.</p>
        ${btn('Review in admin dashboard', SITE_URL)}
      `);

    // ── ADMIN: KYC UPDATE ──
    } else if (type === 'admin_kyc_update') {
      to = ADMIN_EMAIL;
      const member_name = body.name; const member_email = body.applicant_email;
      subject = `KYC details updated — ${member_name}`;
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">KYC details updated</h2>
        <p style="color:#555;line-height:1.7">${member_name} has updated their KYC information. Their verification status has been reset and needs re-review.</p>
        <div style="background:#f5f5f3;border-radius:10px;padding:14px;margin:16px 0;font-size:14px;line-height:1.8">
          <strong>Name:</strong> ${member_name}<br>
          <strong>Email:</strong> ${member_email}
        </div>
        ${btn('Review KYC', SITE_URL)}
      `);

    // ── ADMIN: COORDINATOR APPLICATION ──
    } else if (type === 'admin_coordinator_application') {
      to = ADMIN_EMAIL;
      const applicant_name = body.name; const applicant_email = body.applicant_email;
      subject = `New coordinator application — ${applicant_name}`;
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">New coordinator application ${pill('Pending', 'yellow')}</h2>
        <p style="color:#555;line-height:1.7">A new application to become a group coordinator has been submitted:</p>
        <div style="background:#f5f5f3;border-radius:10px;padding:14px;margin:16px 0;font-size:14px;line-height:1.8">
          <strong>Name:</strong> ${applicant_name}<br>
          <strong>Email:</strong> ${applicant_email}
        </div>
        ${btn('Review application', SITE_URL)}
      `);

    // ── KYC REMINDER (admin-triggered, sent to the contributor) ──
    } else if (type === 'kyc_reminder') {
      to = body.to; const name = body.name;
      if (!to) return J(event, 400, { error: 'Missing recipient' });
      subject = 'Please complete your KYC on Fundova';
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">A quick reminder, ${name}</h2>
        <p style="color:#555;line-height:1.7">We noticed your KYC details on Fundova aren't complete yet. This only takes a few minutes, and it's required before you can request a withdrawal.</p>
        <div style="background:#FFF8E6;border:1px solid #FDEFC3;border-radius:10px;padding:14px;margin:16px 0;font-size:13px;color:#856404">
          Log in, go to your dashboard, and click <strong>"Update profile &amp; KYC"</strong> to finish up.
        </div>
        ${btn('Complete my KYC', SITE_URL)}
      `);

    // ── CONTRIBUTOR ACTION CONFIRMATION (generic — one action, one plain email) ──
    } else if (type === 'contributor_action') {
      to = body.to; const name = body.name; const actionTitle = body.title; const detail = body.detail;
      if (!to) return J(event, 400, { error: 'Missing recipient' });
      subject = actionTitle;
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">${actionTitle}</h2>
        <p style="color:#555;line-height:1.7">Hi ${name},</p>
        <p style="color:#555;line-height:1.7">${detail}</p>
        ${btn('View your dashboard', SITE_URL)}
      `);

    // ── BIRTHDAY WISH (admin-drafted, sent to one contributor) ──
    } else if (type === 'birthday_wish') {
      to = body.to; const name = body.name; const msg = body.body; const image_url = body.image_url;
      if (!to || !msg) return J(event, 400, { error: 'Missing fields' });
      subject = `🎂 Happy Birthday, ${name.split(' ')[0]}!`;
      html = wrap(`
        ${image_url ? `<img src="${image_url}" alt="" style="width:100%;border-radius:10px;margin-bottom:16px;display:block">` : ''}
        <div style="color:#444;font-size:14px;line-height:1.8;white-space:pre-wrap">${msg}</div>
      `);

    // ── ANNOUNCEMENT (email) ──
    } else if (type === 'announcement') {
      to = body.to; const name = body.name; const subj = body.subject; const msg = body.body; const image_url = body.image_url;
      if (!to || !subj || !msg) return J(event, 400, { error: 'Missing fields' });
      subject = subj;
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">${subj}</h2>
        ${image_url ? `<img src="${image_url}" alt="" style="width:100%;border-radius:10px;margin-bottom:16px;display:block">` : ''}
        <p style="color:#555;font-size:14px;margin-bottom:8px">Dear ${name},</p>
        <div style="color:#444;font-size:14px;line-height:1.8;white-space:pre-wrap;margin-bottom:16px">${msg}</div>
        ${btn('Visit Fundova', SITE_URL)}
      `);

    // ── GROUP INVITATION ──
    } else if (type === 'group_invitation') {
      to = body.to; const name = body.name; const coordinator_name = body.coordinator_name; const group_name = body.group_name;
      subject = `You have been invited to join a savings group on Fundova`;
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">You have been invited!</h2>
        <p style="color:#555;line-height:1.7">Hi ${name},</p>
        <p style="color:#555;line-height:1.7"><strong>${coordinator_name}</strong> has invited you to join their savings group <strong>${group_name}</strong> on Fundova.</p>
        <div style="background:#F0FDF8;border:1px solid #BBF7D0;border-radius:10px;padding:16px;margin:16px 0;font-size:13px;line-height:1.8;color:#065F46">
          <strong>What is Fundova?</strong><br>
          Fundova is a registered cooperative savings platform where your money earns about 10% interest per annum — calculated daily from the moment your payment is recorded. Members also get access to group investments, deals and financial education.
        </div>
        <p style="color:#666;font-size:13px;line-height:1.7">Click below to sign up on Fundova and join the group. Your application will be reviewed and once approved you will be added to ${group_name} automatically.</p>
        ${btn('Accept invitation & sign up', SITE_URL)}
        <p style="color:#aaa;font-size:12px;text-align:center">This invitation was sent by ${coordinator_name} via Fundova.</p>
      `);

    // ── NEXT OF KIN WELCOME ──
    } else if (type === 'nok_welcome') {
      to = body.to; const name = body.name; const member_name = body.member_name;
      subject = member_name + ' added you to their Fundova contacts';
      html = wrap(`
        <h2 style="color:#1a1a1a;margin-bottom:8px">Hello ${name},</h2>
        <p style="color:#555;line-height:1.7">${member_name} has added you as their next of kin on <strong>Fundova</strong> — a registered cooperative savings platform in Nigeria.</p>
        <p style="color:#555;line-height:1.7">By adding you, ${member_name} has also opted you in to receive occasional financial education content and updates from <strong>Fundova Learn</strong> — our free financial literacy programme.</p>
        <div style="background:#F0FDF8;border:1px solid #BBF7D0;border-radius:10px;padding:14px;margin:16px 0;font-size:13px;color:#065F46">
          <strong>What is Fundova?</strong><br>
          Fundova is a CAC-registered multipurpose cooperative where members save at their own pace and earn approximately 10% interest per annum. We also offer group investments, financial education and a member marketplace.
        </div>
        <p style="color:#666;font-size:13px">You will receive occasional emails about financial education topics and Fundova events. You can unsubscribe at any time by contacting us.</p>
        ${btn('Learn more about Fundova', SITE_URL)}
        <p style="color:#aaa;font-size:12px;text-align:center">You received this because ${member_name} added you as their next of kin on Fundova. Contact us at fundovamultipurposecooperative@gmail.com to unsubscribe.</p>
      `);

    // ── BIRTHDAY ──
    } else if (type === 'birthday') {
      to = body.to; const name = body.name;
      subject = '🎂 Happy Birthday from Fundova!';
      html = wrap(`
        <div style="text-align:center;padding:1rem 0">
          <div style="font-size:56px;margin-bottom:8px">🎂</div>
          <h2 style="color:#0D3D2A;margin-bottom:4px">Happy Birthday, ${name.split(' ')[0]}!</h2>
          <p style="color:#888;font-size:13px">From all of us at Fundova</p>
        </div>
        <div style="background:#F7F5F0;border-radius:12px;padding:1.25rem;margin:1rem 0;text-align:center">
          <p style="color:#555;line-height:1.8;margin:0">Today is your special day and we wanted to take a moment to celebrate you. Thank you for being part of the Fundova community and for choosing to build your wealth with us.</p>
        </div>
        <p style="color:#555;line-height:1.8">We hope this year brings you great joy, good health and financial growth. Keep saving, keep growing — and know that your Fundova savings are working hard for you every weekday! 💚</p>
        <p style="color:#555;line-height:1.8">With warm wishes,<br><strong>The Fundova Team</strong></p>
        ${btn('View my dashboard', SITE_URL)}
      `);

    } else {
      return J(event, 400, { error: 'Unknown email type' });
    }

    // subject lines are plain text: undo the escaping and remove line breaks
    subject = String(subject).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/[\r\n]+/g, ' ').slice(0, 200);
    const result = await sendResendEmail(to, subject, html);
    if (result.status >= 400) {
      console.log('Resend refused the email, status', result.status);
      return J(event, 500, { error: 'Email could not be sent' });
    }
    if (type === 'birthday' || type === 'birthday_wish') {
      try { const uid = await PUSH.userIdByEmail(to); if (uid) { await PUSH.addBellNotice(uid, 'Happy Birthday from all of us at Fundova! 🎂', 'birthday'); await PUSH.pushToUsers([uid], 'birthday'); } } catch (e) { /* email already sent */ }
    }
    return J(event, 200, { success: true });

  } catch (err) {
    console.log('send-email error:', err.message);
    return J(event, 500, { error: 'Email could not be sent' });
  }
};
