const { checkAndAlert } = require('./alert');
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

async function scrapeSales() {
  console.log('Starting sales sync...', new Date().toISOString());

  const DRY_RUN = false;

  let browser;

  try {
    const now = new Date();
    const israelTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const yesterdayDate = new Date(israelTime);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yDay = String(yesterdayDate.getDate()).padStart(2, '0');
    const yMonth = String(yesterdayDate.getMonth() + 1).padStart(2, '0');
    const yYear = yesterdayDate.getFullYear();
    const yesterdayISO = yYear + '-' + yMonth + '-' + yDay;
    const yesterdayDisplay = yDay + '/' + yMonth + '/' + yYear;

    const { data: syncRows } = await supabase
      .from('origins')
      .select('last_synced_at')
      .eq('user_id', USER_ID)
      .not('last_synced_at', 'is', null)
      .order('last_synced_at', { ascending: false })
      .limit(1);

    const lastSync = syncRows && syncRows.length > 0 ? syncRows[0] : null;

    if (lastSync && lastSync.last_synced_at) {
      const lastSyncISO = new Date(lastSync.last_synced_at)
        .toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
      const todayISO = yYear + '-' + yMonth + '-' + String(israelTime.getDate()).padStart(2, '0');
      if (lastSyncISO === todayISO) {
        console.log('Already synced today, skipping...');
        await checkAndAlert();
        return;
      }
    }
    // Send stock alerts
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

    if (!page.url().includes('/home') && !page.url().includes('/dashboard') && !page.url().includes('/v1/')) {
      throw new Error('Login failed - unexpected URL: ' + page.url());
    }

    console.log('Fetching sales for: ' + yesterdayDisplay);

    const reportUrl = 'https://my.mflow.co.il/reports/product-sell-report?start_date=' + yesterdayISO + '&end_date=' + yesterdayISO;

    await page.goto(reportUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await new Promise(r => setTimeout(r, 3000));

    await page.evaluate(function(dateStr) {
      var input = document.getElementById('product_sr_date_filter');
      if (input && $(input).data('daterangepicker')) {
        var picker = $(input).data('daterangepicker');
        var date = moment(dateStr, 'DD/MM/YYYY');
        picker.setStartDate(date);
        picker.setEndDate(date);
        $(input).trigger('apply.daterangepicker', [picker]);
      }
    }, yesterdayDisplay);

    await new Promise(r => setTimeout(r, 1000));

    await page.evaluate(function() {
      var btn = document.getElementById('filter_btn');
      if (btn) btn.click();
    });

    await new Promise(r => setTimeout(r, 3000));

    // Click "דוח מאוחד" to get the consolidated view with quantities
    await page.evaluate(function() {
      var buttons = Array.from(document.querySelectorAll('button, a, input[type="button"]'));
      var btn = buttons.find(function(el) { return el.innerText && el.innerText.includes('מאוחד'); });
      if (btn) btn.click();
    });

    await new Promise(r => setTimeout(r, 3000));

    // Show all rows
    await page.evaluate(function() {
      try {
        var table = $('#product_sell_report_table').DataTable();
        if (table) table.page.len(-1).draw();
      } catch(e) {}
    });

    await new Promise(r => setTimeout(r, 8000));

    await page.waitForSelector('table', { timeout: 20000 });

    const filterValue = await page.$eval('#product_sr_date_filter', function(el) { return el.value; });
    console.log('Date filter value: ' + filterValue);

    const sales = await page.evaluate(function() {
      // Find quantity column index by header text
      var headers = Array.from(document.querySelectorAll('table thead th'));
      var qtyIndex = -1;
      for (var i = 0; i < headers.length; i++) {
        if (headers[i].innerText && headers[i].innerText.includes('יחידות')) {
          qtyIndex = i;
          break;
        }
      }
      console.log('Quantity column index: ' + qtyIndex);

      var rows = Array.from(document.querySelectorAll('table tbody tr'));
      return rows.map(function(row) {
        var cells = row.querySelectorAll('td');
        var rawQty = qtyIndex >= 0 && cells[qtyIndex] ? cells[qtyIndex].innerText.trim().replace(/,/g, '') : '1';
        var qty = parseInt(rawQty, 10);
        return {
          sku: cells[0] && cells[0].innerText ? cells[0].innerText.trim() : '',
          product: cells[1] && cells[1].innerText ? cells[1].innerText.trim() : '',
          quantity: isNaN(qty) || qty <= 0 ? 1 : qty
        };
      }).filter(function(s) { return s.sku; });
    });

    await browser.close();

    console.log('Found ' + sales.length + ' sales records');

    if (sales.length === 0) {
      console.log('No sales to process');
      return;
    }

    const salesByProduct = new Map();
    for (const sale of sales) {
      const normalizedSku = sale.sku.split('-')[0].replace(/^0+/, '');
      salesByProduct.set(normalizedSku, (salesByProduct.get(normalizedSku) || 0) + sale.quantity);
    }

    console.log('Processing ' + salesByProduct.size + ' unique products');

    console.log('=== DEDUCTION SUMMARY (in kg) ===');
    for (const [normalizedSku, quantity] of salesByProduct) {
      const { data: products } = await supabase
        .from('products')
        .select('name, size, recipe')
        .eq('sku', normalizedSku)
        .eq('user_id', USER_ID);

      if (products && products.length > 0) {
        const product = products[0];
        const totalKg = (product.size * quantity) / 1000;
        console.log(product.name + ': ' + quantity + ' units x ' + product.size + 'g = ' + totalKg.toFixed(3) + 'kg');
      }
    }
    console.log('=================================');

    const syncTime = new Date().toISOString();
    let processed = 0;
    let skipped = 0;
    let errors = [];

    for (const [normalizedSku, quantity] of salesByProduct) {
      try {
        const { data: products, error: productError } = await supabase
          .from('products')
          .select('id, name, size, packed_stock')
          .eq('sku', normalizedSku)
          .eq('user_id', USER_ID);

        if (productError) throw productError;
        if (!products || products.length === 0) {
          skipped++;
          continue;
        }

        const product = products[0];

        // Deduct sold bags from packed_stock (roasted_stock is managed by packing flow)
        const newPackedStock = Math.max(0, (product.packed_stock ?? 0) - quantity);

        const { error: updateError } = await supabase
          .from('products')
          .update({ packed_stock: newPackedStock, last_synced_at: syncTime })
          .eq('id', product.id)
          .eq('user_id', USER_ID);

        if (updateError) {
          errors.push(product.name + ': Error updating packed_stock - ' + updateError.message);
        } else {
          console.log('Updated ' + product.name + ': -' + quantity + ' bags (packed_stock now: ' + newPackedStock + ')');
        }

        processed++;

      } catch (err) {
        errors.push('SKU ' + normalizedSku + ': ' + err.message);
      }
    }

    console.log('Sync complete — Processed: ' + processed + ', Skipped: ' + skipped + ', Errors: ' + errors.length);
    if (errors.length > 0) {
      console.error('Errors:', errors);
    }
    // Send stock alerts
    await checkAndAlert();

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

// 05:00 Israel time
cron.schedule('0 5 * * *', () => {
  console.log('Running scheduled sync...');
  scrapeSales()
    .then(() => console.log('Scheduled sync completed'))
    .catch(err => console.error('Scheduled sync failed:', err.message));
}, { timezone: 'Asia/Jerusalem' });

process.on('SIGTERM', () => {
  console.log('Shutting down gracefully');
  process.exit(0);
});
