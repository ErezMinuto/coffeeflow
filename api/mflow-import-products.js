const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const MFLOW_EMAIL = process.env.MFLOW_EMAIL || '';
const MFLOW_PASSWORD = process.env.MFLOW_PASSWORD || '';
const USER_ID = process.env.USER_ID || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('Missing required environment variables: SUPABASE_URL or SUPABASE_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function getLastSyncDate() {
  const { data } = await supabase
    .from('origins')
    .select('last_synced_at')
    .eq('user_id', USER_ID)
    .not('last_synced_at', 'is', null)
    .order('last_synced_at', { ascending: false })
    .limit(1)
    .single();
  return data?.last_synced_at || null;
}

async function scrapeSales() {
  console.log('Starting sales sync...', new Date().toISOString());

  let browser;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,800'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto('https://my.mflow.co.il/login', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await new Promise(r => setTimeout(r, 3000));
    await page.waitForSelector('#login_username', { timeout: 20000 });
    await page.type('#login_username', MFLOW_EMAIL, { delay: 50 });
    await page.type('#login_password', MFLOW_PASSWORD, { delay: 50 });

    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 })
    ]);

    await new Promise(r => setTimeout(r, 2000));

    if (!page.url().includes('/home')) {
      throw new Error(`Login failed - unexpected URL: ${page.url()}`);
    }

    // Get today's date in Israel time (DD/MM/YYYY)
    const today = new Date().toLocaleDateString('he-IL', {
      timeZone: 'Asia/Jerusalem',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }).replace(/\./g, '/');

    console.log(`Fetching sales for: ${today}`);

    await page.goto('https://my.mflow.co.il/reports/product-sell-report', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await new Promise(r => setTimeout(r, 3000));

    // Set date filter to today only
    await page.evaluate((dateStr) => {
      const input = document.getElementById('product_sr_date_filter');
      if (input) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(input, `${dateStr} - ${dateStr}`);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, today);

    await new Promise(r => setTimeout(r, 2000));

    // Click the filter/apply button
    const filterBtn = await page.$('button#filter_btn, button.filter-submit, button[type="submit"]');
    if (filterBtn) {
      await filterBtn.click();
      await new Promise(r => setTimeout(r, 3000));
    }

    await page.waitForSelector('table', { timeout: 20000 });

    const sales = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.map(row => {
        const cells = row.querySelectorAll('td');
        return {
          sku: cells[0]?.innerText?.trim() || '',
          product: cells[1]?.innerText?.trim() || '',
          date: cells[5]?.innerText?.trim() || ''
        };
      }).filter(s => s.sku);
    });

    await browser.close();

    console.log(`Found ${sales.length} sales records`);

    if (sales.length === 0) {
      console.log('No sales to process');
      return;
    }

    // Group by NORMALIZED SKU to combine variants
    const salesByProduct = new Map();
    for (const sale of sales) {
      const normalizedSku = sale.sku.split('-')[0].replace(/^0+/, '');
      salesByProduct.set(normalizedSku, (salesByProduct.get(normalizedSku) || 0) + 1);
    }

    console.log(`Processing ${salesByProduct.size} unique products`);

    const syncTime = new Date().toISOString();
    let processed = 0;
    let skipped = 0;
    let errors = [];

    for (const [normalizedSku, quantity] of salesByProduct) {
      try {
        const { data: products, error: productError } = await supabase
          .from('products')
          .select('id, name, size, recipe')
          .eq('sku', normalizedSku)
          .eq('user_id', USER_ID);

        if (productError) throw productError;
        if (!products || products.length === 0) {
          skipped++;
          continue;
        }

        const product = products[0];
        const recipe = product.recipe;

        if (!recipe || recipe.length === 0) {
          errors.push(`${product.name}: No recipe defined`);
          continue;
        }

        for (const ingredient of recipe) {
          if (!ingredient.originId || !ingredient.percentage) continue;

          const amountToDeduct = (product.size * quantity * ingredient.percentage) / 100;

          const { data: origin } = await supabase
            .from('origins')
            .select('roasted_stock')
            .eq('id', ingredient.originId)
            .eq('user_id', USER_ID)
            .single();

          if (!origin) {
            errors.push(`${product.name}: Origin ${ingredient.originId} not found`);
            continue;
          }

          const newStock = Math.max(0, origin.roasted_stock - amountToDeduct);

          if (newStock === 0 && origin.roasted_stock - amountToDeduct < 0) {
            console.warn(`⚠️ ${product.name}: Stock clamped to 0 (would have been ${(origin.roasted_stock - amountToDeduct).toFixed(0)}g)`);
          }

          const { error: updateError } = await supabase
            .from('origins')
            .update({ 
              roasted_stock: newStock,
              last_synced_at: syncTime
            })
            .eq('id', ingredient.originId)
            .eq('user_id', USER_ID);

          if (updateError) {
            errors.push(`${product.name}: Error updating stock - ${updateError.message}`);
          } else {
            console.log(`✓ ${product.name}: -${amountToDeduct.toFixed(0)}g (stock now: ${newStock.toFixed(0)}g)`);
          }
        }

        processed++;

      } catch (err) {
        errors.push(`SKU ${normalizedSku}: ${err.message}`);
      }
    }

    console.log(`Sync complete — Processed: ${processed}, Skipped: ${skipped}, Errors: ${errors.length}`);
    if (errors.length > 0) {
      console.error('Errors:', errors);
    }

  } catch (error) {
    console.error('Scraper error:', error.message);
    if (browser) await browser.close();
    throw error;
  }
}

console.log('MFlow Scraper started');
scrapeSales()
  .then(() => console.log('Initial sync completed'))
  .catch(err => console.error('Initial sync failed:', err.message));

cron.schedule('0 8 * * *', () => {
  console.log('Running scheduled sync...');
  scrapeSales()
    .then(() => console.log('Scheduled sync completed'))
    .catch(err => console.error('Scheduled sync failed:', err.message));
});

process.on('SIGTERM', () => {
  console.log('Shutting down gracefully');
  process.exit(0);
});
