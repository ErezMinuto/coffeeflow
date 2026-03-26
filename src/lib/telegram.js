/**
 * Telegram Bot API helpers
 * Settings are stored in localStorage so no SQL migration is needed.
 */

const STORAGE_KEY = 'coffeeflow_telegram';

export const getTelegramSettings = () => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
};

export const saveTelegramSettings = (settings) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
};

export const sendTelegramMessage = async (botToken, chatId, text) => {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res  = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.description || 'Telegram API error');
  return json;
};

/**
 * After any roast/stock-in, if there are pending waiting customers send a
 * summary to the team group and let them decide who to call back.
 *
 * Does NOT auto-mark customers as notified — team marks them manually after
 * handling each one.
 */
export const notifyTeamIfWaiting = async ({ waitingCustomers, roastLabel, showToast }) => {
  const settings = getTelegramSettings();
  if (!settings.botToken || !settings.chatId) return;

  const pending = (waitingCustomers || []).filter(wc => !wc.notified_at);
  if (pending.length === 0) return;

  const lines = pending.map(wc => {
    const phone   = wc.phone   ? ` — ${wc.phone}` : '';
    const product = wc.product ? ` — <b>${wc.product}</b>` : '';
    return `• ${wc.customer_name}${phone}${product}`;
  }).join('\n');

  const text =
    `🔔 <b>קלייה חדשה נרשמה</b>${roastLabel ? ` — ${roastLabel}` : ''}\n\n` +
    `👥 <b>לקוחות ממתינים (${pending.length}):</b>\n${lines}\n\n` +
    `בדקו אם המוצר שהם רוצים נקלה היום.`;

  try {
    await sendTelegramMessage(settings.botToken, settings.chatId, text);
    if (showToast) showToast(`📱 טלגרם: נשלחה התראה על ${pending.length} לקוחות ממתינים`);
  } catch (err) {
    console.error('Telegram error:', err);
    if (showToast) showToast('⚠️ שגיאה בשליחת הודעת טלגרם', 'warning');
  }
};
