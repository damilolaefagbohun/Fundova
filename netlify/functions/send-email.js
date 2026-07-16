exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const RESEND_KEY = 're_EQaE3axY_KYu7QKzQvWvEK7GeeAJkbChv';
  const SITE_URL = 'https://www.fundova.africa';

  try {
    const { to, name, pin } = JSON.parse(event.body);

    if (!to || !name || !pin) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Fundova <no-reply@fundova.africa>',
        to: [to],
        subject: 'Your Fundova account has been approved',
        html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff;border-radius:12px">
          <div style="text-align:center;margin-bottom:24px">
            <img src="${SITE_URL}/logo.png" alt="Fundova" style="width:80px;height:80px;border-radius:16px">
          </div>
          <h2 style="color:#1a1a1a;margin-bottom:8px">Welcome, ${name}! 🎉</h2>
          <p style="color:#555;line-height:1.6;margin-bottom:20px">Your Fundova thrift savings account has been approved. You can now sign in and track your savings and accrued interest.</p>
          <div style="background:#F0FDF8;border:1px solid #BBF7D0;border-radius:10px;padding:16px;margin-bottom:24px">
            <div style="font-size:12px;color:#065F46;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">Your login details</div>
            <div style="margin-bottom:6px"><span style="color:#555;font-size:13px">Email:</span> <strong>${to}</strong></div>
            <div><span style="color:#555;font-size:13px">PIN:</span> <strong style="font-family:monospace;font-size:18px;letter-spacing:4px">${pin}</strong></div>
          </div>
          <a href="${SITE_URL}" style="display:inline-block;background:#1D9E75;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-bottom:24px">Sign in to Fundova →</a>
          <p style="color:#888;font-size:12px;line-height:1.6">We recommend changing your PIN after your first login. If you have any questions, contact us via WhatsApp on <strong>08035257262</strong> or Instagram <strong>@fundova_cooperative</strong>.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
          <p style="color:#bbb;font-size:11px;text-align:center">© 2025 Fundova Cooperative. All rights reserved.</p>
        </div>`
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return { statusCode: 500, body: JSON.stringify({ error: data }) };
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
