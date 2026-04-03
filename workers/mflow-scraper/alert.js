const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || ''
);

const USER_ID = process.env.USER_ID || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

async function sendTelegram(message) {
  const url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    })
  });
  const data = await response.json();
  if (!data.ok) {
    console.error('Telegram error:', data.description);
  }
  return data.ok;
}

async function generateAlertMessage(lowStockOrigins) {
  if (!ANTHROPIC_API_KEY) {
    // Fallback simple message without Claude
    let message = '☕ *Minuto Coffee — Stock Alert*\n\n';
    for (const origin of lowStockOrigins) {
      const roasted  = origin.roasted_stock ?? 0;
      const stock    = origin.stock ?? 0;
      const daysLeft = origin.daily_average > 0
        ? (roasted / origin.daily_average).toFixed(1)
        : 'N/A';
      message += `⚠️ *${origin.name}*\n`;
      message += `  Roasted: ${roasted.toFixed(2)} kg\n`;
      message += `  Daily avg: ${origin.daily_average} kg/day\n`;
      message += `  Days left: ${daysLeft}\n`;
      message += `  Green stock: ${stock.toFixed(1)} kg\n\n`;
    }
    return message;
  }

  // Use Claude to generate smart alert
  const originsText = lowStockOrigins.map(o => {
    const stock    = o.stock ?? 0;
    const daysLeft = o.daily_average > 0
      ? (stock / o.daily_average).toFixed(1)
      : 'unknown';
    return `- ${o.name}: ${stock.toFixed(2)}kg green stock, ${o.daily_average}kg/day average, ${daysLeft} days left`;
  }).join('\n');

  const prompt = `You are a coffee roastery assistant for Minuto Coffee in Rehovot, Israel.
The following coffee origins have low grean coffee beans stock (less than 3 days remaining):

${originsText}

Write a short, practical WhatsApp-style alert message in Hebrew for the roastery manager Erez.
- Use emojis appropriately
- Mention days remaining for each origin
- If green stock is available, suggest roasting
- Keep it concise and actionable
- Use Telegram Markdown formatting (*bold*, etc.)
- Do not use dashes or bullet points, use emojis instead`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  if (data.content && data.content[0]) {
    return data.content[0].text;
  }

  throw new Error('Claude API failed: ' + JSON.stringify(data));
}

async function checkAndAlert() {
  console.log('Checking stock levels for alerts...');

  try {
    const { data: origins, error } = await supabase
      .from('origins')
      .select('id, name, roasted_stock, stock, daily_average')
      .eq('user_id', USER_ID);

    if (error) throw error;
    if (!origins || origins.length === 0) {
      console.log('No origins found');
      return;
    }

    // Find origins with less than 3 days of roasted stock
    const lowStock = origins.filter(o => {
      if (!o.daily_average || o.daily_average === 0) return false;
      const daysLeft = o.stock / o.daily_average;
      return daysLeft < 14;
    });

    if (lowStock.length === 0) {
      console.log('All stock levels OK — no alerts needed');
      return;
    }

    console.log('Low stock origins: ' + lowStock.map(o => o.name).join(', '));

    const message = await generateAlertMessage(lowStock);
    const sent = await sendTelegram(message);

    if (sent) {
      console.log('Alert sent successfully via Telegram');
    }

  } catch (err) {
    console.error('Error in checkAndAlert:', err.message);
  }
}

module.exports = { checkAndAlert };
