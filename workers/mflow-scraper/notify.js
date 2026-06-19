// notify.js — operational alerts for the mflow-scraper worker.
//
// When the worker hits an authentication problem (e.g. the Supabase key was
// rotated / is invalid), a daily run otherwise fails SILENTLY: dozens of
// identical per-SKU "Invalid API key" errors, a no-op sync, and no signal to
// anyone until someone happens to read the logs. This module turns that into
// an immediate, actionable alert via email (Resend) + Telegram.
//
// Env vars (set in Railway):
//   RESEND_API_KEY  — required for email (same Resend account the app uses)
//   SENDER_EMAIL    — optional, defaults to info@minuto.co.il (must be a
//                     verified Resend sender/domain)
//   ALERT_EMAIL     — optional, defaults to erez@minuto.co.il
//   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID — optional, reuses the worker's
//                     existing Telegram alerting if present

const RESEND_API_KEY     = process.env.RESEND_API_KEY || '';
const SENDER_EMAIL       = process.env.SENDER_EMAIL || 'info@minuto.co.il';
const ALERT_EMAIL        = process.env.ALERT_EMAIL || 'erez@minuto.co.il';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID || '';

// Detect Supabase/PostgREST auth failures from an error object or string.
function isAuthError(err) {
  if (!err) return false;
  const msg = (typeof err === 'string' ? err : (err.message || '')).toLowerCase();
  return (
    msg.includes('invalid api key') ||
    msg.includes('no api key') ||
    msg.includes('jwt') ||
    msg.includes('unauthorized')
  );
}

async function sendEmail(subject, html) {
  if (!RESEND_API_KEY) {
    console.error('[notify] RESEND_API_KEY not set — cannot send email alert');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Minuto Alerts <' + SENDER_EMAIL + '>',
        to: [ALERT_EMAIL],
        subject,
        html
      })
    });
    if (!res.ok) {
      const t = await res.text();
      console.error('[notify] Resend ' + res.status + ': ' + t.slice(0, 300));
      return false;
    }
    console.log('[notify] alert email sent to ' + ALERT_EMAIL);
    return true;
  } catch (e) {
    console.error('[notify] email send threw:', e.message);
    return false;
  }
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
    });
    const data = await res.json();
    return !!data.ok;
  } catch (e) {
    console.error('[notify] telegram send threw:', e.message);
    return false;
  }
}

// Fire at most one auth alert per process run, so a rotated key doesn't send
// one email per failed SKU.
let alreadyAlerted = false;

async function alertAuthFailure(detail) {
  if (alreadyAlerted) return;
  alreadyAlerted = true;

  const when = new Date().toISOString();
  console.error('[notify] AUTH FAILURE — ' + detail);

  const subject = '🚨 MFlow Scraper: Supabase authentication failed';
  const html =
    '<div style="font-family: sans-serif; font-size: 14px; color: #333;">' +
    '<h2>🚨 MFlow Scraper — authentication problem</h2>' +
    '<p>The daily MFlow stock sync could not authenticate with Supabase, so ' +
    '<b>no stock was updated</b>.</p>' +
    '<p><b>Detail:</b> ' + detail + '</p>' +
    '<p><b>Time (UTC):</b> ' + when + '</p>' +
    '<hr>' +
    '<p><b>Most likely cause:</b> the <code>SUPABASE_KEY</code> in Railway is no ' +
    'longer valid (e.g. the Supabase JWT secret was rotated).</p>' +
    '<p><b>Fix:</b> copy the current <b>service_role</b> key from Supabase → ' +
    'Settings → API Keys → "Legacy anon, service_role API keys", then update ' +
    '<code>SUPABASE_KEY</code> in the Railway <i>mflow-scraper</i> service and ' +
    'redeploy. (Set it via the Railway CLI to avoid truncating the long key: ' +
    '<code>railway variables --set "SUPABASE_KEY=$KEY"</code>.)</p>' +
    '</div>';

  await Promise.all([
    sendEmail(subject, html),
    sendTelegram(
      '🚨 MFlow Scraper: Supabase auth failed — no stock synced today. ' +
      detail + '. Update SUPABASE_KEY in Railway and redeploy.'
    )
  ]);
}

module.exports = { alertAuthFailure, isAuthError, sendEmail, sendTelegram };
