const https = require('https');

const RESEND_KEY = process.env.RESEND_API_KEY;
const SITE_URL = 'https://www.fundova.africa';

function sendResendEmail(to, subject, html) {
  return new Promise(function(resolve, reject) {
    const emailBody = JSON.stringify({
      from: 'Fundova <no-reply@fundova.africa>',
      to: [to],
      subject: subject,
      html: html
    });

    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(emailBody)
      }
    }, function(res) {
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() { resolve({ status: res.statusCode, body: data }); });
    });

    req.on('error', reject);
    req.write(emailBody);
    req.end();
  });
}

exports.handler = async function(event) {
  console.log('Function called, method:', event.httpMethod);
  console.log('Body received:', event.body);

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const body = JSON.parse(event.body);
    console.log('Parsed body type:', body.type, 'to:', body.to);

    const type = body.type || 'approval';
    let to, subject, html;

    if (type === 'approval') {
      to = body.to;
      const name = body.name;
      const pin = body.pin;

      console.log('Approval email to:', to, 'name:', name);

      if (!to || !name || !pin) {
        console.log('Missing fields');
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing fields' }) };
      }

      subject = 'Your Fundova account has been approved';
      html = '<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px 24px;background:#fff">'
        + '<div style="text-align:center;margin-bottom:24px">'
        + '<img src="' + SITE_URL + '/logo.png" alt="Fundova" style="width:80px;height:80px;border-radius:16px">'
        + '</div>'
        + '<h2 style="color:#1a1a1a;margin-bottom:8px">Welcome to Fundova, ' + name + '!</h2>'
        + '<p style="color:#555;line-height:1.7;margin-bottom:20px">Your account has been approved. You are all set to start your savings journey with us.</p>'
        + '<div style="background:#F0FDF8;border:1px solid #BBF7D0;border-radius:10px;padding:16px;margin-bottom:20px">'
        + '<div style="font-size:12px;color:#065F46;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px">Your login details</div>'
        + '<div style="margin-bottom:8px;font-size:14px"><span style="color:#555">Email:</span> <strong>' + to + '</strong></div>'
        + '<div style="font-size:14px"><span style="color:#555">Default PIN:</span> <strong style="font-family:monospace;font-size:20px;letter-spacing:4px">' + pin + '</strong></div>'
        + '</div>'
        + '<div style="background:#FFF8E6;border:1px solid #FDEFC3;border-radius:10px;padding:16px;margin-bottom:20px">'
        + '<div style="font-size:12px;font-weight:600;color:#856404;margin-bottom:10px">Getting started in 3 steps</div>'
        + '<div style="font-size:13px;color:#555;line-height:1.8">'
        + '<strong>1. Sign in</strong> at ' + SITE_URL + ' using your email and default PIN above.<br>'
        + '<strong>2. Change your PIN</strong> immediately after signing in for security.<br>'
        + '<strong>3. Make your first contribution</strong> to the account below and notify us on WhatsApp.'
        + '</div>'
        + '</div>'
        + '<div style="background:#f5f5f3;border-radius:10px;padding:16px;margin-bottom:24px">'
        + '<div style="font-size:12px;font-weight:600;color:#888;margin-bottom:10px;text-transform:uppercase">Contribution account</div>'
        + '<div style="font-size:13px;color:#1a1a1a;line-height:1.8">'
        + '<strong>Bank:</strong> First Bank<br>'
        + '<strong>Account number:</strong> <span style="font-family:monospace;font-size:15px">3070379829</span><br>'
        + '<strong>Account name:</strong> Ajonibode Damilola'
        + '</div>'
        + '</div>'
        + '<div style="text-align:center;margin-bottom:24px">'
        + '<a href="' + SITE_URL + '" style="display:inline-block;background:#1D9E75;color:#fff;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Sign in to Fundova</a>'
        + '</div>'
        + '<p style="color:#888;font-size:12px;line-height:1.7;margin-bottom:8px">Need help? Reach us on WhatsApp <strong>08035257262</strong> or Instagram <strong>@fundova_cooperative</strong>.</p>'
        + '<p style="color:#aaa;font-size:12px;font-style:italic">Remember — save small small before your salary go disappear small small!</p>'
        + '<hr style="border:none;border-top:1px solid #eee;margin:20px 0">'
        + '<p style="color:#bbb;font-size:11px;text-align:center">2025 Fundova Cooperative. All rights reserved.</p>'
        + '</div>';

    } else if (type === 'payment') {
      to = body.to;
      const name = body.name;
      const amount = body.amount;
      const date = body.date;

      console.log('Payment email to:', to, 'name:', name, 'amount:', amount);

      if (!to || !name || !amount || !date) {
        console.log('Missing payment fields');
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing fields' }) };
      }

      subject = 'Payment recorded — Fundova';
      html = '<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px 24px;background:#fff">'
        + '<div style="text-align:center;margin-bottom:24px">'
        + '<img src="' + SITE_URL + '/logo.png" alt="Fundova" style="width:60px;height:60px;border-radius:12px">'
        + '</div>'
        + '<h2 style="color:#1a1a1a;margin-bottom:8px">Payment recorded</h2>'
        + '<p style="color:#555;line-height:1.7;margin-bottom:20px">Dear ' + name + ', we have successfully recorded the following payment to your Fundova savings account:</p>'
        + '<div style="background:#F0FDF8;border:1px solid #BBF7D0;border-radius:10px;padding:20px;margin-bottom:24px;text-align:center">'
        + '<div style="font-size:12px;color:#065F46;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Amount recorded</div>'
        + '<div style="font-size:32px;font-weight:700;color:#0F6E56">N' + amount + '</div>'
        + '<div style="font-size:13px;color:#888;margin-top:6px">Date: ' + date + '</div>'
        + '</div>'
        + '<div style="text-align:center;margin-bottom:24px">'
        + '<a href="' + SITE_URL + '" style="display:inline-block;background:#1D9E75;color:#fff;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">View my dashboard</a>'
        + '</div>'
        + '<p style="color:#888;font-size:12px;line-height:1.7">Your interest starts accruing from the payment date every weekday automatically.</p>'
        + '<hr style="border:none;border-top:1px solid #eee;margin:20px 0">'
        + '<p style="color:#bbb;font-size:11px;text-align:center">Questions? WhatsApp us on 08035257262 or Instagram @fundova_cooperative</p>'
        + '</div>';
    } else if (type === 'broadcast') {
      to = body.to;
      const name = body.name;
      const subj = body.subject;
      const msg = body.body;

      if (!to || !subj || !msg) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing fields' }) };
      }

      subject = subj;
      html = '<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px 24px;background:#fff">'
        + '<div style="text-align:center;margin-bottom:24px">'
        + '<img src="' + SITE_URL + '/logo.png" alt="Fundova" style="width:60px;height:60px;border-radius:12px">'
        + '</div>'
        + '<h2 style="color:#1a1a1a;margin-bottom:8px">' + subj + '</h2>'
        + '<p style="color:#555;font-size:14px;margin-bottom:8px">Dear ' + name + ',</p>'
        + '<div style="color:#444;font-size:14px;line-height:1.8;white-space:pre-wrap;margin-bottom:24px">' + msg + '</div>'
        + '<hr style="border:none;border-top:1px solid #eee;margin:20px 0">'
        + '<p style="color:#888;font-size:12px">Questions? WhatsApp us on <strong>08035257262</strong> or Instagram <strong>@fundova_cooperative</strong>.</p>'
        + '<div style="text-align:center;margin-top:16px">'
        + '<a href="' + SITE_URL + '" style="display:inline-block;background:#1D9E75;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Visit Fundova</a>'
        + '</div>'
        + '<p style="color:#bbb;font-size:11px;text-align:center;margin-top:16px">2025 Fundova Cooperative. All rights reserved.</p>'
        + '</div>';

    } else {
      console.log('Unknown type:', type);
      return { statusCode: 400, body: JSON.stringify({ error: 'Unknown email type' }) };
    }

    console.log('Calling Resend API...');
    const result = await sendResendEmail(to, subject, html);
    console.log('Resend response status:', result.status, 'body:', result.body);

    if (result.status >= 400) {
      return { statusCode: 500, body: JSON.stringify({ error: result.body }) };
    }

    return { statusCode: 200, body: JSON.stringify({ success: true }) };

  } catch (err) {
    console.log('Caught error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
